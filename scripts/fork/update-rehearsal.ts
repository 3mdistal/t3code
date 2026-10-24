// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - a one-off driver on a disposable runner.
// fork: drives .github/workflows/fork-update-rehearsal.yml on a Windows runner.
// It installs the first build, then updates the installed app to each later
// build through the app's own updater (check, download, install), and checks
// the version the reinstalled app reports. The mock feed serves each build
// from mock-update-server; the GitHub feed publishes each as this repository's
// latest release and deletes them all afterwards, then updates to the release
// that was latest before, so the real published installer is exercised too.
//
//   node scripts/fork/update-rehearsal.ts <mock|github> <build dir>...
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers/promises";

import type { DesktopUpdateState, DesktopUpdateStatus } from "../../packages/contracts/src/ipc.ts";

const require = NodeModule.createRequire(
  new URL("../../apps/desktop/package.json", import.meta.url),
);
const { _electron } = require("playwright-core") as typeof import("playwright-core");

const MOCK_PORT = "3000";
const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
const scratch = process.env.RUNNER_TEMP ?? NodePath.join(repoRoot, ".rehearsal");
const home = NodePath.join(scratch, "t3-rehearsal-home");
const repository = process.env.GITHUB_REPOSITORY ?? "3mdistal/t3code";

interface Build {
  readonly dir: string;
  readonly version: string;
  readonly installer: string;
}

function readBuild(dir: string): Build {
  const installer = NodeFS.readdirSync(dir).find((file) => /^T3-Code-.+-x64\.exe$/.test(file));
  if (installer === undefined) throw new Error(`${dir} has no Windows installer`);
  return {
    dir,
    version: /^T3-Code-(.+)-x64\.exe$/.exec(installer)![1]!,
    installer: NodePath.join(dir, installer),
  };
}

/** Puts a build's installer, blockmap, and update manifest, under the name the updater asks for, in `feed`. */
function stageFeed(build: Build, feed: string): Array<string> {
  NodeFS.mkdirSync(feed, { recursive: true });
  for (const file of NodeFS.readdirSync(feed)) NodeFS.rmSync(NodePath.join(feed, file));
  for (const file of NodeFS.readdirSync(build.dir)) {
    if (file.endsWith(".exe") || file.endsWith(".blockmap")) {
      NodeFS.copyFileSync(NodePath.join(build.dir, file), NodePath.join(feed, file));
    } else if (file === "latest-win-x64.yml") {
      NodeFS.copyFileSync(NodePath.join(build.dir, file), NodePath.join(feed, "latest.yml"));
    }
  }
  if (!NodeFS.existsSync(NodePath.join(feed, "latest.yml"))) {
    throw new Error(`${build.dir} has no latest-win-x64.yml`);
  }
  return NodeFS.readdirSync(feed).map((file) => NodePath.join(feed, file));
}

function log(message: string): void {
  console.log(`[rehearsal ${new Date().toISOString()}] ${message}`);
}

function sh(file: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync(file, args, { encoding: "utf8" }).trim();
}

async function waitFor<T>(
  what: string,
  timeoutMs: number,
  check: () => Promise<T | undefined> | T | undefined,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    }
    await NodeTimers.setTimeout(2_000);
  }
}

function compareVersions(left: string, right: string): number {
  const parts = (version: string) => version.split(/[.-]/).map((part) => Number(part) || 0);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

interface UninstallEntry {
  readonly DisplayVersion: string;
  readonly UninstallString: string;
}

/** The installer's uninstall entry, which it writes last. */
function uninstallEntry(): UninstallEntry | undefined {
  const out = sh("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -like 'T3 Code*' } | Select-Object -First 1 DisplayVersion, UninstallString | ConvertTo-Json -Compress",
  ]);
  return out.length === 0 ? undefined : (JSON.parse(out) as UninstallEntry);
}

function registeredVersion(): string | undefined {
  return uninstallEntry()?.DisplayVersion;
}

function installedApp(): string {
  const entry = uninstallEntry();
  // electron-builder leaves InstallLocation empty; the uninstaller sits beside the app.
  const uninstaller = /^"([^"]+)"/.exec(entry?.UninstallString ?? "")?.[1];
  if (uninstaller === undefined) throw new Error(`T3 Code isn't installed: ${JSON.stringify(entry)}`);
  const installDir = NodePath.dirname(uninstaller);
  const exe = NodeFS.readdirSync(installDir).find(
    (file) => /^T3 Code.*\.exe$/.test(file) && !file.startsWith("Uninstall"),
  );
  if (exe === undefined) throw new Error(`No T3 Code executable in ${installDir}`);
  return NodePath.join(installDir, exe);
}

