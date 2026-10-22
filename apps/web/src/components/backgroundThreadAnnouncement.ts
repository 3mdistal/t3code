import type { SidebarThreadSummary } from "../types";
import { THREAD_STATUS_TEXT } from "./chat/threadActivityAnnouncement";
import { hasUnseenCompletion, resolveSidebarThreadStatus } from "./Sidebar.logic";

export type BackgroundThreadStatus = keyof typeof THREAD_STATUS_TEXT;

/** The statuses worth interrupting someone for: the ones a sidebar row flags. */
export function resolveBackgroundThreadStatus(
  thread: SidebarThreadSummary,
  lastVisitedAt: string | undefined,
): BackgroundThreadStatus | null {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input") return status;
  if (status === "failed" || status === "limited") return "failed";
  if (status === "ready" && hasUnseenCompletion({ ...thread, lastVisitedAt })) return "done";
  return null;
}

export interface BackgroundThreadEntry {
  readonly key: string;
  readonly title: string;
  readonly status: BackgroundThreadStatus | null;
}

export type BackgroundThreadMemory = ReadonlyMap<string, BackgroundThreadStatus | null>;

/**
 * Decides what a screen reader hears when a thread other than the open one
 * changes status. `threads` holds only threads whose environment is live, so a
 * thread is silent the first time it's seen: opening the app or reconnecting
 * takes a baseline instead of reading out every thread.
 */
export function nextBackgroundThreadAnnouncement(
  previous: BackgroundThreadMemory,
  threads: ReadonlyArray<BackgroundThreadEntry>,
  openThreadKey: string | null,
): { readonly memory: BackgroundThreadMemory; readonly announcement: string | null } {
  const memory = new Map<string, BackgroundThreadStatus | null>();
  const announcements: string[] = [];
  for (const thread of threads) {
    memory.set(thread.key, thread.status);
    if (
      thread.status !== null &&
      thread.key !== openThreadKey &&
      previous.has(thread.key) &&
      previous.get(thread.key) !== thread.status
    ) {
      announcements.push(`${THREAD_STATUS_TEXT[thread.status]}: ${thread.title}`);
    }
  }
  return {
    memory,
    announcement: announcements.length === 0 ? null : announcements.join(". "),
  };
}
