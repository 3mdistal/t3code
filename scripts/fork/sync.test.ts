// @effect-diagnostics nodeBuiltinImport:off - builds scratch git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { isInertWorkflow, regenerateWorkflows } from "./ci-workflows.ts";
import {
  linkUpstreamPullRequests,
  memoryAllowsLaunch,
  pickClaudeAccount,
  rebaseStack,
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
