import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerSettings,
  type WorktreeKeepWhen,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import { ServerActivation } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

/** Long enough ago that cleanup's 8-day rule applies. */
const LONG_AGO = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

/** An idle thread whose worktree is old enough to clean up. */
const shell = (worktreePath: string): OrchestrationV2ThreadShell => ({
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePath,
  activeProviderThreadId: null,
  lineage: {
    rootThreadId: ThreadId.make("thread-1"),
    parentThreadId: null,
    relationshipToParent: null,
  },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  activeRunId: null,
  latestVisibleMessage: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  lastVisitedAt: null,
  deletedAt: null,
  branch: "feature",
  linkedPullRequest: null,
  status: "idle",
  activityRunStatus: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestRunId: null,
  latestRunRequestedAt: null,
  latestRunStartedAt: null,
  latestRunCompletedAt: null,
  latestUserMessageAt: null,
  createdAt: LONG_AGO,
  updatedAt: LONG_AGO,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
});

/** A repository with one worktree, `feature`, that cleanup would remove if it were clean. */
const fixture = (worktreeKeepWhen: WorktreeKeepWhen) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-repo-" }));
    const command = (cwd: string, args: string[]) =>
      git.execute({ operation: "cleanup-fork-test", cwd, args });
    yield* command(repo, ["init", "-b", "main"]);
    yield* command(repo, ["config", "user.email", "cleanup@example.test"]);
    yield* command(repo, ["config", "user.name", "Cleanup test"]);
    yield* fs.writeFileString(`${repo}/.gitignore`, "*.log\n");
    yield* command(repo, ["add", "."]);
    yield* command(repo, ["commit", "-m", "initial"]);
    yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
    const worktree = `${config.worktreesDir}/feature`;
    yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      storageCleanup: {
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: 8,
        worktreeOnDelete: true,
        worktreeKeepWhen,
      },
    };
    const threads = [shell(worktree)];
    const context = yield* Layer.build(StorageCleanup.layer).pipe(
      Effect.provideService(Settings.ServerSettingsService, {
        getSettings: Effect.succeed(settings),
        subscribeChanges: Effect.succeed(Stream.empty),
      } as unknown as Settings.ServerSettingsService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        list: () => Effect.succeed([{ workspaceRoot: repo }]),
        listShells: () =>
          Effect.succeed([{ id: ProjectId.make("project-1"), workspaceRoot: repo }]),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        getShellSnapshot: (input?: { location?: string }) =>
          Effect.succeed({
            threads: input?.location === "archive" ? [] : threads,
            archivedThreads: [],
          }),
        getThreadWorktreePaths: () =>
          Effect.succeed(
            threads.map((thread) => ({ threadId: thread.id, worktreePath: worktree })),
          ),
        getThreadShell: (threadId: ThreadId) =>
          Effect.succeed(threads.find((thread) => thread.id === threadId) ?? null),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
        isLive: () => Effect.succeed(true),
      } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]),
      Effect.provideService(Orchestrator.OrchestratorV2, {
        streamDomainEvents: Stream.empty,
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
      Effect.provideService(SqlClient.SqlClient, ((strings: TemplateStringsArray) =>
        Effect.succeed(
          strings.join("").includes('AS "worktreePath"') ? [{ worktreePath: worktree }] : [],
        )) as unknown as SqlClient.SqlClient),
      Effect.provideService(GitManager.GitManager, {
        invalidateStatus: () => Effect.void,
      } as unknown as GitManager.GitManager["Service"]),
      Effect.provideService(TerminalManager.TerminalManager, {
        subscribeMetadata: () => Effect.succeed(() => {}),
      } as unknown as TerminalManager.TerminalManager["Service"]),
      Effect.provideService(ServerActivation, Deferred.await(yield* Deferred.make<void>())),
    );
    /** Enough files that listing them passes cleanup's 64 KiB inspection limit. */
    const writeMany = (extension: string) =>
      Effect.forEach(
        Array.from({ length: 2_000 }, (_, index) => index),
        (index) =>
          fs.writeFileString(
            `${worktree}/a-file-with-a-long-enough-name-${String(index).padStart(5, "0")}.${extension}`,
            "local data\n",
          ),
        { concurrency: 32, discard: true },
      );
    return {
      service: Context.get(context, StorageCleanup.StorageCleanup),
      fs,
      worktree,
      writeMany,
    };
  });

const runCleanupTest = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
    | GitVcsDriver.GitVcsDriver
    | Path.Path
    | Scope.Scope
  >,
) =>
  effect.pipe(
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "storage-cleanup-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );

describe("storage cleanup past its inspection limit", () => {
  it.live("keeps a worktree whose local changes list past the limit", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, writeMany } = yield* fixture("uncommitted-changes");
        yield* writeMany("txt");
        const report = yield* service.runNow;
        expect(report.entries).toMatchObject([
          {
            kind: "worktree",
            outcome: "kept",
            threadId: "thread-1",
            reason: expect.stringContaining("exceed the inspection limit"),
          },
        ]);
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );

  it.live("keeps a worktree whose ignored files list past the limit", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, writeMany } = yield* fixture("any-local-files");
        yield* writeMany("log");
        const report = yield* service.runNow;
        expect(report.entries).toMatchObject([
          {
            kind: "worktree",
            outcome: "kept",
            threadId: "thread-1",
            reason: expect.stringContaining("exceed the inspection limit"),
          },
        ]);
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
});
