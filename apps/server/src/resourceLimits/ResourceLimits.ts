// fork: limits. Who may start a run while the machine is over its limits; see FORK.md.
import * as NodeOS from "node:os";
import type {
  EffectiveResourceLimits,
  OrchestrationV2AppThread,
  ResourceLimitsPause,
  ResourceLimitsState,
  ResourceLimitsStatus,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { makeJsonFiles } from "./jsonFiles.ts";
import {
  effectiveLimits,
  type HostReading,
  isAlicesMessage,
  isBufferedWake,
  latestUserMessage,
  launchAnyway,
  manualPause,
  movedReason,
  type PauseOrder,
  pausedReason,
  type Provenance,
  TIMING,
  waitingReason,
  writtenDuringPause,
} from "./policy.ts";

/** The machine's RAM, which "use up to N%" is a share of. */
export const TotalMemoryBytes = Context.Reference<number>("t3/resourceLimits/TotalMemoryBytes", {
  defaultValue: () => NodeOS.totalmem(),
});

export interface WaitingThread {
  readonly threadId: ThreadId;
  readonly heldAt: number;
  /**
   * The latest admission that held it, which `heldAt` keeps out of so the thread keeps its place in line. Each
   * admission writes a new entry, which is how a pass tells one that landed while it ran.
   */
  readonly lastHeldAt: number;
  /** The snooze the limits put on the thread, so a release ends only that one. */
  readonly snoozedUntil: string | null;
  /** Upstream refuses to snooze a thread with a queued message of its own, so this isn't retried. */
  readonly snoozeTried: boolean;
}

/** Where a thread held here continues: a thread on a linked machine. Saved in `moved.json`. */
export interface MovedThread {
  readonly environmentId: string;
  readonly threadId: string;
  readonly machine: string;
  readonly link: string | null;
  readonly at: number;
}

/** Moves held threads to the linked machine in the overflow settings; installed where the links are. */
export interface OverflowMover {
  /** Moves the first of these that may move, best first. Returns the thread it moved. */
  readonly move: (
    candidates: ReadonlyArray<{ readonly threadId: ThreadId; readonly heldAt: number }>,
    now: number,
  ) => Effect.Effect<ThreadId | null>;
  /** Sends what's queued on moved threads to where they continue, and cancels it here. */
  readonly forward: (now: number) => Effect.Effect<void>;
}

/** `moved.json`'s entries, skipping malformed ones. */
function movedThreads(file: unknown): ReadonlyMap<ThreadId, MovedThread> {
  const moved = new Map<ThreadId, MovedThread>();
  const threads = (file as { readonly threads?: unknown } | null)?.threads;
  if (typeof threads !== "object" || threads === null) return moved;
  for (const [threadId, entry] of Object.entries(threads)) {
    const {
      environmentId,
      threadId: there,
      machine,
      link,
      at,
    } = (entry ?? {}) as Record<string, unknown>;
    if (typeof environmentId !== "string" || typeof there !== "string") continue;
    moved.set(threadId as ThreadId, {
      environmentId,
      threadId: there,
      machine: typeof machine === "string" ? machine : environmentId,
      link: typeof link === "string" ? link : null,
      at: typeof at === "number" ? at : 0,
    });
  }
  return moved;
}

export interface LimitsSnapshot {
  /** Null where the fork has no limits (Linux keeps upstream's cap). */
  readonly limits: EffectiveResourceLimits | null;
  readonly state: ResourceLimitsState;
  readonly reading: HostReading | null;
  readonly cpuAverage: number | null;
  readonly offUntil: number | null;
  /** Alice's switch that holds every agent. It outranks `offUntil` and doesn't depend on any reading. */
  readonly pause: ResourceLimitsPause | null;
  readonly machine: string;
  /** Threads holding work for the limits, oldest first. */
  readonly waiting: ReadonlyArray<WaitingThread>;
  /** Threads that continue on a linked machine. Everything sent to one here waits to be forwarded. */
  readonly moved: ReadonlyMap<ThreadId, MovedThread>;
  /** Moved threads admission held something for since the last forward. */
  readonly forwardDue: ReadonlySet<ThreadId>;
}

export type Admission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly notice: string };

const ADMITTED: Admission = { admitted: true };

export const isOff = (snapshot: LimitsSnapshot, now: number) =>
  snapshot.offUntil !== null && snapshot.offUntil > now;

/** The state the limits act on: none without fresh readings, so a broken sampler lets work through. */
export function liveState(snapshot: LimitsSnapshot, now: number): ResourceLimitsState {
  if (snapshot.limits === null || isOff(snapshot, now) || snapshot.reading === null) return "ok";
  return now - snapshot.reading.sampledAt > TIMING.staleReadingMs ? "ok" : snapshot.state;
}

