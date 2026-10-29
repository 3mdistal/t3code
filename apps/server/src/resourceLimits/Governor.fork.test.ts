import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import { GiB, type HostReading, TIMING } from "./policy.ts";
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

/** A governor whose idle-session closing is recorded, with the state admission saw at the time. */
const makeGovernor = Effect.gen(function* () {
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const limits = yield* ResourceLimits.ResourceLimits;
  const closings = yield* Ref.make<ReadonlyArray<string>>([]);
  const governor = yield* Governor.make().pipe(
    Effect.provideService(HostProcess.Platform, "win32"),
    Effect.provideService(ResourceLimits.TotalMemoryBytes, 128 * GiB),
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
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* roomy);
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* roomy);
    assert.deepEqual(yield* started, [true, true, true, false]);

    // The fourth waits, and starts two minutes after the first.
    yield* TestClock.adjust("15 seconds");
    yield* governor.pass(yield* roomy);
    assert.deepEqual(yield* started, [true, true, true, false]);
    yield* TestClock.adjust(TIMING.sessionGrowthMs - 45_000);
    yield* governor.pass(yield* roomy);
    assert.deepEqual(yield* started, [true, true, true, true]);
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
    assert.include(resume.text, "Continue where you stopped.");

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
