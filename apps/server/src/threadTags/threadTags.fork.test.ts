import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadTagNames from "./ThreadTagNames.ts";

// fork: thread tags, see FORK.md.

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Nothing here starts a turn"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
/** A server's thread services on `layerDatabase`, with the tag read the server provides. */
const layerThreadsOn = <ConfigError>(
  layerDatabase: typeof SqlitePersistence.layerMemory,
  layerConfig: Layer.Layer<ServerConfig.ServerConfig, ConfigError, NodeServices.NodeServices>,
) =>
  ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        EventStore.layer.pipe(Layer.provide(layerDatabase)),
        EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "thread-tags" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: layerDatabase, runEffectWorker: false },
        ),
      ),
    ),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
    Layer.provideMerge(ThreadTagNames.layer.pipe(Layer.provide(layerDatabase))),
    Layer.provideMerge(layerConfig.pipe(Layer.provide(NodeServices.layer))),
    Layer.provideMerge(NodeServices.layer),
  );
const layerTest = () =>
  layerThreadsOn(
    SqlitePersistence.layerMemory,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-tags-" }),
  ).pipe(Layer.provideMerge(ServerSettings.layerTest()));

const createThread = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-tags"),
      title: threadId,
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    }),
  );

/** What a person ticking a tag in the menu sends. */
const setTag = (threadId: ThreadId, tag: string, tagged: boolean, key: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.tag.set",
      commandId: CommandId.make(`menu:${threadId}:${key}`),
      threadId,
      tag,
      tagged,
    }),
  );

const tagsOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadShell(threadId).pipe(Effect.map((shell) => shell?.tags ?? [])),
  );

const a = ThreadId.make("thread:tags-a");
const b = ThreadId.make("thread:tags-b");
const archived = ThreadId.make("thread:tags-archived");
const spelled = ThreadId.make("thread:tags-spelled");

const archive = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make(`archive:${threadId}`),
      threadId,
    }),
  );

it.effect("the tag read lists archived threads' tags, and a malformed payload breaks no list", () =>
  Effect.gen(function* () {
    const live = ThreadId.make("thread:read-live");
    const old = ThreadId.make("thread:read-archived");
    const gone = ThreadId.make("thread:read-deleted");
    const odd = ThreadId.make("thread:read-odd");
    const mixed = ThreadId.make("thread:read-mixed");
    yield* Effect.forEach([live, old, gone, odd, mixed], createThread);
    yield* setTag(live, "Live", true, "live");
    yield* setTag(old, "Archived", true, "archived");
    yield* archive(old);
    yield* setTag(gone, "Gone", true, "gone");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete:gone"),
      threadId: gone,
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.tags', json('{"a":1}')) WHERE thread_id = ${odd}`;
    yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.tags', json('["Mixed",1]')) WHERE thread_id = ${mixed}`;

    const names = yield* ThreadTagNames.ThreadTagNames;
    expect(yield* names.list).toEqual(["Archived", "Live"]);
    const listed = yield* (yield* ProjectionStore.ProjectionStoreV2).listActiveThreads();
    expect(Object.fromEntries(listed.map((thread) => [thread.id, thread.tags]))).toEqual({
      [live]: ["Live"],
      [odd]: undefined,
      [mixed]: [],
    });
    // The shell reads them the same way.
    expect(yield* tagsOf(mixed)).toEqual([]);
  }).pipe(Effect.provide(layerTest())),
);

/** A client outside any thread, so no provider run has to be live. */
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:tags"),
  requestNamespace: "client:tags",
  thread: undefined,
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

it.effect(
  "an agent tags and untags with thread.tag.set, and t3_thread_list filters by any tag",
  () =>
    Effect.gen(function* () {
      yield* Effect.forEach([a, b, spelled, archived], createThread);
      yield* setTag(spelled, "Frontend", true, "frontend");
      yield* setTag(archived, "Old Work", true, "old-work");
      yield* archive(archived);
      const server = yield* McpServer.McpServer;
      const organize = (args: Record<string, unknown>) =>
        server
          .callTool({ name: "t3_thread_organize", arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

      const tagged = yield* organize({
        threadId: a,
        action: "tag",
        tags: ["frontend", "Waiting on review", "old WORK"],
      });
      // Spelled as any thread spells it, an archived one included.
      const spellings = ["Frontend", "Waiting on review", "Old Work"];
      expect(tagged.structuredContent).toEqual({ tags: spellings });
      expect(yield* tagsOf(a)).toEqual(spellings);

      const untagged = yield* organize({
        threadId: a,
        action: "untag",
        tags: ["FRONTEND", "old work"],
      });
      expect(untagged.structuredContent).toEqual({ tags: ["Waiting on review"] });
      expect(yield* tagsOf(a)).toEqual(["Waiting on review"]);
      expect((yield* organize({ threadId: a, action: "tag" })).isError).toBe(true);

      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const listed = yield* service.listThreads(scope, {
        allProjects: true,
        tags: ["waiting ON review", "elsewhere"],
      });
      expect(listed.threads.map((thread) => [thread.threadId, thread.tags])).toEqual([
        [a, ["Waiting on review"]],
      ]);
      const all = yield* service.listThreads(scope, { allProjects: true });
      expect(
        Object.fromEntries(all.threads.map((thread) => [thread.threadId, thread.tags])),
      ).toEqual({ [a]: ["Waiting on review"], [b]: undefined, [spelled]: ["Frontend"] });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          McpHttpServer.layerThreadToolkit.pipe(
            Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
            Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
            Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
            Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
            Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
          ),
          OrchestratorMcpService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
                Layer.mock(GitVcsDriver.GitVcsDriver)({}),
                Layer.mock(ProviderRegistry.ProviderRegistry)({}),
                Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
                Layer.mock(ProjectService.ProjectService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(RemoteDelegation.RemoteDelegation)({}),
              ),
            ),
          ),
        ).pipe(
          Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
          Layer.provide(NodeCrypto.layer),
          Layer.provideMerge(layerTest()),
        ),
      ),
    ),
);
