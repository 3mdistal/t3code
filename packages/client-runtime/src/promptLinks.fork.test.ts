import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePromptLinkModelSelection } from "./promptLinks.ts";

// fork: a prompt link picks the pool that stands in for its accounts, see FORK.md.

describe("resolvePromptLinkModelSelection", () => {
  const provider = (
    instanceId: string,
    driver: string,
    status: "ready" | "warning" | "error" | "disabled" = "ready",
  ) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    status,
    models: [
      { slug: "small", name: "Small" },
      { slug: "big", name: "Big", aliases: ["opus"], isDefault: true },
    ],
  });

  it("resolves a driver to its active pool rather than a hidden member", () => {
    const providers = [
      {
        ...provider("claudeAgent", "claudeAgent"),
        pool: {
          role: "member" as const,
          poolInstanceId: ProviderInstanceId.make("pool_claudeAgent"),
        },
      },
      {
        ...provider("pool_claudeAgent", "claudeAgent"),
        pool: {
          role: "pool" as const,
          memberInstanceIds: [ProviderInstanceId.make("claudeAgent")],
          droppedModels: [],
        },
      },
    ];
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "claude", model: "small" }),
    ).toEqual({
      selection: { instanceId: "pool_claudeAgent", model: "small" },
      exact: true,
    });
  });
});
