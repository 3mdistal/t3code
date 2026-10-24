import {
  findProviderPool,
  providerPoolDriver,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import { ProviderPoolCatalog } from "./ProviderPoolCatalog.ts";
import { routeModelSelection, type RoutedSelection } from "./ProviderPoolRouting.ts";

export interface PoolRoutingInput {
  readonly selection: ModelSelection;
  readonly current: { readonly instanceId: ProviderInstanceId; readonly busy: boolean } | null;
  readonly threadId: ThreadId;
  readonly projectId: OrchestrationV2AppThread["projectId"];
  readonly excluded?: ReadonlySet<ProviderInstanceId>;
}

/** The orchestrator's routing step, built once with the services it reads. */
export const makePoolRouting = Effect.gen(function* () {
  const poolCatalog = yield* ProviderPoolCatalog;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  /**
   * Runs wherever a selection enters a thread, so everything downstream only
   * ever sees a concrete member: run, thread, session, and adapter ids never
   * carry a pool id.
   */
  const resolveRouting = Effect.fn("Orchestrator.resolveRouting")(function* (
    input: PoolRoutingInput,
  ): Effect.fn.Return<RoutedSelection> {
    const providers = yield* poolCatalog.getPublishedProviders;
    // Most dispatches name no pool; keep the settings read off that path.
    if (
      findProviderPool(providers, input.selection.instanceId) === null &&
      providerPoolDriver(input.selection.instanceId) === null
    ) {
      return { type: "unrouted", selection: input.selection };
    }
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    return routeModelSelection({
      selection: input.selection,
      providers,
      settings,
      projectId: input.projectId,
      threadId: input.threadId,
      current: input.current,
      ...(input.excluded === undefined ? {} : { excluded: input.excluded }),
      nowMs,
    });
  });

  return { resolveRouting, getPublishedProviders: poolCatalog.getPublishedProviders };
});

export const noEligibleMemberCause = (
  routed: Extract<RoutedSelection, { readonly type: "no_eligible_member" }>,
): string =>
  `No account in the ${routed.pool.displayName ?? routed.pool.driver} pool is enabled for this project.`;

/**
 * A queued run was pinned to a member at dispatch. Routing it again at
 * promotion lets a run queued behind a member that has since cooled start
 * on a healthy sibling instead of holding the queue. Returns the moved run
 * and the events that move it, or null when it stays where it is.
 */
export function planQueuedRunRepin(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly queuedRun: OrchestrationV2Run;
  readonly routed: RoutedSelection;
  readonly now: DateTime.Utc;
  /** The thread's newest root provider thread on that instance, if it has one. */
  readonly providerThreadFor: (
    instanceId: ProviderInstanceId,
  ) => OrchestrationV2ProviderThread | undefined;
  readonly deriveProviderThreadId: (input: {
    readonly driver: ProviderDriverKind;
    readonly nativeThreadId: string;
  }) => OrchestrationV2ProviderThread["id"];
}): {
  readonly run: OrchestrationV2Run;
  readonly events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>;
} | null {
  const { projection, queuedRun, routed, now } = input;
  const threadId = projection.thread.id;
  if (routed.type !== "routed") return null;
  const instanceId = routed.selection.instanceId;
  if (instanceId === queuedRun.providerInstanceId) return null;
  const attempt = projection.attempts.find(
    (candidate) => candidate.id === queuedRun.activeAttemptId,
  );
  const rootNode = projection.nodes.find((candidate) => candidate.id === queuedRun.rootNodeId);
  const previousThread = projection.providerThreads.find(
    (candidate) => candidate.id === queuedRun.providerThreadId,
  );
  if (attempt === undefined || rootNode === undefined || previousThread === undefined) {
    return null;
  }
  const providerThread: OrchestrationV2ProviderThread = input.providerThreadFor(instanceId) ?? {
    ...previousThread,
    id: input.deriveProviderThreadId({
      driver: previousThread.driver,
      nativeThreadId: `pending:${queuedRun.id}:${instanceId}`,
    }),
    providerInstanceId: instanceId,
    providerSessionId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    handoffIds: [],
    createdAt: now,
    updatedAt: now,
  };
  const run: OrchestrationV2Run = {
    ...queuedRun,
    providerInstanceId: instanceId,
    modelSelection: routed.selection,
    providerThreadId: providerThread.id,
  };
  const events = [
    ...(providerThread.id === previousThread.id
      ? []
      : [
          {
            type: "provider-thread.updated" as const,
            threadId,
            driver: providerThread.driver,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: providerThread,
          },
        ]),
    {
      type: "run.updated" as const,
      threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: run,
    },
    {
      type: "run-attempt.updated" as const,
      threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: {
        ...attempt,
        providerInstanceId: instanceId,
        providerThreadId: providerThread.id,
      },
    },
    {
      type: "node.updated" as const,
      threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: { ...rootNode, providerThreadId: providerThread.id },
    },
  ];
  return { run, events };
}
