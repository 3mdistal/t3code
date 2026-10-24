import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const instanceId = ProviderInstanceId.make("codex_work");

function settingsWith(overrides: Partial<ServerSettings>): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, ...overrides };
}

describe("deriveProviderInstanceConfigMap with reserved ids", () => {
  it("drops a hand-edited pool_* instance so it never registers a real adapter", () => {
    const reservedId = ProviderInstanceId.make("pool_codex");
    const settings = settingsWith({
      providerInstances: {
        [reservedId]: { driver: ProviderDriverKind.make("codex") },
        [instanceId]: { driver: ProviderDriverKind.make("codex") },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[reservedId]).toBeUndefined();
    expect(merged[instanceId]).toEqual({ driver: ProviderDriverKind.make("codex") });
  });
});
