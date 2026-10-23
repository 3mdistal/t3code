import {
  EnvironmentId,
  EventId,
  MessageId,
  RunId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { createEnvironmentThreadDetailAtoms, sameThreadStructure } from "./threadDetail.ts";
import { mergeOlderHistoryIntoProjection } from "./threadHistoryMerge.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "./threadState.ts";

const later = DateTime.makeUnsafe("2026-06-20T00:00:01.000Z");

const assistant: OrchestrationV2TurnItem = {
  id: TurnItemId.make("item-assistant"),
  threadId: v2ThreadId,
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  startedAt: v2Now,
  completedAt: null,
  updatedAt: v2Now,
  type: "assistant_message",
  messageId: MessageId.make("message-assistant"),
  text: "Hel",
  streaming: true,
};

function withItem(item: OrchestrationV2TurnItem, updatedAt = v2Now) {
  return {
    ...v2Projection,
    turnItems: [item],
    visibleTurnItems: [
      {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: v2ThreadId,
        sourceItemId: item.id,
        item,
      },
    ],
    updatedAt,
  };
}

describe("sameThreadStructure", () => {
  const before = withItem(assistant);

  it("holds through streamed text", () => {
    const next = withItem({ ...assistant, text: "Hello", updatedAt: later }, later);
    expect(sameThreadStructure(before, next)).toBe(true);
  });

  it("sees the item finish streaming", () => {
    const next = withItem({ ...assistant, text: "Hello", streaming: false, status: "completed" });
    expect(sameThreadStructure(before, next)).toBe(false);
  });

  it("sees a new item", () => {
    const next = { ...before, turnItems: [assistant, { ...assistant, id: TurnItemId.make("b") }] };
    expect(sameThreadStructure(before, next)).toBe(false);
  });

  it("sees other fields change on a streaming item", () => {
    const next = withItem({ ...assistant, text: "Hello", title: "Answer" });
    expect(sameThreadStructure(before, next)).toBe(false);
  });

  it("holds through a visit mark", () => {
    const thread = { ...before.thread, lastVisitedAt: later, updatedAt: later };
    expect(sameThreadStructure(before, { ...before, thread })).toBe(true);
  });

  it("sees other thread changes", () => {
    const thread = { ...before.thread, title: "Renamed" };
    expect(sameThreadStructure(before, { ...before, thread })).toBe(false);
  });

  it("sees changes outside the turn items", () => {
    expect(sameThreadStructure(before, { ...before, runs: [] })).toBe(false);
  });
});

describe("lastVisitedAtAtom", () => {
  it("follows a visit mark the quiet thread holds through", () => {
    const projection = withItem(assistant);
    const state = Atom.make(
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(projection) }),
    );
    const details = createEnvironmentThreadDetailAtoms(() => state);
    const ref = { environmentId: EnvironmentId.make("env"), threadId: v2ThreadId };
    const registry = AtomRegistry.make();
    const unmountQuiet = registry.mount(details.quietThreadAtom(ref));
    const unmountVisit = registry.mount(details.lastVisitedAtAtom(ref));
    const quietBefore = registry.get(details.quietThreadAtom(ref));

    const visited = { ...projection, thread: { ...projection.thread, lastVisitedAt: later } };
    registry.set(
      state,
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(visited) }),
    );

    expect(registry.get(details.quietThreadAtom(ref))).toBe(quietBefore);
    expect(registry.get(details.lastVisitedAtAtom(ref))).toBe(later);
    unmountQuiet();
    unmountVisit();
    registry.dispose();
  });
});

describe("quietThreadAtom", () => {
  const ref = { environmentId: EnvironmentId.make("environment-1"), threadId: v2ThreadId };

  function setup(initial: OrchestrationV2ThreadProjection) {
    const stateAtom = Atom.make(
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(initial) }),
    );
    const quietAtom = createEnvironmentThreadDetailAtoms(() => stateAtom).quietThreadAtom(ref);
    const registry = AtomRegistry.make();
    registry.mount(quietAtom);
    return {
      read: () => registry.get(quietAtom),
      [Symbol.dispose]: () => registry.dispose(),
      push: (projection: OrchestrationV2ThreadProjection | null) =>
        registry.set(
          stateAtom,
          AsyncResult.success({
            ...EMPTY_ENVIRONMENT_THREAD_STATE,
            data: Option.fromNullishOr(projection),
          }),
        ),
    };
  }

  it("keeps the same value through streamed text", () => {
    const thread = setup(withItem(assistant));
    const first = thread.read();
    thread.push(withItem({ ...assistant, text: "Hello", updatedAt: later }, later));
    thread.push(withItem({ ...assistant, text: "Hello there", updatedAt: later }, later));
    expect(thread.read()).toBe(first);
  });

  it("passes a structure change on", () => {
    const thread = setup(withItem(assistant));
    const first = thread.read();
    thread.push(withItem({ ...assistant, text: "Hello", updatedAt: later }, later));
    thread.push(withItem({ ...assistant, text: "Hello", status: "completed", streaming: false }));
    const next = thread.read();
    expect(next).not.toBe(first);
    expect(next?.projection.turnItems[0]).toMatchObject({ status: "completed", streaming: false });
  });

  it("discards structure held before the thread resets", () => {
    const initial = withItem(assistant);
    using thread = setup(initial);
    const first = thread.read();
    thread.push(replaceItem(initial, { ...assistant, text: "Hello" }));
    expect(thread.read()).toBe(first);
    thread.push(null);
    expect(thread.read()).toBeNull();
    const reset = withItem({ ...assistant, title: "Restored", text: "New snapshot" });
    thread.push(reset);
    expect(thread.read()).not.toBe(first);
    expect(thread.read()?.projection.turnItems[0]).toMatchObject({ title: "Restored" });
    thread.push(replaceItem(reset, { ...assistant, title: "Restored", text: "More text" }));
    expect(thread.read()?.projection.turnItems[0]).toMatchObject({ title: "Restored" });
  });

  it("leaves out the fields that streaming moves", () => {
    const thread = setup(withItem(assistant));
    const projection = thread.read()?.projection;
    expect(projection).not.toHaveProperty("updatedAt");
    expect(projection?.thread).not.toHaveProperty("updatedAt");
    expect(projection?.thread).not.toHaveProperty("lastVisitedAt");
    expect(projection?.turnItems[0]).not.toHaveProperty("text");
    expect(projection?.turnItems[0]).not.toHaveProperty("updatedAt");
    expect(projection?.visibleTurnItems[0]?.item).not.toHaveProperty("text");
    expect(projection?.visibleTurnItems[0]?.item).toMatchObject({
      messageId: assistant.messageId,
      streaming: true,
    });
  });
});

