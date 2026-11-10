// fork: limits. What the per-machine limits decide, from snapshots they're handed, with no I/O.
//
// On 2026-10-21 agent sessions pushed Alice's PC to 122 GiB committed against a 135 GiB commit limit.
// Each running session is about 2 GiB, and stock T3 has no limit that covers this outside Linux. The
// rules here are the memory gate's (teenylilconfig docs/memgate.md), moved into T3's run scheduler.
import * as DateTime from "effect/DateTime";
import {
  type EffectiveResourceLimits,
  type MemoryPressureLevel,
  type OrchestrationV2ConversationMessage,
  resolveResourceLimits,
  type ResourceLimitsPause,
  type ResourceLimitsSettings,
  type ResourceLimitsState,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";

export const GiB = 2 ** 30;

export const TIMING = {
  passMs: 15_000,
  // A new session takes a minute or two to reach its full size, so releases are spaced out,
  // unless there's room for every recent one to grow (`releaseDue`).
  releaseSpacingMs: 90_000,
  sessionGrowthMs: 120_000,
  interruptSpacingMs: 30_000,
  // A reading older than this counts as none, and the limits let everything through.
  staleReadingMs: 60_000,
  // The CPU limit compares the average of the last minute's readings.
  cpuWindow: 4,
  // A thread waiting for memory leaves Alice's inbox until it's released; a snooze outlives any
  // normal pause, and still ends by itself if the server goes away for good.
  snoozeMs: 24 * 3_600_000,
  // Admission records a thread a moment before its held run is written, and a busy machine stretches that moment.
  // A thread held this recently stays in line even with nothing queued yet.
  holdWriteMs: 60_000,
  // `memgate off` switches the limits off for 2 h by default; no switch outlasts a day.
  maxOffMs: 24 * 3_600_000,
  // Task wake rewrites the ranks file every 10 minutes; one older than a day is left over, so it counts as none.
  priorityStaleMs: 24 * 3_600_000,
  priorityAheadMs: 60_000,
  // The pause switch is read this often, so a change holds work almost at once.
  pauseCheckMs: 1_000,
  // Stop now keeps stopping turns this long, for any that were just starting when it was set. After that a turn
  // that's running got there through Alice, by her answer or her Resume.
  stopSweepMs: 30_000,
  // A command's shell can take a moment to die after an interrupt, so what it left running is looked for this often,
  // for this long.
  orphanCheckMs: 2_000,
  orphanWatchMs: 14_000,
} as const;

// CPU has no release line of its own; it releases this many points under the pause line.
const CPU_RELEASE_MARGIN = 10;

// What one session grows to, for the room a release needs.
export const SESSION_GIB = 2;

const LAUNCH_ANYWAY_PHRASE = "launch anyway";

/** One process in a reading of the machine's process table. */
export interface ProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  /** Microseconds since 1970, which a JavaScript number holds exactly. */
  readonly createdAt: number;
  readonly name: string;
}

/**
 * What Codex commands under `rootPid` left running: processes whose parent died since a reading, and which are still
 * alive. Windows keeps a dead parent's id and can give it to something new, so a "parent" newer than its child isn't
 * one, and who started what is only true within one reading. Other providers' commands die with their turn, so nothing
 * else under T3 is touched.
 */
export const orphanedProcesses = (
  before: ReadonlyArray<ProcessRow>,
  after: ReadonlyArray<ProcessRow>,
  rootPid: number,
): ReadonlyArray<ProcessRow> => {
  const then = new Map(before.map((row) => [row.pid, row]));
  const now = new Map(after.map((row) => [row.pid, row]));
  const alive = (row: ProcessRow) => now.get(row.pid)?.createdAt === row.createdAt;
  const parentOf = (row: ProcessRow) => {
    const parent = then.get(row.parentPid);
    return parent !== undefined && parent.createdAt <= row.createdAt ? parent : undefined;
  };
  const underCodex = (row: ProcessRow) => {
    const seen = new Set<number>();
    let codex = false;
    for (let at = parentOf(row); at !== undefined && !seen.has(at.pid); at = parentOf(at)) {
      if (at.pid === rootPid) return codex;
      codex ||= at.name.toLowerCase() === "codex.exe";
      seen.add(at.pid);
    }
    return false;
  };
  return before.filter((row) => {
    const parent = parentOf(row);
    return parent !== undefined && alive(row) && !alive(parent) && underCodex(row);
  });
};

