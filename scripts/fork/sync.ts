// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - runs from a bare checkout, before any install, so it has only Node built-ins.
// fork: rebases the patch stack onto each new upstream stable release (see
// FORK.md). A scheduled task runs `run`; the conflict thread runs `promote`.
// Node built-ins only, so it runs from a checkout without an install.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

import { RUNNING_WORKFLOWS, isInertWorkflow, regenerateWorkflows } from "./ci-workflows.ts";
import {
  FORK_MAIN_BRANCH,
  FORK_REPOSITORY,
  baseStableTag,
  compareStableTags,
  git,
  newestStableTag,
} from "./versions.ts";

const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
const CONFLICT_MODEL = "claude-opus-5-5";
const CONFLICT_MODEL_OPTIONS = ["effort=xhigh", "fastMode=false"];

const CI_APPEAR_TIMEOUT_MS = 15 * 60_000;
const CI_FINISH_TIMEOUT_MS = 4 * 60 * 60_000;
const CI_POLL_MS = 60_000;
const MEMORY_WAIT_MS = 6 * 60 * 60_000;
const MEMORY_POLL_MS = 2 * 60_000;
// `t3 thread start` refuses a longer message.
export const BRIEF_LIMIT = 120_000;
const FAILURE_LIMIT = 20_000;

export interface SyncOptions {
  readonly clone: string;
  readonly workDir: string;
  readonly dryRun: boolean;
  readonly threadProject: string | undefined;
  readonly t3: string;
  readonly usageTool: string | undefined;
  readonly memgate: string | undefined;
  readonly basedOn: string | undefined;
}

interface SyncState {
  readonly target: string;
  readonly base: string;
  readonly basedOn: string;
  readonly status: "ci-pending" | "needs-agent" | "promoted";
  readonly threadId?: string;
  readonly detail?: string;
  /** The error a thrown run started its thread for, so the same error again starts none. */
  readonly error?: string;
  /** Why the last thread start failed; the next run tries again. */
  readonly threadStartFailure?: string;
  readonly updatedAt: string;
}

interface CiRun {
  readonly databaseId: number;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
}

/**
 * The Claude account with the most room, from claude-usage.cjs output: one
 * `<provider instance id> <JSON usage windows>` line per account. Accounts the
 * tool could not read are skipped.
 */
export function pickClaudeAccount(usageOutput: string): string | undefined {
  let best: { readonly id: string; readonly load: number } | undefined;
  for (const line of usageOutput.split(/\r?\n/)) {
    const match = /^(\S+) (\{.*\})$/.exec(line.trim());
    if (!match) continue;
    let windows: Record<string, { readonly utilization?: unknown }>;
    try {
      windows = JSON.parse(match[2]!);
    } catch {
      continue;
    }
    const load = Math.max(
      ...["five_hour", "seven_day"].map((key) => {
        const utilization = windows[key]?.utilization;
        return typeof utilization === "number" ? utilization : 0;
      }),
    );
    if (load >= 100) continue;
    if (best === undefined || load < best.load) best = { id: match[1]!, load };
  }
  return best?.id;
}

/** Whether `memgate status --json` lets a launch through. Fails open like the gate's own hook. */
export function memoryAllowsLaunch(statusJson: string): boolean {
  try {
    const status = JSON.parse(statusJson) as { readonly state?: unknown; readonly off?: unknown };
    if (status.off) return true;
    return typeof status.state !== "string" || !["paused", "critical"].includes(status.state);
  } catch {
    return true;
  }
}

