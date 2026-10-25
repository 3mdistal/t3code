import {
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitManager from "../git/GitManager.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";

const NOW = DateTime.makeUnsafe("2026-09-20T00:00:00.000Z");

const merged: GitManager.GitBranchPullRequest = {
  number: 7,
  title: "Finished work",
  url: "https://github.com/acme/project/pull/7",
  baseRef: "main",
  headRef: "feature/done",
  state: "merged",
  updatedAt: "2026-09-19T00:00:00.000Z",
  repositoryKey: "github.com/acme/project",
};

const mergedBranchThread = (
  saved: Pick<OrchestrationV2ThreadShell, "branchPullRequest"> = {},
): OrchestrationV2ThreadShell => {
  const threadId = ThreadId.make("merged-branch-thread");
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Merged branch",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/done",
    ...saved,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

const sweepCommands = (
  thread: OrchestrationV2ThreadShell,
  branchPullRequest: GitManager.GitManager["Service"]["branchPullRequest"],
) =>
  Effect.gen(function* () {
    const project: OrchestrationProjectShell = {
      id: thread.projectId,
      title: "Project",
      workspaceRoot: "/workspace/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const activation = yield* Deferred.make<void>();
    const sweepStarted = yield* Deferred.make<void>();
    const commands: Array<OrchestrationV2ServerCommand> = [];
    const dependencies = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.never,
        getShellSnapshot: () =>
          Deferred.succeed(sweepStarted, undefined).pipe(
            Effect.as({
              schemaVersion: 2,
              snapshotSequence: 1,
              threads: [thread],
              archivedThreads: [],
            }),
          ),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: 2, storedEvents: [] };
          }),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () => Effect.succeed([project]),
        getShell: () => Effect.succeedSome(project),
      }),
      Layer.mock(GitManager.GitManager)({ branchPullRequest }),
      Layer.mock(PullRequestService.PullRequestService)({}),
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: () =>
          Effect.succeed({
            canonicalKey: "github.com/acme/project",
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: "git@github.com:acme/project.git",
            },
            provider: SourceControlProviderKind.make("github"),
            owner: "acme",
            name: "project",
          }),
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
      Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size).fill(1),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
      FileSystem.layerNoop({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ThreadPullRequestService.make;
      yield* service.start();
      yield* Deferred.succeed(activation, undefined);
      yield* Deferred.await(sweepStarted);
      yield* service.drain;
    }).pipe(Effect.provide(dependencies), Effect.scoped);
    return commands;
  });

describe("ThreadPullRequestServiceV2 sweeps", () => {
  it.effect.each([{ freshAnswer: "the same" }, { freshAnswer: "no" }] as const)(
    "a sweep persists a merged pull request only when fresh git state finds $freshAnswer pull request",
    ({ freshAnswer }) =>
      Effect.gen(function* () {
        const thread = mergedBranchThread();
        // Without fresh git state the answer comes from cached reads, which may predate a
        // repointed remote.
        const commands = yield* sweepCommands(thread, (_input, options) =>
          Effect.succeed(options?.freshGitState === true && freshAnswer === "no" ? null : merged),
        );

        if (freshAnswer === "no") {
          expect(commands).toEqual([]);
        } else {
          expect(commands).toHaveLength(1);
          expect(commands[0]).toMatchObject({
            type: "thread.pull-request.sync",
            threadId: thread.id,
            branchPullRequest: { number: 7, url: merged.url },
          });
        }
      }),
  );

  it.effect("a sweep does not reread git state for a merged pull request it already has", () =>
    Effect.gen(function* () {
      let gitStateReads = 0;
      const thread = mergedBranchThread({
        branchPullRequest: {
          projectId: ProjectId.make("project-1"),
          repository: "acme/project",
          number: merged.number,
          url: merged.url,
        },
      });
      // Like GitManager, a merged answer starts git again unless the caller opts out.
      const commands = yield* sweepCommands(thread, (_input, options) =>
        Effect.sync(() => {
          if (options?.freshGitState === true || options?.confirmClosed !== false) {
            gitStateReads += 1;
          }
          return merged;
        }),
      );

      expect(commands).toEqual([]);
      expect(gitStateReads).toBe(0);
    }),
  );
});
