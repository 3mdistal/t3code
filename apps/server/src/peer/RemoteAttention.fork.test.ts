import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  ProjectId,
  ProviderDriverKind,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  attentionTestLayer,
  modelSelection,
} from "../orchestration-v2/testkit/DelegatedAttention.fork.testkit.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";

const decodeWaitInput = Schema.decodeEffect(OrchestratorMcpThreadWaitInput);
const decodeWaitResult = Schema.decodeEffect(OrchestratorMcpThreadWaitResult);

it.effect.each(["approval", "question", "wake_cancelled"] as const)(
  "relays remote %s without treating attention as the final result",
  (kind) =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const parentId = ThreadId.make("fixture-remote-parent");
      const childId = ThreadId.make("fixture-remote-child");
      const remoteId = EnvironmentId.make("fixture-other-environment");
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-remote-parent"),
        threadId: parentId,
        projectId: ProjectId.make("fixture-project"),
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-remote-parent"),
        threadId: parentId,
        messageId: MessageId.make("remote-parent-work"),
        text: "Work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const run = (yield* engine.getThreadProjection(parentId)).runs[0]!;
      yield* engine.dispatch({
        type: "delegated_task.remote.request",
        commandId: CommandId.make("record-remote-task"),
        parentThreadId: parentId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Work elsewhere",
        modelSelection,
        driver: ProviderDriverKind.make("codex"),
        completionWake: "always",
        remoteChild: {
          environmentId: remoteId,
          threadId: childId,
          runId: RunId.make("fixture-remote-run"),
          label: "Other environment",
        },
      });
      const waits = yield* Queue.unbounded<OrchestratorMcpThreadWaitInput | null>();
      const count = yield* Ref.make(0);
      const bridge = Layer.mock(PeerForwarding.PeerForwarding)({
        readThread: () => Queue.offer(waits, null).pipe(Effect.andThen(Effect.never)),
        waitForThread: (_scope, _environmentId, input) =>
          Effect.gen(function* () {
            yield* Queue.offer(waits, yield* decodeWaitInput(input).pipe(Effect.orDie));
            if ((yield* Ref.updateAndGet(count, (n) => n + 1)) > 2) return yield* Effect.never;
            return yield* decodeWaitResult({
              threadId: childId,
              runId: RunId.make("fixture-remote-run"),
              // A finished run can still owe a background wake and have no final result.
              status: kind === "wake_cancelled" ? "completed" : "running",
              timedOut: false,
              attention: [
                { id: "fixture-request", kind, summary: "Background wake was cancelled." },
              ],
            }).pipe(Effect.orDie);
          }),
      });
      const context = yield* Layer.build(
        RemoteDelegation.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              bridge,
              Layer.mock(PeerLinks.PeerLinks)({}),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture-here")),
              }),
              NodeCrypto.layer,
            ),
          ),
        ),
      );
      yield* Context.get(context, RemoteDelegation.RemoteDelegation).start();
      yield* Queue.take(waits);
      assert.isNotNull(yield* Queue.take(waits));
      const next = yield* Queue.take(waits);
      assert.isNotNull(next);
      const after = yield* engine.getThreadProjection(parentId);
      const messages = after.messages.filter(
        (message) => message.notification?.source.kind === "delegated_task",
      );
      assert.lengthOf(messages, 1);
      assert.deepEqual(next!.seenAttentionIds, ["fixture-request"]);
      assert.include(messages[0]!.text, remoteId);
      if (kind === "approval") assert.notInclude(messages[0]!.text, "action respond");
      assert.equal(after.subagents[0]!.result, null);
      assert.equal(after.runs[0]!.status, "starting");
    }).pipe(Effect.provide(attentionTestLayer), Effect.scoped),
);
