import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { ThreadLink } from "@t3tools/shared/promptLinks";

export interface KnownThreads {
  readonly threadRefs: ReadonlyArray<ScopedThreadRef>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

/**
 * fork: the thread a `t3-thread://` link opens. A link without an environment takes the one
 * whose thread list has the thread, preferring this machine's. With `listedOnly` off, a thread
 * no list has yet (archived, say) falls back to this machine's environment, or the only
 * connected one, whose thread page then shows it or goes home. See FORK.md.
 */
export function threadLinkTarget(
  link: ThreadLink,
  known: KnownThreads,
  listedOnly: boolean,
): ScopedThreadRef | null {
  const threadId = link.threadId as ThreadId;
  const connected = (id: string | null): id is EnvironmentId =>
    id !== null && known.connectedEnvironmentIds.includes(id as EnvironmentId);
  if (link.environmentId !== null) {
    return connected(link.environmentId) ? scopeThreadRef(link.environmentId, threadId) : null;
  }
  const listed = known.threadRefs.filter((ref) => ref.threadId === threadId);
  const match = listed.find((ref) => ref.environmentId === known.primaryEnvironmentId) ?? listed[0];
  if (match !== undefined || listedOnly) return match ?? null;
  if (connected(known.primaryEnvironmentId)) {
    return scopeThreadRef(known.primaryEnvironmentId, threadId);
  }
  const [only, ...others] = known.connectedEnvironmentIds;
  return only !== undefined && others.length === 0 ? scopeThreadRef(only, threadId) : null;
}
