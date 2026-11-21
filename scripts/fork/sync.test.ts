// @effect-diagnostics nodeBuiltinImport:off - builds scratch git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { isInertWorkflow, regenerateWorkflows } from "./ci-workflows.ts";
import {
  BRIEF_LIMIT,
  conflictBrief,
  linkUpstreamPullRequests,
  memoryAllowsLaunch,
  pickClaudeAccount,
  rebaseStack,
  runAndReport,
  unshallow,
} from "./sync.ts";

describe("pickClaudeAccount", () => {
  it("picks the account with the most room in its tightest window", () => {
    const output = [
      'claudeAgent {"five_hour":{"utilization":23},"seven_day":{"utilization":45}}',
      'claudeAgent_full {"five_hour":{"utilization":0},"seven_day":{"utilization":100}}',
      'claudeAgent_apple {"five_hour":{"utilization":18},"seven_day":{"utilization":3}}',
      "claudeAgent_broken credentials unreadable: ENOENT",
      'claudeAgent_busy {"five_hour":{"utilization":60},"seven_day":{"utilization":5}}',
    ].join("\n");
    expect(pickClaudeAccount(output)).toBe("claudeAgent_apple");
  });

  it("finds nothing when every account is used up or unreadable", () => {
    expect(
      pickClaudeAccount('a {"five_hour":{"utilization":100}}\r\nb HTTP 401\r\n'),
    ).toBeUndefined();
  });
});

describe("memoryAllowsLaunch", () => {
  it("holds launches only while the gate is paused or critical and on", () => {
    expect(memoryAllowsLaunch('{"state":"ok","off":null}')).toBe(true);
    expect(memoryAllowsLaunch('{"state":"paused","off":null}')).toBe(false);
    expect(memoryAllowsLaunch('{"state":"critical","off":null}')).toBe(false);
    expect(memoryAllowsLaunch('{"state":"paused","off":"2026-10-24T08:00:00.000Z"}')).toBe(true);
  });

  it("fails open like the gate's hook", () => {
    expect(memoryAllowsLaunch('{"state":"unknown (watcher not running)"}')).toBe(true);
    expect(memoryAllowsLaunch("not json")).toBe(true);
  });
});

describe("linkUpstreamPullRequests", () => {
  it("links each upstream pull request number", () => {
    expect(linkUpstreamPullRequests("044f072 fix(web): sidebar follows (#23519)")).toBe(
      "044f072 fix(web): sidebar follows ([#23519](https://github.com/pingdotgg/t3code/pull/23519))",
    );
  });
});

const UPSTREAM_FILES = {
  ".gitattributes": "* text=auto eol=lf\n",
  "app.txt": "upstream\n",
  ".github/workflows/ci.yml":
    "name: CI\n\non:\n  pull_request:\n\njobs:\n  a:\n    runs-on: blacksmith-8vcpu-ubuntu-2404\n",
  ".github/workflows/windows-tests.yml":
    "name: Windows Tests\n\non:\n  workflow_dispatch:\n\njobs:\n  a:\n    runs-on: blacksmith-8vcpu-windows-2025\n",
  ".github/workflows/release.yml":
    'name: Release\n\non:\n  push:\n    tags: ["v*.*.*"]\n\njobs:\n  a:\n    runs-on: ubuntu-24.04\n',
};

/**
 * A clone whose `origin/fork/main` is upstream's v0.0.1 plus a `fork:` commit
 * that rewrote the workflows, and whose v0.0.2 is upstream's next release. A
 * `backport` is an upstream change in v0.0.2 that the stack also carries.
 */
