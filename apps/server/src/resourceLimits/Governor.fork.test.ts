import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationMessageContext,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadStatus,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Governor from "./Governor.ts";
import * as Overflow from "./Overflow.ts";
import { makePassRecord, MAX_PASSES, PHASE_WRITE_MS } from "./PassRecord.ts";
import { GiB, type HostReading, type ProcessRow, TIMING } from "./policy.ts";
import { ProcessTree } from "./ProcessTree.ts";
import * as ResourceLimits from "./ResourceLimits.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerProjections = ProjectionStore.layer.pipe(Layer.provide(layerDatabase));
// The PC's limits, wherever the tests run.
const layerLimits = ResourceLimits.layer.pipe(
  Layer.provide(layerProjections),
  Layer.provide(Layer.succeed(HostProcess.Platform, "win32")),
  Layer.provide(Layer.succeed(ResourceLimits.TotalMemoryBytes, 128 * GiB)),
);
const layerTestWith = (settings: Parameters<typeof ServerSettings.layerTest>[0] = {}) =>
  ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        layerProjections,
        EventStore.layer.pipe(Layer.provide(layerDatabase)),
        EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "resource-limits" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: layerDatabase, runEffectWorker: false },
        ),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest(settings)),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
    Layer.provideMerge(layerLimits),
    // The same per-thread lock the orchestrator takes, by layer memoization, as the server shares it with the mover.
    Layer.provideMerge(ThreadCommandExecutor.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-resource-limits-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
const layerTest = layerTestWith();

/** A process table that never changes, and ends nothing. */
const quietProcessTree: ProcessTree["Service"] = {
  read: Effect.succeed([]),
  end: () => Effect.succeed("ended"),
};

/** A governor whose idle-session closing is recorded, with the state admission saw at the time. */
const makeGovernorWith = Effect.fnUntraced(function* (
  sessions: ProviderSessionManager.ProviderSessionManagerV2["Service"],
  processTree: ProcessTree["Service"] = quietProcessTree,
  platform: NodeJS.Platform = "win32",
) {
  const limits = yield* ResourceLimits.ResourceLimits;
  const closings = yield* Ref.make<ReadonlyArray<string>>([]);
  const governor = yield* Governor.make().pipe(
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(ResourceLimits.TotalMemoryBytes, 128 * GiB),
    Effect.provideService(ProcessTree, processTree),
    Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
      ...sessions,
      releaseIdleSessions: () =>
        limits.read.pipe(
          Effect.flatMap((snapshot) => Ref.update(closings, (all) => [...all, snapshot.state])),
          Effect.as([] as ReadonlyArray<ProviderSessionId>),
        ),
    }),
  );
  return { ...governor, closings: Ref.get(closings) };
});
const makeGovernor = Effect.flatMap(
  ProviderSessionManager.ProviderSessionManagerV2,
  makeGovernorWith,
);

const reading = (headroom: number, available: number) =>
  Effect.map(Clock.currentTimeMillis, (sampledAt): HostReading => ({
    sampledAt,
    availableBytes: available * GiB,
    totalBytes: 128 * GiB,
    commitLimitBytes: 135 * GiB,
    committedBytes: (135 - headroom) * GiB,
    memoryPressure: null,
    cpuUtilization: null,
  }));
const comfortable = reading(40, 20);
// Just over the release lines, with no room to start more than one session at a time.
const recovered = reading(36, 13);
const tight = reading(20, 20);
const critical = reading(5, 20);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:resource-limits"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const alice = { createdBy: "user", creationSource: "web" } as const;
const agent = { createdBy: "agent", creationSource: "mcp" } as const;
// What the MCP tools send for a tag in an app on `typedInApps`, such as a Content comment.
const tagged = {
  ...agent,
  context: { version: 1, records: [], typedIn: { app: "Content" } },
} as const;

const send = (
  threadId: ThreadId,
  text: string,
  from: {
    readonly createdBy: "user" | "agent";
    readonly creationSource: "web" | "mcp";
    readonly scheduledTaskId?: ScheduledTaskId;
    readonly senderThreadId?: ThreadId;
    readonly context?: OrchestrationMessageContext;
  },
  type: "start_immediately" | "queue_after_active" = "start_immediately",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      ...from,
    });
  });

