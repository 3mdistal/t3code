import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

// fork: thread tags, see FORK.md.

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  hasCompletedRun: true,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [],
};

const tagsItem = (state: ThreadActionMenuState) =>
  buildThreadActionMenuItems(state).find((item) => item.id === "tags");

describe("thread tags menu", () => {
  it("ticks the thread's tags, matching case, and ends with New tag", () => {
    const item = tagsItem({
      ...baseState,
      tags: { all: ["backend", "Frontend"], selected: ["frontend"] },
    });
    expect(item?.children).toEqual([
      { id: "tag:backend", label: "backend", checked: false },
      { id: "tag:Frontend", label: "Frontend", checked: true },
      { id: "tag-new", label: "New tag…", separatorBefore: true },
    ]);
  });

  it("offers only New tag before any tag exists", () => {
    const item = tagsItem({ ...baseState, tags: { all: [], selected: [] } });
    expect(item?.children).toEqual([{ id: "tag-new", label: "New tag…", separatorBefore: false }]);
  });

  it("is left out without tags to show, and disabled where the connection can't change threads", () => {
    expect(tagsItem(baseState)).toBeUndefined();
    const tags = { all: ["backend"], selected: [] };
    expect(tagsItem({ ...baseState, canOperate: false, tags })?.disabled).toBe(true);
  });
});