/** Upstream commit subjects with their `(#123)` pull request numbers linked. */
export function linkUpstreamPullRequests(subject: string): string {
  return subject.replace(
    /\(#(\d+)\)/g,
    (_, number: string) =>
      `([#${number}](https://github.com/${UPSTREAM_REPOSITORY}/pull/${number}))`,
  );
}

export function syncBranch(target: string): string {
  return `sync/${target}`;
}

export function backupTag(target: string): string {
  return `backup/fork-main-before-${target}`;
}

/**
 * A shallow clone has no stable tag under the stack to rebase from, so `run` deepens it first.
 * Whether it was shallow.
 */
export function unshallow(clone: string): boolean {
  const shallow = () => git(clone, ["rev-parse", "--is-shallow-repository"]) === "true";
  if (!shallow()) return false;
  for (const remote of ["origin", "upstream"]) {
    if (!shallow()) break;
    if (lines(git(clone, ["remote"])).includes(remote)) {
      git(clone, ["fetch", "--unshallow", "--no-tags", remote]);
    }
  }
  if (shallow()) throw new Error(`${clone} is still a shallow clone after fetching --unshallow.`);
  return true;
}

function cut(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n\n[cut: ${text.length - limit} more characters]`;
}

const AFTER_THE_FIX = (target: string) => [
  "Before pushing, run the dedupe pass: for each patch FORK.md lists, check whether upstream's new commits cover it. Drop a patch upstream covers fully, cut one it covers partly down to what upstream still lacks, and keep the rest. Prove each with the fork's tests, and update FORK.md, naming the upstream pull request behind each drop or cut.",
  "",
  "When the stack is fixed:",
  `1. Push it with \`node scripts/fork/sync.ts push ${target}\` from the worktree. It refuses a stack where one of upstream's workflows could run, and Fork CI runs on \`${syncBranch(target)}\`.`,
  `2. From the worktree, run \`node scripts/fork/sync.ts promote ${target}\`. It waits for Fork CI and moves ${FORK_MAIN_BRANCH} only if CI passed, which publishes the release.`,
  "3. End with a message that names each patch commit you changed, with its subject, its old and new SHA, and what you changed in it, so the changes can be checked against the old patches before Alice installs the release.",
];

const ASKING_ALICE = [
  "If you can't get it to pass, or a fix would drop or change one of Alice's features, stop and ask her on her Task Priorities board, never only in chat: find the fork sync task with `node ~/.claude/skills/sync-to-vault/scripts/task-log.mjs find fork sync`, write a short Content decision page (the question, the options and your suggested answer), and mark the task `needs` with that page linked.",
];

/**
 * The conflict thread's first message. The list of upstream commits that touch the patches is
 * cut to keep the message under `BRIEF_LIMIT`, with a `git log` for the rest.
 */
export function conflictBrief(input: {
  readonly target: string;
  readonly base: string;
  readonly basedOn: string;
  readonly worktree: string;
  readonly clone: string;
  readonly summary: string;
  readonly failure: string;
  readonly total: number;
  readonly touching: ReadonlyArray<string>;
}): string {
  const stack = input.basedOn.slice(0, 12);
  const render = (shown: number) =>
    [
      `The fork's sync onto upstream ${input.target} needs you: ${input.summary}.`,
      "",
      `You're fixing it for Alice. Work in \`${input.worktree}\`, a worktree of the fork clone \`${input.clone}\`. It holds the patch stack from \`${FORK_MAIN_BRANCH}\` (${stack}) rebased onto ${input.target}. Read FORK.md there first and follow its conflict rules.`,
      "",
      cut(input.failure, FAILURE_LIMIT),
      "",
      `Upstream's ${input.total} commits since ${input.base} are \`git log --oneline ${input.base}..${input.target}\`. These touch files the patches change:`,
      ...(input.touching.length === 0
        ? ["- none"]
        : input.touching.slice(0, shown).map((line) => `- ${line}`)),
      ...(shown < input.touching.length
        ? [
            `- and ${input.touching.length - shown} more: \`git log --oneline --no-merges ${input.base}..${input.target} -- $(git diff --name-only ${input.base} ${stack})\``,
          ]
        : []),
      "",
      ...AFTER_THE_FIX(input.target),
      "",
      ...ASKING_ALICE,
    ].join("\n");
  const whole = render(input.touching.length);
  if (whole.length <= BRIEF_LIMIT) return whole;
  let room = BRIEF_LIMIT - render(0).length;
  let shown = 0;
  for (const line of input.touching) {
    room -= line.length + 3;
    if (room < 0) break;
    shown += 1;
  }
  return render(shown);
}

/** The first message of the thread for a run that threw before it knew what it was syncing. */
export function runFailureBrief(input: {
  readonly clone: string;
  readonly target: string | undefined;
  readonly error: string;
}): string {
  return [
    `The fork's scheduled sync${input.target === undefined ? "" : ` onto upstream ${input.target}`} failed: \`node scripts/fork/sync.ts run\` threw before it could hand the sync over.`,
    "",
    `You're fixing it for Alice, in the fork clone \`${input.clone}\`. Read FORK.md there first.`,
    "",
    "```",
    cut(input.error, FAILURE_LIMIT),
    "```",
    "",
    `Find the cause. If it's in \`scripts/fork/\`, fix it with a test in \`scripts/fork/sync.test.ts\` and fold the fix into the \`fork:\` commit that owns \`scripts/fork/\`. Then run \`node scripts/fork/sync.ts run\` again; it hands any conflict to a new thread.`,
    "",
    ...ASKING_ALICE,
  ].join("\n");
}

function lines(output: string): Array<string> {
  return output.split(/\r?\n/).filter((line) => line.length > 0);
}

function gh(args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// .cmd shims (t3, memgate) only run through cmd.exe on Windows. Arguments are
// this script's own and never contain quotes.
function command(
  file: string,
  args: ReadonlyArray<string>,
  input?: string,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- no Effect runtime here; see the file header.
  const windows = process.platform === "win32";
  const result = windows
    ? NodeChildProcess.spawnSync([file, ...args].map((arg) => `"${arg}"`).join(" "), {
        shell: true,
        encoding: "utf8",
        input,
      })
    : NodeChildProcess.spawnSync(file, args, { encoding: "utf8", input });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function log(message: string): void {
  console.log(`[fork-sync ${new Date().toISOString()}] ${message}`);
}

function statePath(options: SyncOptions): string {
  return NodePath.join(options.workDir, "state.json");
}

function readState(options: SyncOptions): SyncState | undefined {
  try {
    return JSON.parse(NodeFS.readFileSync(statePath(options), "utf8")) as SyncState;
  } catch {
    return undefined;
  }
}

function writeState(options: SyncOptions, state: Omit<SyncState, "updatedAt">): void {
  NodeFS.mkdirSync(options.workDir, { recursive: true });
  NodeFS.writeFileSync(
    statePath(options),
    `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

function isUpstreamWorkflow(path: string): boolean {
  return (
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) &&
    !RUNNING_WORKFLOWS.has(NodePath.posix.basename(path))
  );
}

/** Upstream workflows in a commit whose triggers aren't commented out, so they would run on the fork. */
function runnableUpstreamWorkflows(repo: string, rev: string): Array<string> {
  return lines(
    git(repo, ["ls-tree", "--full-tree", "--name-only", rev, ".github/workflows/"]),
  ).filter(
    (path) => isUpstreamWorkflow(path) && !isInertWorkflow(git(repo, ["show", `${rev}:${path}`])),
  );
}

function refuseRunnableUpstreamWorkflows(repo: string, rev: string): void {
  const runnable = runnableUpstreamWorkflows(repo, rev);
  if (runnable.length > 0) {
    throw new Error(
      `Upstream workflows would run on the fork: ${runnable.join(", ")}. Run node scripts/fork/ci-workflows.ts and fold its changes into the fork: commit that owns .github/workflows/fork-ci.yml.`,
    );
  }
}

function findCiRun(branch: string, sha: string): CiRun | undefined {
  const runs = JSON.parse(
    gh([
      "run",
      "list",
      "--repo",
      FORK_REPOSITORY,
      "--workflow",
      "fork-ci.yml",
      "--branch",
      branch,
      "--commit",
      sha,
      "--limit",
      "1",
      "--json",
      "databaseId,status,conclusion,url",
    ]),
  ) as Array<CiRun>;
  return runs[0];
}

async function waitForCi(branch: string, sha: string): Promise<CiRun | undefined> {
  const appearBy = Date.now() + CI_APPEAR_TIMEOUT_MS;
  const finishBy = Date.now() + CI_FINISH_TIMEOUT_MS;
  let announced = false;
  while (Date.now() < finishBy) {
    const run = findCiRun(branch, sha);
    if (run === undefined && Date.now() > appearBy) return undefined;
    if (run?.status === "completed") return run;
    if (run !== undefined && !announced) {
      log(`Waiting for Fork CI: ${run.url}`);
      announced = true;
    }
    await NodeTimersPromises.setTimeout(CI_POLL_MS);
  }
  return findCiRun(branch, sha);
}

function failedJobs(run: CiRun): Array<string> {
  return lines(
    gh([
      "run",
      "view",
      String(run.databaseId),
      "--repo",
      FORK_REPOSITORY,
      "--json",
      "jobs",
      "--jq",
      '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | .name',
    ]),
  );
}

function upstreamChanges(options: SyncOptions, base: string, target: string, stack: string) {
  const patched = lines(git(options.clone, ["diff", "--name-only", base, stack]));
  const total = Number(git(options.clone, ["rev-list", "--count", `${base}..${target}`]));
  const touching =
    patched.length === 0
      ? []
      : lines(
          git(options.clone, [
            "log",
            "--no-merges",
            "--format=%h %s",
            `${base}..${target}`,
            "--",
            ...patched,
          ]),
        );
  return { total, touching: touching.map(linkUpstreamPullRequests) };
}

async function waitForMemory(options: SyncOptions): Promise<boolean> {
  if (options.memgate === undefined) return true;
  const giveUpAt = Date.now() + MEMORY_WAIT_MS;
  let waited = false;
  while (true) {
    const status = command(options.memgate, ["status", "--json"]);
    if (status.status !== 0 || memoryAllowsLaunch(status.stdout)) return true;
    if (Date.now() > giveUpAt) return false;
    if (!waited) log("The memory gate is holding launches; waiting for memory.");
    waited = true;
    await NodeTimersPromises.setTimeout(MEMORY_POLL_MS);
  }
}

function claudeAccount(options: SyncOptions): string {
  if (options.usageTool === undefined) return "claudeAgent";
  const usage = command(process.execPath, [options.usageTool]);
  return pickClaudeAccount(usage.stdout) ?? "claudeAgent";
}

async function startConflictThread(
  options: SyncOptions,
  input: {
    readonly target: string;
    readonly base: string;
    readonly basedOn: string;
    readonly worktree: string;
    readonly summary: string;
    readonly failure: string;
  },
): Promise<void> {
  const changes = upstreamChanges(options, input.base, input.target, input.basedOn);
  await startThread(options, {
    title: `Fork sync ${input.target}: ${input.summary}`,
    message: conflictBrief({ ...input, clone: options.clone, ...changes }),
    state: {
      target: input.target,
      base: input.base,
      basedOn: input.basedOn,
      status: "needs-agent",
      detail: input.summary,
    },
  });
}

/**
 * Starts the agent's thread, or records in the state why it didn't, so the next run tries
 * again: a run only stands down for a state that names a thread.
 */
async function startThread(
  options: SyncOptions,
  input: {
    readonly title: string;
    readonly message: string;
    readonly state: Omit<SyncState, "updatedAt" | "threadId" | "threadStartFailure">;
  },
): Promise<void> {
  const { message, state } = input;
  const failed = (why: string) => {
    writeState(options, { ...state, threadStartFailure: why });
    log(why);
    process.exitCode = 1;
  };
  if (options.dryRun) {
    log(`Would start a thread:\n${message}`);
    return;
  }
  if (options.threadProject === undefined) {
    return failed(`No --thread-project, so no thread was started. It would have said:\n${message}`);
  }
  if (!(await waitForMemory(options))) {
    return failed("The memory gate held launches for too long; the next run starts the thread.");
  }

  const provider = claudeAccount(options);
  // An installed t3 older than the fork's --option flag starts the thread at
  // the model's default effort instead.
  const help = command(options.t3, ["thread", "start", "--help"]);
  const supportsOptions = help.stdout.includes("--option");
  const started = command(
    options.t3,
    [
      "thread",
      "start",
      options.threadProject,
      "-",
      "--title",
      input.title,
      "--provider",
      provider,
      "--model",
      CONFLICT_MODEL,
      ...(supportsOptions ? CONFLICT_MODEL_OPTIONS.flatMap((option) => ["--option", option]) : []),
    ],
    message,
  );
  const threadId = started.stdout.trim();
  if (started.status !== 0 || threadId.length === 0) {
    return failed(
      `t3 thread start failed (${started.status}): ${started.stderr.trim()}; the next run tries again.`,
    );
  }
  writeState(options, { ...state, threadId });
  log(
    `Started thread ${threadId} on ${provider}${supportsOptions ? "" : " at the default effort (this t3 has no --option)"}.`,
  );
}

/** What `run` has worked out so far, for the thread a failure starts. */
interface RunProgress {
  target?: string;
  base?: string;
  basedOn?: string;
}

/**
 * A run that throws hands its error to an agent, through the conflict thread once it knows what
 * it is syncing. Each error starts one thread: the same error on a later run starts none.
 */
export async function runAndReport(options: SyncOptions): Promise<void> {
  const progress: RunProgress = {};
  try {
    await run(options, progress);
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown.message : String(thrown);
    log(`The run failed: ${error}`);
    const previous = readState(options);
    if (previous?.error === error && previous.threadId !== undefined) {
      log(`Thread ${previous.threadId} already has this error.`);
      process.exitCode = 1;
      return;
    }
    const { target, base, basedOn } = progress;
    const failure = [
      "`node scripts/fork/sync.ts run` threw:",
      "",
      "```",
      thrown instanceof Error ? (thrown.stack ?? error) : error,
      "```",
    ].join("\n");
    if (target !== undefined && base !== undefined && basedOn !== undefined) {
      const changes = upstreamChanges(options, base, target, basedOn);
      await startThread(options, {
        title: `Fork sync ${target}: the run failed`,
        message: conflictBrief({
          target,
          base,
          basedOn,
          worktree: worktreePath(options, target),
          clone: options.clone,
          summary: "the run failed",
          failure,
          ...changes,
        }),
        state: { target, base, basedOn, status: "needs-agent", detail: "the run failed", error },
      });
    } else {
      await startThread(options, {
        title: `Fork sync${target === undefined ? "" : ` ${target}`}: the run failed`,
        message: runFailureBrief({ clone: options.clone, target, error: failure }),
        state: {
          target: target ?? previous?.target ?? "",
          base: previous?.base ?? "",
          basedOn: previous?.basedOn ?? "",
          status: "needs-agent",
          detail: "the run failed",
          error,
        },
      });
    }
    process.exitCode = 1;
  }
}

function fetchRefs(options: SyncOptions, target?: string): void {
  git(options.clone, [
    "fetch",
    "--no-tags",
    "origin",
    `+refs/heads/${FORK_MAIN_BRANCH}:refs/remotes/origin/${FORK_MAIN_BRANCH}`,
    "+refs/tags/v*:refs/tags/v*",
  ]);
  if (target !== undefined) {
    git(options.clone, [
      "fetch",
      "--no-tags",
      "upstream",
      `refs/tags/${target}:refs/tags/${target}`,
    ]);
  }
}

function newestUpstreamStableTag(options: SyncOptions): string | undefined {
  const refs = lines(git(options.clone, ["ls-remote", "--tags", "--refs", "upstream", "v*"]));
  return newestStableTag(refs.map((ref) => ref.split("refs/tags/")[1]!));
}

function worktreePath(options: SyncOptions, target: string): string {
  return NodePath.join(options.workDir, target);
}

function removeWorktree(options: Pick<SyncOptions, "clone">, path: string): void {
  if (!NodeFS.existsSync(path)) return;
  git(options.clone, ["worktree", "remove", "--force", path]);
}

function rewriteWorkflows(worktree: string): string | undefined {
  try {
    regenerateWorkflows(worktree);
    return undefined;
  } catch (error) {
    return [
      `\`node scripts/fork/ci-workflows.ts\` failed: ${error instanceof Error ? error.message : String(error)}`,
      "",
      "Fix the script or the workflow it names, rerun it, and fold its changes into the `fork:` commit that owns `.github/workflows/fork-ci.yml`.",
    ].join("\n");
  }
}

/** Rebases the stack in a fresh worktree. Returns what needs an agent, or undefined when the stack is ready. */
export function rebaseStack(
  options: Pick<SyncOptions, "clone">,
  worktree: string,
  base: string,
  target: string,
) {
  removeWorktree(options, worktree);
  git(options.clone, ["worktree", "add", "--detach", worktree, `origin/${FORK_MAIN_BRANCH}`]);
  try {
    git(worktree, ["merge-base", "--is-ancestor", `refs/tags/${base}`, `refs/tags/${target}`]);
  } catch {
    return {
      summary: "upstream history",
      failure: `Upstream's ${target} doesn't contain ${base}, so the stack can't simply move forward. Rebase it with \`git rebase --onto refs/tags/${target} refs/tags/${base}\` and check what upstream dropped.`,
    };
  }
  // Rebasing onto the target itself, rather than `--onto <target> <base>`,
  // lets git drop stack commits upstream has since released, such as backports.
  let step = ["rebase", `refs/tags/${target}`];
  while (true) {
    try {
      git(worktree, ["-c", "core.editor=true", ...step]);
      break;
    } catch {
      // Expected: the rebase stopped on a conflict, handled below.
    }
    const files = lines(git(worktree, ["diff", "--name-only", "--diff-filter=U"]));
    if (files.length === 0 || !files.every(isUpstreamWorkflow)) {
      const stopped = git(worktree, ["log", "-1", "--format=%h %s", "REBASE_HEAD"]);
      log(`The rebase stopped at ${stopped}.`);
      return {
        summary: "rebase conflict",
        failure: [
          `The rebase stopped applying \`${stopped}\`, with conflicts in:`,
          ...files.map((file) => `- \`${file}\``),
          "",
          "Resolve them, `git rebase --continue`, and check the rest of the stack applies.",
        ].join("\n"),
      };
    }
    // The fork only comments out the triggers of upstream's own workflows, so
    // upstream's side always wins and the rewrite comments them out again.
    for (const file of files) {
      try {
        git(worktree, ["cat-file", "-e", `HEAD:${file}`]);
        git(worktree, ["checkout", "--ours", "--", file]);
      } catch {
        git(worktree, ["rm", "--quiet", "--", file]);
      }
    }
    const failure = rewriteWorkflows(worktree);
    if (failure !== undefined) return { summary: "workflow rewrite failed", failure };
    git(worktree, ["add", "--all", ".github/workflows"]);
    log(`Took upstream's side of ${files.join(", ")}.`);
    step = ["rebase", "--continue"];
  }

  // Upstream may have added workflows or changed ci.yml and windows-tests.yml
  // under the generated copies, so the rewrite goes into the commit that owns them.
  const failure = rewriteWorkflows(worktree);
  if (failure !== undefined) return { summary: "workflow rewrite failed", failure };
  if (git(worktree, ["status", "--porcelain", ".github/workflows"]).length > 0) {
    const owner = git(worktree, [
      "log",
      "-1",
      "--format=%H",
      "--",
      ".github/workflows/fork-ci.yml",
    ]);
    git(worktree, ["add", "--all", ".github/workflows"]);
    git(worktree, ["commit", `--fixup=${owner}`]);
    NodeChildProcess.execFileSync(
      "git",
      ["rebase", "--interactive", "--autosquash", `refs/tags/${target}`],
      { cwd: worktree, env: { ...process.env, GIT_SEQUENCE_EDITOR: "true" }, stdio: "ignore" },
    );
    log("Rewrote the workflows upstream changed.");
  }
  const runnable = runnableUpstreamWorkflows(worktree, "HEAD");
  if (runnable.length > 0) {
    return {
      summary: "workflow triggers",
      failure: `These upstream workflows would still run on the fork after the rewrite: ${runnable.join(", ")}. Find out why \`scripts/fork/ci-workflows.ts\` missed them and fix it.`,
    };
  }
  return undefined;
}

// Only the branch goes to the fork. A pushed tag runs the workflows of the
// commit it names, and upstream's tags name upstream's commits, whose triggers
// are live: `vX.Y.Z` would run upstream's release.yml here. The release
// workflow reads upstream's tags from upstream instead.
function pushSyncBranch(worktree: string, target: string): void {
  refuseRunnableUpstreamWorkflows(worktree, "HEAD");
  git(worktree, ["push", "--force", "origin", `HEAD:refs/heads/${syncBranch(target)}`]);
  log(`Pushed ${syncBranch(target)}; Fork CI runs on it.`);
}

async function run(options: SyncOptions, progress: RunProgress): Promise<void> {
  if (unshallow(options.clone))
    log(`Fetched the full history into the shallow clone ${options.clone}.`);
  const target = newestUpstreamStableTag(options);
  if (target === undefined) throw new Error("upstream has no stable tags");
  progress.target = target;
  fetchRefs(options, target);
  const stack = git(options.clone, ["rev-parse", `origin/${FORK_MAIN_BRANCH}`]);
  const base = baseStableTag(options.clone, stack);
  progress.base = base;
  progress.basedOn = stack;
  if (compareStableTags(target, base) <= 0) {
    log(`${FORK_MAIN_BRANCH} is on ${base}, the newest stable release.`);
    return;
  }

  const previous = readState(options);
  // A thread started for a failed run doesn't own the sync, so the run goes on past it.
  if (
    previous?.target === target &&
    previous.threadId !== undefined &&
    previous.error === undefined
  ) {
    log(`Thread ${previous.threadId} is already on the ${target} sync.`);
    return;
  }

  log(`Syncing ${FORK_MAIN_BRANCH} from ${base} onto ${target}.`);
  const worktree = worktreePath(options, target);
  const problem = rebaseStack(options, worktree, base, target);
  if (problem !== undefined) {
    await startConflictThread(options, { target, base, basedOn: stack, worktree, ...problem });
    return;
  }

  const sha = git(worktree, ["rev-parse", "HEAD"]);
  if (options.dryRun) {
    log(`The stack rebases cleanly onto ${target} (${sha.slice(0, 12)}). Dry run: nothing pushed.`);
    return;
  }
  pushSyncBranch(worktree, target);
  writeState(options, { target, base, basedOn: stack, status: "ci-pending" });

  const ci = await waitForCi(syncBranch(target), sha);
  if (ci?.conclusion === "success") {
    await promote(options, target);
    return;
  }
  const failure =
    ci === undefined
      ? `Fork CI never finished on \`${syncBranch(target)}\` (${sha.slice(0, 12)}).`
      : [
          `The stack rebased cleanly, but Fork CI ended ${ci.conclusion}: ${ci.url}`,
          ...failedJobs(ci).map((job) => `- ${job}`),
          "",
          `\`gh run view ${ci.databaseId} --repo ${FORK_REPOSITORY} --log-failed\` prints the failing steps.`,
        ].join("\n");
  await startConflictThread(options, {
    target,
    base,
    basedOn: stack,
    worktree,
    summary: "CI failed",
    failure,
  });
}

async function promote(options: SyncOptions, target: string): Promise<void> {
  const branch = syncBranch(target);
  git(options.clone, [
    "fetch",
    "--no-tags",
    "origin",
    `+refs/heads/${FORK_MAIN_BRANCH}:refs/remotes/origin/${FORK_MAIN_BRANCH}`,
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  const sha = git(options.clone, ["rev-parse", `origin/${branch}`]);
  const current = git(options.clone, ["rev-parse", `origin/${FORK_MAIN_BRANCH}`]);
  const state = readState(options);
  const basedOn = options.basedOn ?? (state?.target === target ? state.basedOn : undefined);
  if (basedOn === undefined) {
    throw new Error(`No sync state for ${target}; pass --based-on <old ${FORK_MAIN_BRANCH} sha>.`);
  }
  if (current !== basedOn) {
    throw new Error(
      `${FORK_MAIN_BRANCH} moved from ${basedOn.slice(0, 12)} to ${current.slice(0, 12)} since the sync started. Rebase those commits onto ${branch} too, push it, and pass --based-on ${current}.`,
    );
  }
  try {
    git(options.clone, ["merge-base", "--is-ancestor", `refs/tags/${target}`, sha]);
  } catch {
    throw new Error(`${branch} (${sha.slice(0, 12)}) does not contain ${target}.`);
  }
  refuseRunnableUpstreamWorkflows(options.clone, sha);

  const ci = await waitForCi(branch, sha);
  if (ci?.conclusion !== "success") {
    throw new Error(
      `Fork CI on ${branch} (${sha.slice(0, 12)}) ${ci === undefined ? "never finished" : `ended ${ci.conclusion}: ${ci.url}`}. Nothing was promoted.`,
    );
  }
  if (options.dryRun) {
    log(`Would move ${FORK_MAIN_BRANCH} to ${sha.slice(0, 12)} and tag ${backupTag(target)}.`);
    return;
  }
  git(options.clone, [
    "push",
    "--atomic",
    `--force-with-lease=refs/heads/${FORK_MAIN_BRANCH}:${current}`,
    "origin",
    `${sha}:refs/heads/${FORK_MAIN_BRANCH}`,
    `${current}:refs/tags/${backupTag(target)}`,
  ]);
  writeState(options, {
    target,
    base: state?.base ?? target,
    basedOn,
    status: "promoted",
    ...(state?.threadId === undefined ? {} : { threadId: state.threadId }),
  });
  log(
    `${FORK_MAIN_BRANCH} is now ${sha.slice(0, 12)} on ${target}; the old one is ${backupTag(target)}. The release workflow publishes it.`,
  );
  const worktree = worktreePath(options, target);
  if (!NodePath.resolve(process.cwd()).startsWith(NodePath.resolve(worktree))) {
    removeWorktree(options, worktree);
  }
}

const USAGE = `Usage:
  node scripts/fork/sync.ts run [--dry-run] [flags]
  node scripts/fork/sync.ts push <vX.Y.Z>
  node scripts/fork/sync.ts promote <vX.Y.Z> [--based-on <sha>] [--dry-run]

Flags:
  --clone <path>           Fork clone with origin and upstream remotes. Defaults to this checkout's.
  --work-dir <path>        Scratch worktrees and state. Defaults to <clone>-sync beside the clone.
  --thread-project <id>    T3 project for the conflict thread. Without it, no thread starts.
  --t3 <command>           t3 CLI. Defaults to t3.
  --usage-tool <path>      claude-usage.cjs, to pick the Claude account with the most room.
  --memgate <command>      memgate CLI; a launch waits while it holds launches.`;

function mainCloneOf(path: string): string {
  return NodePath.dirname(
    NodePath.resolve(path, git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
  );
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const { values, positionals } = NodeUtil.parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      clone: { type: "string" },
      "work-dir": { type: "string" },
      "thread-project": { type: "string" },
      t3: { type: "string", default: "t3" },
      "usage-tool": { type: "string" },
      memgate: { type: "string" },
      "based-on": { type: "string" },
    },
  });
  const clone = mainCloneOf(values.clone ?? import.meta.dirname);
  const options: SyncOptions = {
    clone,
    workDir: values["work-dir"] ?? `${clone}-sync`,
    dryRun: values["dry-run"],
    threadProject: values["thread-project"],
    t3: values.t3,
    usageTool: values["usage-tool"]?.replace(/^~(?=$|[\\/])/, NodeOS.homedir()),
    memgate: values.memgate,
    basedOn: values["based-on"],
  };
  const [verb, target] = positionals;
  if (verb === "run") return runAndReport(options);
  if (verb === "push" && target !== undefined) {
    pushSyncBranch(process.cwd(), target);
    // The thread that pushed still owns the sync; `promote` reads basedOn from here.
    const state = readState(options);
    if (state?.target === target) writeState(options, { ...state, status: "ci-pending" });
    return;
  }
  if (verb === "promote" && target !== undefined) return promote(options, target);
  console.error(USAGE);
  process.exitCode = 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
