import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { offerClaudeSteer } from "./ClaudeRuntimeRequests.ts";

it.effect("retires an accepted steer even if its offer is interrupted after enqueue", () =>
  Effect.gen(function* () {
    const queued = yield* Deferred.make<void>();
    let accepted = false;
    let retired = false;
    const fiber = yield* offerClaudeSteer({
      offer: (onQueued) =>
        Effect.gen(function* () {
          onQueued();
          yield* Deferred.succeed(queued, undefined);
          return yield* Effect.never;
        }),
      onAccepted: () => {
        accepted = true;
      },
      retire: Effect.sync(() => {
        retired = true;
      }),
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(queued);
    yield* Fiber.interrupt(fiber);
    assert.isTrue(accepted);
    assert.isTrue(retired);
  }),
);

it.effect.each([false, true])("retires a failed offer only if it was accepted (%s)", (enqueue) =>
  Effect.gen(function* () {
    let retired = false;
    yield* offerClaudeSteer({
      offer: (onQueued) =>
        Effect.gen(function* () {
          if (enqueue) onQueued();
          return yield* Effect.fail("protocol logging failed");
        }),
      onAccepted: () => {},
      retire: Effect.sync(() => {
        retired = true;
      }),
    }).pipe(Effect.result);
    assert.equal(retired, enqueue);
  }),
);

it.effect("supports offers without an acceptance callback and commits acceptance once", () =>
  Effect.gen(function* () {
    for (const callsOnQueued of [false, true]) {
      let accepted = 0;
      let retired = 0;
      yield* offerClaudeSteer({
        offer: (onQueued) =>
          Effect.sync(() => {
            if (callsOnQueued) onQueued();
          }),
        onAccepted: () => {
          accepted++;
        },
        retire: Effect.sync(() => {
          retired++;
        }),
      });
      assert.equal(accepted, 1);
      assert.equal(retired, 1);
    }
  }),
);
