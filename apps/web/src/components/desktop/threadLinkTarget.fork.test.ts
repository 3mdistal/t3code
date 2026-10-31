import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type KnownThreads, threadLinkTarget } from "./threadLinkTarget";

const here = "env-here" as EnvironmentId;
const remote = "env-remote" as EnvironmentId;
const ref = (environmentId: EnvironmentId, threadId: string): ScopedThreadRef => ({
  environmentId,
  threadId: threadId as ThreadId,
});
const known = (overrides: Partial<KnownThreads> = {}): KnownThreads => ({
  threadRefs: [ref(here, "a"), ref(remote, "b")],
  primaryEnvironmentId: here,
  connectedEnvironmentIds: [here, remote],
  ...overrides,
});
const link = (threadId: string, environmentId: string | null = null) => ({
  environmentId,
  threadId,
});

describe("threadLinkTarget", () => {
  it("opens a listed thread in the environment that lists it", () => {
    expect(threadLinkTarget(link("b"), known(), true)).toEqual(ref(remote, "b"));
    expect(threadLinkTarget(link("a"), known(), true)).toEqual(ref(here, "a"));
  });

  it("prefers this machine when two environments list the thread", () => {
    const threadRefs = [ref(remote, "a"), ref(here, "a")];
    expect(threadLinkTarget(link("a"), known({ threadRefs }), true)).toEqual(ref(here, "a"));
  });

  it("waits for the lists before guessing at an unlisted thread", () => {
    expect(threadLinkTarget(link("archived"), known(), true)).toBeNull();
  });

  it("falls back to this machine, or the only connected environment, for an unlisted thread", () => {
    expect(threadLinkTarget(link("archived"), known(), false)).toEqual(ref(here, "archived"));
    expect(
      threadLinkTarget(
        link("archived"),
        known({ primaryEnvironmentId: null, connectedEnvironmentIds: [remote] }),
        false,
      ),
    ).toEqual(ref(remote, "archived"));
    expect(
      threadLinkTarget(link("archived"), known({ primaryEnvironmentId: null }), false),
    ).toBeNull();
  });

  it("opens a linked environment only while it's connected", () => {
    expect(threadLinkTarget(link("x", remote), known(), true)).toEqual(ref(remote, "x"));
    expect(threadLinkTarget(link("x", "env-gone"), known(), false)).toBeNull();
  });
});
