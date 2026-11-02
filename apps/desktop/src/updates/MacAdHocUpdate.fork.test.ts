// @effect-diagnostics nodeBuiltinImport:off -- These tests run the install script against real temporary folders.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  appBundleOf,
  isAdHocSignature,
  rememberDownloadedUpdate,
  spawnInstallScript,
} from "./MacAdHocUpdate.ts";

// fork: an ad hoc-signed Mac build swaps its own bundle, since Squirrel.Mac refuses it (FORK.md).
describe("fork ad hoc Mac update", () => {
  it("recognizes code Squirrel.Mac can't update", () => {
    expect(
      isAdHocSignature(
        [
          "Executable=/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)",
          "Identifier=com.t3tools.t3code",
          "Signature=adhoc",
          "TeamIdentifier=not set",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(isAdHocSignature("/Applications/X.app: code object is not signed at all")).toBe(true);
    expect(
      isAdHocSignature(
        [
          "Identifier=com.t3tools.t3code",
          "Authority=Developer ID Application: T3 Tools Inc (ABCDE12345)",
          "TeamIdentifier=ABCDE12345",
        ].join("\n"),
      ),
    ).toBe(false);
  });

  it("finds the bundle that holds the executable", () => {
    expect(appBundleOf("/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)")).toBe(
      "/Applications/T3 Code (Beta).app",
    );
    expect(appBundleOf("/usr/local/bin/node")).toBeNull();
    expect(appBundleOf("/Applications/Tool/Contents/MacOS/Tool")).toBeNull();
  });

  it("ignores update events without a zip", () => {
    expect(() => rememberDownloadedUpdate(null)).not.toThrow();
    expect(() => rememberDownloadedUpdate({ version: "0.1.6-alice.4" })).not.toThrow();
  });
});

const describePosix = describe.skipIf(HostProcess.Platform.defaultValue() === "win32");

function makeApp(path: string, contents: string): void {
  NodeFS.mkdirSync(path, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(path, "build"), contents);
}

function exited(child: NodeChildProcess.ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
}

async function withApps(
  run: (paths: { target: string; staging: string; staged: string; log: string }) => Promise<void>,
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mac-update-"));
  try {
    const target = NodePath.join(root, "T3 Code (Beta).app");
    const staging = NodePath.join(root, ".T3 Code (Beta).app.update-test");
    const staged = NodePath.join(staging, "T3 Code (Beta).app");
    makeApp(target, "old");
    makeApp(staged, "new");
    await run({ target, staging, staged, log: NodePath.join(root, "install.log") });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

const buildOf = (app: string) => NodeFS.readFileSync(NodePath.join(app, "build"), "utf8");

describePosix("fork ad hoc Mac install script", () => {
  it("waits for the app to quit, then swaps the bundles", async () => {
    await withApps(async ({ target, staging, staged, log }) => {
      const app = NodeChildProcess.spawn("sleep", ["0.5"]);
      const script = spawnInstallScript({
        pid: app.pid ?? 0,
        target,
        staged,
        staging,
        relaunch: false,
        logFile: log,
      });
      expect(await exited(script)).toBe(0);
      expect(app.exitCode).toBe(0);
      expect(buildOf(target)).toBe("new");
      expect(NodeFS.existsSync(staging)).toBe(false);
      // macOS exchanges the bundles in one step; elsewhere the script falls back to two moves.
      expect(NodeFS.readFileSync(log, "utf8")).toMatch(/(swapped|moved) the new app into place/);
    });
  });

  it("leaves the app as it was when it doesn't quit in time", async () => {
    await withApps(async ({ target, staging, staged, log }) => {
      const app = NodeChildProcess.spawn("sleep", ["30"]);
      try {
        const script = spawnInstallScript({
          pid: app.pid ?? 0,
          target,
          staged,
          staging,
          relaunch: false,
          logFile: log,
          waitTenths: 2,
        });
        expect(await exited(script)).toBe(1);
        expect(buildOf(target)).toBe("old");
        expect(NodeFS.existsSync(staging)).toBe(false);
        expect(NodeFS.readFileSync(log, "utf8")).toContain("did not quit");
      } finally {
        app.kill();
      }
    });
  });

  it("restores the old app when the new one can't move in", async () => {
    await withApps(async ({ target, staging, log }) => {
      const app = NodeChildProcess.spawn("true");
      await exited(app);
      const script = spawnInstallScript({
        pid: app.pid ?? 0,
        target,
        staged: NodePath.join(staging, "missing.app"),
        staging,
        relaunch: false,
        logFile: log,
      });
      expect(await exited(script)).toBe(1);
      expect(buildOf(target)).toBe("old");
      expect(NodeFS.existsSync(staging)).toBe(false);
    });
  });
});
