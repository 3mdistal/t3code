// fork: sidebar filter and sort, see FORK.md.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { hasAnyThreadTag } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  firstValidTimestampMs,
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  type SidebarThreadStatus,
  sortWorkingThreadsBySend,
} from "../Sidebar.logic";

export const NO_TAGS: ReadonlyArray<string> = [];

export const SIDEBAR_STATUS_FILTERS = [
  "needs-you",
  "failed",
  "working",
  "waiting",
  "done",
] as const;
export type SidebarStatusFilter = (typeof SIDEBAR_STATUS_FILTERS)[number];

export const SIDEBAR_STATUS_LABELS: Record<SidebarStatusFilter, string> = {
  "needs-you": "Needs you",
  failed: "Failed",
  working: "Working",
  waiting: "Waiting",
  done: "Done",
};

export const SIDEBAR_THREAD_SORTS = [
  "latest-message",
  "needs-me",
  "last-activity",
  "newest",
] as const;
export type SidebarThreadSort = (typeof SIDEBAR_THREAD_SORTS)[number];

export const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSort, string> = {
  "latest-message": "My latest message",
  "needs-me": "Needs me first",
  "last-activity": "Last activity",
  newest: "Newest first",
};

export const SIDEBAR_GROUPINGS = ["project", "tag", "status", "none"] as const;
export type SidebarGrouping = (typeof SIDEBAR_GROUPINGS)[number];

export const SIDEBAR_GROUPING_LABELS: Record<SidebarGrouping, string> = {
  project: "Project",
  tag: "Tag",
  status: "Status",
  none: "None",
};

const SidebarViewSchema = Schema.Struct({
  tags: Schema.Array(Schema.String),
  statuses: Schema.Array(Schema.Literals(SIDEBAR_STATUS_FILTERS)),
  pinnedOnly: Schema.Boolean,
  openPrOnly: Schema.Boolean,
  sort: Schema.Literals(SIDEBAR_THREAD_SORTS),
  groupBy: Schema.Literals(SIDEBAR_GROUPINGS),
  // Tag and status folders; project folders keep their open state in the UI state store.
  collapsedGroups: Schema.Array(Schema.String),
});
export type SidebarView = typeof SidebarViewSchema.Type;

export const DEFAULT_SIDEBAR_VIEW: SidebarView = {
  tags: [],
  statuses: [],
  pinnedOnly: false,
  openPrOnly: false,
  sort: "latest-message",
  groupBy: "project",
  collapsedGroups: [],
};

const SIDEBAR_VIEW_STORAGE_KEY = "t3code:sidebar-view:v1";

/** The sidebar's filters, sort and grouping. Projects stay in the UI state store's project scope. */
export function useSidebarView() {
  return useLocalStorage(SIDEBAR_VIEW_STORAGE_KEY, DEFAULT_SIDEBAR_VIEW, SidebarViewSchema);
}

export function sidebarStatusFilterOf(status: SidebarThreadStatus): SidebarStatusFilter {
  switch (status) {
    case "approval":
    case "input":
    case "request":
    case "limited":
      return "needs-you";
    case "failed":
      return "failed";
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "ready":
      return "done";
  }
}

export function sidebarViewStatusOf(thread: EnvironmentThreadShell): SidebarStatusFilter {
  return sidebarStatusFilterOf(resolveSidebarThreadStatus(thread));
}

/** Read the way rows read it: a finished run the user has not opened since. */
export function isSidebarViewUnread(
  thread: EnvironmentThreadShell,
  localLastVisitedAt: string | undefined,
): boolean {
  return hasUnseenCompletion({
    ...thread,
    lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
  });
}

export function hasOpenPullRequest(thread: Pick<EnvironmentThreadShell, "pullRequests">): boolean {
  return thread.pullRequests.some(
    (link) => link.source !== "stack-dismissed" && link.snapshot?.state === "open",
  );
}

/** What the filters read about one thread. */
export interface SidebarViewThreadFacts {
  readonly tags: ReadonlyArray<string>;
  readonly status: SidebarStatusFilter;
  readonly pinned: boolean;
  readonly openPullRequest: boolean;
}

export function hasSidebarViewFilters(view: SidebarView): boolean {
  return view.tags.length > 0 || view.statuses.length > 0 || view.pinnedOnly || view.openPrOnly;
}

