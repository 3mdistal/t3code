import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

const SESSION = "session-under-test";
const FORK = "session-forked";
const threadId = ThreadId.make("thread:lost-session");
const modelSelection = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});
const settings = Schema.decodeSync(ClaudeSettings)({});
const testLayer = Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer);

const makeHome = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-lost-" });
  const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
    instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
    settings,
    environment: { CLAUDE_CONFIG_DIR: configDir },
    attachmentsDir: configDir,
    fileSystem,
    path,
    crypto: yield* Crypto.Crypto,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    queryRunner: {
      keepsTranscriptsOnDisk: true,
      allocateSessionId: Effect.succeed(SESSION),
      open: () =>
        Effect.succeed({
          messages: Stream.never,
          offer: () => Effect.void,
          setModel: () => Effect.void,
          applyFlagSettings: () => Effect.void,
          setPermissionMode: () => Effect.void,
          backgroundTasks: () => Effect.succeed(false),
          stopTask: () => Effect.void,
          interrupt: Effect.void,
          close: Effect.void,
        }),
      forkSession: () => Effect.succeed({ sessionId: FORK }),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    },
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session:lost-session"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const projects = path.join(configDir, "projects");
  const saveTranscript = (project: string, sessionId: string) =>
    fileSystem
      .makeDirectory(path.join(projects, project), { recursive: true })
      .pipe(
        Effect.andThen(
          fileSystem.writeFileString(path.join(projects, project, `${sessionId}.jsonl`), ""),
        ),
      );
  const check = (nativeThreadHasTurns: boolean, thread = providerThread) =>
    Effect.result(
      runtime.assertNativeThreadResumable!({ providerThread: thread, nativeThreadHasTurns }),
    );
  return { fileSystem, path, projects, runtime, providerThread, saveTranscript, check };
});

const startPromptedTurn = Effect.fn("startPromptedTurn")(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
) {
  const now = yield* DateTime.now;
  yield* runtime.startTurn({
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:lost-session"),
      title: "Lost session",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId,
    runId: RunId.make("run:lost-session"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt:lost-session"),
    rootNodeId: NodeId.make("node:lost-session"),
    providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make("message:lost-session"),
      text: "Hello",
      attachments: [],
    },
    modelSelection,
    runtimePolicy,
  });
});

describe("ClaudeAdapterV2 assertNativeThreadResumable", () => {
  it.effect("fails when no project folder holds the transcript of a thread with turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome;
        yield* home.saveTranscript("-some-other-project", "another-session");
        // Stray files sit beside the project folders in a real home.
        yield* home.fileSystem.writeFileString(home.path.join(home.projects, "stray.txt"), "");

        const result = yield* home.check(true);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure" && result.failure._tag === "ProviderAdapterProtocolError") {
          assert.include(result.failure.detail, SESSION);
        } else {
          assert.fail("Expected a protocol error naming the session");
        }
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails when the account has never saved a session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome;
        assert.isFalse(yield* home.fileSystem.exists(home.projects));
        assert.equal((yield* home.check(true))._tag, "Failure");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("passes when any project folder holds the transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome;
        yield* home.saveTranscript("-an-older-worktree", SESSION);
        assert.equal((yield* home.check(true))._tag, "Success");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("leaves a session with no turns for the next query to create", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome;
        assert.equal((yield* home.check(false))._tag, "Success");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("checks a session pinned to a conversation head even with no recorded turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome;
        const pinned = {
          ...home.providerThread,
          nativeConversationHeadRef: {
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeId: "message-at-head",
            strength: "weak" as const,
          },
        };
        assert.equal((yield* home.check(false, pinned))._tag, "Failure");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("leaves a home it can't read to the CLI", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome;
        // A file where the projects folder belongs fails the directory read.
        yield* home.fileSystem.writeFileString(home.projects, "");
        assert.equal((yield* home.check(true))._tag, "Success");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("trusts a live process that hasn't saved the conversation yet", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome;
        yield* startPromptedTurn(home.runtime, home.providerThread);
        assert.equal((yield* home.check(true))._tag, "Success");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("checks a session already opened here even with no recorded turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome;
        const forked = yield* home.runtime.forkThread({
          sourceProviderThread: home.providerThread,
          targetThreadId: threadId,
        });
        assert.equal(forked.nativeThreadRef?.nativeId, FORK);
        assert.equal((yield* home.check(false, forked))._tag, "Failure");
        yield* home.saveTranscript("-workspace", FORK);
        assert.equal((yield* home.check(false, forked))._tag, "Success");
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
