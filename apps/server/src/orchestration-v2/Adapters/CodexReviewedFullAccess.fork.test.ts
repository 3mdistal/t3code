// fork: full access can send flagged commands to Codex's auto-review instead of refusing them; see FORK.md.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CodexSettings,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import packageJson from "../../../package.json" with { type: "json" };
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  CODEX_REVIEWED_FULL_ACCESS_TURN_DEFAULTS,
  codexAutoReviewNotice,
  codexReviewedFullAccessThreadConfig,
  readCodexConfiguredMcpServers,
} from "./CodexReviewedFullAccess.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const buildTurn = (input: {
  readonly runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly reviewFlaggedCommandsInFullAccess?: boolean;
}) =>
  CodexAdapterV2.buildCodexTurnStartParams({
    nativeThreadId: "native",
    codexInput: [{ type: "text", text: "test" }],
    runtimePolicy: { runtimeMode: input.runtimeMode, interactionMode: "default", cwd: null },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    ...(input.reviewFlaggedCommandsInFullAccess === undefined
      ? {}
      : { reviewFlaggedCommandsInFullAccess: input.reviewFlaggedCommandsInFullAccess }),
  });

describe("reviewed full access turn policy", () => {
  it.effect("reviews flagged commands in full access only when the setting is on", () =>
    Effect.gen(function* () {
      const off = yield* buildTurn({ runtimeMode: "full-access" });
      assert.equal(off.approvalPolicy, "never");
      assert.equal(off.approvalsReviewer, "user");
      assert.equal(off.sandboxPolicy?.type, "dangerFullAccess");

      const on = yield* buildTurn({
        runtimeMode: "full-access",
        reviewFlaggedCommandsInFullAccess: true,
      });
      assert.deepEqual(on.approvalPolicy, {
        granular: {
          sandbox_approval: true,
          rules: true,
          request_permissions: false,
          skill_approval: false,
          mcp_elicitations: true,
        },
      });
      assert.equal(on.approvalsReviewer, "auto_review");
      assert.equal(on.sandboxPolicy?.type, "dangerFullAccess");
    }),
  );

  it.effect("leaves every other runtime mode alone when the setting is on", () =>
    Effect.gen(function* () {
      for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
        const off = yield* buildTurn({ runtimeMode });
        const on = yield* buildTurn({ runtimeMode, reviewFlaggedCommandsInFullAccess: true });
        assert.deepEqual(on.approvalPolicy, off.approvalPolicy);
        assert.equal(on.approvalsReviewer, off.approvalsReviewer);
        assert.deepEqual(on.sandboxPolicy, off.sandboxPolicy);
      }
    }),
  );

  it("is off unless the setting is stored", () => {
    assert.isUndefined(decodeCodexSettings({}).reviewFlaggedCommandsInFullAccess);
  });
});

describe("reviewed full access thread config", () => {
  it("approves apps and each named server, skipping T3's inline table and dotted names", () => {
    assert.deepEqual(
      codexReviewedFullAccessThreadConfig(["agent-native-content", "t3-code", "a.b", "node_repl"]),
      {
        "apps._default.default_tools_approval_mode": "approve",
        "mcp_servers.agent-native-content.default_tools_approval_mode": "approve",
        "mcp_servers.node_repl.default_tools_approval_mode": "approve",
      },
    );
  });

  const clientAnswering = (
    answer: Effect.Effect<unknown, CodexErrors.CodexAppServerError>,
    seen: Array<unknown> = [],
  ) =>
    ({
      raw: {
        request: (method: string, params: unknown) => {
          seen.push({ method, params });
          return answer;
        },
      },
    }) as unknown as Pick<CodexClient.CodexAppServerClient["Service"], "raw">;

  it.effect("reads server names from the folder's effective config", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      const names = yield* readCodexConfiguredMcpServers(
        clientAnswering(
          Effect.succeed({
            config: { mcp_servers: { notion: { url: "x" }, node_repl: { command: "y" } } },
            origins: {},
          }),
          seen,
        ),
        "/workspace",
      );
      assert.deepEqual(names, ["notion", "node_repl"]);
      assert.deepEqual(seen, [
        { method: "config/read", params: { includeLayers: false, cwd: "/workspace" } },
      ]);
    }),
  );

  it.effect("treats a config with no servers, a bad shape or a failed read as no names", () =>
    Effect.gen(function* () {
      for (const answer of [
        Effect.succeed({ config: {}, origins: {} }),
        Effect.succeed({ config: { mcp_servers: null }, origins: {} }),
        Effect.succeed({ nope: true }),
        Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound("config/read")),
      ]) {
        assert.deepEqual(yield* readCodexConfiguredMcpServers(clientAnswering(answer), null), []);
      }
    }),
  );
});

