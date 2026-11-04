// fork: sidebar filter and sort, see FORK.md.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { hasAnyThreadTag } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { readLocalStorageValue, useLocalStorage } from "~/hooks/useLocalStorage";
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

const SIDEBAR_PIN_FILTERS = ["pinned", "not-pinned"] as const;
export type SidebarPinFilter = (typeof SIDEBAR_PIN_FILTERS)[number];

export const SIDEBAR_PIN_FILTER_LABELS: Record<SidebarPinFilter, string> = {
  pinned: "Pinned",
  "not-pinned": "Not pinned",
};

const SIDEBAR_PR_FILTERS = ["open", "merged", "closed", "none"] as const;
export type SidebarPrFilter = (typeof SIDEBAR_PR_FILTERS)[number];

export const SIDEBAR_PR_FILTER_LABELS: Record<SidebarPrFilter, string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
  none: "No PR",
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

const sidebarViewFields = {
  tags: Schema.Array(Schema.String),
  statuses: Schema.Array(Schema.Literals(SIDEBAR_STATUS_FILTERS)),
  sort: Schema.Literals(SIDEBAR_THREAD_SORTS),
  groupBy: Schema.Literals(SIDEBAR_GROUPINGS),
  // Tag and status folders; project folders keep their open state in the UI state store.
  collapsedGroups: Schema.Array(Schema.String),
};

const SidebarViewSchema = Schema.Struct({
  ...sidebarViewFields,
  pinned: Schema.Array(Schema.Literals(SIDEBAR_PIN_FILTERS)),
  pullRequests: Schema.Array(Schema.Literals(SIDEBAR_PR_FILTERS)),
  // Environment ids.
  machines: Schema.Array(Schema.String),
});
export type SidebarView = typeof SidebarViewSchema.Type;

const SidebarViewV1Schema = Schema.Struct({
  ...sidebarViewFields,
  pinnedOnly: Schema.Boolean,
  openPrOnly: Schema.Boolean,
});

export const DEFAULT_SIDEBAR_VIEW: SidebarView = {
  tags: [],
  statuses: [],
  pinned: [],
  pullRequests: [],
  machines: [],
  sort: "latest-message",
  groupBy: "project",
  collapsedGroups: [],
};

const SIDEBAR_VIEW_STORAGE_KEY = "t3code:sidebar-view:v2";
// Left in place, so an older build still finds its own saved view.
const SIDEBAR_VIEW_V1_STORAGE_KEY = "t3code:sidebar-view:v1";

/** A view saved before the Pinned and Pull request menus: the switches become their picks. */
export function migrateSidebarViewV1(stored: typeof SidebarViewV1Schema.Type): SidebarView {
  const { pinnedOnly, openPrOnly, ...view } = stored;
  return {
    ...view,
    pinned: pinnedOnly ? ["pinned"] : [],
    pullRequests: openPrOnly ? ["open"] : [],
    machines: [],
  };
}

let initialSidebarView: SidebarView | null = null;
function readInitialSidebarView(): SidebarView {
  initialSidebarView ??= migrateSidebarViewV1(
    readLocalStorageValue(
      SIDEBAR_VIEW_V1_STORAGE_KEY,
      { ...DEFAULT_SIDEBAR_VIEW, pinnedOnly: false, openPrOnly: false },
      SidebarViewV1Schema,
    ),
  );
  return initialSidebarView;
}

