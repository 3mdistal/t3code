import { EnvironmentId, planThreadTagChanges, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadKey } from "./entities.ts";
import { hiddenThreadKeys } from "./threadTagFilter.ts";

// fork: thread tags, see FORK.md.

const environmentId = EnvironmentId.make("local");
const thread = (id: string, tags: ReadonlyArray<string>) => ({
  id: ThreadId.make(id),
  tags: [...tags],
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make(id),
  },
});

describe("hiding tagged threads while recording", () => {
  it("hides a thread tagged from the fork's menu or tools, matching the listed spelling", () => {
    const client = thread("client", ["Client X"]);
    // Tagged "client x" from the sidebar: it takes the spelling already in use.
    const { tags } = planThreadTagChanges(
      [],
      client.tags,
      [{ tag: "client x", tagged: true }],
      "typed",
    );
    const threads = [client, thread("tagged", tags), thread("plain", [])];
    const hidden = (hiddenTags: Array<string>) => [
      ...hiddenThreadKeys([{ environmentId, threads, hiddenTags }]),
    ];

    expect(hidden(["Client X"])).toEqual([
      threadKey({ environmentId, threadId: client.id }),
      threadKey({ environmentId, threadId: ThreadId.make("tagged") }),
    ]);
    // Upstream's list matches exact case.
    expect(hidden(["client x"])).toEqual([]);
  });
});
