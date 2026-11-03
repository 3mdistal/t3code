import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildBulkMenuItem,
  buildBulkTagMenuItem,
  buildBulkTagPatches,
  bulkTagAdds,
  planBulkPinOrderKeys,
  sortByListedOrder,
} from "./bulkThreadActions";

const menu = (selected: ReadonlyArray<string>, all: ReadonlyArray<string> = selected) => ({
  all,
  selected,
  canEdit: true,
});

describe("buildBulkMenuItem", () => {
  it("counts only the threads it applies to", () => {
    expect(buildBulkMenuItem("pin", "Pin", 2, true)).toEqual([
      { id: "pin", label: "Pin (2)", disabled: false },
    ]);
  });

  it("leaves itself out when it applies to none", () => {
    expect(buildBulkMenuItem("pin", "Pin", 0, true)).toEqual([]);
  });

  it("stays visible but disabled when this connection can't change them", () => {
    expect(buildBulkMenuItem("archive", "Archive", 3, false)[0]?.disabled).toBe(true);
  });
});

describe("buildBulkTagMenuItem", () => {
  it("is absent when no server can hold tags", () => {
    expect(buildBulkTagMenuItem([])).toBeNull();
  });

  it("ticks a tag every thread has and counts one only some have", () => {
    const item = buildBulkTagMenuItem([
      menu(["bugs", "sidebar"]),
      menu(["bugs"]),
      menu(["bugs"], ["bugs", "release"]),
    ]);
    expect(item?.label).toBe("Tags (3)");
    expect(item?.children).toEqual([
      { id: "tag:bugs", label: "bugs", checked: true },
      { id: "tag:release", label: "release", checked: false },
      { id: "tag:sidebar", label: "sidebar (1 of 3)", checked: false },
      { id: "tag-new", label: "New tag…", separatorBefore: true },
    ]);
  });

  it("treats tags on different servers as one when only their case differs", () => {
    const item = buildBulkTagMenuItem([menu(["Bugs"]), menu(["bugs"])]);
    expect(item?.children?.[0]).toEqual({ id: "tag:Bugs", label: "Bugs", checked: true });
    expect(item?.children).toHaveLength(2);
  });

  it("offers only New tag when there are no tags yet", () => {
    const item = buildBulkTagMenuItem([menu([]), menu([])]);
    expect(item?.children).toEqual([{ id: "tag-new", label: "New tag…", separatorBefore: false }]);
  });
});

describe("bulkTagAdds", () => {
  it("adds when any thread lacks the tag", () => {
    expect(bulkTagAdds([["bugs"], []], "bugs")).toBe(true);
  });

  it("removes when every thread has it, whatever the case", () => {
    expect(bulkTagAdds([["Bugs"], ["bugs"]], "bugs")).toBe(false);
  });
});

describe("buildBulkTagPatches", () => {
  it("writes one patch per server", () => {
    const pc = EnvironmentId.make("pc");
    const mac = EnvironmentId.make("mac");
    const [a, b, c] = [ThreadId.make("a"), ThreadId.make("b"), ThreadId.make("c")];
    expect(
      buildBulkTagPatches(
        [
          { environmentId: pc, threadId: a },
          { environmentId: mac, threadId: b },
          { environmentId: pc, threadId: c },
        ],
        "bugs",
        true,
      ),
    ).toEqual([
      { environmentId: pc, threadTags: { a: { bugs: true }, c: { bugs: true } } },
      { environmentId: mac, threadTags: { b: { bugs: true } } },
    ]);
  });
});

describe("sortByListedOrder", () => {
  it("follows the list, not the order they were selected in", () => {
    expect(sortByListedOrder(["c", "a", "x", "b"], (key) => key, ["a", "b", "c"])).toEqual([
      "a",
      "b",
      "c",
      "x",
    ]);
  });
});

describe("planBulkPinOrderKeys", () => {
  it("puts the first thread on top and every new pin above the current ones", () => {
    const keys = planBulkPinOrderKeys(3, ["m", null, "t"]);
    expect(keys).toHaveLength(3);
    const [first, second, third] = keys as [string, string, string];
    expect(first < second).toBe(true);
    expect(second < third).toBe(true);
    expect(third < "m").toBe(true);
  });

  it("works with nothing pinned yet", () => {
    const [first, second] = planBulkPinOrderKeys(2, []) as [string, string];
    expect(first < second).toBe(true);
  });

  it("falls back to the usual pin when the current keys can't be built on", () => {
    expect(planBulkPinOrderKeys(1, ["not a valid key!"])).toEqual([undefined]);
  });
});