/** A thread passes when it has any picked tag and any picked status, and every switch holds. */
export function matchesSidebarViewFilters(
  view: SidebarView,
  facts: SidebarViewThreadFacts,
): boolean {
  if (view.tags.length > 0 && !hasAnyThreadTag(facts.tags, view.tags)) return false;
  if (view.statuses.length > 0 && !view.statuses.includes(facts.status)) return false;
  if (view.pinnedOnly && !facts.pinned) return false;
  if (view.openPrOnly && !facts.openPullRequest) return false;
  return true;
}

/** The badge on the filter button: each picked project, tag and status, and each switch. */
export function countSidebarViewFilters(view: SidebarView, projectCount: number): number {
  return (
    projectCount +
    view.tags.length +
    view.statuses.length +
    Number(view.pinnedOnly) +
    Number(view.openPrOnly)
  );
}

/** Clear filters leaves the sort, grouping and closed folders alone. */
export function clearSidebarViewFilters(view: SidebarView): SidebarView {
  return { ...view, tags: [], statuses: [], pinnedOnly: false, openPrOnly: false };
}

/**
 * Needs me first: threads waiting on the user, then failures, then unread results,
 * then running work, then threads waiting on something else, then the rest.
 */
export function needsMeRank(status: SidebarStatusFilter, unread: boolean): number {
  switch (status) {
    case "needs-you":
      return 0;
    case "failed":
      return 1;
    case "done":
      return unread ? 2 : 5;
    case "working":
      return 3;
    case "waiting":
      return 4;
  }
}

type SortableThread = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "unsettledAt" | "latestRun" | "latestUserAuthoredMessageAt"
>;