const runs = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`);
  });

/** Resolves once a later run update in the thread matches; the queue is promoted after a commit. */
const awaitRunUpdate = (threadId: ThreadId, matches: (run: OrchestrationV2Run) => boolean) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* sink.latestSequence();
    return sink.stream({ afterSequence, threadId, eventType: "run.updated" }).pipe(
      Stream.filter(
        (stored) => stored.event.type === "run.updated" && matches(stored.event.payload),
      ),
      Stream.take(1),
      Stream.runDrain,
    );
  });

const endRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (candidate) => candidate.status === "starting",
    )!;
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(`end:${run.id}`),
      threadId,
      runId: run.id,
    });
  });

const notices = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return projection.turnItems.flatMap((item) =>
      item.type === "system_notice" ? [item.message] : [],
    );
  });

it.effect("R2: agent and schedule work waits with a notice, and Alice's own message starts", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const [mine, theirs, scheduled] = ["mine", "theirs", "scheduled"].map((name) =>
      ThreadId.make(`thread:r2:${name}`),
    ) as [ThreadId, ThreadId, ThreadId];
    yield* Effect.forEach([mine, theirs, scheduled], createThread);

    yield* governor.pass(yield* tight);
    yield* send(theirs, "agent work", agent);
    yield* send(scheduled, "daily check", {
      ...alice,
      scheduledTaskId: ScheduledTaskId.make("task:daily"),
    });
    yield* send(mine, "my own message", alice);
    yield* send(mine, "relayed", { ...alice, senderThreadId: theirs }, "queue_after_active");

    assert.deepEqual(yield* runs(theirs), ["queued:held"]);
    assert.deepEqual(yield* runs(scheduled), ["queued:held"]);
    assert.deepEqual(yield* runs(mine), ["starting", "queued"]);
    const [notice] = yield* notices(theirs);
    assert.include(notice, "because This machine was over its limits (commit headroom 20.0 GiB");
    assert.include(notice, "oldest first. Choose Resume to start it now.");
  }).pipe(Effect.provide(layerTest)),
);

it.effect('R2: Alice\'s "launch anyway" in the launching thread lets its work through', () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const parent = ThreadId.make("thread:r2:parent");
    const child = ThreadId.make("thread:r2:child");
    const other = ThreadId.make("thread:r2:other");
    yield* Effect.forEach([parent, child, other], createThread);
    yield* governor.pass(yield* tight);

    yield* send(parent, "Launch anyway!", alice);
    yield* send(child, "launched work", { ...agent, senderThreadId: parent });
    yield* send(other, "launch anyway", agent);
    yield* send(
      other,
      "launched by an agent",
      { ...agent, senderThreadId: other },
      "queue_after_active",
    );

    assert.deepEqual(yield* runs(child), ["starting"]);
    assert.deepEqual(yield* runs(other), ["queued:held", "queued:held"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("R2: work queued behind a turn waits when the turn ends over the limits", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:r2:behind");
    yield* createThread(threadId);
    yield* send(threadId, "first", alice);
    yield* send(threadId, "agent follow-up", agent, "queue_after_active");
    yield* governor.pass(yield* tight);
    assert.deepEqual(yield* runs(threadId), ["starting", "queued"]);

    const held = yield* awaitRunUpdate(threadId, (run) => run.queueHeld === true);
    yield* endRun(threadId);
    yield* held;
    assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);
    assert.lengthOf(yield* notices(threadId), 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("R2: Start now starts held work, and Alice's queued message isn't stuck behind it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const governor = yield* makeGovernor;
    const held = ThreadId.make("thread:r2:start-now");
    const busy = ThreadId.make("thread:r2:busy");
    yield* Effect.forEach([held, busy], createThread);
    yield* governor.pass(yield* tight);

    yield* send(held, "agent work", agent);
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("start-now"),
      threadId: held,
    });
    assert.deepEqual(yield* runs(held), ["starting"]);

    yield* send(busy, "first", alice);
    yield* send(busy, "agent follow-up", agent, "queue_after_active");
    yield* send(busy, "mine after it", alice, "queue_after_active");
    const started = yield* awaitRunUpdate(busy, (run) => run.status === "starting");
    yield* endRun(busy);
    yield* started;
    assert.deepEqual(yield* runs(busy), ["interrupted", "starting", "queued"]);
  }).pipe(Effect.provide(layerTest)),
);

const waitingThreads = Effect.map(
  Effect.flatMap(ResourceLimits.ResourceLimits, (limits) => limits.read),
  (snapshot) => snapshot.waiting.map((entry) => entry.threadId),
);

/** A governor that runs `during` once, just before a pass takes a thread off the line. */
const makeGovernorInterrupted = (during: Effect.Effect<unknown>) =>
  Effect.gen(function* () {
    const limits = yield* ResourceLimits.ResourceLimits;
    const armed = yield* Ref.make(true);
    const service: typeof limits = {
      ...limits,
      update: (change) =>
        Effect.gen(function* () {
          const before = yield* limits.read;
          if (
            change(before).waiting.length < before.waiting.length &&
            (yield* Ref.getAndSet(armed, false))
          ) {
            yield* during;
          }
          return yield* limits.update(change);
        }),
    };
    return yield* makeGovernor.pipe(Effect.provideService(ResourceLimits.ResourceLimits, service));
  });

it.effect("R2: a thread stays in line when a pass runs before its held run is written", () =>
  Effect.gen(function* () {
    const limits = yield* ResourceLimits.ResourceLimits;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:r2:unwritten");
    yield* createThread(threadId);
    yield* governor.pass(yield* tight);

    // Admission records the thread a moment before its run is written, and a pass lands between them.
    const { thread } = yield* orchestrator.getThreadProjection(threadId);
    yield* limits.admit({ thread, message: agent });
    yield* governor.pass(yield* tight);
    assert.deepEqual(yield* waitingThreads, [threadId]);

    // A run that never comes doesn't keep it there.
    yield* TestClock.adjust(TIMING.holdWriteMs);
    yield* governor.pass(yield* tight);
    assert.deepEqual(yield* waitingThreads, []);
  }).pipe(Effect.provide(layerTest)),
);

/** A governor that reads each run through `seen`, for states the orchestrator reaches only during a command. */
const makeGovernorSeeing = (seen: (run: OrchestrationV2Run, index: number) => OrchestrationV2Run) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return yield* makeGovernor.pipe(
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        ...projections,
        getThreadRecords: (id, fields, filter) =>
          projections.getThreadRecords(id, fields, filter).pipe(
            Effect.map((records) => {
              const { runs: all } = records as { runs?: ReadonlyArray<OrchestrationV2Run> };
              return (
                all === undefined ? records : { ...records, runs: all.map(seen) }
              ) as typeof records;
            }),
          ),
      }),
    );
  });

it.effect("R2: a thread stays in line while its preparing run waits to be held", () =>
  Effect.gen(function* () {
    const limits = yield* ResourceLimits.ResourceLimits;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:r2:preparing");
    yield* createThread(threadId);
    yield* send(threadId, "workspace first", alice);
    // A run that prepares a workspace is still preparing when admission holds it.
    const governor = yield* makeGovernorSeeing((run) => ({ ...run, status: "preparing" }));
    yield* governor.pass(yield* tight);

    const { thread } = yield* orchestrator.getThreadProjection(threadId);
    yield* limits.admit({ thread, message: agent });
    yield* governor.pass(yield* tight);
    assert.deepEqual(yield* waitingThreads, [threadId]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("R2: a new thread stays in line until the thread and its held run are written", () =>
  Effect.gen(function* () {
    const limits = yield* ResourceLimits.ResourceLimits;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const governor = yield* makeGovernor;
    const parent = ThreadId.make("thread:r2:parent-of-new");
    yield* createThread(parent);
    yield* governor.pass(yield* tight);

    // A delegated child is held in the same command that creates it, so it's on the line before it exists.
    const child = ThreadId.make("thread:r2:new");
    const { thread } = yield* orchestrator.getThreadProjection(parent);
    yield* limits.admit({ thread: { ...thread, id: child }, message: agent });
    yield* governor.pass(yield* tight);
    assert.deepEqual(yield* waitingThreads, [child]);

    yield* TestClock.adjust(TIMING.holdWriteMs);
    yield* governor.pass(yield* tight);
    assert.deepEqual(yield* waitingThreads, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("R2: an archived thread leaves the line at once", () =>
  Effect.gen(function* () {
    const limits = yield* ResourceLimits.ResourceLimits;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:r2:archived");
    yield* createThread(threadId);
    yield* governor.pass(yield* tight);

    const { thread } = yield* orchestrator.getThreadProjection(threadId);
    yield* limits.admit({ thread, message: agent });
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId,
    });
    yield* governor.pass(yield* tight);
    assert.deepEqual(yield* waitingThreads, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("R2: a hold that lands during a long pass counts from when it landed", () =>
  Effect.gen(function* () {
    const limits = yield* ResourceLimits.ResourceLimits;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const threadId = ThreadId.make("thread:r2:long-pass");
    yield* createThread(threadId);
    const ordinary = yield* makeGovernor;
    yield* ordinary.pass(yield* tight);

    // Closing idle sessions outlasts the wait for the write, and the thread is held just as it finishes.
    const { thread } = yield* orchestrator.getThreadProjection(threadId);
    const governor = yield* Governor.make().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(ResourceLimits.TotalMemoryBytes, 128 * GiB),
      Effect.provideService(ProcessTree, quietProcessTree),
      Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
        ...sessions,
        releaseIdleSessions: () =>
          Effect.gen(function* () {
            yield* TestClock.adjust(TIMING.holdWriteMs + 1_000);
            const fresh = yield* tight;
            yield* limits.update((snapshot) => ({ ...snapshot, reading: fresh }));
            yield* limits.admit({ thread, message: agent });
            return [];
          }),
      }),
    );
    yield* governor.pass(yield* tight);
    assert.deepEqual(yield* waitingThreads, [threadId]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("R2: a clock set back doesn't keep an empty thread in line", () =>
  Effect.gen(function* () {
    const limits = yield* ResourceLimits.ResourceLimits;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:r2:clock");
    yield* createThread(threadId);
    yield* governor.pass(yield* tight);

    const { thread } = yield* orchestrator.getThreadProjection(threadId);
    yield* limits.admit({ thread, message: agent });
    const dayAhead = (yield* Clock.currentTimeMillis) + 86_400_000;
    yield* limits.update((snapshot) => ({
      ...snapshot,
      waiting: snapshot.waiting.map((entry) => ({ ...entry, lastHeldAt: dayAhead })),
    }));
    yield* governor.pass(yield* tight);
    assert.deepEqual(yield* waitingThreads, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("R2: a thread held again during a pass stays in line until its run is released", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:r2:held-again");
    yield* createThread(threadId);
    const governor = yield* makeGovernorInterrupted(
      send(threadId, "held again", agent).pipe(
        Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
        Effect.orDie,
      ),
    );
    yield* governor.pass(yield* tight);
    yield* send(threadId, "agent work", agent);
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("start-now"),
      threadId,
    });
    yield* endRun(threadId);
    yield* TestClock.adjust(TIMING.holdWriteMs);

    // Nothing is left, so this pass takes the thread off, and the new hold lands before it does.
    yield* governor.pass(yield* tight);
    assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);
    assert.deepEqual(yield* waitingThreads, [threadId]);

    yield* TestClock.adjust(TIMING.passMs);
    yield* governor.pass(yield* comfortable);
    assert.deepEqual(yield* runs(threadId), ["interrupted", "starting"]);
  }).pipe(Effect.provide(layerTest)),
);

const stopAfterStartingByHand = (name: string, followUpBeforePass: boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make(`thread:r2:${name}`);
    yield* createThread(threadId);
    yield* governor.pass(yield* tight);
    yield* send(threadId, "agent work", agent);
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("start-now"),
      threadId,
    });
    const followUp = send(threadId, "agent follow-up", agent, "queue_after_active");
    if (followUpBeforePass) yield* followUp;
    yield* TestClock.adjust(TIMING.passMs);
    yield* governor.pass(yield* comfortable);
    assert.deepEqual(yield* waitingThreads, []);

    if (!followUpBeforePass) yield* followUp;
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop"),
      threadId,
      reason: "Stopped.",
      stopDelegatedTasks: false,
    });
    yield* TestClock.adjust(TIMING.passMs);
    yield* governor.pass(yield* comfortable);
    assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);
  }).pipe(Effect.provide(layerTest));

it.effect("R2: a thread started by hand leaves the line, so Stop stays stopped", () =>
  stopAfterStartingByHand("stop", false),
);

it.effect("R2: work queued behind a run started by hand doesn't keep it in line", () =>
  stopAfterStartingByHand("stop-queued", true),
);

it.effect(
  "R2: a run held behind a started one stays in line, with nothing else to release it",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:r2:held-behind");
      yield* createThread(threadId);
      const governor = yield* makeGovernorSeeing((run, index) =>
        index === 0 ? { ...run, status: "starting" } : run,
      );
      yield* governor.pass(yield* tight);
      yield* send(threadId, "agent work", agent);
      yield* send(threadId, "more agent work", agent, "queue_after_active");
      assert.deepEqual(yield* runs(threadId), ["queued:held", "queued:held"]);

      yield* TestClock.adjust(TIMING.holdWriteMs);
      yield* governor.pass(yield* tight);
      assert.deepEqual(yield* waitingThreads, [threadId]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "R3: a thread held again during its release stays in line until the run has started",
  () =>
    Effect.gen(function* () {
      const limits = yield* ResourceLimits.ResourceLimits;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:r3:held-again");
      yield* createThread(threadId);
      const { thread } = yield* orchestrator.getThreadProjection(threadId);
      // The clock doesn't move, so the two holds share a millisecond.
      const governor = yield* makeGovernorInterrupted(limits.admit({ thread, message: agent }));
      yield* governor.pass(yield* tight);
      yield* send(threadId, "agent work", agent);
      assert.deepEqual(yield* runs(threadId), ["queued:held"]);

      yield* governor.pass(yield* recovered);
      assert.deepEqual(yield* runs(threadId), ["starting"]);
      assert.deepEqual(yield* waitingThreads, [threadId]);

      yield* TestClock.adjust(TIMING.passMs);
      yield* governor.pass(yield* recovered);
      assert.deepEqual(yield* waitingThreads, []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("R3: held threads start oldest first, at least 90 s apart, near the lines", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const threads = ["a", "b", "c"].map((name) => ThreadId.make(`thread:r3:${name}`));
    yield* Effect.forEach(threads, createThread);
    yield* governor.pass(yield* tight);
    for (const threadId of threads) {
      yield* send(threadId, "agent work", agent);
      yield* TestClock.adjust("1 second");
    }
    const states = Effect.forEach(threads, (threadId) =>
      runs(threadId).pipe(Effect.map((all) => all.join())),
    );

    yield* governor.pass(yield* recovered);
    assert.deepEqual(yield* states, ["starting", "queued:held", "queued:held"]);

    // New work queues behind the threads already waiting, even with memory back.
    const late = ThreadId.make("thread:r3:late");
    yield* createThread(late);
    yield* send(late, "agent work", agent);
    assert.deepEqual(yield* runs(late), ["queued:held"]);

    yield* TestClock.adjust(TIMING.releaseSpacingMs - 1_000);
    yield* governor.pass(yield* recovered);
    assert.deepEqual(yield* states, ["starting", "queued:held", "queued:held"]);

    yield* TestClock.adjust("1 second");
    yield* governor.pass(yield* tight);
    assert.deepEqual(yield* states, ["starting", "queued:held", "queued:held"]);

    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* recovered);
    assert.deepEqual(yield* states, ["starting", "starting", "queued:held"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("R3: with room for each new session to grow, held threads start every pass", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const threads = ["a", "b", "c", "d"].map((name) => ThreadId.make(`thread:r3-room:${name}`));
    yield* Effect.forEach(threads, createThread);
    yield* governor.pass(yield* tight);
    for (const threadId of threads) {
      yield* send(threadId, "agent work", agent);
      yield* TestClock.adjust("1 second");
    }
    const started = Effect.forEach(threads, (threadId) =>
      runs(threadId).pipe(Effect.map((all) => all.join() === "starting")),
    );

    // Room over the release lines for three sessions of 2 GiB each.
    const roomy = reading(44, 20);
    yield* governor.pass(yield* roomy);
    yield* TestClock.adjust("60 seconds");
    yield* governor.pass(yield* roomy);
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* roomy);
    assert.deepEqual(yield* started, [true, true, true, false]);

    // The fourth waits while the first is still growing, and starts once it has had two
    // minutes, 45 s after the third.
    yield* TestClock.adjust("30 seconds");
    yield* governor.pass(yield* roomy);
    assert.deepEqual(yield* started, [true, true, true, false]);
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* roomy);
    assert.deepEqual(yield* started, [true, true, true, true]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("R3: a restart keeps counting the sessions still growing", () =>
  Effect.gen(function* () {
    const first = yield* makeGovernor;
    const threads = ["a", "b", "c"].map((name) => ThreadId.make(`thread:r3-restart:${name}`));
    yield* Effect.forEach(threads, createThread);
    yield* first.pass(yield* tight);
    for (const threadId of threads) {
      yield* send(threadId, "agent work", agent);
      yield* TestClock.adjust("1 second");
    }
    const started = Effect.forEach(threads, (threadId) =>
      runs(threadId).pipe(Effect.map((all) => all.join() === "starting")),
    );

    // Room for two sessions over the 12.3 GiB available line, not three.
    const twoRoom = reading(44, 17);
    yield* first.pass(yield* twoRoom);
    yield* TestClock.adjust("15 seconds");
    yield* first.pass(yield* twoRoom);
    assert.deepEqual(yield* started, [true, true, false]);

    const second = yield* makeGovernor;
    yield* second.restore;
    yield* TestClock.adjust("15 seconds");
    yield* second.pass(yield* twoRoom);
    assert.deepEqual(yield* started, [true, true, false]);
  }).pipe(Effect.provide(layerTest)),
);

/** Writes the board's ranks where task wake does, stamped now unless `at` says otherwise. */
const writeRanks = (contents: Record<string, unknown> | string, at?: number) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    const dir = path.join(config.stateDir, "resource-limits");
    const text =
      typeof contents === "string"
        ? contents
        : JSON.stringify({ version: 1, at: at ?? now, source: "task-wake", ranks: contents });
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, "priority.json"), text);
  });

/**
 * Agent work held in each of `held`, a second apart, by a governor that sees `parents` as each thread's parent.
 * `others` are threads that exist without held work.
 */
const holdThreads = (
  name: string,
  held: ReadonlyArray<string>,
  parents: Readonly<Record<string, string>> = {},
  others: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const id = (thread: string) => ThreadId.make(`thread:${name}:${thread}`);
    const parentOf = new Map(
      Object.entries(parents).map(([child, parent]) => [id(child), id(parent)]),
    );
    const governor = yield* makeGovernor.pipe(
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        ...projections,
        getThreadShell: (threadId) =>
          projections.getThreadShell(threadId).pipe(
            Effect.map((shell) => {
              const parent = parentOf.get(threadId);
              return shell !== null && parent !== undefined
                ? { ...shell, lineage: { ...shell.lineage, parentThreadId: parent } }
                : shell;
            }),
          ),
      }),
    );
    const threads = held.map(id);
    yield* Effect.forEach([...threads, ...others.map(id)], createThread);
    yield* governor.pass(yield* tight);
    for (const threadId of threads) {
      yield* send(threadId, "agent work", agent);
      yield* TestClock.adjust("1 second");
    }
    const started = Effect.forEach(threads, (threadId) =>
      runs(threadId).pipe(Effect.map((all) => all.join() === "starting")),
    );
    // Past the 90 s spacing and the growth allowance, so the next pass releases one more.
    const nextRelease = Effect.gen(function* () {
      yield* TestClock.adjust(TIMING.releaseSpacingMs + 15_000);
      yield* governor.pass(yield* recovered);
    });
    return { governor, id, started, nextRelease };
  });

// The board's tasks a, b and c, and a helper c launched.
const withHelper = ["a", "b", "c", "helper"];

it.effect(
  "R6: the board's best-ranked task starts first, its helpers next, the rest oldest first",
  () =>
    Effect.gen(function* () {
      const { governor, id, started, nextRelease } = yield* holdThreads("r6", withHelper, {
        helper: "c",
      });
      yield* writeRanks({ [id("b")]: 5, [id("c")]: 2, [id("not-waiting")]: 1 });

      yield* governor.pass(yield* recovered);
      assert.deepEqual(yield* started, [false, false, true, false]);
      yield* nextRelease;
      assert.deepEqual(yield* started, [false, false, true, true]);
      yield* nextRelease;
      assert.deepEqual(yield* started, [false, true, true, true]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("R6: each release reads the latest ranks, and an oversized file counts as none", () =>
  Effect.gen(function* () {
    const { governor, id, started, nextRelease } = yield* holdThreads("r6-change", withHelper, {
      helper: "c",
    });
    yield* writeRanks({ [id("b")]: 5 });
    yield* governor.pass(yield* recovered);
    assert.deepEqual(yield* started, [false, true, false, false]);

    yield* writeRanks({ [id("a")]: 1 });
    yield* nextRelease;
    assert.deepEqual(yield* started, [true, true, false, false]);

    const at = (yield* Clock.currentTimeMillis) + TIMING.releaseSpacingMs + 15_000;
    const ranks = { [id("helper")]: 1 };
    yield* writeRanks(
      JSON.stringify({ version: 1, at, source: "task-wake", ranks, pad: "x".repeat(1024 * 1024) }),
    );
    yield* nextRelease;
    assert.deepEqual(yield* started, [true, true, true, false]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("R6: a rank passes down at most 10 levels of helpers", () =>
  Effect.gen(function* () {
    // x0's parent is x1, and so on up to x10, which has the rank; y0 sits one level below x0.
    const chain = Array.from({ length: 10 }, (_, level) => [`x${level}`, `x${level + 1}`]);
    const { governor, id, started, nextRelease } = yield* holdThreads(
      "r6-deep",
      ["old", "x0", "y0"],
      { ...Object.fromEntries(chain), y0: "x0" },
      chain.map(([, parent]) => parent!),
    );
    yield* writeRanks({ [id("x10")]: 1 });

    yield* governor.pass(yield* recovered);
    assert.deepEqual(yield* started, [false, true, false]);
    yield* nextRelease;
    assert.deepEqual(yield* started, [true, true, false]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("R6: an unreadable or day-old ranks file leaves the line oldest first", () =>
  Effect.gen(function* () {
    const { governor, id, started, nextRelease } = yield* holdThreads("r6-stale", withHelper, {
      helper: "c",
    });
    yield* writeRanks("{ not json");
    yield* governor.pass(yield* recovered);
    assert.deepEqual(yield* started, [true, false, false, false]);

    const day = TIMING.priorityStaleMs + TIMING.releaseSpacingMs + 15_001;
    yield* writeRanks({ [id("c")]: 1 }, (yield* Clock.currentTimeMillis) - day);
    yield* nextRelease;
    assert.deepEqual(yield* started, [true, true, false, false]);
  }).pipe(Effect.provide(layerTest)),
);

/** Writes the standing threads where teenylilconfig's Plaud watcher does, stamped now unless `at` says otherwise. */
const writeStanding = (threads: ReadonlyArray<ThreadId>, at?: number) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    const dir = path.join(config.stateDir, "resource-limits");
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(
      path.join(dir, "standing.json"),
      JSON.stringify({ version: 1, at: at ?? now, source: "plaud-watch", threads }),
    );
  });

it.effect(
  "R7: a standing thread's work starts over the limits, ahead of the line, and waits only at the critical line",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const [inbox, other] = ["inbox", "other"].map((name) =>
        ThreadId.make(`thread:r7:${name}`),
      ) as [ThreadId, ThreadId];
      yield* Effect.forEach([inbox, other], createThread);

      // A day-old file names nothing, so the inbox waits in line like any thread.
      yield* writeStanding([inbox], (yield* Clock.currentTimeMillis) - TIMING.priorityStaleMs - 1);
      yield* governor.pass(yield* tight);
      yield* send(other, "agent work", agent);
      yield* send(inbox, "first recording", agent);
      assert.deepEqual(yield* runs(inbox), ["queued:held"]);

      // Once the file is fresh, the next pass starts the inbox's held work, still over the limits.
      yield* writeStanding([inbox]);
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.deepEqual(yield* runs(inbox), ["starting"]);
      assert.deepEqual(yield* runs(other), ["queued:held"]);

      // Its next work starts at once, ahead of the thread still waiting.
      yield* endRun(inbox);
      yield* send(inbox, "second recording", agent);
      assert.deepEqual(yield* runs(inbox), ["interrupted", "starting"]);

      // At the critical line it waits.
      yield* endRun(inbox);
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* critical);
      yield* send(inbox, "third recording", agent);
      assert.deepEqual(yield* runs(inbox), ["interrupted", "interrupted", "queued:held"]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "R7: the critical line interrupts a standing thread's turn last, and it starts again first",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const threads = ["old", "new", "inbox"].map((name) =>
        ThreadId.make(`thread:r7-critical:${name}`),
      );
      for (const threadId of threads) {
        yield* createThread(threadId);
        yield* send(threadId, "work", alice);
        yield* TestClock.adjust("10 seconds");
      }
      const [old, newer, inbox] = threads as [ThreadId, ThreadId, ThreadId];
      yield* writeStanding([inbox]);

      // The inbox's turn is the newest, and the turns around it go first.
      yield* governor.pass(yield* critical);
      assert.deepEqual(yield* runs(newer), ["interrupted", "queued:held"]);
      assert.deepEqual(yield* runs(inbox), ["starting"]);
      yield* TestClock.adjust(TIMING.interruptSpacingMs);
      yield* governor.pass(yield* critical);
      assert.deepEqual(yield* runs(old), ["interrupted", "queued:held"]);
      assert.deepEqual(yield* runs(inbox), ["starting"]);

      // With nothing else left, it goes too.
      yield* TestClock.adjust(TIMING.interruptSpacingMs);
      yield* governor.pass(yield* critical);
      assert.deepEqual(yield* runs(inbox), ["interrupted", "queued:held"]);

      // Above the critical line, though still over the limits, it starts again and the others keep waiting.
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.deepEqual(yield* runs(inbox), ["interrupted", "starting"]);
      assert.deepEqual(yield* runs(newer), ["interrupted", "queued:held"]);
      assert.deepEqual(yield* runs(old), ["interrupted", "queued:held"]);
      // The same pass snoozed it for the hold, and its start lifts that snooze.
      yield* governor.flushRecord();
      const last = (yield* readPasses).passes.at(-1)!;
      assert.deepInclude((last.starts as Array<object>)[0], {
        threadId: inbox,
        unsnooze: "ok",
        resume: "ok",
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect("R7: standing threads held at the critical line start again one a pass", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const [first, second] = ["first", "second"].map((name) =>
      ThreadId.make(`thread:r7-one:${name}`),
    ) as [ThreadId, ThreadId];
    yield* Effect.forEach([first, second], createThread);
    yield* writeStanding([first, second]);
    yield* governor.pass(yield* critical);
    yield* send(first, "recording", agent);
    yield* TestClock.adjust("1 second");
    yield* send(second, "recording", agent);
    assert.deepEqual(yield* runs(second), ["queued:held"]);

    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.deepEqual(yield* runs(first), ["starting"]);
    assert.deepEqual(yield* runs(second), ["queued:held"]);
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.deepEqual(yield* runs(second), ["starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("R7: a standing thread whose start keeps failing doesn't hold up the line", () =>
  Effect.gen(function* () {
    const [inbox, other] = ["inbox", "other"].map((name) =>
      ThreadId.make(`thread:r7-failing:${name}`),
    ) as [ThreadId, ThreadId];
    const governor = yield* makeGovernorResuming((dispatch, command) =>
      command.type === "queue.resume" && command.threadId === inbox
        ? Effect.die("database is locked")
        : dispatch(command),
    );
    yield* Effect.forEach([inbox, other], createThread);
    yield* writeStanding([inbox]);
    yield* governor.pass(yield* critical);
    // The inbox has waited longest, so a line it held up would start nothing.
    yield* send(inbox, "recording", agent);
    yield* TestClock.adjust("1 second");
    yield* send(other, "agent work", agent);
    yield* TestClock.adjust("1 minute");

    yield* governor.pass(yield* recovered);
    assert.deepEqual(yield* runs(inbox), ["queued:held"]);
    assert.deepEqual(yield* runs(other), ["starting"]);
    assert.deepEqual(yield* waitingThreads, [inbox]);
  }).pipe(Effect.provide(layerTest)),
);

/** The pass record as the governor last wrote it. */
const readPasses = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(
    path.join(config.stateDir, "resource-limits", "passes.json"),
  );
  return JSON.parse(text) as {
    readonly server: { readonly id: string };
    readonly current: Record<string, unknown> | null;
    readonly passes: ReadonlyArray<Record<string, unknown>>;
  };
});

/** Runs `effect` and returns the names of what it logged, such as `resource-limits.released`. */
const logged = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const names: Array<string> = [];
    const logger = Logger.make(({ message }) => {
      const [name] = Array.isArray(message) ? message : [message];
      if (typeof name === "string") names.push(name);
    });
    yield* effect.pipe(
      Effect.provide(
        Layer.merge(
          Logger.layer([logger], { mergeWithExisting: false }),
          Layer.succeed(References.MinimumLogLevel, "Info"),
        ),
      ),
    );
    return names;
  });

/** A governor whose `queue.resume` dispatches go through `resume` first. */
const makeGovernorResuming = (
  resume: (
    dispatch: ThreadManagementService.ThreadManagementService["Service"]["dispatch"],
    command: Parameters<ThreadManagementService.ThreadManagementService["Service"]["dispatch"]>[0],
  ) => ReturnType<ThreadManagementService.ThreadManagementService["Service"]["dispatch"]>,
) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    return yield* makeGovernor.pipe(
      Effect.provideService(ThreadManagementService.ThreadManagementService, {
        ...threads,
        dispatch: (command) =>
          command.type === "queue.resume"
            ? resume(threads.dispatch, command)
            : threads.dispatch(command),
      }),
    );
  });

it.effect("D1: each pass records what it decided, and a run of one decision is one entry", () =>
  Effect.gen(function* () {
    const { governor, id, nextRelease } = yield* holdThreads("d1", withHelper, { helper: "c" });
    yield* writeRanks({ [id("b")]: 5, [id("c")]: 2 });
    yield* governor.pass(yield* recovered);
    yield* nextRelease;
    // Inside the spacing, with no room for another session to grow, twice.
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* recovered);
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* recovered);
    yield* governor.flushRecord();

    const { server, current, passes } = yield* readPasses;
    assert.isNull(current);
    const [first, second, waiting] = passes.slice(-3) as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    const started = (thread: string, heldMs: number) => ({
      threadId: id(thread),
      rank: 2,
      rankFrom: id("c"),
      heldMs,
      unsnooze: "none",
      resume: "ok",
    });
    assert.deepInclude(first, {
      server: server.id,
      state: "ok",
      acting: "ok",
      pause: null,
      offUntil: null,
      waiting: 4,
      held: 4,
      blocked: 0,
      dropped: 0,
      ready: 4,
      ranks: 2,
      release: { due: true, why: "first release" },
      starts: [started("c", 2_000)],
      result: "released",
    });
    assert.deepInclude(second, {
      release: { due: true, why: "spacing passed" },
      starts: [started("helper", TIMING.releaseSpacingMs + 16_000)],
    });
    assert.deepInclude(waiting, {
      count: 2,
      lastPass: (waiting.pass as number) + 1,
      waiting: 2,
      ready: 2,
      oldest: { threadId: id("a"), heldMs: TIMING.releaseSpacingMs + 49_000 },
      release: { due: false, why: "spacing: no room to grow" },
      starts: [],
      result: "not due",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("D2: while a pass waits on an await, the record shows which, and for what thread", () =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const governor = yield* makeGovernorResuming((dispatch, command) =>
      Deferred.succeed(reached, undefined).pipe(
        Effect.andThen(Deferred.await(gate)),
        Effect.andThen(dispatch(command)),
      ),
    );
    const threadId = ThreadId.make("thread:d2:stuck");
    yield* createThread(threadId);
    yield* governor.pass(yield* tight);
    yield* send(threadId, "agent work", agent);
    yield* governor.flushRecord();

    const pass = yield* governor.pass(yield* recovered).pipe(Effect.forkChild);
    yield* Deferred.await(reached);
    // An await that ends quickly is never written.
    yield* governor.flushRecord();
    assert.isNull((yield* readPasses).current);
    yield* TestClock.adjust(PHASE_WRITE_MS);
    yield* governor.flushRecord();
    const stuck = yield* readPasses;
    assert.deepInclude(stuck.current, { server: stuck.server.id, phase: "resume", threadId });

    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(pass);
    yield* governor.flushRecord();
    const done = yield* readPasses;
    assert.isNull(done.current);
    assert.deepInclude(done.passes.at(-1), { result: "released", ms: PHASE_WRITE_MS });
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "D3: the record keeps its newest 1,024 entries, and marks the last server's stuck pass",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = ThreadId.make("thread:d3:stuck");
      const old = "1@0";
      const current = {
        server: old,
        pass: MAX_PASSES + 1,
        startedAt: 5,
        phase: "resume",
        since: 6,
        threadId,
      };
      const dir = path.join(config.stateDir, "resource-limits");
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(
        path.join(dir, "passes.json"),
        JSON.stringify({
          version: 1,
          at: 7,
          server: { id: old },
          current,
          passes: Array.from({ length: MAX_PASSES }, (_, index) => ({
            server: old,
            pass: index + 1,
          })),
        }),
      );

      const governor = yield* makeGovernor;
      yield* governor.restore;
      yield* governor.pass(yield* comfortable);
      yield* governor.flushRecord();

      const record = yield* readPasses;
      assert.lengthOf(record.passes, MAX_PASSES);
      assert.deepEqual(record.passes[0], { server: old, pass: 3 });
      assert.deepEqual(record.passes.at(-2), { ...current, result: "unfinished", seenAt: 7 });
      assert.deepInclude(record.passes.at(-1), {
        server: record.server.id,
        pass: 1,
        result: "nothing held",
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "D4: a release whose start fails keeps its thread in line, tried once a pass, not moved",
  () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const failing = yield* Ref.make(true);
      const governor = yield* makeGovernorResuming((dispatch, command) =>
        Effect.gen(function* () {
          yield* Ref.update(attempts, (count) => count + 1);
          if (yield* Ref.get(failing)) return yield* Effect.die("database is locked");
          return yield* dispatch(command);
        }),
      );
      const [first, second] = ["first", "second"].map((name) =>
        ThreadId.make(`thread:d4:${name}`),
      ) as [ThreadId, ThreadId];
      // Both may move, and have waited long enough to, so only the tried start keeps them here.
      const cloud = yield* makeCloud();
      yield* overflowTo({});
      yield* Effect.forEach([first, second], createThread);
      yield* tagThreads({ [first]: "needs:none", [second]: "needs:none" });
      yield* governor.pass(yield* tight);
      yield* send(first, "agent work", agent);
      yield* TestClock.adjust("1 second");
      yield* send(second, "agent work", agent);
      yield* TestClock.adjust("1 minute");

      const logs = yield* logged(governor.pass(yield* recovered));
      assert.include(logs, "resource-limits.dispatch-failed");
      assert.notInclude(logs, "resource-limits.released");
      assert.deepEqual(yield* runs(first), ["queued:held"]);
      assert.deepEqual(yield* waitingThreads, [first, second]);
      assert.equal(yield* Ref.get(attempts), 1);

      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* recovered);
      assert.equal(yield* Ref.get(attempts), 2);
      assert.lengthOf(yield* cloud.attempts, 0);
      yield* Ref.set(failing, false);
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* recovered);
      assert.equal(yield* Ref.get(attempts), 3);
      assert.deepEqual(yield* runs(first), ["starting"]);
      assert.deepEqual(yield* runs(second), ["queued:held"]);
      assert.deepEqual(yield* waitingThreads, [second]);

      // No failure counted as a release, so the start that worked is still the first.
      yield* governor.flushRecord();
      const [failed, retried, worked] = (yield* readPasses).passes.slice(-3) as [
        Record<string, unknown>,
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      for (const entry of [failed, retried]) {
        assert.deepInclude(entry, { waiting: 2, result: "start failed" });
        assert.deepInclude((entry.starts as Array<object>)[0], {
          threadId: first,
          resume: "failed",
        });
      }
      assert.deepInclude(worked, {
        release: { due: true, why: "first release" },
        result: "released",
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect("D5: a pass that starts more than the record lists keeps every failed start", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(yield* fs.makeTempDirectoryScoped(), "passes.json");
    const record = yield* makePassRecord(file);
    const starts = Array.from({ length: 12 }, (_, index) => ({
      threadId: ThreadId.make(`thread:d5:${index}`),
      rank: null,
      rankFrom: null,
      heldMs: 1_000,
      unsnooze: "none" as const,
      resume: index === 11 ? ("failed" as const) : ("ok" as const),
    }));
    yield* record.finish(
      yield* record.begin,
      Exit.succeed({
        readingAt: null,
        headroomGiB: null,
        availableGiB: null,
        state: "ok",
        acting: "ok",
        pause: null,
        offUntil: 1,
        waiting: 12,
        held: 12,
        blocked: 0,
        dropped: 0,
        ready: 12,
        moving: 0,
        oldest: null,
        blockedBy: [],
        ranks: null,
        release: { due: true, why: "switched off" },
        starts,
        result: "released",
      }),
    );
    yield* record.flush(true);
    const [entry] = (
      JSON.parse(yield* fs.readFileString(file)) as {
        passes: [{ starts: Array<object>; startCount: number; failedStarts: number }];
      }
    ).passes;
    assert.lengthOf(entry.starts, 10);
    assert.deepInclude(entry.starts[0], { threadId: "thread:d5:11", resume: "failed" });
    assert.deepInclude(entry, { startCount: 12, failedStarts: 1 });
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("R4: idle sessions close on every pass over the limits, before any work waits", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:r4");
    yield* createThread(threadId);

    yield* governor.pass(yield* comfortable);
    assert.deepEqual(yield* governor.closings, []);

    yield* governor.pass(yield* tight);
    // Admission still saw "ok" while sessions closed.
    assert.deepEqual(yield* governor.closings, ["ok"]);
    yield* send(threadId, "agent work", agent);
    assert.deepEqual(yield* runs(threadId), ["queued:held"]);

    yield* governor.pass(yield* tight);
    yield* governor.pass(yield* critical);
    assert.deepEqual(yield* governor.closings, ["ok", "paused", "paused"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("R1: a saved percentage shows in the machine's status before the next pass", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const limits = yield* ResourceLimits.ResourceLimits;
    const governor = yield* Governor.make().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(ResourceLimits.TotalMemoryBytes, 128 * GiB),
      Effect.provideService(ProcessTree, quietProcessTree),
      Effect.provideService(ServerSettings.ServerSettingsService, {
        ...settings,
        // One change: whatever is saved when the governor follows it.
        streamChanges: Stream.fromEffect(Effect.orDie(settings.getSettings)),
      }),
    );
    yield* governor.pass(yield* comfortable);
    assert.equal((yield* limits.status)?.limits.pauseHeadroomGiB, 25.6);

    yield* settings.updateSettings({ resourceLimits: { usePercent: 70 } });
    yield* governor.followSettings;
    assert.equal((yield* limits.status)?.limits.pauseHeadroomGiB, 38.4);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("R5: critical interrupts the newest running turn every 30 s, and it resumes held", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const governor = yield* makeGovernor;
    const threads = ["old", "middle", "new"].map((name) => ThreadId.make(`thread:r5:${name}`));
    for (const threadId of threads) {
      yield* createThread(threadId);
      yield* send(threadId, "work", alice);
      yield* TestClock.adjust("10 seconds");
    }
    const [old, middle, newest] = threads as [ThreadId, ThreadId, ThreadId];

    yield* governor.pass(yield* critical);
    assert.deepEqual(yield* runs(newest), ["interrupted", "queued:held"]);
    assert.deepEqual(yield* runs(middle), ["starting"]);
    const resume = (yield* orchestrator.getThreadProjection(newest)).messages.at(-1)!;
    assert.equal(
      resume.notification?.summary,
      "T3 interrupted this turn to free memory on This machine",
    );
    assert.include(resume.text, "that was T3 stopping it: nobody said no.");
    assert.include(resume.text, "continue where you stopped.");

    yield* TestClock.adjust(TIMING.interruptSpacingMs - 1_000);
    yield* governor.pass(yield* critical);
    assert.deepEqual(yield* runs(middle), ["starting"]);

    yield* TestClock.adjust("1 second");
    yield* governor.pass(yield* critical);
    assert.deepEqual(yield* runs(middle), ["interrupted", "queued:held"]);
    assert.deepEqual(yield* runs(old), ["starting"]);

    // Back over the release lines, the first interrupted thread resumes first.
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* comfortable);
    assert.deepEqual(yield* runs(newest), ["interrupted", "starting"]);
    assert.deepEqual(yield* runs(middle), ["interrupted", "queued:held"]);
  }).pipe(Effect.provide(layerTest)),
);

const pauseFile = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, "resource-limits", "pause.json");
});

/** Sets the switch the way teenylilconfig's memgate and task wake do: by writing its file. */
const writePause = (mode: "finish" | "stop") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* pauseFile;
    const at = yield* Clock.currentTimeMillis;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, JSON.stringify({ version: 1, mode, at }));
  });

const removePause = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* pauseFile);
});

const publishedState = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(
    path.join(config.stateDir, "resource-limits", "state.json"),
  );
  return JSON.parse(text) as Record<string, unknown>;
});

it.effect("P1: a pause holds agent, schedule and queue work, with memory to spare", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const [theirs, scheduled, parent, child] = ["theirs", "scheduled", "parent", "child"].map(
      (name) => ThreadId.make(`thread:p1:${name}`),
    ) as [ThreadId, ThreadId, ThreadId, ThreadId];
    yield* Effect.forEach([theirs, scheduled, parent, child], createThread);
    yield* governor.pass(yield* comfortable);

    yield* TestClock.adjust("1 second");
    yield* writePause("finish");
    yield* governor.followPause;

    yield* send(theirs, "agent work", agent);
    yield* send(scheduled, "daily check", {
      ...alice,
      scheduledTaskId: ScheduledTaskId.make("task:daily"),
    });
    // Her "launch anyway" lets a thread's work past the memory limits, but not past her own pause.
    yield* send(parent, "launch anyway", alice);
    yield* send(child, "launched work", { ...agent, senderThreadId: parent });

    assert.deepEqual(yield* runs(theirs), ["queued:held"]);
    assert.deepEqual(yield* runs(scheduled), ["queued:held"]);
    assert.deepEqual(yield* runs(parent), ["starting"]);
    assert.deepEqual(yield* runs(child), ["queued:held"]);
    const [notice] = yield* notices(theirs);
    assert.include(notice, "because all agents were paused");
    assert.include(notice, "Choose Resume to start it now.");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P1: the pause outranks the off switch, and the state file says so", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:p1:off");
    yield* createThread(threadId);
    const dir = path.join(config.stateDir, "resource-limits");
    const now = yield* Clock.currentTimeMillis;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(
      path.join(dir, "off.json"),
      JSON.stringify({ at: now, until: now + 3_600_000 }),
    );

    yield* governor.pass(yield* comfortable);
    assert.equal((yield* publishedState).off, now + 3_600_000);

    yield* writePause("finish");
    yield* governor.pass(yield* comfortable);
    yield* send(threadId, "agent work", agent);
    assert.deepEqual(yield* runs(threadId), ["queued:held"]);

    const state = yield* publishedState;
    assert.equal(state.state, "paused");
    assert.isNull(state.off);
    assert.deepEqual(state.pause, { mode: "finish", at: now });

    const limits = yield* ResourceLimits.ResourceLimits;
    const status = yield* limits.status;
    assert.equal(status?.state, "paused");
    assert.deepEqual(status?.pause, { mode: "finish", at: now });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P1: a pause with no readings still holds, and a malformed file doesn't", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const governor = yield* makeGovernor;
    const held = ThreadId.make("thread:p1:held");
    const free = ThreadId.make("thread:p1:free");
    yield* Effect.forEach([held, free], createThread);

    yield* writePause("finish");
    yield* governor.pass(null);
    yield* send(held, "agent work", agent);
    assert.deepEqual(yield* runs(held), ["queued:held"]);

    yield* fs.writeFileString(yield* pauseFile, "{ not json");
    yield* governor.followPause;
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* comfortable);
    assert.deepEqual(yield* runs(held), ["starting"]);
    yield* send(free, "agent work", agent);
    assert.deepEqual(yield* runs(free), ["starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P2: Pause all lets a running turn finish, then its queue waits", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:p2:finish");
    yield* createThread(threadId);
    yield* send(threadId, "first", alice);
    yield* send(threadId, "agent follow-up", agent, "queue_after_active");

    yield* TestClock.adjust("1 second");
    yield* writePause("finish");
    yield* governor.followPause;
    yield* governor.pass(yield* comfortable);
    assert.deepEqual(yield* runs(threadId), ["starting", "queued"]);

    const held = yield* awaitRunUpdate(threadId, (run) => run.queueHeld === true);
    yield* endRun(threadId);
    yield* held;
    assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P1: a tag from an app on typedInApps starts over the limits and in a pause", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const [tag, theirs, during] = ["tag", "theirs", "during"].map((name) =>
      ThreadId.make(`thread:p1:typed-in:${name}`),
    ) as [ThreadId, ThreadId, ThreadId];
    yield* Effect.forEach([tag, theirs, during], createThread);

    yield* governor.pass(yield* tight);
    yield* send(tag, "tagged in a comment", tagged);
    yield* send(theirs, "agent work", agent);
    assert.deepEqual(yield* runs(tag), ["starting"]);
    assert.deepEqual(yield* runs(theirs), ["queued:held"]);

    yield* TestClock.adjust("1 second");
    yield* writePause("finish");
    yield* governor.followPause;
    yield* send(during, "tagged during the pause", tagged);
    assert.deepEqual(yield* runs(during), ["starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P2: a tag during the pause goes where her own typing would, held queue or busy turn", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const threads = (name: string) =>
      [ThreadId.make(`thread:p2:typed:${name}`), ThreadId.make(`thread:p2:tagged:${name}`)] as const;
    const [typedHeld, taggedHeld] = threads("held");
    const [typedBusy, taggedBusy] = threads("busy");
    const all = [typedHeld, taggedHeld, typedBusy, taggedBusy];
    yield* Effect.forEach(all, createThread);
    yield* Effect.forEach(all, (thread) => send(thread, "first", alice));
    yield* Effect.forEach([typedHeld, taggedHeld], (thread) =>
      send(thread, "queued before the pause", alice, "queue_after_active"),
    );

    yield* TestClock.adjust("1 second");
    yield* writePause("finish");
    yield* governor.followPause;
    yield* TestClock.adjust("1 second");

    // Each thread's older queue is held once its turn ends; her message, or a tag, then starts at once.
    for (const thread of [typedHeld, taggedHeld]) {
      const held = yield* awaitRunUpdate(thread, (run) => run.queueHeld === true);
      yield* endRun(thread);
      yield* held;
    }
    yield* send(typedHeld, "during the pause", alice);
    yield* send(taggedHeld, "during the pause", tagged);

    // Behind a running turn, what's newer than the pause starts when the turn ends.
    yield* send(typedBusy, "during the pause", alice, "queue_after_active");
    yield* send(taggedBusy, "during the pause", tagged, "queue_after_active");
    for (const thread of [typedBusy, taggedBusy]) {
      const started = yield* awaitRunUpdate(thread, (run) => run.status === "starting");
      yield* endRun(thread);
      yield* started;
    }

    yield* TestClock.adjust("1 second");
    assert.include(yield* runs(taggedHeld), "starting");
    assert.deepEqual(yield* runs(taggedHeld), yield* runs(typedHeld));
    assert.deepEqual(yield* runs(taggedBusy), ["interrupted", "starting"]);
    assert.deepEqual(yield* runs(taggedBusy), yield* runs(typedBusy));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P2: what Alice queued before the pause waits, and what she types during it starts", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const before = ThreadId.make("thread:p2:before");
    const during = ThreadId.make("thread:p2:during");
    const idle = ThreadId.make("thread:p2:idle");
    yield* Effect.forEach([before, during, idle], createThread);
    yield* send(before, "first", alice);
    yield* send(before, "queued before the pause", alice, "queue_after_active");
    yield* send(during, "first", alice);

    yield* TestClock.adjust("1 second");
    yield* writePause("finish");
    yield* governor.followPause;
    yield* TestClock.adjust("1 second");

    const heldBefore = yield* awaitRunUpdate(before, (run) => run.queueHeld === true);
    yield* endRun(before);
    yield* heldBefore;
    assert.deepEqual(yield* runs(before), ["interrupted", "queued:held"]);

    yield* send(during, "typed during the pause", alice, "queue_after_active");
    const startedDuring = yield* awaitRunUpdate(during, (run) => run.status === "starting");
    yield* endRun(during);
    yield* startedDuring;
    assert.deepEqual(yield* runs(during), ["interrupted", "starting"]);

    yield* send(idle, "typed in a quiet thread", alice);
    assert.deepEqual(yield* runs(idle), ["starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: Stop now interrupts every running turn at once, and each queues its resume", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const governor = yield* makeGovernor;
    const threads = ["a", "b", "c"].map((name) => ThreadId.make(`thread:p3:${name}`));
    yield* Effect.forEach(threads, createThread);
    yield* Effect.forEach(threads, (threadId) => send(threadId, "work", agent));
    yield* TestClock.adjust("1 second");

    yield* writePause("stop");
    yield* governor.followPause;
    for (const threadId of threads) {
      assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);
      const resume = (yield* orchestrator.getThreadProjection(threadId)).messages.at(-1)!;
      assert.equal(
        resume.notification?.summary,
        "T3 interrupted this turn when all agents were stopped",
      );
      assert.include(resume.text, "continue where you stopped.");
    }

    // Nothing starts again while the switch is on, on any later pass.
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* comfortable);
    const states = Effect.forEach(threads, (threadId) =>
      runs(threadId).pipe(Effect.map((all) => all.join())),
    );
    const allHeld = threads.map(() => "interrupted,queued:held");
    assert.deepEqual(yield* states, allHeld);

    // Resuming starts them one at a time, not all at once.
    yield* removePause;
    yield* TestClock.adjust(TIMING.releaseSpacingMs);
    yield* governor.pass(yield* recovered);
    const after = yield* states;
    assert.equal(after.filter((state) => state === "interrupted,starting").length, 1);
    assert.equal(after.filter((state) => state === "interrupted,queued:held").length, 2);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: Stop now leaves a turn Alice starts afterwards alone", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:p3:hers");
    yield* createThread(threadId);
    yield* writePause("stop");
    yield* governor.followPause;
    yield* TestClock.adjust("1 second");

    yield* send(threadId, "typed after stopping", alice);
    yield* TestClock.adjust("1 second");
    yield* governor.followPause;
    assert.deepEqual(yield* runs(threadId), ["starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "P3: moving from Pause all to Stop now also stops what she started during the pause",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const threadId = ThreadId.make("thread:p3:escalate");
      yield* createThread(threadId);
      yield* writePause("finish");
      yield* governor.followPause;
      yield* TestClock.adjust("1 second");
      yield* send(threadId, "typed during the pause", alice);
      assert.deepEqual(yield* runs(threadId), ["starting"]);

      yield* TestClock.adjust("1 second");
      yield* writePause("stop");
      yield* governor.followPause;
      assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: Stop now asked for again sweeps again, and stops what she started since", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:p3:again");
    const orders = ThreadId.make("thread:p3:again-orders");
    yield* Effect.forEach([threadId, orders], createThread);
    yield* send(orders, "stop all", alice);
    yield* governor.followPause;
    yield* TestClock.adjust(TIMING.stopSweepMs);

    yield* send(threadId, "typed after stopping", alice);
    yield* TestClock.adjust("1 second");
    yield* governor.followPause;
    assert.deepEqual(yield* runs(threadId), ["starting"]);

    yield* send(orders, "Stop all.", alice);
    yield* governor.followPause;
    assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);
  }).pipe(Effect.provide(layerTest)),
);

/** This server, a provider, a server the provider keeps, a command's shell, and what the shell started. */
const SERVER = process.pid;
const row = (pid: number, parentPid: number, name = "a.exe") => ({
  pid,
  parentPid,
  createdAt: pid,
  name,
});
const beforeInterrupt = [
  { pid: SERVER, parentPid: 1, createdAt: 0, name: "t3.exe" },
  row(100_000, SERVER, "codex.exe"),
  row(100_001, 100_000),
  row(100_002, 100_000),
  row(100_003, 100_002),
];

const fakeProcessTree = Effect.gen(function* () {
  const table = yield* Ref.make<ReadonlyArray<ProcessRow> | null>(beforeInterrupt);
  const reads = yield* Ref.make(0);
  const ended = yield* Ref.make<ReadonlyArray<number>>([]);
  const tree: ProcessTree["Service"] = {
    read: Ref.update(reads, (count) => count + 1).pipe(Effect.andThen(Ref.get(table))),
    end: ({ pid }) => Ref.update(ended, (all) => [...all, pid]).pipe(Effect.as("ended" as const)),
  };
  return { table, reads, ended, tree };
});

it.effect("P3: Stop now ends what an interrupted command left running, and nothing else", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const { table, ended, tree } = yield* fakeProcessTree;
    const governor = yield* makeGovernorWith(sessions, tree);
    const threadId = ThreadId.make("thread:p3:orphan");
    yield* createThread(threadId);
    yield* send(threadId, "agent work", agent);
    yield* TestClock.adjust("1 second");

    yield* writePause("stop");
    yield* governor.followPause;
    assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);

    // The interrupt ended the shell, and not what it started.
    yield* Ref.set(
      table,
      beforeInterrupt.filter((process) => process.pid !== 100_002),
    );
    yield* governor.endOrphans;
    assert.deepEqual(yield* Ref.get(ended), [], "it gives the shell a moment to die");
    yield* TestClock.adjust(TIMING.orphanCheckMs);
    yield* governor.endOrphans;
    assert.deepEqual(yield* Ref.get(ended), [100_003]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: Stop now ends what's under an orphan, and not what only names its reused ID", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const { table, ended, tree } = yield* fakeProcessTree;
    const governor = yield* makeGovernorWith(sessions, tree);
    const threadId = ThreadId.make("thread:p3:descendants");
    yield* createThread(threadId);
    yield* send(threadId, "agent work", agent);
    yield* TestClock.adjust("1 second");
    yield* writePause("stop");
    yield* governor.followPause;

    const unrelated = { pid: 90_000, parentPid: 100_003, createdAt: 90_000, name: "explorer.exe" };
    yield* Ref.set(table, [
      ...beforeInterrupt.filter((process) => process.pid !== 100_002),
      unrelated,
      row(100_004, 100_003),
      row(100_005, 100_004),
    ]);
    yield* TestClock.adjust(TIMING.orphanCheckMs);
    yield* governor.endOrphans;
    assert.deepEqual(yield* Ref.get(ended), [100_003, 100_004, 100_005]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: an orphan is still found when the shell takes its time to die", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const { table, ended, tree } = yield* fakeProcessTree;
    const governor = yield* makeGovernorWith(sessions, tree);
    const threadId = ThreadId.make("thread:p3:slow-shell");
    yield* createThread(threadId);
    yield* send(threadId, "agent work", agent);
    yield* TestClock.adjust("1 second");
    yield* writePause("stop");
    yield* governor.followPause;

    yield* TestClock.adjust(TIMING.orphanCheckMs);
    yield* governor.endOrphans;
    assert.deepEqual(yield* Ref.get(ended), []);

    yield* Ref.set(
      table,
      beforeInterrupt.filter((process) => process.pid !== 100_002),
    );
    yield* TestClock.adjust(TIMING.orphanCheckMs);
    yield* governor.endOrphans;
    assert.deepEqual(yield* Ref.get(ended), [100_003]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: a process reading that fails doesn't delay the interrupt", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const { table, ended, tree } = yield* fakeProcessTree;
    yield* Ref.set(table, null);
    const governor = yield* makeGovernorWith(sessions, tree);
    const threadId = ThreadId.make("thread:p3:no-reading");
    yield* createThread(threadId);
    yield* send(threadId, "agent work", agent);
    yield* TestClock.adjust("1 second");
    yield* writePause("stop");
    yield* governor.followPause;
    assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);
    yield* TestClock.adjust(TIMING.orphanCheckMs);
    yield* governor.endOrphans;
    assert.deepEqual(yield* Ref.get(ended), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: a failed reading doesn't stop a later Stop now from reading", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const { table, reads, ended, tree } = yield* fakeProcessTree;
    yield* Ref.set(table, null);
    const governor = yield* makeGovernorWith(sessions, tree);
    const threadId = ThreadId.make("thread:p3:no-reading-then");
    yield* createThread(threadId);
    yield* send(threadId, "agent work", agent);
    yield* TestClock.adjust("1 second");
    yield* writePause("stop");
    yield* governor.followPause;
    assert.equal(yield* Ref.get(reads), 1);

    // Past the watch, what it noted is gone, and there was no reading to compare with.
    yield* TestClock.adjust(TIMING.orphanWatchMs);
    yield* governor.endOrphans;
    assert.equal(yield* Ref.get(reads), 1);

    yield* Ref.set(table, beforeInterrupt);
    yield* send(threadId, "typed during the stop", alice);
    yield* TestClock.adjust("1 second");
    yield* writePause("stop");
    yield* governor.followPause;
    assert.equal(yield* Ref.get(reads), 2, "asking again acts on the thread again");

    yield* Ref.set(
      table,
      beforeInterrupt.filter((process) => process.pid !== 100_002),
    );
    yield* TestClock.adjust(TIMING.orphanCheckMs);
    yield* governor.endOrphans;
    assert.deepEqual(yield* Ref.get(ended), [100_003]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: several turns stopped together share one reading", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const { reads, tree } = yield* fakeProcessTree;
    const governor = yield* makeGovernorWith(sessions, tree);
    for (const name of ["a", "b", "c"]) {
      const threadId = ThreadId.make(`thread:p3:one-reading-${name}`);
      yield* createThread(threadId);
      yield* send(threadId, "agent work", agent);
    }
    yield* TestClock.adjust("1 second");
    yield* writePause("stop");
    yield* governor.followPause;
    assert.equal(yield* Ref.get(reads), 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: two readings aren't joined to say who started what", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const { table, ended, tree } = yield* fakeProcessTree;
    const governor = yield* makeGovernorWith(sessions, tree);
    const first = ThreadId.make("thread:p3:join-first");
    const second = ThreadId.make("thread:p3:join-second");
    yield* createThread(first);
    yield* createThread(second);
    yield* send(first, "agent work", agent);
    yield* TestClock.adjust("1 second");
    yield* writePause("stop");
    yield* governor.followPause;
    yield* TestClock.adjust("1 second");
    yield* send(second, "typed during the stop", alice);
    yield* TestClock.adjust("1 second");

    // The shell's id went to something unrelated, which started a process and died between the two readings.
    const unrelated = { pid: 100_009, parentPid: 100_002, createdAt: 100_009, name: "a.exe" };
    const later = [
      ...beforeInterrupt.filter((process) => process.pid !== 100_002 && process.pid !== 100_003),
      unrelated,
    ];
    yield* Ref.set(table, later);
    yield* writePause("stop");
    yield* governor.followPause;
    assert.deepEqual(yield* runs(second), ["interrupted", "queued:held"]);
    yield* TestClock.adjust(TIMING.orphanCheckMs);
    yield* governor.endOrphans;
    assert.deepEqual(yield* Ref.get(ended), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: a command started just after the pause is ended when no turn is hers", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const { table, ended, tree } = yield* fakeProcessTree;
    const governor = yield* makeGovernorWith(sessions, tree);
    const threadId = ThreadId.make("thread:p3:just-after");
    yield* createThread(threadId);
    yield* send(threadId, "agent work", agent);
    yield* TestClock.adjust("1 second");
    yield* writePause("stop");
    const pausedAt = yield* Clock.currentTimeMillis;
    const shell = {
      pid: 200_000,
      parentPid: 100_000,
      createdAt: pausedAt * 1000 + 1,
      name: "a.exe",
    };
    const command = { ...shell, pid: 200_001, parentPid: 200_000, createdAt: pausedAt * 1000 + 2 };
    yield* Ref.set(table, [...beforeInterrupt, shell, command]);
    yield* governor.followPause;
    yield* Ref.set(table, [...beforeInterrupt, command]);
    yield* TestClock.adjust(TIMING.orphanCheckMs);
    yield* governor.endOrphans;
    assert.deepEqual(yield* Ref.get(ended), [200_001]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: while she has a turn running, what's newer than the pause is left alone", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const { table, ended, tree } = yield* fakeProcessTree;
    const governor = yield* makeGovernorWith(sessions, tree);
    const theirs = ThreadId.make("thread:p3:protected-theirs");
    const hers = ThreadId.make("thread:p3:protected-hers");
    yield* createThread(theirs);
    yield* createThread(hers);
    yield* send(theirs, "agent work", agent);
    yield* TestClock.adjust("1 second");
    yield* writePause("stop");
    const pausedAt = yield* Clock.currentTimeMillis;
    yield* TestClock.adjust("100 millis");
    yield* send(hers, "typed during the stop", alice);
    yield* TestClock.adjust("100 millis");

    // Her shell, and the server it leaves behind when it finishes.
    const hersShell = {
      pid: 200_000,
      parentPid: 100_000,
      createdAt: pausedAt * 1000 + 1,
      name: "a.exe",
    };
    const hersServer = {
      pid: 200_001,
      parentPid: 200_000,
      createdAt: pausedAt * 1000 + 2,
      name: "a.exe",
    };
    yield* Ref.set(table, [...beforeInterrupt, hersShell, hersServer]);
    yield* governor.followPause;
    assert.deepEqual(yield* runs(theirs), ["interrupted", "queued:held"]);

    yield* Ref.set(table, [
      ...beforeInterrupt.filter((process) => process.pid !== 100_002),
      hersServer,
    ]);
    yield* TestClock.adjust(TIMING.orphanCheckMs);
    yield* governor.endOrphans;
    assert.deepEqual(yield* Ref.get(ended), [100_003]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: with nothing to stop, Stop now reads no processes", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const { reads, tree } = yield* fakeProcessTree;
    const governor = yield* makeGovernorWith(sessions, tree);
    yield* writePause("stop");
    yield* governor.followPause;
    assert.equal(yield* Ref.get(reads), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: Pause all interrupts nothing, so it reads no processes", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const { reads, tree } = yield* fakeProcessTree;
    const governor = yield* makeGovernorWith(sessions, tree);
    const threadId = ThreadId.make("thread:p3:finish-reads");
    yield* createThread(threadId);
    yield* send(threadId, "agent work", agent);
    yield* TestClock.adjust("1 second");
    yield* writePause("finish");
    yield* governor.followPause;
    assert.deepEqual(yield* runs(threadId), ["starting"]);
    assert.equal(yield* Ref.get(reads), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: on a Mac, Stop now interrupts and reads no processes", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const { reads, tree } = yield* fakeProcessTree;
    const governor = yield* makeGovernorWith(sessions, tree, "darwin");
    const threadId = ThreadId.make("thread:p3:mac-reads");
    yield* createThread(threadId);
    yield* send(threadId, "agent work", agent);
    yield* TestClock.adjust("1 second");
    yield* writePause("stop");
    yield* governor.followPause;
    assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);
    assert.equal(yield* Ref.get(reads), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: a turn she started since the pause is hers, so it isn't read for", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const { reads, tree } = yield* fakeProcessTree;
    const governor = yield* makeGovernorWith(sessions, tree);
    const threadId = ThreadId.make("thread:p3:hers-read");
    yield* createThread(threadId);
    yield* writePause("stop");
    yield* TestClock.adjust("1 second");
    yield* send(threadId, "typed during the stop", alice);
    yield* TestClock.adjust("1 second");
    yield* governor.followPause;
    assert.deepEqual(yield* runs(threadId), ["starting"]);
    assert.equal(yield* Ref.get(reads), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P3: past its first moments, Stop now doesn't interrupt anything new", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:p3:late");
    yield* createThread(threadId);
    yield* writePause("stop");
    yield* governor.followPause;
    yield* send(threadId, "agent work", agent);
    assert.deepEqual(yield* runs(threadId), ["queued:held"]);

    // Her Resume on this one thread holds, because it comes after the sweep has ended.
    yield* TestClock.adjust(TIMING.stopSweepMs);
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("resume-one"),
      threadId,
    });
    yield* governor.followPause;
    assert.deepEqual(yield* runs(threadId), ["starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P4: a restart while paused reads the switch before anything can start", () =>
  Effect.gen(function* () {
    yield* writePause("stop");
    const pause = yield* Effect.gen(function* () {
      const limits = yield* ResourceLimits.ResourceLimits;
      return (yield* limits.read).pause;
    }).pipe(Effect.provide(Layer.fresh(layerLimits)));
    assert.equal(pause?.mode, "stop");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "P2: typed in an idle thread during a pause, her message goes ahead of its held queue",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const threadId = ThreadId.make("thread:p2:idle-queue");
      const untouched = ThreadId.make("thread:p2:untouched");
      yield* Effect.forEach([threadId, untouched], createThread);
      yield* Effect.forEach([threadId, untouched], (thread) => send(thread, "first", alice));
      yield* Effect.forEach([threadId, untouched], (thread) =>
        send(thread, "queued before the pause", alice, "queue_after_active"),
      );
      yield* TestClock.adjust("1 second");
      yield* writePause("finish");
      yield* governor.followPause;
      yield* TestClock.adjust("1 second");
      for (const thread of [threadId, untouched]) {
        const held = yield* awaitRunUpdate(thread, (run) => run.queueHeld === true);
        yield* endRun(thread);
        yield* held;
      }

      yield* send(threadId, "typed during the pause", alice, "queue_after_active");
      assert.deepEqual(yield* runs(threadId), ["interrupted", "queued", "starting"]);
      assert.deepEqual(yield* runs(untouched), ["interrupted", "queued:held"]);

      // The older message waits again once her turn is done.
      const heldAgain = yield* awaitRunUpdate(threadId, (run) => run.queueHeld === true);
      yield* endRun(threadId);
      yield* heldAgain;
      assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held", "interrupted"]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "P2: typed behind a running turn during a pause, her message follows what's ahead of it",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const threadId = ThreadId.make("thread:p2:busy-queue");
      yield* createThread(threadId);
      yield* send(threadId, "first", alice);
      yield* send(threadId, "queued before the pause", alice, "queue_after_active");
      yield* TestClock.adjust("1 second");
      yield* writePause("finish");
      yield* governor.followPause;
      yield* TestClock.adjust("1 second");

      yield* send(threadId, "typed during the pause", alice, "queue_after_active");
      const started = yield* awaitRunUpdate(threadId, (run) => run.status === "starting");
      yield* endRun(threadId);
      yield* started;
      assert.deepEqual(yield* runs(threadId), ["interrupted", "starting", "queued"]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("P5: Alice's typed orders set the switch, start nothing, and leave a notice", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const limits = yield* ResourceLimits.ResourceLimits;
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:p5:orders");
    yield* createThread(threadId);
    yield* governor.pass(yield* comfortable);

    yield* send(threadId, "  Pause   ALL. ", alice);
    assert.deepEqual(yield* runs(threadId), ["cancelled"]);
    assert.equal((yield* limits.read).pause?.mode, "finish");
    assert.equal(JSON.parse(yield* fs.readFileString(yield* pauseFile)).mode, "finish");
    const paused = yield* notices(threadId);
    assert.include(paused.at(-1), "All agents paused at");
    assert.include(paused.at(-1), "resume all");

    yield* TestClock.adjust("1 second");
    yield* send(threadId, "stop all", alice);
    assert.deepEqual(yield* runs(threadId), ["cancelled", "cancelled"]);
    assert.equal((yield* limits.read).pause?.mode, "stop");
    assert.include((yield* notices(threadId)).at(-1), "All agents stopped at");

    yield* send(threadId, "resume all", alice);
    assert.deepEqual(yield* runs(threadId), ["cancelled", "cancelled", "cancelled"]);
    assert.isNull((yield* limits.read).pause);
    assert.isFalse(yield* fs.exists(yield* pauseFile));
    assert.include((yield* notices(threadId)).at(-1), "All agents resumed at");

    yield* send(threadId, "RESUME ALL!", alice);
    assert.equal((yield* notices(threadId)).at(-1), "Nothing was paused.");

    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.isTrue(projection.runs.every((run) => run.queuePosition === null));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P5: only Alice's whole message is an order", () =>
  Effect.gen(function* () {
    const limits = yield* ResourceLimits.ResourceLimits;
    const governor = yield* makeGovernor;
    const threads = ["agent", "relayed", "scheduled", "longer"].map((name) =>
      ThreadId.make(`thread:p5:${name}`),
    );
    const [fromAgent, relayed, scheduled, longer] = threads as [
      ThreadId,
      ThreadId,
      ThreadId,
      ThreadId,
    ];
    yield* Effect.forEach(threads, createThread);
    yield* governor.pass(yield* comfortable);

    yield* send(fromAgent, "stop all", agent);
    yield* send(relayed, "stop all", { ...alice, senderThreadId: fromAgent });
    yield* send(scheduled, "pause all", {
      ...alice,
      scheduledTaskId: ScheduledTaskId.make("task:pause"),
    });
    yield* send(longer, "should we pause all of these?", alice);

    assert.isNull((yield* limits.read).pause);
    for (const threadId of threads) assert.deepEqual(yield* runs(threadId), ["starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P5: an order in a busy thread doesn't touch its turn or release its queue", () =>
  Effect.gen(function* () {
    const limits = yield* ResourceLimits.ResourceLimits;
    const governor = yield* makeGovernor;
    const busy = ThreadId.make("thread:p5:busy");
    const heldQueue = ThreadId.make("thread:p5:held-queue");
    yield* Effect.forEach([busy, heldQueue], createThread);
    yield* governor.pass(yield* comfortable);

    yield* send(busy, "first", alice);
    yield* send(busy, "pause all", alice, "queue_after_active");
    assert.deepEqual(yield* runs(busy), ["starting", "cancelled"]);
    assert.equal((yield* limits.read).pause?.mode, "finish");

    yield* send(heldQueue, "agent work", agent);
    assert.deepEqual(yield* runs(heldQueue), ["queued:held"]);
    yield* send(heldQueue, "stop all", alice);
    assert.deepEqual(yield* runs(heldQueue), ["queued:held", "cancelled"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P5: `stop all` typed in a busy thread stops that thread's turn too", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:p5:stop-busy");
    yield* createThread(threadId);
    yield* send(threadId, "first", alice);
    yield* TestClock.adjust("1 second");

    yield* send(threadId, "stop all", alice, "queue_after_active");
    assert.deepEqual(yield* runs(threadId), ["starting", "cancelled"]);
    yield* governor.followPause;
    assert.deepEqual(yield* runs(threadId), ["interrupted", "cancelled", "queued:held"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P5: asking to pause again keeps its time, and asking to stop again renews it", () =>
  Effect.gen(function* () {
    const limits = yield* ResourceLimits.ResourceLimits;
    const orders = ThreadId.make("thread:p5:again");
    yield* createThread(orders);

    yield* send(orders, "pause all", alice);
    const paused = (yield* limits.read).pause?.at;
    yield* TestClock.adjust("5 seconds");
    yield* send(orders, "Pause all.", alice);
    assert.equal((yield* limits.read).pause?.at, paused);

    yield* send(orders, "stop all", alice);
    const stopped = (yield* limits.read).pause?.at;
    assert.equal(stopped, (paused ?? 0) + 5000);
    yield* TestClock.adjust("5 seconds");
    yield* send(orders, "Stop all.", alice);
    assert.equal((yield* limits.read).pause?.at, (stopped ?? 0) + 5000);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P5: an order asks no model for a title, and leaves the next message's title alone", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:p5:title");
    yield* createThread(threadId);
    const firstMessage = (text: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`title:${text}`),
        threadId,
        messageId: MessageId.make(`message:title:${text}`),
        text,
        titleSeed: text,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        ...alice,
      });

    yield* firstMessage("pause all");
    const afterOrder = (yield* orchestrator.getThreadProjection(threadId)).thread;
    assert.notEqual(afterOrder.title, "pause all");
    assert.isNotOk(afterOrder.titleRegeneration);

    yield* firstMessage("the real first message");
    const afterMessage = (yield* orchestrator.getThreadProjection(threadId)).thread;
    assert.equal(afterMessage.title, "the real first message");
    assert.isOk(afterMessage.titleRegeneration);
  }).pipe(Effect.provide(layerTest)),
);

/** A buffered wake, as Claude's adapter sends one; Codex's wakes arrive as `server` messages. */
const sendProviderWake = (
  threadId: ThreadId,
  text: string,
  creationSource: "provider" | "server" = "provider",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`wake:${threadId}:${text}`),
      messageId: MessageId.make(`message:wake:${threadId}:${text}`),
      threadId,
      text,
      notification: { source: { kind: "command" }, outcome: "updated", summary: text },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource,
    });
  });

it.effect("P6: a buffered wake starts over the limits and in a pause, and a Codex wake waits", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const [buffered, codex, paused] = ["buffered", "codex", "paused"].map((name) =>
      ThreadId.make(`thread:p6:wake-${name}`),
    ) as [ThreadId, ThreadId, ThreadId];
    yield* Effect.forEach([buffered, codex, paused], createThread);
    yield* governor.pass(yield* tight);

    // Claude's CLI started this turn itself; its run only gives the turn T3's tools.
    yield* sendProviderWake(buffered, "Background command finished");
    // T3 prompts Codex's wake, so holding it holds the work.
    yield* sendProviderWake(codex, "Background command finished", "server");
    assert.deepEqual(yield* runs(buffered), ["starting"]);
    assert.deepEqual(yield* notices(buffered), []);
    assert.deepEqual(yield* runs(codex), ["queued:held"]);
    assert.deepEqual(yield* waitingThreads, [codex]);

    yield* writePause("stop");
    yield* governor.followPause;
    yield* sendProviderWake(paused, "Background command finished");
    assert.deepEqual(yield* runs(paused), ["starting"]);
  }).pipe(Effect.provide(layerTest)),
);

/**
 * A held wake, written directly: admission no longer holds one, but versions before `isBufferedWake` did, and the
 * restart that installs this one can find theirs.
 */
const sendHeldWake = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const limits = yield* ResourceLimits.ResourceLimits;
    const sink = yield* EventSink.EventSinkV2;
    yield* sendProviderWake(threadId, text);
    const { thread, runs: all } = yield* orchestrator.getThreadProjection(threadId);
    const run = all.at(-1)!;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`held:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: yield* DateTime.now,
          payload: { ...run, status: "queued", queueHeld: true, queuePosition: run.ordinal },
        },
      ],
    });
    yield* limits.admit({ thread, message: agent });
  });

const cancelQueuedRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.findLast(
      (run) => run.status === "queued",
    )!;
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make(`cancel:${queued.id}`),
      threadId,
      runId: queued.id,
    });
  });

it.effect("P6: a wake the restart dropped comes back as a note, held like any other", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:p6:lost");
    yield* createThread(threadId);
    yield* writePause("finish");
    yield* governor.followPause;
    yield* sendHeldWake(threadId, "Background command finished");
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* comfortable);
    assert.deepEqual(yield* runs(threadId), ["queued:held"]);

    // What T3's restart recovery does to it.
    yield* cancelQueuedRun(threadId);
    const restarted = yield* makeGovernor;
    yield* restarted.pass(yield* comfortable);
    assert.deepEqual(yield* runs(threadId), ["cancelled:held", "queued:held"]);
    const note = (yield* orchestrator.getThreadProjection(threadId)).messages.at(-1)!;
    assert.equal(note.notification?.summary, "T3 restarted while this thread was held");
    assert.include(note.text, "Background command finished");

    // It stays in the line, so resuming starts it.
    yield* removePause;
    yield* TestClock.adjust(TIMING.releaseSpacingMs);
    yield* restarted.pass(yield* recovered);
    assert.deepEqual(yield* runs(threadId), ["cancelled:held", "starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P6: Alice cancelling a held wake herself doesn't bring it back", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:p6:cancelled");
    yield* createThread(threadId);
    yield* writePause("finish");
    yield* governor.followPause;
    // The governor's first pass has already run by the time she can.
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* comfortable);
    yield* sendHeldWake(threadId, "Background command finished");
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* comfortable);
    yield* cancelQueuedRun(threadId);
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* comfortable);
    assert.deepEqual(yield* runs(threadId), ["cancelled:held"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P6: a held message that isn't a provider wake isn't brought back after a restart", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:p6:agent");
    yield* createThread(threadId);
    yield* writePause("finish");
    yield* governor.followPause;
    yield* send(threadId, "work", agent);
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* comfortable);
    yield* cancelQueuedRun(threadId);
    const restarted = yield* makeGovernor;
    yield* restarted.pass(yield* comfortable);
    assert.deepEqual(yield* runs(threadId), ["cancelled:held"]);
  }).pipe(Effect.provide(layerTest)),
);

