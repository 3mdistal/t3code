// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// fork: installs a desktop update on macOS the way Alice does, from the sidebar's download and
// restart, and checks the app in Applications is replaced and reopens (see FORK.md). It serves
// the newer build's feed locally and drives the update through the app's own desktop bridge.
//
//   node scripts/fork/smoke-mac-update.ts --app "/Applications/T3 Code (Beta).app" \
//     --feed release-b --expect-version 0.1.6-alice.902 [--expect-unchanged] [--artifacts-dir d]
//
// --expect-unchanged is the control: a build without the fork's installer must stay as it was.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

const STEP_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 180_000;
const CONTROL_WAIT_MS = 60_000;
const POLL_MS = 1_000;
// A build that opens and then crashes on startup must not pass.
const REOPENED_WAIT_MS = 15_000;

const { values } = NodeUtil.parseArgs({
  options: {
    app: { type: "string" },
    feed: { type: "string" },
    "expect-version": { type: "string" },
    "expect-unchanged": { type: "boolean", default: false },
    "artifacts-dir": { type: "string" },
  },
});
const appPath = values.app;
const feedDir = values.feed;
const expectedVersion = values["expect-version"];
if (!appPath || !feedDir || !expectedVersion) {
  throw new Error(
    "Usage: smoke-mac-update.ts --app <bundle> --feed <dir> --expect-version <v> [--expect-unchanged]",
  );
}
const expectUnchanged = values["expect-unchanged"] === true;
const artifactsDir = NodePath.resolve(values["artifacts-dir"] ?? "mac-update-check");

interface UpdateState {
  readonly status: string;
  readonly availableVersion: string | null;
  readonly downloadedVersion: string | null;
  readonly message: string | null;
}

const plistValue = (bundle: string, key: string) =>
  NodeChildProcess.execFileSync("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    NodePath.join(bundle, "Contents", "Info.plist"),
  ])
    .toString()
    .trim();

const runningFrom = (bundle: string) =>
  NodeChildProcess.execFileSync("/bin/ps", ["-axo", "pid=,command="])
    .toString()
    .split("\n")
    .filter((line) => line.includes(`${bundle}/Contents/MacOS/`));

/**
 * Each ad hoc build has its own signature, and the keychain trusts only the build that made the
 * app's Safe Storage key, so another build waits on an access dialog nobody answers here.
 */
function forgetSafeStorageKeys(): void {
  const keychain = NodeChildProcess.execFileSync("/usr/bin/security", ["dump-keychain"], {
    timeout: 30_000,
  }).toString();
  const services = new Set(
    [...keychain.matchAll(/"svce"<blob>="(t3code[^"]* Safe Storage)"/gi)].map((match) => match[1]!),
  );
  for (const service of services) {
    const deleted = NodeChildProcess.spawnSync(
      "/usr/bin/security",
      ["delete-generic-password", "-s", service],
      { timeout: 10_000 },
    );
    console.log(`Keychain item "${service}": ${deleted.status === 0 ? "deleted" : "not deleted"}`);
  }
}