/**
 * These processes and what's under them in one reading, them first. A process older than the one it names as parent
 * isn't its child: its real parent died, and this one reused the ID.
 */
export const withDescendants = (
  roots: ReadonlyArray<ProcessRow>,
  table: ReadonlyArray<ProcessRow>,
): ReadonlyArray<ProcessRow> => {
  const found = new Map(roots.map((row) => [row.pid, row]));
  // A Map's loop reaches what's added during it.
  for (const parent of found.values()) {
    for (const row of table) {
      if (
        row.parentPid === parent.pid &&
        row.createdAt >= parent.createdAt &&
        !found.has(row.pid)
      ) {
        found.set(row.pid, row);
      }
    }
  }
  return [...found.values()];
};

/** Linux keeps upstream's cap, so the fork's limits run on Windows and macOS only. */
export const limitsSupported = (platform: NodeJS.Platform) =>
  platform === "win32" || platform === "darwin";

/** The limits in force on a platform, or null where the fork has none. */
export const effectiveLimits = (
  saved: ResourceLimitsSettings,
  platform: NodeJS.Platform,
  totalBytes: number,
): EffectiveResourceLimits | null =>
  limitsSupported(platform) ? resolveResourceLimits(saved, platform === "win32", totalBytes) : null;

export interface HostReading {
  readonly sampledAt: number;
  readonly availableBytes: number;
  readonly totalBytes: number;
  readonly commitLimitBytes: number | null;
  readonly committedBytes: number | null;
  readonly memoryPressure: MemoryPressureLevel | null;
  /** 0 to 1, over the sampling interval. */
  readonly cpuUtilization: number | null;
}

export const headroomGiB = (reading: HostReading) =>
  reading.commitLimitBytes === null || reading.committedBytes === null
    ? null
    : (reading.commitLimitBytes - reading.committedBytes) / GiB;

export const averageCpu = (window: ReadonlyArray<number | null>) => {
  const known = window.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0) / known.length;
};

// Missing data never pauses and never blocks a release.
const below = (value: number | null, line: number | null) =>
  value !== null && line !== null && value < line;
const atLeast = (value: number | null, line: number | null) =>
  value === null || line === null || value > line;

/** One step of the state machine: pause low, release only well above it, critical below everything. */
export function nextState(
  previous: ResourceLimitsState,
  reading: HostReading,
  limits: EffectiveResourceLimits,
  cpuAverage: number | null,
): ResourceLimitsState {
  const headroom = headroomGiB(reading);
  const available = reading.availableBytes / GiB;
  const pressure = limits.usesMemoryPressure ? reading.memoryPressure : null;
  const cpuPercent = cpuAverage === null ? null : cpuAverage * 100;
  if (below(headroom, limits.criticalHeadroomGiB) || pressure === "critical") return "critical";
  if (previous !== "ok") {
    const released =
      atLeast(headroom, limits.releaseHeadroomGiB) &&
      atLeast(available, limits.releaseAvailableGiB) &&
      (pressure === null || pressure === "normal") &&
      (limits.pauseCpuPercent === null ||
        cpuPercent === null ||
        cpuPercent < limits.pauseCpuPercent - CPU_RELEASE_MARGIN);
    return released ? "ok" : "paused";
  }
  return below(headroom, limits.pauseHeadroomGiB) ||
    below(available, limits.pauseAvailableGiB) ||
    (pressure !== null && pressure !== "normal") ||
    (cpuPercent !== null && limits.pauseCpuPercent !== null && cpuPercent > limits.pauseCpuPercent)
    ? "paused"
    : "ok";
}

