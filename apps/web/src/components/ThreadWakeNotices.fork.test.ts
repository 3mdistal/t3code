import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import { ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createThreadNotificationGate } from "./ThreadNotificationCoordinator.logic";
import {
  WAKE_CANCELLED_NOTICE_TITLE,
  createThreadWakeNotices,
  type WakeNoticeItems,
  type WakeNoticeShell,
} from "./ThreadWakeNotices.fork";

type Row = OrchestrationV2ThreadProjection["visibleTurnItems"][number];

const at = (seconds: number) => DateTime.makeUnsafe(1_800_000_000_000 + seconds * 1_000);

const THREAD = ThreadId.make("thread");
const OTHER = ThreadId.make("other");

const idle = (overrides: Partial<WakeNoticeShell> = {}): WakeNoticeShell => ({
  status: "completed",
  activeRunId: null,
  itemCount: 1,
  updatedAt: at(0),
  latestRunStopRequested: false,
  archivedAt: null,
  deletedAt: null,
  pendingBackgroundTasks: [],
  ...overrides,
});

const awaitedTask = {
  id: "task",
  kind: "command",
  awaited: true,
} as unknown as NonNullable<WakeNoticeShell["pendingBackgroundTasks"]>[number];

const notice = (
  id: string,
  updatedAtSeconds: number,
  overrides: { title?: string; visibility?: Row["visibility"]; source?: ThreadId } = {},
): Row =>
  ({
    position: 0,
    visibility: overrides.visibility ?? "local",
    sourceThreadId: overrides.source ?? THREAD,
    sourceItemId: id,
    item: {
      id,
      type: "system_notice",
      title: overrides.title ?? WAKE_CANCELLED_NOTICE_TITLE,
      message: "Lost.",
      updatedAt: at(updatedAtSeconds),
    },
  }) as unknown as Row;

