// fork: limits, see FORK.md.
import type { EffectiveResourceLimits } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { limitsForm, limitsPatch, limitsStateLabel } from "./MachineLimits.logic";

const windows: EffectiveResourceLimits = {
  pauseHeadroomGiB: 25,
  pauseAvailableGiB: 8,
  releaseHeadroomGiB: 35,
  releaseAvailableGiB: 12,
  criticalHeadroomGiB: 10,
  pauseCpuPercent: null,
  usesMemoryPressure: false,
};
const macos: EffectiveResourceLimits = {
  pauseHeadroomGiB: null,
  pauseAvailableGiB: null,
  releaseHeadroomGiB: null,
  releaseAvailableGiB: null,
  criticalHeadroomGiB: null,
  pauseCpuPercent: null,
  usesMemoryPressure: true,
};

describe("limitsPatch", () => {
  it("saves only the fields Alice filled in, so the rest keep following the default", () => {
    const form = { ...limitsForm({ pauseHeadroomGiB: 30 }), pauseCpuPercent: " 90 " };
    expect(limitsPatch(form, windows)).toEqual({ pauseHeadroomGiB: 30, pauseCpuPercent: 90 });
    expect(limitsPatch({ ...form, pauseHeadroomGiB: "" }, windows)).toEqual({
      pauseCpuPercent: 90,
    });
  });

  it("drops commit-charge fields on macOS, where memory pressure decides", () => {
    const form = { ...limitsForm({}), pauseHeadroomGiB: "20", pauseAvailableGiB: "4" };
    expect(limitsPatch(form, macos)).toEqual({ pauseAvailableGiB: 4 });
  });

  it("refuses values the server would reject", () => {
    const form = limitsForm({});
    expect(limitsPatch({ ...form, pauseAvailableGiB: "lots" }, windows)).toBeNull();
    expect(limitsPatch({ ...form, pauseAvailableGiB: "-1" }, windows)).toBeNull();
    expect(limitsPatch({ ...form, pauseCpuPercent: "0" }, windows)).toBeNull();
    expect(limitsPatch({ ...form, pauseCpuPercent: "101" }, windows)).toBeNull();
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
