import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const projectId = ProjectId.make("project:lost-claude-session");

interface Observed {
  /** Native ids whose transcript is gone. */
  readonly lost: ReadonlySet<string>;
  /** Fails the next start before any provider turn exists, as a process that can't launch does. */
  readonly refuseNextStart: boolean;
  readonly checks: ReadonlyArray<{ readonly nativeId: string; readonly hasTurns: boolean }>;
  readonly turns: ReadonlyArray<{
    readonly nativeId: string;
    readonly hasTurns: boolean | undefined;
    readonly text: string;
  }>;
  readonly injected: ReadonlyArray<string>;
  readonly minted: number;
}

const makeAdapter = (
  observed: Ref.Ref<Observed>,
): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId: CLAUDE_MODEL_SELECTION.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (sessionInput) =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const now = yield* DateTime.now;
      const providerSession: OrchestrationV2ProviderSession = {
        id: sessionInput.providerSessionId,
        driver,
        providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
        status: "ready",
        cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
        model: CLAUDE_MODEL_SELECTION.model,
        capabilities: ClaudeProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      return {
        instanceId: CLAUDE_MODEL_SELECTION.instanceId,
        driver,
        providerSessionId: sessionInput.providerSessionId,
        providerSession,
        events: Stream.fromPubSub(events),
        ensureThread: (threadInput) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now;
            const minted = yield* Ref.modify(observed, (current) => [
              current.minted,
              { ...current, minted: current.minted + 1 },
            ]);
            return {
              id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
              driver,
              providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: `native:${minted}`, strength: "strong" },
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
        assertNativeThreadResumable: ({ providerThread, nativeThreadHasTurns }) =>
          Effect.gen(function* () {
            const nativeId = providerThread.nativeThreadRef?.nativeId ?? "";
            const { lost } = yield* Ref.updateAndGet(observed, (current) => ({
              ...current,
              checks: [...current.checks, { nativeId, hasTurns: nativeThreadHasTurns }],
            }));
            // As the adapter does: a session with no turns is created by the next query.
            if (nativeThreadHasTurns && lost.has(nativeId)) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver,
                detail: "No transcript to resume.",
              });
            }
          }),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        injectHistory: (history) =>
          Ref.update(observed, (current) => ({
            ...current,
            injected: [...current.injected, ...history.messages.map((message) => message.text)],
          })).pipe(Effect.as(true)),
        compactThread: () => Effect.die("unused compactThread"),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            const { refuseNextStart } = yield* Ref.getAndUpdate(observed, (current) => ({
              ...current,
              refuseNextStart: false,
            }));
            if (refuseNextStart) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver,
                detail: "The process didn't launch.",
              });
            }
            yield* Ref.update(observed, (current) => ({
              ...current,
              turns: [
                ...current.turns,
                {
                  nativeId: turnInput.providerThread.nativeThreadRef?.nativeId ?? "",
                  hasTurns: turnInput.nativeThreadHasTurns,
                  text: turnInput.message.text,
                },
              ],
            }));
            const at = yield* DateTime.now;
            const providerTurnId = ProviderTurnId.make(`provider-turn:${turnInput.attemptId}`);
            yield* PubSub.publish(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: turnInput.providerThread.id,
                nodeId: turnInput.rootNodeId,
                runAttemptId: turnInput.attemptId,
                nativeTurnRef: { driver, nativeId: `turn:${providerTurnId}`, strength: "strong" },
                ordinal: turnInput.providerTurnOrdinal,
                status: "completed",
                startedAt: at,
                completedAt: at,
              },
            });
            yield* PubSub.publish(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turnInput.providerThread.id,
              providerTurnId,
              runOrdinal: turnInput.runOrdinal,
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
      } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
    }),
});

const runThread = <A, E, R>(
  name: string,
  test: (input: {
    readonly observed: Ref.Ref<Observed>;
    readonly threadId: ThreadId;
    readonly run: (ordinal: number) => Effect.Effect<void>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(name);
      const threadId = ThreadId.make(`thread:${name}`);
      const observed = yield* Ref.make<Observed>({
        lost: new Set(),
        refuseNextStart: false,
        checks: [],
        turns: [],
        injected: [],
        minted: 0,
      });
      return yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${name}:create`),
          threadId,
          projectId,
          createdBy: "user",
          creationSource: "web",
          title: name,
          modelSelection: CLAUDE_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const run = Effect.fn("run")(function* (ordinal: number) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${name}:${ordinal}`),
            threadId,
            messageId: MessageId.make(`${name}:${ordinal}`),
            createdBy: "user",
            creationSource: "web",
            text: `Request ${ordinal}`,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.payload.ordinal === ordinal &&
                (event.payload.status === "completed" || event.payload.status === "failed"),
            ),
            Stream.runHead,
          );
          yield* worker.drain();
        }, Effect.orDie);
        return yield* test({ observed, threadId, run });
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            {
              name,
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: { type: "readOnly" },
              },
            },
            ProviderAdapterRegistry.layerFromAdapters([makeAdapter(observed)]),
          ),
        ),
      );
    }),
  );

describe("a Claude session that was never saved", () => {
  it.live("moves to a fresh session with the whole thread, without failing the run", () =>
    runThread("lost-claude-session", ({ observed, threadId, run }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* run(1);
        const first = yield* Ref.get(observed);
        // A new thread creates its session, so there's nothing to check yet.
        assert.lengthOf(first.checks, 0);

        // Still loaded in the session manager, which skips resumeThread for it.
        yield* Ref.update(observed, (current) => ({ ...current, lost: new Set(["native:0"]) }));
        yield* run(2);
        yield* run(3);

        const { checks, turns, injected } = yield* Ref.get(observed);
        assert.deepEqual(checks, [
          { nativeId: "native:0", hasTurns: true },
          { nativeId: "native:1", hasTurns: true },
        ]);
        assert.deepEqual(
          turns.map(({ nativeId, hasTurns, text }) => [nativeId, hasTurns, text]),
          [
            ["native:0", false, "Request 1"],
            ["native:1", false, "Request 2"],
            ["native:1", true, "Request 3"],
          ],
        );
        assert.isTrue(injected.some((text) => text.includes("Request 1")));

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          projection.runs.map((candidate) => candidate.status),
          ["completed", "completed", "completed"],
        );
        const handoff = projection.contextHandoffs.find(
          (candidate) => candidate.targetRunId === projection.runs[1]?.id,
        );
        assert.equal(handoff?.strategy, "full_thread_summary");
      }),
    ),
  );

  it.live("leaves a retry alone when no turn ever reached the provider", () =>
    runThread("lost-claude-session-first-start", ({ observed, threadId, run }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* Ref.update(observed, (current) => ({ ...current, refuseNextStart: true }));
        yield* run(1);
        yield* Ref.update(observed, (current) => ({ ...current, lost: new Set(["native:0"]) }));
        yield* run(2);

        const { checks, turns, minted } = yield* Ref.get(observed);
        assert.deepEqual(
          checks.map(({ hasTurns }) => hasTurns),
          [false],
        );
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "failed");
        assert.deepEqual(turns, [{ nativeId: "native:0", hasTurns: false, text: "Request 2" }]);
        assert.equal(minted, 1);
        assert.isFalse(
          projection.contextHandoffs.some(
            (candidate) => candidate.strategy === "full_thread_summary",
          ),
        );
      }),
    ),
  );
});
