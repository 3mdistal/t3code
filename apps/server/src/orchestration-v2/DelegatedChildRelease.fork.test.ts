// fork: tests for releasing finished delegated threads. See FORK.md.
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  checkoutKey,
  isReleasableDelegatedChild,
  makeDelegatedChildRelease,
} from "./DelegatedChildRelease.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";

type AutoSettleCommand = Extract<OrchestrationV2Command, { readonly type: "thread.auto-settle" }>;

const now = DateTime.makeUnsafe("2026-10-31T12:00:00Z");
const old = DateTime.subtract(now, { hours: 2 });
const finished = DateTime.subtract(now, { hours: 1 });
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test-model" };
const projectId = ProjectId.make("project:release");
const parentId = ThreadId.make("thread:release:parent");
const TERMINAL = ["completed", "failed", "cancelled", "interrupted"] as const;

const testRandom = SecureRandom.make((size) => new Uint8Array(size).fill(1));

const layerSql = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

function appThread(
  threadId: ThreadId,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  return {
    createdBy: "agent",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: parentId, relationshipToParent: "subagent", rootThreadId: parentId },
    forkedFrom: null,
    createdAt: old,
    updatedAt: old,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

const apply = Effect.fn(function* (event: OrchestrationV2DomainEvent) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply(event);
});

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const threadId = ThreadId.make(`thread:release:${name}`);
  yield* apply({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: old,
    payload: appThread(threadId, overrides),
  });
  return threadId;
});

/** A task on `owner`; with `child`, an app-owned delegated task that runs in that thread. */
const recordTask = Effect.fn(function* (input: {
  readonly name: string;
  readonly owner: ThreadId;
  readonly child: ThreadId | null;
  readonly status: OrchestrationV2Subagent["status"];
  readonly completedAt?: DateTime.Utc | null;
  readonly delivery?: NonNullable<OrchestrationV2Subagent["completionDelivery"]>["state"];
}) {
  const id = NodeId.make(`node:delegated-task:${input.name}`);
  const terminal = (TERMINAL as ReadonlyArray<string>).includes(input.status);
  yield* apply({
    id: EventId.make(`event:${id}:${input.status}`),
    type: "subagent.updated",
    threadId: input.owner,
    nodeId: id,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: {
      id,
      threadId: input.owner,
      runId: null,
      parentNodeId: NodeId.make(`node:parent:${input.name}`),
      origin: "app_owned",
      createdBy: "agent",
      driver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: input.child,
      nativeTaskRef: null,
      prompt: "Review it",
      title: input.name,
      model: null,
      status: input.status,
      result: terminal ? "Done." : null,
      startedAt: old,
      completedAt:
        input.completedAt === undefined ? (terminal ? finished : null) : input.completedAt,
      updatedAt: now,
      ...(input.delivery === undefined
        ? {}
        : { completionDelivery: { state: input.delivery, observedByRunId: null } }),
    },
  });
});

