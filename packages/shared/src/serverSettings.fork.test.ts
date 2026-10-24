import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";

// fork: the `providerPools` settings key, see FORK.md.

describe("serverSettings helpers", () => {
  it("replaces and removes provider pools per driver so concurrent edits cannot clobber", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const codex = ProviderDriverKind.make("codex");
    const pool = (...members: string[]) => ({
      enabled: true,
      memberInstanceIds: members.map((member) => ProviderInstanceId.make(member)),
    });
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      providerPools: { [claude]: pool("claudeAgent", "claudeAgent_icloud", "claudeAgent_work") },
    };

    const added = applyServerSettingsPatch(current, {
      providerPools: { [codex]: pool("codex", "codex_2") },
    });
    expect(added.providerPools).toEqual({
      [claude]: pool("claudeAgent", "claudeAgent_icloud", "claudeAgent_work"),
      [codex]: pool("codex", "codex_2"),
    });

    const replaced = applyServerSettingsPatch(added, {
      providerPools: { [claude]: pool("claudeAgent_icloud"), [codex]: null },
    });
    expect(replaced.providerPools).toEqual({ [claude]: pool("claudeAgent_icloud") });
  });
});
