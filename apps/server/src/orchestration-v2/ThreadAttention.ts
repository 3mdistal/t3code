import type {
  OrchestratorMcpThreadAttention,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function pendingThreadAttention(input: {
  readonly requests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly notices: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly seen: ReadonlyArray<string>;
  readonly since: DateTime.Utc;
}): ReadonlyArray<OrchestratorMcpThreadAttention> {
  const seen = new Set(input.seen);
  const requests = input.requests.flatMap((request): Array<OrchestratorMcpThreadAttention> => {
    if (
      seen.has(request.id) ||
      request.status !== "pending" ||
      request.responseCapability.type === "not_resumable" ||
      request.kind === "auth_refresh" ||
      request.kind === "dynamic_tool_call"
    )
      return [];
    return [
      {
        id: request.id,
        kind: request.kind === "user_input" ? "question" : "approval",
        summary:
          request.kind === "user_input"
            ? "A delegated task has a question."
            : "A delegated task needs user approval.",
      },
    ];
  });
  return [
    ...requests,
    ...input.notices.flatMap((notice): Array<OrchestratorMcpThreadAttention> => {
      if (
        seen.has(notice.id) ||
        notice.type !== "system_notice" ||
        notice.title !== "Background wake cancelled" ||
        DateTime.isLessThan(notice.updatedAt, input.since)
      )
        return [];
      return [{ id: notice.id, kind: "wake_cancelled", summary: notice.message }];
    }),
  ];
}
