import { describe, expect, it } from "vite-plus/test";

import { parsePressureLevel, parseTypeperfLine } from "./HostReadings.ts";
import { GiB, headroomGiB } from "./policy.ts";

describe("parseTypeperfLine", () => {
  it("reads committed bytes, commit limit, available bytes and CPU", () => {
    const line = `"10/24/2026 15:04:05.123","${122 * GiB}","${135 * GiB}","${6 * GiB}","42.5"`;
    const reading = parseTypeperfLine(line, 128 * GiB, 7)!;
    expect(headroomGiB(reading)).toBe(13);
    expect(reading).toMatchObject({
      sampledAt: 7,
      availableBytes: 6 * GiB,
      totalBytes: 128 * GiB,
      memoryPressure: null,
      cpuUtilization: 0.425,
    });
  });

  it("skips the header and lines with missing counters", () => {
    expect(
      parseTypeperfLine(
        `"(PDH-CSV 4.0)","\\\\PC\\Memory\\Committed Bytes","\\\\PC\\Memory\\Commit Limit","\\\\PC\\Memory\\Available Bytes","\\\\PC\\Processor(_Total)\\% Processor Time"`,
        GiB,
        0,
      ),
    ).toBeNull();
    expect(parseTypeperfLine(`"10/24/2026 15:04:05.123"," "," "," "," "`, GiB, 0)).toBeNull();
    expect(parseTypeperfLine("", GiB, 0)).toBeNull();
  });

  it("keeps the memory reading when only CPU is missing", () => {
    const line = `"t","${GiB}","${2 * GiB}","${GiB}"," "`;
    expect(parseTypeperfLine(line, GiB, 0)?.cpuUtilization).toBeNull();
  });
});

describe("parsePressureLevel", () => {
  it("maps the kernel's levels and nothing else", () => {
    expect(parsePressureLevel("1\n")).toBe("normal");
    expect(parsePressureLevel("2")).toBe("warn");
    expect(parsePressureLevel("4")).toBe("critical");
    expect(parsePressureLevel("")).toBeNull();
  });
});
