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
  hasAnyThreadTag,
  listThreadTags,
  normalizeThreadTag,
  planThreadTagChanges,
  storedThreadTagsFromJson,
  THREAD_TAG_MAX_LENGTH,
  THREAD_TAGS_PER_THREAD,
} from "./threadTags.ts";

// fork: thread tags, see FORK.md.

const decodeServerSettings = Schema.decodeSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const tag = (name: string) => ({ tag: name, tagged: true });
const untag = (name: string) => ({ tag: name, tagged: false });

describe("planThreadTagChanges", () => {
  it("sends one thread.tag.set per tag, and nothing for a tag the thread has in any case", () => {
    expect(
      planThreadTagChanges([], [], [tag("frontend"), tag("waiting on review")], "typed"),
    ).toEqual({
      commands: [tag("frontend"), tag("waiting on review")],
      tags: ["frontend", "waiting on review"],
    });
    expect(planThreadTagChanges(["Frontend"], [], [tag("FRONTEND")], "typed")).toEqual({
      commands: [],
      tags: ["Frontend"],
    });
  });

  it("spells a new tag as it is already in use, and removes every spelling that matches", () => {
    expect(
      planThreadTagChanges([], ["zeta", "Frontend"], [tag("frontend")], "typed").commands,
    ).toEqual([tag("Frontend")]);
    expect(
      planThreadTagChanges(["Frontend", "frontend", "keep"], [], [untag("FRONTEND")], "typed"),
    ).toEqual({ commands: [untag("Frontend"), untag("frontend")], tags: ["keep"] });
    expect(planThreadTagChanges(["keep"], [], [untag("gone")], "typed").commands).toEqual([]);
  });

  it("cuts a new tag to 40 characters on one line, and skips a blank one", () => {
    const long = `waiting \n on   ${"x".repeat(64)}`;
    const [added] = planThreadTagChanges([], [], [tag(long), tag("  ")], "typed").commands;
    expect(added?.tag).toBe(normalizeThreadTag(long));
    expect(added?.tag).toHaveLength(THREAD_TAG_MAX_LENGTH);
    expect(added?.tag.startsWith("waiting on xxx")).toBe(true);
    expect(normalizeThreadTag("a\u0000b")).toBe("a b");
    // A cut that lands inside a surrogate pair drops the half.
    expect(normalizeThreadTag(`${"x".repeat(39)}😀`)).toBe("x".repeat(39));
  });

  it("matches stored tags whole, so two sharing their first 40 characters stay apart", () => {
    const stem = "s".repeat(THREAD_TAG_MAX_LENGTH);
    const [one, two] = [`${stem} one`, `${stem} two`];
    expect(planThreadTagChanges([one, two], [], [untag(two.toUpperCase())], "typed")).toEqual({
      commands: [untag(two)],
      tags: [one],
    });
    expect(planThreadTagChanges([one], [two], [tag(one), tag(two)], "typed")).toEqual({
      commands: [tag(two)],
      tags: [one, two],
    });
    expect(hasAnyThreadTag([one], [two], "typed")).toBe(false);
    expect(listThreadTags([[one, two]])).toEqual([one, two]);
  });

  it("matches a tag picked from a list by its whole spelling, so two spacings stay apart", () => {
    const [two, one] = ["waiting  on review", "waiting on review"];
    expect(planThreadTagChanges([two, one], [two, one], [untag(two)], "picked")).toEqual({
      commands: [untag(two)],
      tags: [one],
    });
    expect(planThreadTagChanges([one], [two, one], [tag(two)], "picked")).toEqual({
      commands: [tag(two)],
      tags: [one, two],
    });
    // Typed, the same text finds either spacing.
    expect(planThreadTagChanges([two, one], [], [untag(two)], "typed").tags).toEqual([]);
  });

  it("takes no tag past the soft cap of 20, but a swap on a full thread keeps its new tag", () => {
    const full = Array.from({ length: THREAD_TAGS_PER_THREAD }, (_, index) => `t${index}`);
    expect(planThreadTagChanges(full, [], [tag("one more")], "typed")).toEqual({
      commands: [],
      tags: full,
    });
    const swapped = planThreadTagChanges(full, [], [tag("new"), untag("T0")], "typed");
    expect(swapped.commands).toEqual([untag("t0"), tag("new")]);
    expect(swapped.tags).toHaveLength(THREAD_TAGS_PER_THREAD);
    expect(
      planThreadTagChanges(
        [],
        [],
        Array.from({ length: 25 }, (_, i) => tag(`tag ${i}`)),
        "typed",
      ).commands,
    ).toHaveLength(THREAD_TAGS_PER_THREAD);
  });
});

describe("thread tag reads", () => {
  it("lists every tag once in order and matches any wanted tag", () => {
    expect(listThreadTags([["zeta", "Alpha"], ["alpha", "beta"], undefined])).toEqual([
      "Alpha",
      "beta",
      "zeta",
    ]);
    expect(hasAnyThreadTag(["zeta", "Alpha"], ["ALPHA", "gamma"], "picked")).toBe(true);
    expect(hasAnyThreadTag(["beta"], ["gamma"], "picked")).toBe(false);
    expect(hasAnyThreadTag(undefined, ["gamma"], "typed")).toBe(false);
    // Typed text also matches tidied; a tag picked from a list matches its own spelling only.
    expect(hasAnyThreadTag(["waiting on review"], ["waiting   on review"], "typed")).toBe(true);
    expect(hasAnyThreadTag(["waiting on review"], ["waiting   on review"], "picked")).toBe(false);
  });

  it("reads stored tags as the shell does: an array of strings, or none", () => {
    expect(storedThreadTagsFromJson('["a","B"]')).toEqual(["a", "B"]);
    expect(storedThreadTagsFromJson('["a",1]')).toEqual([]);
    expect(storedThreadTagsFromJson("not json")).toEqual([]);
  });
});

describe("the old settings key", () => {
  it("stays readable until it moves, but no settings patch can write it", () => {
    const a = ThreadId.make("thread-a");
    expect(decodeServerSettings({}).threadTags).toEqual({});
    expect(decodeServerSettings({ threadTags: { [a]: ["frontend"] } }).threadTags).toEqual({
      [a]: ["frontend"],
    });
    for (const threadTags of [{}, { [a]: ["frontend"] }, { [a]: { frontend: true } }]) {
      const patch = decodeServerSettingsPatch({ enableProviderUpdateChecks: false, threadTags });
      expect(patch).toEqual({ enableProviderUpdateChecks: false });
      expect(requiredScopesForServerSettingsPatch(patch)).toEqual([AuthSettingsWriteScope]);
    }
  });
});
