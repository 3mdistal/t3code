import { describe, expect, it } from "vite-plus/test";

import {
  type BackgroundThreadEntry,
  type BackgroundThreadMemory,
  nextBackgroundThreadAnnouncement,
} from "./backgroundThreadAnnouncement";

const login = (status: BackgroundThreadEntry["status"]): BackgroundThreadEntry => ({
  key: "env:login",
  title: "Fix login redirect",
  status,
});
const docs = (status: BackgroundThreadEntry["status"]): BackgroundThreadEntry => ({
  key: "env:docs",
  title: "Update docs",
  status,
});

function speak(
  frames: ReadonlyArray<{
    readonly threads: ReadonlyArray<BackgroundThreadEntry>;
    readonly open?: string;
  }>,
) {
  let memory: BackgroundThreadMemory = new Map();
  const spoken: string[] = [];
  for (const frame of frames) {
    const result = nextBackgroundThreadAnnouncement(memory, frame.threads, frame.open ?? null);
    memory = result.memory;
    if (result.announcement !== null) spoken.push(result.announcement);
  }
  return spoken;
}

describe("nextBackgroundThreadAnnouncement", () => {
  it("names the thread with the same words the open thread uses", () => {
    expect(
      speak([
        { threads: [login(null)] },
        { threads: [login("approval")] },
        { threads: [login(null)] },
        { threads: [login("input")] },
        { threads: [login("done")] },
        { threads: [login(null)] },
        { threads: [login("failed")] },
      ]),
    ).toEqual([
      "Needs approval: Fix login redirect",
      "Needs your input: Fix login redirect",
      "Done: Fix login redirect",
      "Failed: Fix login redirect",
    ]);
  });

  it("stays quiet for threads it sees for the first time, like on launch or reconnect", () => {
    expect(
      speak([
        { threads: [login("done"), docs("approval")] },
        { threads: [login("done"), docs("approval")] },
        // The environment drops out while it resyncs, then comes back changed.
        { threads: [] },
        { threads: [login("failed"), docs("done")] },
      ]),
    ).toEqual([]);
  });

  it("leaves the open thread to its own announcer", () => {
    expect(
      speak([
        { threads: [login(null), docs(null)], open: "env:login" },
        { threads: [login("done"), docs(null)], open: "env:login" },
        // Switching away from a thread doesn't replay its status.
        { threads: [login("done"), docs(null)], open: "env:docs" },
      ]),
    ).toEqual([]);
  });

  it("speaks threads that change together in one announcement", () => {
    expect(
      speak([
        { threads: [login(null), docs(null)] },
        { threads: [login("done"), docs("approval")] },
      ]),
    ).toEqual(["Done: Fix login redirect. Needs approval: Update docs"]);
  });
});
