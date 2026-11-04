// fork: a root thread's lost background wake only reaches its transcript, so the shell cannot say
// it happened. Check settling work and later idle changes for a loss; see FORK.md.
import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

export const WAKE_CANCELLED_NOTICE_TITLE = "Background wake cancelled";

// A released host can drop many sessions at once; each read can be a large projection.
const MAX_CONCURRENT_READS = 2;
const READ_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000];

export type WakeNoticeShell = Pick<
  OrchestrationV2ThreadShell,
  | "status"
  | "activeRunId"
  | "itemCount"
  | "updatedAt"
  | "latestRunStopRequested"
  | "latestRunId"
  | "latestRunCompletedAt"
  | "archivedAt"
  | "deletedAt"
  | "pendingBackgroundTasks"
>;
export type WakeNoticeItems = OrchestrationV2ThreadProjection["visibleTurnItems"];

const isIdle = (shell: WakeNoticeShell) =>
  shell.status === "completed" && shell.activeRunId === null;

const isQuiet = (shell: WakeNoticeShell) =>
  shell.archivedAt !== null || shell.deletedAt !== null || shell.latestRunStopRequested === true;

const awaitedWork = (shell: WakeNoticeShell) =>
  (shell.pendingBackgroundTasks ?? []).filter((task) => backgroundWorkHoldsCompletion([task]))
    .length;

const mayHaveLostWake = (prior: WakeNoticeShell, next: WakeNoticeShell) =>
  isIdle(next) &&
  (!isIdle(prior) || next.itemCount > prior.itemCount || awaitedWork(next) < awaitedWork(prior));

const completedRun = (shell: WakeNoticeShell) =>
  !isIdle(shell) || shell.latestRunId === null || shell.latestRunCompletedAt == null
    ? null
    : {
        runId: shell.latestRunId,
        completedAt: DateTime.toEpochMillis(shell.latestRunCompletedAt),
      };

