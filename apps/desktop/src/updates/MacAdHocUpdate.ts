// @effect-diagnostics nodeBuiltinImport:off -- This macOS platform boundary runs codesign, ditto and a detached install script with Node.
/**
 * fork: Squirrel.Mac only installs a build that meets the running app's designated requirement,
 * which for an ad hoc signature is that one build's hash. So these builds unpack the update beside
 * the app, and a detached script swaps the bundles once the app quits (FORK.md).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import * as HostProcess from "@t3tools/shared/HostProcess";

const COMMAND_TIMEOUT_MS = 120_000;
// The app gets two minutes to shut down before the script gives up and leaves it as it was.
const QUIT_WAIT_TENTHS = 1_200;
const INSTALL_LOG_NAME = "mac-update-install.log";
const QUARANTINE = "com.apple.quarantine";

interface DownloadedUpdate {
  readonly file: string;
  readonly version: string;
}

let downloadedUpdate: DownloadedUpdate | null = null;

/** Keeps the zip electron-updater reports in its `update-downloaded` event. */
export function rememberDownloadedUpdate(event: unknown): void {
  if (typeof event !== "object" || event === null) return;
  const { downloadedFile, version } = event as {
    readonly downloadedFile?: unknown;
    readonly version?: unknown;
  };
  if (typeof downloadedFile !== "string" || typeof version !== "string") return;
  if (!/\.zip$/i.test(downloadedFile)) return;
  downloadedUpdate = { file: downloadedFile, version };
}

/** `codesign -dv` details for code that Squirrel.Mac can never update. */
export function isAdHocSignature(codesignDetails: string): boolean {
  return (
    /^Signature=adhoc$/m.test(codesignDetails) ||
    codesignDetails.includes("code object is not signed at all")
  );
}

/** The `.app` bundle that holds a macOS executable (`X.app/Contents/MacOS/X`), if any. */
export function appBundleOf(executablePath: string): string | null {
  const macOSDir = NodePath.posix.dirname(executablePath);
  const contentsDir = NodePath.posix.dirname(macOSDir);
  const bundle = NodePath.posix.dirname(contentsDir);
  if (NodePath.posix.basename(macOSDir) !== "MacOS") return null;
  if (NodePath.posix.basename(contentsDir) !== "Contents") return null;
  return bundle.endsWith(".app") ? bundle : null;
}

/**
 * Args: pid, installed bundle, staged bundle, staging folder, "1" to reopen, tenths to wait for quit.
 * renamex_np's RENAME_SWAP (through osascript's ObjC bridge) exchanges the bundles in one step, so
 * the installed path is never empty; without it, two moves run with stopping signals ignored.
 */
const INSTALL_SCRIPT = `
pid=$1 target=$2 staged=$3 staging=$4 relaunch=$5 wait_tenths=$6
log() { printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
swap() {
  /usr/bin/osascript -l JavaScript -e 'function run(argv) {
    ObjC.bindFunction("renamex_np", ["int", ["char *", "char *", "unsigned int"]]);
    return $.renamex_np(argv[0], argv[1], 2) === 0 ? "swapped" : "failed";
  }' "$1" "$2" 2>/dev/null
}
log "waiting for $pid to quit before installing $staged"
waited=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$waited" -ge "$wait_tenths" ]; then
    log "the app did not quit; leaving it as it was"
    rm -rf "$staging"
    exit 1
  fi
  sleep 0.1
  waited=$((waited + 1))
done
trap '' HUP INT TERM
if [ "$(swap "$staged" "$target")" = swapped ]; then
  log "swapped the new app into place"
else
  previous="$staging/previous.app"
  if ! mv "$target" "$previous"; then
    log "could not move the installed app aside; leaving it as it was"
    rm -rf "$staging"
    exit 1
  fi
  if ! mv "$staged" "$target"; then
    log "could not move the new app into place; restoring the old one"
    if mv "$previous" "$target"; then
      rm -rf "$staging"
    else
      log "could not restore the old app; it is at $previous"
    fi
    exit 1
  fi
  log "moved the new app into place"
fi
rm -rf "$staging"
log "installed $target"
if [ "$relaunch" = 1 ]; then
  open "$target" || log "could not reopen $target"
fi
exit 0
`;

interface CommandResult {
  readonly code: number;
  readonly output: string;
}

/** Resolves with the command's exit code and output; rejects if it can't start or times out. */
function exec(command: string, args: ReadonlyArray<string>): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        if (error === null) resolve({ code: 0, output });
        else if (typeof error.code === "number" && !error.killed) {
          resolve({ code: error.code, output });
        } else reject(new Error(`${command} ${args.join(" ")} failed: ${error.message}`));
      },
    );
  });
}

