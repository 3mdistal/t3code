import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const settings = Schema.decodeSync(ClaudeSettings)({});

const versionOnly = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode("2.1.308\n")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  ),
);

const statusWith = (
  tokenSource: string | undefined,
  expiresAt: string | undefined,
  apiProvider = "firstParty",
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    return yield* checkClaudeProviderStatus(
      settings,
      () =>
        Effect.succeed({
          email: "alice@example.com",
          subscriptionType: "max",
          tokenSource,
          apiKeySource: undefined,
          apiProvider,
          slashCommands: [],
        }),
      { ANTHROPIC_BASE_URL: "" },
      undefined,
      undefined,
      undefined,
      undefined,
      () => Effect.succeed(expiresAt),
    );
  }).pipe(Effect.provide(versionOnly));

it.layer(NodeServices.layer)("checkClaudeProviderStatus sign-in end", (it) => {
  describe("a stored claude.ai login", () => {
    it.effect.each([undefined, "claude.ai"])(
      "publishes when the sign-in ends (%s)",
      (tokenSource) =>
        Effect.gen(function* () {
          const status = yield* statusWith(tokenSource, "2026-12-16T09:30:00.000Z");
          assert.strictEqual(status.status, "ready");
          assert.deepInclude(status.auth, {
            status: "authenticated",
            email: "alice@example.com",
            expiresAt: "2026-12-16T09:30:00.000Z",
          });
        }),
    );

    it.effect("needs signing in once the sign-in has ended", () =>
      Effect.gen(function* () {
        const status = yield* statusWith(undefined, "2026-11-16T11:59:00.000Z");
        assert.strictEqual(status.status, "error");
        assert.deepStrictEqual(status.auth, {
          status: "unauthenticated",
          expiresAt: "2026-11-16T11:59:00.000Z",
        });
      }),
    );
  });

  it.effect.each([
    ["CLAUDE_CODE_OAUTH_TOKEN", "firstParty"],
    [undefined, "bedrock"],
  ] as const)(
    "ignores the stored login when Claude authenticates another way (%s, %s)",
    ([tokenSource, apiProvider]) =>
      Effect.gen(function* () {
        const status = yield* statusWith(tokenSource, "2026-11-16T11:59:00.000Z", apiProvider);
        assert.strictEqual(status.auth.status, "authenticated");
        assert.isUndefined(status.auth.expiresAt);
      }),
  );
});
