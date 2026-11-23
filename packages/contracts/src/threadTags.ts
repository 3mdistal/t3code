import * as Effect from "effect/Effect";
import * as Option from "effect/Option"; // fork: thread tags, see FORK.md.
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts"; // fork: thread tags, see FORK.md.

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

// fork: the sidebar and agents set upstream's tags with `thread.tag.set`, matching them regardless of
// case. See FORK.md.
export const THREAD_TAG_MAX_LENGTH = 40;
/** Soft: the menu and agent tools keep to it, but upstream's command takes any number. */
export const THREAD_TAGS_PER_THREAD = 20;

/** Where the fork kept tags before they moved onto their threads; read only to move them. */
export const ThreadTagSettings = Schema.Record(ThreadId, Schema.Array(Schema.String));
export type ThreadTagSettings = typeof ThreadTagSettings.Type;

/** Every tag on a server's threads, archived ones too. Servers that advertise `threadTagNames`. */
export const THREAD_TAG_NAMES_WS_METHOD = "orchestration.listThreadTagNames";
export const ThreadTagNames = Schema.Struct({ tags: Schema.Array(Schema.String) });

const decodeStoredThreadTagsJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredThreadTags),
);

/** A thread's tags from their stored JSON, read as leniently as its shell reads them. */
export function storedThreadTagsFromJson(json: string): ReadonlyArray<string> {
  return Option.getOrElse(decodeStoredThreadTagsJson(json), () => []);
}

const isThreadTag = Schema.is(ThreadTag);

const tidyThreadTag = (tag: string) => tag.replace(/[\s\p{Cc}]+/gu, " ").trim();

/** Typed text as a new tag: one line, single spaces, cut to 40 without splitting a surrogate pair. */
export function normalizeThreadTag(tag: string): string {
  const cut = tidyThreadTag(tag).slice(0, THREAD_TAG_MAX_LENGTH);
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).trim();
}

/** How stored tags compare: the whole trimmed tag, never cut, in any case, in any locale. */
export function threadTagKey(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * How a tag finds its matches. One picked from a menu or filter is a stored tag, so it matches by
 * its key alone; typed text also matches tidied, so `waiting  on review` finds `waiting on review`.
 */
export type ThreadTagMatch = "picked" | "typed";

const matchKeys = (tag: string, match: ThreadTagMatch) =>
  match === "picked" ? [threadTagKey(tag)] : [threadTagKey(tag), tidyThreadTag(tag).toLowerCase()];

/** Each tag `thread.tag.set` accepts, by key, in its first spelling. */
function threadTagSpellings(tags: Iterable<string>): Map<string, string> {
  const spellings = new Map<string, string>();
  for (const tag of tags) {
    if (isThreadTag(tag) && !spellings.has(threadTagKey(tag)))
      spellings.set(threadTagKey(tag), tag);
  }
  return spellings;
}

/**
 * How a tag added to a thread is spelled: the first of `sources` (the thread's tags, then those in
 * use) that has it, else the text as a new tag; typed text also finds its cut form. Empty for blank
 * text.
 */
function spellThreadTag(
  tag: string,
  match: ThreadTagMatch,
  ...sources: ReadonlyArray<ReadonlyMap<string, string>>
): string {
  const find = (text: string) => {
    for (const source of sources) {
      for (const key of matchKeys(text, match)) {
        const spelling = source.get(key);
        if (spelling !== undefined) return spelling;
      }
    }
    return undefined;
  };
  const name = normalizeThreadTag(tag);
  if (name === "") return "";
  return find(tag) ?? (match === "typed" ? find(name) : undefined) ?? name;
}

/** Every tag in use, once each, in alphabetical order. */
export function listThreadTags(
  tagLists: Iterable<ReadonlyArray<string> | undefined>,
): ReadonlyArray<string> {
  const tags = new Map<string, string>();
  for (const list of tagLists) {
    for (const tag of list ?? [])
      if (!tags.has(threadTagKey(tag))) tags.set(threadTagKey(tag), tag);
  }
  return [...tags.values()].sort((a, b) => a.localeCompare(b));
}

/** True when the thread has any of the wanted tags. */
export function hasAnyThreadTag(
  tags: ReadonlyArray<string> | undefined,
  wanted: ReadonlyArray<string>,
  match: ThreadTagMatch,
): boolean {
  const keys = new Set(wanted.flatMap((tag) => matchKeys(tag, match)));
  return (tags ?? []).some((tag) => keys.has(threadTagKey(tag)));
}

export interface ThreadTagChange {
  readonly tag: string;
  readonly tagged: boolean;
}

/**
 * The `thread.tag.set` changes that apply `changes` to a thread holding `current`, and its tags after.
 * Removals go first, so a swap on a full thread keeps its new tag. A new tag is spelled by
 * `spellThreadTag`, and a thread at the soft cap takes no more; a removal takes off every match.
 */
export function planThreadTagChanges(
  current: ReadonlyArray<string>,
  inUse: Iterable<string>,
  changes: ReadonlyArray<ThreadTagChange>,
  match: ThreadTagMatch,
): { readonly commands: ReadonlyArray<ThreadTagChange>; readonly tags: ReadonlyArray<string> } {
  const spellings = threadTagSpellings(inUse);
  let tags = [...current];
  const commands: Array<ThreadTagChange> = [];
  const ordered = [
    ...changes.filter(({ tagged }) => !tagged),
    ...changes.filter(({ tagged }) => tagged),
  ];
  for (const change of ordered) {
    if (!change.tagged) {
      const keys = matchKeys(change.tag, match);
      const removed = tags.filter((tag) => keys.includes(threadTagKey(tag)) && isThreadTag(tag));
      commands.push(...removed.map((tag) => ({ tag, tagged: false })));
      tags = tags.filter((tag) => !removed.includes(tag));
      continue;
    }
    const tag = spellThreadTag(change.tag, match, threadTagSpellings(tags), spellings);
    if (
      tag === "" ||
      tags.some((have) => threadTagKey(have) === threadTagKey(tag)) ||
      tags.length >= THREAD_TAGS_PER_THREAD
    ) {
      continue;
    }
    spellings.set(threadTagKey(tag), tag);
    tags.push(tag);
    commands.push({ tag, tagged: true });
  }
  return { commands, tags };
}