/** What the machine reports: "paused" while Alice's switch holds work, even with memory to spare. */
export const reportedState = (snapshot: LimitsSnapshot, now: number): ResourceLimitsState => {
  const state = liveState(snapshot, now);
  return state === "ok" && snapshot.pause !== null ? "paused" : state;
};

const UNLIMITED: LimitsSnapshot = {
  limits: null,
  state: "ok",
  reading: null,
  cpuAverage: null,
  offUntil: null,
  pause: null,
  machine: "This machine",
  waiting: [],
  moved: new Map(),
  forwardDue: new Set(),
};

// A reference, like the pool catalog: harnesses without the limits admit everything.
export class ResourceLimits extends Context.Reference<{
  /**
   * Whether a run may start now. A run that may not is recorded as waiting, and the caller holds
   * it in its thread's queue with the returned notice.
   */
  readonly admit: (input: {
    readonly thread: Pick<OrchestrationV2AppThread, "id" | "lineage">;
    readonly message: Provenance;
    /** When the message was written, in epoch ms; left out for one arriving now. */
    readonly writtenAt?: number;
  }) => Effect.Effect<Admission>;
  /** Sets or lifts Alice's switch. `supported` is false where the machine has no limits. */
  readonly setPause: (order: PauseOrder) => Effect.Effect<{
    readonly supported: boolean;
    readonly saved: boolean;
    readonly wasPaused: boolean;
  }>;
  /**
   * The notice for a run on a thread that continues on a linked machine, which always waits here to be forwarded,
   * or undefined for any other thread.
   */
  readonly movedHold: (threadId: ThreadId) => Effect.Effect<string | undefined>;
  readonly overflow: Effect.Effect<OverflowMover | null>;
  readonly setOverflow: (mover: OverflowMover) => Effect.Effect<void>;
  /** Reads the switch again, since other processes can set it too. */
  readonly refreshPause: Effect.Effect<ResourceLimitsPause | null>;
  readonly status: Effect.Effect<ResourceLimitsStatus | undefined>;
  /** The governor's readings and the waiting list, which only the governor prunes and releases. */
  readonly read: Effect.Effect<LimitsSnapshot>;
  readonly update: (
    change: (snapshot: LimitsSnapshot) => LimitsSnapshot,
  ) => Effect.Effect<LimitsSnapshot>;
}>("t3/resourceLimits/ResourceLimits", {
  defaultValue: () => ({
    admit: () => Effect.succeed(ADMITTED),
    setPause: () => Effect.succeed({ supported: false, saved: false, wasPaused: false }),
    movedHold: () => Effect.undefined,
    overflow: Effect.succeed(null),
    setOverflow: () => Effect.void,
    refreshPause: Effect.succeed(null),
    status: Effect.undefined,
    read: Effect.succeed(UNLIMITED),
    update: () => Effect.succeed(UNLIMITED),
  }),
}) {}

