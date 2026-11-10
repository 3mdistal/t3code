import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProviderDriverKind } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { CodexOrchestratorReplayHarness } from "./Adapters/CodexAdapterV2.testkit.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { layerProviderReplay } from "./testkit/ProviderReplayHarness.ts";
import {
  CODEX_MODEL_SELECTION,
  materializeFixtureInput,
  TOOL_CALL_WRITE_PROMPT,
  WORKSPACE_NEVER_POLICY,
} from "./testkit/fixtures/shared.ts";

// A run marks its session busy only once its turn starts. On Nov 9 the memory sweep closed a session
// while its /compact ran, and another while Alice's message was reopening it; see FORK.md.
it.effect("the memory sweep keeps an idle session while its thread has a run starting", () =>
  Effect.gen(function* () {
    const name = "fork-limits-sweep-keeps-runs";
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
    // The provider stays up after its turn, so its session is live and idle.
    const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript({
      ...recorded,
      scenario: name,
      entries: recorded.entries.filter((entry) => entry.type !== "runtime_exit"),
    });
    const materialized = yield* materializeFixtureInput({
      scenario: name,
      fixtureInput: { steps: [{ type: "message", text: TOOL_CALL_WRITE_PROMPT }] },
      driver: ProviderDriverKind.make("codex"),
      modelSelection: CODEX_MODEL_SELECTION,
    }).pipe(Effect.provide(IdAllocator.layer));
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const effectDaemon = yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
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
      // With no worker, the next run stays where a slow open or resume would hold it.
      yield* Fiber.interrupt(effectDaemon);
      const providerSessionId = (yield* orchestrator.getThreadProjection(threadId))
        .providerThreads[0]!.providerSessionId!;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("fork-limits-sweep-second"),
        threadId,
        messageId: MessageId.make("fork-limits-sweep-second"),
        text: "Again",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const second = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      assert.equal(second.status, "starting");

      assert.deepEqual(yield* sessions.releaseIdleSessions!({ keepThreadIds: new Set() }), []);
      assert.isTrue(yield* sessions.isLive(providerSessionId));

      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("fork-limits-sweep-end"),
        threadId,
        runId: second.id,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!.status,
        "interrupted",
      );
      assert.deepEqual(yield* sessions.releaseIdleSessions!({ keepThreadIds: new Set() }), [
        providerSessionId,
      ]);
    }).pipe(
      Effect.provide(
        layerProviderReplay(
          { name, transcript, ...materialized, runtimePolicyOverride: WORKSPACE_NEVER_POLICY },
          CodexOrchestratorReplayHarness,
          { runEffectWorker: false },
        ),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