function newestFirstBy<T extends SortableThread>(
  threads: readonly T[],
  timestampOf: (thread: T) => number,
): T[] {
  const timestamps = new Map(threads.map((thread) => [thread, timestampOf(thread)] as const));
  return threads.toSorted(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

function lastActivityMs(thread: SortableThread): number {
  return Math.max(
    firstValidTimestampMs(thread.createdAt),
    firstValidTimestampMs(thread.unsettledAt),
    firstValidTimestampMs(thread.latestRun?.requestedAt),
    firstValidTimestampMs(thread.latestRun?.completedAt),
    firstValidTimestampMs(thread.latestUserAuthoredMessageAt),
  );
}

/** Orders folder threads. "My latest message" is the order folders had before this menu. */
export function sortSidebarViewThreads<T extends SortableThread>(
  threads: readonly T[],
  sort: SidebarThreadSort,
  needsMeRankOf: (thread: T) => number,
): T[] {
  switch (sort) {
    case "latest-message":
      return sortWorkingThreadsBySend(threads);
    case "needs-me": {
      const ranks = new Map(threads.map((thread) => [thread, needsMeRankOf(thread)] as const));
      // Stable, so each rank keeps the latest-message order.
      return sortWorkingThreadsBySend(threads).toSorted(
        (left, right) => ranks.get(left)! - ranks.get(right)!,
      );
    }
    case "last-activity":
      return newestFirstBy(threads, lastActivityMs);
    case "newest":
      return newestFirstBy(threads, (thread) => firstValidTimestampMs(thread.createdAt));
  }
}

/**
 * Orders folders by their top thread, so the sort moves folders as well as rows.
 * Lower tiers come first; folders with no threads keep their order at the end of their tier.
 */
export function orderSidebarFoldersByThreads<F extends { readonly threads: readonly unknown[] }>(
  folders: readonly F[],
  threadOrder: ReadonlyMap<unknown, number>,
  tierOf: (folder: F) => number,
): F[] {
  const firstOf = (folder: F) =>
    folder.threads.length === 0
      ? Number.POSITIVE_INFINITY
      : (threadOrder.get(folder.threads[0]) ?? Number.POSITIVE_INFINITY);
  return folders.toSorted(
    (left, right) => tierOf(left) - tierOf(right) || firstOf(left) - firstOf(right),
  );
}

export interface SidebarViewGroup<T> {
  /** Stable across renders and stored for closed folders. */
  readonly key: string;
  readonly label: string;
  readonly tag: string | null;
  readonly status: SidebarStatusFilter | null;
  readonly threads: T[];
}

export const NO_TAG_GROUP_KEY = "tag:";

/**
 * Tag folders, ordered by their top thread, with untagged threads last. A thread sits
 * in one folder only: its first tag that the filter picked, else its first tag.
 */
export function groupSidebarThreadsByTag<T>(
  threads: readonly T[],
  tagsOf: (thread: T) => ReadonlyArray<string>,
  pickedTags: ReadonlyArray<string>,
): SidebarViewGroup<T>[] {
  const picked = new Set(pickedTags.map((tag) => tag.toLocaleLowerCase()));
  const groups = new Map<string, SidebarViewGroup<T>>();
  const untagged: T[] = [];
  for (const thread of threads) {
    const tags = tagsOf(thread);
    const tag = tags.find((candidate) => picked.has(candidate.toLocaleLowerCase())) ?? tags[0];
    if (tag === undefined) {
      untagged.push(thread);
      continue;
    }
    const key = `tag:${tag.toLocaleLowerCase()}`;
    const group = groups.get(key);
    if (group) group.threads.push(thread);
    else groups.set(key, { key, label: tag, tag, status: null, threads: [thread] });
  }
  return untagged.length === 0
    ? [...groups.values()]
    : [
        ...groups.values(),
        { key: NO_TAG_GROUP_KEY, label: "No tag", tag: null, status: null, threads: untagged },
      ];
}

/** Status folders, most urgent first; empty statuses get no folder. */
export function groupSidebarThreadsByStatus<T>(
  threads: readonly T[],
  statusOf: (thread: T) => SidebarStatusFilter,
): SidebarViewGroup<T>[] {
  return SIDEBAR_STATUS_FILTERS.flatMap((status) => {
    const members = threads.filter((thread) => statusOf(thread) === status);
    return members.length === 0
      ? []
      : [
          {
            key: `status:${status}`,
            label: SIDEBAR_STATUS_LABELS[status],
            tag: null,
            status,
            threads: members,
          },
        ];
  });
}

export interface SidebarFilterCount<T> {
  readonly value: T;
  readonly count: number;
}

/**
 * How many threads each project, tag and status holds, for the filter menu. Projects are
 * keyed `environmentId:projectId`; tags merge across case and sort by name.
 */
export function countSidebarFilterFacets<T extends EnvironmentThreadShell>(
  threads: readonly T[],
  tagsOf: (thread: T) => ReadonlyArray<string>,
): {
  readonly projects: ReadonlyMap<string, number>;
  readonly tags: ReadonlyArray<SidebarFilterCount<string>>;
  readonly statuses: ReadonlyArray<SidebarFilterCount<SidebarStatusFilter>>;
} {
  const projects = new Map<string, number>();
  const tags = new Map<string, { value: string; count: number }>();
  const statuses = new Map<SidebarStatusFilter, number>();
  for (const thread of threads) {
    const projectKey = `${thread.environmentId}:${thread.projectId}`;
    projects.set(projectKey, (projects.get(projectKey) ?? 0) + 1);
    for (const tag of tagsOf(thread)) {
      const entry = tags.get(tag.toLocaleLowerCase());
      if (entry) entry.count += 1;
      else tags.set(tag.toLocaleLowerCase(), { value: tag, count: 1 });
    }
    const status = sidebarViewStatusOf(thread);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
  return {
    projects,
    tags: [...tags.values()].toSorted((left, right) => left.value.localeCompare(right.value)),
    statuses: SIDEBAR_STATUS_FILTERS.map((value) => ({ value, count: statuses.get(value) ?? 0 })),
  };
}

/** What boring sidebar folders take from the view. */
export interface SidebarFolderView {
  readonly sort: SidebarThreadSort;
  readonly groupBy: SidebarGrouping;
  readonly collapsedGroups: ReadonlyArray<string>;
  readonly pickedTags: ReadonlyArray<string>;
  // A manual project order wins over the sort for project folders.
  readonly keepProjectOrder: boolean;
  readonly tagsOf: (thread: EnvironmentThreadShell) => ReadonlyArray<string>;
  readonly needsMeRankOf: (thread: EnvironmentThreadShell) => number;
}

/** Menu search: every project, tag and status whose name contains the query. */
export function matchesSidebarFilterQuery(label: string, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return needle.length === 0 || label.toLocaleLowerCase().includes(needle);
}