const attachSession = Effect.fn(function* (
  threadId: ThreadId,
  status: "running" | "ready" | "stopped" = "ready",
) {
  yield* apply({
    id: EventId.make(`event:${threadId}:session`),
    type: "provider-session.attached",
    threadId,
    driver,
    occurredAt: old,
    payload: {
      id: ProviderSessionId.make(`session:${threadId}`),
      driver,
      providerInstanceId,
      status,
      cwd: "/workspace",
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: old,
      updatedAt: old,
      lastError: null,
    },
  });
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"] = "completed",
  ordinal = 1,
) {
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  const ended = ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
  yield* apply({
    id: EventId.make(`event:${runId}`),
    type: "run.created",
    threadId,
    occurredAt: old,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: old,
      startedAt: status === "queued" ? null : old,
      completedAt: ended ? finished : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  return runId;
});

const createItem = Effect.fn(function* (
  threadId: ThreadId,
  runId: RunId,
  type: "command_execution" | "dynamic_tool" | "subagent" | "link_request",
  status: "pending" | "running" | "waiting" | "completed",
) {
  const common = {
    id: TurnItemId.make(`item:${runId}:${type}`),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: null,
    startedAt: old,
    completedAt: status === "completed" ? finished : null,
    updatedAt: old,
  };
  yield* apply({
    id: EventId.make(`event:item:${runId}:${type}:${status}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: old,
    payload:
      type === "dynamic_tool"
        ? { ...common, type, toolName: "monitor", input: null, output: null }
        : type === "link_request"
          ? { ...common, type, reason: "Run the suite there.", linkStatus: "pending" }
          : type === "subagent"
            ? {
                ...common,
                type,
                subagentId: NodeId.make(`node:nested:${runId}`),
                origin: "provider_native",
                driver,
                providerInstanceId,
                childThreadId: null,
                prompt: "Look into it",
                result: null,
              }
            : { ...common, type, input: "npm run dev" },
  });
});

const insertEffect = Effect.fn(function* (
  threadId: ThreadId,
  effectType: string,
  status: "pending" | "running" | "succeeded",
) {
  const sql = yield* SqlClient.SqlClient;
  const iso = DateTime.formatIso(now);
  yield* sql`
    INSERT INTO orchestration_v2_effect_outbox (
      effect_id, command_id, thread_id, effect_type, payload_json, status,
      attempt_count, available_at, created_at, updated_at
    ) VALUES (
      ${`effect:${threadId}:${effectType}`}, ${`command:${threadId}`}, ${threadId}, ${effectType},
      '{}', ${status}, 0, ${iso}, ${iso}, ${iso}
    )
  `;
});

const writeMessage = Effect.fn(function* (
  threadId: ThreadId,
  createdBy: "user" | "agent",
  at: DateTime.Utc,
) {
  yield* apply({
    id: EventId.make(`event:${threadId}:message:${createdBy}`),
    type: "message.updated",
    threadId,
    occurredAt: at,
    payload: {
      createdBy,
      creationSource: "web",
      id: MessageId.make(`message:${threadId}:${createdBy}`),
      threadId,
      runId: null,
      nodeId: null,
      role: "user",
      text: "One more thing",
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  });
});

/** A child whose task finished, with a finished run and a live session: releasable as it stands. */
const finishedChild = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const threadId = yield* createThread(name, overrides);
  yield* recordTask({ name, owner: parentId, child: threadId, status: "completed" });
  yield* attachSession(threadId);
  yield* createRun(threadId);
  return threadId;
});

describe("getReleasableDelegatedChildren", () => {
  it.effect("finds finished children with a live session and nothing left running", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* createThread("parent", {
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentId },
      });
      const expected = new Set<ThreadId>();
      for (const status of TERMINAL) {
        const threadId = yield* createThread(`ended-${status}`);
        yield* recordTask({ name: `ended-${status}`, owner: parentId, child: threadId, status });
        yield* attachSession(threadId);
        yield* createRun(threadId, status === "completed" ? "completed" : "interrupted");
        expected.add(threadId);
      }

      // Reused: its first task ended at `finished`, its second an hour later.
      const reused = yield* finishedChild("reused");
      yield* recordTask({
        name: "reused-again",
        owner: parentId,
        child: reused,
        status: "completed",
        completedAt: now,
      });
      expected.add(reused);
      // Items of a rolled-back run never close; they don't hold release.
      const rolledBack = yield* finishedChild("rolled-back-item");
      yield* createItem(
        rolledBack,
        yield* createRun(rolledBack, "rolled_back", 2),
        "command_execution",
        "running",
      );
      expected.add(rolledBack);
      // A finished command and a settled provider effect don't hold it either.
      const quiet = yield* finishedChild("quiet");
      yield* createItem(quiet, RunId.make(`run:${quiet}:1`), "command_execution", "completed");
      yield* insertEffect(quiet, "provider-turn.start", "succeeded");
      expected.add(quiet);
      // Its own task finished and its wake was delivered.
      const delivered = yield* finishedChild("own-task-delivered");
      yield* recordTask({
        name: "nested-delivered",
        owner: delivered,
        child: null,
        status: "completed",
        delivery: "delivered",
      });
      expected.add(delivered);

      // Each of these differs from a releasable child in one way.
      yield* createThread("not-delegated").pipe(
        Effect.tap(attachSession),
        Effect.tap((id) => createRun(id)),
      );
      const notStarted = yield* createThread("task-running");
      yield* recordTask({
        name: "task-running",
        owner: parentId,
        child: notStarted,
        status: "running",
      });
      yield* attachSession(notStarted);
      const missingTime = yield* createThread("task-without-completion-time");
      yield* recordTask({
        name: "task-without-completion-time",
        owner: parentId,
        child: missingTime,
        status: "completed",
        completedAt: null,
      });
      yield* attachSession(missingTime);
      const reusedRunning = yield* finishedChild("reused-running");
      yield* recordTask({
        name: "reused-running-again",
        owner: parentId,
        child: reusedRunning,
        status: "running",
      });
      const noSession = yield* createThread("no-session");
      yield* recordTask({
        name: "no-session",
        owner: parentId,
        child: noSession,
        status: "completed",
      });
      const stopped = yield* createThread("stopped-session");
      yield* recordTask({
        name: "stopped-session",
        owner: parentId,
        child: stopped,
        status: "completed",
      });
      yield* attachSession(stopped, "stopped");
      for (const [name, overrides] of [
        ["archived", { archivedAt: old }],
        ["deleted", { deletedAt: old }],
        ["settled", { settledOverride: "settled", settledAt: old }],
        ["kept-active", { settledOverride: "active" }],
        ["pinned", { pinnedAt: old }],
        ["auto-settle-disabled", { autoSettleDisabledAt: old }],
      ] satisfies ReadonlyArray<readonly [string, Partial<OrchestrationV2AppThread>]>) {
        yield* finishedChild(name, overrides);
      }
      for (const status of ["queued", "preparing", "starting", "running", "waiting"] as const) {
        yield* createRun(yield* finishedChild(`run-${status}`), status, 2);
      }
      const held = yield* finishedChild("run-held");
      yield* apply({
        id: EventId.make("event:release:held-run"),
        type: "run.created",
        threadId: held,
        occurredAt: old,
        payload: {
          id: RunId.make(`run:${held}:2`),
          threadId: held,
          ordinal: 2,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message:${held}:2`),
          rootNodeId: null,
          activeAttemptId: null,
          status: "queued",
          queueHeld: true,
          requestedAt: old,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const blocked = yield* finishedChild("runtime-request");
      yield* apply({
        id: EventId.make("event:release:request"),
        type: "runtime-request.updated",
        threadId: blocked,
        occurredAt: old,
        payload: {
          id: RuntimeRequestId.make("request:release"),
          nodeId: NodeId.make("node:release:request"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "not_resumable", reason: "Process stopped" },
          createdAt: old,
          resolvedAt: null,
        },
      });
      const command = yield* finishedChild("open-command");
      yield* createItem(command, RunId.make(`run:${command}:1`), "command_execution", "running");
      const monitor = yield* finishedChild("open-dynamic-tool");
      yield* createItem(monitor, RunId.make(`run:${monitor}:1`), "dynamic_tool", "running");
      const nativeSubagent = yield* finishedChild("open-subagent");
      yield* createItem(
        nativeSubagent,
        RunId.make(`run:${nativeSubagent}:1`),
        "subagent",
        "running",
      );
      const pendingCommand = yield* finishedChild("pending-command");
      yield* createItem(
        pendingCommand,
        RunId.make(`run:${pendingCommand}:1`),
        "command_execution",
        "pending",
      );
      const waitingTool = yield* finishedChild("waiting-dynamic-tool");
      yield* createItem(waitingTool, RunId.make(`run:${waitingTool}:1`), "dynamic_tool", "waiting");
      const link = yield* finishedChild("waiting-link-request");
      yield* createItem(link, RunId.make(`run:${link}:1`), "link_request", "waiting");
      yield* insertEffect(
        yield* finishedChild("provider-effect"),
        "provider-turn.start",
        "running",
      );
      yield* insertEffect(
        yield* finishedChild("restart-continuation"),
        "provider-runtime.continue",
        "pending",
      );
      const nestedRunning = yield* finishedChild("own-task-running");
      yield* recordTask({
        name: "nested-running",
        owner: nestedRunning,
        child: null,
        status: "running",
      });
      for (const delivery of ["pending", "claimed"] as const) {
        const owes = yield* finishedChild(`own-task-owes-wake-${delivery}`);
        yield* recordTask({
          name: `nested-${delivery}`,
          owner: owes,
          child: null,
          status: "completed",
          delivery,
        });
      }

      const found = yield* store.getReleasableDelegatedChildren();
      assert.deepStrictEqual(new Set(found.map((child) => child.threadId)), expected);
      assert.strictEqual(
        DateTime.formatIso(found.find((child) => child.threadId === reused)!.taskCompletedAt),
        DateTime.formatIso(now),
      );
      assert.deepStrictEqual(
        (yield* store.getReleasableDelegatedChildren(quiet)).map((child) => child.threadId),
        [quiet],
      );
      assert.strictEqual(
        DateTime.formatIso(found.find((child) => child.threadId === quiet)!.snapshotAt),
        DateTime.formatIso(old),
      );
      assert.deepStrictEqual(yield* store.getReleasableDelegatedChildren(command), []);
      // Once its command finishes, the child is found.
      yield* createItem(command, RunId.make(`run:${command}:1`), "command_execution", "completed");
      assert.deepStrictEqual(
        (yield* store.getReleasableDelegatedChildren(command)).map((child) => child.threadId),
        [command],
      );
    }).pipe(Effect.provide(layerSql)),
  );
});

describe("isReleasableDelegatedChild", () => {
  it.effect("leaves a child Alice wrote to after its task ended", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const nowMs = DateTime.toEpochMillis(now);
      const finishedMs = DateTime.toEpochMillis(finished);
      const candidate = Effect.fn(function* (threadId: ThreadId) {
        const [thread] = yield* store.getSettlementCandidates(threadId);
        return thread!;
      });

      // Half an hour after the task ended, so neither reads as a turn about to start.
      const agentFollowUp = yield* finishedChild("agent-follow-up");
      yield* writeMessage(agentFollowUp, "agent", DateTime.subtract(now, { minutes: 30 }));
      const wroteBefore = yield* finishedChild("user-wrote-before");
      yield* writeMessage(wroteBefore, "user", old);
      const wroteAfter = yield* finishedChild("user-wrote-after");
      yield* writeMessage(wroteAfter, "user", DateTime.subtract(now, { minutes: 30 }));

      assert.isTrue(isReleasableDelegatedChild(yield* candidate(agentFollowUp), finishedMs, nowMs));
      assert.isTrue(isReleasableDelegatedChild(yield* candidate(wroteBefore), finishedMs, nowMs));
      assert.isFalse(isReleasableDelegatedChild(yield* candidate(wroteAfter), finishedMs, nowMs));
    }).pipe(Effect.provide(layerSql)),
  );

  it("holds for any background work, a guest, or a snooze", () => {
    const nowMs = DateTime.toEpochMillis(now);
    const base: ProjectionStore.ProjectionSettlementCandidate = {
      id: ThreadId.make("thread:release:shell"),
      projectId,
      branch: null,
      worktreePath: null,
      pullRequests: [],
      linkedPullRequest: null,
      createdAt: old,
      updatedAt: old,
      archivedAt: null,
      settledOverride: null,
      pinnedAt: null,
      autoSettleDisabledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      latestRunId: RunId.make("run:release:shell"),
      latestRunRequestedAt: old,
      latestRunStartedAt: old,
      latestRunCompletedAt: finished,
      latestUserMessageAt: old,
      status: "completed",
      activityRunStartedAt: null,
      activityRunStatus: null,
      pendingRuntimeRequest: null,
      pendingBackgroundTasks: [],
      pendingGuestMessageCount: 0,
      latestUserAuthoredMessageAt: null,
    };
    const releasable = (overrides: Partial<ProjectionStore.ProjectionSettlementCandidate>) =>
      isReleasableDelegatedChild(
        { ...base, ...overrides },
        DateTime.toEpochMillis(finished),
        nowMs,
      );

    assert.isTrue(releasable({}));
    // Auto-settle lets a running command or monitor settle; releasing would stop it.
    assert.isFalse(releasable({ pendingBackgroundTasks: [{ taskId: "dev", kind: "command" }] }));
    assert.isFalse(releasable({ pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" }] }));
    assert.isFalse(releasable({ pendingGuestMessageCount: 1 }));
    assert.isFalse(
      releasable({
        snoozedUntil: DateTime.add(now, { hours: 1 }),
        snoozedAt: DateTime.subtract(now, { minutes: 1 }),
      }),
    );
    assert.isFalse(releasable({ activityRunStatus: "running" }));
    // A wake queued after the projection read shows up as the latest run.
    assert.isFalse(releasable({ status: "queued" }));
    assert.isFalse(releasable({ status: "running" }));
    assert.isTrue(releasable({ status: "idle", latestRunId: null }));
    assert.isFalse(releasable({ settledOverride: "active" }));
  });
});

/** The release over the real projection, or over `projections` when given; records its commands. */
const makeRelease = Effect.fn(function* (
  projections?: Layer.Layer<ProjectionStore.ProjectionStoreV2>,
) {
  const commands = yield* Ref.make<ReadonlyArray<AutoSettleCommand>>([]);
  const dependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        command.type === "thread.auto-settle"
          ? Ref.update(commands, (all) => [...all, command]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            )
          : Effect.die(new Error(`Unexpected command: ${command.type}`)),
    }),
    Layer.succeed(SecureRandom.SecureRandom, testRandom),
  );
  const release = yield* makeDelegatedChildRelease().pipe(
    Effect.provide(
      projections === undefined ? dependencies : Layer.merge(dependencies, projections),
    ),
  );
  return { release, commands };
});