function harness() {
  const reads: Array<{
    readonly threadId: ThreadId;
    readonly resolve: (items: WakeNoticeItems | null) => void;
    readonly reject: (cause: unknown) => void;
  }> = [];
  const notify = vi.fn();
  const notices = createThreadWakeNotices({
    read: (threadId) =>
      new Promise<WakeNoticeItems | null>((resolve, reject) => {
        reads.push({ threadId, resolve, reject });
      }),
    notify,
  });
  // Lets the read's promise chain run without advancing any timer.
  const answer = async (items: WakeNoticeItems | null, index = reads.length - 1) => {
    reads[index]!.resolve(items);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { notices, notify, reads, answer };
}

describe("createThreadWakeNotices", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("alerts once for a notice appended to a parked thread", async () => {
    const { notices, notify, reads, answer } = harness();
    notices.observe(THREAD, idle({ pendingBackgroundTasks: [awaitedTask] }));
    expect(reads).toEqual([]);
    notices.observe(
      THREAD,
      idle({ itemCount: 2, updatedAt: at(5), pendingBackgroundTasks: [awaitedTask] }),
    );
    expect(reads.map((read) => read.threadId)).toEqual([THREAD]);
    await answer([notice("notice", 5)]);
    expect(notify.mock.calls).toEqual([[THREAD]]);
    // The retried write keeps its id and a later unrelated item finds nothing new.
    notices.observe(
      THREAD,
      idle({ itemCount: 3, updatedAt: at(6), pendingBackgroundTasks: [awaitedTask] }),
    );
    await answer([notice("notice", 6)]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  const running = { status: "running" as const, activeRunId: "run" as never };
  it.each([
    ["items streaming in a run", running, { ...running, itemCount: 2 }],
    ["the checkpoint that ends a run", running, { itemCount: 2 }],
    ["a run that starts", {}, { ...running, itemCount: 2 }],
    ["an update with no new items or lost work", {}, { updatedAt: at(9) }],
    ["a failed run", { status: "failed" as const }, { status: "failed" as const, itemCount: 2 }],
    ["fewer items", { itemCount: 5 }, { itemCount: 4 }],
  ])("does not read for %s", (_label, before, after) => {
    const { notices, reads } = harness();
    notices.observe(THREAD, idle(before));
    notices.observe(THREAD, idle(after));
    expect(reads).toEqual([]);
  });

  it("reads when awaited work is lost but not for other roster changes", () => {
    const { notices, reads } = harness();
    const devServer = { ...awaitedTask, awaited: undefined };
    notices.observe(THREAD, idle({ pendingBackgroundTasks: [devServer] }));
    notices.observe(THREAD, idle({ pendingBackgroundTasks: [] }));
    expect(reads).toEqual([]);
    notices.observe(THREAD, idle({ pendingBackgroundTasks: [awaitedTask] }));
    expect(reads).toEqual([]);
    notices.observe(THREAD, idle({ pendingBackgroundTasks: [] }));
    expect(reads).toHaveLength(1);
  });

  it("ignores old, inherited and unrelated notices", async () => {
    const { notices, notify, answer } = harness();
    notices.observe(THREAD, idle({ updatedAt: at(10) }));
    notices.observe(THREAD, idle({ itemCount: 2, updatedAt: at(20) }));
    await answer([
      notice("historical", 10),
      notice("older", 3),
      notice("forked", 15, { visibility: "inherited" }),
      notice("from-parent", 15, { source: OTHER }),
      notice("synthetic", 15, { visibility: "synthetic" }),
      notice("other-notice", 15, { title: "Context compacted" }),
    ]);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    ["archived", { archivedAt: at(7) }],
    ["deleted", { deletedAt: at(7) }],
    ["stopped", { latestRunStopRequested: true }],
  ])("stays quiet when the thread is %s by the time the read returns", async (_label, quiet) => {
    const { notices, notify, answer } = harness();
    notices.observe(THREAD, idle());
    notices.observe(THREAD, idle({ itemCount: 2, updatedAt: at(5) }));
    notices.observe(THREAD, idle({ itemCount: 2, updatedAt: at(7), ...quiet }));
    await answer([notice("notice", 5)]);
    expect(notify).not.toHaveBeenCalled();
    // Coming back must not announce what happened while it was out of sight.
    notices.observe(THREAD, idle({ itemCount: 2, updatedAt: at(8) }));
    notices.observe(THREAD, idle({ itemCount: 3, updatedAt: at(9) }));
    await answer([notice("notice", 5), notice("while-away", 7)]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not read a quiet thread, and forgets one that leaves the snapshot", async () => {
    const { notices, notify, reads, answer } = harness();
    notices.observe(THREAD, idle({ archivedAt: at(0) }));
    notices.observe(THREAD, idle({ archivedAt: at(0), itemCount: 2 }));
    expect(reads).toEqual([]);

    notices.observe(OTHER, idle());
    notices.observe(OTHER, idle({ itemCount: 2, updatedAt: at(5) }));
    notices.retain(new Set([THREAD]));
    await answer([notice("notice", 5, { source: OTHER })]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("alerts for a real loss even if the thread has started working again", async () => {
    const { notices, notify, answer } = harness();
    notices.observe(THREAD, idle());
    notices.observe(THREAD, idle({ itemCount: 2, updatedAt: at(5) }));
    notices.observe(THREAD, idle({ status: "running", activeRunId: "run" as never, itemCount: 2 }));
    await answer([notice("notice", 5)]);
    expect(notify.mock.calls).toEqual([[THREAD]]);
  });

  it("coalesces changes during a read into one further read", async () => {
    const { notices, notify, reads, answer } = harness();
    notices.observe(THREAD, idle());
    notices.observe(THREAD, idle({ itemCount: 2 }));
    notices.observe(THREAD, idle({ itemCount: 3 }));
    notices.observe(THREAD, idle({ itemCount: 4, updatedAt: at(5) }));
    expect(reads).toHaveLength(1);
    await answer([]);
    expect(reads).toHaveLength(2);
    await answer([notice("notice", 5)]);
    expect(reads).toHaveLength(2);
    expect(notify.mock.calls).toEqual([[THREAD]]);
  });

  it("limits reads at once and runs the rest in turn", async () => {
    const { notices, reads, answer } = harness();
    const threads = ["a", "b", "c"].map((id) => ThreadId.make(id));
    for (const thread of threads) notices.observe(thread, idle());
    for (const thread of threads) notices.observe(thread, idle({ itemCount: 2 }));
    expect(reads.map((read) => read.threadId)).toEqual(threads.slice(0, 2));
    await answer([], 0);
    expect(reads.map((read) => read.threadId)).toEqual(threads);
  });

  it.each(["timeout", "reconnect"])(
    "keeps unfinished transport reads within the cap after a %s",
    async (reason) => {
      const { notices, reads, answer, notify } = harness();
      for (const id of ["a", "b", "c"]) {
        const threadId = ThreadId.make(id);
        notices.observe(threadId, idle());
        notices.observe(threadId, idle({ itemCount: 2 }));
      }
      expect(reads).toHaveLength(2);
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(17_000);
      else {
        notices.pause();
        notices.resume();
      }
      expect(reads).toHaveLength(2);
      await answer([], 0);
      expect(reads).toHaveLength(3);
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["answers null", (read: { resolve: (items: null) => void }) => read.resolve(null)],
    ["rejects", (read: { reject: (cause: unknown) => void }) => read.reject(new Error("offline"))],
  ] as const)("retries when a read %s", async (_label, fail) => {
    const { notices, notify, reads, answer } = harness();
    notices.observe(THREAD, idle());
    notices.observe(THREAD, idle({ itemCount: 2, updatedAt: at(5) }));
    fail(reads[0]! as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads).toHaveLength(2);
    await answer([notice("notice", 5)]);
    expect(notify.mock.calls).toEqual([[THREAD]]);
  });

  it("stops retrying after its limit but reads again on the next change", async () => {
    const { notices, notify, reads, answer } = harness();
    notices.observe(THREAD, idle());
    notices.observe(THREAD, idle({ itemCount: 2, updatedAt: at(5) }));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await answer(null);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(reads).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(reads).toHaveLength(4);
    notices.observe(THREAD, idle({ itemCount: 3, updatedAt: at(6) }));
    expect(reads).toHaveLength(5);
    await answer([notice("notice", 5)]);
    expect(notify.mock.calls).toEqual([[THREAD]]);
  });

  it("treats a read that never answers as failed and ignores its late answer", async () => {
    const { notices, notify, reads } = harness();
    notices.observe(THREAD, idle());
    notices.observe(THREAD, idle({ itemCount: 2, updatedAt: at(5) }));
    await vi.advanceTimersByTimeAsync(15_000);
    reads[0]!.resolve([notice("notice", 5)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads).toHaveLength(2);
  });

  it("waits out a disconnect and reads what it missed on reconnect", async () => {
    const { notices, notify, reads, answer } = harness();
    notices.observe(THREAD, idle());
    notices.observe(THREAD, idle({ itemCount: 2, updatedAt: at(5) }));
    notices.pause();
    // The abandoned read's answer no longer counts.
    await answer([notice("notice", 5)], 0);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toHaveLength(1);
    notices.resume();
    expect(reads).toHaveLength(2);
    await answer([notice("notice", 5)]);
    expect(notify.mock.calls).toEqual([[THREAD]]);
  });

  it("queues changes seen while paused until it resumes", () => {
    const { notices, reads } = harness();
    notices.observe(THREAD, idle());
    notices.pause();
    notices.observe(THREAD, idle({ itemCount: 2 }));
    expect(reads).toEqual([]);
    notices.resume();
    expect(reads).toHaveLength(1);
  });

  it("ignores everything after it is disposed", async () => {
    const { notices, notify, reads, answer } = harness();
    notices.observe(THREAD, idle());
    notices.observe(THREAD, idle({ itemCount: 2, updatedAt: at(5) }));
    notices.dispose();
    await answer([notice("notice", 5)]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(notify).not.toHaveBeenCalled();
    expect(reads).toHaveLength(1);
  });
});

describe("a wake alert and the thread's completion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const COMPLETED_AT = 1_000;

  function alerts() {
    const sent: string[] = [];
    const gate = createThreadNotificationGate<ThreadId>((threadId, kind) => {
      const deliver = () => sent.push(kind);
      if (kind !== "completion" || !wake.notices.holdCompletion(threadId, deliver)) deliver();
    });
    const reads: Array<(items: WakeNoticeItems | null) => void> = [];
    const wake = {
      notices: createThreadWakeNotices({
        read: () => new Promise((resolve) => reads.push(resolve)),
        notify: (threadId) => {
          gate.supersedeCompletion(threadId, COMPLETED_AT);
          sent.push("wake");
        },
      }),
    };
    const parked = { attention: null, settled: false, completedAt: null };
    const ready = { attention: null, settled: true, completedAt: COMPLETED_AT };
    const visible = { archived: false, quiet: false };
    const answer = async (items: WakeNoticeItems | null) => {
      reads.at(-1)!(items);
      await vi.advanceTimersByTimeAsync(0);
    };
    // The session is released: the card lands and the parked roster clears together.
    const release = () => {
      wake.notices.observe(THREAD, idle({ pendingBackgroundTasks: [awaitedTask] }));
      gate.observe(THREAD, undefined, parked, visible);
      wake.notices.observe(THREAD, idle({ itemCount: 2, updatedAt: at(5) }));
      gate.observe(THREAD, parked, ready, visible);
    };
    return { sent, gate, wake, reads, answer, release };
  }

  it("sends only the wake alert when the read beats the grace", async () => {
    const { sent, answer, release } = alerts();
    release();
    await answer([notice("notice", 5)]);
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS * 2);
    expect(sent).toEqual(["wake"]);
  });

  it("holds the completion for a slower read and drops it when a notice is found", async () => {
    const { sent, answer, release } = alerts();
    release();
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    expect(sent).toEqual([]);
    await answer([notice("notice", 5)]);
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS * 2);
    expect(sent).toEqual(["wake"]);
  });

  it("releases the held completion when no notice is found", async () => {
    const { sent, answer, release } = alerts();
    release();
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    await answer([]);
    expect(sent).toEqual(["completion"]);
  });

  it("keeps the completion held through the coalesced read", async () => {
    const { sent, wake, answer, reads, release } = alerts();
    release();
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    wake.notices.observe(THREAD, idle({ itemCount: 3, updatedAt: at(6) }));
    await answer([]);
    expect(reads).toHaveLength(2);
    expect(sent).toEqual([]);
    await answer([notice("notice", 6)]);
    expect(sent).toEqual(["wake"]);
  });

  it("releases the held completion when the read fails, so it is not lost", async () => {
    const { sent, answer, release } = alerts();
    release();
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    await answer(null);
    expect(sent).toEqual(["completion"]);
  });

  it("releases the held completion on a disconnect", async () => {
    const { sent, wake, release } = alerts();
    release();
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    wake.notices.pause();
    expect(sent).toEqual(["completion"]);
  });

  it("drops the held completion when the thread is archived meanwhile", async () => {
    const { sent, wake, answer, release } = alerts();
    release();
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    wake.notices.observe(THREAD, idle({ itemCount: 2, archivedAt: at(7) }));
    await answer([]);
    expect(sent).toEqual([]);
  });

  it("does not delay a completion when no read is outstanding", async () => {
    const { sent, gate, wake } = alerts();
    const parked = { attention: null, settled: false, completedAt: null };
    const ready = { attention: null, settled: true, completedAt: COMPLETED_AT };
    wake.notices.observe(THREAD, idle({ status: "running", activeRunId: "run" as never }));
    gate.observe(THREAD, undefined, parked, { archived: false, quiet: false });
    wake.notices.observe(THREAD, idle({ itemCount: 2 }));
    gate.observe(THREAD, parked, ready, { archived: false, quiet: false });
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    expect(sent).toEqual(["completion"]);
  });

  it("lets a later run's completion notify after a wake alert", async () => {
    const { sent, gate, answer, release } = alerts();
    release();
    await answer([notice("notice", 5)]);
    const ready = { attention: null, settled: true, completedAt: COMPLETED_AT };
    const later = { attention: null, settled: true, completedAt: COMPLETED_AT + 1 };
    gate.observe(THREAD, ready, later, { archived: false, quiet: false });
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    expect(sent).toEqual(["wake", "completion"]);
  });
});