/** The sidebar's filters, sort and grouping. Projects stay in the UI state store's project scope. */
export function useSidebarView() {
  return useLocalStorage(SIDEBAR_VIEW_STORAGE_KEY, readInitialSidebarView(), SidebarViewSchema);
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

/** A thread with several pull requests matches if any of them does. */
export function sidebarPrFiltersOf(
  thread: Pick<EnvironmentThreadShell, "pullRequests">,
): ReadonlyArray<SidebarPrFilter> {
  const links = thread.pullRequests.filter((link) => link.source !== "stack-dismissed");
  if (links.length === 0) return ["none"];
  return SIDEBAR_PR_FILTERS.filter((filter) =>
    links.some((link) => link.snapshot?.state === filter),
  );
}

/** What the filters read about one thread. */
export interface SidebarViewThreadFacts {
  readonly tags: ReadonlyArray<string>;
  readonly status: SidebarStatusFilter;
  readonly pinned: boolean;
  readonly pullRequests: ReadonlyArray<SidebarPrFilter>;
  readonly machine: string;
}

export function hasSidebarViewFilters(view: SidebarView): boolean {
  return countSidebarViewFilters(view, 0) > 0;
}

/** A thread passes when, for each kind of filter with picks, it matches any of them. */
export function matchesSidebarViewFilters(
  view: SidebarView,
  facts: SidebarViewThreadFacts,
): boolean {
  if (view.tags.length > 0 && !hasAnyThreadTag(facts.tags, view.tags)) return false;
  if (view.statuses.length > 0 && !view.statuses.includes(facts.status)) return false;
  if (view.pinned.length > 0 && !view.pinned.includes(facts.pinned ? "pinned" : "not-pinned")) {
    return false;
  }
  if (
    view.pullRequests.length > 0 &&
    !facts.pullRequests.some((pullRequest) => view.pullRequests.includes(pullRequest))
  ) {
    return false;
  }
  if (view.machines.length > 0 && !view.machines.includes(facts.machine)) return false;
  return true;
}

/**
 * Picks the menu no longer lists: a tag no thread has now, or a machine since removed. They stay
 * in the menu, so each can still be unticked on its own.
 */
export function unlistedSidebarFilterPicks(
  picked: ReadonlyArray<string>,
  listed: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const keys = new Set(listed.map((value) => value.toLocaleLowerCase()));
  return picked.filter((value) => !keys.has(value.toLocaleLowerCase()));
}

/** The badge on the filter button: every pick counts once. */
export function countSidebarViewFilters(view: SidebarView, projectCount: number): number {
  return (
    projectCount +
    view.tags.length +
    view.statuses.length +
    view.pinned.length +
    view.pullRequests.length +
    view.machines.length
  );
}

/** Clear filters leaves the sort, grouping and closed folders alone. */
export function clearSidebarViewFilters(view: SidebarView): SidebarView {
  return { ...view, tags: [], statuses: [], pinned: [], pullRequests: [], machines: [] };
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
 * in one folder only: its first tag by name that the filter picked, else its first by name.
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
    const tags = tagsOf(thread).toSorted((left, right) => left.localeCompare(right));
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

/**
 * Whether a folder's heading already says what its rows would. "Needs you" holds several
 * kinds of wait, so those rows still say which.
 */
export function sidebarGroupNamesRowStatus(group: Pick<SidebarViewGroup<unknown>, "status">) {
  return group.status !== null && group.status !== "needs-you";
}

export interface SidebarFilterCount<T> {
  readonly value: T;
  readonly count: number;
}

/**
 * How many threads each filter option holds, for the filter menu. Projects are keyed
 * `environmentId:projectId`; tags merge across case and sort by name. A thread counts under
 * each state its pull requests are in.
 */
export function countSidebarFilterFacets<T extends EnvironmentThreadShell>(
  threads: readonly T[],
  tagsOf: (thread: T) => ReadonlyArray<string>,
): {
  readonly projects: ReadonlyMap<string, number>;
  readonly tags: ReadonlyArray<SidebarFilterCount<string>>;
  readonly statuses: ReadonlyArray<SidebarFilterCount<SidebarStatusFilter>>;
  readonly pinned: ReadonlyArray<SidebarFilterCount<SidebarPinFilter>>;
  readonly pullRequests: ReadonlyArray<SidebarFilterCount<SidebarPrFilter>>;
  readonly machines: ReadonlyMap<string, number>;
} {
  const projects = new Map<string, number>();
  const machines = new Map<string, number>();
  const pullRequests = new Map<SidebarPrFilter, number>();
  let pinnedCount = 0;
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
    machines.set(thread.environmentId, (machines.get(thread.environmentId) ?? 0) + 1);
    for (const pullRequest of sidebarPrFiltersOf(thread)) {
      pullRequests.set(pullRequest, (pullRequests.get(pullRequest) ?? 0) + 1);
    }
    if (thread.pinnedAt != null) pinnedCount += 1;
  }
  return {
    projects,
    tags: [...tags.values()].toSorted((left, right) => left.value.localeCompare(right.value)),
    statuses: SIDEBAR_STATUS_FILTERS.map((value) => ({ value, count: statuses.get(value) ?? 0 })),
    pinned: [
      { value: "pinned", count: pinnedCount },
      { value: "not-pinned", count: threads.length - pinnedCount },
    ],
    pullRequests: SIDEBAR_PR_FILTERS.map((value) => ({
      value,
      count: pullRequests.get(value) ?? 0,
    })),
    machines,
  };
}

/**
 * Working threads fold into the Working section unless the view is about status. Status folders
 * have their own Working folder, and a status filter shouldn't hide its matches in a closed shelf.
 */
export function sidebarViewAllowsWorkingShelf(
  view: Pick<SidebarView, "groupBy" | "statuses">,
): boolean {
  return view.groupBy !== "status" && view.statuses.length === 0;
}

/** What boring sidebar folders take from the view. */
export interface SidebarFolderView {
  readonly sort: SidebarThreadSort;
  readonly groupBy: SidebarGrouping;
  readonly collapsedGroups: ReadonlyArray<string>;
  readonly pickedTags: ReadonlyArray<string>;
  // A manual project order wins over the sort for project folders.
  readonly keepProjectOrder: boolean;
  readonly allowsWorkingShelf: boolean;
  readonly tagsOf: (thread: EnvironmentThreadShell) => ReadonlyArray<string>;
  readonly needsMeRankOf: (thread: EnvironmentThreadShell) => number;
  // Loaded threads the filters hide, so the Settled count doesn't take them for unloaded ones.
  readonly hiddenThreads: ReadonlyArray<EnvironmentThreadShell>;
}

/** Menu search: every filter option whose name contains the query. */
export function matchesSidebarFilterQuery(label: string, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return needle.length === 0 || label.toLocaleLowerCase().includes(needle);
}