describe("makeDelegatedChildRelease", () => {
  it.effect("settles each releasable child once, with the snapshot it read", () =>
    Effect.gen(function* () {
      const ready = yield* finishedChild("release-ready");
      const takenOver = yield* finishedChild("release-taken-over");
      yield* writeMessage(takenOver, "user", DateTime.subtract(now, { minutes: 5 }));
      const busy = yield* finishedChild("release-busy");
      yield* createItem(busy, RunId.make(`run:${busy}:1`), "command_execution", "running");

      const { release, commands } = yield* makeRelease();
      yield* release.releaseFinishedChildren();

      const sent = yield* Ref.get(commands);
      assert.deepStrictEqual(
        sent.map((command) => command.threadId),
        [ready],
      );
      assert.strictEqual(DateTime.formatIso(sent[0]!.snapshotAt), DateTime.formatIso(old));
      assert.match(sent[0]!.commandId, /^server:release-delegated:/);
    }).pipe(Effect.provide(layerSql)),
  );

  it.effect("leaves a child that changed after the projection read", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      // A wake queued between the two reads moves no thread timestamp, only the latest run.
      const woken = yield* finishedChild("woken-between-reads");
      const touched = yield* finishedChild("touched-between-reads");
      const { release, commands } = yield* makeRelease(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getReleasableDelegatedChildren: store.getReleasableDelegatedChildren,
          getSettlementCandidates: (threadId) =>
            Effect.gen(function* () {
              if (threadId === woken) yield* createRun(woken, "queued", 2);
              const candidates = yield* store.getSettlementCandidates(threadId);
              return threadId === touched
                ? candidates.map((thread) => ({ ...thread, updatedAt: now }))
                : candidates;
            }).pipe(Effect.provideService(ProjectionStore.ProjectionStoreV2, store)),
        }),
      );
      yield* release.releaseFinishedChildren();
      assert.deepStrictEqual(yield* Ref.get(commands), []);
    }).pipe(Effect.provide(layerSql)),
  );

  it.effect("reaches a ready child behind forty held ones", () =>
    Effect.gen(function* () {
      for (let index = 0; index < 40; index++) {
        const held = yield* finishedChild(`held-${String(index).padStart(2, "0")}`);
        yield* writeMessage(held, "user", DateTime.subtract(now, { minutes: 30 }));
      }
      // Touched last, so it sorts after the held ones.
      const ready = yield* finishedChild("ready-behind-held");
      yield* writeMessage(ready, "agent", DateTime.subtract(now, { minutes: 20 }));
      const { release, commands } = yield* makeRelease();
      yield* release.releaseFinishedChildren();
      assert.deepStrictEqual(
        (yield* Ref.get(commands)).map((command) => command.threadId),
        [ready],
      );
    }).pipe(Effect.provide(layerSql)),
  );

  it.effect("keeps a child out of its parent's checkout teardown", () =>
    Effect.gen(function* () {
      yield* createThread("parent", {
        worktreePath: "/worktrees/parent",
        settledOverride: "settled",
        settledAt: now,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentId },
      });
      const { release } = yield* makeRelease();
      const thread = (overrides: Partial<OrchestrationV2AppThread>) =>
        appThread(ThreadId.make("thread:release:checkout"), overrides);
      const shares = (overrides: Partial<OrchestrationV2AppThread>) =>
        release.childSharesCheckout(thread(overrides));

      // The parent has settled; the checkout is still the parent's.
      assert.isTrue(yield* shares({ worktreePath: "/worktrees/parent" }));
      assert.isFalse(yield* shares({ worktreePath: "/worktrees/isolated" }));
      assert.isFalse(yield* shares({ worktreePath: null }));
      assert.isFalse(
        yield* shares({
          worktreePath: "/worktrees/parent",
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentId },
        }),
      );
      // Without the parent's record it leaves the checkout alone.
      const orphan = ThreadId.make("thread:release:missing-parent");
      assert.isTrue(
        yield* shares({
          worktreePath: "/worktrees/parent",
          lineage: {
            parentThreadId: orphan,
            relationshipToParent: "subagent",
            rootThreadId: orphan,
          },
        }),
      );
    }).pipe(Effect.provide(layerSql)),
  );

  it.effect("finds the parent's checkout on Windows whatever its case and slashes", () =>
    Effect.gen(function* () {
      yield* createThread("parent", {
        worktreePath: "c:\\repo\\checkout",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentId },
      });
      const { release } = yield* makeRelease().pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
      );
      const child = appThread(ThreadId.make("thread:release:windows-checkout"), {
        worktreePath: "C:/Repo/Checkout/",
      });
      assert.isTrue(yield* release.childSharesCheckout(child));
    }).pipe(Effect.provide(layerSql)),
  );

  it("compares checkouts the way their platform does", () => {
    assert.strictEqual(
      checkoutKey("C:/Repo/Checkout", "win32"),
      checkoutKey("c:\\repo\\checkout\\", "win32"),
    );
    assert.notStrictEqual(
      checkoutKey("/repo/Checkout", "linux"),
      checkoutKey("/repo/checkout", "linux"),
    );
    assert.strictEqual(
      checkoutKey("/repo/checkout/", "linux"),
      checkoutKey("/repo/checkout", "linux"),
    );
  });
});

