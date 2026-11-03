import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AuthSettingsWriteScope } from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";
import {
  requiredScopesForServerSettingsPatch,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";
import {
  applyThreadTagsPatch,
  hasAnyThreadTag,
  listThreadTags,
  normalizeThreadTag,
  THREAD_TAGS_PER_THREAD,
} from "./threadTags.ts";

// fork: thread tags, see FORK.md.

const decodeServerSettings = Schema.decodeSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeSync(ServerSettingsPatch);
const a = ThreadId.make("thread-a");
const b = ThreadId.make("thread-b");

describe("thread tags", () => {
  it("adds and removes one tag at a time, so two windows ticking at once both land", () => {
    const first = applyThreadTagsPatch({}, { [a]: { frontend: true } });
    const both = applyThreadTagsPatch(first, { [a]: { "waiting on review": true } });
    expect(both).toEqual({ [a]: ["frontend", "waiting on review"] });
    expect(applyThreadTagsPatch(both, { [a]: { frontend: false } })).toEqual({
      [a]: ["waiting on review"],
    });
  });

  it("matches tags regardless of case and keeps the spelling already in use", () => {
    const current = { [a]: ["Frontend"] };
    const next = applyThreadTagsPatch(current, {
      [b]: { frontend: true },
      [a]: { FRONTEND: true },
    });
    expect(next).toEqual({ [a]: ["Frontend"], [b]: ["Frontend"] });
    expect(applyThreadTagsPatch(next, { [a]: { frontend: false } })).toEqual({ [b]: ["Frontend"] });
  });

  it("drops a thread with no tags left, clears a thread with null, and skips blank tags", () => {
    const current = { [a]: ["one", "two"], [b]: ["three"] };
    expect(applyThreadTagsPatch(current, { [a]: null, [b]: { "  ": true } })).toEqual({
      [b]: ["three"],
    });
    expect(applyThreadTagsPatch(current, { [a]: ["Two", "two", " "], [b]: [] })).toEqual({
      [a]: ["two"],
    });
    expect(normalizeThreadTag("  waiting \n on   review ")).toBe("waiting on review");
  });

  it("caps tags per thread", () => {
    const many = Object.fromEntries(
      Array.from({ length: THREAD_TAGS_PER_THREAD + 5 }, (_, index) => [`tag ${index}`, true]),
    );
    expect(applyThreadTagsPatch({}, { [a]: many })[a]).toHaveLength(THREAD_TAGS_PER_THREAD);
  });

  it("lists every tag once in order and matches any wanted tag", () => {
    const settings = { [a]: ["zeta", "Alpha"], [b]: ["alpha", "beta"] };
    expect(listThreadTags(settings)).toEqual(["Alpha", "beta", "zeta"]);
    expect(hasAnyThreadTag(settings[a], ["ALPHA", "gamma"])).toBe(true);
    expect(hasAnyThreadTag(settings[b], ["gamma"])).toBe(false);
    expect(hasAnyThreadTag(undefined, ["gamma"])).toBe(false);
  });

  it("is an optional settings key that needs settings write", () => {
    expect(decodeServerSettings({}).threadTags).toEqual({});
    const patch = decodeServerSettingsPatch({
      threadTags: { [a]: { frontend: true }, [b]: null },
    });
    expect(requiredScopesForServerSettingsPatch(patch)).toEqual([AuthSettingsWriteScope]);
  });
});
