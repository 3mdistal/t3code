// fork: sidebar filter and sort, see FORK.md.
import { ArrowDownUpIcon } from "lucide-react";

import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import {
  SIDEBAR_GROUPING_LABELS,
  SIDEBAR_GROUPINGS,
  SIDEBAR_THREAD_SORT_LABELS,
  SIDEBAR_THREAD_SORTS,
  type SidebarGrouping,
  type SidebarThreadSort,
  type SidebarView,
} from "./sidebarView";

/** Thread order and folder grouping for the boring sidebar. Filters never change these. */
export function SidebarSortMenu(props: {
  readonly view: SidebarView;
  readonly onViewChange: (update: (view: SidebarView) => SidebarView) => void;
  // Set when project folders keep the user's manual project order instead of following the sort.
  readonly folderOrderNote: string | null;
}) {
  const { view, onViewChange } = props;
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={`Sort threads: ${SIDEBAR_THREAD_SORT_LABELS[view.sort]}, grouped by ${SIDEBAR_GROUPING_LABELS[view.groupBy].toLocaleLowerCase()}`}
            data-testid="sidebar-sort-button"
          />
        }
      >
        <ArrowDownUpIcon className="size-4" />
      </MenuTrigger>
      <MenuPopup
        align="start"
        collisionAvoidance={{ side: "flip", align: "shift" }}
        className="w-[min(16rem,var(--available-width))]"
      >
        <MenuRadioGroup
          value={view.sort}
          onValueChange={(next) =>
            onViewChange((current) => ({ ...current, sort: next as SidebarThreadSort }))
          }
        >
          <MenuGroupLabel>Sort threads by</MenuGroupLabel>
          {SIDEBAR_THREAD_SORTS.map((sort) => (
            <MenuRadioItem key={sort} value={sort}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{SIDEBAR_THREAD_SORT_LABELS[sort]}</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuRadioGroup
          value={view.groupBy}
          onValueChange={(next) =>
            onViewChange((current) => ({ ...current, groupBy: next as SidebarGrouping }))
          }
        >
          <MenuGroupLabel>Group by</MenuGroupLabel>
          {SIDEBAR_GROUPINGS.map((grouping) => (
            <MenuRadioItem key={grouping} value={grouping}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{SIDEBAR_GROUPING_LABELS[grouping]}</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
          {view.groupBy === "project" && props.folderOrderNote !== null ? (
            <p className="px-2 pb-1 text-xs text-muted-foreground">{props.folderOrderNote}</p>
          ) : null}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
