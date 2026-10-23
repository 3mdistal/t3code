import {
  EventId,
  MessageId,
  ThreadId,
  RunId,
  TurnItemId,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";
import {
  coalesceLiveUpdatedEvents,
  coalesceThreadLiveStream,
  makeThreadLiveEventCoalescer,
} from "./ThreadLiveEventCoalescer.ts";

type ThreadEvent = Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "event" }>;
const threadId = ThreadId.make("thread-coalescer-test");
const runId = RunId.make("run-coalescer-test");
const now = DateTime.makeUnsafe("2026-01-01T00:00:01.000Z");
const encodeEvent = JSON.stringify;

function makeToolActivity(
  sequence: number,
  options: {
    readonly kind?: "tool.updated" | "tool.completed";
    readonly toolCallId?: string;
    readonly turnId?: RunId;
  } = {},
): ThreadEvent {
  const itemRunId = options.turnId ?? runId;
  const status = options.kind === "tool.completed" ? "completed" : "running";
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`event-${sequence}`),
      type: "turn-item.updated",
      threadId,
      runId: itemRunId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(options.toolCallId ?? "call-edit"),
        type: "command_execution",
        threadId,
        runId: itemRunId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status,
        title: "Editing app.ts",
        startedAt: now,
        completedAt: status === "completed" ? now : null,
        updatedAt: now,
        input: "echo app.ts",
        output: `output-${sequence}`,
      },
    },
  };
}

function makeMessage(sequence: number, text = "Still working"): ThreadEvent {
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`event-${sequence}`),
      type: "message.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: MessageId.make(`message-${sequence}`),
        threadId,
        runId,
        nodeId: null,
        createdBy: "agent",
        creationSource: "provider",
        role: "assistant",
        text,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    },
  };
}

function makeStreamingMessage(
  sequence: number,
  options: {
    readonly id?: string;
    readonly text?: string;
    readonly streaming?: boolean;
    readonly role?: "assistant" | "user";
  } = {},
): ThreadEvent {
  const message = makeMessage(sequence, options.text ?? `text-${sequence}`);
  if (message.event.type !== "message.updated") throw new Error("Expected message");
  return {
    ...message,
    event: {
      ...message.event,
      payload: {
        ...message.event.payload,
        id: MessageId.make(options.id ?? "message"),
        streaming: options.streaming ?? true,
        role: options.role ?? "assistant",
      },
    },
  };
}

function makeTextItem(
  sequence: number,
  options: {
    readonly id?: string;
    readonly text?: string;
    readonly type?: "assistant_message" | "reasoning";
    readonly status?: OrchestrationV2TurnItem["status"];
    readonly streaming?: boolean;
  } = {},
): ThreadEvent {
  const tool = makeToolActivity(sequence);
  if (tool.event.type !== "turn-item.updated" || tool.event.payload.type !== "command_execution")
    throw new Error("Expected command item");
  const { input: _input, output: _output, ...base } = tool.event.payload;
  return {
    ...tool,
    event: {
      ...tool.event,
      payload: {
        ...base,
        id: TurnItemId.make(options.id ?? "item"),
        type: options.type ?? "assistant_message",
        messageId: MessageId.make("message"),
        text: options.text ?? `text-${sequence}`,
        status: options.status ?? "running",
        streaming: options.streaming ?? true,
      },
    },
  };
}

function sequences(events: ReadonlyArray<{ readonly kind: string; readonly sequence?: number }>) {
  return events.map((event) => (event.kind === "event" ? event.sequence : event.kind));
}