async function run(command: string, args: ReadonlyArray<string>): Promise<string> {
  const { code, output } = await exec(command, args);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${code}: ${output.trim()}`);
  return output;
}

async function isAdHocSigned(bundle: string): Promise<boolean> {
  // codesign writes its details to stderr, and exits 1 for code that isn't signed at all.
  const { code, output } = await exec("/usr/bin/codesign", ["-dv", bundle]);
  if (code !== 0 && !isAdHocSignature(output)) {
    throw new Error(`codesign -dv ${bundle} exited ${code}: ${output.trim()}`);
  }
  return isAdHocSignature(output);
}

function readPlistString(bundle: string, key: string): Promise<string> {
  return run("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    NodePath.posix.join(bundle, "Contents", "Info.plist"),
  ]).then((value) => value.trim());
}

/** Unpacks the update beside the installed bundle and checks it is whole and the expected build. */
async function stageUpdate(bundle: string, update: DownloadedUpdate) {
  const staging = await NodeFSP.mkdtemp(
    NodePath.posix.join(
      NodePath.posix.dirname(bundle),
      `.${NodePath.posix.basename(bundle)}.update-`,
    ),
  );
  try {
    await run("/usr/bin/ditto", ["-x", "-k", update.file, staging]);
    const apps = (await NodeFSP.readdir(staging)).filter((entry) => entry.endsWith(".app"));
    const [app] = apps;
    if (apps.length !== 1 || app === undefined) {
      throw new Error(`The update holds ${apps.length} apps, not one.`);
    }
    const staged = NodePath.posix.join(staging, app);
    const [installedId, stagedId, stagedVersion] = await Promise.all([
      readPlistString(bundle, "CFBundleIdentifier"),
      readPlistString(staged, "CFBundleIdentifier"),
      readPlistString(staged, "CFBundleShortVersionString"),
    ]);
    if (stagedId !== installedId) {
      throw new Error(`The update is ${stagedId}, not ${installedId}.`);
    }
    if (stagedVersion !== update.version) {
      throw new Error(`The update is version ${stagedVersion}, not ${update.version}.`);
    }
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged]);
    // The app downloaded the zip itself, so nothing should carry a quarantine flag. One that stays
    // would make Gatekeeper refuse the new app once the old one is gone.
    await exec("/usr/bin/xattr", ["-dr", QUARANTINE, staged]);
    if ((await exec("/usr/bin/xattr", ["-p", QUARANTINE, staged])).code === 0) {
      throw new Error(`Could not clear the quarantine flag on ${staged}.`);
    }
    return { staging, staged };
  } catch (error) {
    await NodeFSP.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Starts the install script detached, so it outlives the app it replaces. */
export function spawnInstallScript(args: {
  readonly pid: number;
  readonly target: string;
  readonly staged: string;
  readonly staging: string;
  readonly relaunch: boolean;
  readonly logFile: string;
  readonly waitTenths?: number;
}): NodeChildProcess.ChildProcess {
  const log = NodeFS.openSync(args.logFile, "a");
  try {
    const child = NodeChildProcess.spawn(
      "/bin/sh",
      [
        "-c",
        INSTALL_SCRIPT,
        "t3-mac-update",
        String(args.pid),
        args.target,
        args.staged,
        args.staging,
        args.relaunch ? "1" : "0",
        String(args.waitTenths ?? QUIT_WAIT_TENTHS),
      ],
      { detached: true, stdio: ["ignore", log, log] },
    );
    child.unref();
    return child;
  } finally {
    NodeFS.closeSync(log);
  }
}

/** spawn can return a child and then report that it never started, so the app waits to hear. */
function started(child: NodeChildProcess.ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.on("error", reject);
  });
}

/**
 * On an ad hoc-signed Mac build, stages the downloaded update, starts the install script and quits.
 * Succeeds with false wherever Squirrel.Mac should install instead.
 */
export const installWithoutSquirrel = Effect.fn("MacAdHocUpdate.installWithoutSquirrel")(
  function* (options: {
    readonly relaunch: boolean;
    readonly isPackaged: boolean;
    readonly executablePath: string;
    readonly pid: number;
    readonly logDir: string;
    readonly expectedVersion?: string;
    readonly quit: () => void;
  }) {
    if ((yield* HostProcess.Platform) !== "darwin" || !options.isPackaged) return false;
    const bundle = appBundleOf(options.executablePath);
    if (bundle === null) return false;
    return yield* Effect.tryPromise(async () => {
      if (!(await isAdHocSigned(bundle))) return false;
      const update = downloadedUpdate;
      if (update === null) throw new Error("No downloaded update to install.");
      if (options.expectedVersion !== undefined && update.version !== options.expectedVersion) {
        throw new Error(
          `The downloaded update is ${update.version}, not ${options.expectedVersion}.`,
        );
      }
      const { staging, staged } = await stageUpdate(bundle, update);
      try {
        await NodeFSP.mkdir(options.logDir, { recursive: true });
        await started(
          spawnInstallScript({
            pid: options.pid,
            target: bundle,
            staged,
            staging,
            relaunch: options.relaunch,
            logFile: NodePath.posix.join(options.logDir, INSTALL_LOG_NAME),
          }),
        );
      } catch (error) {
        await NodeFSP.rm(staging, { recursive: true, force: true });
        throw error;
      }
      options.quit();
      return true;
    });
  },
);
