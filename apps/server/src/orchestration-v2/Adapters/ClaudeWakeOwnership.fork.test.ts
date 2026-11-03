import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { TestClock } from "effect/testing";
import {
  makeClaudeWakeOwnership,
  CLAUDE_WAKE_OWNERSHIP_TIMEOUT_MS,
} from "./ClaudeWakeOwnership.ts";

it.effect("bounds missing native evidence without renewing the deadline on duplicate removal", () =>
  Effect.gen(function* () {
    const deadlines = yield* Queue.unbounded<boolean>();
    const ownership = makeClaudeWakeOwnership({
      scope: yield* Effect.scope,
      onDeadline: (lease) =>
        Effect.sync(() => ownership.expire(lease)).pipe(
          Effect.flatMap((expired) => Queue.offer(deadlines, expired)),
          Effect.asVoid,
        ),
    });
    const query = {};
    const task = { taskId: "waiter", kind: "command" as const, awaited: true as const };
    yield* ownership.acquire("native", query, [{ taskId: "unawaited", kind: "command" }]);
    assert.isFalse(ownership.has());
    yield* ownership.acquire("native", query, [task]);
    yield* TestClock.adjust(CLAUDE_WAKE_OWNERSHIP_TIMEOUT_MS - 1);
    yield* ownership.acquire("native", query, [task]);
    yield* TestClock.adjust(1);
    assert.isTrue(yield* Queue.take(deadlines));
    assert.isFalse(ownership.has());
  }),
);

it.effect(
  "retains a proven wake until its owner consumes it, despite an old query's deadline",
  () =>
    Effect.gen(function* () {
      const deadlines = yield* Queue.unbounded<boolean>();
      const ownership = makeClaudeWakeOwnership({
        scope: yield* Effect.scope,
        onDeadline: (lease) =>
          Effect.sync(() => ownership.expire(lease)).pipe(
            Effect.flatMap((expired) => Queue.offer(deadlines, expired)),
            Effect.asVoid,
          ),
      });
      const oldQuery = {};
      const newQuery = {};
      const task = { taskId: "waiter", kind: "command" as const, awaited: true as const };
      yield* ownership.acquire("native", oldQuery, [task]);
      ownership.clear("native");
      yield* ownership.acquire("native", newQuery, [task]);
      ownership.markWaking("native", newQuery);
      yield* TestClock.adjust(CLAUDE_WAKE_OWNERSHIP_TIMEOUT_MS);
      assert.isFalse(yield* Queue.take(deadlines));
      assert.isFalse(yield* Queue.take(deadlines));
      ownership.consumeWake("native", oldQuery);
      ownership.consumeObserved("native", newQuery, task.taskId);
      assert.deepEqual(ownership.merge("native", []), [task]);
      ownership.consumeWake("native", newQuery);
      assert.isFalse(ownership.has());
    }),
);
