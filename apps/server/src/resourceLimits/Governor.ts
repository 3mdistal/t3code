// fork: limits. Acts on each host reading: closes idle sessions, interrupts on the critical line,
// releases waiting threads, and publishes the state the session hook reads; see FORK.md.
import {
  CommandId,
  MessageId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ResourceLimitsPause,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HostReadings } from "./HostReadings.ts";
import { makeJsonFiles } from "./jsonFiles.ts";
import {
  averageCpu,
  delegatedThreadIds,
  effectiveLimits,
  GiB,
  headroomGiB,
  heldLaunchesNote,
  type HostReading,
  interruptedNote,
  latestUserMessage,
  launchAnyway,
  limitsSupported,
  interruptible,
  lostWake,
  lostWakeNote,
  newestInterruptible,
  nextState,
  offUntil,
  orphanedProcesses,
  priorityRanks,
  type ProcessRow,
  releaseDue,
  releaseOrder,
  type ResumeNote,
  type RunningTurn,
  stoppableWork,
  stoppedNote,
  stoppedWorkNote,
  stoppedWorkNoteQueued,
  TIMING,
  withDescendants,
  writtenDuringPause,
} from "./policy.ts";
import { ProcessTree } from "./ProcessTree.ts";
import {
  isOff,
  liveState,
  reportedState,
  ResourceLimits,
  TotalMemoryBytes,
  type WaitingThread,
} from "./ResourceLimits.ts";

/** A running session the hook may ask about, keyed by its provider's session id. */
interface SessionInfo {
  readonly threadId: ThreadId;
  readonly launchAnyway: boolean;
}

interface Memory {
  readonly cpuWindow: ReadonlyArray<number | null>;
  readonly lastReleaseAt: number | null;
  /** Releases whose sessions may still be growing. */
  readonly growingSince: ReadonlyArray<number>;
  readonly lastInterruptAt: number | null;
  readonly interruptedRunIds: ReadonlyArray<string>;
  /** Per running turn and its latest message, so the transcript is read once per change. */
  readonly sessionCache: ReadonlyMap<
    string,
    { readonly nativeIds: ReadonlyArray<string> } & SessionInfo
  >;
}

/** What Stop now read before it acted, kept until what it orphaned has been looked for. */
interface NotedProcesses {
  readonly readings: ReadonlyArray<ReadonlyArray<ProcessRow>>;
  readonly noted: ReadonlySet<string>;
  readonly checkAt: number;
  readonly until: number;
}

const NOTHING_NOTED: NotedProcesses = { readings: [], noted: new Set(), checkAt: 0, until: 0 };

interface Inspected {
  readonly entry: WaitingThread;
  readonly shell: OrchestrationV2ThreadShell | null;
  readonly queued: boolean;
  readonly held: boolean;
  readonly blocked: boolean;
  /** Upstream snoozes a thread with a queue only when every queued message is a notification. */
  readonly snoozable: boolean;
}

const STATE_VERSION = 1;
const MAX_INTERRUPTED_RUN_IDS = 50;
// A helper thread takes the rank of the nearest thread above it that has one, this many levels up at most.
const MAX_RANK_HOPS = 10;
// Any local process can write the ranks file, so a larger one is skipped unread.
const MAX_PRIORITY_BYTES = 1024 * 1024;

const STOPPED_REASON = "All agents were stopped.";

const waitsOnAlice = (shell: OrchestrationV2ThreadShell) =>
  shell.pendingRuntimeRequest !== null && shell.pendingRuntimeRequest.blocking !== false;

const epoch = (value: DateTime.Utc | null | undefined) =>
  value === null || value === undefined ? null : DateTime.toEpochMillis(value);

