import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2StoredEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { ProviderPoolCatalog } from "./ProviderPoolCatalog.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const projectId = ProjectId.make("project:start-retry");
const model = "claude-opus";

interface StartScript {
  /** How many starts fail before Claude reports the turn, so before any prompt is sent. */
  readonly failBeforeReport: number;
  readonly started: ReadonlyArray<{ readonly attemptId: string; readonly prompt: string }>;
}

function makeAdapter(state: Ref.Ref<StartScript>): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
          model: sessionInput.modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native-thread:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Effect.gen(function* () {
              const { failBeforeReport } = yield* Ref.getAndUpdate(state, (current) => ({
                failBeforeReport: Math.max(0, current.failBeforeReport - 1),
                started: [
                  ...current.started,
                  { attemptId: input.attemptId, prompt: input.message.text },
                ],
              }));
              if (failBeforeReport > 0) {
                return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver,
                  threadId: input.threadId,
                  providerThreadId: input.providerThread.id,
                  runId: input.runId,
                  cause: "Claude Code did not answer the MCP server registration.",
                });
              }
              const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
              const startedAt = yield* DateTime.now;
              const providerTurn = (
                status: "running" | "completed",
                completedAt: typeof startedAt | null,
              ) => ({
                id: providerTurnId,
                providerThreadId: input.providerThread.id,
                nodeId: input.rootNodeId,
                runAttemptId: input.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native:${providerTurnId}`,
                  strength: "strong" as const,
                },
                ordinal: input.providerTurnOrdinal,
                status,
                startedAt,
                completedAt,
              });
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: providerTurn("running", null),
              });
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: providerTurn("completed", yield* DateTime.now),
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: input.providerThread.id,
                providerTurnId,
                runOrdinal: input.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

const makeRegistry = (state: Ref.Ref<StartScript>) => {
  const adapter = makeAdapter(state);
  const instance: ProviderInstance = {
    instanceId,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: "claude:home" },
    displayName: "Claude",
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: adapter,
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
  return ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
  );
};

const claude: ServerProvider = {
  instanceId,
  driver,
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-10T00:00:00.000Z",
  continuation: { groupKey: "claude:home" },
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

const catalog = Layer.succeed(ProviderPoolCatalog, {
  getPublishedProviders: Effect.succeed([claude]),
  markLimited: () => Effect.void,
});

const awaitRunStatus = (threadId: ThreadId, status: "completed" | "failed") =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    return yield* eventSink
      .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
      .pipe(
        Stream.filter(
          (stored: OrchestrationV2StoredEvent) =>
            stored.event.type === "run.updated" && stored.event.payload.status === status,
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
  });

/** Sends one message on a fresh Claude thread whose first `failBeforeReport` starts fail. */
const runScript = (name: string, failBeforeReport: number, settles: "completed" | "failed") =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const threadId = ThreadId.make(`thread:${name}`);
    const state = yield* Ref.make<StartScript>({ failBeforeReport, started: [] });
    const projection = yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId,
        title: "Start retry",
        modelSelection: { instanceId, model },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
      });
      const settled = yield* awaitRunStatus(threadId, settles);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:first`),
        threadId,
        messageId: MessageId.make(`${threadId}:first:message`),
        text: "first",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      yield* Fiber.join(settled);
      yield* worker.drain();
      return yield* orchestrator.getThreadProjection(threadId);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry({ name }, makeRegistry(state), {
          settings: { providerInstances: { [instanceId]: { driver, enabled: true } } },
          poolCatalog: catalog,
        }),
      ),
    );
    return { projection, started: (yield* Ref.get(state)).started };
  });

it.live("retries once a Claude turn that failed before its prompt was sent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { projection, started } = yield* runScript("start-retry-recovers", 1, "completed");
      const [run] = projection.runs;
      assert.lengthOf(projection.runs, 1);
      assert.equal(run?.status, "completed");
      assert.deepEqual(
        projection.attempts.map((attempt) => [attempt.status, attempt.reason]),
        [
          ["failed", "initial"],
          ["completed", "retry"],
        ],
      );
      assert.lengthOf(started, 2);
      assert.isTrue(started.every((turn) => turn.prompt.includes("first")));
      assert.lengthOf(
        projection.messages.filter((message) => message.runId === run?.id),
        1,
      );
      const notices = projection.turnItems.filter((item) => item.type === "system_notice");
      assert.deepEqual(
        notices.map((item) => (item.type === "system_notice" ? item.message : null)),
        ["Claude could not start this turn. Trying once more."],
      );
      assert.isFalse(projection.turnItems.some((item) => item.type === "error"));
    }),
  ),
);

it.live("fails the run when the one retry fails too", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { projection, started } = yield* runScript("start-retry-exhausted", 2, "failed");
      const [run] = projection.runs;
      assert.equal(run?.status, "failed");
      assert.deepEqual(
        projection.attempts.map((attempt) => [attempt.status, attempt.reason]),
        [
          ["failed", "initial"],
          ["failed", "retry"],
        ],
      );
      assert.lengthOf(started, 2);
      const errors = projection.turnItems.filter((item) => item.type === "error");
      assert.lengthOf(errors, 1);
      assert.equal(errors[0]?.nodeId, projection.attempts[1]?.rootNodeId);
    }),
  ),
);