/** A provider thread on a session that records which background tasks it was asked to end. */
const withBackgroundTasks = (
  threadId: ThreadId,
  tasks: ReadonlyArray<{ readonly taskId: string; readonly kind: "command" | "monitor" }>,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const driver = ProviderDriverKind.make("codex");
    const providerThread: OrchestrationV2ProviderThread = {
      id: ProviderThreadId.make(`provider-thread:${threadId}`),
      driver,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: ProviderSessionId.make(`provider-session:${threadId}`),
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: tasks,
      contextUsage: null,
      nativeMetadata: null,
      createdAt: now,
      updatedAt: now,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make(`background:${threadId}`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: providerThread,
        },
      ],
    });
  });

const recordingStops = Effect.gen(function* () {
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const asked = yield* Ref.make<ReadonlyArray<string>>([]);
  const session = {
    stopBackgroundTasks: (input: { readonly taskIds: ReadonlyArray<string> }) =>
      Ref.update(asked, (all) => [...all, ...input.taskIds]),
  } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
  return {
    asked: Ref.get(asked),
    sessions: { ...sessions, get: () => Effect.succeedSome(session) },
  };
});

it.effect("P7: Stop now ends a running turn's background tasks through its provider", () =>
  Effect.gen(function* () {
    const stops = yield* recordingStops;
    const governor = yield* makeGovernorWith(stops.sessions);
    const threadId = ThreadId.make("thread:p7:running");
    yield* createThread(threadId);
    yield* send(threadId, "work", agent);
    yield* withBackgroundTasks(threadId, [
      { taskId: "build", kind: "command" },
      { taskId: "pull-request-watch:7", kind: "monitor" },
    ]);
    yield* TestClock.adjust("1 second");

    yield* writePause("stop");
    yield* governor.followPause;
    assert.deepEqual(yield* stops.asked, ["build"]);
    assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P7: asking again while a provider still lists the work tries again, with one note", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const stops = yield* recordingStops;
    const { reads, tree } = yield* fakeProcessTree;
    const governor = yield* makeGovernorWith(stops.sessions, tree);
    const threadId = ThreadId.make("thread:p7:renewed");
    yield* createThread(threadId);
    yield* send(threadId, "work", agent);
    const { runs: started } = yield* orchestrator.getThreadProjection(threadId);
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("settle:p7:renewed"),
      threadId,
      runId: started[0]!.id,
    });
    yield* withBackgroundTasks(threadId, [{ taskId: "build", kind: "command" }]);
    yield* TestClock.adjust("1 second");
    yield* writePause("stop");
    yield* governor.followPause;

    yield* TestClock.adjust("1 second");
    yield* writePause("stop");
    yield* governor.followPause;
    assert.deepEqual(yield* stops.asked, ["build", "build"]);
    assert.equal(yield* Ref.get(reads), 2, "it acts on the thread again, so it reads again");
    const { messages } = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(
      messages.filter((message) => message.id.startsWith("limits:stopped-work:")).length,
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P7: a note that's been read doesn't stand in for the next stop's", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const stops = yield* recordingStops;
    const governor = yield* makeGovernorWith(stops.sessions);
    const threadId = ThreadId.make("thread:p7:read");
    yield* createThread(threadId);
    yield* send(threadId, "work", agent);
    const { runs: started } = yield* orchestrator.getThreadProjection(threadId);
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("settle:p7:read"),
      threadId,
      runId: started[0]!.id,
    });
    yield* withBackgroundTasks(threadId, [{ taskId: "build", kind: "command" }]);
    yield* TestClock.adjust("1 second");
    yield* writePause("stop");
    yield* governor.followPause;
    assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);

    // Resume starts the note's run, and it finishes.
    yield* removePause;
    yield* governor.followPause;
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("resume:p7:read"),
      threadId,
    });
    yield* endRun(threadId);
    assert.deepEqual(yield* runs(threadId), ["interrupted", "interrupted"]);

    yield* TestClock.adjust("1 second");
    yield* writePause("stop");
    yield* governor.followPause;
    assert.deepEqual(yield* runs(threadId), ["interrupted", "interrupted", "queued:held"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P7: Stop now ends an idle thread's background tasks, and its note says so", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const stops = yield* recordingStops;
    const governor = yield* makeGovernorWith(stops.sessions);
    const threadId = ThreadId.make("thread:p7:idle");
    yield* createThread(threadId);
    yield* send(threadId, "work", agent);
    const { runs: started } = yield* orchestrator.getThreadProjection(threadId);
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("settle:p7:idle"),
      threadId,
      runId: started[0]!.id,
    });
    yield* withBackgroundTasks(threadId, [{ taskId: "build", kind: "command" }]);
    yield* TestClock.adjust("1 second");

    yield* writePause("stop");
    yield* governor.followPause;
    assert.deepEqual(yield* stops.asked, ["build"]);
    const note = (yield* orchestrator.getThreadProjection(threadId)).messages.at(-1);
    assert.equal(
      note?.notification?.summary,
      "T3 stopped this thread's background work when all agents were stopped",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P7: Pause all leaves background tasks running", () =>
  Effect.gen(function* () {
    const stops = yield* recordingStops;
    const governor = yield* makeGovernorWith(stops.sessions);
    const threadId = ThreadId.make("thread:p7:finish");
    yield* createThread(threadId);
    yield* send(threadId, "work", agent);
    yield* withBackgroundTasks(threadId, [{ taskId: "build", kind: "command" }]);
    yield* TestClock.adjust("1 second");

    yield* writePause("finish");
    yield* governor.followPause;
    assert.deepEqual(yield* stops.asked, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P7: an interrupted turn's note tells it the rejection wasn't a no", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:p7:note");
    yield* createThread(threadId);
    yield* send(threadId, "work", agent);
    yield* TestClock.adjust("1 second");

    yield* writePause("stop");
    yield* governor.followPause;
    const note = (yield* orchestrator.getThreadProjection(threadId)).messages.at(-1);
    assert.include(note?.text, "that was T3 stopping it: nobody said no.");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("P8: a thread Stop now holds keeps its place through a restart right after", () =>
  Effect.gen(function* () {
    const limits = yield* ResourceLimits.ResourceLimits;
    const governor = yield* makeGovernor;
    const threadId = ThreadId.make("thread:p8:shutdown");
    yield* createThread(threadId);
    yield* send(threadId, "work", agent);
    yield* governor.pass(yield* comfortable);
    yield* TestClock.adjust("1 second");

    yield* writePause("stop");
    yield* governor.followPause;
    assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);
    // No pass has run since, and the next second's check saves the list.
    yield* governor.followPause;

    yield* limits.update((snapshot) => ({ ...snapshot, waiting: [] }));
    const restarted = yield* makeGovernor;
    yield* restarted.restore;
    assert.deepEqual(
      (yield* limits.read).waiting.map((entry) => entry.threadId),
      [threadId],
    );

    yield* removePause;
    yield* TestClock.adjust(TIMING.releaseSpacingMs);
    yield* restarted.pass(yield* recovered);
    assert.deepEqual(yield* runs(threadId), ["interrupted", "starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "P9: a launch refused during the pause comes back on resume, even after its turn ended",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const governor = yield* makeGovernor;
      const threadId = ThreadId.make("thread:p9:refused");
      yield* createThread(threadId);
      yield* send(threadId, "work", agent);
      const { runs: started } = yield* orchestrator.getThreadProjection(threadId);
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("settle:p9"),
        threadId,
        runId: started[0]!.id,
      });
      yield* withBackgroundTasks(threadId, [{ taskId: "watch", kind: "monitor" }]);
      yield* writePause("finish");
      yield* governor.followPause;

      const inbox = path.join(config.stateDir, "resource-limits", "inbox");
      yield* fs.makeDirectory(inbox, { recursive: true });
      yield* fs.writeFileString(
        path.join(inbox, "refused.json"),
        JSON.stringify({ sessionId: `native:${threadId}`, about: "a reviewer", tool: "Agent" }),
      );
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* comfortable);

      const note = (yield* orchestrator.getThreadProjection(threadId)).messages.at(-1);
      assert.include(note?.text, "a reviewer");
      assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);
    }).pipe(Effect.provide(layerTest)),
);

