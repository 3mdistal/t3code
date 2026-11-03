import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { RESTART_START_GAP_MS } from "./RestartPacing.ts";

it.effect("paces six restored starts while leaving control effects claimable", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('stale:run', 'stale:thread', 1, 'codex', 'failed', ${now},
        ${JSON.stringify({ restartContinuationOfRunId: "stale:source" })})
    `;
    yield* outbox.enqueue([
      {
        id: "stale:start",
        commandId: CommandId.make("stale:start"),
        threadId: ThreadId.make("stale:thread"),
        request: { type: "provider-turn.start", runId: RunId.make("stale:run") },
      },
    ]);
    const stale = Option.getOrThrow(yield* outbox.claimNext({ workerId: "pacing-test" }));
    yield* outbox.succeed({ effectId: stale.id, workerId: "pacing-test" });
    const starts = Array.from({ length: 6 }, (_, index) => ({
      id: `start:${index}`,
      commandId: CommandId.make(`start:${index}`),
      threadId: ThreadId.make(`thread:${index}`),
      request: { type: "provider-turn.start" as const, runId: RunId.make(`run:${index}`) },
    }));
    for (const start of starts)
      yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${start.request.runId}, ${start.threadId}, 1, 'codex', 'starting', ${now},
        ${JSON.stringify({ restartContinuationOfRunId: `source:${start.id}` })})
    `;
    yield* outbox.enqueue(starts);
    const claim = () => outbox.claimNext({ workerId: "pacing-test" });
    const one = Option.getOrThrow(yield* claim());
    assert.isTrue(Option.isNone(yield* claim()));
    assert.equal(
      DateTime.formatIso(Option.getOrThrow(yield* outbox.nextClaimableAt)),
      DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(now), { milliseconds: RESTART_START_GAP_MS }),
      ),
    );
    yield* TestClock.adjust(RESTART_START_GAP_MS);
    const two = Option.getOrThrow(yield* claim());
    yield* TestClock.adjust(RESTART_START_GAP_MS);
    assert.isTrue(Option.isNone(yield* claim()), "two starts are already in progress");
    assert.isTrue(Option.isNone(yield* outbox.nextClaimableAt));
    const stop = {
      id: "stop",
      commandId: CommandId.make("stop"),
      threadId: ThreadId.make("thread:stop"),
      request: { type: "delegated-tasks.stop" as const },
    };
    yield* outbox.enqueue([stop]);
    assert.equal(Option.getOrThrow(yield* claim()).id, stop.id);
    yield* outbox.succeed({ effectId: one.id, workerId: "pacing-test" });
    const three = Option.getOrThrow(yield* claim());
    assert.equal(three.id, starts[2]!.id);
    yield* outbox.succeed({ effectId: two.id, workerId: "pacing-test" });
    yield* outbox.succeed({ effectId: three.id, workerId: "pacing-test" });
    for (const expected of starts.slice(3)) {
      assert.isTrue(Option.isNone(yield* claim()));
      yield* TestClock.adjust(RESTART_START_GAP_MS);
      const next = Option.getOrThrow(yield* claim());
      assert.equal(next.id, expected.id);
      yield* outbox.succeed({ effectId: next.id, workerId: "pacing-test" });
    }
    assert.isTrue(Option.isNone(yield* claim()));
  }).pipe(
    Effect.provide(EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);
