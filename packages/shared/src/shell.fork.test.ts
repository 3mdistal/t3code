// @effect-diagnostics nodeBuiltinImport:off - The test fakes the file pool's answers.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { CommandResolutionCache, resolveSpawnCommand, SpawnExecutableResolution } from "./shell.ts";

const GIT = "C:\\Program Files\\Git";
const NPM = "C:\\Users\\tester\\AppData\\Roaming\\npm";
const OPENCODE = `${NPM}\\node_modules\\opencode-ai\\bin\\opencode.exe`;
const NPM_OPENCODE_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
  "",
].join("\r\n");

// Only the file pool's calls answer for these, so a check on the event loop misses them.
const files = new Map([
  [`${GIT}\\clangarm64\\bin\\git.exe`, ""],
  [`${NPM}\\opencode.cmd`, NPM_OPENCODE_SHIM],
  [OPENCODE, ""],
]);
const FILE_STATS = { isFile: () => true } as NodeFS.Stats;

const spawn = (command: string, found: string, bypassNpmShim = false) =>
  resolveSpawnCommand(command, ["--version"], {
    env: { PATH: "", PATHEXT: ".EXE;.CMD" },
    bypassNpmShim,
  }).pipe(
    Effect.provideService(HostProcess.Platform, "win32"),
    Effect.provideService(CommandResolutionCache, new Map()),
    Effect.provideService(SpawnExecutableResolution, () => found),
  );

describe("the lookup before a Windows spawn", () => {
  it.effect("checks for Git for Windows' own git.exe and reads an npm shim off the event loop", () =>
    Effect.gen(function* () {
      using _stat = vi.spyOn(NodeFS.promises, "stat").mockImplementation(async (candidate) => {
        if (!files.has(String(candidate))) throw new Error("not found");
        return FILE_STATS;
      });
      using _readFile = vi
        .spyOn(NodeFS.promises, "readFile")
        .mockImplementation(async (candidate) => {
          const contents = files.get(String(candidate));
          if (contents === undefined) throw new Error("not found");
          return contents;
        });

      assert.equal(
        (yield* spawn("git", `${GIT}\\cmd\\git.exe`)).command,
        `${GIT}\\clangarm64\\bin\\git.exe`,
      );
      assert.deepStrictEqual(yield* spawn("opencode", `${NPM}\\opencode.cmd`, true), {
        command: OPENCODE,
        args: ["--version"],
        shell: false,
      });
    }),
  );
});
