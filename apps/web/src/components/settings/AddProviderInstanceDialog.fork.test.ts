import { describe, expect, it } from "vite-plus/test";

import { reservedInstanceIdError } from "./AddProviderInstanceDialog.logic";

describe("reservedInstanceIdError", () => {
  it("accepts an ordinary instance id", () => {
    expect(reservedInstanceIdError("claudeAgent_work")).toBeNull();
  });

  it("refuses ids that account pools reserve", () => {
    expect(reservedInstanceIdError("pool_claudeAgent")).toBe(
      "Instance IDs starting with 'pool_' are reserved for account pools.",
    );
    expect(reservedInstanceIdError("pool_anything")).not.toBeNull();
  });
});
