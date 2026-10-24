import { describe, expect, it } from "vite-plus/test";

import {
  cliReleaseChannelOf,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
} from "./cliRelease.ts";

// fork: `t3 update`, server self-updates, and SSH installs follow the fork's
// X.Y.Z-alice.N releases (see FORK.md).
describe("fork CLI releases", () => {
  it("treats -alice.N releases as the stable channel", () => {
    expect(cliReleaseChannelOf("0.1.3-alice.1")).toBe("stable");
    expect(
      newestCliReleaseVersion(
        [{ tag_name: "v0.1.4-alice.1" }, { tag_name: "v0.1.3-alice.2" }],
        "stable",
      ),
    ).toBe("0.1.4-alice.1");
  });

  it("downloads from the fork, never upstream", () => {
    expect(cliReleaseDownloadBaseUrl("0.1.3-alice.1")).toBe(
      "https://github.com/3mdistal/t3code/releases/download/v0.1.3-alice.1",
    );
    expect(cliReleaseIndexPageUrl(1)).toBe(
      "https://api.github.com/repos/3mdistal/t3code/releases?per_page=100&page=1",
    );
  });
});
