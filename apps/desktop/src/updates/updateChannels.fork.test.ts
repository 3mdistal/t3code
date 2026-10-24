import { describe, expect, it } from "vite-plus/test";

import { isNightlyDesktopVersion, resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

// fork: an -alice.N install follows the latest channel, so electron-updater
// reads latest.yml from the fork's newest release (see FORK.md).
describe("fork update channel", () => {
  it("follows latest", () => {
    expect(resolveDefaultDesktopUpdateChannel("0.1.3-alice.1")).toBe("latest");
    expect(isNightlyDesktopVersion("0.1.3-alice.1")).toBe(false);
  });
});
