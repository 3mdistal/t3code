import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";

const captureEffect = (index: number): EffectOutbox.PendingOrchestrationEffectV2 => ({
  id: `effect:capture:${index}`,
  commandId: CommandId.make(`command:capture:${index}`),
  threadId: ThreadId.make(`thread:capture:${index}`),
  request: {
    type: "checkpoint.capture",
    runId: RunId.make(`run:capture:${index}`),
    scopeId: CheckpointScopeId.make(`scope:capture:${index}`),
  },
});

const providerTurn = {
  providerSessionId: ProviderSessionId.make("provider-session:control"),
  providerThreadId: ProviderThreadId.make("provider-thread:control"),
  providerTurnId: ProviderTurnId.make("provider-turn:control"),
};

const controlEffects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2> = [
  {
    id: "effect:start",
    commandId: CommandId.make("command:start"),
    threadId: ThreadId.make("thread:start"),
    request: { type: "provider-turn.start", runId: RunId.make("run:start") },
  },
  {
    id: "effect:steer",
    commandId: CommandId.make("command:steer"),
    threadId: ThreadId.make("thread:steer"),
    request: {
      type: "provider-turn.steer",
      ...providerTurn,
      messageId: MessageId.make("message:steer"),
    },
  },
  {
    id: "effect:interrupt",
    commandId: CommandId.make("command:interrupt"),
    threadId: ThreadId.make("thread:interrupt"),
    request: { type: "provider-turn.interrupt", ...providerTurn },
  },
  // An interrupt that holds the queue stops the thread's delegated children through this effect.
  {
    id: "effect:stop-delegated",
    commandId: CommandId.make("command:stop-delegated"),
    threadId: ThreadId.make("thread:stop-delegated"),
    request: { type: "delegated-tasks.stop" },
  },
];

/**
 * Captures listed in `stalled` hang until `releaseCaptures` completes, like the
 * captures that held every worker on Oct 26. Every other effect succeeds at once.
 */
const makeHarness = (
  effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>,
  options: Pick<EffectWorker.OrchestrationEffectWorkerOptions, "backgroundConcurrency"> = {},
) =>
  Effect.gen(function* () {
    const releaseCaptures = yield* Deferred.make<void>();
    const executions: string[] = [];
    const started = new Map(effects.map((effect) => [effect.id, Deferred.makeUnsafe<void>()]));
    const stalled = new Set<string>();
    const executor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: (effect) =>
          Effect.gen(function* () {
            executions.push(effect.id);
            const signal = started.get(effect.id);
            if (signal !== undefined) yield* Deferred.succeed(signal, undefined);
            if (stalled.has(effect.id)) yield* Deferred.await(releaseCaptures);
          }),
      }),
    );
    const outbox = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
    const worker = EffectWorker.layerWithOptions({ workerId: "fork-test-worker", ...options }).pipe(
      Layer.provideMerge(Layer.merge(executor, outbox)),
    );
    const awaitStarted = (effectId: string) => Deferred.await(started.get(effectId)!);
    const executionCount = (effectId: string) => executions.filter((id) => id === effectId).length;
    return { releaseCaptures, executions, stalled, worker, awaitStarted, executionCount };
  });

const statusOf = (outbox: EffectOutbox.EffectOutboxV2Shape, effectId: string) =>
  outbox.get(effectId).pipe(Effect.map((effect) => Option.getOrThrow(effect).status));

/** Parks a fiber after every operation until `step` runs it, so a test can interrupt it at any point. */
const makeSteppingScheduler = () => {
  const tasks: Array<() => void> = [];
  const runAll = () => {
    while (tasks.length > 0) tasks.shift()!();
  };
  const scheduler: Scheduler.Scheduler = {
    executionMode: "sync",
    // A resumed fiber spends its first two operations getting back to where it parked.
    shouldYield: (fiber) => fiber.currentOpCount > 2,
    makeDispatcher: () => ({ scheduleTask: (task) => tasks.push(task), flush: runAll }),
  };
  const step = () => tasks.shift()?.();
  return { scheduler, step, runAll };
};