/** The first run of the thread there, as `t3_thread_read` reports it, or null before it has one. */
interface RunThere {
  readonly status: OrchestrationV2Run["status"];
  readonly startedAt: string | null;
  /** Set once its worktree is ready. */
  readonly worktreePath: string | null;
}

const runThere = {
  started: { status: "running", startedAt: "2026-11-16T10:00:00.000Z", worktreePath: "/cloud/w" },
  // Waiting behind that machine's own queue, or its Pause all, with its worktree ready.
  queued: { status: "queued", startedAt: null, worktreePath: "/cloud/w" },
  preparing: { status: "preparing", startedAt: null, worktreePath: null },
  setupFailed: { status: "failed", startedAt: null, worktreePath: null },
} satisfies Record<string, RunThere>;

interface CloudFaults {
  /** Launches it takes but whose replies are lost. */
  readonly loseLaunchReplies: number;
  /** Launches it fails before taking them, with this code. */
  readonly refuseLaunches: OrchestratorMcpFailure["code"] | null;
  /** Launches that never answer, once they've signalled this. */
  readonly stallLaunches: Deferred.Deferred<void> | null;
  readonly sendFailures: number;
  /** Cancels here that fail. */
  readonly cancelFailures: number;
  readonly there: RunThere | null;
  /** What `git ls-remote` reports for the branch here. */
  readonly remoteHead: {
    readonly remoteHead: string | null;
    readonly containsHead: boolean | null;
  };
  /** One-shot hooks, run inside the call they're named for. */
  readonly onLaunch: Effect.Effect<void>;
  readonly onSend: Effect.Effect<void>;
  readonly onGitStatus: Effect.Effect<void>;
  readonly onProjects: Effect.Effect<void>;
  readonly onRemoteHead: Effect.Effect<void>;
  /** The checkout here has uncommitted changes. */
  readonly dirtyCheckout: boolean;
  /** Threads there that `t3_thread_list` lists as running; the rest of those launched have finished. */
  readonly busy: ReadonlySet<string>;
  /** Other threads running there, such as code-work children, which it lists first. */
  readonly otherBusy: number;
  /** Lists that fail. */
  readonly listFailures: number;
  /** Lists that never answer, once they've signalled this. */
  readonly stallLists: Deferred.Deferred<void> | null;
}

