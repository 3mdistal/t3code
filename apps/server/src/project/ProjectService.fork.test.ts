import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  providerPoolInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const work = ProviderInstanceId.make("claudeAgent_work");
const home = ProviderInstanceId.make("claudeAgent_home");

const layerTest = RuntimeLayer.layerProjectService.pipe(
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(
    Layer.succeed(WorkspacePaths.WorkspacePaths, {
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
        Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
    }),
  ),
  Layer.provideMerge(
    Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(
    ServerSettings.layerTest({
      providerInstances: {
        [work]: { driver: claude, enabled: true },
        [home]: { driver: claude, enabled: true },
      },
      providerPools: { [claude]: { enabled: true, memberInstanceIds: [work, home] } },
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "project-service-fork-test-" })),
  Layer.provide(NodeServices.layer),
);

// Threads that agents start take the project's own default; stock T3 would hand a pool id
// straight to a provider that doesn't exist, so the project keeps the pool's first account.
it.layer(layerTest)("ProjectService on the fork", (it) => {
  it.effect("saves a project default that names a pool on the pool's first account", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const projectId = ProjectId.make("project:pooled");
      yield* service.create({
        commandId: CommandId.make("command:project:create"),
        projectId,
        title: "Pooled",
        workspaceRoot: "/work/pooled",
      });

      const updated = yield* service.update({
        commandId: CommandId.make("command:project:update"),
        projectId,
        defaultModelSelection: {
          instanceId: providerPoolInstanceId(claude),
          model: "claude-opus-4-8",
        },
      });

      assert.deepStrictEqual(updated.defaultModelSelection, {
        instanceId: work,
        model: "claude-opus-4-8",
      });
    }),
  );
});
