import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveComposerProviderInstanceEntries,
  providerInstanceEntriesFor,
  resolvePoolMemberLabel,
} from "./providerInstances";

// fork: account pools in the provider catalogs, see FORK.md.

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
  accentColor?: string;
  status?: ServerProvider["status"];
  models?: ServerProvider["models"];
  supportsTextGeneration?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.supportsTextGeneration === undefined
      ? {}
      : { supportsTextGeneration: input.supportsTextGeneration }),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

describe("account pools in the composer catalog", () => {
  const claude = ProviderDriverKind.make("claudeAgent");
  const codex = ProviderDriverKind.make("codex");
  const poolId = ProviderInstanceId.make("pool_claudeAgent");
  const memberIds = ["claudeAgent", "claudeAgent_icloud"].map((id) => ProviderInstanceId.make(id));
  const settings = {
    providerInstances: {},
    projectSettingsOverrides: {},
    providerPools: { [claude]: { enabled: true, memberInstanceIds: memberIds } },
  };
  const pooledProviders: ReadonlyArray<ServerProvider> = [
    provider({ provider: codex, instanceId: "codex" }),
    {
      ...provider({ provider: claude, instanceId: "claudeAgent" }),
      pool: { role: "member", poolInstanceId: poolId },
    },
    {
      ...provider({ provider: claude, instanceId: "claudeAgent_icloud" }),
      pool: { role: "member", poolInstanceId: poolId },
    },
    {
      ...provider({ provider: claude, instanceId: poolId, displayName: "Claude" }),
      pool: { role: "pool", memberInstanceIds: memberIds, droppedModels: [] },
    },
  ];
  const ids = (entries: ReadonlyArray<{ readonly instanceId: string }>) =>
    entries.map((entry) => entry.instanceId);

  it("offers the pool in place of its members and keeps unpooled accounts", () => {
    const entries = deriveComposerProviderInstanceEntries(pooledProviders, settings, null);
    expect(ids(entries)).toEqual(["codex", "pool_claudeAgent"]);
    expect(entries.find((entry) => entry.instanceId === poolId)?.enabled).toBe(true);
  });

  it("lists the pool ahead of a third account that is not pooled", () => {
    const entries = deriveComposerProviderInstanceEntries(
      [...pooledProviders, provider({ provider: claude, instanceId: "claudeAgent_work" })],
      settings,
      null,
    );
    expect(ids(entries.filter((entry) => entry.driverKind === claude))).toEqual([
      "pool_claudeAgent",
      "claudeAgent_work",
    ]);
  });

  it("offers every account when no pool is active", () => {
    const unpooled = pooledProviders.filter((entry) => entry.pool === undefined);
    expect(ids(deriveComposerProviderInstanceEntries(unpooled, settings, null))).toEqual(
      ids(unpooled),
    );
  });

  it("leaves the settings catalog showing every account", () => {
    const settingsEntries = providerInstanceEntriesFor(pooledProviders, settings, null);
    expect(ids(settingsEntries)).toEqual(
      expect.arrayContaining(["claudeAgent", "claudeAgent_icloud", "codex"]),
    );
  });

  describe("resolvePoolMemberLabel", () => {
    it("names the account that ran without repeating the provider's name", () => {
      const withNames = pooledProviders.map((entry) =>
        entry.instanceId === memberIds[1] ? { ...entry, displayName: "Claude - iCloud" } : entry,
      );
      expect(resolvePoolMemberLabel(withNames, poolId, memberIds[1])).toEqual({
        poolName: "Claude",
        memberName: "iCloud",
      });
    });

    it("keeps a member name that does not start with the pool's", () => {
      const withNames = pooledProviders.map((entry) =>
        entry.instanceId === memberIds[1] ? { ...entry, displayName: "Work account" } : entry,
      );
      expect(resolvePoolMemberLabel(withNames, poolId, memberIds[1])?.memberName).toBe(
        "Work account",
      );
    });

    it("is absent when the selection is not a pool or the thread has not run on a member", () => {
      expect(resolvePoolMemberLabel(pooledProviders, memberIds[0]!, memberIds[0])).toBeNull();
      expect(resolvePoolMemberLabel(pooledProviders, poolId, null)).toBeNull();
      expect(
        resolvePoolMemberLabel(pooledProviders, poolId, ProviderInstanceId.make("codex")),
      ).toBeNull();
    });
  });
});
