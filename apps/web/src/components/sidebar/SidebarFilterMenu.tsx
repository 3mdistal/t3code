// fork: sidebar filter and sort, see FORK.md.
import { CircleDotIcon, FolderIcon, ListFilterIcon, PinIcon, TagIcon, XIcon } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, type RefObject, useState } from "react";

import { cn } from "~/lib/utils";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSearchInput,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import {
  matchesSidebarFilterQuery,
  type SidebarFilterCount,
  SIDEBAR_STATUS_FILTERS,
  SIDEBAR_STATUS_LABELS,
  type SidebarStatusFilter,
  type SidebarView,
} from "./sidebarView";
import { SIDEBAR_STATUS_DOT_CLASS_NAME } from "./SidebarViewFolderHeader";
import { threadTagDotClassName, threadTagDotStyle } from "./ThreadTagChips";

export interface SidebarFilterProject {
  readonly key: string;
  readonly label: string;
  readonly project: ProjectFaviconProject;
  readonly count: number;
}

interface SidebarFilterMenuProps {
  readonly anchor: RefObject<HTMLElement | null>;
  readonly view: SidebarView;
  readonly onViewChange: (update: (view: SidebarView) => SidebarView) => void;
  readonly projects: ReadonlyArray<SidebarFilterProject>;
  readonly projectKeys: ReadonlyArray<string>;
  readonly onProjectKeysChange: (keys: readonly string[]) => void;
  readonly onProjectSettings: (key: string, event: ReactMouseEvent<HTMLElement>) => void;
  readonly tags: ReadonlyArray<SidebarFilterCount<string>>;
  readonly statuses: ReadonlyArray<SidebarFilterCount<SidebarStatusFilter>>;
  readonly filterCount: number;
  readonly onClear: () => void;
}

const toggled = <T,>(values: ReadonlyArray<T>, value: T, on: boolean): T[] =>
  on
    ? [...values.filter((candidate) => candidate !== value), value]
    : values.filter((candidate) => candidate !== value);

function hasTag(tags: ReadonlyArray<string>, tag: string) {
  const key = tag.toLocaleLowerCase();
  return tags.some((candidate) => candidate.toLocaleLowerCase() === key);
}

function toggledTag(tags: ReadonlyArray<string>, tag: string, on: boolean): string[] {
  const key = tag.toLocaleLowerCase();
  const rest = tags.filter((candidate) => candidate.toLocaleLowerCase() !== key);
  return on ? [...rest, tag] : rest;
}

function Count(props: { readonly value: number }) {
  return <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{props.value}</span>;
}

function SelectedCount(props: { readonly value: number }) {
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {props.value === 0 ? "Any" : props.value}
    </span>
  );
}

/**
 * The sidebar's one filter button: projects, tags, statuses and two switches. A badge
 * counts what is on, since no chips show it, and the search finds any project, tag or status.
 */
