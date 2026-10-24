import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  providerPoolInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ServerSettingsModule from "./serverSettings.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const work = ProviderInstanceId.make("claudeAgent_work");
const home = ProviderInstanceId.make("claudeAgent_home");
const pool = providerPoolInstanceId(claude);
const projectId = ProjectId.make("project:pooled");

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
