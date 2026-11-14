// fork: limits. A parent reads a child T3 holds as held, and a working one as working; see FORK.md.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestratorMcpHeldRun,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { heldQueue, heldRun } from "./heldRuns.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const parentThreadId = ThreadId.make("thread:held-parent");
const childThreadId = ThreadId.make("thread:held-child");
const taskId = NodeId.make("node:held-task");
const firstRunId = RunId.make("run:held-child-1");
const wakeRunId = RunId.make("run:held-child-2");
const firstMessageId = MessageId.make("message:held-child-1");
const wakeMessageId = MessageId.make("message:held-child-2");
const requestedAt = DateTime.makeUnsafe("2026-11-09T19:21:42Z");
const limitsNotice =
  "Held at 2:21 PM behind other work waiting for teenylilpc's limits. Held work starts on its own, one thread at a time: board tasks by rank, then the rest oldest first. Choose Resume to start it now.";

const run = (input: Partial<OrchestrationV2Run> & Pick<OrchestrationV2Run, "id" | "ordinal">) =>
  ({
    status: "completed",
    userMessageId: firstMessageId,
    requestedAt,
    startedAt: null,
    completedAt: null,
    ...input,
  }) as OrchestrationV2Run;

const noticeFor = (runId: RunId, message: string) => ({
  id: IdAllocator.derive.runSignalTurnItem({ runId, signal: "limits-hold" }),
  runId,
  type: "system_notice" as const,
  message,
});

const userMessage = { id: firstMessageId, createdBy: "user", creationSource: "client" };
// The wake ClaudeAdapterV2 buffers while the CLI goes on with the session.
const bufferedWake = {
  id: wakeMessageId,
  createdBy: "agent",
  creationSource: "provider",
  notification: { source: { kind: "background_task" }, outcome: "updated", summary: "CI ended" },
};

const thirdRunId = RunId.make("run:held-child-3");

describe("heldQueue", () => {
  it("is every queued run when T3 holds them all", () => {
    const queue = heldQueue({
      runs: [
        run({ id: firstRunId, ordinal: 1 }),
        run({ id: wakeRunId, ordinal: 2, status: "queued", queueHeld: true, queuePosition: 2 }),
        run({ id: thirdRunId, ordinal: 3, status: "queued", queueHeld: true, queuePosition: 1 }),
      ],
    });
    assert.deepStrictEqual(
      queue.map((queued) => queued.id),
      [wakeRunId, thirdRunId],
    );
  });

  it("is nothing while a run goes, or while T3 can start a queued run", () => {
    assert.deepStrictEqual(
      heldQueue({
        runs: [
          run({ id: firstRunId, ordinal: 1, status: "running" }),
          run({ id: wakeRunId, ordinal: 2, status: "queued", queueHeld: true }),
        ],
      }),
      [],
    );
    // The scheduler starts the run it doesn't hold, whatever T3 holds behind it.
    assert.deepStrictEqual(
      heldQueue({
        runs: [
          run({ id: firstRunId, ordinal: 1, status: "queued", queuePosition: 1 }),
          run({ id: wakeRunId, ordinal: 2, status: "queued", queueHeld: true, queuePosition: 2 }),
        ],
      }),
      [],
    );
    assert.deepStrictEqual(
      heldQueue({ runs: [run({ id: firstRunId, ordinal: 1, status: "queued" })] }),
      [],
    );
  });
});

