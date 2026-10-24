import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { hydrateCachedProvider } from "./providerStatusCache.ts";

const NOW_MS = Date.parse("2026-04-11T12:00:00.000Z");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const makeProvider = (
  provider: ProviderDriverKind,
  overrides?: Partial<ServerProvider>,
): ServerProvider => ({
  instanceId: defaultInstanceIdForDriver(provider),
  driver: provider,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

it("restores a cooldown only while it is still in force", () => {
  const fallbackCodex = makeProvider(CODEX_DRIVER);
  const hydrate = (limitedUntil: string) =>
    hydrateCachedProvider({
      cachedProvider: makeProvider(CODEX_DRIVER, { limitedUntil }),
      fallbackProvider: fallbackCodex,
      nowMs: NOW_MS,
    }).limitedUntil;

  assert.strictEqual(hydrate("2026-04-11T12:30:00.000Z"), "2026-04-11T12:30:00.000Z");
  assert.isUndefined(hydrate("2026-04-11T12:00:00.000Z"));
});
