// fork: bounded idle release must record lost wakes independently of the closing reader; see FORK.md.
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import type * as EventSink from "./EventSink.ts";

export const writeClaudeWakeCancellationNotices = Effect.fn("ClaudeWakeCancellation.writeNotices")(
  function* (
    notices: ReadonlyArray<OrchestrationV2TurnItem>,
    runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
    ids: IdAllocator.IdAllocatorV2["Service"],
    sink: EventSink.EventSinkV2["Service"],
  ) {
    if (notices.length === 0) return;
    const events = yield* Effect.forEach(notices, (item) =>
      ids.allocate
        .event({ threadId: item.threadId, providerSessionId: runtime.providerSessionId })
        .pipe(
          Effect.map((id) => ({
            id,
            type: "turn-item.updated" as const,
            threadId: item.threadId,
            ...(item.runId === null ? {} : { runId: item.runId }),
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            driver: runtime.driver,
            providerInstanceId: runtime.instanceId,
            occurredAt: item.updatedAt,
            payload: item,
          })),
        ),
    );
    yield* sink.write({ events });
  },
);
