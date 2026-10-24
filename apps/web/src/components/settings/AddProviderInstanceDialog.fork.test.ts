import { describe, expect, it } from "vite-plus/test";

import { validateInstanceId } from "./AddProviderInstanceDialog.logic";

// fork: `pool_` instance ids are reserved for account pools, see FORK.md.

describe("validateInstanceId", () => {
  it("accepts a free slug and rejects duplicates", () => {
    expect(validateInstanceId("claudeAgent_work", new Set())).toBeNull();
    expect(validateInstanceId("claudeAgent_work", new Set(["claudeAgent_work"]))).toBe(
      "An instance named 'claudeAgent_work' already exists.",
    );
  });

  it("refuses ids that account pools reserve", () => {
    expect(validateInstanceId("pool_claudeAgent", new Set())).toBe(
      "Instance IDs starting with 'pool_' are reserved for account pools.",
    );
    expect(validateInstanceId("pool_anything", new Set())).not.toBeNull();
  });
});
