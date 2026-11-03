// fork: sidebar filter and sort, see FORK.md.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, TagIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { sidebarFolderRowId } from "./SidebarProjectFolderHeader";
import type { SidebarStatusFilter, SidebarViewGroup } from "./sidebarView";
import { threadTagDotStyle } from "./ThreadTagChips";

/** A status's dot color, the same on folders and in the filter menu. */
export const SIDEBAR_STATUS_DOT_CLASS_NAME: Record<SidebarStatusFilter, string> = {
  "needs-you": "bg-warning",
  failed: "bg-error",
  working: "bg-info",
  waiting: "bg-muted-foreground/50",
  done: "bg-success",
};

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

/**
 * A tag or status folder in the boring sidebar, drawn like a project folder. It has no
 * new-thread button or menu, since a new thread belongs to a project, not a tag.
 */
export const SidebarViewFolderHeader = memo(function SidebarViewFolderHeader(props: {
  group: SidebarViewGroup<EnvironmentThreadShell>;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (key: string) => void;
}) {
  const { group, collapsed, hiddenThreads } = props;
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  // A status folder's own color already says its status.
  const dot =
    collapsed && group.status === null
      ? resolveSidebarFolderDot(
          hiddenThreads.map((thread) => ({
            ...thread,
            lastVisitedAt: resolveThreadLastVisitedAt(
              thread.lastVisitedAt,
              localLastVisitedAtById[
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
              ],
            ),
          })),
        )
      : null;
  return (
    <li data-testid="sidebar-view-folder" className="relative mt-2 list-none first:mt-0">
      <button
        type="button"
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={sidebarFolderRowId(group.key)}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(group.key)}
        className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span aria-hidden className="grid size-4 shrink-0 place-items-center">
          {group.status !== null ? (
            <span
              className={cn("size-2 rounded-full", SIDEBAR_STATUS_DOT_CLASS_NAME[group.status])}
            />
          ) : group.tag !== null ? (
            <span className="size-2 rounded-full" style={threadTagDotStyle(group.tag)} />
          ) : (
            <TagIcon className="size-3.5 text-sidebar-muted-foreground" />
          )}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium",
            group.tag === null && group.status === null
              ? "text-sidebar-muted-foreground"
              : "text-sidebar-foreground/90",
          )}
        >
          {group.label}
        </span>
        {dot ? (
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}
          />
        ) : null}
        {collapsed && hiddenThreads.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
            {hiddenThreads.length}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
    </li>
  );
});
