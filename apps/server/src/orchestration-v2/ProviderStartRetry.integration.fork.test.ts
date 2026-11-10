import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2StoredEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import {
  ClaudeAgentSdkQueryRunnerError,
  ClaudeProviderCapabilitiesV2,
} from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { ProviderPoolCatalog } from "./ProviderPoolCatalog.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const projectId = ProjectId.make("project:start-retry");
const CLAUDE: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "opus",
};
const CODEX: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt" };

interface Script {
  /** How many Claude starts fail before Claude reports the turn, so before any prompt is sent. */
  readonly failStarts: number;
  /** What those starts fail with. */
  readonly refusal: unknown;
  /** How many history injections fail after writing, as if the acknowledgement was lost. */
  readonly failInjections: number;
  readonly started: ReadonlyArray<{
    readonly driver: string;
    readonly prompt: string;
    readonly nativeThreadId: string | null;
    readonly failed: boolean;
  }>;
  readonly injected: ReadonlyArray<unknown>;
  readonly nativeThreads: number;
}

function makeAdapter(
  driverName: "claudeAgent" | "codex",
  capabilities: OrchestrationV2ProviderCapabilities,
  script: Ref.Ref<Script>,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driverName);
  const claude = driverName === "claudeAgent";
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
          model: sessionInput.modelSelection.model,
          capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              // Each native thread gets its own id, so a test can tell a reused one from a new one.
              const { nativeThreads } = yield* Ref.getAndUpdate(script, (current) => ({
                ...current,
                nativeThreads: current.nativeThreads + 1,
              }));
              const nativeId = `${driverName}:${threadInput.threadId}:${nativeThreads}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          ...(claude
            ? {
                injectHistory: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                  Effect.gen(function* () {
                    const { failInjections } = yield* Ref.getAndUpdate(script, (current) => ({
                      ...current,
                      failInjections: Math.max(0, current.failInjections - 1),
                      injected: [
                        ...current.injected,
                        ...historyResponseItems(history.messages, history.context),
                      ],
                    }));
                    if (failInjections > 0) {
                      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                        driver,
                        detail: "lost injection acknowledgement",
                      });
                    }
                    return true;
                  }),
              }
            : {}),
          startTurn: (input) =>
            Effect.gen(function* () {
              const { failStarts, refusal } = yield* Ref.getAndUpdate(script, (current) => ({
                ...current,
                failStarts: claude ? Math.max(0, current.failStarts - 1) : current.failStarts,
                started: [
                  ...current.started,
                  {
                    driver: driverName,
                    prompt: input.message.text,
                    nativeThreadId: input.providerThread.nativeThreadRef?.nativeId ?? null,
                    failed: claude && current.failStarts > 0,
                  },
                ],
              }));
              if (claude && failStarts > 0) {
                return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver,
                  threadId: input.threadId,
                  providerThreadId: input.providerThread.id,
                  runId: input.runId,
                  cause: refusal,
                });
              }
              const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
              const startedAt = yield* DateTime.now;
              const providerTurn = (
                status: "running" | "completed",
                completedAt: typeof startedAt | null,
              ) => ({
                id: providerTurnId,
                providerThreadId: input.providerThread.id,
                nodeId: input.rootNodeId,
                runAttemptId: input.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native:${providerTurnId}`,
                  strength: "strong" as const,
                },
                ordinal: input.providerTurnOrdinal,
                status,
                startedAt,
                completedAt,
              });
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: providerTurn("running", null),
              });
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: providerTurn("completed", yield* DateTime.now),
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: input.providerThread.id,
                providerTurnId,
                runOrdinal: input.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

const makeInstance = (
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  displayName: string,
): ProviderInstance => ({
  instanceId: adapter.instanceId,
  driverKind: adapter.driver,
  continuationIdentity: { driverKind: adapter.driver, continuationKey: `${adapter.driver}:home` },
  displayName,
  enabled: true,
  snapshot: {} as ProviderInstance["snapshot"],
  orchestrationAdapter: adapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
});

const makeRegistry = (script: Ref.Ref<Script>) => {
  const instances = [
    makeInstance(makeAdapter("claudeAgent", ClaudeProviderCapabilitiesV2, script), "Claude"),
    makeInstance(makeAdapter("codex", CodexProviderCapabilitiesV2, script), "Codex"),
  ];
  return ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (id) =>
          Effect.succeed(instances.find((instance) => instance.instanceId === id)),
        listInstances: Effect.succeed(instances),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
  );
};