it.each([100, 1000, 10000])(
  "only compares replaced entries in a reducer delta among %i items",
  (size) => {
    let slotReads = 0;
    const countReads = <T>(items: ReadonlyArray<T>): ReadonlyArray<T> =>
      new Proxy(items, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) slotReads++;
          return Reflect.get(target, key, receiver);
        },
      });
    const items = Array.from({ length: size }, (_, index) => ({
      ...assistant,
      id: TurnItemId.make(`item-${index}`),
      ordinal: index,
    }));
    const before = {
      ...v2Projection,
      turnItems: countReads(items),
      visibleTurnItems: countReads(
        items.map((item, position) => ({
          item,
          position,
          visibility: "local" as const,
          sourceThreadId: v2ThreadId,
          sourceItemId: item.id,
        })),
      ),
    };
    const next = applyOrchestrationV2ProjectionEvent(before, {
      id: EventId.make("text-delta"),
      type: "turn-item.updated",
      threadId: v2ThreadId,
      occurredAt: later,
      payload: { ...items.at(-1)!, text: "Hello", updatedAt: later },
    });
    slotReads = 0;

    expect(sameThreadStructure(before, next!)).toBe(true);
    expect(slotReads).toBeLessThanOrEqual(2);
  },
);

function replaceItem(projection: OrchestrationV2ThreadProjection, item: OrchestrationV2TurnItem) {
  return applyOrchestrationV2ProjectionEvent(projection, {
    id: EventId.make(`event-${item.id}`),
    type: "turn-item.updated",
    threadId: v2ThreadId,
    occurredAt: item.updatedAt,
    payload: item,
  })!;
}

describe("reducer structure comparisons", () => {
  it.each(["assistant_message", "reasoning"] as const)(
    "keeps %s text quiet but observes completion and run changes",
    (type) => {
      const item = { ...assistant, type };
      const initial = withItem(item);
      const streamed = replaceItem(initial, { ...item, text: "Hello", updatedAt: later });
      const completed = replaceItem(streamed, {
        ...item,
        status: "completed",
        streaming: false,
        text: "Hello there",
      });
      const movedRun = replaceItem(completed, { ...item, runId: RunId.make("another-run") });

      expect(sameThreadStructure(initial, streamed)).toBe(true);
      expect(sameThreadStructure(streamed, completed)).toBe(false);
      expect(sameThreadStructure(completed, movedRun)).toBe(false);
      expect(streamed.visibleTurnItems[0]?.item).toMatchObject({ text: "Hello" });
      expect(initial.turnItems[0]).toBe(item);
      expect(initial.visibleTurnItems[0]?.item).toMatchObject({ text: "Hel" });
    },
  );

  it("compares all changes when the reader skips events in a batch", () => {
    const initial = mergeOlderHistoryIntoProjection(withItem(assistant), [
      {
        ...withItem(assistant).visibleTurnItems[0]!,
        sourceItemId: TurnItemId.make("older"),
        item: { ...assistant, id: TurnItemId.make("older"), ordinal: 0 },
      },
    ]);
    const older = initial.turnItems.find((item) => item.id === "older")!;
    const completed = replaceItem(initial, { ...older, status: "completed" });
    const streamed = replaceItem(completed, { ...assistant, text: "Hello", updatedAt: later });

    expect(sameThreadStructure(completed, streamed)).toBe(true);
    expect(sameThreadStructure(initial, streamed)).toBe(false);
    expect(
      sameThreadStructure(initial, {
        ...streamed,
        turnItems: initial.turnItems,
        visibleTurnItems: streamed.visibleTurnItems.slice(),
      }),
    ).toBe(false);
  });

  it("compares snapshot resets and history merges without a replacement hint", () => {
    const initial = withItem(assistant);
    const streamed = replaceItem(initial, { ...assistant, text: "Hello", updatedAt: later });
    const snapshot = {
      ...streamed,
      turnItems: streamed.turnItems.map((item) => ({ ...item, title: "Restored" })),
      visibleTurnItems: streamed.visibleTurnItems.map((row) => ({ ...row })),
    };
    const older = { ...assistant, id: TurnItemId.make("older"), ordinal: 0 };
    const history = mergeOlderHistoryIntoProjection(streamed, [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: v2ThreadId,
        sourceItemId: older.id,
        item: older,
      },
    ]);
    const next = replaceItem(history, { ...assistant, text: "Hello there", updatedAt: later });

    expect(sameThreadStructure(initial, snapshot)).toBe(false);
    expect(sameThreadStructure(streamed, history)).toBe(false);
    expect(sameThreadStructure(history, next)).toBe(true);
    expect(next.visibleTurnItems.map((row) => [row.item.id, row.position])).toEqual([
      [older.id, 0],
      [assistant.id, 1],
    ]);
  });
});
