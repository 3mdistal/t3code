// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { SourceControlProvider } from "@t3tools/source-control-core/server/SourceControlProvider";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-manager-fork-test-",
});

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(layerServerConfig),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  GitVcsDriver.GitVcsDriver.use((driver) =>
    driver.execute({ operation: "GitManager.fork.test.git", cwd, args }),
  );

const makeManager = (pullRequest: SourceControlProvider["Service"]["listChangeRequests"]) =>
  Effect.gen(function* () {
    const gitCommands: Array<string> = [];
    // On Windows the driver starts git by its full path to git.exe.
    const layerCountingSpawner = Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
        Effect.succeed(
          ChildProcessSpawner.make((command) => {
            if (
              command._tag === "StandardCommand" &&
              NodePath.parse(command.command).name.toLowerCase() === "git"
            ) {
              gitCommands.push(command.args.join(" "));
            }
            return spawner.spawn(command);
          }),
        ),
      ),
    ).pipe(Layer.provide(NodeServices.layer));
    const provider = yield* SourceControlProvider.pipe(
      Effect.provide(
        Layer.mock(SourceControlProvider)({
          kind: SourceControlProviderKind.make("github"),
          // The mock would otherwise stub this optional method too.
          headBranchProbe: ({ headSelectors }) => ({ headSelectors, limit: 20 }),
          listChangeRequests: pullRequest,
        }),
      ),
    );
    const layerManager = Layer.mergeAll(
      Layer.mock(TextGeneration.TextGeneration)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
      ServerSettings.ServerSettingsService.layerTest(),
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
        resolve: () => Effect.succeed(provider),
      }),
    ).pipe(
      Layer.provideMerge(
        Layer.fresh(GitVcsDriver.layer).pipe(
          Layer.provide(layerCountingSpawner),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(layerServerConfig),
        ),
      ),
      Layer.provideMerge(
        Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
          Layer.provideMerge(SqlitePersistence.layerMemory),
        ),
      ),
    );
    const manager = yield* GitManager.make.pipe(
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provide(layerManager),
    );
    return { manager, gitCommands };
  });

it.layer(layerGit)("GitManager (fork)", (it) => {
  it.effect("a caller that confirms a merged PR itself can skip rereading git state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const repoDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-git-manager-" });
      const remoteDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-git-remote-" });
      yield* git(remoteDir, "init", "--bare");
      yield* git(repoDir, "init", "--initial-branch=main");
      yield* git(repoDir, "config", "user.email", "test@example.com");
      yield* git(repoDir, "config", "user.name", "Test User");
      yield* git(repoDir, "commit", "--allow-empty", "-m", "Initial commit");
      yield* git(repoDir, "remote", "add", "origin", remoteDir);
      yield* git(repoDir, "checkout", "-b", "feature/merged-confirm");
      yield* git(repoDir, "push", "-u", "origin", "feature/merged-confirm");
      const { manager, gitCommands } = yield* makeManager(() =>
        Effect.succeed([
          {
            provider: SourceControlProviderKind.make("github"),
            number: 240,
            title: "Merged work",
            url: "https://github.com/acme/project/pull/240",
            baseRefName: "main",
            headRefName: "feature/merged-confirm",
            state: "merged",
            updatedAt: Option.none(),
          },
        ]),
      );
      const input = { cwd: repoDir, branch: "feature/merged-confirm" };
      expect((yield* manager.branchPullRequest(input))?.state).toBe("merged");

      gitCommands.length = 0;
      const unconfirmed = yield* manager.branchPullRequest(input, { confirmClosed: false });
      expect(unconfirmed?.state).toBe("merged");
      expect(gitCommands).toEqual([]);

      expect((yield* manager.branchPullRequest(input))?.state).toBe("merged");
      expect(gitCommands).not.toEqual([]);
    }),
  );
});