/**
 * Whether the next held thread may start, while the machine is under its limits. Releases are
 * 90 s apart, but one may start every pass when the reading would still be at its release lines
 * after it and every session released in the last two minutes grow to full size. That needs a
 * reading and at least one release line; macOS needs memory pressure normal too.
 */
export function releaseDue(input: {
  readonly now: number;
  readonly lastReleaseAt: number | null;
  /** Release times within the last `sessionGrowthMs`. */
  readonly growingSince: ReadonlyArray<number>;
  readonly reading: HostReading | null;
  readonly limits: EffectiveResourceLimits;
}): boolean {
  const { now, lastReleaseAt, reading, limits } = input;
  if (lastReleaseAt === null || now - lastReleaseAt >= TIMING.releaseSpacingMs) return true;
  if (reading === null) return false;
  if (limits.releaseHeadroomGiB === null && limits.releaseAvailableGiB === null) return false;
  if (limits.usesMemoryPressure && reading.memoryPressure !== "normal") return false;
  const growing = input.growingSince.filter((at) => now - at < TIMING.sessionGrowthMs).length;
  const needed = (growing + 1) * SESSION_GIB;
  const roomAbove = (value: number | null, line: number | null) =>
    line === null || (value !== null && value - needed >= line);
  return (
    roomAbove(headroomGiB(reading), limits.releaseHeadroomGiB) &&
    roomAbove(reading.availableBytes / GiB, limits.releaseAvailableGiB)
  );
}

export type Provenance = Pick<
  OrchestrationV2ConversationMessage,
  | "createdBy"
  | "creationSource"
  | "scheduledTaskId"
  | "senderThreadId"
  | "notification"
  | "delegatedCompletion"
>;

/**
 * A wake a provider buffered, like `isBufferedProviderNotification`: output from a turn its CLI started on its
 * own, as Claude does when a background command finishes. Holding its run saves no memory, since that turn runs
 * anyway, and leaves the turn without T3's tools until the hold lifts. Codex's wakes are prompted by T3, so they
 * arrive as server messages and are still held.
 */
export const isBufferedWake = (message: Provenance) =>
  message.createdBy === "agent" &&
  message.creationSource === "provider" &&
  message.notification !== undefined &&
  message.delegatedCompletion === undefined;

/**
 * Whether Alice typed this message herself in T3's app, on her PC or her phone. The server stamps
 * `createdBy: "user"` only for WebSocket sessions, which agent tokens can't open, so every
 * `t3_thread_send`, `t3 thread send` and launch tool arrives as an agent's. A schedule she set up
 * isn't her at the keyboard, and neither is a message relayed from another thread.
 */
export const isAlicesMessage = (message: Provenance | undefined) =>
  message !== undefined &&
  message.createdBy === "user" &&
  (message.creationSource === "web" || message.creationSource === "mobile") &&
  message.scheduledTaskId === undefined &&
  message.senderThreadId === undefined;

/**
 * The pause switch, from `pause.json`: `{ version: 1, mode, at }`, with `at` in epoch ms. T3 and teenylilconfig's
 * `memgate` and task wake all write it. It holds until someone resumes, so it has no expiry. A malformed file
 * counts as no pause, like the rest of the limits: a broken switch lets work through.
 */
export function manualPause(file: unknown): ResourceLimitsPause | null {
  if (typeof file !== "object" || file === null) return null;
  const { version, mode, at } = file as {
    readonly version?: unknown;
    readonly mode?: unknown;
    readonly at?: unknown;
  };
  if (version !== 1 || (mode !== "finish" && mode !== "stop")) return null;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) return null;
  return { mode, at };
}

export type PauseOrder = ResourceLimitsPause["mode"] | "resume";

