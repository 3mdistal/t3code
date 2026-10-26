// fork: limits, see FORK.md.
import { resolveResourceLimits, type ResourceLimitsStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  consequences,
  holdLabel,
  limitsForm,
  limitsPatch,
  limitsStateLabel,
  previewLimits,
  usageLabel,
} from "./MachineLimits.logic";

const GiB = 1024 ** 3;
const pc = 128 * GiB;
const mac = 64 * GiB;

const status = (overrides: Partial<ResourceLimitsStatus>): ResourceLimitsStatus => ({
  state: "ok",
  offUntil: null,
  waitingThreadCount: 0,
  sampledAt: 1,
  availableBytes: 40 * GiB,
  commitLimitBytes: 136 * GiB,
  committedBytes: 72 * GiB,
  memoryPressure: null,
  cpuUtilization: 0.4,
  limits: resolveResourceLimits({}, true, pc),
  ...overrides,
});

describe("limitsPatch", () => {
  it("saves the percentage only when it differs from the machine's default", () => {
    expect(limitsPatch(limitsForm({}, true), true)).toEqual({});
    expect(limitsPatch({ ...limitsForm({}, true), usePercent: 70 }, true)).toEqual({
      usePercent: 70,
    });
    expect(limitsPatch(limitsForm({}, false), false)).toEqual({});
    expect(limitsPatch({ ...limitsForm({}, false), usePercent: 80 }, false)).toEqual({
      usePercent: 80,
    });
  });

  it("saves only the lines Alice filled in, so the rest keep following the percentage", () => {
    const form = limitsForm({ pauseHeadroomGiB: 30 }, true);
    const lines = { ...form.lines, pauseCpuPercent: " 90 " };
    expect(limitsPatch({ ...form, lines }, true)).toEqual({
      pauseHeadroomGiB: 30,
      pauseCpuPercent: 90,
    });
    expect(limitsPatch({ ...form, lines: { ...lines, pauseHeadroomGiB: "" } }, true)).toEqual({
      pauseCpuPercent: 90,
    });
  });

  it("drops commit-charge lines on macOS, which has none", () => {
    const form = limitsForm({}, false);
    const lines = { ...form.lines, pauseHeadroomGiB: "20", pauseAvailableGiB: "4" };
    expect(limitsPatch({ ...form, lines }, false)).toEqual({ pauseAvailableGiB: 4 });
  });

  it("refuses values the server would reject", () => {
    const form = limitsForm({}, true);
    const patch = (key: keyof typeof form.lines, value: string) =>
      limitsPatch({ ...form, lines: { ...form.lines, [key]: value } }, true);
    expect(patch("pauseAvailableGiB", "lots")).toBeNull();
    expect(patch("pauseAvailableGiB", "-1")).toBeNull();
    expect(patch("pauseCpuPercent", "0")).toBeNull();
    expect(patch("pauseCpuPercent", "101")).toBeNull();
  });
});

describe("previewLimits", () => {
  it("lets a filled line win over the one the slider sets", () => {
    const form = { ...limitsForm({}, true), usePercent: 70 };
    const filled = { ...form, lines: { ...form.lines, pauseHeadroomGiB: "20" } };
    expect(previewLimits(form, true, pc).pauseHeadroomGiB).toBe(38.4);
    expect(previewLimits(filled, true, pc).pauseHeadroomGiB).toBe(20);
    expect(consequences(previewLimits(filled, true, pc), pc)[0]).toEqual({
      text: "Holds new agent work at 84%",
      detail: "under 20 GiB left",
    });
  });
});

describe("holdLabel", () => {
  it("reads the hold point from the line in force", () => {
    expect(holdLabel(resolveResourceLimits({ usePercent: 70 }, true, pc), {}, pc)).toBe(
      "Holds new agent work at 70%",
    );
    const custom = { pauseHeadroomGiB: 32 };
    expect(holdLabel(resolveResourceLimits(custom, true, pc), custom, pc)).toBe(
      "Holds new agent work at 75% (custom lines)",
    );
  });

  it("names macOS memory pressure, and the percentage once one is saved", () => {
    expect(holdLabel(resolveResourceLimits({}, false, mac), {}, mac)).toBe(
      "Holds new agent work when memory pressure warns",
    );
    const saved = { usePercent: 80, pauseCpuPercent: 90 };
    expect(holdLabel(resolveResourceLimits(saved, false, mac), saved, mac)).toBe(
      "Holds new agent work at 80%, or when memory pressure warns, or over 90% CPU",
    );
  });
});

describe("usageLabel", () => {
  it("measures a Windows machine by commit headroom and a Mac by available memory", () => {
    expect(usageLabel(status({}), pc)).toBe("50% in use (64 GiB left)");
    expect(
      usageLabel(
        status({
          availableBytes: 38.4 * GiB,
          commitLimitBytes: null,
          committedBytes: null,
          memoryPressure: "normal",
          limits: resolveResourceLimits({}, false, mac),
        }),
        mac,
      ),
    ).toBe("40% in use (38 GiB available)");
  });

  it("adds available memory while a Windows machine holds work, since that line can hold it too", () => {
    expect(usageLabel(status({ state: "paused", availableBytes: 7 * GiB }), pc)).toBe(
      "50% in use (64 GiB left, 7 GiB available)",
    );
  });

  it("shows CPU only where a CPU line is set", () => {
    const limits = resolveResourceLimits({ pauseCpuPercent: 90 }, true, pc);
    expect(usageLabel(status({ limits }), pc)).toBe("50% in use (64 GiB left) · CPU 40%");
  });
});

describe("limitsStateLabel", () => {
  const until = (epochMs: number) => `at ${epochMs}`;

  it("puts a switched-off machine first, whatever its readings say", () => {
    expect(limitsStateLabel({ state: "paused", offUntil: 5, waitingThreadCount: 0 }, until)).toBe(
      "Off until at 5",
    );
  });

  it("counts waiting threads beside the state", () => {
    expect(
      limitsStateLabel({ state: "critical", offUntil: null, waitingThreadCount: 1 }, until),
    ).toBe("Critically low on memory · 1 thread waiting");
    expect(limitsStateLabel({ state: "ok", offUntil: null, waitingThreadCount: 3 }, until)).toBe(
      "Within limits · 3 threads waiting",
    );
  });
});
