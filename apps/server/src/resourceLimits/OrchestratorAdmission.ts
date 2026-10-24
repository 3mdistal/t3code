// fork: limits. The orchestrator's admission step at the places a run can start; see FORK.md.
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { isAlicesMessage, type Provenance } from "./policy.ts";
import { ResourceLimits } from "./ResourceLimits.ts";

type RunUpdated = Omit<Extract<OrchestrationV2DomainEvent, { readonly type: "run.updated" }>, "id">;
type TurnItemUpdated = Omit<
  Extract<OrchestrationV2DomainEvent, { readonly type: "turn-item.updated" }>,
  "id"
>;

/** A run the limits hold: it waits in its thread's queue, with a notice saying why. */
export interface LimitsHold {
  readonly run: RunUpdated;
  readonly notice: TurnItemUpdated;
}

type Projection = Pick<OrchestrationV2ThreadProjection, "thread" | "runs">;

const nextQueuePosition = (projection: Pick<OrchestrationV2ThreadProjection, "runs">) =>
  Math.max(
    0,
    ...projection.runs
      .filter((candidate) => candidate.status === "queued")
      .map((candidate) => candidate.queuePosition ?? candidate.ordinal),
  ) + 1;

/** Built once with the orchestrator; harnesses without the limits admit everything. */
export const makeLimitsAdmission = Effect.gen(function* () {
  const resourceLimits = yield* ResourceLimits;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const projectionStore = yield* ProjectionStoreV2;

  const admit = (thread: Projection["thread"], message: Provenance) =>
    resourceLimits
      .admit({ thread, message })
      .pipe(Effect.map((admission) => (admission.admitted ? undefined : admission.notice)));

  const noticeEvent = (
    run: OrchestrationV2Run,
    message: string,
    ordinal: number,
    now: DateTime.Utc,
  ): TurnItemUpdated => ({
    type: "turn-item.updated",
    threadId: run.threadId,
    runId: run.id,
    ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
    providerInstanceId: run.providerInstanceId,
    occurredAt: now,
    payload: {
      id: idAllocator.derive.runSignalTurnItem({ runId: run.id, signal: "limits-hold" }),
      threadId: run.threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      providerThreadId: run.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "system_notice",
      message,
    },
  });

  const hold = Effect.fn("LimitsAdmission.hold")(function* <E>(
    run: OrchestrationV2Run,
    payload: OrchestrationV2Run,
    message: string,
    ordinal: Effect.Effect<number, E>,
  ) {
    const now = yield* DateTime.now;
    return {
      run: {
        type: "run.updated",
        threadId: run.threadId,
        runId: run.id,
        ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload,
      },
      notice: noticeEvent(run, message, yield* ordinal, now),
    } satisfies LimitsHold;
  });

  /**
   * A message that would start a run with nothing to queue behind. Runs queued behind another,
   * forks and merge-backs, and runs that prepare a workspace first are decided elsewhere.
   */
  const newRunNotice = Effect.fn("LimitsAdmission.newRunNotice")(function* (input: {
    readonly projection: Projection;
    readonly message: Provenance;
    readonly mode: string;
    readonly skip: boolean;
  }) {
    if (input.skip) return undefined;
    if (input.mode !== "start_immediately" && input.mode !== "queue_after_active") return undefined;
    return yield* admit(input.projection.thread, input.message);
  });

  /**
   * The next queued run, when the queue would start it on its own. A queue with a message Alice
   * sent herself is hers to run, and someone choosing to start the queue admits it.
   */
  const holdQueuedRun = Effect.fn("LimitsAdmission.holdQueuedRun")(function* <E>(input: {
    readonly admitted: boolean | undefined;
    readonly projection: Projection & Pick<OrchestrationV2ThreadProjection, "messages">;
    readonly run: OrchestrationV2Run;
    readonly ordinal: Effect.Effect<number, E>;
  }) {
    const { projection, run } = input;
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    if (input.admitted === true || message === undefined) return undefined;
    const alicesQueue = projection.runs.some(
      (candidate) =>
        candidate.status === "queued" &&
        isAlicesMessage(projection.messages.find((item) => item.id === candidate.userMessageId)),
    );
    if (alicesQueue) return undefined;
    const notice = yield* admit(projection.thread, message);
    if (notice === undefined) return undefined;
    return yield* hold(run, { ...run, queueHeld: true }, notice, input.ordinal);
  });

  /** A run whose workspace is ready, which would start now. A held one goes to the queue instead. */
  const holdPreparedRun = Effect.fn("LimitsAdmission.holdPreparedRun")(function* <E>(input: {
    readonly projection: Projection;
    readonly run: OrchestrationV2Run;
    readonly ordinal: Effect.Effect<number, E>;
  }) {
    const { projection, run } = input;
    const message = yield* projectionStore
      .getRunMessage(projection.thread.id, run.id)
      .pipe(Effect.orElseSucceed(() => undefined));
    const notice = message === undefined ? undefined : yield* admit(projection.thread, message);
    if (notice === undefined) return undefined;
    return yield* hold(
      run,
      { ...run, status: "queued", queueHeld: true, queuePosition: nextQueuePosition(projection) },
      notice,
      input.ordinal,
    );
  });

  return { newRunNotice, noticeEvent, holdQueuedRun, holdPreparedRun };
});
