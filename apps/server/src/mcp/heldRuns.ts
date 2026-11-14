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
import { queuedRunsInDeliveryOrder } from "../orchestration-v2/QueuedRunOrder.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/** Said for a hold without the limits' notice: Stop, a failed run, a missing worktree or a restart. */
const QUEUE_HELD =
  "T3 holds this thread's queue, as it does after a Stop, a failed run, a missing worktree or a restart. It starts when someone resumes it in T3 or sends it a message there.";

/** Said as well when the held run is a Claude wake, whose session goes on without T3. */
const SESSION_WORKING =
  " This run is the session's own wake after its background work ended: the session may still be working outside T3, where T3 tools fail, until the run starts.";

/**
 * The thread's queued runs, when T3 holds every one and nothing runs. The scheduler starts the first
 * queued run it doesn't hold (`Orchestrator`'s `nextQueuedRun`), so one it can start, or a run going,
 * means the thread is working, whatever waits behind it.
 */
export function heldQueue(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): ReadonlyArray<OrchestrationV2Run> {
  if (ThreadManagementService.latestActiveRun(projection) !== undefined) return [];
  const queued = projection.runs.filter((run) => run.status === "queued");
  return queued.every((run) => run.queueHeld === true) ? queued : [];
}

/** The records `heldRun` reads: the queued runs' messages and their system notices. */
export const heldRunRecordFilter = (queue: ReadonlyArray<OrchestrationV2Run>) => ({
  messageIds: queue.map((run) => run.userMessageId),
  turnItemRunIds: queue.map((run) => run.id),
  turnItemTypes: ["system_notice" as const],
});

/**
 * The held run that starts first once the hold ends, in the scheduler's order, with the limits' notice
 * as its reason when they hold it.
 */
export function heldRun(
  queue: ReadonlyArray<OrchestrationV2Run>,
  records: {
    readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  },
): OrchestratorMcpHeldRun | undefined {
  const run = queuedRunsInDeliveryOrder({ runs: queue, messages: records.messages })[0];
  if (run === undefined) return undefined;
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