const PAUSE_ORDERS: Readonly<Record<string, PauseOrder>> = {
  "pause all": "finish",
  "stop all": "stop",
  "resume all": "resume",
};

/**
 * The order in a message Alice typed herself, when that's the whole message: "pause all", "stop all" or
 * "resume all", in any case, with any spacing and closing punctuation. Anything longer is an ordinary message,
 * so she can still talk about pausing, and an agent can't set the switch by sending the words.
 */
export function pauseOrder(
  message: Provenance & { readonly text: string; readonly attachments: ReadonlyArray<unknown> },
): PauseOrder | null {
  if (!isAlicesMessage(message) || message.attachments.length > 0) return null;
  const words = message.text
    .trim()
    .replace(/[.!]+$/, "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join(" ");
  return Object.hasOwn(PAUSE_ORDERS, words) ? (PAUSE_ORDERS[words] ?? null) : null;
}

/**
 * Whether a message Alice typed came after the pause began. Those still start: at once in an idle thread, with its
 * older queue waiting again afterwards, or behind that older queue when a turn is still running.
 */
export const writtenDuringPause = (
  message: Provenance,
  writtenAt: number,
  pause: ResourceLimitsPause,
) => isAlicesMessage(message) && writtenAt >= pause.at;

/** Whether a message contains the phrase as whole words, ignoring case, punctuation and spacing. */
export function hasPhrase(text: string, phrase = LAUNCH_ANYWAY_PHRASE): boolean {
  const words = phrase
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(^|[^a-z0-9])${words.join("[^a-z0-9]+")}($|[^a-z0-9])`, "i").test(text);
}

/**
 * The newest message that started or joined a turn in a thread: role "user", in a run that isn't
 * still waiting in the queue or cancelled from it, as a typed order is. A run a restart cancelled
 * had started, so its message counts. Anyone may have written it.
 */
export function latestUserMessage<
  M extends Pick<OrchestrationV2ConversationMessage, "role" | "runId" | "createdAt">,
>(
  messages: ReadonlyArray<M>,
  runs: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly startedAt?: DateTime.Utc | null;
  }>,
): M | undefined {
  const notTurns = new Set(
    runs
      .filter(
        (run) => run.status === "queued" || (run.status === "cancelled" && run.startedAt == null),
      )
      .map((run) => run.id),
  );
  return messages
    .filter((message) => message.role === "user" && !(message.runId && notTurns.has(message.runId)))
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
    )
    .at(-1);
}

/** Alice's "launch anyway" lets a thread's launches through only while it is her latest message. */
export const launchAnyway = (
  latest: (Provenance & Pick<OrchestrationV2ConversationMessage, "text">) | undefined,
) => latest !== undefined && isAlicesMessage(latest) && hasPhrase(latest.text);

/**
 * The sessions to close early for memory, oldest first: idle ones, without a turn running, that
 * aren't attached to a thread waiting on Alice.
 */
export function idleSessionsToClose<
  Session extends {
    readonly busyTurns: { readonly size: number };
    readonly attachedThreadIds: ReadonlySet<ThreadId>;
    readonly lastActivityAtMs: number;
  },
>(sessions: Iterable<Session>, keepThreadIds: ReadonlySet<ThreadId>): Array<Session> {
  return [...sessions]
    .filter(
      (session) =>
        session.busyTurns.size === 0 &&
        ![...session.attachedThreadIds].some((threadId) => keepThreadIds.has(threadId)),
    )
    .toSorted((left, right) => left.lastActivityAtMs - right.lastActivityAtMs);
}

export interface RunningTurn {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly startedAt: number;
  /** Blocked on an approval or a question from Alice. */
  readonly waitingOnUser: boolean;
  /** Someone has already asked it to stop. */
  readonly stopRequested: boolean;
}

/** A turn waiting on Alice has nothing running and keeps her question. One already stopping needs nothing. */
export const interruptible = (turn: RunningTurn) => !turn.waitingOnUser && !turn.stopRequested;

/** The newest running turn the critical line may interrupt, skipping ones waiting on Alice or stopping. */
export function newestInterruptible(
  turns: ReadonlyArray<RunningTurn>,
  alreadyInterrupted: ReadonlySet<string>,
): RunningTurn | undefined {
  return turns
    .filter((turn) => interruptible(turn) && !alreadyInterrupted.has(turn.runId))
    .toSorted((left, right) => right.startedAt - left.startedAt)[0];
}

const gib = (value: number | null) => (value === null ? "?" : `${value.toFixed(1)} GiB`);

const clock = (at: number) =>
  DateTime.formatLocal(DateTime.makeUnsafe(at), {
    locale: "en-US",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * Why a run is waiting, for the notice in its thread. It stays in the transcript after the run
 * starts, so it's worded to stay true then too.
 */
export function waitingReason(input: {
  readonly state: ResourceLimitsState;
  readonly reading: HostReading | null;
  readonly limits: EffectiveResourceLimits;
  readonly cpuAverage: number | null;
  readonly machine: string;
  readonly at: number;
}): string {
  const { state, reading, limits, cpuAverage, machine, at } = input;
  const then =
    "Held work starts on its own, one thread at a time: board tasks by rank, then the rest oldest first. Choose Resume to start it now.";
  if (state === "ok" || reading === null) {
    return `Held at ${clock(at)} behind other work waiting for ${machine}'s limits. ${then}`;
  }
  const memory = limits.usesMemoryPressure
    ? `memory pressure ${reading.memoryPressure ?? "unknown"}, ${gib(reading.availableBytes / GiB)} available`
    : `commit headroom ${gib(headroomGiB(reading))}, ${gib(reading.availableBytes / GiB)} available`;
  const cpu =
    limits.pauseCpuPercent !== null &&
    cpuAverage !== null &&
    cpuAverage * 100 > limits.pauseCpuPercent
      ? `, CPU ${Math.round(cpuAverage * 100)}% over the last minute`
      : "";
  const low = state === "critical" ? "critically low on memory" : "over its limits";
  return `Held at ${clock(at)} because ${machine} was ${low} (${memory}${cpu}). ${then}`;
}

