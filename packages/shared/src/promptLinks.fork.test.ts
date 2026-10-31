import { describe, expect, it } from "vite-plus/test";

import { readThreadLink } from "./promptLinks.ts";

describe("readThreadLink", () => {
  it("reads the thread from a v1 link, ignoring a fragment", () => {
    const id = "0191cdaf-175d-4d3c-a1c5-55684eb0db7e";
    expect(readThreadLink(`t3-thread://v1/${id}`)).toEqual({ environmentId: null, threadId: id });
    expect(readThreadLink(`t3-thread://v1/${id}#item-3`)).toEqual({
      environmentId: null,
      threadId: id,
    });
    expect(readThreadLink(`T3-Thread://v1/${id}/`)).toEqual({ environmentId: null, threadId: id });
  });

  it("keeps thread IDs raw, as the vault writes them", () => {
    for (const id of [
      "mcp:00f23a02-b745-4264-bf60-2e35f4e1ade8",
      "thread:delegated-task:command%3Amcp%3A0029d62d-633f-4fb2-aedf-1499c2aefc57%3Adelegate-task",
      "calendar-card-1556722494457516073",
    ]) {
      expect(readThreadLink(`t3-thread://v1/${id}`)?.threadId).toBe(id);
    }
  });

  it("reads the environment and thread from a v2 link", () => {
    expect(readThreadLink("t3-thread://v2/75ff2b38-59cc/mcp:00f23a02")).toEqual({
      environmentId: "75ff2b38-59cc",
      threadId: "mcp:00f23a02",
    });
  });

  it("refuses other links and malformed IDs", () => {
    for (const value of [
      "t3-thread://v1/",
      "t3-thread://v1/a/b",
      "t3-thread://v2/env-only",
      "t3-thread://v3/thread-1",
      "t3-thread://v1/has space",
      "t3-thread://v1/<script>",
      `t3-thread://v1/${"a".repeat(513)}`,
      "t3code://threads/env-1/thread-1",
      "https://example.com/v1/thread-1",
      "not a link",
    ]) {
      expect(readThreadLink(value), value).toBeNull();
    }
  });
});