const publishedProvider = (selection: ModelSelection, displayName: string): ServerProvider => ({
  instanceId: selection.instanceId,
  driver: ProviderDriverKind.make(selection.instanceId),
  displayName,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-10T00:00:00.000Z",
  continuation: { groupKey: `${selection.instanceId}:home` },
  models: [{ slug: selection.model, name: selection.model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const catalog = Layer.succeed(ProviderPoolCatalog, {
  getPublishedProviders: Effect.succeed([
    publishedProvider(CLAUDE, "Claude"),
    publishedProvider(CODEX, "Codex"),
  ]),
  markLimited: () => Effect.void,
});

const awaitRunStatus = (threadId: ThreadId, status: "completed" | "failed") =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    return yield* eventSink
      .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
      .pipe(
        Stream.filter(
          (stored: OrchestrationV2StoredEvent) =>
            stored.event.type === "run.updated" && stored.event.payload.status === status,
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
  });

interface Message {
  readonly text: string;
  readonly selection: ModelSelection;
  readonly settles: "completed" | "failed";
  /** Fails this many Claude starts, from this message on. */
  readonly failStarts?: number;
}

/** Sends each message in turn on a fresh thread and waits for its run to settle. */
const runScript = (
  name: string,
  setup: Partial<Pick<Script, "failStarts" | "failInjections" | "refusal">>,
  messages: ReadonlyArray<Message>,
) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const threadId = ThreadId.make(`thread:${name}`);
    const script = yield* Ref.make<Script>({
      failStarts: 0,
      failInjections: 0,
      refusal: "Claude Code did not answer the MCP server registration.",
      ...setup,
      started: [],
      injected: [],
      nativeThreads: 0,
    });
    const projection = yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId,
        title: "Start retry",
        modelSelection: messages[0]!.selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
      });
      for (const [index, message] of messages.entries()) {
        const failStarts = message.failStarts;
        if (failStarts !== undefined) yield* Ref.update(script, (s) => ({ ...s, failStarts }));
        const settled = yield* awaitRunStatus(threadId, message.settles);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:${index}`),
          threadId,
          messageId: MessageId.make(`${threadId}:${index}:message`),
          text: message.text,
          attachments: [],
          modelSelection: message.selection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
      }
      return yield* orchestrator.getThreadProjection(threadId);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry({ name }, makeRegistry(script), {
          settings: {
            providerInstances: {
              [CLAUDE.instanceId]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                enabled: true,
              },
              [CODEX.instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
            },
          },
          poolCatalog: catalog,
          startRetry: true,
        }),
      ),
    );
    return { projection, script: yield* Ref.get(script) };
  });

it.live("retries once a Claude turn that failed before its prompt was sent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { projection, script } = yield* runScript(
        "start-retry-recovers",
        { failStarts: 1, failInjections: 0 },
        [{ text: "first", selection: CLAUDE, settles: "completed" }],
      );
      const [run] = projection.runs;
      assert.lengthOf(projection.runs, 1);
      assert.equal(run?.status, "completed");
      assert.deepEqual(
        projection.attempts.map((attempt) => [attempt.status, attempt.reason]),
        [
          ["failed", "initial"],
          ["completed", "retry"],
        ],
      );
      assert.lengthOf(script.started, 2);
      assert.isTrue(script.started.every((turn) => turn.prompt.includes("first")));
      assert.lengthOf(
        projection.messages.filter((message) => message.runId === run?.id),
        1,
      );
      const notices = projection.turnItems.filter((item) => item.type === "system_notice");
      assert.deepEqual(
        notices.map((item) => (item.type === "system_notice" ? item.message : null)),
        ["Claude could not start this turn. Trying once more."],
      );
      assert.isFalse(projection.turnItems.some((item) => item.type === "error"));
    }),
  ),
);

it.live("fails the run when the one retry fails too", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { projection, script } = yield* runScript(
        "start-retry-exhausted",
        { failStarts: 2, failInjections: 0 },
        [{ text: "first", selection: CLAUDE, settles: "failed" }],
      );
      const [run] = projection.runs;
      assert.equal(run?.status, "failed");
      assert.deepEqual(
        projection.attempts.map((attempt) => [attempt.status, attempt.reason]),
        [
          ["failed", "initial"],
          ["failed", "retry"],
        ],
      );
      assert.lengthOf(script.started, 2);
      const errors = projection.turnItems.filter((item) => item.type === "error");
      assert.lengthOf(errors, 1);
      assert.equal(errors[0]?.nodeId, projection.attempts[1]?.rootNodeId);
    }),
  ),
);

// A switch to Claude injects the earlier Codex history before the start. Upstream
// records whether that injection landed, and the retry must respect it.
it.live.each([
  [
    "start",
    "the same native thread, without injecting again",
    { failStarts: 1, failInjections: 0 },
  ],
  ["injection", "a new native thread with the history", { failStarts: 0, failInjections: 1 }],
] as const)("retries a handoff after a failed %s, in %s", ([failure, , setup]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { projection, script } = yield* runScript(`start-retry-handoff-${failure}`, setup, [
        { text: "Original request", selection: CODEX, settles: "completed" },
        { text: "Switched request", selection: CLAUDE, settles: "completed" },
      ]);
      const switched = projection.runs.at(-1)!;
      assert.equal(switched.status, "completed");
      assert.deepEqual(
        projection.attempts
          .filter((attempt) => attempt.runId === switched.id)
          .map((attempt) => [attempt.status, attempt.reason]),
        [
          ["failed", "initial"],
          ["completed", "retry"],
        ],
      );
      const claudeStarts = script.started.filter((turn) => turn.driver === "claudeAgent");
      const sent = claudeStarts.at(-1)!;
      assert.equal(sent.prompt, "Switched request");
      const history = yield* encodeJson(script.injected);
      const injections = history.split("Original request").length - 1;
      if (failure === "start") {
        assert.lengthOf(claudeStarts, 2);
        assert.equal(claudeStarts[0]!.nativeThreadId, sent.nativeThreadId);
        assert.equal(injections, 1);
      } else {
        // The first injection may have landed, so the retry starts over in a new native thread.
        assert.lengthOf(claudeStarts, 1);
        assert.equal(injections, 2);
        const retried = projection.attempts.find(
          (attempt) => attempt.id === switched.activeAttemptId,
        )!;
        assert.equal(retried.nativeThreadId, sent.nativeThreadId);
        assert.notEqual(
          projection.attempts.find(
            (attempt) => attempt.runId === switched.id && attempt.reason === "initial",
          )?.nativeThreadId,
          sent.nativeThreadId,
        );
      }
    }),
  ),
);

// Same tag as the adapter's unexported error raised when Claude never answers setMcpServers.
class ClaudeMcpRegistrationTimeoutError extends Schema.TaggedError<ClaudeMcpRegistrationTimeoutError>()(
  "ClaudeMcpRegistrationTimeoutError",
  {},
) {}

// Upstream keeps the native session after a start Claude refused before reading the
// prompt, and hands the missed request to the next turn. That holds when the retry is
// refused too.
it.live("keeps the native session and the missed request when the retry is refused too", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { projection, script } = yield* runScript(
        "start-retry-refused",
        {
          refusal: new ClaudeAgentSdkQueryRunnerError({
            method: "setMcpServers",
            cause: new ClaudeMcpRegistrationTimeoutError(),
          }),
        },
        [
          { text: "Request 1", selection: CLAUDE, settles: "completed" },
          { text: "Request 2", selection: CLAUDE, settles: "failed", failStarts: 2 },
          { text: "Request 3", selection: CLAUDE, settles: "completed" },
        ],
      );
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "failed", "completed"],
      );
      assert.deepEqual(
        projection.attempts
          .filter((attempt) => attempt.runId === projection.runs[1]?.id)
          .map((attempt) => [attempt.status, attempt.reason]),
        [
          ["failed", "initial"],
          ["failed", "retry"],
        ],
      );
      const sent = script.started.filter((turn) => !turn.failed);
      assert.lengthOf(sent, 2);
      assert.equal(sent[1]!.prompt, "Request 3");
      // This fake Claude takes history, so the missed request arrives that way, once.
      const missed = projection.contextHandoffs.filter(
        (handoff) => handoff.targetRunId === projection.runs[2]?.id,
      );
      assert.deepEqual(
        missed.map((handoff) => [handoff.strategy, handoff.delivery?.status]),
        [["delta_since_target_last_seen", "injected"]],
      );
      const history = yield* encodeJson(script.injected);
      assert.equal(history.split("Request 2").length - 1, 1);
      assert.equal(script.nativeThreads, 1);
      assert.isTrue(
        script.started.every((turn) => turn.nativeThreadId === sent[0]!.nativeThreadId),
      );
    }),
  ),
);
