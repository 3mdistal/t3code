// fork: limits. What a parent reads about a thread whose next run T3 holds; see FORK.md.
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  OrchestratorMcpHeldRun,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";

import { isBufferedProviderNotification } from "../orchestration-v2/NotificationMailbox.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/** Said for a hold without the limits' notice: Stop, a failed run, a missing worktree or a restart. */
const QUEUE_HELD =
  "T3 holds this thread's queue, as it does after a Stop, a failed run, a missing worktree or a restart. It starts when someone resumes it in T3 or sends it a message there.";

/** Said as well when the held run is a Claude wake, whose session goes on without T3. */
const SESSION_WORKING =
  " This run is the session's own wake after its background work ended: the session may still be working outside T3, where T3 tools fail, until the run starts.";

/**
 * The queued run T3 holds that would start next, when nothing runs on the thread. A thread with a
 * run going is working, whatever waits behind it.
 */
export function heldQueuedRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined {
  if (ThreadManagementService.latestActiveRun(projection) !== undefined) return undefined;
  return projection.runs
    .filter((run) => run.status === "queued" && run.queueHeld === true)
    .toSorted(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    )[0];
}

/** The records `heldRun` reads: the run's message and its system notices. */
export const heldRunRecordFilter = (run: OrchestrationV2Run) => ({
  messageIds: [run.userMessageId],
  turnItemRunIds: [run.id],
  turnItemTypes: ["system_notice" as const],
});

/** `run`, held, with the limits' notice as its reason when they hold it. */
export function heldRun(
  run: OrchestrationV2Run,
  records: {
    readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  },
): OrchestratorMcpHeldRun {
  const noticeId = IdAllocator.derive.runSignalTurnItem({ runId: run.id, signal: "limits-hold" });
  const notice = records.turnItems.find((item) => item.id === noticeId);
  const message = records.messages.find((candidate) => candidate.id === run.userMessageId);
  const wake = message !== undefined && isBufferedProviderNotification(message);
  return {
    runId: run.id,
    since: DateTime.formatIso(run.requestedAt),
    reason:
      (notice?.type === "system_notice" ? notice.message : QUEUE_HELD) +
      (wake ? SESSION_WORKING : ""),
  };
}
