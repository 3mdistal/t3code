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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
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
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { legacyThreadTagCommandId, moveLegacyThreadTags } from "./LegacyThreadTags.ts";
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
const layerTest = (threadTags: Record<string, Array<string>> = {}) =>
  layerThreadsOn(
    SqlitePersistence.layerMemory,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-tags-" }),
  ).pipe(Layer.provideMerge(ServerSettings.layerTest({ threadTags })));

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

const legacyTags = Effect.map(
  Effect.flatMap(ServerSettings.ServerSettingsService, (settings) => settings.getSettings),
  (settings) => settings.threadTags,
);

const a = ThreadId.make("thread:tags-a");
const b = ThreadId.make("thread:tags-b");
const archived = ThreadId.make("thread:tags-archived");
const spelled = ThreadId.make("thread:tags-spelled");
const present = ThreadId.make("thread:tags-present");
const full = ThreadId.make("thread:tags-full");
const missing = ThreadId.make("thread:tags-missing");

const archive = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make(`archive:${threadId}`),
      threadId,
    }),
  );

const receiptOf = (threadId: ThreadId, tag: string) =>
  Effect.flatMap(CommandReceiptStore.CommandReceiptStoreV2, (receipts) =>
    receipts
      .getByCommandId(legacyThreadTagCommandId(threadId, tag, 0))
      .pipe(Effect.map(Option.map((receipt) => receipt.status))),
  );

it.effect(
  "the move adds every settings tag with a receipt, spelled as threads spell it, and clears the key",
  () =>
    Effect.gen(function* () {
      yield* Effect.forEach([a, b, archived, spelled, present, full], createThread);
      yield* setTag(spelled, "Frontend", true, "frontend");
      yield* setTag(archived, "Old Work", true, "old-work");
      yield* archive(archived);
      yield* setTag(present, "keep", true, "keep");
      const twenty = Array.from({ length: 20 }, (_, index) => `t${index}`);
      yield* Effect.forEach(twenty, (tag) => setTag(full, tag, true, tag));

      yield* moveLegacyThreadTags();
      expect(yield* tagsOf(a)).toEqual(["Frontend", "review"]);
      // An archived thread's spelling counts too.
      expect(yield* tagsOf(b)).toEqual(["review", "Old Work"]);
      // A tag the thread has still gets its add, so the add leaves a receipt.
      expect(yield* tagsOf(present)).toEqual(["keep"]);
      expect(yield* receiptOf(present, "KEEP")).toEqual(Option.some("accepted"));
      // Legacy lists were capped already, so the soft cap doesn't drop one.
      expect(yield* tagsOf(full)).toEqual([...twenty, "one more"]);
      // A thread that's gone refuses the add; the refusal is its receipt.
      expect(yield* receiptOf(missing, "gone")).toEqual(Option.some("rejected"));
      expect(yield* legacyTags).toEqual({});
    }).pipe(
      Effect.provide(
        layerTest({
          [a]: ["frontend", "review"],
          [b]: ["Review", "old work"],
          [present]: ["KEEP"],
          [full]: ["one more"],
          [missing]: ["gone"],
        }),
      ),
    ),
);

it.effect("a repeated move replays each add's receipt, so a tag removed since stays off", () =>
  Effect.gen(function* () {
    yield* createThread(a);
    // An earlier run added "one" and stopped before "two" and before clearing settings.
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.tag.set",
      commandId: legacyThreadTagCommandId(a, "one", 0),
      threadId: a,
      tag: "one",
      tagged: true,
    });
    yield* setTag(a, "one", false, "untag-one");

    yield* moveLegacyThreadTags();
    expect(yield* tagsOf(a)).toEqual(["two"]);
    expect(yield* legacyTags).toEqual({});

    // Run again with nothing left to move: nothing changes.
    yield* moveLegacyThreadTags();
    expect(yield* tagsOf(a)).toEqual(["two"]);
  }).pipe(Effect.provide(layerTest({ [a]: ["one", "two"] }))),
);

it.effect(
  "an add that leaves no receipt stays in settings for the next start, and the rest clear",
  () =>
    Effect.gen(function* () {
      yield* Effect.forEach([a, b], createThread);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      let failures = 1;
      const flaky = {
        ...orchestrator,
        dispatch: (command: Parameters<typeof orchestrator.dispatch>[0]) =>
          command.type === "thread.tag.set" && command.tag === "flaky" && failures-- > 0
            ? Effect.die("The database went away")
            : orchestrator.dispatch(command),
      };
      const move = moveLegacyThreadTags().pipe(
        Effect.provideService(Orchestrator.OrchestratorV2, flaky),
      );

      yield* move;
      expect(yield* tagsOf(a)).toEqual(["steady"]);
      expect(yield* tagsOf(b)).toEqual(["other"]);
      expect(yield* legacyTags).toEqual({ [a]: ["flaky"] });

      yield* move;
      expect(yield* tagsOf(a)).toEqual(["steady", "flaky"]);
      expect(yield* legacyTags).toEqual({});
    }).pipe(Effect.provide(layerTest({ [a]: ["steady", "flaky"], [b]: ["other"] }))),
);

it("names each add by thread, tag and attempt so no two share a command id", () => {
  const id = (threadId: string, tag: string, attempt = 0) =>
    legacyThreadTagCommandId(ThreadId.make(threadId), tag, attempt);
  expect(id("thread:a", "b:c")).not.toBe(id("thread:a:b", "c"));
  expect(id("thread:a", "Review")).toBe(id("thread:a", "review"));
  expect(id("thread:a", "review", 1)).not.toBe(id("thread:a", "review"));
  // A tag older builds cut inside a character still has an id of its own.
  const cut = `${"x".repeat(39)}\uD83D`;
  expect(id("thread:a", cut)).not.toBe(id("thread:a", "x".repeat(39)));
  expect(id("thread:a", "\uDC00")).not.toBe(id("thread:a", "\uFFFD"));
});