function appIsRunning(image: string): boolean {
  return sh("tasklist.exe", ["/FI", `IMAGENAME eq ${image}`, "/NH"]).includes(image);
}

/**
 * The installer relaunches the app after an update, and that instance holds the
 * single-instance lock the next launch needs. This runner is disposable, so
 * stopping it by image name is safe here.
 */
async function stopRelaunchedApp(): Promise<void> {
  const image = NodePath.basename(installedApp());
  await waitFor("the relaunched app", 60_000, () => (appIsRunning(image) ? true : undefined)).catch(
    () => log("The app did not relaunch after installing."),
  );
  await waitFor(`${image} to exit`, 60_000, () => {
    if (!appIsRunning(image)) return true;
    NodeChildProcess.spawnSync("taskkill.exe", ["/IM", image, "/T", "/F"]);
    return undefined;
  });
}

async function install(build: Build): Promise<void> {
  log(`Installing ${build.version}.`);
  sh(build.installer, ["/S"]);
  await waitFor(`${build.version} to install`, 120_000, () =>
    registeredVersion() === build.version ? true : undefined,
  );
}

async function launch(env: Record<string, string>) {
  const app = await _electron.launch({
    executablePath: installedApp(),
    env: { ...process.env, T3CODE_HOME: home, ...env } as Record<string, string>,
    timeout: 120_000,
  });
  const page = await waitFor("a window with the desktop bridge", 120_000, async () => {
    for (const candidate of app.windows()) {
      const ready = await candidate.evaluate(() => "desktopBridge" in window).catch(() => false);
      if (ready) return candidate;
    }
    return undefined;
  });
  type Bridge = Record<string, () => Promise<unknown>>;
  const call = (method: "getUpdateState" | "checkForUpdate" | "downloadUpdate" | "installUpdate") =>
    page.evaluate(
      (name) => (window as unknown as { desktopBridge: Bridge }).desktopBridge[name]!(),
      method,
    );
  const state = () => call("getUpdateState") as Promise<DesktopUpdateState>;
  /** The state once the updater has moved past every status in `through`. */
  const settled = (what: string, timeoutMs: number, through: ReadonlyArray<DesktopUpdateStatus>) =>
    waitFor(what, timeoutMs, async () => {
      const current = await state();
      return through.includes(current.status) ? undefined : current;
    });
  return { app, call, state, settled };
}

async function update(from: string, to: string, env: Record<string, string>): Promise<void> {
  log(`Updating ${from} to ${to}.`);
  const { app, call, state, settled } = await launch(env);
  try {
    NodeAssert.equal(await app.evaluate(({ app }) => app.getVersion()), from);
    NodeAssert.equal((await state()).notAppliedVersion, undefined, "the last update didn't apply");
    await call("checkForUpdate");
    const offered = await settled(`the check to offer ${to}`, 120_000, ["idle", "checking"]);
    NodeAssert.equal(offered.status, "available", JSON.stringify(offered));
    NodeAssert.equal(offered.availableVersion, to);
    await call("downloadUpdate");
    const downloaded = await settled(`${to} to download`, 600_000, ["available", "downloading"]);
    NodeAssert.equal(downloaded.status, "downloaded", JSON.stringify(downloaded));
    NodeAssert.equal(downloaded.downloadedVersion, to);
    log(`Downloaded ${to}; installing it.`);
    const closed = app.waitForEvent("close", { timeout: 120_000 });
    // The app quits while it answers, so the call itself may fail.
    await call("installUpdate").catch(() => undefined);
    await closed;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
  await waitFor(`${to} to install`, 300_000, () => (registeredVersion() === to ? true : undefined));
  await stopRelaunchedApp();
  log(`Installed ${to}.`);
}

/** The updater on `version` offers nothing, so it never moves an install backwards. */
async function expectUpToDate(version: string, env: Record<string, string>): Promise<void> {
  const { app, call, settled } = await launch(env);
  try {
    NodeAssert.equal(await app.evaluate(({ app }) => app.getVersion()), version);
    await call("checkForUpdate");
    const checked = await settled("the check to finish", 120_000, ["idle", "checking"]);
    NodeAssert.equal(checked.status, "up-to-date", JSON.stringify(checked));
    log(`${version} sees no update.`);
  } finally {
    await app.close().catch(() => undefined);
  }
}

async function rehearseMock(builds: ReadonlyArray<Build>): Promise<void> {
  const feed = NodePath.join(scratch, "mock-feed");
  stageFeed(builds[1]!, feed);
  const server = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(repoRoot, "scripts/mock-update-server.ts")],
    {
      env: {
        ...process.env,
        T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: MOCK_PORT,
        T3CODE_DESKTOP_MOCK_UPDATE_SERVER_ROOT: feed,
      },
      stdio: "inherit",
    },
  );
  try {
    await waitFor("mock-update-server", 60_000, () =>
      fetch(`http://localhost:${MOCK_PORT}/latest.yml`).then(
        (response) => (response.ok ? true : undefined),
        () => undefined,
      ),
    );
    const env = {
      T3CODE_DESKTOP_MOCK_UPDATES: "true",
      T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: MOCK_PORT,
    };
    await install(builds[0]!);
    for (let index = 1; index < builds.length; index++) {
      stageFeed(builds[index]!, feed);
      await update(builds[index - 1]!.version, builds[index]!.version, env);
    }
    // An older build in the feed is never offered.
    stageFeed(builds[1]!, feed);
    await expectUpToDate(builds.at(-1)!.version, env);
  } finally {
    server.kill();
  }
}