describe("ThreadSettlementServiceV2 with delegated children", () => {
  const child = ThreadId.make("thread:release:worker-child");
  const offSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    sidebarAutoSettleOnMerge: false,
    sidebarAutoSettleAfterDays: null,
  };

  const childCandidate: ProjectionStore.ProjectionSettlementCandidate = {
    id: child,
    projectId,
    branch: null,
    worktreePath: "/worktrees/parent",
    pullRequests: [],
    linkedPullRequest: null,
    createdAt: old,
    updatedAt: old,
    archivedAt: null,
    settledOverride: null,
    pinnedAt: null,
    autoSettleDisabledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    latestRunId: RunId.make("run:release:worker-child"),
    latestRunRequestedAt: old,
    latestRunStartedAt: old,
    latestRunCompletedAt: finished,
    latestUserMessageAt: old,
    status: "completed",
    activityRunStartedAt: null,
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    pendingGuestMessageCount: 0,
    latestUserAuthoredMessageAt: null,
  };

  const makeWorker = Effect.fn(function* (threads: ReadonlyArray<OrchestrationV2AppThread>) {
    const commands = yield* Queue.unbounded<AutoSettleCommand>();
    const releaseReads = yield* Queue.unbounded<ThreadId | undefined>();
    const scriptRuns =
      yield* Queue.unbounded<ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput>();
    const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
    const settingsChanges = yield* PubSub.unbounded<typeof offSettings>();
    const merges = yield* PubSub.unbounded<PullRequestService.PullRequestMergeEvent>();
    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        // Only the child's own sweep finds it, so a release proves that sweep ran.
        getReleasableDelegatedChildren: (threadId) =>
          Queue.offer(releaseReads, threadId).pipe(
            Effect.as(
              threadId === child
                ? [{ threadId: child, taskCompletedAt: finished, snapshotAt: old }]
                : [],
            ),
          ),
        getSettlementCandidates: (threadId) =>
          Effect.succeed(threadId === child ? [childCandidate] : []),
        getThread: (threadId) => {
          const thread = threads.find((candidate) => candidate.id === threadId);
          return thread
            ? Effect.succeed(thread)
            : Effect.die(new Error(`Unexpected read: ${threadId}`));
        },
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.fromPubSub(domainEvents),
        dispatch: (command) =>
          command.type === "thread.auto-settle"
            ? Queue.offer(commands, command).pipe(Effect.as({ sequence: 1, storedEvents: [] }))
            : Effect.die(new Error(`Unexpected command: ${command.type}`)),
      }),
      Layer.mock(TerminalManager.TerminalManager)({ closeIdle: () => Effect.void }),
      Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
        runForThread: (input) =>
          Queue.offer(scriptRuns, input).pipe(Effect.as({ status: "no-script" } as const)),
      }),
      Layer.mock(GitManager.GitManager)({}),
      Layer.mock(PullRequestService.PullRequestService)({
        subscribeMerges: PubSub.subscribe(merges).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        ),
      }),
      Layer.succeed(
        ServerSettings.ServerSettingsService,
        ServerSettings.ServerSettingsService.of({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(offSettings),
          updateSettings: () => Effect.die("Unexpected settings update"),
          updateProviderInstance: () => Effect.die("Unexpected provider mutation"),
          withSettingsSnapshot: (use) => use(offSettings),
          streamChanges: Stream.fromPubSub(settingsChanges),
          subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
            Effect.map((subscription) => Stream.fromSubscription(subscription)),
          ),
        }),
      ),
      Layer.succeed(ServerActivation.ServerActivation, Effect.void),
      Layer.succeed(SecureRandom.SecureRandom, testRandom),
      FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
      Path.layer,
    );
    return {
      commands,
      releaseReads,
      scriptRuns,
      publish: (event: OrchestrationV2DomainEvent) => PubSub.publish(domainEvents, event),
      layer: Layer.effect(
        ThreadSettlementService.ThreadSettlementServiceV2,
        ThreadSettlementService.make,
      ).pipe(Layer.provide(dependencies)),
    };
  });

  it.effect("releases a child when its task ends after its run, with auto-settle off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* makeWorker([]);
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* service.start();
          // The first full sweep's read: the worker is listening.
          assert.strictEqual(yield* Queue.take(worker.releaseReads), undefined);
          yield* service.drain;
          yield* worker.publish({
            id: EventId.make("event:release:task-ended"),
            type: "subagent.updated",
            threadId: parentId,
            nodeId: NodeId.make("node:delegated-task:worker-child"),
            driver,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: NodeId.make("node:delegated-task:worker-child"),
              threadId: parentId,
              runId: null,
              parentNodeId: NodeId.make("node:parent:worker-child"),
              origin: "app_owned",
              createdBy: "agent",
              driver,
              providerInstanceId,
              providerThreadId: null,
              childThreadId: child,
              nativeTaskRef: null,
              prompt: "Review it",
              title: "Review",
              model: null,
              status: "completed",
              result: "Done.",
              startedAt: old,
              completedAt: finished,
              updatedAt: now,
            },
          });
          const command = yield* Queue.take(worker.commands);
          assert.strictEqual(command.threadId, child);
        }).pipe(Effect.provide(worker.layer));
      }),
    ),
  );

  it.effect("skips the settle script in its parent's checkout, settled or not", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settledChild = appThread(child, {
          worktreePath: "/worktrees/parent",
          settledOverride: "settled",
          settledAt: now,
        });
        const parent = appThread(parentId, {
          worktreePath: "/worktrees/parent",
          settledOverride: "settled",
          settledAt: now,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentId },
        });
        const isolated = appThread(ThreadId.make("thread:release:isolated"), {
          worktreePath: "/worktrees/isolated",
          settledOverride: "settled",
          settledAt: now,
        });
        const worker = yield* makeWorker([settledChild, parent, isolated]);
        const settled = (thread: OrchestrationV2AppThread): OrchestrationV2DomainEvent => ({
          type: "thread.settled",
          id: EventId.make(`event:settled:${thread.id}`),
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* service.start();
          assert.strictEqual(yield* Queue.take(worker.releaseReads), undefined);
          yield* service.drain;
          yield* worker.publish(settled(settledChild));
          yield* worker.publish(settled(isolated));
          // Events run in order, so the isolated child's script is the first one.
          const run = yield* Queue.take(worker.scriptRuns);
          assert.strictEqual(run.threadId, isolated.id);
          assert.strictEqual(run.worktreePath, "/worktrees/isolated");
          yield* service.drain;
          assert.strictEqual(yield* Queue.size(worker.scriptRuns), 0);
        }).pipe(Effect.provide(worker.layer));
      }),
    ),
  );
});