export function SidebarFilterMenu(props: SidebarFilterMenuProps) {
  const { view, onViewChange, projects, projectKeys, tags, statuses } = props;
  const [query, setQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [tagQuery, setTagQuery] = useState("");
  const setTag = (tag: string, on: boolean) =>
    onViewChange((current) => ({ ...current, tags: toggledTag(current.tags, tag, on) }));
  const setStatus = (status: SidebarStatusFilter, on: boolean) =>
    onViewChange((current) => ({ ...current, statuses: toggled(current.statuses, status, on) }));
  const setProject = (key: string, on: boolean) =>
    props.onProjectKeysChange(toggled(projectKeys, key, on));

  const projectItem = (project: SidebarFilterProject) => (
    <MenuCheckboxItem
      key={`project:${project.key}`}
      checked={projectKeys.includes(project.key)}
      onCheckedChange={(on) => setProject(project.key, on)}
      onContextMenu={(event) => props.onProjectSettings(project.key, event)}
    >
      <span className="flex min-w-0 items-center gap-2">
        <ProjectFavicon project={project.project} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{project.label}</span>
        <Count value={project.count} />
      </span>
    </MenuCheckboxItem>
  );
  const tagItem = (tag: SidebarFilterCount<string>) => (
    <MenuCheckboxItem
      key={`tag:${tag.value.toLocaleLowerCase()}`}
      checked={hasTag(view.tags, tag.value)}
      onCheckedChange={(on) => setTag(tag.value, on)}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="inline-flex min-w-0 flex-1 items-center">
          <span className="inline-flex min-w-0 items-center gap-1 rounded-sm bg-muted/70 px-1 text-xs">
            <span
              aria-hidden
              className={threadTagDotClassName}
              style={threadTagDotStyle(tag.value)}
            />
            <span className="min-w-0 truncate">{tag.value}</span>
          </span>
        </span>
        <Count value={tag.count} />
      </span>
    </MenuCheckboxItem>
  );
  const statusItem = (status: SidebarFilterCount<SidebarStatusFilter>) => (
    <MenuCheckboxItem
      key={`status:${status.value}`}
      checked={view.statuses.includes(status.value)}
      onCheckedChange={(on) => setStatus(status.value, on)}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            SIDEBAR_STATUS_DOT_CLASS_NAME[status.value],
          )}
        />
        <span className="min-w-0 flex-1 truncate">{SIDEBAR_STATUS_LABELS[status.value]}</span>
        <Count value={status.count} />
      </span>
    </MenuCheckboxItem>
  );

  const searching = query.trim().length > 0;
  const projectMatches = projects.filter((project) =>
    matchesSidebarFilterQuery(project.label, query),
  );
  const tagMatches = tags.filter((tag) => matchesSidebarFilterQuery(tag.value, query));
  const statusMatches = statuses.filter((status) =>
    matchesSidebarFilterQuery(SIDEBAR_STATUS_LABELS[status.value], query),
  );
  const label =
    props.filterCount === 0
      ? "Filter threads"
      : `Filter threads, ${props.filterCount} ${props.filterCount === 1 ? "filter" : "filters"} on`;

  return (
    <Menu
      onOpenChange={(open) => {
        if (open) return;
        setQuery("");
        setProjectQuery("");
        setTagQuery("");
      }}
    >
      <MenuTrigger
        render={<SidebarHeaderIconButton label={label} data-testid="sidebar-filter-button" />}
      >
        <ListFilterIcon className="size-4" />
        {props.filterCount > 0 ? (
          <span
            aria-hidden
            data-testid="sidebar-filter-count"
            className="pointer-events-none absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-primary px-0.5 text-2xs leading-none font-medium text-primary-foreground tabular-nums"
          >
            {props.filterCount}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="start" anchor={props.anchor} className="w-64">
        <MenuSearchInput
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Filter by…"
          aria-label="Filter by project, tag or status"
        />
        {searching ? (
          projectMatches.length + tagMatches.length + statusMatches.length === 0 ? (
            <MenuItem disabled>No matching projects, tags or statuses</MenuItem>
          ) : (
            <>
              {projectMatches.map(projectItem)}
              {tagMatches.map(tagItem)}
              {statusMatches.map(statusItem)}
            </>
          )
        ) : (
          <>
            <MenuSub>
              <MenuSubTrigger>
                <FolderIcon aria-hidden className="size-3.5" />
                <span className="flex-1">Project</span>
                <SelectedCount value={projectKeys.length} />
              </MenuSubTrigger>
              <MenuSubPopup className="w-64">
                <MenuSearchInput
                  autoFocus
                  value={projectQuery}
                  onChange={(event) => setProjectQuery(event.currentTarget.value)}
                  placeholder="Project…"
                  aria-label="Search projects"
                />
                {projects
                  .filter((project) => matchesSidebarFilterQuery(project.label, projectQuery))
                  .map(projectItem)}
              </MenuSubPopup>
            </MenuSub>
            <MenuSub>
              <MenuSubTrigger>
                <TagIcon aria-hidden className="size-3.5" />
                <span className="flex-1">Tag</span>
                <SelectedCount value={view.tags.length} />
              </MenuSubTrigger>
              <MenuSubPopup className="w-64">
                <MenuSearchInput
                  autoFocus
                  value={tagQuery}
                  onChange={(event) => setTagQuery(event.currentTarget.value)}
                  placeholder="Tag…"
                  aria-label="Search tags"
                />
                {tags.length === 0 ? (
                  <MenuItem disabled>No tags yet. Right-click a thread to tag it.</MenuItem>
                ) : (
                  tags.filter((tag) => matchesSidebarFilterQuery(tag.value, tagQuery)).map(tagItem)
                )}
              </MenuSubPopup>
            </MenuSub>
            <MenuSub>
              <MenuSubTrigger>
                <CircleDotIcon aria-hidden className="size-3.5" />
                <span className="flex-1">Status</span>
                <SelectedCount value={view.statuses.length} />
              </MenuSubTrigger>
              <MenuSubPopup className="w-56">
                {SIDEBAR_STATUS_FILTERS.map((value) =>
                  statusItem(
                    statuses.find((status) => status.value === value) ?? { value, count: 0 },
                  ),
                )}
              </MenuSubPopup>
            </MenuSub>
            <MenuCheckboxItem
              checked={view.pinnedOnly}
              onCheckedChange={(on) => onViewChange((current) => ({ ...current, pinnedOnly: on }))}
            >
              <span className="flex items-center gap-2">
                <PinIcon aria-hidden className="size-3.5 text-muted-foreground" />
                Pinned only
              </span>
            </MenuCheckboxItem>
            <MenuCheckboxItem
              checked={view.openPrOnly}
              onCheckedChange={(on) => onViewChange((current) => ({ ...current, openPrOnly: on }))}
            >
              <span className="flex items-center gap-2">
                <PullRequestGlyph.pullRequest
                  aria-hidden
                  className="size-3.5 text-muted-foreground"
                />
                Has an open PR
              </span>
            </MenuCheckboxItem>
            <MenuSeparator />
            <MenuItem disabled={props.filterCount === 0} onClick={props.onClear}>
              <XIcon aria-hidden className="size-3.5" />
              Clear filters
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}