it.effect("a worker without a background slot claims a newer turn effect over older captures", () =>
  Effect.gen(function* () {
    const captures = Array.from({ length: 5 }, (_, index) => captureEffect(index + 1));
    const start = controlEffects[0]!;
    const harness = yield* makeHarness([...captures, start]);
    for (const capture of captures.slice(0, 4)) harness.stalled.add(capture.id);

    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* outbox.enqueue([...captures, start]);

      const stalledWorkers = yield* Effect.forEach(captures.slice(0, 4), () =>
        worker.runOnce.pipe(Effect.forkChild),
      );
      yield* Effect.forEach(captures.slice(0, 4), (capture) => harness.awaitStarted(capture.id));

      // The fifth capture is older and due, but the background share is full.
      assert.isTrue(yield* worker.runOnce);
      assert.deepEqual(harness.executions.slice(4), [start.id]);
      assert.equal(yield* statusOf(outbox, captures[4]!.id), "pending");
      // With no control effect left, an idle worker has nothing due, so it sleeps instead of spinning.
      assert.isTrue(Option.isNone(yield* worker.nextClaimableAt));
      assert.isFalse(yield* worker.runOnce);

      yield* Deferred.succeed(harness.releaseCaptures, undefined);
      yield* Effect.forEach(stalledWorkers, Fiber.join);
      assert.equal(yield* worker.drain(), 1);
      for (const effect of [...captures, start]) {
        assert.equal(yield* statusOf(outbox, effect.id), "succeeded");
        assert.equal(harness.executionCount(effect.id), 1);
      }
    }).pipe(Effect.provide(harness.worker));
  }),
);

it.effect("turn control effects run while stalled captures fill the background share", () =>
  Effect.gen(function* () {
    const captures = Array.from({ length: 6 }, (_, index) => captureEffect(index + 1));
    const harness = yield* makeHarness([...captures, ...controlEffects]);
    for (const capture of captures) harness.stalled.add(capture.id);

    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* outbox.enqueue([...captures, ...controlEffects]);
      yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
      yield* outbox.notifyAvailable(captures.length + controlEffects.length);

      yield* Effect.forEach(captures.slice(0, 4), (capture) => harness.awaitStarted(capture.id));
      yield* Effect.forEach(controlEffects, (effect) => outbox.awaitSettled(effect.id));
      for (const effect of controlEffects) {
        assert.equal(yield* statusOf(outbox, effect.id), "succeeded");
      }
      // Six workers, four of them for background work: the last two captures wait.
      assert.deepEqual(
        harness.executions.filter((id) => id.startsWith("effect:capture:")).toSorted(),
        captures.slice(0, 4).map((capture) => capture.id),
      );

      yield* Deferred.succeed(harness.releaseCaptures, undefined);
      yield* Effect.forEach(captures, (capture) => outbox.awaitSettled(capture.id));
      for (const effect of [...captures, ...controlEffects]) {
        assert.equal(yield* statusOf(outbox, effect.id), "succeeded");
        assert.equal(harness.executionCount(effect.id), 1);
      }
    }).pipe(Effect.provide(harness.worker), Effect.scoped);
  }),
);