const decodeThreadRead = Schema.decodeSync(OrchestratorMcpThreadReadResult);

/**
 * A `t3_thread_read` answer, decoded with the real schema so the fake can't drift from it. A thread launched into its
 * project's own folder (`root`) has no branch or worktree there.
 */
const threadReadThere = (threadId: string, first: RunThere | null, root = false) =>
  decodeThreadRead({
    thread: {
      threadId,
      projectId: "project:cloud",
      title: "moved",
      createdBy: "agent",
      creationSource: "mcp",
      status: first === null ? "idle" : first.status === "running" ? "running" : "idle",
      latestRunId: first === null ? null : "run:cloud:1",
      activeRunId: first?.status === "running" ? "run:cloud:1" : null,
      providerInstanceId: instanceId,
      model: modelSelection.model,
      runtimeMode: "full-access",
      interactionMode: "default",
      linkedPullRequest: null,
      titleRegeneration: null,
      branch: root ? null : "t3-moved/main",
      worktreePath: root ? null : (first?.worktreePath ?? null),
      parentThreadId: null,
      relationshipToParent: null,
      runCount: first === null ? 0 : 1,
      itemCount: 1,
      pendingRequestCount: 0,
      archived: false,
      settled: false,
      settledAt: null,
      snoozed: false,
      snoozedUntil: null,
      createdAt: "2026-11-16T10:00:00.000Z",
      updatedAt: "2026-11-16T10:00:00.000Z",
    },
    recentRuns:
      first === null
        ? []
        : [
            {
              runId: "run:cloud:1",
              ordinal: 1,
              status: first.status,
              providerInstanceId: instanceId,
              model: modelSelection.model,
              requestedAt: "2026-11-16T10:00:00.000Z",
              startedAt: first.startedAt,
              completedAt: null,
            },
          ],
    items: [],
    nextPosition: null,
    hasMore: false,
  });

const decodeThreadList = Schema.decodeSync(OrchestratorMcpThreadListResult);

/** A page of `t3_thread_list`, decoded with the real schema. */
const threadListThere = (
  threads: ReadonlyArray<{
    readonly threadId: string;
    readonly status: OrchestratorMcpThreadStatus;
  }>,
  nextCursor: number | null,
  total: number,
) =>
  decodeThreadList({
    projectId: null,
    currentThreadId: null,
    threads: threads.map(({ threadId, status }) => ({
      threadId,
      projectId: "project:cloud",
      title: "moved",
      createdBy: "agent",
      creationSource: "mcp",
      status,
      latestRunId: "run:cloud:1",
      providerInstanceId: instanceId,
      model: modelSelection.model,
      runtimeMode: "full-access",
      interactionMode: "default",
      linkedPullRequest: null,
      settled: false,
      settledAt: null,
      snoozed: false,
      snoozedUntil: null,
      parentThreadId: null,
      relationshipToParent: null,
      itemCount: 1,
      createdAt: "2026-11-16T10:00:00.000Z",
      updatedAt: "2026-11-16T10:00:00.000Z",
    })),
    nextCursor,
    total,
  });

/**
 * A linked machine with one matching project. It replays a launch or send by its request ID, as the real one does,
 * refuses a new launch onto a branch an earlier one took, records every call, and can lose replies, stall, fail late,
 * or reject calls on demand.
 */
const makeCloud = Effect.fnUntraced(function* () {
  const faults = yield* Ref.make<CloudFaults>({
    loseLaunchReplies: 0,
    refuseLaunches: null,
    stallLaunches: null,
    sendFailures: 0,
    cancelFailures: 0,
    there: runThere.started,
    remoteHead: { remoteHead: "abc123", containsHead: true },
    onLaunch: Effect.void,
    onSend: Effect.void,
    onGitStatus: Effect.void,
    onProjects: Effect.void,
    onRemoteHead: Effect.void,
    dirtyCheckout: false,
    busy: new Set(),
    otherBusy: 0,
    listFailures: 0,
    stallLists: null,
  });
  const once = (hook: "onLaunch" | "onSend" | "onGitStatus" | "onProjects" | "onRemoteHead") =>
    Effect.gen(function* () {
      const run = (yield* Ref.get(faults))[hook];
      yield* Ref.update(faults, (current) => ({ ...current, [hook]: Effect.void }));
      yield* run;
    });
  const attempts = yield* Ref.make<ReadonlyArray<ResourceLimits.MoveLaunch>>([]);
  const launched = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const branches = yield* Ref.make<ReadonlySet<string>>(new Set());
  // Threads launched into their project's own folder, and every git or repository read here.
  const roots = yield* Ref.make<ReadonlySet<string>>(new Set());
  const gitReads = yield* Ref.make<ReadonlyArray<string>>([]);
  const read = (what: string) => Ref.update(gitReads, (all) => [...all, what]);
  const sendCalls = yield* Ref.make<
    ReadonlyArray<{ threadId: string; message: string; clientRequestId: string }>
  >([]);
  const delivered = yield* Ref.make<ReadonlyMap<string, { threadId: string; message: string }>>(
    new Map(),
  );
  const failure = (message: string, code: OrchestratorMcpFailure["code"] = "orchestration_error") =>
    new OrchestratorMcpFailure({ code, message });
  const lists = yield* Ref.make(0);
  const host: Overflow.OverflowHost = {
    project: () =>
      Effect.succeed({ workspaceRoot: "/repo", repositoryKey: "github.com/alice/repo" }),
    gitStatus: () =>
      Effect.gen(function* () {
        yield* read("gitStatus");
        yield* once("onGitStatus");
        return {
          branch: "main",
          isDefaultBranch: true,
          hasWorkingTreeChanges: (yield* Ref.get(faults)).dirtyCheckout,
          upstream: { remote: "origin", branch: "main", repositoryKey: "github.com/alice/repo" },
          aheadCount: 0,
          head: "abc123",
        };
      }),
    label: () => Effect.succeed("t3-cloud"),
    projectsThere: () =>
      Effect.gen(function* () {
        yield* read("projectsThere");
        yield* once("onProjects");
        return [
          {
            id: ProjectId.make("project:cloud"),
            remotes: new Map([["github.com/alice/repo", "origin"]]),
          },
        ];
      }),
    projectsNamed: (_environmentId, _modes, name) =>
      Effect.succeed(name === "Vault" ? [{ id: ProjectId.make("project:cloud-vault") }] : []),
    providersThere: () =>
      Effect.succeed([{ instanceId, models: [modelSelection.model], omittedModels: 0 }]),
    launch: (_environmentId, _modes, input) =>
      Effect.gen(function* () {
        const fault = yield* Ref.get(faults);
        yield* Ref.update(attempts, (all) => [...all, input]);
        if (fault.stallLaunches !== null) {
          yield* Deferred.succeed(fault.stallLaunches, undefined);
          return yield* Effect.never;
        }
        yield* once("onLaunch");
        if (fault.refuseLaunches !== null) return yield* failure("refused", fault.refuseLaunches);
        const replayed = (yield* Ref.get(launched)).get(input.clientRequestId);
        // A launch with no strategy starts in the project's own folder, with no branch of its own.
        const branch =
          input.workspaceStrategy?.type === "worktree" ? input.workspaceStrategy.branch! : null;
        // A new launch can't take a branch an earlier one left there.
        if (replayed === undefined && branch !== null && (yield* Ref.get(branches)).has(branch)) {
          return yield* failure(`A branch named '${branch}' already exists.`, "invalid_request");
        }
        const base = `cloud:${input.title}`;
        const taken = [...(yield* Ref.get(launched)).values()].filter((id) => id.startsWith(base));
        const threadId = replayed ?? (taken.length === 0 ? base : `${base}:${taken.length + 1}`);
        yield* Ref.update(launched, (all) => new Map(all).set(input.clientRequestId, threadId));
        if (branch !== null) yield* Ref.update(branches, (all) => new Set(all).add(branch));
        if (input.workspaceStrategy === undefined) {
          yield* Ref.update(roots, (all) => new Set(all).add(threadId));
        }
        if (fault.loseLaunchReplies > 0) {
          yield* Ref.update(faults, (current) => ({
            ...current,
            loseLaunchReplies: current.loseLaunchReplies - 1,
          }));
          return yield* failure("the reply was lost");
        }
        return { threadId, link: `t3://cloud/${threadId}` };
      }),
    readThere: (_environmentId, _modes, threadId) =>
      Effect.gen(function* () {
        const fault = yield* Ref.get(faults);
        return threadReadThere(threadId, fault.there, (yield* Ref.get(roots)).has(threadId));
      }),
    threadsThere: (_environmentId, _modes, statuses) =>
      Effect.gen(function* () {
        const fault = yield* Ref.get(faults);
        yield* Ref.update(lists, (count) => count + 1);
        if (fault.stallLists !== null) {
          yield* Deferred.succeed(fault.stallLists, undefined);
          return yield* Effect.never;
        }
        if (fault.listFailures > 0) {
          yield* Ref.update(faults, (current) => ({
            ...current,
            listFailures: current.listFailures - 1,
          }));
          return yield* failure("asleep");
        }
        const others = Array.from({ length: fault.otherBusy }, (_, index) => ({
          threadId: `cloud:other:${index}`,
          status: "running" as const,
        }));
        const moved = [...(yield* Ref.get(launched)).values()].map((threadId) => ({
          threadId,
          status: fault.busy.has(threadId) ? ("running" as const) : ("completed" as const),
        }));
        const listed = [...others, ...moved].filter(({ status }) => statuses.includes(status));
        return threadListThere(
          listed.slice(0, 100),
          listed.length > 100 ? 100 : null,
          listed.length,
        );
      }),
    send: (_environmentId, _modes, input) =>
      Effect.gen(function* () {
        const fault = yield* Ref.get(faults);
        yield* Ref.update(sendCalls, (all) => [...all, input]);
        if (fault.sendFailures > 0) {
          yield* Ref.update(faults, (current) => ({
            ...current,
            sendFailures: current.sendFailures - 1,
          }));
          return yield* failure("asleep");
        }
        yield* Ref.update(delivered, (all) =>
          all.has(input.clientRequestId)
            ? all
            : new Map(all).set(input.clientRequestId, {
                threadId: input.threadId,
                message: input.message,
              }),
        );
        yield* once("onSend");
      }),
    remoteHead: () =>
      Effect.andThen(
        Effect.andThen(read("remoteHead"), once("onRemoteHead")),
        Effect.map(Ref.get(faults), (fault) => fault.remoteHead),
      ),
  };
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // Cancels fail while asked to, as a lost write would.
  const flakyThreads = ThreadManagementService.ThreadManagementService.of({
    ...threads,
    dispatch: (command) =>
      Effect.gen(function* () {
        const fault = yield* Ref.get(faults);
        if (command.type === "queued-run.cancel" && fault.cancelFailures > 0) {
          yield* Ref.update(faults, (current) => ({
            ...current,
            cancelFailures: current.cancelFailures - 1,
          }));
          return yield* Effect.die("cancel failed");
        }
        return yield* threads.dispatch(command);
      }),
  });
  const limits = yield* ResourceLimits.ResourceLimits;
  /** A fresh mover, as a restart builds, reading `moved.json` again. */
  const start = Effect.gen(function* () {
    yield* limits.update((snapshot) => ({ ...snapshot, moved: new Map() }));
    yield* limits.setOverflow(
      yield* Overflow.makeOverflowMover(host).pipe(
        Effect.provideService(ThreadManagementService.ThreadManagementService, flakyThreads),
      ),
    );
  });
  yield* start;
  return {
    attempts: Ref.get(attempts),
    /** Threads the launches made there, by request ID. */
    launched: Ref.get(launched),
    /** The messages there: a send repeated with its key is replayed, not added. */
    sent: Effect.map(Ref.get(delivered), (all) => [...all.values()]),
    /** Every send, including repeats and failed ones. */
    sendCalls: Ref.get(sendCalls),
    /** The git status, same-repository project and remote branch reads, in order. */
    gitReads: Ref.get(gitReads),
    /** How many times it was asked which threads are busy there. */
    lists: Ref.get(lists),
    fault: (change: (current: CloudFaults) => CloudFaults) => Ref.update(faults, change),
    restart: start,
  };
});

const overflowTo = (extra: Record<string, unknown> = {}) =>
  Effect.flatMap(ServerSettings.ServerSettingsService, (settings) =>
    settings.updateSettings({
      resourceLimits: {
        overflow: {
          environmentId: EnvironmentId.make("environment:cloud"),
          moveAfterMs: 60_000,
          ...extra,
        },
      },
    } as never),
  );

/** Tags threads the way the sidebar and agents do, on the thread itself. */
const tagThreads = (threadTags: Record<ThreadId, string>) =>
  Effect.forEach(Object.entries(threadTags) as Array<[ThreadId, string]>, ([threadId, tag]) =>
    Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.dispatch({
        type: "thread.tag.set",
        commandId: CommandId.make(`tag:${threadId}:${tag}`),
        threadId,
        tag,
        tagged: true,
      }),
    ),
  );

const movedPath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, "resource-limits", "moved.json");
});

const movedFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(yield* movedPath).pipe(
    Effect.map(
      (text) =>
        JSON.parse(text) as {
          threads: Record<string, { phase: string; threadId: string | null; batch: string[] }>;
          retryAt: Record<string, number>;
        },
    ),
    Effect.option,
  );
});

const phaseOf = (threadId: ThreadId) =>
  Effect.map(movedFile, (file) =>
    Option.match(file, {
      onNone: () => undefined,
      onSome: (saved) => saved.threads[threadId]?.phase,
    }),
  );

/** Makes `moved.json` unwritable: a directory with something in it, which a rename can't replace. */
const breakMovedFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* movedPath;
  yield* fs.remove(file, { recursive: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(`${file}/blocked`, { recursive: true });
});
const mendMovedFile = Effect.flatMap(Effect.zip(FileSystem.FileSystem, movedPath), ([fs, file]) =>
  fs.remove(file, { recursive: true }).pipe(Effect.ignore),
);

/** Runs `effect` later, from inside the fake cloud, with the services it has now. */
const later = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.context<R>(), (context) =>
    effect.pipe(Effect.provideContext(context), Effect.orDie, Effect.asVoid),
  );

/** A held thread that may move at once. */
/** A thread that may move, with agent work held. */
const heldThread = (name: string, text = "work") =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(`thread:${name}`);
    yield* createThread(threadId);
    yield* tagThreads({ [threadId]: "needs:none" });
    yield* send(threadId, text, agent);
    return threadId;
  });

const resume = (threadId: ThreadId, key: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make(`resume:${threadId}:${key}`),
      threadId,
    }),
  );

it.effect("O1: the best-ranked held thread that has waited long enough moves, one a pass", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const cloud = yield* makeCloud();
    const [older, ranked, fresh] = ["older", "ranked", "fresh"].map((name) =>
      ThreadId.make(`thread:o1:${name}`),
    ) as [ThreadId, ThreadId, ThreadId];
    yield* overflowTo({});
    yield* Effect.forEach([older, ranked, fresh], createThread);
    yield* tagThreads({ [older]: "needs:none", [ranked]: "needs:none", [fresh]: "needs:none" });
    yield* governor.pass(yield* tight);
    yield* send(older, "older work", agent);
    yield* send(ranked, "ranked work", agent);
    yield* TestClock.adjust("1 minute");
    yield* send(fresh, "fresh work", agent);
    yield* writeRanks({ [ranked]: 1 });

    yield* governor.pass(yield* tight);
    const [launch] = yield* cloud.attempts;
    assert.lengthOf(yield* cloud.attempts, 1);
    assert.include(launch!.message, "ranked work");
    assert.include(launch!.message, "git push origin HEAD:main");
    assert.include(launch!.message, "git merge-base --is-ancestor abc123 HEAD");
    assert.deepInclude(launch!.workspaceStrategy, {
      baseRef: "origin/main",
      startFromOrigin: true,
    });
    assert.match(
      launch!.workspaceStrategy?.type === "worktree" ? launch!.workspaceStrategy.branch! : "",
      /^t3-moved\/main-/,
    );
    // The held work went there, and so did the move's own note, which leaves only its notice.
    assert.deepEqual(yield* runs(ranked), ["cancelled:held", "cancelled:held"]);
    assert.include(
      (yield* notices(ranked)).at(-1),
      "This thread continues on t3-cloud (t3://cloud/",
    );
    const moved = Option.getOrThrow(yield* movedFile);
    assert.equal(moved.threads[ranked]?.threadId, `cloud:${ranked}`);
    assert.equal(moved.threads[ranked]?.phase, "moved");

    // The next pass moves the other one that has waited a minute, and the fresh one keeps waiting.
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.lengthOf(yield* cloud.attempts, 2);
    assert.deepEqual(yield* waitingThreads, [fresh]);
  }).pipe(Effect.provide(layerTest)),
);

