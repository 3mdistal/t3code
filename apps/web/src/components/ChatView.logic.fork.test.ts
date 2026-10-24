import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../providerInstances";
import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import { resolveComposerProviderSelection } from "./ChatView.logic";

// fork: account pools in the composer, see FORK.md.

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("resolveComposerProviderSelection", () => {
  function entry(driver: string, instanceId = driver, overrides: Partial<ServerProvider> = {}) {
    return deriveProviderInstanceEntries([
      {
        driver: ProviderDriverKind.make(driver),
        instanceId: ProviderInstanceId.make(instanceId),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: now,
        models: [],
        slashCommands: [],
        skills: [],
        ...overrides,
      },
    ])[0]!;
  }

  function importedThread(instanceId: ProviderInstanceId) {
    return makeThread({
      modelSelection: { instanceId, model: "default" },
      itemCount: 1,
    });
  }

  describe("with an active account pool", () => {
    const poolId = ProviderInstanceId.make("pool_claudeAgent");
    const memberIds = ["claudeAgent", "claudeAgent_icloud"].map((id) =>
      ProviderInstanceId.make(id),
    );
    const member = (instanceId: string) =>
      entry("claudeAgent", instanceId, { pool: { role: "member", poolInstanceId: poolId } });
    const poolEntry = entry("claudeAgent", poolId, {
      pool: { role: "pool", memberInstanceIds: memberIds, droppedModels: [] },
      continuation: undefined,
    });
    const providers = [member("claudeAgent"), member("claudeAgent_icloud"), poolEntry].map(
      (candidate) => candidate.snapshot,
    );
    const composerEntries = [entry("codex"), poolEntry];

    it("selects the pool for a thread whose runtime account the composer hides", () => {
      const thread = importedThread(memberIds[0]!);
      const selection = resolveComposerProviderSelection({
        entries: composerEntries,
        providers,
        candidateInstanceIds: [null, memberIds[1], thread.modelSelection.instanceId],
        lockedProvider: ProviderDriverKind.make("claudeAgent"),
        lockedInstanceId: memberIds[1],
      });

      expect(selection.selectedProviderEntry?.instanceId).toBe(poolId);
      expect(selection.unavailableProviderInstanceId).toBeUndefined();
    });

    it("locks a started thread to the continuation group its pool shares", () => {
      const sharedPool = entry("codex", "pool_codex", {
        pool: {
          role: "pool",
          memberInstanceIds: [ProviderInstanceId.make("codex"), ProviderInstanceId.make("codex_2")],
          droppedModels: [],
        },
        continuation: { groupKey: "codex:home:shared" },
      });
      const sharedMember = entry("codex", "codex_2", {
        pool: { role: "member", poolInstanceId: sharedPool.instanceId },
        continuation: { groupKey: "codex:home:shared" },
      });
      const selection = resolveComposerProviderSelection({
        entries: [sharedPool],
        providers: [sharedMember.snapshot, sharedPool.snapshot],
        candidateInstanceIds: [sharedMember.instanceId],
        lockedProvider: ProviderDriverKind.make("codex"),
        lockedInstanceId: sharedMember.instanceId,
      });

      expect(selection.lockedContinuationGroupKey).toBe("codex:home:shared");
      expect(selection.selectedProviderEntry?.instanceId).toBe(sharedPool.instanceId);
    });

    it("does not lock a mixed Claude pool to one account's continuation group", () => {
      const selection = resolveComposerProviderSelection({
        entries: composerEntries,
        providers,
        candidateInstanceIds: [memberIds[0]],
        lockedProvider: ProviderDriverKind.make("claudeAgent"),
        lockedInstanceId: memberIds[0],
      });

      expect(selection.lockedContinuationGroupKey).toBeNull();
    });
  });
});