export const make = Effect.fn("makeResourceLimitsGovernor")(function* () {
  const limits = yield* ResourceLimits;
  const settings = yield* ServerSettings.ServerSettingsService;
  const platform = yield* HostProcess.Platform;
  const totalBytes = yield* TotalMemoryBytes;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const processTree = yield* ProcessTree;
  const notedProcesses = yield* Ref.make(NOTHING_NOTED);
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);

  // The memory gate's hook and CLI read and write these; see teenylilconfig docs/memgate.md.
  const dir = path.join(config.stateDir, "resource-limits");
  const files = {
    state: path.join(dir, "state.json"),
    off: path.join(dir, "off.json"),
    inbox: path.join(dir, "inbox"),
    // The Task Priorities board's ranks, which teenylilconfig's task wake writes; see FORK.md.
    priority: path.join(dir, "priority.json"),
  };

  const { readJson, writeJson } = yield* makeJsonFiles;

  const firstPassPending = yield* Ref.make(true);
  const savedWaiting = yield* Ref.make("");
  const memory = yield* Ref.make<Memory>({
    cpuWindow: [],
    lastReleaseAt: null,
    growingSince: [],
    lastInterruptAt: null,
    interruptedRunIds: [],
    sessionCache: new Map(),
  });

  const dispatch = (
    command: Extract<OrchestrationV2ServerCommand, { readonly threadId: ThreadId }>,
  ) =>
    threads.dispatch(command).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("resource-limits.dispatch-failed", {
          type: command.type,
          threadId: command.threadId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );

  // Sent like the restart continuation: a system notification, which doesn't end a snooze and
  // which upstream's snooze accepts in a queue.
  const queueNote = (threadId: ThreadId, id: string, note: ResumeNote) =>
    dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      messageId: MessageId.make(id),
      threadId,
      text: note.text,
      notification: {
        source: { kind: "system" },
        outcome: "updated",
        summary: note.summary,
        detail: note.text,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });

  /** Threads with a live run, a pending request, or a live session. */
  const runtimeShells = projections.getRecoveryThreadIds("runtime").pipe(
    Effect.flatMap((ids) =>
      Effect.forEach(ids, (id) =>
        projections.getThreadShell(id).pipe(Effect.orElseSucceed(() => null)),
      ),
    ),
    Effect.map((shells) =>
      shells.filter(
        (shell): shell is OrchestrationV2ThreadShell =>
          shell !== null && shell.archivedAt === null && shell.deletedAt === null,
      ),
    ),
    Effect.orElseSucceed((): ReadonlyArray<OrchestrationV2ThreadShell> => []),
  );

  const runningTurns = (shells: ReadonlyArray<OrchestrationV2ThreadShell>, now: number) =>
    shells.flatMap((shell): Array<RunningTurn> =>
      shell.activeRunId !== null &&
      (shell.activityRunStatus === "starting" || shell.activityRunStatus === "running")
        ? [
            {
              threadId: shell.id,
              runId: shell.activeRunId,
              startedAt: epoch(shell.activityRunStartedAt ?? shell.latestRunStartedAt) ?? now,
              waitingOnUser: waitsOnAlice(shell),
              stopRequested:
                shell.latestRunStopRequested === true && shell.latestRunId === shell.activeRunId,
            },
          ]
        : [],
    );

  /** Whether Alice wrote this thread's latest message during the pause, which makes its work hers to keep. */
  const hersSincePause = Effect.fn("ResourceLimitsGovernor.hersSincePause")(function* (
    threadId: ThreadId,
    pause: ResourceLimitsPause,
  ) {
    const records = yield* projections
      .getThreadRecords(threadId, ["messages", "runs"], { messageRoles: ["user"] })
      .pipe(Effect.option);
    const latest = Option.isSome(records)
      ? latestUserMessage(records.value.messages, records.value.runs)
      : undefined;
    return (
      latest !== undefined &&
      writtenDuringPause(latest, DateTime.toEpochMillis(latest.createdAt), pause)
    );
  });

  /**
   * Interrupting a Codex turn on Windows ends the command's shell and leaves what the shell started running, with no
   * parent left to find it by. So Stop now reads the processes before it acts on anything new, and `endOrphans` compares.
   */
  const noteProcesses = Effect.fn("ResourceLimitsGovernor.noteProcesses")(function* (
    keys: ReadonlyArray<string>,
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    pause: ResourceLimitsPause,
  ) {
    if (platform !== "win32") return;
    const { noted } = yield* Ref.get(notedProcesses);
    // Asking for Stop now again acts on a thread again, so it reads again.
    const fresh = keys.map((key) => `${pause.at}:${key}`);
    if (fresh.every((key) => noted.has(key))) return;
    const rows = yield* processTree.read;
    if (rows === null) yield* Effect.logWarning("resource-limits.process-reading-failed");
    // What she started since the pause began is newer than it, and the table can't say whose a new process is. A turn
    // she steered also has older processes, which stay in: Stop now is the kill switch, and it would rather end what
    // such a turn's finished shell left running than miss what every other turn's interrupted shell did.
    const hers = yield* Effect.filter(
      shells.filter(
        (shell) => shell.activeRunId !== null || (shell.pendingBackgroundTasks?.length ?? 0) > 0,
      ),
      (shell) => hersSincePause(shell.id, pause),
      { concurrency: 8 },
    );
    const reading = hers.length > 0 ? rows?.filter((row) => row.createdAt < pause.at * 1000) : rows;
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(notedProcesses, (current) => ({
      readings: reading == null ? current.readings : [...current.readings, reading],
      noted: new Set([...current.noted, ...fresh]),
      checkAt: now + TIMING.orphanCheckMs,
      until: now + TIMING.orphanWatchMs,
    }));
  });

  /** Ends what Stop now's interrupts left running. It has its own loop, because this can take seconds. */
  const endOrphans = Effect.gen(function* () {
    const noted = yield* Ref.get(notedProcesses);
    if (noted.until === 0 || (yield* Clock.currentTimeMillis) < noted.checkAt) return;
    const after = noted.readings.length > 0 ? yield* processTree.read : null;
    const orphans =
      after === null
        ? []
        : withDescendants(
            noted.readings.flatMap((before) => orphanedProcesses(before, after, process.pid)),
            after,
          );
    const results = yield* Effect.forEach(
      orphans,
      (row) => processTree.end(row).pipe(Effect.map((outcome) => ({ pid: row.pid, outcome }))),
      { concurrency: 8 },
    );
    if (results.some((result) => result.outcome !== "gone")) {
      const pids = (outcome: string) =>
        results.filter((result) => result.outcome === outcome).map((result) => result.pid);
      yield* Effect.logWarning("resource-limits.ended-orphans", {
        ended: pids("ended"),
        failed: pids("failed"),
      });
    }
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(notedProcesses, (current) =>
      now >= current.until ? NOTHING_NOTED : { ...current, checkAt: now + TIMING.orphanCheckMs },
    );
  });

  /**
   * Interrupting a turn or closing its session leaves a Claude background command running on Windows,
   * so Stop now asks the provider to end them first. Codex ends its console ones when its turn is interrupted.
   */
  const endBackgroundTasks = Effect.fn("ResourceLimitsGovernor.endBackgroundTasks")(function* (
    threadId: ThreadId,
  ) {
    const records = yield* projections
      .getThreadRecords(threadId, ["providerThreads", "subagents"])
      .pipe(Effect.option);
    if (Option.isNone(records)) return;
    const delegated = delegatedThreadIds(records.value.subagents);
    yield* Effect.forEach(
      records.value.providerThreads,
      (providerThread) =>
        Effect.gen(function* () {
          const taskIds = stoppableWork(providerThread.pendingBackgroundTasks ?? [], delegated).map(
            (task) => task.taskId,
          );
          if (taskIds.length === 0 || providerThread.providerSessionId === null) return;
          const runtime = yield* sessions.get(providerThread.providerSessionId);
          if (Option.isNone(runtime) || runtime.value.stopBackgroundTasks === undefined) return;
          yield* runtime.value.stopBackgroundTasks({ providerThread, taskIds });
        }).pipe(Effect.ignore),
      { concurrency: 8, discard: true },
    );
  });

  /** The running turns Stop now interrupts. A turn she started since the pause began is hers to keep. */
  const turnsToStop = (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    pause: ResourceLimitsPause,
    now: number,
  ) =>
    Effect.filter(
      runningTurns(shells, now).filter(interruptible),
      ({ threadId }) => Effect.map(hersSincePause(threadId, pause), (hers) => !hers),
      { concurrency: 8 },
    );

  /** Stop now: interrupts these turns and queues the note each resumes with. */
  const stopRunningTurns = Effect.fn("ResourceLimitsGovernor.stopRunningTurns")(function* (
    turns: ReadonlyArray<RunningTurn>,
    now: number,
  ) {
    yield* Effect.forEach(
      turns,
      Effect.fnUntraced(function* ({ threadId, runId }) {
        yield* endBackgroundTasks(threadId);
        const interrupted = yield* dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`limits:stop:${runId}`),
          threadId,
          runId,
          reason: STOPPED_REASON,
        });
        if (!interrupted) return;
        yield* Effect.logWarning("resource-limits.stopped", { threadId, runId });
        yield* queueNote(threadId, `limits:stopped:${runId}`, stoppedNote(now));
      }),
      { concurrency: 8, discard: true },
    );
  });

  /**
   * The threads whose turn has ended but which still have commands or subagents running in the background.
   * What she started since the pause began is hers to keep.
   */
  const workToStop = Effect.fn("ResourceLimitsGovernor.workToStop")(function* (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    pause: ResourceLimitsPause,
    now: number,
  ) {
    const running = new Set(runningTurns(shells, now).map((turn) => turn.threadId));
    const candidates = shells.filter(
      (shell) =>
        !running.has(shell.id) &&
        !waitsOnAlice(shell) &&
        (shell.pendingBackgroundTasks?.length ?? 0) > 0,
    );
    const found = yield* Effect.forEach(
      candidates,
      Effect.fnUntraced(function* (shell) {
        const { subagents } = yield* projections
          .getThreadRecords(shell.id, ["subagents"])
          .pipe(Effect.orElseSucceed(() => ({ subagents: [] })));
        const work = stoppableWork(
          shell.pendingBackgroundTasks ?? [],
          delegatedThreadIds(subagents),
        );
        return work.length > 0 && !(yield* hersSincePause(shell.id, pause)) ? [shell] : [];
      }),
      { concurrency: 8 },
    );
    return found.flat();
  });

  /**
   * Stop now's other half: ending a thread's background work closes its session too, and the note brings the
   * thread back on resume, unless Alice has set it aside or it's waiting on her.
   */
  const stopBackgroundWork = Effect.fn("ResourceLimitsGovernor.stopBackgroundWork")(function* (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    found: ReadonlyArray<OrchestrationV2ThreadShell>,
    pause: ResourceLimitsPause,
    now: number,
  ) {
    // A thread waiting on Alice keeps its turn and her question, but nothing keeps running under it.
    yield* Effect.forEach(shells.filter(waitsOnAlice), (shell) => endBackgroundTasks(shell.id), {
      concurrency: 8,
      discard: true,
    });
    yield* Effect.forEach(
      found,
      Effect.fnUntraced(function* (shell) {
        yield* endBackgroundTasks(shell.id);
        const stopped = yield* dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`limits:stop-work:${shell.id}:${pause.at}`),
          threadId: shell.id,
          reason: STOPPED_REASON,
          stopDelegatedTasks: false,
        });
        if (!stopped) return;
        yield* Effect.logWarning("resource-limits.stopped-background-work", {
          threadId: shell.id,
        });
        const setAside =
          shell.settledOverride === "settled" ||
          (shell.snoozedUntil != null && (epoch(shell.snoozedUntil) ?? 0) > now);
        if (setAside) return;
        // Asking again while a provider still lists the work queues no second note. One that's been read doesn't
        // count, because this stop needs its own.
        const records = yield* projections
          .getThreadRecords(shell.id, ["messages", "runs"], { messageRoles: ["user"] })
          .pipe(Effect.option);
        if (
          Option.isNone(records) ||
          !stoppedWorkNoteQueued(records.value.messages, records.value.runs)
        ) {
          yield* queueNote(
            shell.id,
            `limits:stopped-work:${shell.id}:${pause.at}`,
            stoppedWorkNote(now),
          );
        }
      }),
      { concurrency: 8, discard: true },
    );
  });

  /** T3 cancels a held wake when it restarts, once the session that sent it is gone. */
  const requeueLostWake = Effect.fn("ResourceLimitsGovernor.requeueLostWake")(function* (
    threadId: ThreadId,
    now: number,
  ) {
    const records = yield* projections
      .getThreadRecords(threadId, ["messages", "runs"], { messageRoles: ["user"] })
      .pipe(Effect.option);
    if (Option.isNone(records)) return false;
    const wake = lostWake(records.value.messages, records.value.runs);
    if (wake === undefined) return false;
    return yield* queueNote(threadId, `limits:lost-wake:${wake.id}`, lostWakeNote(wake.text, now));
  });

  /**
   * The waiting list is how a restart knows what to release, and a pass only saves it every 15 s. Stop now
   * is often followed by shutting down, so a change is saved within a second.
   */
  const saveWaiting = Effect.gen(function* () {
    const { waiting } = yield* limits.read;
    const threads = waiting.map((entry) => entry.threadId).join();
    if (threads === (yield* Ref.get(savedWaiting))) return;
    const saved = yield* readJson(files.state);
    if (saved === null || typeof saved !== "object") return;
    if (yield* writeJson(files.state, { ...saved, waiting })) {
      yield* Ref.set(savedWaiting, threads);
    }
  });

  /** The switch, checked often: admission follows it at once, and Stop now interrupts straight away. */
  const followPause = Effect.gen(function* () {
    yield* saveWaiting;
    const before = (yield* limits.read).pause;
    const pause = yield* limits.refreshPause;
    if (pause?.mode !== before?.mode || pause?.at !== before?.at) {
      yield* Effect.logInfo("resource-limits.pause-changed", { pause });
    }
    if (pause?.mode !== "stop") return;
    const now = yield* Clock.currentTimeMillis;
    if (now - pause.at < TIMING.stopSweepMs) {
      const shells = yield* runtimeShells;
      const turns = yield* turnsToStop(shells, pause, now);
      const work = yield* workToStop(shells, pause, now);
      yield* noteProcesses(
        [...turns.map((turn) => turn.runId), ...work.map((shell) => shell.id)],
        shells,
        pause,
      );
      yield* stopRunningTurns(turns, now);
      yield* stopBackgroundWork(shells, work, pause, now);
    }
  });

  const inspect = Effect.fn("ResourceLimitsGovernor.inspect")(function* (entry: WaitingThread) {
    const shell = yield* projections
      .getThreadShell(entry.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) {
      return {
        entry,
        shell: null,
        queued: false,
        held: false,
        blocked: false,
        snoozable: false,
      } satisfies Inspected;
    }
    const runs = yield* projections.getThreadRecords(entry.threadId, ["runs"]).pipe(
      Effect.map((records) => records.runs),
      Effect.orElseSucceed(() => []),
    );
    const queued = runs.filter((run) => run.status === "queued");
    const snoozable =
      queued.length > 0 &&
      !entry.snoozeTried &&
      shell.snoozedUntil == null &&
      (yield* projections
        .getThreadRecords(entry.threadId, ["messages"], {
          messageIds: queued.map((run) => run.userMessageId),
        })
        .pipe(
          Effect.map(
            ({ messages }) =>
              messages.length === queued.length &&
              messages.every(
                (message) =>
                  message.notification !== undefined || message.delegatedCompletion !== undefined,
              ),
          ),
          Effect.orElseSucceed(() => false),
        ));
    return {
      entry,
      shell,
      queued: queued.length > 0,
      held: queued.some((run) => run.queueHeld === true),
      blocked: runs.some((run) =>
        ["preparing", "starting", "running", "waiting"].includes(run.status),
      ),
      snoozable,
    } satisfies Inspected;
  });

  const ourSnooze = (inspected: Inspected) => {
    const ours =
      inspected.entry.snoozedUntil === null
        ? Option.none()
        : DateTime.make(inspected.entry.snoozedUntil);
    return (
      Option.isSome(ours) &&
      inspected.shell?.snoozedUntil != null &&
      epoch(inspected.shell.snoozedUntil) === DateTime.toEpochMillis(ours.value)
    );
  };

  const unsnooze = (inspected: Inspected, now: number) =>
    ourSnooze(inspected)
      ? dispatch({
          type: "thread.unsnooze",
          commandId: CommandId.make(`limits:unsnooze:${inspected.entry.threadId}:${now}`),
          threadId: inspected.entry.threadId,
          reason: "user",
        })
      : Effect.succeed(true);

  const readPriority = (now: number) =>
    fs.stat(files.priority).pipe(
      Effect.flatMap((info) =>
        Number(info.size) > MAX_PRIORITY_BYTES ? Effect.succeed(null) : readJson(files.priority),
      ),
      Effect.orElseSucceed((): unknown => null),
      Effect.map((file) => priorityRanks(file, now)),
    );

  // The board's best-ranked task goes first. A thread without a rank of its own, such as a task's helper or a
  // fork of its thread, takes the rank of the nearest thread above it that has one. A deleted thread ends the walk.
  const byRank = Effect.fn("ResourceLimitsGovernor.byRank")(function* (
    ready: ReadonlyArray<Inspected>,
    now: number,
  ) {
    if (ready.length < 2) return ready;
    const ranks = yield* readPriority(now);
    if (ranks.size === 0) return ready;
    // Each thread above is read once a pass, however many helpers share it.
    const shells = new Map<ThreadId, OrchestrationV2ThreadShell | null>();
    const shellOf = (threadId: ThreadId) =>
      shells.has(threadId)
        ? Effect.succeed(shells.get(threadId) ?? null)
        : projections.getThreadShell(threadId).pipe(
            Effect.orElseSucceed(() => null),
            Effect.tap((shell) => Effect.sync(() => shells.set(threadId, shell))),
          );
    const rankOf = new Map<ThreadId, number | null>();
    for (const item of ready) {
      let shell = item.shell;
      let rank: number | null = null;
      const seen = new Set<ThreadId>();
      for (let hop = 0; hop <= MAX_RANK_HOPS; hop++) {
        if (shell === null || shell.deletedAt !== null || seen.has(shell.id)) break;
        seen.add(shell.id);
        rank = ranks.get(shell.id) ?? null;
        const parent = shell.lineage.parentThreadId;
        if (rank !== null || parent == null) break;
        shell = yield* shellOf(parent);
      }
      rankOf.set(item.entry.threadId, rank);
    }
    return releaseOrder(ready, (item) => rankOf.get(item.entry.threadId) ?? null);
  });

  const sessionsFor = Effect.fn("ResourceLimitsGovernor.sessionsFor")(function* (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    paused: boolean,
    // A refused launch's record can arrive after its turn ended, as the refusal tells the agent to.
    includeIdle: boolean,
  ) {
    const cache = (yield* Ref.get(memory)).sessionCache;
    const next = new Map<string, { readonly nativeIds: ReadonlyArray<string> } & SessionInfo>();
    for (const shell of shells) {
      if (shell.activeRunId === null && !includeIdle) continue;
      const key = `${shell.id}:${shell.activeRunId}:${epoch(shell.latestUserMessageAt) ?? ""}`;
      const known = cache.get(key);
      if (known !== undefined) {
        next.set(key, known);
        continue;
      }
      const records = yield* projections
        .getThreadRecords(shell.id, ["providerThreads", "messages", "runs"], {
          messageRoles: ["user"],
        })
        .pipe(Effect.option);
      if (Option.isNone(records)) continue;
      next.set(key, {
        threadId: shell.id,
        nativeIds: records.value.providerThreads.flatMap((thread) =>
          thread.nativeThreadRef?.nativeId ? [thread.nativeThreadRef.nativeId] : [],
        ),
        launchAnyway: launchAnyway(latestUserMessage(records.value.messages, records.value.runs)),
      });
    }
    yield* Ref.update(memory, (current) => ({ ...current, sessionCache: next }));
    const bySession: Record<string, SessionInfo> = {};
    for (const info of next.values()) {
      for (const nativeId of info.nativeIds) {
        bySession[nativeId] = {
          threadId: info.threadId,
          launchAnyway: !paused && info.launchAnyway,
        };
      }
    }
    return bySession;
  });

  // The hook leaves one record per refused launch; each becomes part of a note its thread resumes with.
  const ingestInbox = Effect.fn("ResourceLimitsGovernor.ingestInbox")(function* (
    names: ReadonlyArray<string>,
    bySession: Readonly<Record<string, SessionInfo>>,
    now: number,
    paused: boolean,
  ) {
    const launches = new Map<ThreadId, Array<string>>();
    for (const name of names) {
      const file = path.join(files.inbox, name);
      const record = yield* readJson(file);
      yield* fs.remove(file).pipe(Effect.ignore);
      const { sessionId, about, tool } = (record ?? {}) as {
        readonly sessionId?: unknown;
        readonly about?: unknown;
        readonly tool?: unknown;
      };
      const thread = typeof sessionId === "string" ? bySession[sessionId] : undefined;
      if (thread === undefined) {
        yield* Effect.logInfo("resource-limits.inbox-unmatched", { name });
        continue;
      }
      const label =
        typeof about === "string" && about.trim() !== ""
          ? about
          : typeof tool === "string"
            ? tool
            : "a subagent";
      launches.set(thread.threadId, [...(launches.get(thread.threadId) ?? []), label]);
    }
    for (const [threadId, labels] of launches) {
      yield* queueNote(
        threadId,
        `limits:launches:${threadId}:${now}`,
        heldLaunchesNote(labels, now, paused),
      );
    }
  });

  const listInbox = fs.readDirectory(files.inbox).pipe(
    Effect.map((names) => names.filter((name) => name.endsWith(".json")).toSorted()),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const machineName = Option.match(environment, {
    onNone: () => Effect.succeed("This machine"),
    onSome: (service) => service.getDescriptor.pipe(Effect.map((descriptor) => descriptor.label)),
  });

  /** One pass over a reading, or over none when the sampler went quiet. */
  const pass = Effect.fn("ResourceLimitsGovernor.pass")(function* (reading: HostReading | null) {
    const now = yield* Clock.currentTimeMillis;
    const pause = yield* limits.refreshPause;
    const paused = pause !== null;
    const saved = yield* settings.getSettings.pipe(
      Effect.map((current) => current.resourceLimits),
      Effect.orElseSucceed(() => ({})),
    );
    const effective = effectiveLimits(saved, platform, totalBytes);
    if (effective === null) return;
    const switchedOffUntil = offUntil(yield* readJson(files.off), now);
    const remembered = yield* Ref.get(memory);
    const cpuWindow =
      reading === null
        ? remembered.cpuWindow
        : [...remembered.cpuWindow, reading.cpuUtilization].slice(-TIMING.cpuWindow);
    const cpuAverage = averageCpu(cpuWindow);
    const machine = yield* machineName;
    const previous = yield* limits.read;
    const next = {
      ...previous,
      limits: effective,
      reading,
      cpuAverage,
      offUntil: switchedOffUntil,
      machine,
      state: reading === null ? "ok" : nextState(previous.state, reading, effective, cpuAverage),
    } as const;
    const state = liveState(next, now);
    const off = isOff(next, now);

    const inbox = yield* listInbox;
    const runtime =
      state !== "ok" || paused || previous.waiting.length > 0 || inbox.length > 0
        ? yield* runtimeShells
        : [];

    // Every pass while over the limits, and before admission sees the new state, so idle sessions
    // go before any work waits. Stop now closes them too, so nothing is left running.
    if ((state !== "ok" || pause?.mode === "stop") && sessions.releaseIdleSessions !== undefined) {
      const closed = yield* sessions.releaseIdleSessions({
        keepThreadIds: new Set(runtime.filter(waitsOnAlice).map((shell) => shell.id)),
      });
      if (closed.length > 0) {
        yield* Effect.logInfo("resource-limits.closed-idle-sessions", { count: closed.length });
      }
    }
    const current = yield* limits.update((snapshot) => ({
      ...snapshot,
      limits: next.limits,
      reading: next.reading,
      cpuAverage: next.cpuAverage,
      offUntil: next.offUntil,
      machine: next.machine,
      state: next.state,
    }));

    // Drop threads with nothing left waiting, and snooze the rest out of Alice's inbox.
    const firstPass = yield* Ref.getAndSet(firstPassPending, false);
    const inspected = yield* Effect.forEach(current.waiting, inspect);
    const dropped = new Set<ThreadId>();
    const changed = new Map<ThreadId, WaitingThread>();
    for (const item of inspected) {
      if (item.shell === null || !item.queued) {
        // A wake the restart dropped comes back as a note, so the thread keeps its place in the line.
        if (
          item.shell !== null &&
          firstPass &&
          (yield* requeueLostWake(item.entry.threadId, now))
        ) {
          continue;
        }
        // Its held run may not be written yet. Dropping it now would leave that run with nothing to release it.
        if (item.shell !== null && now - item.entry.lastHeldAt < TIMING.holdWriteMs) continue;
        dropped.add(item.entry.threadId);
        if (item.shell !== null) yield* unsnooze(item, now);
        continue;
      }
      if (item.held && !item.blocked && item.snoozable && !waitsOnAlice(item.shell)) {
        const until = DateTime.formatIso(DateTime.makeUnsafe(now + TIMING.snoozeMs));
        const snoozed = yield* dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`limits:snooze:${item.entry.threadId}:${item.entry.heldAt}`),
          threadId: item.entry.threadId,
          snoozedUntil: until,
        });
        changed.set(item.entry.threadId, {
          ...item.entry,
          snoozeTried: true,
          snoozedUntil: snoozed ? until : null,
        });
      }
    }

    const bySession =
      state !== "ok" || paused || inbox.length > 0
        ? yield* sessionsFor(runtime, paused, inbox.length > 0)
        : {};
    if (inbox.length > 0) yield* ingestInbox(inbox, bySession, now, paused);

    // Critical: stop the newest running turn, one per interval, until memory is back.
    let lastInterruptAt = remembered.lastInterruptAt;
    let interruptedRunIds = remembered.interruptedRunIds;
    if (
      state === "critical" &&
      (lastInterruptAt === null || now - lastInterruptAt >= TIMING.interruptSpacingMs)
    ) {
      const turn = newestInterruptible(runningTurns(runtime, now), new Set(interruptedRunIds));
      if (turn !== undefined) {
        const { threadId, runId } = turn;
        // Interrupt only; holding the queue would also stop delegated tasks.
        const interrupted = yield* dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`limits:interrupt:${runId}`),
          threadId,
          runId,
          reason: `${machine} was critically low on memory.`,
        });
        if (interrupted) {
          yield* Effect.logWarning("resource-limits.interrupted", { threadId, runId });
          yield* queueNote(threadId, `limits:interrupted:${runId}`, interruptedNote(machine, now));
          lastInterruptAt = now;
          interruptedRunIds = [...interruptedRunIds, runId].slice(-MAX_INTERRUPTED_RUN_IDS);
        }
      }
    }

    // Release the best-ranked board task first and the rest oldest first, spaced out, once the reading this pass
    // took is back under the limits.
    let lastReleaseAt = remembered.lastReleaseAt;
    const growingSince = remembered.growingSince.filter((at) => now - at < TIMING.sessionGrowthMs);
    const released = new Set<ThreadId>();
    if (
      state === "ok" &&
      !paused &&
      (off || releaseDue({ now, lastReleaseAt, growingSince, reading, limits: effective }))
    ) {
      const ready = inspected.filter(
        (item) => !dropped.has(item.entry.threadId) && item.held && !item.blocked,
      );
      // Switched off, everything waiting goes at once.
      for (const item of off ? ready : (yield* byRank(ready, now)).slice(0, 1)) {
        yield* unsnooze({ ...item, entry: changed.get(item.entry.threadId) ?? item.entry }, now);
        yield* dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`limits:release:${item.entry.threadId}:${now}`),
          threadId: item.entry.threadId,
        });
        yield* Effect.logInfo("resource-limits.released", { threadId: item.entry.threadId });
        released.add(item.entry.threadId);
        lastReleaseAt = now;
        growingSince.push(now);
      }
    }

    // Admission may have added threads during this pass, so only the ones handled here change, and one held again
    // since this pass read it stays, with a new run to wait for.
    const handled = new Map(current.waiting.map((entry) => [entry.threadId, entry.lastHeldAt]));
    const published = yield* limits.update((snapshot) => ({
      ...snapshot,
      waiting: snapshot.waiting
        .filter(
          (entry) =>
            (!dropped.has(entry.threadId) && !released.has(entry.threadId)) ||
            entry.lastHeldAt !== handled.get(entry.threadId),
        )
        .map((entry) => {
          const snooze = changed.get(entry.threadId);
          return snooze === undefined
            ? entry
            : { ...entry, snoozedUntil: snooze.snoozedUntil, snoozeTried: snooze.snoozeTried };
        }),
    }));
    yield* Ref.update(memory, (latest) => ({
      ...latest,
      cpuWindow,
      lastReleaseAt,
      growingSince,
      lastInterruptAt,
      interruptedRunIds,
    }));

    const headroom = reading === null ? null : headroomGiB(reading);
    yield* writeJson(files.state, {
      version: STATE_VERSION,
      source: "t3",
      at: now,
      machine,
      state: reportedState({ ...next, pause }, now),
      // Every agent stays held while paused, whatever the off switch says, and the hook follows that.
      off: off && !paused ? switchedOffUntil : null,
      pause,
      headroomGiB: headroom === null ? null : Math.round(headroom * 10) / 10,
      availableGiB: reading === null ? null : Math.round((reading.availableBytes / GiB) * 10) / 10,
      waiting: published.waiting,
      sessions: bySession,
      lastReleaseAt,
      growingSince,
      lastInterruptAt,
      interruptedRunIds,
    });
    yield* Ref.set(savedWaiting, published.waiting.map((entry) => entry.threadId).join());
  });

  /** Picks up the waiting list and timers a restart left behind. */
  const restore = Effect.gen(function* () {
    const saved = (yield* readJson(files.state)) as {
      readonly version?: unknown;
      readonly waiting?: unknown;
      readonly lastReleaseAt?: unknown;
      readonly growingSince?: unknown;
      readonly lastInterruptAt?: unknown;
      readonly interruptedRunIds?: unknown;
    } | null;
    if (saved === null || saved.version !== STATE_VERSION) return;
    const number = (value: unknown) => (typeof value === "number" ? value : null);
    const waiting = Array.isArray(saved.waiting)
      ? saved.waiting.flatMap((entry: unknown): Array<WaitingThread> => {
          const { threadId, heldAt, lastHeldAt, snoozedUntil, snoozeTried } = (entry ??
            {}) as Record<string, unknown>;
          return typeof threadId === "string" && typeof heldAt === "number"
            ? [
                {
                  threadId: threadId as ThreadId,
                  heldAt,
                  lastHeldAt: typeof lastHeldAt === "number" ? lastHeldAt : heldAt,
                  snoozedUntil: typeof snoozedUntil === "string" ? snoozedUntil : null,
                  snoozeTried: snoozeTried === true,
                },
              ]
            : [];
        })
      : [];
    yield* limits.update((snapshot) => ({ ...snapshot, waiting }));
    yield* Ref.set(savedWaiting, waiting.map((entry) => entry.threadId).join());
    const lastReleaseAt = number(saved.lastReleaseAt);
    yield* Ref.update(memory, (current) => ({
      ...current,
      lastReleaseAt,
      // A file from before `growingSince` was saved has only the newest release.
      growingSince: Array.isArray(saved.growingSince)
        ? saved.growingSince.filter((at): at is number => typeof at === "number")
        : lastReleaseAt === null
          ? []
          : [lastReleaseAt],
      lastInterruptAt: number(saved.lastInterruptAt),
      interruptedRunIds: Array.isArray(saved.interruptedRunIds)
        ? saved.interruptedRunIds.filter((id): id is string => typeof id === "string")
        : [],
    }));
  });

  /** A saved change shows in Settings at once; the next pass decides what it means for held work. */
  const followSettings = settings.streamChanges.pipe(
    Stream.runForEach((current) => {
      const effective = effectiveLimits(current.resourceLimits, platform, totalBytes);
      return effective === null
        ? Effect.void
        : limits.update((snapshot) => ({ ...snapshot, limits: effective })).pipe(Effect.asVoid);
    }),
  );

  return { pass, restore, followSettings, followPause, endOrphans };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    if (!limitsSupported(platform)) return;
    const readings = yield* HostReadings;
    const governor = yield* make();
    yield* governor.restore;
    yield* governor.followSettings.pipe(Effect.forkScoped);
    yield* governor.followPause.pipe(
      Effect.catchCause((cause) => Effect.logWarning("resource-limits.pause-failed", { cause })),
      Effect.andThen(Effect.sleep(Duration.millis(TIMING.pauseCheckMs))),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* governor.endOrphans.pipe(
      Effect.catchCause((cause) => Effect.logWarning("resource-limits.orphans-failed", { cause })),
      Effect.andThen(Effect.sleep(Duration.millis(TIMING.pauseCheckMs))),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* readings.next.pipe(
      // A sampler that goes quiet counts as no reading, which lets everything through.
      Effect.timeoutOption(Duration.millis(TIMING.staleReadingMs)),
      Effect.flatMap((reading) => governor.pass(Option.getOrNull(reading))),
      Effect.catchCause((cause) => Effect.logWarning("resource-limits.pass-failed", { cause })),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
