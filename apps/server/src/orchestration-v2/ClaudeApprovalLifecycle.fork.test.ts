import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProviderDriverKind } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import type { ClaudeAgentSdkQueryOpenInput } from "./Adapters/ClaudeAdapterV2.ts";
import {
  ClaudeOrchestratorReplayHarness,
  makeClaudeRestartReplayHarness,
} from "./Adapters/ClaudeAdapterV2.testkit.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { restartContinuationRun } from "./RestartContinuation.ts";
import * as DateTime from "effect/DateTime";
import { provideDeterministicTestRuntime } from "./testkit/DeterministicRuntime.ts";
import { layerProviderReplay } from "./testkit/ProviderReplayHarness.ts";
import { CLAUDE_MODEL_SELECTION, materializeFixtureInput } from "./testkit/fixtures/shared.ts";

it.effect.each(["steer", "abort", "question", "child", "restart"] as const)(
  "retires a Claude permission callback after %s without interrupting the live run",
  (action) =>
    Effect.gen(function* () {
      const name = `fork-approval-${action}`;
      const question = action === "question";
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "fork-approval-db-" });
      const database = SqlitePersistence.layerFromPath(path.join(baseDir, "statev2.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      );
      const recoveryLayer = ProviderRuntimeRecoveryService.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ProjectionStore.layer.pipe(Layer.provide(database)),
            EffectOutbox.layer.pipe(Layer.provide(database)),
            IdAllocator.layer,
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          ),
        ),
      );
      const workspace = yield* checkpointWorkspace(name);
      const nativeId = "00000000-0000-4000-8000-000000000001";
      const prompt = (text: string, priority?: "now") => ({
        type: "expect_outbound" as const,
        frame: {
          type: "prompt.offer",
          message: {
            type: "user",
            message: { role: "user", content: text },
            parent_tool_use_id: null,
            ...(priority === undefined ? {} : { priority }),
          },
        },
      });
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
        provider: "claudeAgent",
        protocol: "claude-agent-sdk.query",
        version: "1",
        scenario: name,
        metadata: { nativeSessionId: nativeId },
        entries: [
          {
            type: "expect_outbound",
            frame: {
              type: "query.open",
              options: {
                model: CLAUDE_MODEL_SELECTION.model,
                tools: { type: "preset", preset: "claude_code" },
                permissionMode: "default",
                settings: { showThinkingSummaries: true },
                sessionId: nativeId,
              },
            },
          },
          prompt("Work"),
          prompt("Use the safe alternative", "now"),
          {
            type: "emit_inbound",
            label: "finish",
            frame: {
              type: "user",
              parent_tool_use_id: null,
              session_id: nativeId,
              uuid: "00000000-0000-4000-8000-000000000003",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "permission-tool",
                    is_error: true,
                    content: "Tool denied; use the safe alternative.",
                  },
                ],
              },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "Safe alternative completed",
              session_id: nativeId,
              uuid: "00000000-0000-4000-8000-000000000002",
              duration_ms: 1,
              duration_api_ms: 1,
              num_turns: 1,
              total_cost_usd: 0,
              usage: { input_tokens: 1, output_tokens: 1 },
              modelUsage: {},
              permission_denials: [],
            },
          },
        ],
      });
      const materialized = yield* materializeFixtureInput({
        scenario: name,
        fixtureInput: {
          runtimeMode: "approval-required",
          steps: [{ type: "message", text: "Work" }],
        },
        driver: ProviderDriverKind.make("claudeAgent"),
        modelSelection: CLAUDE_MODEL_SELECTION,
      }).pipe(Effect.provide(IdAllocator.layer));
      const gate = makeProviderReplayGate(["finish"]);
      let opened: ClaudeAgentSdkQueryOpenInput | undefined;
      const replay = makeClaudeRestartReplayHarness(transcript, {
        replayGate: gate,
        onOpen: (input) => {
          opened = input;
        },
      });
      yield* Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.releaseAll()));
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const effects = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = materialized.projectionThreadIds[0]!;
        for (const command of materialized.commands)
          yield* orchestrator.dispatch(
            command.type === "thread.create" ? { ...command, worktreePath: workspace } : command,
          );
        yield* effects.drain();
        const initial = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(initial.runs[0]!.status, "running");
        const controller = yield* Effect.sync(() => new AbortController());
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
        const permission = yield* Effect.promise(() =>
          opened!.options.canUseTool!(
            question ? "AskUserQuestion" : "Bash",
            question
              ? {
                  questions: [
                    {
                      question: "Which safe alternative?",
                      header: "Choice",
                      options: [{ label: "Safe", description: "Use a safe command" }],
                    },
                  ],
                }
              : { command: "echo scratch-only" },
            {
              signal: controller.signal,
              toolUseID: "permission-tool",
              requestId: "permission-request",
              ...(action === "child" ? { agentID: "parallel-worker" } : {}),
            },
          ),
        ).pipe(Effect.forkScoped);
        const pending = Option.getOrThrow(
          yield* sink.stream({ threadId, afterSequence: 0 }).pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "runtime-request.updated" && event.payload.status === "pending",
            ),
            Stream.runHead,
          ),
        );
        assert.equal(pending.event.type, "runtime-request.updated");
        if (pending.event.type !== "runtime-request.updated") return;
        const requestId = pending.event.payload.id;
        const blocked = yield* orchestrator.getThreadProjection(threadId);
        assert.isUndefined(restartContinuationRun(blocked, yield* DateTime.now));
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* recovery.prepareForShutdown;
        assert.isTrue(
          Option.isNone(yield* outbox.get(`effect:restart-continuation:${initial.runs[0]!.id}`)),
        );
        const cardCancelled = sink.stream({ threadId, afterSequence: pending.sequence }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "turn-item.updated" &&
              (event.payload.type === "approval_request" ||
                event.payload.type === "user_input_request") &&
              event.payload.requestId === requestId &&
              event.payload.status === "cancelled",
          ),
          Stream.runHead,
        );
        // Upstream cancels a request Claude withdraws; the steer then has nothing to retire.
        if (action === "abort") {
          controller.abort();
          yield* cardCancelled;
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("fork-steer"),
          threadId,
          messageId: MessageId.make("fork-steer-message"),
          text: "Use the safe alternative",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          modelSelection: CLAUDE_MODEL_SELECTION,
          dispatchMode: { type: "steer_active", targetRunId: initial.runs[0]!.id },
        });
        yield* effects.drain();
        if (action === "child") {
          const held = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(held.runtimeRequests.find((r) => r.id === requestId)?.status, "pending");
          assert.isUndefined(restartContinuationRun(held, yield* DateTime.now));
          yield* orchestrator.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("fork-child-decline"),
            threadId,
            requestId,
            decision: "decline",
          });
          yield* effects.drain();
        }
        yield* cardCancelled;
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          after.runtimeRequests.find((r) => r.id === requestId)?.status,
          action === "abort" ? "cancelled" : "resolved",
        );
        assert.isFalse(
          after.turnItems.some(
            (item) => item.type === "approval_request" && item.status === "waiting",
          ),
        );
        const response = yield* Fiber.join(permission);
        assert.equal(response?.behavior, "deny");
        if (response?.behavior === "deny") assert.notEqual(response.interrupt, true);
        const stale = yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("fork-stale-cancel"),
            threadId,
            requestId,
            decision: "cancel",
          })
          .pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        yield* effects.drain();
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.status,
          "running",
        );
        assert.equal(restartContinuationRun(after, yield* DateTime.now)?.id, initial.runs[0]!.id);
        if (action === "restart") {
          yield* recovery.prepareForShutdown;
          yield* recovery.reconcile("shutdown");
          const continuation = Option.getOrThrow(
            yield* outbox.get(`effect:restart-continuation:${initial.runs[0]!.id}`),
          );
          assert.equal(continuation.status, "pending");
          assert.equal(continuation.request.type, "provider-runtime.continue");
          return;
        }
        gate.release("finish");
        yield* sink.stream({ threadId, afterSequence: 0 }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "run.updated" &&
              (event.payload.status === "waiting" || event.payload.status === "completed"),
          ),
          Stream.runHead,
        );
        yield* effects.drain();
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.status,
          "completed",
        );
        yield* replay.assertComplete;
      }).pipe(
        Effect.provide(
          recoveryLayer.pipe(
            Layer.provideMerge(
              layerProviderReplay({ name, transcript, ...materialized }, replay.harness, {
                runEffectWorker: false,
                databaseLayer: database,
                continueThreadsAfterServerUpdate: true,
              }),
            ),
          ),
        ),
        Effect.scoped,
      );
      if (action === "restart") {
        const startup = layerProviderReplay(
          { name: `${name}-startup`, transcript: { ...transcript, entries: [] }, ...materialized },
          ClaudeOrchestratorReplayHarness,
          {
            databaseLayer: database,
            runEffectWorker: false,
            continueThreadsAfterServerUpdate: true,
          },
        );
        yield* Effect.gen(function* () {
          const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* recovery.reconcile("startup");
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(1);
          const after = yield* orchestrator.getThreadProjection(
            materialized.projectionThreadIds[0]!,
          );
          assert.lengthOf(after.runs, 2);
          assert.equal(after.runs[1]!.restartContinuationOfRunId, after.runs[0]!.id);
          assert.equal(after.runs[1]!.status, "starting");
        }).pipe(Effect.provide(recoveryLayer.pipe(Layer.provideMerge(startup))), Effect.scoped);
      }
    }).pipe(provideDeterministicTestRuntime, Effect.provide(NodeServices.layer), Effect.scoped),
);
