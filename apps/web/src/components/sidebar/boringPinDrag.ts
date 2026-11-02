// fork: the boring sidebar lets pinned rows drag among themselves, see FORK.md.
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import type { SidebarListItem } from "../Sidebar.logic";

// Project folders draw their rows outside the list's order, so only pinned rows may move.
export function createBoringSidebarSortingStrategy(
  items: readonly SidebarListItem[],
): SortingStrategy {
  const isPinned = (index: number) => {
    const item = items[index];
    return item?.kind === "thread" && item.section === "pinned";
  };
  return (args) =>
    isPinned(args.activeIndex) && isPinned(args.overIndex) && isPinned(args.index)
      ? verticalListSortingStrategy(args)
      : null;
}
