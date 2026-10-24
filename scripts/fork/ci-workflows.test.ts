// @effect-diagnostics nodeBuiltinImport:off - compares the committed workflow files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  FORK_WORKFLOWS,
  RUNNING_WORKFLOWS,
  forkWorkflow,
  inertWorkflow,
  isInertWorkflow,
} from "./ci-workflows.ts";

const workflowsDir = NodePath.join(import.meta.dirname, "../../.github/workflows");
const read = (file: string) => NodeFS.readFileSync(NodePath.join(workflowsDir, file), "utf8");

const UPSTREAM_RELEASE = `name: Release

on:
  push:
    tags:
      - "v*.*.*"

  schedule:
    # Avoid minute zero.
    - cron: "8,38 * * * *"
  workflow_dispatch:
    inputs:
      channel:
        type: string

# Serialize nightlies.
concurrency:
  group: release
jobs:
  a:
    runs-on: blacksmith-8vcpu-ubuntu-2404
`;

describe("fork workflows", () => {
  it.each(FORK_WORKFLOWS)("$target is generated from upstream's $source", (spec) => {
    expect(read(spec.target), "run node scripts/fork/ci-workflows.ts").toBe(
      forkWorkflow(read(spec.source), spec),
    );
  });

  it("leaves no upstream workflow able to run", () => {
    const upstream = NodeFS.readdirSync(workflowsDir).filter(
      (file) => /\.ya?ml$/.test(file) && !RUNNING_WORKFLOWS.has(file),
    );
    expect(upstream).toContain("release.yml");
    for (const file of upstream) {
      expect(isInertWorkflow(read(file)), `${file}: run node scripts/fork/ci-workflows.ts`).toBe(
        true,
      );
    }
  });

  it("comments out upstream's triggers and gives the fork copies them back", () => {
    const inert = inertWorkflow(UPSTREAM_RELEASE, "release.yml");
    expect(isInertWorkflow(inert)).toBe(true);
    expect(inertWorkflow(inert, "release.yml")).toBe(inert);
    expect(inert).not.toMatch(/^ {2}(push|schedule|workflow_dispatch):/m);
    expect(inert).toContain('  #     - "v*.*.*"\n  #\n  # schedule:\n');
    expect(inert).toContain("  workflow_call:\n\n# Serialize nightlies.\nconcurrency:\n");

    const spec = FORK_WORKFLOWS[1];
    expect(forkWorkflow(inert, spec)).toBe(forkWorkflow(UPSTREAM_RELEASE, spec));
    expect(forkWorkflow(inert, spec)).toContain(
      'on:\n  push:\n    tags:\n      - "v*.*.*"\n\n  schedule:\n',
    );
  });

  it("catches a trigger added to an inert workflow", () => {
    const inert = inertWorkflow(UPSTREAM_RELEASE, "release.yml");
    expect(
      isInertWorkflow(inert.replace("  workflow_call:\n", "  workflow_call:\n  push:\n")),
    ).toBe(false);
    expect(isInertWorkflow(inert.replace("  # schedule:\n", "  schedule:\n"))).toBe(false);
    expect(isInertWorkflow(`${inert}on:\n  push:\n`)).toBe(false);
  });

  it("refuses triggers it cannot comment out", () => {
    expect(() => inertWorkflow("name: A\non: [push]\njobs: {}\n", "a.yml")).toThrow(/on: block/);
    expect(() => inertWorkflow("name: A\non:\n\tpush:\njobs: {}\n", "a.yml")).toThrow(/two spaces/);
  });

  it("maps every runner to a GitHub-hosted one and runs CI on fork PRs and syncs", () => {
    const generated = forkWorkflow(
      `name: CI

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  a:
    runs-on: blacksmith-8vcpu-ubuntu-2404
    timeout-minutes: 10
  b:
    runs-on: blacksmith-6vcpu-macos-26
  c:
    runs-on: blacksmith-4vcpu-ubuntu-2404-arm
  d:
    runs-on: blacksmith-8vcpu-windows-2025
`,
      FORK_WORKFLOWS[0],
    );
    expect(generated).toContain("name: Fork CI\n");
    expect(generated).toContain('    branches: ["sync/**"]\n  workflow_call:\n');
    expect(generated).not.toContain("- main");
    expect(generated).toContain("runs-on: ubuntu-24.04\n    timeout-minutes: 30\n");
    expect(generated).toContain("runs-on: macos-26\n");
    expect(generated).toContain("runs-on: ubuntu-24.04-arm\n");
    expect(generated).toContain("runs-on: windows-2025\n");
  });

  it("refuses a runner it cannot map", () => {
    expect(() =>
      forkWorkflow("name: CI\non:\n  push:\njobs:\n  a:\n    runs-on: blacksmith-gpu\n", {
        ...FORK_WORKFLOWS[0],
      }),
    ).toThrow(/cannot map/);
  });
});
