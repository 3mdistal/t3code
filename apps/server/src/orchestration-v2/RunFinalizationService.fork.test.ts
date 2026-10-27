import { assert, it } from "@effect/vitest";
import { CheckpointScopeId, RunId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

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

      yield* TestClock.adjust(Duration.minutes(5));
      yield* Deferred.await(thirdStarted);
      assert.deepEqual(refreshes, ["/thread-1", "/thread-2", "/thread-3"]);
    }).pipe(Effect.provide(finalizationLayer(observer, calls)));
  },
);
