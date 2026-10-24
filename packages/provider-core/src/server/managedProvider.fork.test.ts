import { describe, it, assert } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProviderHost from "./ProviderHost.ts";
import { makeManagedServerProvider } from "./managedProvider.ts";

// fork: a pooled account's usage-limit cooldown, see FORK.md.

interface TestSettings {
  readonly enabled: boolean;
}

const maintenanceCapabilities = {
  provider: ProviderDriverKind.make("codex"),
  packageName: "@openai/codex",
  update: {
    command: "npm install -g @openai/codex@latest",

    executable: "npm",

    args: ["install", "-g", "@openai/codex@latest"],

    lockKey: "npm-global",
  },
} as const;

const initialSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  message: "Checking provider availability...",
  models: [],
  slashCommands: [],
  skills: [],
};

const refreshedSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:01.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

function layerProviderHost(input: {
  readonly runBackgroundWork: boolean;
  readonly settings?: Pick<ProviderHost.ProviderHost["Service"], "settings">["settings"];
}) {
  return Layer.succeed(
    ProviderHost.ProviderHost,
    ProviderHost.ProviderHost.of({
      paths: {
        cwd: process.cwd(),
        baseDir: "/t3",
        stateDir: "/t3/userdata",
        providerStatusCacheDir: "/t3/caches",
        attachmentsDir: "/t3/userdata/attachments",
      },
      settings: input.settings ?? {
        get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
        changes: Stream.empty,
        subscribe: Effect.succeed(Stream.empty),
      },
      shouldRunBackgroundWork: () => Effect.succeed(input.runBackgroundWork),
      resolveAttachmentPath: () => null,
      credentials: () => Effect.die("unused"),
    }),
  );
}

const layerAlwaysRunTest = layerProviderHost({ runBackgroundWork: true });

describe("makeManagedServerProvider", () => {
  it.effect("keeps the later cooldown across probes and clears it when the account changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const account = yield* Ref.make("first@example.com");
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.get(account).pipe(
            Effect.map((email) => ({
              ...refreshedSnapshot,
              auth: { ...refreshedSnapshot.auth, email },
            })),
          ),
        });

        yield* provider.markLimited({ until: "2026-04-10T01:00:00.000Z" });
        yield* provider.markLimited({ until: "2026-04-10T00:30:00.000Z" });
        assert.strictEqual((yield* provider.getSnapshot).limitedUntil, "2026-04-10T01:00:00.000Z");

        const refreshed = yield* provider.refresh;
        assert.strictEqual(refreshed.limitedUntil, "2026-04-10T01:00:00.000Z");

        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:05:00.000Z",
          windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 90 }],
        });
        assert.strictEqual((yield* provider.getSnapshot).limitedUntil, "2026-04-10T01:00:00.000Z");

        yield* Ref.set(account, "second@example.com");
        const switched = yield* provider.refresh;
        assert.isUndefined(switched.limitedUntil);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
});