function latestTag(): string {
  return sh("gh", ["api", `repos/${repository}/releases/latest`, "--jq", ".tag_name"]);
}

/**
 * The updater asks github.com's releases/latest for JSON, then fetches that
 * tag's latest.yml. Both lag the API by a while after releases change, so this
 * waits until the same two requests answer for `tag`, three times running.
 */
async function waitForLatestRedirect(tag: string): Promise<void> {
  const answers = async () => {
    const latest = await fetch(`https://github.com/${repository}/releases/latest`, {
      headers: { accept: "application/json" },
    });
    if (!latest.ok || ((await latest.json()) as { tag_name?: string }).tag_name !== tag) {
      return false;
    }
    const manifest = await fetch(
      `https://github.com/${repository}/releases/download/${tag}/latest.yml`,
    );
    return manifest.ok;
  };
  let streak = 0;
  await waitFor(`releases/latest to name ${tag}`, 600_000, async () => {
    streak = (await answers().catch(() => false)) ? streak + 1 : 0;
    return streak >= 3 ? true : undefined;
  });
}

async function rehearseGitHub(builds: ReadonlyArray<Build>): Promise<void> {
  const latestBefore = latestTag();
  NodeAssert.match(latestBefore, /^v\d+\.\d+\.\d+-alice\.\d+$/);
  for (const build of builds) {
    NodeAssert.ok(
      compareVersions(build.version, latestBefore.slice(1)) < 0,
      `${build.version} must be lower than ${latestBefore}, so no real install is offered it`,
    );
  }
  const published: Array<string> = [];
  const feed = NodePath.join(scratch, "github-feed");
  try {
    await install(builds[0]!);
    for (let index = 1; index < builds.length; index++) {
      const build = builds[index]!;
      const tag = `v${build.version}`;
      log(`Publishing ${tag} as the latest release.`);
      published.push(tag);
      sh("gh", [
        "release",
        "create",
        tag,
        ...stageFeed(build, feed),
        "--repo",
        repository,
        "--target",
        process.env.GITHUB_SHA ?? "HEAD",
        "--title",
        `Update rehearsal ${build.version}`,
        "--notes",
        "A test release from .github/workflows/fork-update-rehearsal.yml. The rehearsal deletes it when it ends.",
        "--latest",
      ]);
      await waitForLatestRedirect(tag);
      await update(builds[index - 1]!.version, build.version, {});
    }
  } finally {
    for (const tag of published.toReversed()) {
      log(`Deleting ${tag}.`);
      const deleted = NodeChildProcess.spawnSync(
        "gh",
        ["release", "delete", tag, "--repo", repository, "--cleanup-tag", "--yes"],
        { encoding: "utf8" },
      );
      if (deleted.status !== 0) log(`Couldn't delete ${tag}: ${deleted.stderr.trim()}`);
    }
    sh("gh", ["release", "edit", latestBefore, "--repo", repository, "--latest"]);
    log(`${latestBefore} is the latest release again.`);
  }
  NodeAssert.equal(latestTag(), latestBefore);
  await waitForLatestRedirect(latestBefore);
  await update(builds.at(-1)!.version, latestBefore.slice(1), {});
  await expectUpToDate(latestBefore.slice(1), {});
}

const [feed, ...dirs] = process.argv.slice(2);
const builds = dirs.map(readBuild);
if ((feed !== "mock" && feed !== "github") || builds.length < 2) {
  console.error("Usage: node scripts/fork/update-rehearsal.ts <mock|github> <build dir>...");
  process.exit(2);
}
NodeFS.mkdirSync(home, { recursive: true });
log(`Rehearsing ${builds.map((build) => build.version).join(" -> ")} through the ${feed} feed.`);
await (feed === "mock" ? rehearseMock(builds) : rehearseGitHub(builds));
log("Every update installed, and each app reported its new version.");
