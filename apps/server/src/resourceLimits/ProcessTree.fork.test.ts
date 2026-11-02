import { describe, expect, it } from "vite-plus/test";

import { parseProcessRows } from "./ProcessTree.ts";

describe("parseProcessRows", () => {
  it("reads PowerShell's lines, and skips what isn't one", () => {
    expect(parseProcessRows("4|0|133\r\n\r\nnot a row\r\n8|4|134\r\n12|x|135\r\n")).toEqual([
      { pid: 4, parentPid: 0, createdAt: 133 },
      { pid: 8, parentPid: 4, createdAt: 134 },
    ]);
  });
});