describe("ThreadLiveEventCoalescer", () => {
  it("coalesces only calls with a stable toolCallId", () => {
    const events = [
      makeToolActivity(1, { toolCallId: "call-a" }),
      makeToolActivity(2, { toolCallId: "call-b" }),
      makeToolActivity(3, { toolCallId: "call-a" }),
    ];

    expect(coalesceLiveUpdatedEvents(events).map((event) => event.sequence)).toEqual([2, 3]);
  });

  it("does not coalesce stable tool calls across turns", () => {
    const events = [
      makeToolActivity(1, { turnId: RunId.make("turn-old") }),
      makeToolActivity(2, { turnId: RunId.make("turn-new") }),
    ];

    expect(coalesceLiveUpdatedEvents(events).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("flushes a stable update run before a completion boundary", () => {
    const events = [
      makeToolActivity(1),
      makeToolActivity(2),
      makeToolActivity(3, { kind: "tool.completed" }),
      makeToolActivity(4),
    ];

    expect(coalesceLiveUpdatedEvents(events).map((event) => event.sequence)).toEqual([2, 3, 4]);
  });

  it("coalesces paired assistant messages/items and interleaved reasoning/tools by identity", () => {
    const events = [
      makeStreamingMessage(1, { id: "shared" }),
      makeTextItem(2, { id: "shared" }),
      makeTextItem(3, { id: "reasoning", type: "reasoning" }),
      makeToolActivity(4, { toolCallId: "tool" }),
      makeTextItem(5, { id: "unique" }),
      makeStreamingMessage(6, { id: "shared" }),
      makeTextItem(7, { id: "shared" }),
      makeTextItem(8, { id: "reasoning", type: "reasoning" }),
      makeToolActivity(9, { toolCallId: "tool" }),
    ];
    const result = coalesceLiveUpdatedEvents(events);
    expect(sequences(result)).toEqual([5, 6, 7, 8, 9]);
    expect(result).toEqual(events.slice(4));
  });

  it("preserves message, text and tool completions and non-streaming boundaries", () => {
    for (const boundary of [
      makeStreamingMessage(3, { streaming: false }),
      makeStreamingMessage(3, { role: "user" }),
      makeTextItem(3, { streaming: false }),
      ...(["completed", "failed", "cancelled"] as const).map((status) =>
        makeTextItem(3, { status }),
      ),
      makeToolActivity(3, { kind: "tool.completed" }),
      makeMessage(3),
    ]) {
      const events = [
        makeStreamingMessage(1),
        makeStreamingMessage(2),
        boundary,
        makeStreamingMessage(4),
        makeStreamingMessage(5),
      ];
      expect(coalesceLiveUpdatedEvents(events)).toEqual([events[1], boundary, events[4]]);
    }
  });

  it("does not mix message/item identities, item types, threads or runs", () => {
    const first = makeStreamingMessage(1, { id: "same" });
    const events = [
      first,
      makeTextItem(2, { id: "same" }),
      makeTextItem(3, { id: "same", type: "reasoning" }),
      { ...first, sequence: 4, event: { ...first.event, runId: RunId.make("other-run") } },
      { ...first, sequence: 5, event: { ...first.event, threadId: ThreadId.make("other-thread") } },
    ];
    expect(coalesceLiveUpdatedEvents(events)).toEqual(events);
  });

  it("preserves assistant-message identity changes as insertion-order boundaries", () => {
    const events = [
      makeStreamingMessage(1, { id: "message-a" }),
      makeTextItem(2, { id: "item-a" }),
      makeStreamingMessage(3, { id: "message-b" }),
      makeTextItem(4, { id: "item-b" }),
      makeStreamingMessage(5, { id: "message-a" }),
      makeTextItem(6, { id: "item-a" }),
    ];
    expect(coalesceLiveUpdatedEvents(events)).toEqual(events);
  });

  it.effect("flushes text within 50ms of the first update under sustained offers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer();
        yield* coalescer.offerAll([makeStreamingMessage(1), makeTextItem(2)]);
        yield* TestClock.adjust("20 millis");
        yield* coalescer.offerAll([makeStreamingMessage(3), makeTextItem(4)]);
        yield* TestClock.adjust("20 millis");
        yield* coalescer.offerAll([makeStreamingMessage(5), makeTextItem(6)]);
        yield* TestClock.adjust("10 millis");
        const pull = yield* Stream.toPull(coalescer.stream);
        expect(sequences(yield* pull)).toEqual([5, 6]);
        yield* coalescer.offerAll([makeStreamingMessage(7), makeTextItem(8)]);
        yield* TestClock.adjust("50 millis");
        expect(sequences(yield* pull)).toEqual([7, 8]);
        yield* coalescer.end;
        yield* pull.pipe(Effect.result);
        expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
      }),
    ),
  );

  it.effect("flushes before synchronization without coalescing across it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer();
        const events = [
          makeStreamingMessage(1),
          makeTextItem(2),
          makeStreamingMessage(3),
          makeTextItem(4),
        ];
        yield* coalescer.offerAll([
          ...events,
          { kind: "synchronized" },
          makeStreamingMessage(5),
          makeStreamingMessage(6),
        ]);
        yield* coalescer.end;
        const result = yield* Stream.runCollect(coalescer.stream);
        expect(sequences(result)).toEqual([3, 4, "synchronized", 6]);
        expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
      }),
    ),
  );

  it.effect("retains the exact serialized budget for surviving and unacknowledged text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer();
        const events = [1, 2, 3].map((sequence) =>
          makeStreamingMessage(sequence, { text: "é".repeat(sequence * 100) }),
        );
        yield* coalescer.offerAll(events);
        expect(yield* coalescer.usage).toEqual({
          retainedItems: 3,
          retainedSerializedBytes: events.reduce(
            (sum, event) => sum + Buffer.byteLength(encodeEvent(event)),
            0,
          ),
        });
        yield* TestClock.adjust("50 millis");
        const expectedUsage = {
          retainedItems: 1,
          retainedSerializedBytes: Buffer.byteLength(encodeEvent(events[2])),
        };
        expect(yield* coalescer.usage).toEqual(expectedUsage);
        const pull = yield* Stream.toPull(coalescer.stream);
        expect(sequences(yield* pull)).toEqual([3]);
        expect(yield* coalescer.usage).toEqual(expectedUsage);
        yield* coalescer.end;
        yield* pull.pipe(Effect.result);
        expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
      }),
    ),
  );

  it.effect("does not drop unique text items at the pending batch cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer();
        const events = Array.from({ length: 513 }, (_, index) =>
          makeTextItem(index + 1, { id: `item-${index}` }),
        );
        yield* coalescer.offerAll(events);
        yield* coalescer.end;
        expect(yield* Stream.runCollect(coalescer.stream)).toEqual(events);
      }),
    ),
  );

  it("can resume after every surviving cursor without losing the final state", () => {
    const events = [
      makeStreamingMessage(1),
      makeTextItem(2),
      makeTextItem(3, { id: "unique", type: "reasoning" }),
      makeStreamingMessage(4),
      makeTextItem(5),
      makeStreamingMessage(6, { streaming: false, text: "final answer" }),
      makeTextItem(7, { streaming: false, status: "completed", text: "final answer" }),
    ];
    const latestStates = (input: ReadonlyArray<ThreadEvent>) =>
      Object.fromEntries(
        input.map(({ event }) => [
          `${event.type}:${"id" in event.payload ? event.payload.id : ""}`,
          event.payload,
        ]),
      );
    const survivors = coalesceLiveUpdatedEvents(events);
    expect(sequences(survivors)).toEqual([3, 4, 5, 6, 7]);
    for (let index = 0; index < survivors.length; index += 1) {
      const received = survivors.slice(0, index + 1);
      const cursor = received.at(-1)!.sequence;
      const resumed = coalesceLiveUpdatedEvents(events.filter((event) => event.sequence > cursor));
      expect(latestStates([...received, ...resumed])).toEqual(latestStates(events));
    }
  });

  it.effect("reduces growing paired/interleaved states queued across fixed windows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer();
        const input: Array<ThreadEvent> = [];
        const expected: Array<ThreadEvent> = [];
        for (let window = 0; window < 20; window += 1) {
          for (let update = 0; update < 5; update += 1) {
            const text = "x".repeat((window * 5 + update + 1) * 100);
            const pair = [
              makeStreamingMessage(input.length + 1, { text }),
              makeTextItem(input.length + 2, { text }),
              makeTextItem(input.length + 3, { type: "reasoning", id: "reasoning", text }),
            ];
            input.push(...pair);
            yield* coalescer.offerAll(pair);
            if (update === 4) expected.push(...pair);
            yield* TestClock.adjust("10 millis");
          }
        }
        const completions = [
          makeStreamingMessage(input.length + 1, { streaming: false, text: "final answer" }),
          makeTextItem(input.length + 2, {
            status: "completed",
            streaming: false,
            text: "final answer",
          }),
        ];
        input.push(...completions);
        expected.push(...completions);
        yield* coalescer.offerAll(completions);
        yield* coalescer.end;
        const serializedBytes = (events: ReadonlyArray<ThreadEvent>) =>
          events.reduce((sum, event) => sum + Buffer.byteLength(encodeEvent(event)), 0);
        expect(yield* coalescer.usage).toEqual({
          retainedItems: 62,
          retainedSerializedBytes: serializedBytes(expected),
        });
        const result = yield* Stream.runCollect(coalescer.stream);
        expect(result).toEqual(expected);
        expect(input).toHaveLength(302);
        expect(serializedBytes(expected)).toBeLessThan(serializedBytes(input) * 0.22);
        expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
      }),
    ),
  );

  it.effect("preserves every pair when producer updates are already 50ms apart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer();
        const input: Array<ThreadEvent> = [];
        for (let index = 0; index < 10; index += 1) {
          const text = "x".repeat((index + 1) * 100);
          const pair = [
            makeStreamingMessage(index * 2 + 1, { text }),
            makeTextItem(index * 2 + 2, { text }),
          ];
          input.push(...pair);
          yield* coalescer.offerAll(pair);
          yield* TestClock.adjust("50 millis");
        }
        yield* coalescer.end;
        expect(yield* Stream.runCollect(coalescer.stream)).toEqual(input);
      }),
    ),
  );

  it.effect("fails rather than bypassing the byte budget for pending text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = makeStreamingMessage(1, { text: "x".repeat(1_000) });
        const coalescer = yield* makeThreadLiveEventCoalescer({
          maxSerializedBytes: Buffer.byteLength(encodeEvent(first)),
        });
        yield* coalescer.offer(first);
        const result = yield* coalescer
          .offer(makeStreamingMessage(2, { text: "x".repeat(2_000) }))
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        yield* coalescer.closed;
        expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
      }),
    ),
  );

  it.effect("keeps the flush timer alive when an offer's shorter scope closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer({ coalesceWindow: "50 millis" });
        yield* Effect.scoped(coalescer.offer(makeToolActivity(1)));
        yield* TestClock.adjust("50 millis");
        const items = yield* coalescer.stream.pipe(Stream.take(1), Stream.runCollect);
        expect(items.map((item) => (item.kind === "event" ? item.sequence : item.kind))).toEqual([
          1,
        ]);
      }),
    ),
  );

  it.effect("keeps an unacknowledged batch charged and clears later events on overflow", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer({ maxItems: 3 });
        const first = makeMessage(1, "é".repeat(1_024));
        yield* coalescer.offer(first);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const pull = yield* Stream.toPull(coalescer.stream);
            const batch = yield* pull;
            expect(batch.map((item) => (item.kind === "event" ? item.sequence : null))).toEqual([
              1,
            ]);
            yield* coalescer.offer(makeMessage(2));
            yield* coalescer.offer(makeToolActivity(3));
            expect((yield* coalescer.usage).retainedItems).toBe(3);

            const overflow = yield* coalescer
              .offer(makeToolActivity(4, { kind: "tool.completed" }))
              .pipe(Effect.result);
            expect(overflow._tag).toBe("Failure");
            yield* coalescer.closed;
            expect(yield* coalescer.usage).toEqual({
              retainedItems: 1,
              retainedSerializedBytes: Buffer.byteLength(encodeEvent(first)),
            });
          }),
        );
        expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
      }),
    ),
  );
});

it.effect("flushes the last update before a finite source ends", () =>
  Effect.gen(function* () {
    const result = yield* Stream.make(makeToolActivity(1), makeToolActivity(2)).pipe(
      coalesceThreadLiveStream,
      Stream.runCollect,
    );
    expect(result.map((item) => (item.kind === "event" ? item.sequence : null))).toEqual([2]);
  }),
);

it.effect("propagates an upstream failure instead of leaving the subscriber waiting", () =>
  Effect.gen(function* () {
    const result = yield* Stream.fail("source stopped").pipe(
      coalesceThreadLiveStream,
      Stream.runCollect,
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure).toBe("source stopped");
  }),
);