interface HeldCompletion {
  readonly runId: RunId;
  readonly completedAt: number;
  readonly deliver: () => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface TrackedThread {
  shell: WakeNoticeShell;
  // Notices at or before this were already there when the client first saw the thread.
  baseline: DateTime.Utc;
  readonly seen: Set<string>;
  // A change no finished read has covered yet.
  stale: boolean;
  failures: number;
  retry: ReturnType<typeof setTimeout> | undefined;
  heldCompletion: HeldCompletion | undefined;
}

const completionStillCurrent = (tracked: TrackedThread, held: HeldCompletion) => {
  const current = completedRun(tracked.shell);
  return current?.runId === held.runId && current.completedAt === held.completedAt;
};

export function createThreadWakeNotices(options: {
  /** One bounded read of the thread's recent items. Null or a rejection means it failed. */
  readonly read: (threadId: ThreadId) => Promise<WakeNoticeItems | null>;
  readonly notify: (threadId: ThreadId, runIds: ReadonlySet<RunId>) => void;
}) {
  const threads = new Map<ThreadId, TrackedThread>();
  const queue = new Set<ThreadId>();
  const reads = new Map<ThreadId, { readonly timeout: ReturnType<typeof setTimeout> }>();
  let inFlight = 0;
  let paused = false;

  const dropCompletion = (tracked: TrackedThread) => {
    const completion = tracked.heldCompletion;
    tracked.heldCompletion = undefined;
    clearTimeout(completion?.timeout);
    return completion;
  };

  const releaseCompletion = (tracked: TrackedThread) => {
    const completion = dropCompletion(tracked);
    if (completion && !isQuiet(tracked.shell) && completionStillCurrent(tracked, completion)) {
      completion.deliver();
    }
  };

  const isNewNotice = (threadId: ThreadId, tracked: TrackedThread, row: WakeNoticeItems[number]) =>
    row.visibility === "local" &&
    row.sourceThreadId === threadId &&
    row.item.type === "system_notice" &&
    row.item.title === WAKE_CANCELLED_NOTICE_TITLE &&
    !tracked.seen.has(row.item.id) &&
    DateTime.toEpochMillis(row.item.updatedAt) > DateTime.toEpochMillis(tracked.baseline);

  const enqueue = (threadId: ThreadId, tracked: TrackedThread) => {
    tracked.stale = true;
    clearTimeout(tracked.retry);
    tracked.retry = undefined;
    if (paused || reads.has(threadId)) return;
    queue.add(threadId);
    pump();
  };

  const onFailure = (threadId: ThreadId, tracked: TrackedThread) => {
    tracked.stale = true;
    // The completion already waited out its grace, and a retry can take much longer.
    releaseCompletion(tracked);
    const delay = RETRY_DELAYS_MS[tracked.failures];
    tracked.failures += 1;
    if (delay !== undefined) tracked.retry = setTimeout(() => enqueue(threadId, tracked), delay);
  };

  const onItems = (threadId: ThreadId, tracked: TrackedThread, items: WakeNoticeItems) => {
    tracked.failures = 0;
    const notices = items.filter((row) => isNewNotice(threadId, tracked, row));
    for (const row of notices) tracked.seen.add(row.item.id);
    if (notices.length > 0 && !isQuiet(tracked.shell)) {
      const runIds = new Set(
        notices.flatMap(({ item }) => (item.runId === null ? [] : [item.runId])),
      );
      if (tracked.heldCompletion && runIds.has(tracked.heldCompletion.runId)) {
        dropCompletion(tracked);
      }
      options.notify(threadId, runIds);
    }
    if (tracked.stale) enqueue(threadId, tracked);
    else releaseCompletion(tracked);
  };

  const startRead = (threadId: ThreadId, tracked: TrackedThread) => {
    tracked.stale = false;
    const finish = (items: WakeNoticeItems | null) => {
      if (reads.get(threadId) !== read) return;
      clearTimeout(read.timeout);
      reads.delete(threadId);
      if (items === null) onFailure(threadId, tracked);
      else onItems(threadId, tracked, items);
      pump();
    };
    const read = { timeout: setTimeout(() => finish(null), READ_TIMEOUT_MS) };
    reads.set(threadId, read);
    // A timeout abandons its answer, but the RPC may still own a transport slot.
    inFlight += 1;
    void options
      .read(threadId)
      .then(finish, () => finish(null))
      .finally(() => {
        inFlight -= 1;
        pump();
      });
  };

  const pump = () => {
    for (const threadId of queue) {
      if (paused || inFlight >= MAX_CONCURRENT_READS) return;
      queue.delete(threadId);
      const tracked = threads.get(threadId);
      if (tracked !== undefined) startRead(threadId, tracked);
    }
  };

  const abandonRead = (threadId: ThreadId) => {
    clearTimeout(reads.get(threadId)?.timeout);
    reads.delete(threadId);
  };

  const forget = (threadId: ThreadId, tracked: TrackedThread) => {
    clearTimeout(tracked.retry);
    dropCompletion(tracked);
    abandonRead(threadId);
    queue.delete(threadId);
    threads.delete(threadId);
  };

  return {
    observe(threadId: ThreadId, shell: WakeNoticeShell): void {
      const tracked = threads.get(threadId);
      if (tracked === undefined) {
        threads.set(threadId, {
          shell,
          baseline: shell.updatedAt,
          seen: new Set(),
          stale: false,
          failures: 0,
          retry: undefined,
          heldCompletion: undefined,
        });
        return;
      }
      const prior = tracked.shell;
      tracked.shell = shell;
      if (tracked.heldCompletion && !completionStillCurrent(tracked, tracked.heldCompletion)) {
        dropCompletion(tracked);
      }
      if (isQuiet(shell)) {
        // What happens while it is archived or stopped is never announced later.
        tracked.baseline = shell.updatedAt;
        tracked.stale = false;
        dropCompletion(tracked);
        clearTimeout(tracked.retry);
        tracked.retry = undefined;
        queue.delete(threadId);
        return;
      }
      if (mayHaveLostWake(prior, shell)) enqueue(threadId, tracked);
    },
    /**
     * Keeps a completion back while a read could still replace it with a wake alert. Reads are
     * time-limited, so it is released, or dropped by an alert, soon after.
     */
    holdCompletion(threadId: ThreadId, completion: () => void): boolean {
      const tracked = threads.get(threadId);
      if (tracked === undefined || (!reads.has(threadId) && !queue.has(threadId))) return false;
      const current = completedRun(tracked.shell);
      if (current === null) return false;
      dropCompletion(tracked);
      tracked.heldCompletion = {
        ...current,
        deliver: completion,
        timeout: setTimeout(() => releaseCompletion(tracked), READ_TIMEOUT_MS),
      };
      return true;
    },
    /** Forgets threads that left the snapshot. */
    retain(threadIds: ReadonlySet<ThreadId>): void {
      for (const [threadId, tracked] of threads) {
        if (!threadIds.has(threadId)) forget(threadId, tracked);
      }
      pump();
    },
    /** No reads while the environment is away; what they would have covered waits for resume. */
    pause(): void {
      if (paused) return;
      paused = true;
      queue.clear();
      for (const [threadId, tracked] of threads) {
        clearTimeout(tracked.retry);
        tracked.retry = undefined;
        if (reads.has(threadId)) {
          abandonRead(threadId);
          tracked.stale = true;
        }
        releaseCompletion(tracked);
      }
    },
    resume(): void {
      if (!paused) return;
      paused = false;
      for (const [threadId, tracked] of threads) {
        if (!tracked.stale) continue;
        tracked.failures = 0;
        enqueue(threadId, tracked);
      }
    },
    dispose(): void {
      for (const [threadId, tracked] of threads) forget(threadId, tracked);
    },
  };
}
