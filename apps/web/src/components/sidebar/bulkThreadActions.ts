// fork: bulk thread actions, see FORK.md.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import {
  type ContextMenuItem,
  type EnvironmentId,
  hasAnyThreadTag,
  normalizeThreadTag,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

import type { ThreadTagMenuState } from "../threadActionMenu.logic";

/** A menu entry that says how many threads it will change, or nothing when it changes none. */
export function buildBulkMenuItem<T extends string>(
  id: T,
  label: string,
  targetCount: number,
  canOperate: boolean,
): ReadonlyArray<ContextMenuItem<T>> {
  if (targetCount === 0) return [];
  return [{ id, label: `${label} (${targetCount})`, disabled: !canOperate }];
}

export type BulkTagMenuId = "tags" | `tag:${string}` | "tag-new";

/** Every tag the selected threads' servers know, once each, however many threads share it. */
export function bulkAllTags(menus: ReadonlyArray<ThreadTagMenuState>): ReadonlyArray<string> {
  const tags = new Map<string, string>();
  for (const menu of menus) {
    for (const tag of menu.all) {
      const key = normalizeThreadTag(tag).toLocaleLowerCase();
      if (!tags.has(key)) tags.set(key, tag);
    }
  }
  return [...tags.values()].toSorted((a, b) => a.localeCompare(b));
}

/**
 * The Tags submenu for several threads, or null when none of their servers can hold tags.
 * Native menus have no mixed state, so a tag only some threads have says how many.
 */
export function buildBulkTagMenuItem(
  menus: ReadonlyArray<ThreadTagMenuState>,
): ContextMenuItem<BulkTagMenuId> | null {
  if (menus.length === 0) return null;
  const all = bulkAllTags(menus);
  return {
    id: "tags",
    label: `Tags (${menus.length})`,
    children: [
      ...all.map((tag) => {
        const have = menus.filter((menu) => hasAnyThreadTag(menu.selected, [tag])).length;
        return {
          id: `tag:${tag}` as const,
          label: have > 0 && have < menus.length ? `${tag} (${have} of ${menus.length})` : tag,
          checked: have === menus.length,
        };
      }),
      { id: "tag-new", label: "New tag…", separatorBefore: all.length > 0 },
    ],
  };
}

/** Picking a tag every thread already has removes it; otherwise every thread gets it. */
export function bulkTagAdds(selected: ReadonlyArray<ReadonlyArray<string>>, tag: string): boolean {
  return !selected.every((tags) => hasAnyThreadTag(tags, [tag]));
}

/** One settings patch per server, since each server keeps its own threads' tags. */
export function buildBulkTagPatches(
  threadRefs: ReadonlyArray<ScopedThreadRef>,
  tag: string,
  add: boolean,
): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly threadTags: Readonly<Record<ThreadId, Readonly<Record<string, boolean>>>>;
}> {
  const byEnvironment = new Map<EnvironmentId, Record<ThreadId, Record<string, boolean>>>();
  for (const { environmentId, threadId } of threadRefs) {
    const threadTags = byEnvironment.get(environmentId) ?? {};
    threadTags[threadId] = { [tag]: add };
    byEnvironment.set(environmentId, threadTags);
  }
  return [...byEnvironment].map(([environmentId, threadTags]) => ({ environmentId, threadTags }));
}

/** Puts threads in the order the sidebar lists them. Anything not listed goes last. */
export function sortByListedOrder<T>(
  items: ReadonlyArray<T>,
  keyOf: (item: T) => string,
  listedKeys: ReadonlyArray<string>,
): ReadonlyArray<T> {
  const positions = new Map(listedKeys.map((key, index) => [key, index] as const));
  const positionOf = (item: T) => positions.get(keyOf(item)) ?? listedKeys.length;
  return items.toSorted((a, b) => positionOf(a) - positionOf(b));
}

/** Every current pin's order key, from all threads: a batch goes above a pin a filter hides too. */
export function currentPinOrderKeys(
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "pinnedAt" | "pinOrderKey">>,
): ReadonlyArray<string | null> {
  return threads.map((thread) => (thread.pinnedAt == null ? null : (thread.pinOrderKey ?? null)));
}

/**
 * Order keys that put `count` new pins above every current pin, first one on top, so a bulk
 * pin keeps the listed order. An undefined key means the existing keys can't be built on, and
 * the pin falls back to its usual place at the top.
 */
export function planBulkPinOrderKeys(
  count: number,
  currentOrderKeys: Iterable<string | null>,
): ReadonlyArray<string | undefined> {
  let next: string | null = null;
  for (const key of currentOrderKeys) {
    if (key !== null && (next === null || key < next)) next = key;
  }
  const keys: Array<string | undefined> = [];
  for (let index = 0; index < count; index += 1) {
    const key: string | null = pinOrderKeyBetween(null, next);
    keys.unshift(key ?? undefined);
    if (key !== null) next = key;
  }
  return keys;
}
