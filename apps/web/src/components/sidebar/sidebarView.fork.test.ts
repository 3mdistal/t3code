import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import {
  clearSidebarViewFilters,
  countSidebarViewFilters,
  DEFAULT_SIDEBAR_VIEW,
  groupSidebarThreadsByStatus,
  groupSidebarThreadsByTag,
  matchesSidebarFilterQuery,
  matchesSidebarViewFilters,
  needsMeRank,
  NO_TAG_GROUP_KEY,
  orderSidebarFoldersByThreads,
  type SidebarStatusFilter,
  type SidebarView,
  type SidebarViewThreadFacts,
  sidebarStatusFilterOf,
  sidebarGroupNamesRowStatus,
  sidebarViewAllowsWorkingShelf,
  sortSidebarViewThreads,
} from "./sidebarView";

// fork: sidebar filter and sort, see FORK.md.

const facts = (overrides: Partial<SidebarViewThreadFacts> = {}): SidebarViewThreadFacts => ({
  tags: [],
  status: "done",
  pinned: false,
  openPullRequest: false,
  ...overrides,
});

const view = (overrides: Partial<SidebarView> = {}): SidebarView => ({
  ...DEFAULT_SIDEBAR_VIEW,
  ...overrides,
});

interface TestThread {
  readonly id: string;
  readonly status: SidebarStatusFilter;
  readonly unread: boolean;
  readonly tags: ReadonlyArray<string>;
}

const thread = (
  id: string,
  times: {
    created: string;
    sent?: string;
    completed?: string;
  },
  extra: Partial<TestThread> = {},
) =>
  ({
    id,
    environmentId: "env",
    createdAt: times.created,
    unsettledAt: null,
    latestUserAuthoredMessageAt: times.sent ?? null,
    latestRun:
      times.completed === undefined
        ? null
        : { requestedAt: times.sent ?? times.created, completedAt: times.completed },
    status: "done",
    unread: false,
    tags: [],
    ...extra,
  }) as unknown as EnvironmentThreadShell & TestThread;

describe("sidebar view filters", () => {
  it("matches any picked tag, any picked status, and every switch", () => {
    const tagged = facts({ tags: ["Frontend"], status: "working", pinned: true });
    expect(matchesSidebarViewFilters(view(), facts())).toBe(true);
    expect(matchesSidebarViewFilters(view({ tags: ["frontend", "backend"] }), tagged)).toBe(true);
    expect(matchesSidebarViewFilters(view({ tags: ["backend"] }), tagged)).toBe(false);
    expect(
      matchesSidebarViewFilters(view({ tags: ["frontend"], statuses: ["failed"] }), tagged),
    ).toBe(false);
    expect(
      matchesSidebarViewFilters(
        view({ statuses: ["failed", "working"], pinnedOnly: true }),
        tagged,
      ),
    ).toBe(true);
    expect(matchesSidebarViewFilters(view({ openPrOnly: true }), tagged)).toBe(false);
    expect(
      matchesSidebarViewFilters(view({ openPrOnly: true }), facts({ openPullRequest: true })),
    ).toBe(true);
  });

  it("counts each picked value for the badge, and clearing keeps sort and grouping", () => {
    const busy = view({
      tags: ["a", "b"],
      statuses: ["failed"],
      pinnedOnly: true,
      sort: "newest",
      groupBy: "tag",
      collapsedGroups: ["tag:a"],
    });
    expect(countSidebarViewFilters(busy, 2)).toBe(6);
    expect(clearSidebarViewFilters(busy)).toEqual(
      view({ sort: "newest", groupBy: "tag", collapsedGroups: ["tag:a"] }),
    );
  });

  it("buckets thread statuses the way the folder dot does", () => {
    expect(sidebarStatusFilterOf("approval")).toBe("needs-you");
    expect(sidebarStatusFilterOf("input")).toBe("needs-you");
    expect(sidebarStatusFilterOf("limited")).toBe("needs-you");
    expect(sidebarStatusFilterOf("ready")).toBe("done");
    expect(matchesSidebarFilterQuery("Needs you", " need")).toBe(true);
    expect(matchesSidebarFilterQuery("frontend", "back")).toBe(false);
  });
});

