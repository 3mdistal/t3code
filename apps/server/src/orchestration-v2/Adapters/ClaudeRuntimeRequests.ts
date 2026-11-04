import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export interface ClaudeRequestArtifacts {
  readonly node: OrchestrationV2ExecutionNode;
  readonly request: OrchestrationV2RuntimeRequest;
  readonly turnItem: OrchestrationV2TurnItem;
}

export const makeClaudeRuntimeRequests = Effect.fn("ClaudeRuntimeRequests.make")(function* <
  Pending,
>(publish: (artifacts: ClaudeRequestArtifacts) => Effect.Effect<void>) {
  const lock = yield* Semaphore.make(1);
  type Entry = {
    readonly pending: Pending;
    readonly owner: string;
    readonly root: boolean;
    readonly artifacts: ClaudeRequestArtifacts;
    readonly retired: Deferred.Deferred<void>;
  };
  const entries = new Map<string, Entry>();
  const retire = Effect.fn("ClaudeRuntimeRequests.retire")(function* (entry: Entry) {
    const id = String(entry.artifacts.request.id);
    if (entries.get(id) !== entry) return;
    entries.delete(id);
    const now = yield* DateTime.now;
    const { node, request, turnItem } = entry.artifacts;
    yield* publish({
      node: { ...node, status: "cancelled", completedAt: now },
      request: {
        ...request,
        status: "resolved",
        responseCapability: {
          type: "not_resumable",
          reason: "Claude moved past this request. Its tool was not approved.",
        },
        resolvedAt: now,
      },
      turnItem: { ...turnItem, status: "cancelled", completedAt: now, updatedAt: now },
    });
    yield* Deferred.succeed(entry.retired, undefined);
  });
  return {
    register: Effect.fn("ClaudeRuntimeRequests.register")(function* (
      input: Omit<Entry, "retired">,
    ) {
      const entry: Entry = { ...input, retired: yield* Deferred.make<void>() };
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          entries.set(String(entry.artifacts.request.id), entry);
          yield* publish(entry.artifacts);
        }),
      );
      return entry;
    }),
    snapshot: (owner: string) =>
      [...entries.values()].filter((entry) => entry.owner === owner && entry.root),
    retire: (entry: Entry) => lock.withPermits(1)(retire(entry)),
    retireAll: (snapshot: ReadonlyArray<Entry>) =>
      lock.withPermits(1)(Effect.forEach(snapshot, retire, { discard: true })),
    respond: <E>(id: string, deliver: (pending: Pending) => Effect.Effect<void, E>) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const entry = entries.get(id);
          if (entry === undefined) return false;
          yield* deliver(entry.pending);
          entries.delete(id);
          return true;
        }),
      ),
    remove: (entry: Entry) =>
      lock.withPermits(1)(
        Effect.sync(() => {
          const id = String(entry.artifacts.request.id);
          if (entries.get(id) === entry) entries.delete(id);
        }),
      ),
  };
});
