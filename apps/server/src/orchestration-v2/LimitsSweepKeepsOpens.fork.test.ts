import * as NetAddress from "effect/net/NetAddress";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const driver = ProviderDriverKind.make("codex");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;

const unused = (detail: string) =>
  Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));

// A provider whose sessions take several app threads and stay up.
const layerAdapter = ProviderAdapterRegistry.layerSingle(
  ProviderAdapter.ProviderAdapterV2.of({
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId: modelSelection.instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            status: "ready",
            cwd: process.cwd(),
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          backgroundTasksEndWithProcess: true as const,
          ensureThread: () => unused("ensureThread unused in test"),
          resumeThread: (threadInput) => Effect.succeed(threadInput.providerThread),
          startTurn: () => Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          unloadThread: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unused("readThreadSnapshot unused in test"),
          rollbackThread: () => unused("rollbackThread unused in test"),
          forkThread: () => unused("forkThread unused in test"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  }),
);

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);

// Holds the write that records a thread attaching to a live session, once armed.
const layerPausingAttachEventSink = (pause: {
  readonly armed: Ref.Ref<boolean>;
  readonly paused: Deferred.Deferred<void>;
}) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          Effect.gen(function* () {
            const attach = input.events.some((event) => event.type === "provider-session.attached");
            if (attach && (yield* Ref.getAndSet(pause.armed, false))) {
              yield* Deferred.succeed(pause.paused, undefined);
              return yield* Effect.never;
            }
            return yield* delegate.write(input);
          }),
      });
    }),
  ).pipe(
    Layer.provide(
      EventSink.layer.pipe(Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase))),
    ),
  );

const layerMcpRegistry = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make(),
).pipe(
  Layer.provide(
    Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
  ),
  Layer.provide(
    Layer.succeed(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-fork-limits-sweep")),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const layerTest = (pause: Parameters<typeof layerPausingAttachEventSink>[0]) => {
  const layerEventSink = layerPausingAttachEventSink(pause);
  const layerIngestor = ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          // @effect-diagnostics-next-line effectSucceedWithVoid:off - Optional instances require undefined rather than void.
          getInstance: () => Effect.succeed(undefined),
        }),
        layerEventSink,
        IdAllocator.layer,
        layerTestStores,
        ThreadCommandExecutor.layer,
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolveBranchName: () => Effect.succeed(null),
        }),
      ),
    ),
  );
  return Layer.mergeAll(
    layerTestStores,
    layerEventSink,
    IdAllocator.layer,
    ProviderSessionManager.layerWithOptions({ idleTimeoutMs: 60_000 }).pipe(
      Layer.provide(
        Layer.mergeAll(
          layerAdapter,
          McpProviderSessions.layer,
          CommandOutputHub.layer.pipe(Layer.provide(Layer.merge(layerEventSink, layerTestStores))),
          layerEventSink,
          IdAllocator.layer,
          layerIngestor,
          layerMcpRegistry,
          layerTestStores,
        ),
      ),
    ),
  ).pipe(Layer.provide(NodeServices.layer));
};

const threadCreated = (
  idAllocator: IdAllocator.IdAllocatorV2["Service"],
  threadId: ThreadId,
  now: DateTime.Utc,
) =>
  Effect.gen(function* () {
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: yield* idAllocator.allocate.project({ fixtureName: "fork-limits-sweep" }),
      title: "Memory sweep",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: idAllocator.derive.providerThread({
        driver,
        nativeThreadId: `native-${threadId}`,
      }),
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return {
      id: yield* idAllocator.allocate.event({ threadId }),
      type: "thread.created" as const,
      threadId,
      occurredAt: now,
      payload: thread,
    };
  });

// Attaching a thread to a live session leaves its idle generation alone until the open ends, and the
// thread may have no run the sweep can see yet. Sol found the sweep could close the session meanwhile.
it.effect("the memory sweep keeps a session while an open attaches a thread to it", () =>
  Effect.gen(function* () {
    const armed = yield* Ref.make(false);
    const paused = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const owner = ThreadId.make("thread-fork-limits-sweep-owner");
      const joining = ThreadId.make("thread-fork-limits-sweep-joining");
      const providerSessionId = idAllocator.derive.providerSession({
        providerInstanceId: modelSelection.instanceId,
      });
      yield* eventSink.write({
        events: [
          yield* threadCreated(idAllocator, owner, now),
          yield* threadCreated(idAllocator, joining, now),
        ],
      });
      yield* sessions.open({ threadId: owner, providerSessionId, modelSelection, runtimePolicy });

      yield* Ref.set(armed, true);
      const joiningOpen = yield* sessions
        .open({ threadId: joining, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(paused);
      assert.deepEqual(yield* sessions.releaseIdleSessions!({ keepThreadIds: new Set() }), []);
      assert.isTrue(yield* sessions.isLive(providerSessionId));

      // An open that ends without finishing, here interrupted, leaves the session to the next sweep.
      yield* Fiber.interrupt(joiningOpen);
      assert.deepEqual(yield* sessions.releaseIdleSessions!({ keepThreadIds: new Set() }), [
        providerSessionId,
      ]);
    }).pipe(Effect.provide(layerTest({ armed, paused })));
  }),
);
