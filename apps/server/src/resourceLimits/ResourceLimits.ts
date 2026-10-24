// fork: limits. Who may start a run while the machine is over its limits; see FORK.md.
import type {
  EffectiveResourceLimits,
  OrchestrationV2AppThread,
  ResourceLimitsState,
  ResourceLimitsStatus,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  effectiveLimits,
  type HostReading,
  isAlicesMessage,
  latestUserMessage,
  launchAnyway,
  type Provenance,
  TIMING,
  waitingReason,
} from "./policy.ts";

export interface WaitingThread {
  readonly threadId: ThreadId;
  readonly heldAt: number;
  /** The snooze the limits put on the thread, so a release ends only that one. */
  readonly snoozedUntil: string | null;
  /** Upstream refuses to snooze a thread with a queued message of its own, so this isn't retried. */
  readonly snoozeTried: boolean;
}

export interface LimitsSnapshot {
  /** Null where the fork has no limits (Linux keeps upstream's cap). */
  readonly limits: EffectiveResourceLimits | null;
  readonly state: ResourceLimitsState;
  readonly reading: HostReading | null;
  readonly cpuAverage: number | null;
  readonly offUntil: number | null;
  readonly machine: string;
  /** Threads holding work for the limits, oldest first. */
  readonly waiting: ReadonlyArray<WaitingThread>;
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

const UNLIMITED: LimitsSnapshot = {
  limits: null,
  state: "ok",
  reading: null,
  cpuAverage: null,
  offUntil: null,
  machine: "This machine",
  waiting: [],
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
  }) => Effect.Effect<Admission>;
  readonly status: Effect.Effect<ResourceLimitsStatus | undefined>;
  /** The governor's readings and the waiting list, which only the governor prunes and releases. */
  readonly read: Effect.Effect<LimitsSnapshot>;
  readonly update: (
    change: (snapshot: LimitsSnapshot) => LimitsSnapshot,
  ) => Effect.Effect<LimitsSnapshot>;
}>("t3/resourceLimits/ResourceLimits", {
  defaultValue: () => ({
    admit: () => Effect.succeed(ADMITTED),
    status: Effect.succeed(undefined),
    read: Effect.succeed(UNLIMITED),
    update: () => Effect.succeed(UNLIMITED),
  }),
}) {}

const make = Effect.fn("makeResourceLimits")(function* () {
  const platform = yield* HostProcess.Platform;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const snapshot = yield* Ref.make<LimitsSnapshot>({
    ...UNLIMITED,
    limits: effectiveLimits({}, platform),
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
  }) {
    if (isAlicesMessage(input.message)) return ADMITTED;
    const now = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(snapshot);
    const state = liveState(current, now);
    // While anything waits, new work queues behind it, so release order stays oldest first.
    if (current.limits === null || isOff(current, now)) return ADMITTED;
    if (state === "ok" && current.waiting.length === 0) return ADMITTED;
    const launcher = input.message.senderThreadId ?? input.thread.lineage.parentThreadId;
    if (launcher != null && (yield* launchAnywayIn(launcher))) return ADMITTED;
    const updated = yield* Ref.updateAndGet(snapshot, (latest) =>
      latest.waiting.some((entry) => entry.threadId === input.thread.id)
        ? latest
        : {
            ...latest,
            waiting: [
              ...latest.waiting,
              { threadId: input.thread.id, heldAt: now, snoozedUntil: null, snoozeTried: false },
            ],
          },
    );
    return {
      admitted: false,
      notice: waitingReason({
        state,
        reading: updated.reading,
        limits: current.limits,
        cpuAverage: updated.cpuAverage,
        machine: updated.machine,
        at: now,
      }),
    } satisfies Admission;
  });

  const status = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(snapshot);
    if (current.limits === null) return undefined;
    const reading = current.reading;
    const bytes = (value: number | null | undefined) =>
      value === null || value === undefined ? null : Math.max(0, Math.round(value));
    return {
      state: liveState(current, now),
      offUntil: isOff(current, now) ? current.offUntil : null,
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
    status,
    read: Ref.get(snapshot),
    update: (change: (current: LimitsSnapshot) => LimitsSnapshot) =>
      Ref.updateAndGet(snapshot, change),
  };
});

export const layer = Layer.effect(ResourceLimits, make());
