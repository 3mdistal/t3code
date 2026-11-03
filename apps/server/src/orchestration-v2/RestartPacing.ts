// fork: startup admission and continuation retries; see FORK.md.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

const RESTART_START_CONCURRENCY = 2;
export const RESTART_START_GAP_MS = 3_000;

export const restartDispatchCommandId = (sourceRunId: string, attempt: number) =>
  `command:restart-continuation:${sourceRunId}${attempt > 1 ? `:attempt:${attempt}` : ""}`;

export const restartRetryDelayMs = (attempt: number) =>
  Math.min(60_000, 5_000 * 2 ** (attempt - 1));

export const makeStartPacing = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  let nextStartAt = 0;

  const applies = () => sql`
    candidate.effect_type = 'provider-turn.start' AND (
      EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs AS restart_run
        WHERE restart_run.run_id = json_extract(candidate.payload_json, '$.runId')
          AND restart_run.status = 'starting'
          AND (restart_run.requested_at < ${startedAt}
            OR json_extract(restart_run.payload_json, '$.restartContinuationOfRunId') IS NOT NULL)
      )
    )
  `;
  const capacity = () => sql`
    NOT (${applies()}) OR (
      SELECT COUNT(*) FROM orchestration_v2_effect_outbox AS starting
      WHERE starting.status = 'running' AND starting.effect_type = 'provider-turn.start'
    ) < ${RESTART_START_CONCURRENCY}
  `;
  const deadline = () => sql`
    CASE WHEN ${applies()}
      THEN MAX(candidate.available_at, ${DateTime.formatIso(DateTime.makeUnsafe(nextStartAt))})
      ELSE candidate.available_at END
  `;
  return {
    withClaimLock: lock.withPermit,
    capacity,
    deadline,
    ready: (now: DateTime.Utc) =>
      sql`${capacity()} AND ${deadline()} <= ${DateTime.formatIso(now)}`,
    // Covered by the outbox claim span; only restored work consumes the gap.
    claimed: Effect.fnUntraced(function* (
      request: { readonly type: string; readonly runId?: string },
      now: DateTime.Utc,
    ) {
      if (request.type !== "provider-turn.start" || request.runId === undefined) return;
      const rows = yield* sql<{ readonly restored: number }>`
        SELECT requested_at < ${startedAt}
          OR json_extract(payload_json, '$.restartContinuationOfRunId') IS NOT NULL AS restored
        FROM orchestration_v2_projection_runs
        WHERE run_id = ${request.runId} AND status = 'starting'
      `;
      if (rows[0]?.restored === 1) nextStartAt = DateTime.toEpochMillis(now) + RESTART_START_GAP_MS;
    }),
  };
});