// A real denial from Codex 0.167.0, with the paths shortened.
const REAL_DENIAL = {
  threadId: "01a1ba73-ffce-7651-9606-c77f2cb0a8f7",
  turnId: "turn-1",
  startedAtMs: 1794129538909,
  completedAtMs: 1794129544621,
  reviewId: "11e0402a-db66-4a5c-abd1-927e6c423308",
  targetItemId: "exec-c70b8057-c553-42e3-8856-0e30efd98131",
  decisionSource: "agent",
  review: {
    status: "denied",
    riskLevel: "medium",
    userAuthorization: "low",
    rationale: "The command deletes keep.txt despite the user's explicit instruction.",
  },
  action: {
    type: "command",
    source: "unifiedExec",
    command: "pwsh.exe -Command 'Remove-Item -Force -LiteralPath keep.txt'",
    cwd: "C:\\scratch",
  },
};
const decodeReview = Schema.decodeUnknownSync(
  CodexSchema.V2ItemGuardianApprovalReviewCompletedNotification,
);

describe("auto-review notices", () => {
  it("names the command, folder, risk, reason and how to try again for a real denial", () => {
    assert.deepEqual(codexAutoReviewNotice(decodeReview(REAL_DENIAL)), {
      title: "Auto-review blocked a command",
      message: [
        "Auto-review blocked a command (medium risk).",
        "Command: pwsh.exe -Command 'Remove-Item -Force -LiteralPath keep.txt'",
        "Folder: C:\\scratch",
        "Why: The command deletes keep.txt despite the user's explicit instruction.",
        "To try it anyway, reply in this thread approving this exact command. The reviewer reads that reply and decides again.",
      ].join("\n"),
    });
  });

  it("says a timed out review didn't run the command", () => {
    const notice = codexAutoReviewNotice(
      decodeReview({ ...REAL_DENIAL, review: { status: "timedOut" } }),
    );
    assert.equal(notice?.title, "Auto-review timed out on a command");
    assert.isTrue(
      notice?.message.startsWith("Auto-review timed out on a command, so it didn't run."),
    );
  });

  it("stays quiet unless the review stopped the action", () => {
    for (const status of ["approved", "aborted", "inProgress"] as const) {
      assert.isUndefined(
        codexAutoReviewNotice(decodeReview({ ...REAL_DENIAL, review: { status } })),
      );
    }
  });

  it("summarizes actions that aren't commands", () => {
    const review = { status: "denied", rationale: "No." };
    const message = (action: unknown) =>
      codexAutoReviewNotice(decodeReview({ ...REAL_DENIAL, review, action }))?.message ?? "";
    assert.include(
      message({
        type: "execve",
        source: "shell",
        program: "rm",
        argv: ["rm", "-f", "x"],
        cwd: "/w",
      }),
      "Command: rm -f x",
    );
    const input = message({
      type: "writeStdin",
      approvalId: "approval",
      processId: "7",
      stdin: "yes\n",
      cwd: "/w",
    });
    assert.include(input, "Input: yes\nFolder: /w");
    assert.include(input, "approving this exact terminal input");
    assert.include(
      message({ type: "applyPatch", cwd: "/w", files: ["/w/a.ts", "/w/b.ts"] }),
      "Files: /w/a.ts, /w/b.ts",
    );
    assert.include(
      message({
        type: "networkAccess",
        host: "example.com",
        port: 443,
        protocol: "https",
        target: "https://example.com",
      }),
      "Target: https://example.com",
    );
    assert.include(
      message({ type: "mcpToolCall", server: "notion", toolName: "delete_page" }),
      "Tool: notion / delete_page",
    );
    const permissions = message({
      type: "requestPermissions",
      permissions: {},
      reason: "Needs the network",
    });
    assert.include(permissions, "Reason: Needs the network");
    assert.notInclude(permissions, "To try it anyway");
  });
});