const o2 = (name: string) => ThreadId.make(`thread:o2:${name}`);

it.effect(
  "O2: an ineligible or untagged thread keeps its place, and nothing moves while paused",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const cloud = yield* makeCloud();
      const [untagged, pc, legacy, free] = ["untagged", "pc", "legacy", "free"].map(o2) as [
        ThreadId,
        ThreadId,
        ThreadId,
        ThreadId,
      ];
      yield* overflowTo({ provides: ["notion"] });
      yield* Effect.forEach([untagged, pc, legacy, free], createThread);
      // fork: thread tags. A `needs:` still in settings counts until it moves onto the thread.
      yield* tagThreads({ [pc]: "needs:pc", [legacy]: "needs:none", [free]: "needs:none" });
      yield* governor.pass(yield* tight);
      yield* Effect.forEach([untagged, pc, legacy, free], (threadId) =>
        send(threadId, "work", agent),
      );
      yield* TestClock.adjust("2 minutes");

      yield* writePause("finish");
      yield* governor.pass(yield* tight);
      assert.lengthOf(yield* cloud.attempts, 0);

      yield* removePause;
      yield* governor.pass(yield* tight);
      assert.lengthOf(yield* cloud.attempts, 1);
      assert.deepEqual(yield* runs(free), ["cancelled:held", "cancelled:held"]);
      assert.deepEqual(yield* runs(untagged), ["queued:held"]);
      assert.deepEqual(yield* runs(pc), ["queued:held"]);
      assert.deepEqual(yield* runs(legacy), ["queued:held"]);
    }).pipe(Effect.provide(layerTestWith({ threadTags: { [o2("legacy")]: ["needs:pc"] } }))),
);

it.effect(
  "O3: a later message to a moved thread goes there, even during Pause all, and a buffered wake stays",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const cloud = yield* makeCloud();
      const threadId = ThreadId.make("thread:o3:moved");
      yield* overflowTo({ moveAfterMs: 0 });
      yield* createThread(threadId);
      yield* tagThreads({ [threadId]: "needs:none" });
      yield* governor.pass(yield* tight);
      yield* send(threadId, "work", agent);
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), "moved");

      // Admission held something for it before the run committed; there's no flag for a pass to drain.
      const limits = yield* ResourceLimits.ResourceLimits;
      assert.isDefined(yield* limits.movedHold(threadId));
      yield* governor.pass(yield* comfortable);

      // Even Alice's own message, with memory to spare, waits to be sent there, and goes during Pause all.
      yield* send(threadId, "and one more thing", alice);
      assert.deepEqual((yield* runs(threadId)).at(-1), "queued:held");
      yield* writePause("finish");
      yield* governor.pass(yield* comfortable);
      assert.deepEqual(yield* cloud.sent, [
        { threadId: `cloud:${threadId}`, message: "and one more thing" },
      ]);
      assert.deepEqual(yield* runs(threadId), [
        "cancelled:held",
        "cancelled:held",
        "cancelled:held",
      ]);

      // Claude started a buffered wake's turn here, so it runs here, queued behind another or not.
      yield* sendProviderWake(threadId, "first wake");
      yield* sendProviderWake(threadId, "second wake");
      assert.deepEqual((yield* runs(threadId)).slice(3), ["starting", "queued"]);
      const started = yield* awaitRunUpdate(threadId, (run) => run.status === "starting");
      yield* endRun(threadId);
      yield* started;
      assert.deepEqual((yield* runs(threadId)).slice(3), ["interrupted", "starting"]);
      yield* governor.pass(yield* comfortable);
      assert.lengthOf(yield* cloud.sent, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "O4: a launch the link never answers stays pending with its key, and only a refusal ends it",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const cloud = yield* makeCloud();
      yield* cloud.fault((current) => ({ ...current, refuseLaunches: "orchestration_error" }));
      yield* overflowTo({ moveAfterMs: 0 });
      yield* governor.pass(yield* tight);
      const threadId = yield* heldThread("o4:asleep");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), "pending");

      // Long past any retry window, it's still the same launch, and the batch is still held here.
      yield* TestClock.adjust(TIMING.moveRetryMs * 3);
      yield* governor.pass(yield* comfortable);
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), "pending");
      assert.deepEqual(yield* runs(threadId), ["queued:held"]);
      const keys = new Set((yield* cloud.attempts).map((attempt) => attempt.clientRequestId));
      assert.equal(keys.size, 1);
      assert.lengthOf(yield* cloud.attempts, 3);

      // The machine answers that it won't take it: the batch stays here and the thread waits before trying again.
      yield* cloud.fault((current) => ({ ...current, refuseLaunches: "model_unavailable" }));
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.isUndefined(yield* phaseOf(threadId));
      assert.deepEqual(yield* runs(threadId), ["queued:held"]);
      assert.deepEqual(yield* waitingThreads, [threadId]);
      const tried = (yield* cloud.attempts).length;
      yield* cloud.fault((current) => ({ ...current, refuseLaunches: null }));
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.lengthOf(yield* cloud.attempts, tried);

      // After the wait it tries again as a new move.
      yield* TestClock.adjust(TIMING.moveRetryMs);
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), "moved");
      assert.isFalse(keys.has((yield* cloud.attempts).at(-1)!.clientRequestId));
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "O5: a lost launch reply repeats the frozen launch; a message and a Resume meanwhile stay here",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const cloud = yield* makeCloud();
      yield* cloud.fault((current) => ({ ...current, loseLaunchReplies: 1 }));
      yield* overflowTo({ moveAfterMs: 0 });
      yield* governor.pass(yield* tight);
      const threadId = yield* heldThread("o5:lost", "first");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), "pending");

      yield* send(threadId, "second", agent);
      yield* resume(threadId, "during-move");
      assert.deepEqual(yield* runs(threadId), ["queued:held", "queued"]);
      assert.include((yield* notices(threadId)).at(-1), "T3 is moving this thread to t3-cloud");

      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      const attempts = yield* cloud.attempts;
      assert.lengthOf(attempts, 2);
      assert.equal(attempts[1]!.message, attempts[0]!.message);
      assert.notInclude(attempts[1]!.message, "second");
      assert.equal((yield* cloud.launched).size, 1);
      // The first went with the launch; the second is forwarded as any later message is.
      assert.deepEqual(yield* cloud.sent, [{ threadId: `cloud:${threadId}`, message: "second" }]);
      assert.deepEqual(yield* runs(threadId), [
        "cancelled:held",
        "cancelled:held",
        "cancelled:held",
      ]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("O6: a restart at each phase carries the move on without repeating it", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const cloud = yield* makeCloud();
    const phases = [
      ["pending", { loseLaunchReplies: 1 }],
      ["launched", { there: runThere.queued }],
      // A cancel that failed leaves it here too, restart or not.
      ["confirmed", { cancelFailures: 1 }],
      ["moved", {}],
    ] as const;
    // Each lands within the last ones' hold there, so the cap leaves room for all of them.
    yield* overflowTo({ moveAfterMs: 0, maxBusy: phases.length });
    yield* governor.pass(yield* tight);
    for (const [phase, fault] of phases) {
      const threadId = yield* heldThread(`o6:${phase}`);
      yield* cloud.fault((current) => ({ ...current, ...fault }));
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), phase);

      yield* cloud.fault((current) => ({ ...current, there: runThere.started }));
      yield* cloud.restart;
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), "moved", phase);
      assert.deepEqual(yield* runs(threadId), ["cancelled:held", "cancelled:held"], phase);
      assert.lengthOf(
        (yield* notices(threadId)).filter((notice) => notice.includes("continues on")),
        1,
        phase,
      );
    }
    assert.equal((yield* cloud.launched).size, phases.length);
    // What a launch carried there is never sent again.
    assert.deepEqual(yield* cloud.sendCalls, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "O7: a move whose moved.json can't be written stops at that step and changes nothing",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const cloud = yield* makeCloud();
      const limits = yield* ResourceLimits.ResourceLimits;
      yield* overflowTo({ moveAfterMs: 0 });
      yield* governor.pass(yield* tight);
      const threadId = yield* heldThread("o7:unwritable");

      yield* breakMovedFile;
      yield* governor.pass(yield* tight);
      assert.lengthOf(yield* cloud.attempts, 0);
      assert.isFalse((yield* limits.read).moved.has(threadId));
      assert.deepEqual(yield* runs(threadId), ["queued:held"]);

      // Written as pending, then unwritable once the launch returns: it stays pending, and the retry finds that thread.
      yield* mendMovedFile;
      const onLaunch = yield* later(breakMovedFile);
      yield* cloud.fault((current) => ({ ...current, onLaunch }));
      yield* TestClock.adjust(TIMING.moveRetryMs);
      yield* governor.pass(yield* tight);
      assert.equal((yield* limits.read).moved.get(threadId)?.phase, "pending");
      assert.deepEqual(yield* runs(threadId), ["queued:held"]);

      yield* mendMovedFile;
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), "moved");
      assert.lengthOf(yield* cloud.attempts, 2);
      assert.equal((yield* cloud.launched).size, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "O8: only a first run that started there confirms; queued there it waits, and a failed setup leaves the batch here",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const cloud = yield* makeCloud();
      yield* cloud.fault((current) => ({ ...current, there: null }));
      yield* overflowTo({ moveAfterMs: 0 });
      yield* governor.pass(yield* tight);
      const threadId = yield* heldThread("o8:late");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), "launched");

      // Queued there with its worktree ready, as that machine's own Pause all leaves it: not started.
      for (const there of [runThere.preparing, runThere.queued]) {
        yield* cloud.fault((current) => ({ ...current, there }));
        yield* TestClock.adjust("15 seconds");
        yield* governor.pass(yield* tight);
        assert.equal(yield* phaseOf(threadId), "launched");
        assert.deepEqual(yield* runs(threadId), ["queued:held"]);
      }

      yield* cloud.fault((current) => ({ ...current, there: runThere.setupFailed }));
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.isUndefined(yield* phaseOf(threadId));
      assert.deepEqual(yield* runs(threadId), ["queued:held"]);
      assert.deepEqual(yield* waitingThreads, [threadId]);

      // Memory back: it's released here like any other held thread.
      yield* governor.pass(yield* comfortable);
      assert.deepEqual(yield* runs(threadId), ["starting"]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "O9: forwarding keeps order through a failed send, a failed cancel, and a message that arrives meanwhile",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const cloud = yield* makeCloud();
      yield* overflowTo({ moveAfterMs: 0 });
      yield* governor.pass(yield* tight);
      const threadId = yield* heldThread("o9:forward");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), "moved");

      yield* send(threadId, "one", agent);
      yield* send(threadId, "two", agent);
      yield* cloud.fault((current) => ({ ...current, sendFailures: 1 }));
      yield* governor.pass(yield* tight);
      assert.deepEqual(yield* cloud.sent, []);

      const onSend = yield* later(send(threadId, "three", agent));
      yield* cloud.fault((current) => ({ ...current, onSend }));
      yield* governor.pass(yield* tight);
      assert.deepEqual(
        (yield* cloud.sent).map((sent) => sent.message),
        ["one", "two"],
      );
      yield* cloud.fault((current) => ({ ...current, cancelFailures: 1 }));
      yield* governor.pass(yield* tight);
      assert.deepEqual(
        (yield* cloud.sent).map((sent) => sent.message),
        ["one", "two"],
      );
      yield* governor.pass(yield* tight);
      assert.deepEqual(
        (yield* cloud.sent).map((sent) => sent.message),
        ["one", "two", "three"],
      );
      assert.deepEqual(
        (yield* runs(threadId)).filter((run) => run !== "cancelled:held"),
        [],
      );
      // A restart in between sends nothing twice.
      yield* cloud.restart;
      yield* governor.pass(yield* tight);
      assert.lengthOf(yield* cloud.sent, 3);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "O10: a Resume while the batch is claimed is held, and one that started a run first stops the move",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const cloud = yield* makeCloud();
      yield* overflowTo({ moveAfterMs: 0 });
      yield* governor.pass(yield* tight);

      // Claimed: the Resume is held, and what it would have started goes there.
      const claimed = yield* heldThread("o10:claimed");
      const onRemoteHead = yield* later(resume(claimed, "claiming"));
      yield* cloud.fault((current) => ({ ...current, onRemoteHead }));
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(claimed), "moved");
      assert.deepEqual(yield* runs(claimed), ["cancelled:held", "cancelled:held"]);
      assert.include((yield* cloud.attempts)[0]!.message, "work");

      // Resumed before the claim: it runs here, so it doesn't move.
      const started = yield* heldThread("o10:started");
      const onGitStatus = yield* later(resume(started, "before-claim"));
      yield* cloud.fault((current) => ({ ...current, onGitStatus }));
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.lengthOf(yield* cloud.attempts, 1);
      assert.isUndefined(yield* phaseOf(started));
      assert.deepEqual(yield* runs(started), ["starting"]);
      const limits = yield* ResourceLimits.ResourceLimits;
      assert.isFalse((yield* limits.read).moved.has(started));
    }).pipe(Effect.provide(layerTest)),
);

it.effect("O11: Pause all switched on during a move's reads stops it before it launches", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const cloud = yield* makeCloud();
    yield* overflowTo({ moveAfterMs: 0 });
    yield* governor.pass(yield* tight);
    const threadId = yield* heldThread("o11:paused");
    const onProjects = yield* later(writePause("finish"));
    yield* cloud.fault((current) => ({ ...current, onProjects }));
    yield* governor.pass(yield* tight);
    assert.lengthOf(yield* cloud.attempts, 0);
    assert.isUndefined(yield* phaseOf(threadId));
    const limits = yield* ResourceLimits.ResourceLimits;
    assert.isFalse((yield* limits.read).moved.has(threadId));
    assert.deepEqual(yield* runs(threadId), ["queued:held"]);

    yield* removePause;
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(threadId), "moved");
  }).pipe(Effect.provide(layerTest)),
);

/** Edits the thread's last run, as Alice edits a queued message. */
const editLast = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.findLast(
      (candidate) => !candidate.userMessageId.startsWith("limits:"),
    )!;
    yield* orchestrator.dispatch({
      type: "queued-run.edit",
      commandId: CommandId.make(`edit:${run.id}:${text}`),
      threadId,
      runId: run.id,
      text,
    });
  });

