import { describe, expect, it } from "vite-plus/test";

import { compareStableTags, newestStableTag, nextForkVersion } from "./versions.ts";

describe("fork versions", () => {
  it("picks the newest stable tag and ignores nightlies, previews, and fork releases", () => {
    expect(
      newestStableTag([
        "v0.1.2",
        "v0.1.10",
        "v0.1.9",
        "v0.1.11-nightly.20261101.4000",
        "v0.1.11-preview.20261101.3999",
        "v0.1.10-alice.3",
      ]),
    ).toBe("v0.1.10");
    expect(compareStableTags("v1.0.0", "v0.99.99")).toBeGreaterThan(0);
  });

  it("counts releases per base version", () => {
    expect(nextForkVersion("v0.1.3", [])).toBe("0.1.3-alice.1");
    expect(
      nextForkVersion("v0.1.3", [
        "v0.1.3-alice.1",
        "v0.1.3-alice.10",
        "v0.1.3-alice.2",
        "v0.1.2-alice.40",
        "v0.1.3",
      ]),
    ).toBe("0.1.3-alice.11");
    expect(nextForkVersion("v0.1.4", ["v0.1.3-alice.11"])).toBe("0.1.4-alice.1");
  });
});