describe("reviewed full access in a session", () => {
  const MODEL_SELECTION = {
    instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    model: "gpt-5.4",
  } satisfies ModelSelection;
  const FULL_ACCESS = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: "/workspace",
  });
  const NATIVE_THREAD_ID = "native-thread";
  const NATIVE_TURN_ID = "native-turn";
  const FORK_THREAD_ID = "forked-thread";
  const nativeThread = {
    id: NATIVE_THREAD_ID,
    sessionId: NATIVE_THREAD_ID,
    projectId: null,
    forkedFromId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1782622440,
    updatedAt: 1782622440,
    status: { type: "idle" },
    path: `/tmp/${NATIVE_THREAD_ID}.jsonl`,
    cwd: "/workspace",
    cliVersion: "0.167.0",
    source: "vscode",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
  const nativeTurn = (status: "inProgress" | "completed") => ({
    id: NATIVE_TURN_ID,
    items: [],
    itemsView: "notLoaded",
    status,
    error: null,
    startedAt: 1782622440,
    completedAt: status === "completed" ? 1782622450 : null,
    durationMs: null,
  });
  const review = (reviewId: string, status: string) => ({
    type: "emit_inbound" as const,
    label: `review ${status}`,
    frame: {
      method: "item/autoApprovalReview/completed",
      params: {
        ...REAL_DENIAL,
        threadId: NATIVE_THREAD_ID,
        turnId: NATIVE_TURN_ID,
        reviewId,
        review: { ...REAL_DENIAL.review, status },
      },
    },
  });

  const transcript = (reviewed: boolean): CodexReplay.CodexAppServerReplayTranscript => {
    const threadStartId = reviewed ? 3 : 2;
    const turnStartId = threadStartId + 1;
    return {
      provider: "codex",
      protocol: "codex.app-server",
      version: "0.167.0",
      scenario: `reviewed-full-access-${reviewed}`,
      entries: [
        {
          type: "expect_outbound",
          label: "initialize",
          frame: {
            id: 1,
            method: "initialize",
            params: {
              clientInfo: { name: "T3 Code", title: "T3 Code", version: packageJson.version },
              capabilities: {
                experimentalApi: true,
                optOutNotificationMethods: ["turn/diff/updated"],
                extensions: {
                  "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
                },
              },
            },
          },
        },
        {
          type: "emit_inbound",
          label: "initialize",
          frame: {
            id: 1,
            result: {
              userAgent: "T3 Code/0.156.1",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          },
        },
        { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
        ...(reviewed
          ? ([
              {
                type: "expect_outbound",
                label: "config/read",
                frame: {
                  id: 2,
                  method: "config/read",
                  params: { includeLayers: false, cwd: "/workspace" },
                },
              },
              {
                type: "emit_inbound",
                label: "config/read",
                frame: {
                  id: 2,
                  result: {
                    config: { mcp_servers: { notion: { url: "x" }, "t3-code": { url: "y" } } },
                    origins: {},
                  },
                },
              },
            ] as const)
          : []),
        {
          type: "expect_outbound",
          label: "thread/start",
          frame: {
            id: threadStartId,
            method: "thread/start",
            params: {
              config: {
                ...CodexAdapterV2.CODEX_THREAD_CONFIG,
                ...(reviewed
                  ? {
                      "apps._default.default_tools_approval_mode": "approve",
                      "mcp_servers.notion.default_tools_approval_mode": "approve",
                    }
                  : {}),
              },
            },
          },
        },
        {
          type: "emit_inbound",
          label: "thread/start",
          frame: {
            id: threadStartId,
            result: {
              thread: nativeThread,
              model: "gpt-5.4",
              modelProvider: "openai",
              serviceTier: null,
              cwd: "/workspace",
              instructionSources: [],
              approvalPolicy: "on-request",
              approvalsReviewer: "user",
              sandbox: { type: "dangerFullAccess" },
              reasoningEffort: "medium",
            },
          },
        },
        {
          type: "expect_outbound",
          label: "turn/start",
          frame: {
            id: turnStartId,
            method: "turn/start",
            params: {
              threadId: NATIVE_THREAD_ID,
              input: [{ type: "text", text: "work" }],
              cwd: "/workspace",
              model: "gpt-5.4",
              approvalPolicy: reviewed
                ? CODEX_REVIEWED_FULL_ACCESS_TURN_DEFAULTS.approvalPolicy
                : "never",
              approvalsReviewer: reviewed ? "auto_review" : "user",
              sandboxPolicy: { type: "dangerFullAccess" },
              summary: "detailed",
              collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
            },
          },
        },
        {
          type: "emit_inbound",
          label: "turn/start",
          frame: { id: turnStartId, result: { turn: nativeTurn("inProgress") } },
        },
        {
          type: "emit_inbound",
          label: "turn/started",
          frame: {
            method: "turn/started",
            params: { threadId: NATIVE_THREAD_ID, turn: nativeTurn("inProgress") },
          },
        },
        review("review-approved", "approved"),
        review("review-denied", "denied"),
        review("review-aborted", "aborted"),
        {
          type: "emit_inbound",
          label: "turn/completed",
          frame: {
            method: "turn/completed",
            params: { threadId: NATIVE_THREAD_ID, turn: nativeTurn("completed") },
          },
        },
      ],
    };
  };

  const rejoinEntries = (
    reviewed: boolean,
    method: "thread/resume" | "thread/fork",
    forkResult: unknown,
  ): Array<CodexReplay.CodexAppServerReplayEntry> => {
    const configReadId = reviewed ? 4 : 3;
    const requestId = reviewed ? 5 : 3;
    return [
      ...(reviewed
        ? ([
            {
              type: "expect_outbound",
              label: "config/read",
              frame: {
                id: configReadId,
                method: "config/read",
                params: { includeLayers: false, cwd: "/workspace" },
              },
            },
            {
              type: "emit_inbound",
              label: "config/read",
              frame: {
                id: configReadId,
                result: { config: { mcp_servers: { notion: { url: "x" } } }, origins: {} },
              },
            },
          ] as const)
        : []),
      {
        type: "expect_outbound",
        label: method,
        frame: {
          id: requestId,
          method,
          params: {
            threadId: NATIVE_THREAD_ID,
            ...(method === "thread/resume" ? { excludeTurns: true } : {}),
            config: {
              ...CodexAdapterV2.CODEX_THREAD_CONFIG,
              ...(reviewed ? { "apps._default.default_tools_approval_mode": "approve" } : {}),
            },
          },
        },
      },
      {
        type: "emit_inbound",
        label: method,
        frame: {
          id: requestId,
          result:
            method === "thread/resume"
              ? { thread: { id: NATIVE_THREAD_ID, updatedAt: 1782622450 } }
              : forkResult,
        },
      },
    ];
  };

  // T3's own server adds context to every turn, so that run stops once the thread has started.
  const run = (input: {
    readonly reviewed: boolean;
    readonly t3Server: boolean;
    readonly rejoin?: "resume" | "fork";
  }) =>
    Effect.gen(function* () {
      const { reviewed, t3Server } = input;
      const scripted = transcript(reviewed);
      const threadStartResult = scripted.entries.flatMap((entry) =>
        entry.type === "emit_inbound" && entry.label === "thread/start" ? [entry.frame] : [],
      )[0] as { readonly result: { readonly thread: object } };
      const replay = t3Server
        ? {
            ...scripted,
            entries: [
              ...scripted.entries.slice(
                0,
                scripted.entries.findIndex(
                  (entry) => "label" in entry && entry.label === "turn/start",
                ),
              ),
              ...(input.rejoin === undefined
                ? []
                : rejoinEntries(reviewed, `thread/${input.rejoin}`, {
                    ...threadStartResult.result,
                    thread: {
                      ...threadStartResult.result.thread,
                      id: FORK_THREAD_ID,
                      forkedFromId: NATIVE_THREAD_ID,
                    },
                  })),
            ],
          }
        : scripted;
      const threadId = ThreadId.make(`thread-${replay.scenario}`);
      const providerSessionId = `provider-session-${replay.scenario}`;
      if (t3Server) {
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("environment-reviewed"),
          threadId,
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer secret-codex-token",
          browserToolsAvailable: true,
        });
      }
      // The replay ignores MCP server config, so read what was really sent.
      const threadStarts: Array<unknown> = [];
      const threadResumes: Array<unknown> = [];
      const threadForks: Array<unknown> = [];
      const driver = yield* CodexReplay.makeReplayDriver(replay, {});
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: decodeCodexSettings({
          reviewFlaggedCommandsInFullAccess: reviewed,
        }),
        environment: {},
        clientFactory: {
          open: (openInput) =>
            Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
              Effect.flatMap((context) =>
                Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
              ),
              Effect.map(
                (client) =>
                  ({
                    ...client,
                    raw: {
                      ...client.raw,
                      request: (method, params) =>
                        Effect.sync(() => {
                          if (method === "thread/resume") threadResumes.push(params);
                        }).pipe(Effect.andThen(client.raw.request(method, params))),
                    },
                    request: (method, params) =>
                      Effect.sync(() => {
                        if (method === "thread/start") threadStarts.push(params);
                        if (method === "thread/fork") threadForks.push(params);
                      }).pipe(Effect.andThen(client.request(method, params))),
                  }) satisfies CodexClient.CodexAppServerClient["Service"],
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                    providerSessionId: openInput.providerSessionId,
                    cause,
                  }),
              ),
            ),
        },
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ProviderReplayHarness.makeReplayServerConfig(replay.scenario).pipe(
          Effect.orDie,
        ),
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(providerSessionId),
        modelSelection: MODEL_SELECTION,
        runtimePolicy: FULL_ACCESS,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: MODEL_SELECTION,
        runtimePolicy: FULL_ACCESS,
      });
      if (input.rejoin === "resume") {
        yield* runtime.resumeThread({
          providerThread,
          modelSelection: MODEL_SELECTION,
          runtimePolicy: FULL_ACCESS,
        });
      }
      if (input.rejoin === "fork") {
        yield* runtime.forkThread({
          sourceProviderThread: providerThread,
          targetThreadId: threadId,
          modelSelection: MODEL_SELECTION,
          runtimePolicy: FULL_ACCESS,
        });
      }
      if (t3Server) return { threadStarts, threadResumes, threadForks, notices: [] };
      const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const terminal = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }).pipe(
            Effect.andThen(
              event.type === "turn.terminal" ? Deferred.succeed(terminal, undefined) : Effect.void,
            ),
          ),
        ),
        Effect.forkScoped,
      );
      const now = yield* DateTime.now;
      yield* runtime.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make(`project-${threadId}`),
          title: "Reviewed full access test",
          providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
          modelSelection: MODEL_SELECTION,
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
        runId: RunId.make("run-reviewed"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-reviewed"),
        rootNodeId: NodeId.make("node-reviewed"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-reviewed"),
          text: "work",
          attachments: [],
        },
        modelSelection: MODEL_SELECTION,
        runtimePolicy: FULL_ACCESS,
      });
      yield* Deferred.await(terminal);
      return {
        threadStarts,
        threadResumes,
        threadForks,
        notices: events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
            ? [event.turnItem]
            : [],
        ),
      };
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    );

  it.effect("reviews, exempts connectors and shows only the denial when the setting is on", () =>
    Effect.gen(function* () {
      const { notices, threadStarts } = yield* run({ reviewed: true, t3Server: false });
      assert.deepEqual(threadStarts, [
        {
          cwd: "/workspace",
          model: "gpt-5.4",
          config: {
            ...CodexAdapterV2.CODEX_THREAD_CONFIG,
            "apps._default.default_tools_approval_mode": "approve",
            "mcp_servers.notion.default_tools_approval_mode": "approve",
          },
        },
      ]);
      assert.deepEqual(
        notices.map(({ title, message, status }) => ({ title, status, message })),
        [
          {
            title: "Auto-review blocked a command",
            status: "completed",
            message: codexAutoReviewNotice(decodeReview(REAL_DENIAL))?.message ?? "",
          },
        ],
      );
      assert.equal(notices[0]?.nativeItemRef?.nativeId, "auto-review:review-denied");
    }),
  );

  it.effect("keeps upstream's requests when the setting is off, and still shows a denial", () =>
    Effect.gen(function* () {
      const { notices, threadStarts } = yield* run({ reviewed: false, t3Server: false });
      assert.deepEqual(threadStarts, [
        { cwd: "/workspace", model: "gpt-5.4", config: CodexAdapterV2.CODEX_THREAD_CONFIG },
      ]);
      assert.deepEqual(
        notices.map(({ title }) => title),
        ["Auto-review blocked a command"],
      );
    }),
  );

  it.effect.each([true, false])("exempts T3's own server only when reviewing is %s", (reviewed) =>
    Effect.gen(function* () {
      const { threadStarts } = yield* run({ reviewed, t3Server: true });
      assert.deepEqual(threadStarts, [
        {
          cwd: "/workspace",
          model: "gpt-5.4",
          config: {
            ...CodexAdapterV2.CODEX_THREAD_CONFIG,
            ...(reviewed
              ? {
                  "apps._default.default_tools_approval_mode": "approve",
                  "mcp_servers.notion.default_tools_approval_mode": "approve",
                }
              : {}),
            "mcp_servers.t3-code": {
              url: "http://127.0.0.1:43123/mcp",
              tool_timeout_sec: 3_900,
              http_headers: { Authorization: "Bearer secret-codex-token" },
              ...(reviewed ? { default_tools_approval_mode: "approve" } : {}),
            },
          },
        },
      ]);
    }),
  );

  const rejoinConfig = (reviewed: boolean) => ({
    cwd: "/workspace",
    model: "gpt-5.4",
    config: {
      ...CodexAdapterV2.CODEX_THREAD_CONFIG,
      ...(reviewed
        ? {
            "apps._default.default_tools_approval_mode": "approve",
            "mcp_servers.notion.default_tools_approval_mode": "approve",
          }
        : {}),
      "mcp_servers.t3-code": {
        url: "http://127.0.0.1:43123/mcp",
        tool_timeout_sec: 3_900,
        http_headers: { Authorization: "Bearer secret-codex-token" },
        ...(reviewed ? { default_tools_approval_mode: "approve" } : {}),
      },
    },
  });

  it.effect.each([true, false])(
    "exempts connectors on resume only when reviewing is %s",
    (reviewed) =>
      Effect.gen(function* () {
        const { threadResumes } = yield* run({ reviewed, t3Server: true, rejoin: "resume" });
        assert.deepEqual(threadResumes, [
          { threadId: NATIVE_THREAD_ID, excludeTurns: true, ...rejoinConfig(reviewed) },
        ]);
      }),
  );

  it.effect.each([true, false])(
    "exempts connectors on a native fork only when reviewing is %s",
    (reviewed) =>
      Effect.gen(function* () {
        const { threadForks } = yield* run({ reviewed, t3Server: true, rejoin: "fork" });
        assert.deepEqual(threadForks, [{ threadId: NATIVE_THREAD_ID, ...rejoinConfig(reviewed) }]);
      }),
  );
});
