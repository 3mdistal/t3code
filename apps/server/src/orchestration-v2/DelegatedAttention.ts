import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestratorMcpThreadAttention,
  type OrchestrationV2Subagent,
  type ThreadId,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { reportLabel } from "@t3tools/provider-core/server/notification";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

function isDelegatedApproval(request: OrchestrationV2RuntimeRequest): boolean {
  return (
    request.kind !== "user_input" &&
    request.kind !== "dynamic_tool_call" &&
    request.kind !== "auth_refresh"
  );
}

export function delegatedAttentionCommand(input: {
  readonly task: OrchestrationV2Subagent;
  readonly childThreadId: ThreadId;
  readonly environmentId?: EnvironmentId;
  readonly attention: OrchestratorMcpThreadAttention;
}) {
  const { task, attention, childThreadId, environmentId } = input;
  const key = `${task.threadId}:${environmentId === undefined ? "" : `${environmentId}:`}${attention.id}`;
  const location = `threadId ${childThreadId}${environmentId === undefined ? "" : `, environmentId ${environmentId}`}`;
  const label = reportLabel(task.title?.trim() || task.prompt);
  const text =
    attention.kind === "question"
      ? `Delegated task ${task.id} has a question. Read it with t3_pending_request action read, ${location}, requestId ${attention.id}. Answer with action respond when the answer follows from the task or the user's instructions; otherwise ask the user. If it is no longer pending, it was answered or dismissed.`
      : attention.kind === "approval"
        ? `Delegated task ${task.id} is waiting for an approval in ${location}, request ${attention.id}. The user must answer this approval in the child's own thread. You cannot approve it on the user's behalf. Tell the user what is waiting. If the request is no longer pending, it was answered or dismissed.`
        : `Delegated task ${task.id} lost a background wake in ${location}. ${attention.summary} Tell the user that this work needs attention; the lost wake was not delivered.`;
  return {
    type: "message.dispatch" as const,
    commandId: CommandId.make(`server:delegated-attention:${key}`),
    threadId: task.threadId,
    messageId: MessageId.make(`message:delegated-attention:${key}`),
    text,
    notification: {
      source: { kind: "delegated_task" as const, taskIds: [task.id], childThreadId },
      outcome: "updated" as const,
      summary: `Delegated task${label === undefined ? "" : ` "${label}"`} ${attention.kind === "approval" ? "needs approval" : attention.kind === "question" ? "has a question" : "lost a background wake"}`,
    },
    attachments: [],
    dispatchMode: { type: "queue_after_active" as const },
    createdBy: "agent" as const,
    creationSource: "server" as const,
  };
}

export function isDelegatedAttentionEvent(event: OrchestrationV2DomainEvent): boolean {
  return (
    (event.type === "runtime-request.updated" && isDelegatedApproval(event.payload)) ||
    (event.type === "turn-item.updated" &&
      event.payload.type === "system_notice" &&
      event.payload.title === "Background wake cancelled")
  );
}

export const makeDelegatedAttention = Effect.fn("DelegatedAttention.make")(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return Effect.fn("DelegatedAttention.handle")(function* (event: OrchestrationV2DomainEvent) {
    const approval =
      event.type === "runtime-request.updated" && isDelegatedApproval(event.payload)
        ? event.payload
        : undefined;
    const notice =
      event.type === "turn-item.updated" &&
      event.payload.type === "system_notice" &&
      event.payload.title === "Background wake cancelled"
        ? event.payload
        : undefined;
    if (approval === undefined && notice === undefined) return;
    const child = yield* projections.getThreadRecords(event.threadId, ["runs"]);
    const parentId = child.thread.lineage.parentThreadId;
    if (parentId === null) return;
    const key = `${parentId}:${approval?.id ?? notice!.id}`;
    const messageId = MessageId.make(`message:delegated-attention:${key}`);
    const parent = yield* projections.getThreadRecords(parentId, ["runs", "subagents"]);
    if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;
    if (approval !== undefined) {
      const current = yield* projections.getRuntimeRequest(event.threadId, approval.id);
      if (approval.status !== "pending" || current?.status !== "pending") {
        const queued = parent.runs.find(
          (run) => run.status === "queued" && run.userMessageId === messageId,
        );
        if (queued !== undefined)
          yield* engine.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`server:delegated-attention-cancel:${key}`),
            threadId: parentId,
            runId: queued.id,
          });
        return;
      }
      if (current.responseCapability.type === "not_resumable") return;
    }
    const run =
      child.runs.find((candidate) => candidate.id === event.runId) ??
      child.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
    const taskId =
      run?.delegatedTaskId ??
      (child.thread.forkedFrom?.type === "node" ? child.thread.forkedFrom.nodeId : undefined);
    const task = parent.subagents.find(
      (candidate) =>
        candidate.origin === "app_owned" &&
        candidate.id === taskId &&
        candidate.childThreadId === event.threadId,
    );
    if (task === undefined || task.status === "cancelled" || task.status === "interrupted") return;
    yield* engine.dispatch(
      delegatedAttentionCommand({
        task,
        childThreadId: event.threadId,
        attention: {
          id: approval?.id ?? notice!.id,
          kind: approval === undefined ? "wake_cancelled" : "approval",
          summary: notice?.message ?? "Waiting for user approval.",
        },
      }),
    );
  });
});