it.effect(
  "a tag older builds cut inside a character moves cleaned, and the entry beside it moves too",
  () =>
    Effect.gen(function* () {
      yield* Effect.forEach([a, b], createThread);
      yield* moveLegacyThreadTags();
      expect(yield* tagsOf(a)).toEqual(["x".repeat(39)]);
      expect(yield* tagsOf(b)).toEqual(["review"]);
      expect(yield* legacyTags).toEqual({});
    }).pipe(
      // What the old writer saved for 39 letters and an emoji: the first half of the emoji.
      Effect.provide(layerTest({ [a]: [`${"x".repeat(39)}😀`.slice(0, 40)], [b]: ["review"] })),
    ),
);

it.effect(
  "a live thread that refuses an add keeps the entry, and the next start adds it under a new id",
  () =>
    Effect.gen(function* () {
      yield* createThread(a);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      let breaks = 1;
      // The thread's row is out of reach while the first add runs, as a failed read inside the
      // handler leaves it: a refusal on the record for a thread that is still there.
      const flaky = {
        ...orchestrator,
        dispatch: (command: Parameters<typeof orchestrator.dispatch>[0]) =>
          command.type === "thread.tag.set" && breaks-- > 0
            ? sql`ALTER TABLE orchestration_v2_projection_threads RENAME TO projection_threads_away`.pipe(
                Effect.andThen(orchestrator.dispatch(command)),
                Effect.ensuring(
                  sql`ALTER TABLE projection_threads_away RENAME TO orchestration_v2_projection_threads`.pipe(
                    Effect.orDie,
                  ),
                ),
              )
            : orchestrator.dispatch(command),
      };
      const move = moveLegacyThreadTags().pipe(
        Effect.provideService(Orchestrator.OrchestratorV2, flaky),
      );

      yield* move;
      expect(yield* receiptOf(a, "needs:pc")).toEqual(Option.some("rejected"));
      expect(yield* tagsOf(a)).toEqual([]);
      expect(yield* legacyTags).toEqual({ [a]: ["needs:pc"] });

      yield* move;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const second = yield* receipts.getByCommandId(legacyThreadTagCommandId(a, "needs:pc", 1));
      expect(Option.map(second, (receipt) => receipt.status)).toEqual(Option.some("accepted"));
      expect(yield* tagsOf(a)).toEqual(["needs:pc"]);
      expect(yield* legacyTags).toEqual({});
    }).pipe(Effect.provide(layerTest({ [a]: ["needs:pc"] }))),
);

it.effect("a deleted thread's tags leave settings on the first start", () =>
  Effect.gen(function* () {
    yield* createThread(a);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete:a"),
      threadId: a,
    });
    yield* moveLegacyThreadTags();
    expect(yield* receiptOf(a, "review")).toEqual(Option.some("rejected"));
    expect(yield* legacyTags).toEqual({});
  }).pipe(Effect.provide(layerTest({ [a]: ["review"] }))),
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

it.live(
  "on disk, the move survives a restart: a tag removed since stays off and the key leaves the file",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-tags-disk-" });
      const layerConfig = ServerConfig.layerTest(process.cwd(), baseDir);
      const { settingsPath } = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(layerConfig.pipe(Layer.provide(NodeServices.layer))),
      );
      const onDisk = ThreadId.make("thread:tags-on-disk");
      const writeLegacy = fs.writeFileString(
        settingsPath,
        JSON.stringify({ threadTags: { [onDisk]: ["one", "two"] } }),
      );
      const savedTags = fs
        .readFileString(settingsPath)
        .pipe(Effect.map((text) => (JSON.parse(text) as { threadTags?: unknown }).threadTags));
      const layerDatabase = SqlitePersistence.layerConfig.pipe(
        Layer.provide(layerConfig),
        Layer.provide(NodeServices.layer),
        Layer.orDie,
      );
      // Each open builds the server's layers afresh on the same database and settings file.
      const open = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provide(
            layerThreadsOn(layerDatabase, layerConfig).pipe(
              Layer.provideMerge(
                ServerSettings.layer.pipe(
                  Layer.provide(ServerSecretStore.layer),
                  Layer.provide(ManagedPolicy.layerTest()),
                  Layer.provide(layerDatabase),
                  Layer.provide(layerConfig),
                ),
              ),
            ),
          ),
        );

      yield* writeLegacy;
      yield* open(
        Effect.gen(function* () {
          yield* createThread(onDisk);
          yield* moveLegacyThreadTags();
          expect(yield* tagsOf(onDisk)).toEqual(["one", "two"]);
          yield* setTag(onDisk, "one", false, "untag-one");
        }),
      );
      expect(yield* savedTags).toBeUndefined();

      // As if the clear never reached the file: the next start moves the same tags again.
      yield* writeLegacy;
      yield* open(
        Effect.gen(function* () {
          expect(yield* legacyTags).toEqual({ [onDisk]: ["one", "two"] });
          yield* moveLegacyThreadTags();
          expect(yield* tagsOf(onDisk)).toEqual(["two"]);
        }),
      );
      expect(yield* savedTags).toBeUndefined();

      yield* open(
        Effect.gen(function* () {
          yield* moveLegacyThreadTags();
          expect(yield* tagsOf(onDisk)).toEqual(["two"]);
          expect(yield* legacyTags).toEqual({});
        }),
      );
      expect(yield* savedTags).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);