function scratchClone(input: {
  readonly fork?: Record<string, string>;
  readonly backport?: Record<string, string>;
  readonly upstream: Record<string, string>;
}) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-"));
  const clone = NodePath.join(dir, "clone");
  const git = (cwd: string, ...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(clone, path)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(clone, path), text);
    }
  };
  const commit = (message: string) => {
    git(clone, "add", "--all");
    git(clone, "commit", "--quiet", "--message", message);
  };

  NodeFS.mkdirSync(clone);
  git(clone, "init", "--quiet", "--initial-branch=main");
  for (const [key, value] of Object.entries({
    "user.name": "Fork Sync Test",
    "user.email": "fork-sync@example.invalid",
    "commit.gpgsign": "false",
    "core.autocrlf": "false",
    "core.hooksPath": NodePath.join(dir, "no-hooks"),
  })) {
    git(clone, "config", key, value);
  }
  write(UPSTREAM_FILES);
  commit("upstream 0.0.1");
  git(clone, "tag", "v0.0.1");

  regenerateWorkflows(clone);
  write(input.fork ?? {});
  commit("fork: workflows");
  if (input.backport) {
    write(input.backport);
    commit("fork: backport upstream's fix");
  }
  git(clone, "update-ref", "refs/remotes/origin/fork/main", "HEAD");

  git(clone, "checkout", "--quiet", "--detach", "v0.0.1");
  if (input.backport) {
    write(input.backport);
    commit("upstream fix");
  }
  write(input.upstream);
  commit("upstream 0.0.2");
  git(clone, "tag", "v0.0.2");

  const worktree = NodePath.join(dir, "v0.0.2");
  return {
    worktree,
    show: (path: string) => git(worktree, "show", `HEAD:${path}`),
    git: (...args: Array<string>) => git(worktree, ...args),
    rebase: () => rebaseStack({ clone }, worktree, "v0.0.1", "v0.0.2"),
    [Symbol.dispose]: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("rebaseStack", () => {
  it("takes upstream's workflow changes and comments their triggers out again", () => {
    using repo = scratchClone({
      upstream: {
        ".github/workflows/release.yml":
          'name: Release\n\non:\n  push:\n    tags: ["v*.*.*"]\n  schedule:\n    - cron: "8 * * * *"\n\njobs:\n  a:\n    runs-on: ubuntu-24.04\n',
        ".github/workflows/ci.yml":
          "name: CI\n\non:\n  pull_request:\n  merge_group:\n\njobs:\n  a:\n    runs-on: blacksmith-8vcpu-ubuntu-2404\n    timeout-minutes: 7\n",
        ".github/workflows/deploy.yml":
          "name: Deploy\n\non:\n  push:\n    branches: [main]\n\njobs:\n  a:\n    runs-on: ubuntu-24.04\n",
      },
    });

    expect(repo.rebase()).toBeUndefined();
    expect(repo.git("log", "--format=%s", "v0.0.2..HEAD")).toBe("fork: workflows");
    expect(repo.git("status", "--porcelain")).toBe("");
    for (const file of ["release.yml", "ci.yml", "deploy.yml", "windows-tests.yml"]) {
      expect(isInertWorkflow(repo.show(`.github/workflows/${file}`)), file).toBe(true);
    }
    expect(repo.show(".github/workflows/release.yml")).toContain('  #   - cron: "8 * * * *"\n');
    expect(repo.show(".github/workflows/fork-ci.yml")).toContain("timeout-minutes: 21");
  });

  it("drops a backport once upstream releases it, even if upstream changed it again", () => {
    using repo = scratchClone({
      backport: { "pnpm-workspace.yaml": "packages: [apps/*]\n" },
      upstream: { "pnpm-workspace.yaml": "packages: [apps/*, packages/*]\n" },
    });

    expect(repo.rebase()).toBeUndefined();
    expect(repo.git("log", "--format=%s", "v0.0.2..HEAD")).toBe("fork: workflows");
    expect(repo.show("pnpm-workspace.yaml")).toBe("packages: [apps/*, packages/*]");
  });

  it("leaves conflicts outside upstream's workflows to the agent", () => {
    using repo = scratchClone({
      fork: { "app.txt": "fork\n" },
      upstream: { "app.txt": "upstream 0.0.2\n" },
    });

    const problem = repo.rebase();
    expect(problem?.summary).toBe("rebase conflict");
    expect(problem?.failure).toContain("- `app.txt`");
  });

  it("hands the agent an upstream workflow it cannot rewrite", () => {
    using repo = scratchClone({
      upstream: { ".github/workflows/lint.yml": "name: Lint\non: [push]\njobs: {}\n" },
    });

    const problem = repo.rebase();
    expect(problem?.summary).toBe("workflow rewrite failed");
    expect(problem?.failure).toContain("lint.yml needs exactly one top-level on: block");
  });
});

describe("unshallow", () => {
  it("fetches the full history into a shallow clone, once", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-shallow-"));
    try {
      const git = (cwd: string, ...args: Array<string>) =>
        NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      const source = NodePath.join(dir, "source");
      NodeFS.mkdirSync(source);
      git(source, "init", "--quiet", "--initial-branch=main");
      git(source, "config", "user.name", "Fork Sync Test");
      git(source, "config", "user.email", "fork-sync@example.invalid");
      for (const message of ["one", "two", "three"]) {
        git(source, "commit", "--quiet", "--allow-empty", "--no-gpg-sign", "--message", message);
      }
      const clone = NodePath.join(dir, "clone");
      const url = `file://${source.replaceAll("\\", "/")}`;
      git(dir, "clone", "--quiet", "--depth=1", url, clone);
      expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");

      expect(unshallow(clone)).toBe(true);
      expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("false");
      expect(git(clone, "rev-list", "--count", "HEAD")).toBe("3");
      expect(unshallow(clone)).toBe(false);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conflictBrief", () => {
  const input = {
    target: "v0.1.11",
    base: "v0.1.6",
    basedOn: "362ad35656099e4415c64a4b0dbc9ea8817fa55a",
    worktree: "/sync/v0.1.11",
    clone: "/fork",
    summary: "rebase conflict",
    failure: "The rebase stopped applying `abc fork: x`.",
    total: 3,
    touching: ["aaa fix(server): one (#1)", "bbb fix(web): two (#2)"],
  };

  it("lists every upstream commit that fits, and asks for the dedupe pass and board questions", () => {
    const brief = conflictBrief(input);
    expect(brief).toContain("- aaa fix(server): one (#1)\n- bbb fix(web): two (#2)\n");
    expect(brief).not.toContain("more:");
    expect(brief).toContain("dedupe pass");
    expect(brief).toContain(
      "`node ~/.claude/skills/sync-to-vault/scripts/task-log.mjs find fork sync`",
    );
    expect(brief).toContain("`needs`");
    expect(brief).not.toContain("tell Alice here");
  });

  it("stays under the limit, cutting the commit list and naming a git log for the rest", () => {
    const touching = Array.from(
      { length: 5_000 },
      (_, index) => `${String(index).padStart(10, "0")} fix(server): ${"a".repeat(80)} (#${index})`,
    );
    const brief = conflictBrief({ ...input, failure: "x".repeat(200_000), touching });
    expect(brief.length).toBeLessThanOrEqual(BRIEF_LIMIT);
    expect(brief).toContain(`- ${touching[0]}\n`);
    expect(brief).not.toContain(touching.at(-1));
    expect(brief).toMatch(
      /- and \d+ more: `git log --oneline --no-merges v0\.1\.6\.\.v0\.1\.11 -- \$\(git diff --name-only v0\.1\.6 362ad3565609\)`/,
    );
    expect(brief).toContain("[cut: 180000 more characters]");
    expect(brief).toContain("task-log.mjs find fork sync");
  });
});

/**
 * A `t3` that records each `thread start` and answers with `thread-<n>`, or fails with "boom"
 * while `fail()` is on.
 */
function fakeT3(dir: string) {
  const calls = NodePath.join(dir, "calls.jsonl");
  const brief = NodePath.join(dir, "brief.txt");
  const failFlag = NodePath.join(dir, "fail");
  const script = NodePath.join(dir, "t3.mjs");
  NodeFS.writeFileSync(
    script,
    [
      'import * as NodeFS from "node:fs";',
      "const args = process.argv.slice(2);",
      'if (args.includes("--help")) { console.log("--option"); process.exit(0); }',
      `NodeFS.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");`,
      `NodeFS.writeFileSync(${JSON.stringify(brief)}, NodeFS.readFileSync(0, "utf8"));`,
      `if (NodeFS.existsSync(${JSON.stringify(failFlag)})) { console.error("boom"); process.exit(3); }`,
      `console.log("thread-" + NodeFS.readFileSync(${JSON.stringify(calls)}, "utf8").trim().split("\\n").length);`,
      "",
    ].join("\n"),
  );
  let t3: string;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- no Effect runtime here; see sync.ts's header.
  if (process.platform === "win32") {
    t3 = NodePath.join(dir, "t3.cmd");
    NodeFS.writeFileSync(t3, `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    t3 = NodePath.join(dir, "t3");
    NodeFS.writeFileSync(t3, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
      mode: 0o755,
    });
  }
  return {
    t3,
    starts: () =>
      NodeFS.existsSync(calls) ? NodeFS.readFileSync(calls, "utf8").trim().split("\n").length : 0,
    brief: () => NodeFS.readFileSync(brief, "utf8"),
    fail: (on: boolean) =>
      on ? NodeFS.writeFileSync(failFlag, "") : NodeFS.rmSync(failFlag, { force: true }),
  };
}

describe("runAndReport", () => {
  const scratch = () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-report-"));
    const t3 = fakeT3(dir);
    const exitCode = process.exitCode;
    const options = (clone: string) => ({
      clone,
      workDir: NodePath.join(dir, "work"),
      dryRun: false,
      threadProject: "project-1",
      t3: t3.t3,
      usageTool: undefined,
      memgate: undefined,
      basedOn: undefined,
    });
    const state = () =>
      JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "work", "state.json"), "utf8"));
    return {
      dir,
      t3,
      options,
      state,
      [Symbol.dispose]: () => {
        process.exitCode = exitCode;
        NodeFS.rmSync(dir, { recursive: true, force: true });
      },
    };
  };

  it("starts one thread for each distinct error a run throws", async () => {
    using repo = scratch();
    const missing = NodePath.join(repo.dir, "missing");

    await runAndReport(repo.options(missing));
    expect(repo.t3.starts()).toBe(1);
    expect(repo.t3.brief()).toContain("`node scripts/fork/sync.ts run` threw");
    expect(repo.t3.brief()).toContain("task-log.mjs find fork sync");
    expect(repo.state()).toMatchObject({ status: "needs-agent", threadId: "thread-1" });
    expect(repo.state().error).toEqual(expect.any(String));

    await runAndReport(repo.options(missing));
    expect(repo.t3.starts()).toBe(1);

    const notARepository = NodePath.join(repo.dir, "plain");
    NodeFS.mkdirSync(notARepository);
    await runAndReport(repo.options(notARepository));
    expect(repo.t3.starts()).toBe(2);
    expect(repo.state().threadId).toBe("thread-2");
  });

  it("records a failed thread start, and the next run tries again", async () => {
    using repo = scratch();
    const missing = NodePath.join(repo.dir, "missing");

    repo.t3.fail(true);
    await runAndReport(repo.options(missing));
    expect(repo.t3.starts()).toBe(1);
    expect(repo.state().threadId).toBeUndefined();
    expect(repo.state().threadStartFailure).toContain("boom");

    repo.t3.fail(false);
    await runAndReport(repo.options(missing));
    expect(repo.t3.starts()).toBe(2);
    expect(repo.state().threadId).toBe("thread-2");
    expect(repo.state().threadStartFailure).toBeUndefined();
  });
});
