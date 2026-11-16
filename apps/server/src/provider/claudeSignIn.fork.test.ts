import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect, it } from "vite-plus/test";

import { claudeSignInExpiresAt, readClaudeSignInExpiresAt } from "./claudeSignIn.ts";

const END_MS = Date.parse("2026-12-16T09:30:00.000Z");
const login = (claudeAiOauth: Record<string, unknown>) =>
  JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", ...claudeAiOauth } });

describe("claudeSignInExpiresAt", () => {
  it("reads refreshTokenExpiresAt and nothing else", () => {
    expect(claudeSignInExpiresAt(login({ refreshTokenExpiresAt: END_MS }))).toBe(
      "2026-12-16T09:30:00.000Z",
    );
    expect(claudeSignInExpiresAt(login({ expiresAt: END_MS }))).toBeUndefined();
    expect(claudeSignInExpiresAt(login({ refreshTokenExpiresAt: "soon" }))).toBeUndefined();
    expect(claudeSignInExpiresAt(login({ refreshTokenExpiresAt: 0 }))).toBeUndefined();
    expect(claudeSignInExpiresAt("{not json")).toBeUndefined();
    expect(claudeSignInExpiresAt("{}")).toBeUndefined();
  });
});

const writeConfigDir = (contents?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = yield* fs.makeTempDirectoryScoped();
    if (contents !== undefined) {
      yield* fs.writeFileString(path.join(configDir, ".credentials.json"), contents);
    }
    return configDir;
  });

/** Answers every spawn like `security` would, and records what it was asked. */
const securityStub = (exitCode: number, stdout: string) => {
  const calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
    calls.push({ command: command.command, args: command.args });
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { calls, spawner };
};

effectIt.layer(NodeServices.layer)("readClaudeSignInExpiresAt", (it) => {
  it.effect("reads the login file beside Claude's config off macOS", () =>
    Effect.gen(function* () {
      const present = yield* writeConfigDir(login({ refreshTokenExpiresAt: END_MS }));
      const malformed = yield* writeConfigDir("{");
      const missing = yield* writeConfigDir();
      const read = (configDir: string) =>
        readClaudeSignInExpiresAt({ configDir, environment: {} }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
        );
      expect([yield* read(present), yield* read(malformed), yield* read(missing)]).toEqual([
        "2026-12-16T09:30:00.000Z",
        undefined,
        undefined,
      ]);
    }),
  );

  it.effect("asks the Keychain on macOS exactly as Claude Code does", () =>
    Effect.gen(function* () {
      const configDir = yield* writeConfigDir(login({ refreshTokenExpiresAt: 1 }));
      const read = (stub: ReturnType<typeof securityStub>, environment: NodeJS.ProcessEnv) =>
        readClaudeSignInExpiresAt({ configDir, environment }).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(HostProcess.Username, "fallback-user"),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stub.spawner),
        );

      const pooled = securityStub(0, `${login({ refreshTokenExpiresAt: END_MS })}\n`);
      expect(
        yield* read(pooled, { CLAUDE_CONFIG_DIR: "/Users/alice/.claude_emdistal", USER: "alice" }),
      ).toBe("2026-12-16T09:30:00.000Z");
      const defaultHome = securityStub(0, login({ refreshTokenExpiresAt: END_MS }));
      yield* read(defaultHome, { USER: "not a keychain account" });
      expect([...pooled.calls, ...defaultHome.calls]).toEqual([
        {
          command: "/usr/bin/security",
          args: [
            "find-generic-password",
            "-a",
            "alice",
            "-w",
            "-s",
            "Claude Code-credentials-9c0bdf73",
          ],
        },
        {
          command: "/usr/bin/security",
          args: [
            "find-generic-password",
            "-a",
            "claude-code-user",
            "-w",
            "-s",
            "Claude Code-credentials",
          ],
        },
      ]);

      // Claude Code falls back to the file only when the Keychain has no item.
      expect(yield* read(securityStub(44, ""), {})).toBe("1970-01-01T00:00:00.001Z");
      expect(yield* read(securityStub(36, ""), {})).toBeUndefined();
      expect(yield* read(securityStub(0, "not json"), {})).toBeUndefined();
    }),
  );
});
