import {
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolvePendingHandoff, type HandoffTimelineRun } from "./handoff.ts";

// fork: a pool that holds the account that last ran is no handoff, see FORK.md.

const from = ProviderInstanceId.make("codex_personal");
const to = ProviderInstanceId.make("claudeAgent");
const run = (
  id: string,
  ordinal: number,
  instanceId: ProviderInstanceId,
  model: string,
): HandoffTimelineRun => ({
  id: RunId.make(id),
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model },
});

const projection = {
  runs: [{ ...run("source", 1, from, "source"), startedAt: "2026-10-11T00:00:00Z" }],
  visibleTurnItems: [{ item: { type: "user_message" } }],
} as unknown as OrchestrationV2ThreadProjection;

describe("pending context handoff", () => {
  it("predicts no handoff when the target pool contains the account that last ran", () => {
    const poolId = ProviderInstanceId.make("pool_codex");
    const providers = [
      { instanceId: from, driver: "codex", requiresNewThreadForModelChange: false },
      {
        instanceId: poolId,
        driver: "codex",
        continuation: undefined,
        pool: { role: "pool", memberInstanceIds: [from, to], droppedModels: [] },
      },
    ] as unknown as ServerProvider[];
    expect(
      resolvePendingHandoff(projection, { instanceId: poolId, model: "other" }, providers),
    ).toBeNull();
  });
  it("still previews a fresh native thread when a pooled model change requires one", () => {
    const poolId = ProviderInstanceId.make("pool_codex");
    const providers = [
      { instanceId: from, driver: "codex", requiresNewThreadForModelChange: true },
      {
        instanceId: poolId,
        driver: "codex",
        pool: { role: "pool", memberInstanceIds: [from, to], droppedModels: [] },
      },
    ] as unknown as ServerProvider[];
    expect(
      resolvePendingHandoff(projection, { instanceId: poolId, model: "other" }, providers)?.to
        .model,
    ).toBe("other");
    expect(
      resolvePendingHandoff(projection, { instanceId: poolId, model: "source" }, providers),
    ).toBeNull();
  });
  it("predicts a handoff to a pool that does not contain the account that last ran", () => {
    const poolId = ProviderInstanceId.make("pool_claudeAgent");
    const providers = [
      { instanceId: from, driver: "codex", continuation: { groupKey: "codex:home:a" } },
      {
        instanceId: poolId,
        driver: "claudeAgent",
        pool: { role: "pool", memberInstanceIds: [to], droppedModels: [] },
      },
    ] as unknown as ServerProvider[];
    expect(
      resolvePendingHandoff(projection, { instanceId: poolId, model: "first" }, providers)?.to
        .instanceId,
    ).toBe(poolId);
  });
});
