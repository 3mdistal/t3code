import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

// fork: thread tags, see FORK.md.

const threadId = ThreadId.make("thread:tags");
const otherThreadId = ThreadId.make("thread:tags-other");
const threadScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:tags"),
  requestNamespace: "provider-session:tags",
  thread: {
    threadId,
    providerSessionId: "provider-session:tags",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "thread-tags", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-tags", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("an agent tags and untags its thread through t3_thread_organize", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const settings = yield* ServerSettings.ServerSettingsService;
    const organize = (args: Record<string, unknown>) =>
      server
        .callTool({ name: "t3_thread_organize", arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, threadScope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const tagged = yield* organize({ action: "tag", tags: ["frontend", "Waiting on review"] });
    expect(tagged.isError).toBe(false);
    expect(tagged.structuredContent).toEqual({ tags: ["frontend", "Waiting on review"] });

    const untagged = yield* organize({ action: "untag", tags: ["FRONTEND"] });
    expect(untagged.structuredContent).toEqual({ tags: ["Waiting on review"] });
    expect((yield* settings.getSettings).threadTags).toEqual({
      [threadId]: ["Waiting on review"],
    });

    const missing = yield* organize({ action: "tag" });
    expect(missing.isError).toBe(true);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getProjectThreadRecords: () =>
              Effect.succeed(
                McpToolAccessTestkit.idleThreadProjection(
                  McpToolAccessTestkit.liveThreadShell(threadId),
                ),
              ),
          }),
        ),
        Layer.provideMerge(ServerSettings.layerTest()),
      ),
    ),
  ),
);

it.effect("t3_thread_list filters by any tag and returns each thread's tags", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const scope = { ...threadScope, thread: undefined, client: undefined };
    const listed = yield* service.listThreads(scope, { allProjects: true, tags: ["FRONTEND"] });
    expect(listed.threads.map((thread) => [thread.threadId, thread.tags])).toEqual([
      [threadId, ["frontend"]],
    ]);
    const all = yield* service.listThreads(scope, { allProjects: true });
    expect(all.threads.map((thread) => thread.tags)).toEqual([["frontend"], undefined]);
  }).pipe(
    Effect.provide(
      OrchestratorMcpService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(ThreadManagement.ThreadManagementService)({
              listProjectThreads: () =>
                Effect.succeed([
                  McpToolAccessTestkit.liveThreadShell(threadId),
                  McpToolAccessTestkit.liveThreadShell(otherThreadId),
                ]),
            }),
            ServerSettings.layerTest({ threadTags: { [threadId]: ["frontend"] } }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            Layer.mock(ProviderRegistry.ProviderRegistry)({}),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          ),
        ),
      ),
    ),
  ),
);
