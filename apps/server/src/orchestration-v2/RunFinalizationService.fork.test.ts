import { assert, it } from "@effect/vitest";
import { CheckpointScopeId, CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as CheckpointRollback from "./CheckpointRollbackService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import * as ProviderTurnControl from "./ProviderTurnControlService.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as RuntimeRequests from "./RuntimeRequestService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitles from "./ThreadTitleRegenerationService.ts";

const scopeId = CheckpointScopeId.make("scope:refresh");
const runId = RunId.make("run:refresh");

const projectionsWithScope = Layer.mock(ProjectionStore.ProjectionStoreV2)({
  getCheckpointContext: (threadId) =>
    Effect.succeed({
      runs: [],
      checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: `/${threadId}` }],
      checkpoints: [],
    }),
});

const finalizationLayer = (observer: Layer.Layer<never>, calls: string[]) =>
  RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        projectionsWithScope,
        observer,
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
          execute: () => Effect.sync(() => calls.push("capture")),
        }),
      ),
    ),
  );

it.effect("the next turn starts while the workspace refresh after a checkpoint stalls", () => {
  const threadId = ThreadId.make("thread:refresh-stall");
  const calls: string[] = [];
  const refreshGate = Deferred.makeUnsafe<void>();
  const refreshEnded = Deferred.makeUnsafe<void>();
  const observer = Layer.succeed(RunFinalization.RunFinalizationObserver, {
    refresh: () =>
      Effect.gen(function* () {
        calls.push("refresh:start");
        yield* Deferred.await(refreshGate);
        calls.push("refresh:end");
        yield* Deferred.succeed(refreshEnded, undefined);
      }),
    refreshAfterTurn: () => Effect.void,
  });
  const executor = EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        finalizationLayer(observer, calls),
        Layer.mock(ProviderSessions.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderTurnControl.ProviderTurnControlServiceV2)({}),
        Layer.mock(CheckpointRollback.CheckpointRollbackServiceV2)({}),
        Layer.mock(RuntimeRequests.RuntimeRequestServiceV2)({}),
        Layer.mock(ThreadTitles.ThreadTitleRegenerationService)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        ServerSettings.layerTest(),
        Layer.mock(ProviderTurnStart.ProviderTurnStartServiceV2)({
          start: () => Effect.sync(() => calls.push("start")).pipe(Effect.asVoid),
        }),
      ),
    ),
  );
  const outbox = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
  const worker = EffectWorker.layer.pipe(Layer.provideMerge(Layer.merge(executor, outbox)));

  return Effect.gen(function* () {
    const queue = yield* EffectOutbox.EffectOutboxV2;
    const effectWorker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* queue.enqueue([
      {
        id: "effect:refresh-stall:capture",
        commandId: CommandId.make("command:refresh-stall:capture"),
        threadId,
        request: { type: "checkpoint.capture", runId, scopeId },
      },
      {
        id: "effect:refresh-stall:start",
        commandId: CommandId.make("command:refresh-stall:start"),
        threadId,
        request: { type: "provider-turn.start", runId: RunId.make("run:refresh-stall:next") },
      },
    ]);

    assert.equal(yield* effectWorker.drain(2), 2);
    assert.deepEqual(calls, ["capture", "refresh:start", "start"]);
    const captured = Option.getOrThrow(yield* queue.get("effect:refresh-stall:capture"));
    assert.equal(captured.status, "succeeded");
    assert.equal(captured.attemptCount, 1);

    yield* Deferred.succeed(refreshGate, undefined);
    yield* Deferred.await(refreshEnded);
    assert.deepEqual(calls, ["capture", "refresh:start", "start", "refresh:end"]);
  }).pipe(Effect.provide(Layer.fresh(worker)));
});

it.effect(
  "two refreshes run at once, and a stalled one gives its place up after five minutes",
  () => {
    const calls: string[] = [];
    const refreshes: string[] = [];
    const thirdStarted = Deferred.makeUnsafe<void>();
    const observer = Layer.succeed(RunFinalization.RunFinalizationObserver, {
      refresh: ({ cwd }) =>
        Effect.gen(function* () {
          refreshes.push(cwd);
          if (refreshes.length === 3) yield* Deferred.succeed(thirdStarted, undefined);
          return yield* Effect.never;
        }),
      refreshAfterTurn: () => Effect.void,
    });

    return Effect.gen(function* () {
      const service = yield* RunFinalization.RunFinalizationService;
      for (const index of [1, 2, 3]) {
        yield* service.finalize({ threadId: ThreadId.make(`thread-${index}`), runId, scopeId });
      }
      assert.deepEqual(calls, ["capture", "capture", "capture"]);
      assert.deepEqual(refreshes, ["/thread-1", "/thread-2"]);

      yield* TestClock.adjust(Duration.seconds(299));
      assert.deepEqual(refreshes, ["/thread-1", "/thread-2"]);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Deferred.await(thirdStarted);
      assert.deepEqual(refreshes, ["/thread-1", "/thread-2", "/thread-3"]);
    }).pipe(Effect.provide(finalizationLayer(observer, calls)));
  },
);
