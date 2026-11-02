import { describe, expect, it } from "vite-plus/test";
import type { SortingStrategy } from "@dnd-kit/sortable";
import { createBoringSidebarSortingStrategy } from "./boringPinDrag";
import type { SidebarListItem } from "../Sidebar.logic";

const items: SidebarListItem[] = [
  { kind: "marker", marker: "pinned-header" },
  { kind: "thread", key: "p1", section: "pinned" },
  { kind: "thread", key: "p2", section: "pinned" },
  { kind: "thread", key: "p3", section: "pinned" },
  { kind: "marker", marker: "pinned-divider" },
  { kind: "thread", key: "a1", section: "active" },
  { kind: "thread", key: "a2", section: "active" },
];

function transforms(activeIndex: number, overIndex: number) {
  let top = 0;
  const rects = items.map(() => {
    const rect = { top, height: 80, bottom: top + 80, left: 0, right: 260, width: 260 };
    top += 81;
    return rect;
  });
  const strategy = createBoringSidebarSortingStrategy(items);
  return items.map((_, index) =>
    strategy({
      activeIndex,
      overIndex,
      index,
      rects,
      activeNodeRect: rects[activeIndex]!,
    } satisfies Parameters<SortingStrategy>[0]),
  );
}

describe("boring sidebar pin dragging", () => {
  it("moves only pinned rows while a pinned row drags among them", () => {
    const moved = transforms(1, 3).map((transform) => transform?.y ?? 0);
    expect(moved.slice(2, 4).every((y) => y < 0)).toBe(true);
    expect([moved[0], moved[4], moved[5], moved[6]]).toEqual([0, 0, 0, 0]);
  });

  it("keeps folder rows in place when the pointer reaches them", () => {
    expect(transforms(1, 5).every((transform) => transform === null)).toBe(true);
  });
});