/** Why a run waits while every agent is paused. Like `waitingReason`, it stays true after the run starts. */
export const pausedReason = (at: number) =>
  `Held at ${clock(at)} because all agents were paused. After \`resume all\`, held work starts on its own, one thread at a time: board tasks by rank, then the rest oldest first. Choose Resume to start it now.`;

const ORDER_WORDS = { finish: "pause all", stop: "stop all", resume: "resume all" } as const;

/** What Alice sees in the thread where she typed an order. */
export function pauseOrderNotice(
  order: PauseOrder,
  input: { readonly saved: boolean; readonly wasPaused: boolean; readonly at: number },
): string {
  const { saved, wasPaused, at } = input;
  if (!saved) {
    return `T3 couldn't save the pause switch at ${clock(at)}, so \`${ORDER_WORDS[order]}\` may not hold. Check the logs, or send it again.`;
  }
  if (order === "resume") {
    return wasPaused
      ? `All agents resumed at ${clock(at)}. Held work starts on its own, one thread at a time.`
      : "Nothing was paused.";
  }
  const then = "Send `resume all` in any thread to start everything again.";
  return order === "stop"
    ? `All agents stopped at ${clock(at)}. Running turns are being interrupted, and nothing else starts. ${then}`
    : `All agents paused at ${clock(at)}. Running turns finish, then nothing else starts. ${then}`;
}

export interface ResumeNote {
  /** The notification row's title in the transcript. */
  readonly summary: string;
  /** The prompt the agent gets when the thread resumes. */
  readonly text: string;
}

// Claude reports an interrupted tool call as the user rejecting it, and agents take that as a no.
const NOT_REFUSED =
  "If your last tool call shows as rejected or declined by the user, that was T3 stopping it: nobody said no.";

