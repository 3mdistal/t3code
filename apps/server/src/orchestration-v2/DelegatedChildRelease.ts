// fork: settles a delegated child as soon as its tasks end and nothing in it runs, whatever the
// auto-settle settings, so its provider session is let go. A loaded Codex thread keeps MCP helpers
// that stall Codex on Windows in bulk (openai/codex#42740). See FORK.md.
import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isSnoozed, threadHasQueuedTurnStart } from "./ThreadSettlementService.ts";

/** At most this many children settle in one sweep, oldest first. */
const RELEASES_PER_SWEEP = 40;

/** Latest-run states that leave nothing to cancel. A queued wake shows up here as `queued`. */
const FINISHED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/**
 * The shell's guards for a child the projection query already found finished. Stricter than
 * auto-settle: any background work holds release, since settling stops it, and so does a message
 * Alice wrote after the task ended, which leaves the thread to her and to ordinary auto-settle.
 */
export function isReleasableDelegatedChild(
  thread: ProjectionStore.ProjectionSettlementCandidate,
  taskCompletedAtMs: number,
  nowMs: number,
): boolean {
  if (thread.archivedAt !== null || thread.settledOverride !== null) return false;
  if (thread.pinnedAt != null || thread.autoSettleDisabledAt != null) return false;
  // Settling cancels a queued notification or wake, which the candidate read doesn't exclude.
  if (!FINISHED_RUN_STATUSES.has(thread.status)) return false;
  if (thread.pendingRuntimeRequest !== null) return false;
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return false;
  if (thread.activityRunStatus != null) return false;
  if ((thread.pendingBackgroundTasks ?? []).length > 0) return false;
  if (threadHasQueuedTurnStart(thread, nowMs)) return false;
  if (isSnoozed(thread, nowMs)) return false;
  const userWroteAtMs =
    thread.latestUserAuthoredMessageAt === null
      ? null
      : DateTime.toEpochMillis(thread.latestUserAuthoredMessageAt);
  return userWroteAtMs === null || userWroteAtMs <= taskCompletedAtMs;
}

export const makeDelegatedChildRelease = Effect.fn("DelegatedChildRelease.make")(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const random = yield* SecureRandom.SecureRandom;

  const isReady = Effect.fn("DelegatedChildRelease.isReady")(
    function* (child: ProjectionStore.ProjectionReleasableDelegatedChild) {
      // Upstream reads a child only once its parent is done; this one is released before.
      const [thread] = yield* projections.getSettlementCandidates(child.threadId, {
        withLiveParent: true,
      });
      if (thread === undefined) return false;
      // A change since the projection read waits for the next check.
      if (DateTime.toEpochMillis(thread.updatedAt) > DateTime.toEpochMillis(child.snapshotAt)) {
        return false;
      }
      const now = yield* DateTime.now;
      return isReleasableDelegatedChild(
        thread,
        DateTime.toEpochMillis(child.taskCompletedAt),
        DateTime.toEpochMillis(now),
      );
    },
    (effect, child) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("checking a finished delegated thread skipped", {
              threadId: child.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
        ),
      ),
  );

  const settle = Effect.fn("DelegatedChildRelease.settle")(
    function* (child: ProjectionStore.ProjectionReleasableDelegatedChild) {
      const uuid = yield* random.uuidV4();
      const now = yield* DateTime.now;
      // The orchestrator refuses it if the thread changed after the projection read.
      yield* orchestrator.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make(`server:release-delegated:${child.threadId}:${uuid}`),
        threadId: child.threadId,
        snapshotAt: child.snapshotAt,
        settledAt: now,
      });
    },
    (effect, child) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("releasing a finished delegated thread skipped", {
              threadId: child.threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );

  /**
   * Settles releasable children, or just `threadId` when it is one. The cap counts children that
   * pass every guard, so held ones can't crowd out the rest. Never fails.
   */
  const releaseFinishedChildren = (threadId?: ThreadId) =>
    projections.getReleasableDelegatedChildren(threadId).pipe(
      Effect.flatMap((children) =>
        Effect.forEach(
          children,
          (child) => isReady(child).pipe(Effect.map((ready) => (ready ? [child] : []))),
          { concurrency: 8 },
        ),
      ),
      Effect.flatMap((ready) =>
        Effect.forEach(ready.flat().slice(0, RELEASES_PER_SWEEP), settle, {
          concurrency: 8,
          discard: true,
        }),
      ),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("releasing finished delegated threads failed", {
            cause: Cause.pretty(cause),
          }),
      ),
    );

  return { releaseFinishedChildren };
});
