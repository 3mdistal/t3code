import { EnvironmentId, ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createThreadNotificationGate } from "./ThreadNotificationCoordinator.logic";
import {
  announcedRequest,
  createPendingChildRequestsAtom,
  newerAttentionRequest,
  threadAttentionKey,
  type AttentionRequest,
} from "./ThreadAttentionRequests.fork";

const request = (id: string, createdAt: number): AttentionRequest => ({ id, createdAt });

describe("threadAttentionKey", () => {
  it.each([
    ["approval", "run:approval:b"],
    ["input", "run:input:b"],
    ["failed", "run:failed"],
    ["limited", "run:limited"],
    ["request", "run:request"],
  ] as const)("keys %s", (status, key) => {
    expect(threadAttentionKey("run", status, request("b", 2))).toBe(key);
  });

  it("is null when the thread needs nothing", () => {
    expect(threadAttentionKey("run", "ready", request("b", 2))).toBeNull();
    expect(threadAttentionKey("run", "working", null)).toBeNull();
  });
});

describe("attention for requests within one run", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function alerts() {
    const notify = vi.fn();
    const gate = createThreadNotificationGate<string>(notify);
    let prior: { attention: string | null; settled: false; completedAt: null } = {
      attention: null,
      settled: false,
      completedAt: null,
    };
    let held: AttentionRequest | null = null;
    const pending = (...requests: AttentionRequest[]) => {
      const newest = requests.reduce<AttentionRequest | null>(
        (best, next) => newerAttentionRequest(best, next),
        null,
      );
      held = announcedRequest(held, newest);
      const next = {
        attention: threadAttentionKey("run", newest === null ? "working" : "approval", held),
        settled: false as const,
        completedAt: null,
      };
      gate.observe("thread", prior, next, { archived: false, quiet: false });
      prior = next;
    };
    return { notify, pending };
  }

  it("alerts for a new request replacing the old in a single update", () => {
    const { notify, pending } = alerts();
    pending(request("a", 1));
    expect(notify).toHaveBeenCalledTimes(1);
    pending(request("b", 2));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("alerts for a new request arriving while an older one still waits", () => {
    const { notify, pending } = alerts();
    pending(request("a", 1));
    pending(request("a", 1), request("b", 2));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("does not alert again when the newest is answered and an older one still waits", () => {
    const { notify, pending } = alerts();
    pending(request("a", 1), request("b", 2));
    expect(notify).toHaveBeenCalledTimes(1);
    pending(request("a", 1));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not alert again for the same request on a later update", () => {
    const { notify, pending } = alerts();
    pending(request("a", 1));
    pending(request("a", 1));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("alerts for a request after the last one cleared", () => {
    const { notify, pending } = alerts();
    pending(request("a", 1));
    pending();
    pending(request("b", 2));
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe("createPendingChildRequestsAtom", () => {
  const LOCAL = EnvironmentId.make("local");
  const LINKED = EnvironmentId.make("linked");
  const PARENT = ThreadId.make("parent");
  const LATER_PARENT = ThreadId.make("later-parent");
  const CHILD = ThreadId.make("child");
  const SIDE_CHAT = ThreadId.make("side-chat");
  const TASK = ThreadId.make("task");

  const shell = (
    id: ThreadId,
    pending: { id: string; kind: string; at: number } | null,
    sideChat = false,
  ) =>
    ({
      id,
      lineage: { sideChat },
      pendingRuntimeRequest:
        pending === null
          ? null
          : {
              id: pending.id,
              kind: pending.kind,
              createdAt: DateTime.makeUnsafe(pending.at),
            },
    }) as unknown as OrchestrationV2ThreadShell;

  function setup() {
    const flags = Atom.make(new Map<ThreadId, "approval" | "user_input">());
    const noFlags = Atom.make(new Map<ThreadId, "approval" | "user_input">());
    const children = Atom.make<
      ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ThreadId }>
    >([]);
    const local = Atom.make(new Map<ThreadId, OrchestrationV2ThreadShell>());
    const linked = Atom.make(new Map<ThreadId, OrchestrationV2ThreadShell>());
    const childReads = vi.fn();
    const atom = createPendingChildRequestsAtom({
      pendingSubagentRequestsAtom: (environmentId) => (environmentId === LOCAL ? flags : noFlags),
      childThreadInputsAtom: () => {
        childReads();
        return children;
      },
      environmentThreadIndexAtom: (environmentId) => (environmentId === LOCAL ? local : linked),
    })(LOCAL);
    const registry = AtomRegistry.make();
    const unmount = registry.subscribe(atom, () => undefined, { immediate: true });
    const setIndex = (
      environmentId: EnvironmentId,
      ...threads: ReadonlyArray<OrchestrationV2ThreadShell>
    ) =>
      registry.set(
        environmentId === LOCAL ? local : linked,
        new Map(threads.map((thread) => [thread.id, thread] as const)),
      );
    return {
      registry,
      atom,
      flags,
      children,
      childReads,
      setIndex,
      [Symbol.dispose]: () => {
        unmount();
        registry.dispose();
      },
    };
  }

  it("does no child work while nothing is flagged", () => {
    using app = setup();
    expect(app.registry.get(app.atom).size).toBe(0);
    expect(app.childReads).not.toHaveBeenCalled();
  });

  it("names the newest request among a flagged parent's children", () => {
    using app = setup();
    app.setIndex(LOCAL, shell(CHILD, { id: "local-approval", kind: "command", at: 1 }));
    app.setIndex(LINKED, shell(TASK, { id: "linked-approval", kind: "command", at: 2 }));
    app.registry.set(app.children, [
      { environmentId: LOCAL, id: CHILD },
      { environmentId: LINKED, id: TASK },
    ]);
    app.registry.set(app.flags, new Map([[PARENT, "approval" as const]]));
    expect(app.registry.get(app.atom).get(PARENT)).toEqual({
      id: "linked-approval",
      createdAt: 2,
    });
  });

  it("sees a linked task's next request though the flag and child list are unchanged", () => {
    using app = setup();
    app.setIndex(LINKED, shell(TASK, { id: "first", kind: "command", at: 1 }));
    app.registry.set(app.children, [{ environmentId: LINKED, id: TASK }]);
    app.registry.set(app.flags, new Map([[PARENT, "approval" as const]]));
    expect(app.registry.get(app.atom).get(PARENT)?.id).toBe("first");
    app.setIndex(LINKED, shell(TASK, { id: "second", kind: "command", at: 2 }));
    expect(app.registry.get(app.atom).get(PARENT)?.id).toBe("second");
  });

  it("keeps subagent questions out but counts side chat questions", () => {
    using app = setup();
    app.setIndex(
      LOCAL,
      shell(CHILD, { id: "subagent-question", kind: "user_input", at: 9 }),
      shell(SIDE_CHAT, { id: "side-chat-question", kind: "user_input", at: 1 }, true),
    );
    app.registry.set(app.children, [
      { environmentId: LOCAL, id: CHILD },
      { environmentId: LOCAL, id: SIDE_CHAT },
    ]);
    app.registry.set(app.flags, new Map([[PARENT, "user_input" as const]]));
    expect(app.registry.get(app.atom).get(PARENT)?.id).toBe("side-chat-question");
  });

  it("keeps the same map while the requests are unchanged, so nothing re-observes", () => {
    using app = setup();
    const child = shell(CHILD, { id: "approval", kind: "command", at: 1 });
    app.setIndex(LOCAL, child);
    app.registry.set(app.children, [{ environmentId: LOCAL, id: CHILD }]);
    app.registry.set(app.flags, new Map([[PARENT, "approval" as const]]));
    const before = app.registry.get(app.atom);
    app.setIndex(LOCAL, { ...child, title: "Renamed" } as OrchestrationV2ThreadShell);
    expect(app.registry.get(app.atom)).toBe(before);
  });

  it("drops a parent once it is no longer flagged", () => {
    using app = setup();
    app.setIndex(LOCAL, shell(CHILD, { id: "approval", kind: "command", at: 1 }));
    app.registry.set(app.children, [{ environmentId: LOCAL, id: CHILD }]);
    app.registry.set(
      app.flags,
      new Map([
        [PARENT, "approval" as const],
        [LATER_PARENT, "approval" as const],
      ]),
    );
    expect(app.registry.get(app.atom).size).toBe(2);
    app.registry.set(app.flags, new Map());
    expect(app.registry.get(app.atom).size).toBe(0);
  });
});
