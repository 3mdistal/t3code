import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AuthProvidersManageScope, AuthSettingsWriteScope } from "./auth.ts";
import type { ProjectId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  DEFAULT_SERVER_SETTINGS,
  requiredScopesForServerSettingsPatch,
  resolveProjectProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

// fork: the `providerPools` settings key, see FORK.md.

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("providerPools settings", () => {
  const claude = ProviderDriverKind.make("claudeAgent");

  it("defaults to no pools and turns a configured pool on unless it says otherwise", () => {
    expect(decodeServerSettings({}).providerPools).toEqual({});
    expect(
      decodeServerSettings({
        providerPools: { claudeAgent: { memberInstanceIds: ["claudeAgent"] } },
      }).providerPools[claude]?.enabled,
    ).toBe(true);
  });

  it("patches one pool at a time, with null removing it", () => {
    const patch = {
      providerPools: {
        claudeAgent: { enabled: false, memberInstanceIds: ["claudeAgent", "claudeAgent_icloud"] },
        codex: null,
      },
    };
    expect(decodeServerSettingsPatch(patch)).toEqual(patch);
  });

  it("needs the provider-manage scope, like the instances it pools", () => {
    expect(requiredScopesForServerSettingsPatch({ providerPools: { [claude]: null } })).toEqual([
      AuthProvidersManageScope,
    ]);
    expect(
      requiredScopesForServerSettingsPatch({
        providerPools: { [claude]: null },
        snoozeLimitedThreads: true,
      }),
    ).toEqual([AuthSettingsWriteScope, AuthProvidersManageScope]);
  });
});

describe("resolveProjectProviderInstanceEnabled for a pool id", () => {
  const projectId = "project-a" as ProjectId;
  const claude = ProviderDriverKind.make("claudeAgent");
  const poolId = ProviderInstanceId.make("pool_claudeAgent");
  const personal = ProviderInstanceId.make("claudeAgent");
  const work = ProviderInstanceId.make("claudeAgent_work");
  const settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [personal]: { driver: claude, enabled: false },
      [work]: { driver: claude, enabled: true },
    },
    providerPools: { [claude]: { enabled: true, memberInstanceIds: [personal, work] } },
  };

  it("is enabled while any member is enabled for the project", () => {
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, poolId)).toBe(true);
  });

  it("is disabled once the project disables every enabled member", () => {
    const overridden: ServerSettings = {
      ...settings,
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [work]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(overridden, projectId, poolId)).toBe(false);
    expect(resolveProjectProviderInstanceEnabled(overridden, null, poolId)).toBe(true);
  });

  it("is disabled when no pool is configured for the driver", () => {
    expect(
      resolveProjectProviderInstanceEnabled({ ...settings, providerPools: {} }, projectId, poolId),
    ).toBe(false);
  });

  it("does not recurse through a pool that lists its own id", () => {
    const selfListed: ServerSettings = {
      ...settings,
      providerPools: { [claude]: { enabled: true, memberInstanceIds: [poolId] } },
    };
    expect(resolveProjectProviderInstanceEnabled(selfListed, projectId, poolId)).toBe(false);
  });
});