function serveFeed(dir: string): Promise<{ server: NodeHttp.Server; port: number }> {
  const server = NodeHttp.createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const file = NodePath.join(dir, NodePath.basename(name));
    console.log(`feed: ${request.method} ${name}`);
    if (!NodeFS.existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Length": NodeFS.statSync(file).size });
    NodeFS.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

async function waitForState(
  page: Page,
  done: (state: UpdateState) => boolean,
  what: string,
): Promise<UpdateState> {
  let state: UpdateState | undefined;
  for (let waited = 0; waited < STEP_TIMEOUT_MS; waited += POLL_MS) {
    state = (await bridgeCall(page, "getUpdateState")) as UpdateState;
    if (done(state)) return state;
    if (state.status === "error") break;
    await NodeTimersPromises.setTimeout(POLL_MS);
  }
  throw new Error(`The update never ${what}; last state: ${JSON.stringify(state)}`);
}

// Runs in the app's window, where globalThis is the window that holds the preload's bridge.
const bridgeCall = (page: Page, method: string, arg?: string) =>
  page.evaluate(
    ([name, value]) =>
      (
        globalThis as unknown as {
          desktopBridge: Record<string, (value?: string) => Promise<unknown>>;
        }
      ).desktopBridge[name]!(value),
    [method, arg] as const,
  );

/** Resolves true if the app exits within `ms`, false otherwise. */
const exitsWithin = (exited: Promise<void>, ms: number) =>
  Promise.race([exited.then(() => true), NodeTimersPromises.setTimeout(ms, false, { ref: false })]);

const installedVersion = plistValue(appPath, "CFBundleShortVersionString");
const executable = NodePath.join(
  appPath,
  "Contents",
  "MacOS",
  plistValue(appPath, "CFBundleExecutable"),
);
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mac-update-"));
const { server, port } = await serveFeed(NodePath.resolve(feedDir));
let step = "launching the installed app";
let app: ElectronApplication | undefined;
// Playwright drops the process handle once the app exits, and this app quits to install.
let appProcess: NodeChildProcess.ChildProcess | undefined;
try {
  console.log(`Installed ${installedVersion}; offering ${expectedVersion} on port ${port}.`);
  forgetSafeStorageKeys();
  app = await _electron.launch({
    executablePath: executable,
    env: {
      ...process.env,
      T3CODE_HOME: NodePath.join(home, "t3"),
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_DESKTOP_MOCK_UPDATES: "true",
      T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: String(port),
    },
    timeout: STEP_TIMEOUT_MS,
  });
  appProcess = app.process();
  const exited = new Promise<void>((resolve) => appProcess!.once("exit", () => resolve()));
  step = "waiting for the first window";
  const page = await app.firstWindow({ timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(() => "desktopBridge" in globalThis, undefined, {
    timeout: STEP_TIMEOUT_MS,
  });

  step = "checking for the update";
  await waitForState(page, (state) => state.status !== "disabled", "enabled the updater");
  await bridgeCall(page, "checkForUpdate");
  await waitForState(
    page,
    (state) => state.availableVersion === expectedVersion || state.status === "available",
    "became available",
  );
  step = "downloading the update";
  await bridgeCall(page, "downloadUpdate");
  await waitForState(
    page,
    (state) => state.status === "downloaded" && state.downloadedVersion === expectedVersion,
    "finished downloading",
  );

  step = "restarting to install";
  // The app quits partway through this call when the install works, so its reply never comes.
  void bridgeCall(page, "installUpdate", expectedVersion).catch(() => {});

  if (expectUnchanged) {
    step = "watching the control build not install";
    const quit = await exitsWithin(exited, CONTROL_WAIT_MS);
    const version = plistValue(appPath, "CFBundleShortVersionString");
    if (version !== installedVersion) {
      throw new Error(`The control build installed ${version}; expected it to stay unchanged.`);
    }
    const state = quit ? undefined : await bridgeCall(page, "getUpdateState");
    console.log(
      `Control passed: ${installedVersion} stayed installed (app ${quit ? "quit" : "kept running"}). State: ${JSON.stringify(state)}`,
    );
  } else {
    step = "waiting for the app to quit";
    if (!(await exitsWithin(exited, INSTALL_TIMEOUT_MS))) {
      throw new Error("The app never quit to install the update.");
    }
    step = "waiting for the new build in Applications";
    let version = installedVersion;
    let processes: string[] = [];
    for (let waited = 0; waited < INSTALL_TIMEOUT_MS; waited += POLL_MS) {
      // The swap is one step, so a missing app here is a failure, not a moment between moves.
      version = plistValue(appPath, "CFBundleShortVersionString");
      processes = runningFrom(appPath);
      if (version === expectedVersion && processes.length > 0) break;
      await NodeTimersPromises.setTimeout(POLL_MS);
    }
    if (version !== expectedVersion) {
      throw new Error(`Applications still holds ${version}, not ${expectedVersion}.`);
    }
    if (processes.length === 0) throw new Error("The new build never reopened.");
    step = "watching the reopened build keep running";
    const reopened = processes.map((line) => line.trim().split(/\s+/)[0]);
    await NodeTimersPromises.setTimeout(REOPENED_WAIT_MS);
    const survivors = runningFrom(appPath).map((line) => line.trim().split(/\s+/)[0]);
    if (!reopened.some((pid) => survivors.includes(pid))) {
      throw new Error(`The reopened build quit within ${REOPENED_WAIT_MS / 1000} s.`);
    }
    const installLog = NodeFS.readFileSync(
      NodePath.join(home, "t3", "userdata", "logs", "mac-update-install.log"),
      "utf8",
    );
    if (!installLog.includes("swapped the new app into place")) {
      throw new Error("The install log doesn't say the bundles were swapped.");
    }
    NodeChildProcess.execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
    const leftovers = NodeFS.readdirSync(NodePath.dirname(appPath)).filter((entry) =>
      entry.startsWith(`.${NodePath.basename(appPath)}.update-`),
    );
    if (leftovers.length > 0) throw new Error(`Staging folders were left: ${leftovers.join(", ")}`);
    console.log(
      `Update check passed: ${installedVersion} replaced itself with ${expectedVersion} and reopened.`,
    );
  }
} catch (error) {
  console.error(`Mac update check failed while ${step}.`);
  console.error(error instanceof Error ? error.message : error);
  NodeFS.mkdirSync(artifactsDir, { recursive: true });
  const window = app?.windows()[0];
  await window
    ?.screenshot({ path: NodePath.join(artifactsDir, "window.png"), timeout: 10_000 })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) {
    const closed = app.close().catch(() => {});
    await Promise.race([closed, NodeTimersPromises.setTimeout(10_000, undefined, { ref: false })]);
    appProcess?.kill("SIGKILL");
  }
  // The reopened build is not Playwright's to close, and one held by a dialog ignores SIGTERM.
  for (const signal of ["-TERM", "-KILL"]) {
    const pids = runningFrom(appPath).map((line) => line.trim().split(/\s+/)[0]!);
    if (pids.length === 0) break;
    NodeChildProcess.spawnSync("/bin/kill", [signal, ...pids]);
    await NodeTimersPromises.setTimeout(5_000, undefined, { ref: false });
  }
  server.close();
  NodeFS.mkdirSync(artifactsDir, { recursive: true });
  const logs = NodePath.join(home, "t3", "userdata", "logs");
  if (NodeFS.existsSync(logs)) {
    NodeFS.cpSync(logs, NodePath.join(artifactsDir, "logs"), { recursive: true });
  }
  const installLog = NodePath.join(logs, "mac-update-install.log");
  console.log(
    NodeFS.existsSync(installLog)
      ? `\nmac-update-install.log:\n${NodeFS.readFileSync(installLog, "utf8")}`
      : "\nNo mac-update-install.log was written.",
  );
}
