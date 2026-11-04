// fork: the attention key names the pending request, so a new prompt in the same run still alerts,
// including one a parent shows for its children; see FORK.md.
import type { PendingSubagentRequest } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

export interface AttentionRequest {
  readonly id: string;
  readonly createdAt: number;
}

const NO_REQUESTS: ReadonlyMap<ThreadId, AttentionRequest> = new Map();

export function ownAttentionRequest(
  shell: Pick<OrchestrationV2ThreadShell, "pendingRuntimeRequest">,
): AttentionRequest | null {
  const request = shell.pendingRuntimeRequest;
  return request === null
    ? null
    : { id: request.id, createdAt: DateTime.toEpochMillis(request.createdAt) };
}

export function newerAttentionRequest(
  left: AttentionRequest | null,
  right: AttentionRequest | null,
): AttentionRequest | null {
  if (left === null) return right;
  return right !== null && right.createdAt > left.createdAt ? right : left;
}

/** The shell shows the newest request, so answering it must not re-alert for an older one. */
export function announcedRequest(
  prior: AttentionRequest | null,
  current: AttentionRequest | null,
): AttentionRequest | null {
  if (current === null) return null;
  return prior !== null && current.createdAt < prior.createdAt ? prior : current;
}

export function threadAttentionKey(
  runId: string,
  status: string,
  request: AttentionRequest | null,
): string | null {
  if (status === "approval" || status === "input") {
    return `${runId}:${status}${request === null ? "" : `:${request.id}`}`;
  }
  return status === "request" || status === "failed" || status === "limited"
    ? `${runId}:${status}`
    : null;
}

/**
 * The newest request a flagged parent shows for its children, by parent. Questions from a subagent
 * stay out: the coordinator answers those, and only a side chat asks its user directly.
 */
export function createPendingChildRequestsAtom(shells: {
  readonly pendingSubagentRequestsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyMap<ThreadId, PendingSubagentRequest>>;
  readonly childThreadInputsAtom: (ref: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => Atom.Atom<ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ThreadId }>>;
  readonly environmentThreadIndexAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>>;
}) {
  return Atom.family((environmentId: EnvironmentId) => {
    let previous = NO_REQUESTS;
    return Atom.make((get): ReadonlyMap<ThreadId, AttentionRequest> => {
      const flags = get(shells.pendingSubagentRequestsAtom(environmentId));
      const next = new Map<ThreadId, AttentionRequest>();
      for (const threadId of flags.keys()) {
        let newest: AttentionRequest | null = null;
        // This list keeps an old array while only a request id changed, so read current shells.
        for (const child of get(shells.childThreadInputsAtom({ environmentId, threadId }))) {
          const shell = get(shells.environmentThreadIndexAtom(child.environmentId)).get(child.id);
          if (shell === undefined) continue;
          if (shell.pendingRuntimeRequest?.kind === "user_input" && shell.lineage.sideChat !== true)
            continue;
          newest = newerAttentionRequest(newest, ownAttentionRequest(shell));
        }
        if (newest !== null) next.set(threadId, newest);
      }
      const same =
        previous.size === next.size &&
        [...next].every(([threadId, request]) => previous.get(threadId)?.id === request.id);
      if (!same) previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-pending-child-requests:${environmentId}`));
  });
}
