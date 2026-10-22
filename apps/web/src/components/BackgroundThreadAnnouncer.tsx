import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useQuietThreadShells } from "../state/entities";
import { liveShellEnvironmentIdsAtom } from "../state/shell";
import { resolveActiveThreadRouteRef } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import {
  type BackgroundThreadEntry,
  type BackgroundThreadMemory,
  nextBackgroundThreadAnnouncement,
  resolveBackgroundThreadStatus,
} from "./backgroundThreadAnnouncement";
import { resolveThreadLastVisitedAt } from "./Sidebar.logic";

/**
 * Speaks status changes for threads other than the open one. It lives outside
 * the sidebar because a collapsed sidebar is inert, which silences its rows.
 */
export function BackgroundThreadAnnouncer() {
  const threads = useQuietThreadShells();
  const liveEnvironmentIds = useAtomValue(liveShellEnvironmentIdsAtom);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const routeTarget = useThreadRouteTarget();
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const openThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraftThread);
  const openThreadKey = openThreadRef === null ? null : scopedThreadKey(openThreadRef);
  const regionRef = useRef<HTMLDivElement>(null);
  const memoryRef = useRef<BackgroundThreadMemory>(new Map());

  useEffect(() => {
    const entries: BackgroundThreadEntry[] = [];
    for (const thread of threads) {
      // Subagents have no row of their own; their requests surface on the parent.
      if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent")
        continue;
      if (!liveEnvironmentIds.has(thread.environmentId)) continue;
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      entries.push({
        key,
        title: thread.title,
        status: resolveBackgroundThreadStatus(
          thread,
          resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAtById[key]),
        ),
      });
    }
    const { memory, announcement } = nextBackgroundThreadAnnouncement(
      memoryRef.current,
      entries,
      openThreadKey,
    );
    memoryRef.current = memory;
    const region = regionRef.current;
    if (region === null || announcement === null) return;
    // Screen readers ignore a write that leaves the text unchanged, so a repeat
    // gets a trailing non-breaking space to count as new.
    region.textContent = region.textContent === announcement ? `${announcement} ` : announcement;
  }, [threads, liveEnvironmentIds, localLastVisitedAtById, openThreadKey]);

  return <div ref={regionRef} role="status" aria-live="polite" className="sr-only" />;
}
