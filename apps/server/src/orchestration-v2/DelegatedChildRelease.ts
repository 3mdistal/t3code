// fork: settles a delegated child as soon as its tasks end and nothing in it runs, whatever the
// auto-settle settings, so its provider session is let go. A loaded Codex thread keeps MCP helpers
// that stall Codex on Windows in bulk (openai/codex#42740). See FORK.md.
import { CommandId, type OrchestrationV2AppThread, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isSnoozed, threadHasQueuedTurnStart } from "./ThreadSettlementService.ts";

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

  const release = Effect.fn("DelegatedChildRelease.release")(
    function* (child: ProjectionStore.ProjectionReleasableDelegatedChild) {
      const [thread] = yield* projections.getSettlementCandidates(child.threadId);
      const now = yield* DateTime.now;
      if (
        thread === undefined ||
        !isReleasableDelegatedChild(
          thread,
          DateTime.toEpochMillis(child.taskCompletedAt),
          DateTime.toEpochMillis(now),
        )
      ) {
        return;
      }
      const uuid = yield* random.uuidV4();
      // The orchestrator refuses it if the thread changed after this read or was settled meanwhile.
      yield* orchestrator.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make(`server:release-delegated:${thread.id}:${uuid}`),
        threadId: thread.id,
        snapshotAt: thread.updatedAt,
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

  /** Settles every releasable child, or just `threadId` when it is one. Never fails. */
  const releaseFinishedChildren = (threadId?: ThreadId) =>
    projections.getReleasableDelegatedChildren(threadId).pipe(
      Effect.flatMap((children) =>
        Effect.forEach(children, release, { concurrency: 8, discard: true }),
      ),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("releasing finished delegated threads failed", {
            cause: Cause.pretty(cause),
          }),
      ),
    );

  /**
   * A delegated child starts in its parent's checkout unless it was given its own worktree. The
   * project's settle script tears a checkout down, so a child skips it while another thread there
   * is still unsettled; the last thread to settle runs it.
   */
  const childSharesCheckout = Effect.fn("DelegatedChildRelease.childSharesCheckout")(function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath" | "lineage">,
  ) {
    if (thread.lineage.relationshipToParent !== "subagent" || thread.worktreePath === null) {
      return false;
    }
    const sharers = (yield* projections.getThreadWorktreePaths()).filter(
      (entry) => entry.threadId !== thread.id && entry.worktreePath === thread.worktreePath,
    );
    for (const sharer of sharers) {
      const other = yield* projections.getThread(sharer.threadId);
      if (other.settledOverride !== "settled") return true;
    }
    return false;
  });

  return { releaseFinishedChildren, childSharesCheckout };
});