describe("sidebar view sorting", () => {
  const old = thread(
    "old",
    { created: "2026-01-01T00:00:00Z", sent: "2026-01-05T00:00:00Z" },
    { status: "needs-you" },
  );
  const fresh = thread(
    "fresh",
    { created: "2026-01-04T00:00:00Z", sent: "2026-01-04T00:00:00Z" },
    { status: "working" },
  );
  const finished = thread(
    "finished",
    {
      created: "2026-01-02T00:00:00Z",
      sent: "2026-01-02T00:00:00Z",
      completed: "2026-01-06T00:00:00Z",
    },
    { unread: true },
  );
  const threads = [fresh, finished, old];
  const ids = (list: ReadonlyArray<{ id: string }>) => list.map((entry) => entry.id);
  const rank = (entry: TestThread) => needsMeRank(entry.status, entry.unread);

  it("sorts by my latest message, needs me, last activity and age", () => {
    expect(ids(sortSidebarViewThreads(threads, "latest-message", rank))).toEqual([
      "old",
      "fresh",
      "finished",
    ]);
    expect(ids(sortSidebarViewThreads(threads, "needs-me", rank))).toEqual([
      "old",
      "finished",
      "fresh",
    ]);
    expect(ids(sortSidebarViewThreads(threads, "last-activity", rank))).toEqual([
      "finished",
      "old",
      "fresh",
    ]);
    expect(ids(sortSidebarViewThreads(threads, "newest", rank))).toEqual([
      "fresh",
      "finished",
      "old",
    ]);
  });

  it("orders folders by their top thread inside each tier, with empty folders last", () => {
    const sorted = sortSidebarViewThreads(threads, "newest", rank);
    const order = new Map(sorted.map((entry, index) => [entry, index] as const));
    const folders = [
      { name: "empty", tier: 1, threads: [] },
      { name: "has-old", tier: 1, threads: [old] },
      { name: "has-fresh", tier: 1, threads: [fresh] },
      { name: "pinned", tier: 0, threads: [old] },
      { name: "archived", tier: 2, threads: [finished] },
    ];
    expect(
      orderSidebarFoldersByThreads(folders, order, (folder) => folder.tier).map(
        (folder) => folder.name,
      ),
    ).toEqual(["pinned", "has-fresh", "has-old", "empty", "archived"]);
  });
});

describe("sidebar view grouping", () => {
  const a = thread("a", { created: "2026-01-01T00:00:00Z" }, { tags: ["backend", "Frontend"] });
  const b = thread("b", { created: "2026-01-01T00:00:00Z" }, { tags: ["frontend"] });
  const c = thread("c", { created: "2026-01-01T00:00:00Z" }, { status: "failed" });

  it("puts each thread in one tag folder, preferring a picked tag, and untagged last", () => {
    const groups = groupSidebarThreadsByTag([c, a, b], (entry) => entry.tags, ["FRONTEND"]);
    expect(groups.map((group) => [group.key, group.label, group.threads.map((t) => t.id)])).toEqual(
      [
        ["tag:frontend", "Frontend", ["a", "b"]],
        [NO_TAG_GROUP_KEY, "No tag", ["c"]],
      ],
    );
    expect(
      groupSidebarThreadsByTag([a, b], (entry) => entry.tags, []).map((group) => group.key),
    ).toEqual(["tag:backend", "tag:frontend"]);
    const late = thread("late", { created: "2026-01-01T00:00:00Z" }, { tags: ["zebra", "alpha"] });
    expect(
      groupSidebarThreadsByTag([late], (entry) => entry.tags, []).map((group) => group.key),
    ).toEqual(["tag:alpha"]);
  });

  it("groups by status, most urgent first, without empty folders", () => {
    const groups = groupSidebarThreadsByStatus([a, c, b], (entry) => entry.status);
    expect(groups.map((group) => [group.label, group.threads.map((t) => t.id)])).toEqual([
      ["Failed", ["c"]],
      ["Done", ["a", "b"]],
    ]);
  });
});

describe("sidebarGroupNamesRowStatus", () => {
  it("leaves the status to the heading when the heading says it", () => {
    expect(sidebarGroupNamesRowStatus({ status: "waiting" })).toBe(true);
    expect(sidebarGroupNamesRowStatus({ status: "done" })).toBe(true);
  });

  it("keeps it on the row when the heading covers several kinds, or none", () => {
    expect(sidebarGroupNamesRowStatus({ status: "needs-you" })).toBe(false);
    expect(sidebarGroupNamesRowStatus({ status: null })).toBe(false);
  });
});

describe("sidebarViewAllowsWorkingShelf", () => {
  it("keeps the Working section when grouping by project, tag or nothing", () => {
    for (const groupBy of ["project", "tag", "none"] as const) {
      expect(sidebarViewAllowsWorkingShelf({ groupBy, statuses: [] })).toBe(true);
    }
  });

  it("steps aside for status folders", () => {
    expect(sidebarViewAllowsWorkingShelf({ groupBy: "status", statuses: [] })).toBe(false);
  });

  it("steps aside for a status filter, so its matches aren't hidden in a closed shelf", () => {
    expect(sidebarViewAllowsWorkingShelf({ groupBy: "project", statuses: ["working"] })).toBe(
      false,
    );
  });
});