it.effect("a cancelled capture gives its background slot back", () =>
  Effect.gen(function* () {
    const captures = Array.from({ length: 5 }, (_, index) => captureEffect(index + 1));
    const harness = yield* makeHarness(captures);
    for (const capture of captures.slice(0, 4)) harness.stalled.add(capture.id);

    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* outbox.enqueue(captures);
      const stalledWorkers = yield* Effect.forEach(captures.slice(0, 4), () =>
        worker.runOnce.pipe(Effect.forkChild),
      );
      yield* Effect.forEach(captures.slice(0, 4), (capture) => harness.awaitStarted(capture.id));
      assert.isFalse(yield* worker.runOnce);

      const cancelled = captures[0]!;
      const cancelledIds = yield* outbox.cancelUnsettled({
        threadId: cancelled.threadId,
        effectTypes: ["checkpoint.capture"],
        reason: "Thread deleted.",
      });
      yield* outbox.signalCancellations(cancelledIds);
      assert.isTrue(yield* Fiber.join(stalledWorkers[0]!));

      assert.isTrue(yield* worker.runOnce);
      assert.equal(yield* statusOf(outbox, cancelled.id), "cancelled");
      assert.equal(yield* statusOf(outbox, captures[4]!.id), "succeeded");
      yield* Deferred.succeed(harness.releaseCaptures, undefined);
      yield* Effect.forEach(stalledWorkers.slice(1), Fiber.join);
    }).pipe(Effect.provide(harness.worker));
  }),
);

it.effect("an interrupt at any step of an empty claim gives the background slot back", () =>
  Effect.gen(function* () {
    // Each entry says whether that claim could take background work.
    const claims: boolean[] = [];
    const outbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: ({ effectTypes }) =>
        Effect.sync(() => {
          claims.push(effectTypes === undefined);
          return Option.none();
        }),
    });
    const worker = EffectWorker.layerWithOptions({ backgroundConcurrency: 1 }).pipe(
      Layer.provide(
        Layer.merge(outbox, Layer.mock(EffectWorker.OrchestrationEffectExecutorV2)({})),
      ),
    );

    yield* Effect.gen(function* () {
      const effectWorker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      let finished = false;
      for (let steps = 0; !finished; steps++) {
        assert.isBelow(steps, 1_000);
        const stepping = makeSteppingScheduler();
        const fiber = yield* effectWorker.runOnce.pipe(
          Effect.provideService(Scheduler.Scheduler, stepping.scheduler),
          Effect.forkChild({ startImmediately: true }),
        );
        for (let step = 0; step < steps; step++) stepping.step();
        finished = fiber.pollUnsafe() !== undefined;
        fiber.interruptUnsafe();
        stepping.runAll();
        yield* Fiber.await(fiber);

        assert.isFalse(yield* effectWorker.runOnce);
        assert.isTrue(claims.at(-1), `the slot leaked after an interrupt at step ${steps}`);
      }
    }).pipe(Effect.provide(worker));
  }),
);

it.effect("a restart mid-stall reruns only the captures it cut off", () =>
  Effect.gen(function* () {
    const captures = Array.from({ length: 6 }, (_, index) => captureEffect(index + 1));
    const harness = yield* makeHarness([...captures, ...controlEffects]);
    for (const capture of captures) harness.stalled.add(capture.id);

    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* outbox.enqueue([...captures, ...controlEffects]);

      const daemon = yield* EffectWorker.runDaemon.pipe(Effect.forkChild);
      yield* outbox.notifyAvailable(captures.length + controlEffects.length);
      yield* Effect.forEach(captures.slice(0, 4), (capture) => harness.awaitStarted(capture.id));
      yield* Effect.forEach(controlEffects, (effect) => outbox.awaitSettled(effect.id));

      // The process dies mid-stall: its claimed captures stay running in the database.
      yield* Fiber.interrupt(daemon);
      assert.equal(yield* statusOf(outbox, captures[0]!.id), "running");
      assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 4, cancelled: 0 });

      yield* Deferred.succeed(harness.releaseCaptures, undefined);
      assert.equal(yield* worker.drain(), captures.length);
      for (const effect of [...captures, ...controlEffects]) {
        assert.equal(yield* statusOf(outbox, effect.id), "succeeded");
      }
      // A capture is replay-safe: it skips a run whose checkpoint is already recorded.
      for (const capture of captures.slice(0, 4)) {
        assert.equal(harness.executionCount(capture.id), 2);
      }
      for (const effect of [...captures.slice(4), ...controlEffects]) {
        assert.equal(harness.executionCount(effect.id), 1);
      }
    }).pipe(Effect.provide(harness.worker));
  }),
);
