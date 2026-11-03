import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts"; // fork: ThreadId, see FORK.md.

/** Tags match by exact spelling and case after trimming. */
export const ThreadTag = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value) =>
    /[\p{Cc}]/u.test(value) ? "A thread tag must be a single line of text." : true,
  ),
);
export type ThreadTag = typeof ThreadTag.Type;

/** Tags read back from storage or a peer. Lenient so a later tag rule never fails a whole thread. */
export const StoredThreadTags = Schema.Array(Schema.String).pipe(
  Schema.catchDecoding(() => Effect.succeedSome([])),
);

// fork: thread tags kept in server settings, see FORK.md.
export const THREAD_TAG_MAX_LENGTH = 40;
export const THREAD_TAGS_PER_THREAD = 20;

/** A tag as an agent names it for the settings-backed tags below; stored normalized. */
export const ThreadTagInput = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_TAG_MAX_LENGTH),
);

// Stored tags decode as plain strings, so one odd entry can't fail every setting.
export const ThreadTagSettings = Schema.Record(ThreadId, Schema.Array(Schema.String));
export type ThreadTagSettings = typeof ThreadTagSettings.Type;

/**
 * Applied to the tags the server holds, so ticks sent from two windows both land.
 * Each tag adds (true) or removes (false) one tag; a list replaces the thread's tags,
 * as a whole settings object does; null clears them.
 */
export const ThreadTagSettingsPatch = Schema.Record(
  ThreadId,
  Schema.NullOr(
    Schema.Union([Schema.Array(Schema.String), Schema.Record(Schema.String, Schema.Boolean)]),
  ),
);
export type ThreadTagSettingsPatch = typeof ThreadTagSettingsPatch.Type;

export function normalizeThreadTag(tag: string): string {
  return tag.trim().replace(/\s+/g, " ").slice(0, THREAD_TAG_MAX_LENGTH).trim();
}

// Compared in their stored form, so a tag typed with extra spaces still finds itself.
const tagKey = (tag: string) => normalizeThreadTag(tag).toLocaleLowerCase();

/** Tags match regardless of case, and a new tag takes the spelling already in use. */
export function applyThreadTagsPatch(
  current: ThreadTagSettings,
  patch: ThreadTagSettingsPatch,
): ThreadTagSettings {
  const spelling = new Map<string, string>();
  for (const tag of listThreadTags(current)) spelling.set(tagKey(tag), tag);
  const next: Record<string, ReadonlyArray<string>> = { ...current };
  for (const [threadId, change] of Object.entries(patch)) {
    const replaces = change === null || Array.isArray(change);
    let tags = replaces ? [] : [...(next[threadId] ?? [])];
    const changes: ReadonlyArray<readonly [string, boolean]> = Array.isArray(change)
      ? change.map((tag) => [tag, true] as const)
      : Object.entries(change ?? {});
    // Removals go first, so a patch that swaps tags on a full thread keeps its additions.
    const ordered = [...changes.filter(([, add]) => !add), ...changes.filter(([, add]) => add)];
    for (const [raw, add] of ordered) {
      const name = normalizeThreadTag(raw);
      if (name === "") continue;
      const key = tagKey(name);
      const has = tags.some((tag) => tagKey(tag) === key);
      if (!add) tags = tags.filter((tag) => tagKey(tag) !== key);
      else if (!has && tags.length < THREAD_TAGS_PER_THREAD) {
        const tag = spelling.get(key) ?? name;
        spelling.set(key, tag);
        tags.push(tag);
      }
    }
    if (tags.length === 0) delete next[threadId];
    else next[threadId] = tags;
  }
  return next as ThreadTagSettings;
}

/** Every tag in use, once each, in alphabetical order. */
export function listThreadTags(settings: ThreadTagSettings): ReadonlyArray<string> {
  const tags = new Map<string, string>();
  for (const threadTags of Object.values(settings)) {
    for (const tag of threadTags) if (!tags.has(tagKey(tag))) tags.set(tagKey(tag), tag);
  }
  return [...tags.values()].sort((a, b) => a.localeCompare(b));
}

/** True when the thread has any of the wanted tags. */
export function hasAnyThreadTag(
  tags: ReadonlyArray<string> | undefined,
  wanted: ReadonlyArray<string>,
): boolean {
  const keys = new Set(wanted.map(tagKey));
  return (tags ?? []).some((tag) => keys.has(tagKey(tag)));
}
