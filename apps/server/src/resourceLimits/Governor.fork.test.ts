import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
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
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Governor from "./Governor.ts";
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
const layerTest = ThreadManagementService.layer.pipe(
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
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(layerLimits),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-resource-limits-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

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

const send = (
  threadId: ThreadId,
  text: string,
  from: {
    readonly createdBy: "user" | "agent";
    readonly creationSource: "web" | "mcp";
    readonly scheduledTaskId?: ScheduledTaskId;
    readonly senderThreadId?: ThreadId;
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

/** A wake as versions before `isBufferedWake` held it, which the restart that installs this one can find. */
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