describe("heldRun", () => {
  const held = (input: Partial<OrchestrationV2Run> & Pick<OrchestrationV2Run, "id" | "ordinal">) =>
    run({ status: "queued", queueHeld: true, ...input });

  it("names the held run that starts first", () => {
    const named = heldRun(
      [
        held({ id: wakeRunId, ordinal: 2, queuePosition: 2 }),
        held({ id: thirdRunId, ordinal: 3, queuePosition: 1 }),
      ],
      { messages: [], turnItems: [] },
    );
    assert.equal(named?.runId, thirdRunId);
  });

  it("puts a child's finished result first, as the scheduler does", () => {
    const resultMessageId = MessageId.make("message:held-child-result");
    const named = heldRun(
      [
        held({ id: wakeRunId, ordinal: 2, queuePosition: 1 }),
        held({ id: thirdRunId, ordinal: 3, queuePosition: 2, userMessageId: resultMessageId }),
      ],
      {
        messages: [
          { id: resultMessageId, createdBy: "system", delegatedCompletion: { taskId } },
        ] as never,
        turnItems: [],
      },
    );
    assert.equal(named?.runId, thirdRunId);
  });

  it("gives the limits' notice as the reason", () => {
    const named = heldRun([held({ id: wakeRunId, ordinal: 2 })], {
      messages: [],
      turnItems: [noticeFor(wakeRunId, limitsNotice)] as never,
    });
    assert.deepStrictEqual(named, {
      runId: wakeRunId,
      since: "2026-11-09T19:21:42.000Z",
      reason: limitsNotice,
    });
  });

  it("says a Claude wake's session may still be working outside T3", () => {
    const named = heldRun([held({ id: wakeRunId, ordinal: 2, userMessageId: wakeMessageId })], {
      messages: [bufferedWake] as never,
      turnItems: [],
    });
    assert.match(named?.reason ?? "", /^T3 holds this thread's queue/);
    assert.match(named?.reason ?? "", /may still be working outside T3/);
  });
});

describe("task_status on a held child", () => {
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:held"),
    requestNamespace: "provider-session:held",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:held",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const task = {
    id: taskId,
    threadId: parentThreadId,
    origin: "app_owned",
    childThreadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    driver: "codex",
    model: "gpt-5.6-terra",
    status: "running",
    result: null,
    completionDelivery: { state: "pending" },
  };

  const readStatus = (input: {
    readonly task: object;
    readonly child?: Partial<OrchestrationV2ThreadProjection>;
    readonly heldThere?: OrchestratorMcpHeldRun;
  }) => {
    const parentProjection = {
      thread: { id: parentThreadId },
      runs: [],
      contextTransfers: [],
      subagents: [input.task],
    } as unknown as OrchestrationV2ThreadProjection;
    const childProjection = {
      thread: { id: childThreadId, title: "Child", modelSelection: undefined },
      runs: [],
      contextTransfers: [],
      messages: [],
      subagents: [],
      providerThreads: [],
      runtimeRequests: [],
      turnItems: [],
      nodes: [],
      ...input.child,
    } as unknown as OrchestrationV2ThreadProjection;
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: (threadId) =>
          Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
        delegatedTaskResultPending: () => Effect.succeed(true),
        dispatch: () => Effect.succeed({} as never),
      }),
      ServerSettings.layerTest(),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getPublishedProviders: Effect.succeed([]),
      }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(RemoteDelegation.RemoteDelegation)({
        heldThere: () => Effect.succeed(input.heldThere),
      }),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    );
    return OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.flatMap((service) => service.taskStatus(scope, taskId)),
      Effect.provide(
        OrchestratorMcpService.layer.pipe(
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
          Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
          Layer.provide(dependencies),
        ),
      ),
    );
  };

  it.effect("reads a child held for the limits as held, with the limits' notice", () =>
    Effect.gen(function* () {
      const result = yield* readStatus({
        task,
        child: {
          runs: [
            run({
              id: firstRunId,
              ordinal: 1,
              status: "queued",
              queueHeld: true,
              queuePosition: 1,
              delegatedTaskId: taskId,
            }),
          ],
          messages: [userMessage] as never,
          turnItems: [noticeFor(firstRunId, limitsNotice)] as never,
        },
      });
      assert.equal(result.status, "queued");
      assert.deepStrictEqual(result.held, {
        runId: firstRunId,
        since: "2026-11-09T19:21:42.000Z",
        reason: limitsNotice,
      });
    }),
  );

  it.effect("reads a child whose wake T3 holds as held, not just running", () =>
    Effect.gen(function* () {
      const result = yield* readStatus({
        task,
        child: {
          runs: [
            run({ id: firstRunId, ordinal: 1, status: "completed", delegatedTaskId: taskId }),
            run({
              id: wakeRunId,
              ordinal: 2,
              status: "queued",
              queueHeld: true,
              userMessageId: wakeMessageId,
            }),
          ],
          messages: [userMessage, bufferedWake] as never,
        },
      });
      assert.equal(result.workState, "working");
      assert.equal(result.held?.runId, wakeRunId);
      assert.match(result.held?.reason ?? "", /may still be working outside T3/);
    }),
  );

  it.effect("reads a working child without a hold", () =>
    Effect.gen(function* () {
      const result = yield* readStatus({
        task,
        child: {
          runs: [
            run({ id: firstRunId, ordinal: 1, status: "running", delegatedTaskId: taskId }),
            run({ id: wakeRunId, ordinal: 2, status: "queued", queueHeld: true }),
          ],
        },
      });
      assert.equal(result.status, "running");
      assert.isUndefined(result.held);
    }),
  );

  const remoteTask = {
    ...task,
    childThreadId: null,
    remoteChild: {
      environmentId: EnvironmentId.make("environment:held-there"),
      threadId: ThreadId.make("thread:held-there"),
      label: "teenylilpc",
    },
  };

  it.effect("passes on what a linked environment says it holds", () =>
    Effect.gen(function* () {
      const heldThere = {
        runId: wakeRunId,
        since: "2026-11-09T19:21:42.000Z",
        reason: limitsNotice,
      };
      const held = yield* readStatus({ task: remoteTask, heldThere });
      assert.equal(held.status, "running");
      assert.deepStrictEqual(held.held, heldThere);
      const working = yield* readStatus({ task: remoteTask });
      assert.isUndefined(working.held);
    }),
  );
});