it.effect(
  "O12: a batch message edited during the move, and a forwarded one, arrive as they read",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const cloud = yield* makeCloud();
      yield* cloud.fault((current) => ({ ...current, there: runThere.queued }));
      yield* overflowTo({ moveAfterMs: 0 });
      yield* governor.pass(yield* tight);
      const threadId = yield* heldThread("o12:edited", "fix the bug");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), "launched");

      yield* editLast(threadId, "fix the bug in parser.ts");
      yield* cloud.fault((current) => ({ ...current, there: runThere.started }));
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), "moved");
      const [edited] = yield* cloud.sent;
      assert.include(edited!.message, "was edited on");
      assert.include(edited!.message, "fix the bug in parser.ts");

      // Cancelled before it's read, so a forwarded message goes as it reads then, and can't change after.
      yield* send(threadId, "then the tests", agent);
      yield* editLast(threadId, "then the parser tests");
      yield* cloud.fault((current) => ({ ...current, sendFailures: 1 }));
      yield* governor.pass(yield* tight);
      yield* Effect.flip(editLast(threadId, "too late"));
      yield* governor.pass(yield* tight);
      assert.deepEqual((yield* cloud.sent).map((sent) => sent.message).slice(1), [
        "then the parser tests",
      ]);
      assert.deepEqual(
        [...new Set((yield* cloud.sendCalls).slice(1).map((sent) => sent.message))],
        ["then the parser tests"],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("O13: a branch rewound or gone on its remote doesn't move", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const cloud = yield* makeCloud();
    yield* overflowTo({ moveAfterMs: 0 });
    yield* governor.pass(yield* tight);
    const threadId = yield* heldThread("o13:rewound");
    for (const remoteHead of [
      { remoteHead: "def456", containsHead: false },
      { remoteHead: null, containsHead: null },
      { remoteHead: "fed789", containsHead: null },
    ]) {
      yield* cloud.fault((current) => ({ ...current, remoteHead }));
      yield* TestClock.adjust(TIMING.moveRetryMs);
      yield* governor.pass(yield* tight);
      assert.lengthOf(yield* cloud.attempts, 0);
      assert.isUndefined(yield* phaseOf(threadId));
      assert.deepEqual(yield* runs(threadId), ["queued:held"]);
    }

    // Pushed to since, with this commit in it: it moves.
    yield* cloud.fault((current) => ({
      ...current,
      remoteHead: { remoteHead: "0a1b2c", containsHead: true },
    }));
    yield* TestClock.adjust(TIMING.moveRetryMs);
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(threadId), "moved");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("O14: a later move of a thread whose setup failed there gets a branch of its own", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const cloud = yield* makeCloud();
    yield* cloud.fault((current) => ({ ...current, there: runThere.setupFailed }));
    yield* overflowTo({ moveAfterMs: 0 });
    yield* governor.pass(yield* tight);
    const threadId = yield* heldThread("o14:retried");
    yield* governor.pass(yield* tight);
    assert.isUndefined(yield* phaseOf(threadId));

    yield* cloud.fault((current) => ({ ...current, there: runThere.started }));
    yield* TestClock.adjust(TIMING.moveRetryMs);
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(threadId), "moved");
    const branches = (yield* cloud.attempts).map((attempt) =>
      attempt.workspaceStrategy?.type === "worktree" ? attempt.workspaceStrategy.branch : null,
    );
    assert.lengthOf(branches, 2);
    assert.notEqual(branches[0], branches[1]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("O15: a launch that never answers ends with the call, and the move stays pending", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const cloud = yield* makeCloud();
    const stalled = yield* Deferred.make<void>();
    yield* cloud.fault((current) => ({ ...current, stallLaunches: stalled }));
    yield* overflowTo({ moveAfterMs: 0 });
    yield* governor.pass(yield* tight);
    const threadId = yield* heldThread("o15:stalled");
    const pass = yield* governor.pass(yield* tight).pipe(Effect.forkChild);
    yield* Deferred.await(stalled);
    yield* TestClock.adjust(TIMING.overflowCallMs);
    yield* Fiber.join(pass);
    assert.equal(yield* phaseOf(threadId), "pending");
    assert.deepEqual(yield* runs(threadId), ["queued:held"]);

    yield* cloud.fault((current) => ({ ...current, stallLaunches: null }));
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(threadId), "moved");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("O16: a pass where one move lands starts no other", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const cloud = yield* makeCloud();
    yield* cloud.fault((current) => ({ ...current, there: runThere.queued }));
    yield* overflowTo({ moveAfterMs: 0 });
    yield* governor.pass(yield* tight);
    const first = yield* heldThread("o16:first");
    yield* governor.pass(yield* tight);
    const second = yield* heldThread("o16:second");
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(first), "launched");
    assert.lengthOf(yield* cloud.attempts, 1);

    yield* cloud.fault((current) => ({ ...current, there: runThere.started }));
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(first), "moved");
    assert.lengthOf(yield* cloud.attempts, 1);

    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(second), "moved");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("O17: a thread that couldn't move still waits after a restart", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const cloud = yield* makeCloud();
    yield* cloud.fault((current) => ({
      ...current,
      remoteHead: { remoteHead: "def456", containsHead: false },
    }));
    yield* overflowTo({ moveAfterMs: 0 });
    yield* governor.pass(yield* tight);
    const threadId = yield* heldThread("o17:waiting");
    yield* governor.pass(yield* tight);
    assert.isUndefined(yield* phaseOf(threadId));

    yield* cloud.fault((current) => ({
      ...current,
      remoteHead: { remoteHead: "abc123", containsHead: true },
    }));
    yield* cloud.restart;
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.lengthOf(yield* cloud.attempts, 0);

    yield* TestClock.adjust(TIMING.moveRetryMs);
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(threadId), "moved");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "O18: a checkout-free thread moves from a dirty checkout into the named project, with no worktree",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const cloud = yield* makeCloud();
      yield* cloud.fault((current) => ({ ...current, dirtyCheckout: true }));
      // Listed as someone might type it, with a trailing slash.
      const checkoutFree = (project: string) => ({
        moveAfterMs: 0,
        checkoutFree: {
          repositories: ["github.com/alice/repo/"],
          project,
          note: "Reach the vault through its tools.",
        },
      });
      yield* overflowTo(checkoutFree("Gone"));
      yield* governor.pass(yield* tight);
      const threadId = yield* heldThread("o18:vault");

      // Without its project there, it waits.
      yield* governor.pass(yield* tight);
      assert.lengthOf(yield* cloud.attempts, 0);
      assert.deepEqual(yield* runs(threadId), ["queued:held"]);

      yield* overflowTo(checkoutFree("Vault"));
      yield* TestClock.adjust(TIMING.moveRetryMs);
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), "moved");
      const [launch] = yield* cloud.attempts;
      assert.equal(launch!.projectId, ProjectId.make("project:cloud-vault"));
      assert.isUndefined(launch!.workspaceStrategy);
      assert.include(launch!.message, "github.com/alice/repo, which isn't on this machine");
      assert.include(launch!.message, "Reach the vault through its tools.");
      assert.notInclude(launch!.message, "git push");

      // A second one moves into the same folder too, where it has no branch to collide with the first's.
      const second = yield* heldThread("o18:vault2", "more work");
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(second), "moved");
      assert.lengthOf(yield* cloud.attempts, 2);
      // Neither move read the checkout's status, a project by repository, or the remote branch.
      assert.deepEqual(yield* cloud.gitReads, []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("O19: a needs: tag set after the first look, before the claim, stops the move", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const cloud = yield* makeCloud();
    yield* overflowTo({ moveAfterMs: 0 });
    yield* governor.pass(yield* tight);
    const threadId = yield* heldThread("o19:tagged");
    // fork: thread tags. Tagged while the first look reads git, after it read the tags.
    const onGitStatus = yield* later(tagThreads({ [threadId]: "needs:pc" }));
    yield* cloud.fault((current) => ({ ...current, onGitStatus }));
    yield* governor.pass(yield* tight);
    assert.lengthOf(yield* cloud.attempts, 0);
    assert.isUndefined(yield* phaseOf(threadId));
    const limits = yield* ResourceLimits.ResourceLimits;
    assert.isFalse((yield* limits.read).moved.has(threadId));
    assert.deepEqual(yield* runs(threadId), ["queued:held"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "O20: a standing thread held at the critical line stays here, and the next thread moves",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const cloud = yield* makeCloud();
      yield* overflowTo({ moveAfterMs: 0 });
      yield* governor.pass(yield* critical);
      // The inbox has waited longest, so it would move first if it could.
      const inbox = yield* heldThread("o20:inbox", "recording");
      yield* TestClock.adjust("1 second");
      yield* heldThread("o20:other", "other work");
      yield* writeStanding([inbox]);
      yield* governor.pass(yield* critical);
      const [launch] = yield* cloud.attempts;
      assert.lengthOf(yield* cloud.attempts, 1);
      assert.include(launch!.message, "other work");
      assert.isUndefined(yield* phaseOf(inbox));
      assert.deepEqual(yield* runs(inbox), ["queued:held"]);
    }).pipe(Effect.provide(layerTest)),
);

/** A governor and a cloud with `maxBusy: 2`, where two moved threads are running. */
const capReached = Effect.gen(function* () {
  const governor = yield* makeGovernor;
  const cloud = yield* makeCloud();
  yield* overflowTo({ moveAfterMs: 0, maxBusy: 2 });
  yield* governor.pass(yield* tight);
  for (const name of ["first", "second"]) {
    const threadId = yield* heldThread(`cap:${name}`);
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(threadId), "moved");
  }
  const there = [...(yield* cloud.launched).values()];
  yield* cloud.fault((current) => ({ ...current, busy: new Set(there) }));
  return { governor, cloud, there };
});

const cappedLogs = (logs: ReadonlyArray<string>) =>
  logs.filter((name) => name === "resource-limits.move-capped");

it.effect(
  "CAP-1: while maxBusy moved threads are busy there, due threads stay here with no wait, logged once a pass",
  () =>
    Effect.gen(function* () {
      const { governor, cloud } = yield* capReached;
      const waiting = [yield* heldThread("cap1:one"), yield* heldThread("cap1:two")];
      for (const _pass of [1, 2]) {
        yield* TestClock.adjust("15 seconds");
        const logs = yield* logged(governor.pass(yield* tight));
        assert.lengthOf(cappedLogs(logs), 1);
        assert.notInclude(logs, "resource-limits.move-skipped");
      }
      assert.lengthOf(yield* cloud.attempts, 2);
      for (const threadId of waiting) {
        assert.deepEqual(yield* runs(threadId), ["queued:held"]);
        assert.isUndefined(yield* phaseOf(threadId));
      }
      assert.deepEqual(Option.getOrThrow(yield* movedFile).retryAt, {});
      assert.includeMembers(yield* waitingThreads, waiting);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("CAP-2: once one there frees its place, the next thread in rank order moves", () =>
  Effect.gen(function* () {
    const { governor, cloud, there } = yield* capReached;
    const older = yield* heldThread("cap2:older");
    yield* TestClock.adjust("1 second");
    const ranked = yield* heldThread("cap2:ranked");
    yield* writeRanks({ [ranked]: 1 });
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.lengthOf(yield* cloud.attempts, 2);

    // The first one finishes there, so once its hold ends one more may move: the ranked one, though the other has
    // waited longer.
    yield* cloud.fault((current) => ({ ...current, busy: new Set([there[1]!]) }));
    yield* TestClock.adjust(TIMING.movedSessionMs);
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(ranked), "moved");
    assert.deepEqual(yield* runs(older), ["queued:held"]);

    // It runs there now, which fills the places again until the other one there finishes.
    const rankedThere = [...(yield* cloud.launched).values()].find((id) => !there.includes(id))!;
    yield* cloud.fault((current) => ({ ...current, busy: new Set([there[1]!, rankedThere]) }));
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.isUndefined(yield* phaseOf(older));
    yield* cloud.fault((current) => ({ ...current, busy: new Set([rankedThere]) }));
    yield* TestClock.adjust(TIMING.movedSessionMs);
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(older), "moved");
    assert.lengthOf(yield* cloud.attempts, 4);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("CAP-3: a read there that fails, doesn't answer or lists only part counts as busy", () =>
  Effect.gen(function* () {
    const { governor, cloud } = yield* capReached;
    // Neither moved thread is busy there, nor holds its place any more, but the read fails.
    yield* cloud.fault((current) => ({ ...current, busy: new Set(), listFailures: 1 }));
    yield* TestClock.adjust(TIMING.movedSessionMs);
    const failed = yield* heldThread("cap3:failed");
    yield* TestClock.adjust("15 seconds");
    assert.lengthOf(cappedLogs(yield* logged(governor.pass(yield* tight))), 1);
    assert.deepEqual(yield* runs(failed), ["queued:held"]);
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(failed), "moved");

    // A read that never answers ends with the call.
    const stalled = yield* Deferred.make<void>();
    yield* cloud.fault((current) => ({ ...current, stallLists: stalled }));
    const unanswered = yield* heldThread("cap3:unanswered");
    yield* TestClock.adjust("15 seconds");
    const pass = yield* governor.pass(yield* tight).pipe(Effect.forkChild);
    yield* Deferred.await(stalled);
    yield* TestClock.adjust(TIMING.overflowCallMs);
    yield* Fiber.join(pass);
    assert.deepEqual(yield* runs(unanswered), ["queued:held"]);
    yield* cloud.fault((current) => ({ ...current, stallLists: null }));
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(unanswered), "moved");

    // More threads run there than one read lists, so the moved ones may be among the rest.
    yield* cloud.fault((current) => ({ ...current, otherBusy: 150 }));
    yield* TestClock.adjust(TIMING.movedSessionMs);
    const crowded = yield* heldThread("cap3:crowded");
    const before = yield* cloud.lists;
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.equal((yield* cloud.lists) - before, 1);
    assert.deepEqual(yield* runs(crowded), ["queued:held"]);
    assert.deepEqual(Option.getOrThrow(yield* movedFile).retryAt, {});
    yield* cloud.fault((current) => ({ ...current, otherBusy: 0 }));
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(crowded), "moved");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("CAP-3: a pass reads there once at most, however many threads have moved", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const cloud = yield* makeCloud();
    yield* overflowTo({ moveAfterMs: 60_000, maxBusy: 2 });
    yield* governor.pass(yield* tight);
    // Under the cap, nothing is read; at it, one read a pass, as more pile up in moved.json. Each waits out the
    // holds of the ones before.
    for (const [index, reads] of [0, 0, 1, 1, 1].entries()) {
      const threadId = yield* heldThread(`cap3:pile:${index}`);
      const before = yield* cloud.lists;
      yield* TestClock.adjust(TIMING.movedSessionMs);
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), "moved");
      assert.equal((yield* cloud.lists) - before, reads, `move ${index}`);
    }
    // A held thread that hasn't waited `moveAfterMs` isn't due, so nothing is read.
    const fresh = yield* heldThread("cap3:fresh");
    const before = yield* cloud.lists;
    yield* TestClock.adjust("15 seconds");
    assert.lengthOf(cappedLogs(yield* logged(governor.pass(yield* tight))), 0);
    assert.equal(yield* cloud.lists, before);
    assert.deepEqual(yield* runs(fresh), ["queued:held"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "CAP-3: a move under way through a restart holds the next one, and counts once it lands there",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const cloud = yield* makeCloud();
      yield* overflowTo({ moveAfterMs: 0, maxBusy: 1 });
      yield* governor.pass(yield* tight);
      const first = yield* heldThread("cap3:first");
      // It takes the launch and loses the reply, twice, so the move is still pending at the restart.
      yield* cloud.fault((current) => ({ ...current, loseLaunchReplies: 2 }));
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(first), "pending");
      const next = yield* heldThread("cap3:next");
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(first), "pending");
      assert.isUndefined(yield* phaseOf(next));

      // Its thread there runs once the launch is found again after the restart.
      yield* cloud.fault((current) => ({ ...current, busy: new Set([`cloud:${first}`]) }));
      yield* cloud.restart;
      for (const _pass of [1, 2]) {
        yield* TestClock.adjust("15 seconds");
        yield* governor.pass(yield* tight);
      }
      assert.equal(yield* phaseOf(first), "moved");
      assert.isUndefined(yield* phaseOf(next));
      assert.equal((yield* cloud.launched).size, 1);

      yield* cloud.fault((current) => ({ ...current, busy: new Set() }));
      yield* TestClock.adjust(TIMING.movedSessionMs);
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(next), "moved");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("CAP-4: with maxBusy left out, three moved threads fill the places there", () =>
  Effect.gen(function* () {
    const governor = yield* makeGovernor;
    const cloud = yield* makeCloud();
    yield* overflowTo({ moveAfterMs: 0 });
    yield* governor.pass(yield* tight);
    for (const index of [1, 2, 3]) {
      const threadId = yield* heldThread(`cap4:${index}`);
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(threadId), "moved");
    }
    assert.equal(yield* cloud.lists, 0);

    // None was ever seen busy there, but each holds its place from when it landed.
    const fourth = yield* heldThread("cap4:4");
    yield* TestClock.adjust("15 seconds");
    assert.lengthOf(cappedLogs(yield* logged(governor.pass(yield* tight))), 1);
    assert.isUndefined(yield* phaseOf(fourth));
    yield* TestClock.adjust(TIMING.movedSessionMs);
    yield* governor.pass(yield* tight);
    assert.equal(yield* phaseOf(fourth), "moved");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "CAP-6: a moved thread that finishes there keeps its place until movedSessionMs after it was last seen busy",
  () =>
    Effect.gen(function* () {
      const { governor, cloud } = yield* capReached;
      const waiting = yield* heldThread("cap6:waiting");
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.isUndefined(yield* phaseOf(waiting));

      // Both finish there, and their sessions stay loaded a while; a read that finds them idle changes nothing.
      yield* cloud.fault((current) => ({ ...current, busy: new Set() }));
      yield* TestClock.adjust(TIMING.movedSessionMs - 15_000);
      const logs = yield* logged(governor.pass(yield* tight));
      assert.lengthOf(cappedLogs(logs), 1);
      assert.notInclude(logs, "resource-limits.move-skipped");
      assert.isUndefined(yield* phaseOf(waiting));

      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(waiting), "moved");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "CAP-6: after a restart, a thread that just moved keeps its place from when it moved",
  () =>
    Effect.gen(function* () {
      const governor = yield* makeGovernor;
      const cloud = yield* makeCloud();
      yield* overflowTo({ moveAfterMs: 0, maxBusy: 1 });
      yield* governor.pass(yield* tight);
      const first = yield* heldThread("cap6:first");
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(first), "moved");

      // It's done there at once, and the restart has only moved.json to go on.
      yield* cloud.restart;
      const next = yield* heldThread("cap6:next");
      yield* TestClock.adjust(TIMING.movedSessionMs - 15_000);
      assert.lengthOf(cappedLogs(yield* logged(governor.pass(yield* tight))), 1);
      assert.isUndefined(yield* phaseOf(next));
      yield* TestClock.adjust("15 seconds");
      yield* governor.pass(yield* tight);
      assert.equal(yield* phaseOf(next), "moved");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "CAP-7: at the cap, a due thread that can't move waits as before, and nothing is read there",
  () =>
    Effect.gen(function* () {
      const { governor, cloud } = yield* capReached;
      const blocked = ThreadId.make("thread:cap7:blocked");
      yield* createThread(blocked);
      yield* tagThreads({ [blocked]: "needs:pc" });
      yield* send(blocked, "work", agent);
      const before = yield* cloud.lists;
      yield* TestClock.adjust("15 seconds");
      const skipped = yield* logged(governor.pass(yield* tight));
      assert.include(skipped, "resource-limits.move-skipped");
      assert.lengthOf(cappedLogs(skipped), 0);
      assert.equal(yield* cloud.lists, before);
      assert.deepEqual(Object.keys(Option.getOrThrow(yield* movedFile).retryAt), [blocked]);

      // While it waits out its skip, nothing is due, so a pass reads nothing and logs nothing.
      yield* TestClock.adjust("15 seconds");
      const quiet = yield* logged(governor.pass(yield* tight));
      assert.notInclude(quiet, "resource-limits.move-skipped");
      assert.lengthOf(cappedLogs(quiet), 0);
      assert.equal(yield* cloud.lists, before);

      // A thread that may move reads once, and the cap holds it.
      const eligible = yield* heldThread("cap7:eligible");
      yield* TestClock.adjust("15 seconds");
      const capped = yield* logged(governor.pass(yield* tight));
      assert.lengthOf(cappedLogs(capped), 1);
      assert.notInclude(capped, "resource-limits.move-skipped");
      assert.equal((yield* cloud.lists) - before, 1);
      assert.isUndefined(yield* phaseOf(eligible));
      assert.deepEqual(yield* runs(blocked), ["queued:held"]);
    }).pipe(Effect.provide(layerTest)),
);