/** What an interrupted thread resumes with. */
export const interruptedNote = (machine: string, at: number): ResumeNote => ({
  summary: `T3 interrupted this turn to free memory on ${machine}`,
  text: `T3 interrupted your turn at ${clock(at)} because ${machine} was critically low on memory. ${NOT_REFUSED} Run it again if you still need it, then continue where you stopped.`,
});

/** What a thread resumes with after Stop now interrupted its turn. */
export const stoppedNote = (at: number): ResumeNote => ({
  summary: "T3 interrupted this turn when all agents were stopped",
  text: `T3 interrupted your turn at ${clock(at)} because all agents were stopped. They've been resumed now. ${NOT_REFUSED} Whatever you had running stopped with it, so start again what you still need, then continue where you stopped.`,
});

/** For a thread with no turn running, whose background work Stop now ended. */
export const stoppedWorkNote = (at: number): ResumeNote => ({
  summary: "T3 stopped this thread's background work when all agents were stopped",
  text: `T3 stopped your background work at ${clock(at)} because all agents were stopped. They've been resumed now. Start again what you still need, then continue where you stopped.`,
});

/** Whether Stop now's note about a thread's background work is still in its queue, unread. */
export const stoppedWorkNoteQueued = (
  messages: ReadonlyArray<{ readonly id: string; readonly runId?: string | null | undefined }>,
  runs: ReadonlyArray<{ readonly id: string; readonly status: string }>,
) => {
  const queued = new Set(runs.filter((run) => run.status === "queued").map((run) => run.id));
  return messages.some(
    (message) =>
      message.id.startsWith("limits:stopped-work:") &&
      message.runId != null &&
      queued.has(message.runId),
  );
};

/** The threads of a thread's delegated tasks. */
export const delegatedThreadIds = (
  tasks: ReadonlyArray<{ readonly origin: string; readonly childThreadId: string | null }>,
): ReadonlySet<string> =>
  new Set(
    tasks.flatMap((task) =>
      task.origin === "app_owned" && task.childThreadId !== null ? [task.childThreadId] : [],
    ),
  );

/**
 * What Stop now has to end on a thread with no turn running. A delegated task has its own thread and
 * stops there, and a pull request watch has nothing running.
 */
export function stoppableWork<
  Task extends {
    readonly taskId: string;
    readonly kind: string;
    readonly childThreadId?: string | undefined;
  },
>(tasks: ReadonlyArray<Task>, delegatedThreadIds: ReadonlySet<string>): ReadonlyArray<Task> {
  return tasks.filter(
    (task) =>
      !task.taskId.startsWith("pull-request-watch:") &&
      !(
        task.kind === "subagent" &&
        task.childThreadId !== undefined &&
        delegatedThreadIds.has(task.childThreadId)
      ),
  );
}

const MAX_WAKE_LENGTH = 500;

/**
 * The wake a restart dropped: T3 cancels a queued wake from a provider session once that session is
 * gone, so a thread that was held for it has nothing left to start it.
 */
export function lostWake<
  M extends Pick<
    OrchestrationV2ConversationMessage,
    "id" | "text" | "createdBy" | "creationSource" | "notification" | "delegatedCompletion"
  >,
>(
  messages: ReadonlyArray<M>,
  runs: ReadonlyArray<{
    readonly ordinal: number;
    readonly status: string;
    readonly userMessageId: string;
  }>,
): M | undefined {
  const latest = runs.toSorted((left, right) => left.ordinal - right.ordinal).at(-1);
  if (latest?.status !== "cancelled") return undefined;
  return messages.find(
    (message) =>
      message.id === latest.userMessageId &&
      message.createdBy === "agent" &&
      message.creationSource === "provider" &&
      message.notification !== undefined &&
      message.delegatedCompletion === undefined,
  );
}

