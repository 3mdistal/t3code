import { describe, expect, it } from "vite-plus/test";

import { parseProcessRows } from "./ProcessTree.ts";

describe("parseProcessRows", () => {
  it("reads PowerShell's lines, and skips what isn't one", () => {
    expect(
      parseProcessRows(
        "4|0|133|System\r\n\r\nnot a row\r\n8|4|134|codex.exe\r\n12|x|135|a.exe\r\n16|4|136\r\n",
      ),
    ).toEqual([
      { pid: 4, parentPid: 0, createdAt: 133, name: "System" },
      { pid: 8, parentPid: 4, createdAt: 134, name: "codex.exe" },
    ]);
  });
});
