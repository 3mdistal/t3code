import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestratorMcpDelegateTaskInput,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
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

// `delegate_task` to a linked environment with isolation "worktree" forwards a
// worktree strategy that starts from `baseRef` on that project's origin.

const parentId = ThreadId.make("fixture-worktree-parent");
const remoteId = EnvironmentId.make("fixture-cloud");
const remoteProject = ProjectId.make("fixture-cloud-project");
const scope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("fixture-here"),
  requestNamespace: "provider-session:fixture-worktree",
  thread: {
    threadId: parentId,
    providerSessionId: "provider-session:fixture-worktree",
    providerInstanceId: modelSelection.instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

type DelegateInput = Omit<OrchestratorMcpDelegateTaskInput, "task" | "target">;

const harness = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-worktree-parent"),
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
    commandId: CommandId.make("start-worktree-parent"),
    threadId: parentId,
    messageId: MessageId.make("worktree-parent-work"),
    text: "Work",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const launches = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]);
  const call = ((_scope, _tool, _environmentId, params) => {
    const input = params as unknown as Record<string, unknown>;
    return Ref.update(launches, (all) => [...all, input]).pipe(
      // The other side replays a launch with the same key as the same thread.
      Effect.as({
        threadId: ThreadId.make(`fixture-remote:${String(input.clientRequestId)}`),
        projectId: remoteProject,
        modelSelection,
        runId: null,
        status: null,
      }),
    );
  }) as PeerForwarding.PeerForwarding["Service"]["call"];
  const context = yield* Layer.build(
    RemoteDelegation.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(PeerForwarding.PeerForwarding)({
            call,
            readThread: () => Effect.never,
            waitForThread: () => Effect.never,
          }),
          Layer.mock(PeerLinks.PeerLinks)({ get: () => Effect.succeedNone }),
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
  const delegation = Context.get(context, RemoteDelegation.RemoteDelegation);
  return {
    launches,
    tasks: engine.getThreadProjection(parentId).pipe(Effect.map(({ subagents }) => subagents)),
    delegate: (input: DelegateInput) =>
      delegation.delegate(scope, {
        task: "Run the suite on the cloud machine.",
        target: { environmentId: remoteId, projectId: remoteProject },
        ...input,
      }),
  };
});

it.effect("a worktree there starts from baseRef on that project's origin", () =>
  Effect.gen(function* () {
    const { delegate, launches } = yield* harness;
    yield* delegate({ isolation: "worktree", baseRef: "fork/pr-branch" });
    const [launch] = yield* Ref.get(launches);
    assert.deepEqual(launch?.workspaceStrategy, {
      type: "worktree",
      baseRef: "fork/pr-branch",
      startFromOrigin: true,
    });
    assert.equal(launch?.projectId, remoteProject);
  }).pipe(Effect.provide(attentionTestLayer), Effect.scoped),
);

it.effect("a shared task there still runs in that project's checkout", () =>
  Effect.gen(function* () {
    const { delegate, launches } = yield* harness;
    yield* delegate({});
    yield* delegate({ isolation: "shared", clientRequestId: "shared" });
    const all = yield* Ref.get(launches);
    assert.lengthOf(all, 2);
    for (const launch of all) assert.notProperty(launch, "workspaceStrategy");
  }).pipe(Effect.provide(attentionTestLayer), Effect.scoped),
);

it.effect.each([
  { name: "a worktree without baseRef", input: { isolation: "worktree" }, says: "Pass baseRef" },
  { name: "baseRef on a shared task", input: { baseRef: "main" }, says: "needs isolation" },
] as const)("refuses $name there before launching anything", ({ input, says }) =>
  Effect.gen(function* () {
    const { delegate, launches, tasks } = yield* harness;
    const error = yield* delegate(input).pipe(Effect.flip);
    assert.equal(error.code, "invalid_request");
    assert.include(error.message, says);
    assert.lengthOf(yield* Ref.get(launches), 0);
    assert.lengthOf(yield* tasks, 0);
  }).pipe(Effect.provide(attentionTestLayer), Effect.scoped),
);

it.effect("a retry with the same key launches the same worktree thread and records one task", () =>
  Effect.gen(function* () {
    const { delegate, launches, tasks } = yield* harness;
    const input = { isolation: "worktree", baseRef: "main", clientRequestId: "retry" } as const;
    const first = yield* delegate(input);
    const second = yield* delegate(input);
    assert.equal(second.taskId, first.taskId);
    const [launch, again] = yield* Ref.get(launches);
    // The other side replays a launch by its key, so the same key makes no second worktree.
    assert.deepEqual(again, launch);
    assert.lengthOf(yield* tasks, 1);
  }).pipe(Effect.provide(attentionTestLayer), Effect.scoped),
);
