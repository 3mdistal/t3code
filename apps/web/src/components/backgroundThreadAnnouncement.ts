import type { OrchestrationV2RunStatus, RunId } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../types";
import { runOutcomeText, THREAD_STATUS_TEXT } from "./chat/threadActivityAnnouncement";

export interface BackgroundThreadSnapshot {
  readonly key: string;
  readonly title: string;
  readonly request: "approval" | "input" | null;
  readonly runId: RunId | null;
  readonly runStatus: OrchestrationV2RunStatus | null;
  /** A snoozed thread stays hidden until its timer, so it stays quiet too. */
  readonly snoozed: boolean;
}

export function resolveBackgroundThreadRequest(
  thread: Pick<
    SidebarThreadSummary,
    "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest"
  >,
): BackgroundThreadSnapshot["request"] {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  return null;
}

interface BackgroundThreadMemoryEntry {
  readonly request: BackgroundThreadSnapshot["request"];
  /** The last run whose ending is known, so each run's ending is announced once. */
  readonly settledRunId: RunId | null;
}

export type BackgroundThreadMemory = ReadonlyMap<string, BackgroundThreadMemoryEntry>;

/**
 * Decides what a screen reader hears when a thread other than the open one
 * asks for something or ends a run. `threads` holds only threads whose
 * environment is live, so a thread is silent the first time it's seen:
 * opening the app or reconnecting takes a baseline instead of reading out
 * every thread.
 */
export function nextBackgroundThreadAnnouncement(
  previous: BackgroundThreadMemory,
  threads: ReadonlyArray<BackgroundThreadSnapshot>,
  openThreadKey: string | null,
): { readonly memory: BackgroundThreadMemory; readonly announcement: string | null } {
  const memory = new Map<string, BackgroundThreadMemoryEntry>();
  const announcements: string[] = [];
  for (const thread of threads) {
    const before = previous.get(thread.key);
    const outcome = runOutcomeText(thread.runStatus);
    const settled = outcome !== null || thread.runStatus === "rolled_back";
    memory.set(thread.key, {
      request: thread.request,
      settledRunId: settled ? thread.runId : (before?.settledRunId ?? null),
    });
    if (before === undefined || thread.key === openThreadKey || thread.snoozed) continue;
    if (thread.request !== null && thread.request !== before.request) {
      announcements.push(`${THREAD_STATUS_TEXT[thread.request]}: ${thread.title}`);
    }
    if (outcome !== null && thread.runId !== before.settledRunId) {
      announcements.push(`${outcome}: ${thread.title}`);
    }
  }
  return {
    memory,
    announcement: announcements.length === 0 ? null : announcements.join(". "),
  };
}
