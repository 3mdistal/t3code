// fork: limits. What the per-machine limits decide, from snapshots they're handed, with no I/O.
//
// On 2026-10-21 agent sessions pushed Alice's PC to 122 GiB committed against a 135 GiB commit limit.
// Each running session is about 2 GiB, and stock T3 has no limit that covers this outside Linux. The
// rules here are the memory gate's (teenylilconfig docs/memgate.md), moved into T3's run scheduler.
import * as DateTime from "effect/DateTime";
import type {
  EffectiveResourceLimits,
  MemoryPressureLevel,
  OrchestrationV2ConversationMessage,
  ResourceLimitsSettings,
  ResourceLimitsState,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

export const GiB = 2 ** 30;

export const TIMING = {
  passMs: 15_000,
  // A new session takes a minute or two to reach its full size, so releases are spaced out.
  releaseSpacingMs: 90_000,
  interruptSpacingMs: 30_000,
  // A reading older than this counts as none, and the limits let everything through.
  staleReadingMs: 60_000,
  // The CPU limit compares the average of the last minute's readings.
  cpuWindow: 4,
  // A thread waiting for memory leaves Alice's inbox until it's released; a snooze outlives any
  // normal pause, and still ends by itself if the server goes away for good.
  snoozeMs: 24 * 3_600_000,
  // `memgate off` switches the limits off for 2 h by default; no switch outlasts a day.
  maxOffMs: 24 * 3_600_000,
} as const;

// CPU has no release line of its own; it releases this many points under the pause line.
const CPU_RELEASE_MARGIN = 10;

const LAUNCH_ANYWAY_PHRASE = "launch anyway";

/** Alice's memory gate thresholds for the PC (teenylilconfig windows/hosts/teenylilpc/memgate.json). */
const WINDOWS_DEFAULTS: EffectiveResourceLimits = {
  pauseHeadroomGiB: 25,
  pauseAvailableGiB: 8,
  releaseHeadroomGiB: 35,
  releaseAvailableGiB: 12,
  criticalHeadroomGiB: 10,
  pauseCpuPercent: null,
  usesMemoryPressure: false,
};

// macOS keeps free memory low on purpose and compresses before it swaps, so its own pressure level
// decides by default. Available-memory lines can be added per machine.
const MACOS_DEFAULTS: EffectiveResourceLimits = {
  pauseHeadroomGiB: null,
  pauseAvailableGiB: null,
  releaseHeadroomGiB: null,
  releaseAvailableGiB: null,
  criticalHeadroomGiB: null,
  pauseCpuPercent: null,
  usesMemoryPressure: true,
};

/** The limits in force on a platform, or null where the fork has none (Linux keeps upstream's cap). */
export function effectiveLimits(
  saved: ResourceLimitsSettings,
  platform: NodeJS.Platform,
): EffectiveResourceLimits | null {
  const defaults =
    platform === "win32" ? WINDOWS_DEFAULTS : platform === "darwin" ? MACOS_DEFAULTS : null;
  if (defaults === null) return null;
  const commit = platform === "win32";
  return {
    pauseHeadroomGiB: commit ? (saved.pauseHeadroomGiB ?? defaults.pauseHeadroomGiB) : null,
    pauseAvailableGiB: saved.pauseAvailableGiB ?? defaults.pauseAvailableGiB,
    releaseHeadroomGiB: commit ? (saved.releaseHeadroomGiB ?? defaults.releaseHeadroomGiB) : null,
    releaseAvailableGiB: saved.releaseAvailableGiB ?? defaults.releaseAvailableGiB,
    criticalHeadroomGiB: commit
      ? (saved.criticalHeadroomGiB ?? defaults.criticalHeadroomGiB)
      : null,
    pauseCpuPercent: saved.pauseCpuPercent ?? defaults.pauseCpuPercent,
    usesMemoryPressure: defaults.usesMemoryPressure,
  };
}

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

export type Provenance = Pick<
  OrchestrationV2ConversationMessage,
  "createdBy" | "creationSource" | "scheduledTaskId" | "senderThreadId"
>;

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
 * still waiting in the queue. Anyone may have written it.
 */
export function latestUserMessage<
  M extends Pick<OrchestrationV2ConversationMessage, "role" | "runId" | "createdAt">,
>(
  messages: ReadonlyArray<M>,
  runs: ReadonlyArray<{ readonly id: string; readonly status: string }>,
): M | undefined {
  const queued = new Set(runs.filter((run) => run.status === "queued").map((run) => run.id));
  return messages
    .filter((message) => message.role === "user" && !(message.runId && queued.has(message.runId)))
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

/** The newest running turn the critical line may interrupt, skipping ones waiting on Alice or stopping. */
export function newestInterruptible(
  turns: ReadonlyArray<RunningTurn>,
  alreadyInterrupted: ReadonlySet<string>,
): RunningTurn | undefined {
  return turns
    .filter(
      (turn) => !turn.waitingOnUser && !turn.stopRequested && !alreadyInterrupted.has(turn.runId),
    )
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
    "Held work starts on its own, one thread at a time, oldest first. Choose Resume to start it now.";
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

export interface ResumeNote {
  /** The notification row's title in the transcript. */
  readonly summary: string;
  /** The prompt the agent gets when the thread resumes. */
  readonly text: string;
}

/** What an interrupted thread resumes with. */
export const interruptedNote = (machine: string, at: number): ResumeNote => ({
  summary: `T3 interrupted this turn to free memory on ${machine}`,
  text: `T3 interrupted your turn at ${clock(at)} because ${machine} was critically low on memory. Continue where you stopped.`,
});

// A hook record comes from a file any local process can write, so its text is bounded.
const MAX_LAUNCHES = 5;
const MAX_LAUNCH_LENGTH = 200;

/** What a thread resumes with after the session hook refused its subagents. */
export function heldLaunchesNote(launches: ReadonlyArray<string>, at: number): ResumeNote {
  const shown = launches
    .slice(0, MAX_LAUNCHES)
    .map((launch) => launch.replace(/\s+/g, " ").trim().slice(0, MAX_LAUNCH_LENGTH));
  const more = launches.length - shown.length;
  const list = `${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
  const one = launches.length === 1;
  return {
    summary: `The memory limits held ${one ? "a launch" : `${launches.length} launches`}`,
    text: `Continue where you stopped. The memory limits held ${one ? "this launch" : "these launches"} at ${clock(at)}: ${list}. Start ${one ? "it" : "them"} now if you still need to.`,
  };
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