const make = Effect.fn("makeResourceLimits")(function* () {
  const platform = yield* HostProcess.Platform;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { readJson, writeJson } = yield* makeJsonFiles;
  const pauseFile = path.join(config.stateDir, "resource-limits", "pause.json");
  const readPause = readJson(pauseFile).pipe(Effect.map(manualPause));
  const movedFile = path.join(config.stateDir, "resource-limits", "moved.json");
  // Read before the first dispatch, so a restart while paused doesn't start anything, and a moved thread's
  // messages still wait to be forwarded.
  const moved = movedThreads(yield* readJson(movedFile));
  const snapshot = yield* Ref.make<LimitsSnapshot>({
    ...UNLIMITED,
    limits: effectiveLimits({}, platform, yield* TotalMemoryBytes),
    pause: yield* readPause,
    moved,
    forwardDue: new Set(moved.keys()),
  });
  const overflow = yield* Ref.make<OverflowMover | null>(null);

  const movedHold = Effect.fn("ResourceLimits.movedHold")(function* (threadId: ThreadId) {
    const entry = (yield* Ref.get(snapshot)).moved.get(threadId);
    if (entry === undefined) return undefined;
    yield* Ref.update(snapshot, (latest) => ({
      ...latest,
      forwardDue: new Set([...latest.forwardDue, threadId]),
    }));
    return movedReason(entry);
  });

  // Memory gate's rule: Alice's "launch anyway" counts while it's the newest message that started
  // a turn in the thread that launched this work.
  const launchAnywayIn = (threadId: ThreadId) =>
    projections.getThreadRecords(threadId, ["messages", "runs"], { messageRoles: ["user"] }).pipe(
      Effect.map(({ messages, runs }) => launchAnyway(latestUserMessage(messages, runs))),
      Effect.orElseSucceed(() => false),
    );

  const admit = Effect.fn("ResourceLimits.admit")(function* (input: {
    readonly thread: Pick<OrchestrationV2AppThread, "id" | "lineage">;
    readonly message: Provenance;
    readonly writtenAt?: number;
  }) {
    // A buffered wake's turn is already running, paused or not; its run only gives it T3's tools.
    if (isBufferedWake(input.message)) return ADMITTED;
    const moved = yield* movedHold(input.thread.id);
    if (moved !== undefined) return { admitted: false, notice: moved } satisfies Admission;
    const now = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(snapshot);
    const { pause } = current;
    if (pause === null) {
      if (isAlicesMessage(input.message)) return ADMITTED;
    } else if (writtenDuringPause(input.message, input.writtenAt ?? now, pause)) {
      return ADMITTED;
    }
    const state = liveState(current, now);
    if (current.limits === null) return ADMITTED;
    // While every agent is paused, neither the off switch nor "launch anyway" lets work through.
    if (pause === null) {
      // While anything waits, new work queues behind it, so the governor picks what starts next.
      if (isOff(current, now)) return ADMITTED;
      if (state === "ok" && current.waiting.length === 0) return ADMITTED;
      const launcher = input.message.senderThreadId ?? input.thread.lineage.parentThreadId;
      if (launcher != null && (yield* launchAnywayIn(launcher))) return ADMITTED;
    }
    const updated = yield* Ref.updateAndGet(snapshot, (latest) =>
      latest.waiting.some((entry) => entry.threadId === input.thread.id)
        ? {
            ...latest,
            waiting: latest.waiting.map((entry) =>
              entry.threadId === input.thread.id ? { ...entry, lastHeldAt: now } : entry,
            ),
          }
        : {
            ...latest,
            waiting: [
              ...latest.waiting,
              {
                threadId: input.thread.id,
                heldAt: now,
                lastHeldAt: now,
                snoozedUntil: null,
                snoozeTried: false,
              },
            ],
          },
    );
    return {
      admitted: false,
      notice:
        pause !== null
          ? pausedReason(now)
          : waitingReason({
              state,
              reading: updated.reading,
              limits: current.limits,
              cpuAverage: updated.cpuAverage,
              machine: updated.machine,
              at: now,
            }),
    } satisfies Admission;
  });

  const refreshPause = readPause.pipe(
    Effect.tap((pause) => Ref.update(snapshot, (latest) => ({ ...latest, pause }))),
  );

  const setPause = Effect.fn("ResourceLimits.setPause")(function* (order: PauseOrder) {
    if ((yield* Ref.get(snapshot)).limits === null) {
      return { supported: false, saved: false, wasPaused: false };
    }
    const saved = yield* readPause;
    const wasPaused = saved !== null;
    if (order === "resume") {
      yield* fs.remove(pauseFile).pipe(Effect.ignore);
      const left = yield* refreshPause;
      return { supported: true, saved: left === null, wasPaused };
    }
    // Asking to pause again keeps the start, so what Alice has typed since still counts as written during the
    // pause. Asking to stop again starts over, so it also stops what she has started since.
    const pause =
      order === "finish" && saved?.mode === "finish"
        ? saved
        : { mode: order, at: yield* Clock.currentTimeMillis };
    const written = yield* writeJson(pauseFile, { version: 1, ...pause });
    if (written) yield* Ref.update(snapshot, (latest) => ({ ...latest, pause }));
    return { supported: true, saved: written, wasPaused };
  });

  const status = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(snapshot);
    if (current.limits === null) return undefined;
    const reading = current.reading;
    const bytes = (value: number | null | undefined) =>
      value === null || value === undefined ? null : Math.max(0, Math.round(value));
    return {
      state: reportedState(current, now),
      offUntil: isOff(current, now) ? current.offUntil : null,
      ...(current.pause === null ? {} : { pause: current.pause }),
      waitingThreadCount: current.waiting.length,
      sampledAt: reading?.sampledAt ?? null,
      availableBytes: bytes(reading?.availableBytes),
      commitLimitBytes: bytes(reading?.commitLimitBytes),
      committedBytes: bytes(reading?.committedBytes),
      memoryPressure: reading?.memoryPressure ?? null,
      cpuUtilization: current.cpuAverage,
      limits: current.limits,
    } satisfies ResourceLimitsStatus;
  });

  return {
    admit,
    setPause,
    movedHold,
    overflow: Ref.get(overflow),
    setOverflow: (mover: OverflowMover) => Ref.set(overflow, mover),
    refreshPause,
    status,
    read: Ref.get(snapshot),
    update: (change: (current: LimitsSnapshot) => LimitsSnapshot) =>
      Ref.updateAndGet(snapshot, change),
  };
});

export const layer = Layer.effect(ResourceLimits, make());