export const lostWakeNote = (text: string, at: number): ResumeNote => ({
  summary: "T3 restarted while this thread was held",
  text: `T3 restarted at ${clock(at)} while this thread was held, and the message that would have woken you was dropped. It said: ${text.slice(0, MAX_WAKE_LENGTH)}\n\nContinue where you stopped.`,
});

// A hook record comes from a file any local process can write, so its text is bounded.
const MAX_LAUNCHES = 5;
const MAX_LAUNCH_LENGTH = 200;

/** What a thread resumes with after the session hook refused its subagents. */
export function heldLaunchesNote(
  launches: ReadonlyArray<string>,
  at: number,
  paused = false,
): ResumeNote {
  const who = paused ? "The pause on all agents" : "The memory limits";
  const shown = launches
    .slice(0, MAX_LAUNCHES)
    .map((launch) => launch.replace(/\s+/g, " ").trim().slice(0, MAX_LAUNCH_LENGTH));
  const more = launches.length - shown.length;
  const list = `${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
  const one = launches.length === 1;
  return {
    summary: `${who} held ${one ? "a launch" : `${launches.length} launches`}`,
    text: `Continue where you stopped. ${who} held ${one ? "this launch" : "these launches"} at ${clock(at)}: ${list}. Start ${one ? "it" : "them"} now if you still need to.`,
  };
}

// Any local process can write the ranks file, so what it can hand the governor is bounded.
const MAX_RANKS = 5_000;
const MAX_THREAD_ID_LENGTH = 512;

/**
 * Thread ranks from the file teenylilconfig's task wake writes from Alice's Task Priorities board:
 * `{ version: 1, at, ranks: { [threadId]: rank } }`, with rank 1 the top. A file more than a day old or more than a
 * minute ahead counts as none, and so does a malformed one. Only positive finite ranks count, for thread IDs up to
 * 512 characters, and at most 5,000 are read.
 */
export function priorityRanks(file: unknown, now: number): ReadonlyMap<string, number> {
  const ranked = new Map<string, number>();
  if (typeof file !== "object" || file === null) return ranked;
  const { version, at, ranks } = file as {
    readonly version?: unknown;
    readonly at?: unknown;
    readonly ranks?: unknown;
  };
  if (version !== 1 || typeof at !== "number" || !Number.isFinite(at)) return ranked;
  if (now - at > TIMING.priorityStaleMs || at - now > TIMING.priorityAheadMs) return ranked;
  if (typeof ranks !== "object" || ranks === null || Array.isArray(ranks)) return ranked;
  for (const [threadId, rank] of Object.entries(ranks).slice(0, MAX_RANKS)) {
    if (threadId.length > MAX_THREAD_ID_LENGTH) continue;
    if (typeof rank === "number" && Number.isFinite(rank) && rank > 0) ranked.set(threadId, rank);
  }
  return ranked;
}

/**
 * The order held threads start in: ranked ones first, best rank first, then the rest. Ties keep the order they
 * came in, which is oldest first.
 */
export function releaseOrder<T>(
  items: ReadonlyArray<T>,
  rankOf: (item: T) => number | null,
): Array<T> {
  return items
    .map((item, index) => ({ item, index, rank: rankOf(item) ?? Number.POSITIVE_INFINITY }))
    .toSorted((left, right) =>
      left.rank === right.rank ? left.index - right.index : left.rank < right.rank ? -1 : 1,
    )
    .map(({ item }) => item);
}

/**
 * When the limits are switched off, from the override file `memgate off` writes: `{ at, until }`
 * in epoch ms. A switch never outlasts a day from when it was written, and a past one is none.
 */
export function offUntil(file: unknown, now: number): number | null {
  if (typeof file !== "object" || file === null) return null;
  const { at, until } = file as { readonly at?: unknown; readonly until?: unknown };
  if (typeof at !== "number" || typeof until !== "number") return null;
  if (!Number.isFinite(at) || !Number.isFinite(until)) return null;
  const end = Math.min(until, at + TIMING.maxOffMs);
  return end > now ? end : null;
}
