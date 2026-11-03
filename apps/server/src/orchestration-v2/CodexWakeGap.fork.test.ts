import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { CodexOrchestratorReplayHarness } from "./Adapters/CodexAdapterV2.testkit.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { layerProviderReplay } from "./testkit/ProviderReplayHarness.ts";
import {
  CODEX_MODEL_SELECTION,
  materializeFixtureInput,
  TOOL_CALL_WRITE_PROMPT,
  WORKSPACE_NEVER_POLICY,
} from "./testkit/fixtures/shared.ts";

const decodeStartedTurn = Schema.decodeUnknownEffect(
  Schema.Struct({
    params: Schema.Struct({
      threadId: Schema.String,
      turn: Schema.Struct({ id: Schema.String }),
    }),
  }),
);

// Known failure: see FORK.md's "Codex background continuations" known gap.
it.effect.fails(
  "delivers a completed Codex command's wake and starts a run despite memory cleanup",
  () =>
    Effect.gen(function* () {
      const name = "fork-codex-wake-gap";
      const workspace = yield* checkpointWorkspace(name);
      const recorded = materializeReplayTranscriptWorkspace(
        yield* readProviderReplayTranscript(
          new URL(
            "./testkit/fixtures/tool_call_workspace_never/codex_transcript.ndjson",
            import.meta.url,
          ),
        ),
        workspace,
      );
      const last = recorded.entries.findIndex(
        (entry) => entry.type !== "runtime_exit" && entry.label === "turn/started",
      );
      const entry = recorded.entries[last]!;
      assert.equal(entry.type, "emit_inbound");
      if (entry.type !== "emit_inbound") return;
      const { params } = yield* decodeStartedTurn(entry.frame);
      const command = (status: "inProgress" | "completed") => ({
        type: "commandExecution",
        id: "fork-bg-command",
        command: "echo done",
        cwd: workspace,
        processId: "4242",
        source: "unifiedExecStartup",
        status,
        commandActions: [{ type: "unknown", command: "echo done" }],
        aggregatedOutput: status === "completed" ? "done\n" : null,
        exitCode: status === "completed" ? 0 : null,
        durationMs: status === "completed" ? 1 : null,
      });
      const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript({
        ...recorded,
        scenario: name,
        entries: [
          ...recorded.entries.slice(0, last + 1),
          {
            type: "emit_inbound",
            frame: {
              method: "item/started",
              params: {
                threadId: params.threadId,
                turnId: params.turn.id,
                item: command("inProgress"),
                startedAtMs: 1,
              },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              method: "turn/completed",
              params: {
                threadId: params.threadId,
                turn: {
                  id: params.turn.id,
                  items: [],
                  itemsView: "notLoaded",
                  status: "completed",
                  error: null,
                  startedAt: 1,
                  completedAt: 2,
                  durationMs: 1,
                },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "command-completed",
            frame: {
              method: "item/completed",
              params: {
                threadId: params.threadId,
                turnId: params.turn.id,
                item: command("completed"),
                completedAtMs: 2,
              },
            },
          },
        ],
      });
      const materialized = yield* materializeFixtureInput({
        scenario: name,
        fixtureInput: { steps: [{ type: "message", text: TOOL_CALL_WRITE_PROMPT }] },
        driver: ProviderDriverKind.make("codex"),
        modelSelection: CODEX_MODEL_SELECTION,
      }).pipe(Effect.provide(IdAllocator.layer));
      const offered = yield* Deferred.make<void>();
      const allowOffer = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const requests =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const continuationQueue = {
        take: Queue.take(requests),
        offer: (request: ProviderContinuationRequests.ProviderContinuationRequest) =>
          Deferred.succeed(offered, undefined).pipe(
            Effect.andThen(Deferred.await(allowOffer)),
            Effect.andThen(Queue.offer(requests, request)),
            Effect.andThen(Deferred.succeed(delivered, undefined)),
            Effect.asVoid,
            Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
          ),
      };
      const gate = makeProviderReplayGate(["command-completed"]);
      yield* Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(allowOffer, undefined).pipe(
            Effect.andThen(Effect.sync(() => gate.releaseAll())),
          ),
        );
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const effectDaemon = yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
        yield* Layer.build(
          ProviderContinuationService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                IdAllocator.layer,
                Layer.succeed(
                  ProviderContinuationRequests.ProviderContinuationRequests,
                  continuationQueue,
                ),
                Layer.mock(ThreadManagementService.ThreadManagementService)({
                  dispatch: orchestrator.dispatch,
                  getThreadRecords: orchestrator.getThreadRecords,
                }),
              ),
            ),
          ),
        );
        const threadId = materialized.projectionThreadIds[0]!;
        for (const command of materialized.commands)
          yield* orchestrator.dispatch(
            command.type === "thread.create" ? { ...command, worktreePath: workspace } : command,
          );
        yield* sink.stream({ threadId }).pipe(
          Stream.filter(
            ({ event }) => event.type === "run.updated" && event.payload.status === "completed",
          ),
          Stream.runHead,
        );
        yield* Fiber.interrupt(effectDaemon);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const providerThread = projection.providerThreads[0]!;
        const runtime = Option.getOrThrow(yield* sessions.get(providerThread.providerSessionId!));
        assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
        const completed = yield* sink.stream({ threadId }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "turn-item.updated" &&
              event.payload.nativeItemRef?.nativeId === "fork-bg-command" &&
              event.payload.status === "completed",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        gate.release("command-completed");
        yield* Deferred.await(offered);
        yield* Fiber.join(completed);
        yield* sessions.releaseIdleSessions!({ keepThreadIds: new Set() });
        const nextRun = yield* sink.stream({ threadId }).pipe(
          Stream.filter(
            ({ event }) =>
              (event.type === "run.created" || event.type === "run.updated") &&
              event.payload.ordinal === 2 &&
              event.payload.status === "starting",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Deferred.succeed(allowOffer, undefined);
        yield* Effect.raceFirst(Deferred.await(delivered), Deferred.await(cancelled));
        assert.isTrue(
          yield* Deferred.isDone(delivered),
          "the completed command's continuation must reach the queue",
        );
        assert.isTrue(
          Option.isSome(yield* Fiber.join(nextRun)),
          "the delivered continuation must start a new run",
        );
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }).pipe(
        Effect.provide(
          layerProviderReplay(
            { name, transcript, ...materialized, runtimePolicyOverride: WORKSPACE_NEVER_POLICY },
            CodexOrchestratorReplayHarness,
            { replayGate: gate, runEffectWorker: false },
          ),
        ),
        Effect.provideService(
          ProviderContinuationRequests.ProviderContinuationRequests,
          continuationQueue,
        ),
        Effect.scoped,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
