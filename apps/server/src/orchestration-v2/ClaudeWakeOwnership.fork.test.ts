import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ResourceLimits } from "../resourceLimits/ResourceLimits.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ClaudeOrchestratorReplayHarness } from "./Adapters/ClaudeAdapterV2.testkit.ts";
import { makeDelegatedChildRelease } from "./DelegatedChildRelease.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import { provideDeterministicTestRuntime } from "./testkit/DeterministicRuntime.ts";
import { layerProviderReplay } from "./testkit/ProviderReplayHarness.ts";
import { CLAUDE_MODEL_SELECTION, materializeFixtureInput } from "./testkit/fixtures/shared.ts";

it.effect.each([
  { emptyFirst: false, end: "wake" },
  { emptyFirst: true, end: "wake" },
  { emptyFirst: true, end: "expire" },
  { emptyFirst: false, end: "stop" },
  { emptyFirst: false, end: "retry" },
  { emptyFirst: false, end: "stop-retry" },
  { emptyFirst: false, end: "exit" },
  { emptyFirst: false, end: "restart" },
  { emptyFirst: false, end: "top-level" },
  { emptyFirst: true, end: "second-task" },
  { emptyFirst: false, end: "idle-expire" },
])("owns an awaited Claude wake ($emptyFirst, $end)", ({ emptyFirst, end }) =>
  Effect.gen(function* () {
    const scenarioName = `fork-claude-wake-${emptyFirst}-${end}`;
    const deliverWake = [
      "wake",
      "retry",
      "stop-retry",
      "top-level",
      "second-task",
      "idle-expire",
    ].includes(end);
    const secondTask = end === "second-task";
    const workspace = yield* checkpointWorkspace(scenarioName);
    const nativeId = "00000000-0000-4000-8000-000000000001";
    let ordinal = 10;
    const frame = (body: Record<string, unknown>) => ({
      ...body,
      session_id: nativeId,
      uuid: `00000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
    });
    const result = (text: string) =>
      frame({
        type: "result",
        subtype: "success",
        is_error: false,
        result: text,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
      });
    const assistant = (text: string, id: string) =>
      frame({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id,
          type: "message",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          model: CLAUDE_MODEL_SELECTION.model,
          content: [{ type: "text", text }],
        },
      });
    const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
      provider: "claudeAgent",
      protocol: "claude-agent-sdk.query",
      version: "1",
      scenario: scenarioName,
      metadata: { nativeSessionId: nativeId },
      entries: [
        {
          type: "expect_outbound",
          frame: {
            type: "query.open",
            options: {
              model: CLAUDE_MODEL_SELECTION.model,
              tools: { type: "preset", preset: "claude_code" },
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
              settings: { showThinkingSummaries: true },
              sessionId: nativeId,
            },
          },
        },
        {
          type: "expect_outbound",
          frame: {
            type: "prompt.offer",
            message: {
              type: "user",
              message: { role: "user", content: "Work" },
              parent_tool_use_id: null,
            },
          },
        },
        ...(secondTask
          ? [
              {
                type: "emit_inbound" as const,
                label: "task-start",
                frame: frame({
                  type: "system",
                  subtype: "task_started",
                  task_id: "other",
                  tool_use_id: "tool_other",
                  task_type: "local_bash",
                  description: "Second waiter",
                  is_backgrounded: true,
                }),
              },
            ]
          : []),
        {
          type: "emit_inbound",
          label: secondTask ? "primary-start" : "task-start",
          frame: frame({
            type: "system",
            subtype: "task_started",
            task_id: "waiter",
            tool_use_id: "tool_waiter",
            task_type: "local_bash",
            description: "PowerShell waiter",
            is_backgrounded: true,
          }),
        },
        { type: "emit_inbound", label: "root-result", frame: result("Waiting") },
        ...(emptyFirst
          ? [
              {
                type: "emit_inbound" as const,
                label: "removed",
                frame: frame({ type: "system", subtype: "background_tasks_changed", tasks: [] }),
              },
            ]
          : []),
        ...(end === "expire"
          ? []
          : [
              {
                type: "emit_inbound" as const,
                label: emptyFirst ? "notification" : "removed",
                frame: frame({
                  type: "system",
                  subtype: "task_notification",
                  task_id: "waiter",
                  tool_use_id: "tool_waiter",
                  task_type: "local_bash",
                  status: "completed",
                  output_file: "/tmp/waiter.output",
                  summary: "Waiter exited",
                }),
              },
            ]),
        ...(!deliverWake
          ? end === "exit"
            ? [
                {
                  type: "emit_inbound" as const,
                  label: "query-exit",
                  frame: frame({ type: "system", subtype: "status", status: null }),
                },
                { type: "runtime_exit" as const, status: "success" as const },
              ]
            : [{ type: "expect_outbound" as const, frame: { type: "query.close" } }]
          : [
              {
                type: "emit_inbound" as const,
                label: "native-wake",
                frame: assistant("Wake received", "wake"),
              },
              ...(end === "stop-retry" || end === "idle-expire"
                ? [{ type: "expect_outbound" as const, frame: { type: "query.close" } }]
                : [
                    {
                      type: "emit_inbound" as const,
                      label: "wake-result",
                      frame: result("Wake received"),
                    },
                    {
                      type: "expect_outbound" as const,
                      frame: {
                        type: "prompt.offer",
                        message: {
                          type: "user",
                          message: { role: "user", content: "After wake" },
                          parent_tool_use_id: null,
                        },
                      },
                    },
                    { type: "emit_inbound" as const, frame: result("Follow-up received") },
                    ...(secondTask
                      ? [
                          {
                            type: "emit_inbound" as const,
                            label: "second-wake",
                            frame: frame({
                              type: "system",
                              subtype: "task_notification",
                              task_id: "other",
                              tool_use_id: "tool_other",
                              task_type: "local_bash",
                              status: "completed",
                              output_file: "/tmp/other.output",
                              summary: "Second waiter exited",
                            }),
                          },
                          {
                            type: "emit_inbound" as const,
                            frame: assistant("Second wake received", "second-wake"),
                          },
                          {
                            type: "emit_inbound" as const,
                            label: "second-result",
                            frame: result("Second wake received"),
                          },
                        ]
                      : []),
                  ]),
            ]),
      ],
    });
    const materialized = yield* materializeFixtureInput({
      scenario: scenarioName,
      fixtureInput: { steps: [{ type: "message", text: "Work" }] },
      driver: ProviderDriverKind.make("claudeAgent"),
      modelSelection: CLAUDE_MODEL_SELECTION,
    }).pipe(Effect.provide(IdAllocator.layer));
    const gate = makeProviderReplayGate([
      "task-start",
      "root-result",
      "removed",
      "notification",
      "native-wake",
      "wake-result",
      "query-exit",
      "second-wake",
      "second-result",
    ]);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "fork-claude-wake-db-" });
    const database = SqlitePersistence.layerFromPath(path.join(baseDir, "statev2.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
    );
    const recoveryLayer = ProviderRuntimeRecoveryService.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ProjectionStore.layer.pipe(Layer.provide(database)),
          EffectOutbox.layer.pipe(Layer.provide(database)),
          IdAllocator.layer,
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        ),
      ),
    );
    const dispatchEntered = yield* Deferred.make<void>();
    const allowDispatch = yield* Deferred.make<void>();
    const dispatched = yield* Deferred.make<void>();
    const secondDispatched = yield* Deferred.make<void>();
    const rejected = yield* Deferred.make<void>();
    const attempts: Array<{ commandId: string; messageId: string }> = [];
    const defaults = yield* ResourceLimits;
    let held = false;
    yield* Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(allowDispatch, undefined).pipe(
          Effect.andThen(Effect.sync(() => gate.releaseAll())),
        ),
      );
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const effects = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const effectDaemon = yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = materialized.projectionThreadIds[0]!;
      const event = (predicate: (stored: OrchestrationV2StoredEvent) => boolean) =>
        sink.stream({ threadId, afterSequence: 0 }).pipe(Stream.filter(predicate), Stream.runHead);
      for (const command of materialized.commands)
        yield* orchestrator.dispatch(
          command.type === "thread.create" ? { ...command, worktreePath: workspace } : command,
        );
      const started = yield* event(
        ({ event }) =>
          event.type === "provider-thread.updated" &&
          event.payload.pendingBackgroundTasks?.some((task) => task.taskId === "waiter") === true,
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      gate.release("task-start");
      yield* Fiber.join(started);
      const before = yield* orchestrator.getThreadProjection(threadId);
      const providerThread = before.providerThreads[0]!;
      const runtime = Option.getOrThrow(yield* sessions.get(providerThread.providerSessionId!));
      const marked = yield* event(
        ({ event }) =>
          event.type === "provider-thread.updated" &&
          event.payload.pendingBackgroundTasks?.some((task) => task.awaited) === true,
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      const awaited = yield* runtime.awaitBackgroundTasks!({
        providerThread,
        taskIds: secondTask ? ["waiter", "other"] : ["waiter"],
        awaited: true,
      });
      assert.deepEqual(awaited.matched, secondTask ? ["waiter", "other"] : ["waiter"]);
      yield* Fiber.join(marked);
      gate.release("root-result");
      yield* event(
        ({ event }) => event.type === "run.updated" && event.payload.status === "completed",
      );
      yield* effects.drain();
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const now = yield* DateTime.now;
      const parent = ThreadId.make("fork-wake-parent");
      const create = materialized.commands.find((command) => command.type === "thread.create")!;
      yield* orchestrator.dispatch({
        ...create,
        commandId: CommandId.make("fork-create-parent"),
        threadId: parent,
      });
      const taskId = NodeId.make("fork-wake-delegation");
      yield* sink.write({
        events: [
          {
            id: EventId.make("fork-wake-lineage"),
            type: "thread.pull-request-synced",
            threadId,
            occurredAt: now,
            payload: {
              ...projection.thread,
              pullRequests: [
                {
                  host: "example.test",
                  repository: "owner/repository",
                  number: 1,
                  url: "https://example.test/owner/repository/pull/1",
                  source: "manual",
                  linkedAt: DateTime.formatIso(now),
                  snapshot: {
                    state: "merged",
                    title: "Merged build",
                    headBranch: "feature",
                    baseBranch: "main",
                    isDraft: false,
                    updatedAt: DateTime.formatIso(now),
                    syncedAt: DateTime.formatIso(now),
                    mergedAt: DateTime.formatIso(now),
                  },
                  stack: null,
                },
              ],
              lineage:
                end === "top-level"
                  ? projection.thread.lineage
                  : {
                      parentThreadId: parent,
                      relationshipToParent: "subagent",
                      rootThreadId: parent,
                    },
            },
          },
          ...(end === "top-level"
            ? []
            : [
                {
                  id: EventId.make("fork-wake-task"),
                  type: "subagent.updated",
                  threadId: parent,
                  nodeId: taskId,
                  driver: ProviderDriverKind.make("claudeAgent"),
                  occurredAt: now,
                  payload: {
                    id: taskId,
                    threadId: parent,
                    runId: null,
                    parentNodeId: NodeId.make("fork-parent-node"),
                    origin: "app_owned",
                    createdBy: "agent",
                    driver: ProviderDriverKind.make("claudeAgent"),
                    providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
                    providerThreadId: null,
                    childThreadId: threadId,
                    nativeTaskRef: null,
                    prompt: "Work",
                    title: "Work",
                    model: null,
                    status: "completed",
                    result: "Done",
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                  },
                } as const,
              ]),
        ],
      });
      const sequence = yield* orchestrator.getThreadEventSequence(threadId);
      const removed = yield* sink.stream({ threadId, afterSequence: sequence }).pipe(
        Stream.filter(({ event }) => event.type === "provider-thread.updated"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      gate.release("removed");
      yield* Fiber.join(removed);
      const [candidate] = yield* projections.getSettlementCandidates(threadId);
      assert.isDefined(candidate);
      assert.isNotNull(
        ThreadSettlementService.resolveAutoSettlementAt({
          thread: { ...candidate!, pendingBackgroundTasks: [] },
          pullRequest: null,
          nowMs: DateTime.toEpochMillis(yield* DateTime.now),
          autoSettleOnMerge: true,
          autoSettleAfterDays: null,
        }),
      );
      const release = yield* makeDelegatedChildRelease();
      const cleanup = Effect.fn("ClaudeWakeReplay.cleanup")(function* (expectedTask: string) {
        yield* release.releaseFinishedChildren(threadId);
        // Run the ordinary settlement worker against the same SQLite projections.
        const read = yield* Deferred.make<void>();
        const settlement = yield* ThreadSettlementService.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
              Layer.succeed(ProjectionStore.ProjectionStoreV2, {
                ...projections,
                getReleasableDelegatedChildren: (id) =>
                  projections
                    .getReleasableDelegatedChildren(id)
                    .pipe(Effect.tap(() => Deferred.succeed(read, undefined))),
              }),
              ProjectStore.layer.pipe(Layer.provide(database)),
              ServerSettings.layerTest({
                sidebarAutoSettleOnMerge: true,
                sidebarAutoSettleAfterDays: null,
              }),
              Layer.mock(GitManager.GitManager)({}),
              Layer.mock(PullRequestService.PullRequestService)({
                subscribeMerges: Effect.succeed(Stream.never),
              }),
              Layer.mock(TerminalManager.TerminalManager)({ closeIdle: () => Effect.void }),
              Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
                runForThread: () => Effect.succeed({ status: "no-script" }),
              }),
              Layer.succeed(ServerActivation.ServerActivation, Effect.void),
            ),
          ),
        );
        yield* settlement.start();
        yield* Deferred.await(read);
        yield* settlement.drain;
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).thread.settledOverride,
          null,
        );
        assert.deepEqual(yield* sessions.releaseIdleSessions!({ keepThreadIds: new Set() }), []);
        assert.isTrue(yield* sessions.isLive(providerThread.providerSessionId!));
        assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
        assert.isTrue(yield* runtime.hasPendingBackgroundWorkForThread!(providerThread));
        assert.isTrue(
          (yield* orchestrator.getThreadProjection(
            threadId,
          )).providerThreads[0]!.pendingBackgroundTasks?.some(
            (task) => task.taskId === expectedTask && task.awaited === true,
          ),
        );
      }, Effect.scoped);
      yield* cleanup("waiter");
      if (end === "restart") {
        yield* Fiber.interrupt(effectDaemon);
        yield* Effect.gen(function* () {
          const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
          yield* recovery.prepareForShutdown;
          yield* recovery.reconcile("shutdown");
        }).pipe(
          Effect.provide(
            recoveryLayer.pipe(Layer.provide(Layer.succeed(EventSink.EventSinkV2, sink))),
          ),
        );
        yield* sessions.close(providerThread.providerSessionId!);
        return;
      }
      if (!deliverWake) {
        const ended = yield* sink
          .stream({ threadId, afterSequence: yield* orchestrator.getThreadEventSequence(threadId) })
          .pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "provider-thread.updated" &&
                (event.payload.pendingBackgroundTasks?.length ?? 0) === 0,
            ),
            Stream.runHead,
            Effect.forkScoped({ startImmediately: true }),
          );
        if (end === "expire") {
          // No notification or native frames follow the empty roster level.
          yield* TestClock.adjust("2 minutes");
        } else if (end === "exit") {
          gate.release("query-exit");
        } else {
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("fork-stop-waiter"),
            threadId,
            stopDelegatedTasks: false,
          });
          yield* effects.drain();
        }
        yield* Fiber.join(ended);
        assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        if (end === "exit")
          assert.isTrue(
            (yield* orchestrator.getThreadProjection(threadId)).turnItems.some(
              (item) => item.type === "system_notice" && item.title === "Background wake cancelled",
            ),
          );
        if (end === "expire") {
          yield* release.releaseFinishedChildren(threadId);
          yield* effects.drain();
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).thread.settledOverride,
            "settled",
          );
        }
        return;
      }
      if (emptyFirst) gate.release("notification");
      held = true;
      gate.release("native-wake");
      if (end === "retry" || end === "stop-retry") {
        yield* Deferred.await(rejected);
        yield* cleanup("waiter");
        if (end === "stop-retry") {
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("fork-stop-retrying-waiter"),
            threadId,
            stopDelegatedTasks: false,
          });
          yield* effects.drain();
          yield* TestClock.adjust("3 minutes");
          assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
          assert.lengthOf(attempts, 1);
          assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
          return;
        }
        yield* TestClock.adjust("1 second");
      }
      yield* Deferred.await(dispatchEntered);
      yield* cleanup("waiter");
      yield* Deferred.succeed(allowDispatch, undefined);
      yield* Deferred.await(dispatched);
      const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.status === "queued",
      )!;
      assert.isDefined(queued);
      assert.isTrue(queued.queueHeld);
      const followUpId = MessageId.make("fork-follow-up");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("fork-follow-up"),
        threadId,
        messageId: followUpId,
        text: "After wake",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      const queue = (yield* orchestrator.getThreadProjection(threadId)).runs.filter(
        (run) => run.status === "queued",
      );
      assert.deepEqual(
        queue.map((run) => run.userMessageId),
        [queued.userMessageId, followUpId],
      );
      if (end === "idle-expire") {
        const closed = yield* event(
          ({ event }) =>
            event.type === "provider-session.updated" &&
            event.payload.id === providerThread.providerSessionId &&
            event.payload.status === "stopped",
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* TestClock.adjust("3 seconds");
        yield* Fiber.join(closed);
        const expired = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(
          expired.turnItems.some(
            (item) => item.type === "system_notice" && item.title === "Background wake cancelled",
          ),
        );
        assert.isFalse(yield* sessions.isLive(providerThread.providerSessionId!));
        assert.deepEqual(
          expired.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
          [queued.userMessageId, followUpId],
        );
        return;
      }
      // Admission can take longer than the missing-native-wake deadline.
      if (!secondTask) yield* TestClock.adjust("3 minutes");
      yield* cleanup("waiter");
      held = false;
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("fork-admit-wake"),
        threadId,
      });
      yield* effects.drain();
      gate.release("wake-result");
      yield* event(
        ({ event }) =>
          event.type === "run.updated" &&
          event.payload.id === queued.id &&
          event.payload.status === "completed",
      );
      yield* event(
        ({ event }) =>
          event.type === "run.updated" &&
          event.payload.userMessageId === followUpId &&
          event.payload.status === "completed",
      );
      yield* effects.drain();
      const completed = yield* orchestrator.getThreadProjection(threadId);
      assert.isTrue(
        completed.turnItems.some(
          (item) =>
            item.runId === queued.id &&
            item.type === "assistant_message" &&
            item.text.includes("Wake received"),
        ),
      );
      if (secondTask) {
        assert.deepEqual(
          completed.providerThreads[0]!.pendingBackgroundTasks?.map((task) => task.taskId),
          ["other"],
        );
        yield* cleanup("other");
        gate.release("second-wake");
        yield* Deferred.await(secondDispatched);
        yield* effects.drain();
        gate.release("second-result");
        yield* event(
          ({ event }) =>
            event.type === "run.updated" &&
            !completed.runs.some((run) => run.id === event.payload.id) &&
            ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status),
        );
        yield* effects.drain();
        const second = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(
          second.turnItems.some(
            (item) =>
              item.type === "assistant_message" && item.text.includes("Second wake received"),
          ),
        );
        assert.deepEqual(
          second.runs.map((run) => run.status),
          ["completed", "completed", "completed", "completed"],
        );
        assert.deepEqual(second.providerThreads[0]!.pendingBackgroundTasks, []);
      } else assert.deepEqual(completed.providerThreads[0]!.pendingBackgroundTasks, []);
      assert.deepEqual(
        completed.runs.map((run) => run.status),
        ["completed", "completed", "completed"],
      );
      if (end === "retry") {
        assert.lengthOf(attempts, 2);
        assert.notEqual(attempts[0]!.commandId, attempts[1]!.commandId);
        assert.equal(attempts[0]!.messageId, attempts[1]!.messageId);
      }
      yield* release.releaseFinishedChildren(threadId);
      yield* effects.drain();
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).thread.settledOverride,
        end === "top-level" ? null : "settled",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerProviderReplay(
            { name: scenarioName, transcript, ...materialized },
            ClaudeOrchestratorReplayHarness,
            {
              databaseLayer: database,
              ...(end === "idle-expire"
                ? { idleSessionOptions: { idleTimeoutMs: 1_000, maxIdlePinMs: 1_000 } }
                : {}),
              runEffectWorker: false,
              runContinuationWorker: true,
              replayGate: gate,
              continuationDispatch: (dispatch) => (command) =>
                Effect.gen(function* () {
                  if (command.type !== "message.dispatch" || command.creationSource !== "provider")
                    return yield* dispatch(command);
                  attempts.push({ commandId: command.commandId, messageId: command.messageId });
                  if ((end === "retry" || end === "stop-retry") && attempts.length === 1) {
                    return yield* dispatch({
                      ...command,
                      threadId: ThreadId.make("fork-missing-on-first-attempt"),
                    }).pipe(Effect.tapError(() => Deferred.succeed(rejected, undefined)));
                  }
                  yield* Deferred.succeed(dispatchEntered, undefined);
                  yield* Deferred.await(allowDispatch);
                  const result = yield* dispatch(command);
                  yield* Deferred.succeed(dispatched, undefined);
                  if (secondTask && attempts.length === 2)
                    yield* Deferred.succeed(secondDispatched, undefined);
                  return result;
                }),
            },
          ),
          ProjectionStore.layer.pipe(Layer.provide(database)),
          NodeServices.layer,
        ),
      ),
      Effect.provideService(ResourceLimits, {
        ...defaults,
        admit: () =>
          Effect.succeed(
            held ? { admitted: false, notice: "Test memory pressure" } : { admitted: true },
          ),
      }),
      Effect.scoped,
    );
    if (end === "restart") {
      // Reopen the same SQLite file after every live adapter and first runtime has closed.
      const restarted = layerProviderReplay(
        {
          name: `${scenarioName}-startup`,
          transcript: { ...transcript, entries: [] },
          ...materialized,
        },
        ClaudeOrchestratorReplayHarness,
        { databaseLayer: database, runEffectWorker: false },
      );
      yield* Effect.gen(function* () {
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* recovery.reconcile("startup");
        const threadId = materialized.projectionThreadIds[0]!;
        const source = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const pending = Option.getOrThrow(
          yield* outbox.get(`effect:restart-continuation:${source.id}`),
        );
        assert.equal(pending.status, "pending");
        assert.equal(pending.request.type, "provider-runtime.continue");
        assert.isTrue(source.restartCancelledBackgroundWork?.some((work) => work.awaited === true));
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(1);
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(after.runs, 2);
        assert.equal(after.runs[1]!.restartContinuationOfRunId, source.id);
        assert.equal(after.runs[1]!.status, "starting");
      }).pipe(Effect.provide(recoveryLayer.pipe(Layer.provideMerge(restarted))), Effect.scoped);
    }
  }).pipe(provideDeterministicTestRuntime, Effect.provide(NodeServices.layer), Effect.scoped),
);
