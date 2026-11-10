import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  layer,
  ProviderStartFailureHook,
  START_FAILURE_LOG_FILE,
  startFailureRecord,
  startFailureRetryable,
  type ProviderStartFailure,
} from "./ProviderStartRetry.ts";
import { makeReplayServerConfig } from "./testkit/ProviderReplayHarness.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const threadId = ThreadId.make("thread:start-retry");
const runId = RunId.make("run:start-retry");

const turnStartError = (cause: unknown) =>
  new ProviderAdapter.ProviderAdapterTurnStartError({
    driver: claude,
    threadId,
    providerThreadId: ProviderThreadId.make("provider-thread:start-retry"),
    runId,
    cause,
  });

const failure = (overrides: Partial<ProviderStartFailure> = {}): ProviderStartFailure => ({
  threadId,
  runId,
  attemptId: RunAttemptId.make("attempt:start-retry:1"),
  attemptReason: "initial",
  driver: claude,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus",
  elapsedMs: 90_012,
  cause: Cause.fail(
    turnStartError({
      _tag: "ClaudeMcpRegistrationTimeoutError",
      message: "Claude Code did not answer the MCP server registration.",
    }),
  ),
  providerTurnReported: false,
  continuation: false,
  compact: false,
  ...overrides,
});

describe("startFailureRetryable", () => {
  it("retries a Claude turn whose start failed before the prompt was sent", () => {
    assert.isTrue(startFailureRetryable(failure()));
    assert.isTrue(startFailureRetryable(failure({ cause: Cause.fail(turnStartError("exit 1")) })));
  });

  it("leaves every other failure to fail the run", () => {
    const cases: ReadonlyArray<[string, Partial<ProviderStartFailure>]> = [
      ["another driver", { driver: ProviderDriverKind.make("codex") }],
      ["the retry itself", { attemptReason: "retry" }],
      ["a turn Claude already reported", { providerTurnReported: true }],
      ["a provider wake", { continuation: true }],
      ["a compaction", { compact: true }],
      ["a stop", { cause: Cause.interrupt() }],
      ["a defect", { cause: Cause.die(new Error("bug")) }],
      ["an ownership read", { cause: Cause.fail({ _tag: "ProjectionStoreV2Error" }) }],
      [
        "a launch argument Claude rejects every time",
        { cause: Cause.fail(turnStartError({ _tag: "ClaudeSettingsLaunchArgError" })) },
      ],
      [
        "background work that blocks a new query",
        {
          cause: Cause.fail(
            turnStartError({ _tag: "ClaudeBackgroundWorkBlocksQueryReplacementError" }),
          ),
        },
      ],
      [
        "a turn still active",
        {
          cause: Cause.fail(
            turnStartError(
              new ProviderAdapter.ProviderAdapterProtocolError({
                driver: claude,
                detail: "Claude provider turn is still active.",
                reason: "previous_turn_active",
              }),
            ),
          ),
        },
      ],
    ];
    for (const [name, overrides] of cases) {
      assert.isFalse(startFailureRetryable(failure(overrides)), name);
    }
  });
});

describe("startFailureRecord", () => {
  it("names the error chain and redacts provider text", () => {
    const record = startFailureRecord(
      failure({
        cause: Cause.fail(
          turnStartError(
            new Error("spawn failed: Authorization: Bearer abc123 key sk-abcdefghijklmnop1234"),
          ),
        ),
      }),
      { at: "2026-11-10T17:00:00.000Z", retried: true },
    );
    assert.equal(record.error, "ProviderAdapterTurnStartError > Error");
    assert.equal(record.elapsedMs, 90_012);
    assert.isTrue(record.retried);
    assert.include(record.detail, "spawn failed");
    assert.notInclude(record.detail, "abc123");
    assert.notInclude(record.detail, "sk-abcdefghijklmnop1234");
  });

  it("caps a long detail", () => {
    const record = startFailureRecord(
      failure({ cause: Cause.fail(turnStartError("x".repeat(20_000))) }),
      { at: "2026-11-10T17:00:00.000Z", retried: false },
    );
    assert.equal(record.detail.length, 8_000);
    assert.isTrue(record.detail.endsWith("…"));
  });
});

describe("ProviderStartFailureHook", () => {
  it.effect("dispatches one retry for a retryable failure and logs every failure", () =>
    Effect.gen(function* () {
      const config = yield* makeReplayServerConfig("start-retry-log");
      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      const orchestrator = Layer.mock(Orchestrator.OrchestratorV2)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 1, storedEvents: [{} as OrchestrationV2StoredEvent] };
          }),
      });
      yield* Effect.gen(function* () {
        const hook = yield* ProviderStartFailureHook;
        yield* hook.onStartFailure(failure());
        yield* hook.onStartFailure(
          failure({
            attemptId: RunAttemptId.make("attempt:start-retry:2"),
            attemptReason: "retry",
          }),
        );
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                orchestrator,
                Layer.succeed(ServerConfig.ServerConfig, config),
                NodeServices.layer,
              ),
            ),
          ),
        ),
      );

      assert.deepEqual(
        dispatched.map((command) => command.type),
        ["run.start-retry"],
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lines = (yield* fs.readFileString(path.join(config.logsDir, START_FAILURE_LOG_FILE)))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as ReturnType<typeof startFailureRecord>);
      assert.deepEqual(
        lines.map((line) => [line.attemptReason, line.retried, line.error]),
        [
          ["initial", true, "ProviderAdapterTurnStartError > ClaudeMcpRegistrationTimeoutError"],
          ["retry", false, "ProviderAdapterTurnStartError > ClaudeMcpRegistrationTimeoutError"],
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
