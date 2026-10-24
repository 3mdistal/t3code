// @effect-diagnostics nodeBuiltinImport:off - reads the committed entitlements plist.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Plist from "plist";

import desktopPackageJson from "../../apps/desktop/package.json" with { type: "json" };

import {
  createBuildConfig,
  isDesktopPreviewVersion,
  renderMacPasskeyEntitlements,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveDesktopWebAssetBrand,
  resolveMacPasskeySigningConfiguration,
} from "../build-desktop-artifact.ts";

// fork: these hold upstream's build to what the X.Y.Z-alice.N scheme relies on
// (see FORK.md). A failure here after a sync means upstream changed how it
// reads versions, and the scheme needs rethinking before anything ships.

it("builds an -alice.N version as a production release with an update feed", () => {
  for (const version of ["0.1.3-alice.1", "0.1.3-alice.12", "1.0.0-alice.1"]) {
    assert.strictEqual(resolveDesktopUpdateChannel(version), "latest");
    assert.isFalse(isDesktopPreviewVersion(version));
    assert.strictEqual(resolveDesktopProductName(version), desktopPackageJson.productName);
    assert.strictEqual(resolveDesktopWebAssetBrand(version), "production");
  }
});

const forkReleaseEnv = Layer.mergeAll(
  NodeServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "3mdistal/t3code" } })),
);

it.effect("publishes the update feed to the repository the release runs in", () =>
  Effect.gen(function* () {
    const config = yield* createBuildConfig(
      "win",
      "nsis",
      "0.1.3-alice.1",
      false,
      false,
      undefined,
      undefined,
    );
    assert.deepStrictEqual(config.publish, [
      { provider: "github", owner: "3mdistal", repo: "t3code", releaseType: "release" },
    ]);
  }).pipe(Effect.provide(forkReleaseEnv)),
);

it.effect("signs an unsigned macOS build ad hoc", () =>
  Effect.gen(function* () {
    const config = yield* createBuildConfig(
      "mac",
      "dmg",
      "0.1.3-alice.1",
      false,
      false,
      undefined,
      undefined,
    );
    assert.propertyVal(config.mac, "identity", "-");
    assert.notProperty(config.mac, "sign");
  }).pipe(Effect.provide(forkReleaseEnv)),
);

// Entitlements that need a provisioning profile, which a fork cannot get for
// upstream's App ID.
const RESTRICTED_ENTITLEMENTS = new Set([
  "com.apple.application-identifier",
  "com.apple.developer.team-identifier",
  "com.apple.developer.associated-domains",
  "keychain-access-groups",
  "com.apple.developer.web-browser.public-key-credential",
]);

it("signs without a profile using upstream's unrestricted entitlements", () => {
  const upstream = Plist.parse(
    renderMacPasskeyEntitlements(
      resolveMacPasskeySigningConfiguration({
        T3CODE_APPLE_TEAM_ID: "ABC1234567",
        T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
        T3CODE_CLERK_PASSKEY_RP_DOMAINS: "clerk.example.com",
      }),
      { touchIdKeychainAccessGroup: "ABC1234567.group", browserPasskeys: true },
    ),
  ) as Record<string, unknown>;
  const fork = Plist.parse(
    NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../../apps/desktop/resources/entitlements.mac.plist"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const unrestricted = Object.fromEntries(
    Object.entries(upstream).filter(([key]) => !RESTRICTED_ENTITLEMENTS.has(key)),
  );
  assert.deepStrictEqual(fork, unrestricted);
});
