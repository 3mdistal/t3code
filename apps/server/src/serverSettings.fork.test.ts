import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  providerPoolInstanceId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const work = ProviderInstanceId.make("claudeAgent_work");
const home = ProviderInstanceId.make("claudeAgent_home");
const pool = providerPoolInstanceId(claude);
const projectId = ProjectId.make("project:pooled");

const layerServerSettings = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

// Stock T3 has no pools: a saved pool id would make it fall back to another provider, so saving
// stores the pool's first enabled account, which the fork still routes through the pool.
it.effect("saves every model choice that names a pool on the pool's first enabled account", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
    const pooled = (model: string) => ({
      instanceId: pool,
      model,
      options: [{ id: "effort", value: "high" }],
    });

    const next = yield* serverSettings.updateSettings({
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent_old")]: { driver: claude, enabled: false },
        [work]: { driver: claude, enabled: true },
        [home]: { driver: claude, enabled: true },
      },
      providerPools: {
        [claude]: {
          enabled: true,
          memberInstanceIds: [ProviderInstanceId.make("claudeAgent_old"), work, home],
        },
      },
      defaultModelSelection: pooled("claude-opus-4-8"),
      textGenerationModelSelection: pooled("claude-haiku-4-5"),
      sourceControlWriterModelSelection: pooled("claude-sonnet-4-6"),
      reviewGuideModelSelection: pooled("claude-sonnet-4-6"),
      projectSettingsOverrides: {
        [projectId]: { defaultModelSelection: pooled("claude-opus-4-8") },
      },
    });

    const onWork = (model: string) => ({ ...pooled(model), instanceId: work });
    assert.deepStrictEqual(next.defaultModelSelection, onWork("claude-opus-4-8"));
    assert.deepStrictEqual(next.textGenerationModelSelection, onWork("claude-haiku-4-5"));
    assert.deepStrictEqual(next.sourceControlWriterModelSelection, onWork("claude-sonnet-4-6"));
    assert.deepStrictEqual(next.reviewGuideModelSelection, onWork("claude-sonnet-4-6"));
    assert.deepStrictEqual(
      next.projectSettingsOverrides[projectId]?.defaultModelSelection,
      onWork("claude-opus-4-8"),
    );
  }).pipe(Effect.provide(ServerSettingsModule.layerTest())),
);

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("refuses a pool whose members are unknown, repeated, or on another driver", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const claude = ProviderDriverKind.make("claudeAgent");
      yield* service.updateProviderInstance({
        operation: "create",
        instanceId: ProviderInstanceId.make("claudeAgent_work"),
        instance: { driver: claude, config: {} },
      });
      for (const members of [
        ["claudeAgent", "claudeAgent_missing"],
        ["claudeAgent", "claudeAgent"],
        ["claudeAgent", "codex"],
      ]) {
        const result = yield* service
          .updateSettings({
            providerPools: {
              [claude]: {
                enabled: true,
                memberInstanceIds: members.map((member) => ProviderInstanceId.make(member)),
              },
            },
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure", members.join(","));
        if (result._tag === "Failure") {
          assert.equal(result.failure.operation, "validate-provider-pool");
          assert.equal(result.failure.providerInstanceId, members[1]);
        }
      }
      assert.deepEqual((yield* service.getSettings).providerPools, {});
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("pools a built-in default with a configured account and prunes a removed one", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const claude = ProviderDriverKind.make("claudeAgent");
      const work = ProviderInstanceId.make("claudeAgent_work");
      yield* service.updateProviderInstance({
        operation: "create",
        instanceId: work,
        instance: { driver: claude, config: {} },
      });
      const pooled = yield* service.updateSettings({
        providerPools: {
          [claude]: {
            enabled: true,
            memberInstanceIds: [ProviderInstanceId.make("claudeAgent"), work],
          },
        },
      });
      assert.deepEqual(pooled.providerPools[claude]?.memberInstanceIds, [
        ProviderInstanceId.make("claudeAgent"),
        work,
      ]);

      const removed = yield* service.updateProviderInstance({
        operation: "remove",
        instanceId: work,
      });
      assert.deepEqual(removed.providerPools[claude]?.memberInstanceIds, [
        ProviderInstanceId.make("claudeAgent"),
      ]);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("reserves the pool id prefix for pools", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      for (const operation of ["create", "upsert"] as const) {
        const result = yield* service
          .updateProviderInstance({
            operation,
            instanceId: ProviderInstanceId.make("pool_claudeAgent"),
            instance: { driver: ProviderDriverKind.make("claudeAgent"), config: {} },
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure", operation);
      }
    }).pipe(Effect.provide(layerServerSettings())),
  );
});
