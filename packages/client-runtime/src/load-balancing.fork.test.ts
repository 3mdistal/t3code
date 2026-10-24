// fork: limits, see FORK.md.
import type { ResourceLimitsStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { chooseLoadBalancedEnvironment } from "./load-balancing.ts";

describe("load balancing with memory limits", () => {
  const now = 100_000;
  const limits = (state: ResourceLimitsStatus["state"]): ResourceLimitsStatus => ({
    state,
    offUntil: null,
    waitingThreadCount: 0,
    sampledAt: now,
    availableBytes: 8_000,
    commitLimitBytes: null,
    committedBytes: null,
    memoryPressure: "normal",
    cpuUtilization: 0.2,
    limits: {
      pauseHeadroomGiB: null,
      pauseAvailableGiB: null,
      releaseHeadroomGiB: null,
      releaseAvailableGiB: null,
      criticalHeadroomGiB: null,
      pauseCpuPercent: null,
      usesMemoryPressure: true,
    },
  });
  const machine = (
    environmentId: string,
    cpuCount: number,
    state?: ResourceLimitsStatus["state"],
  ) => ({
    environmentId,
    weight: 1,
    resources: {
      sampledAt: now,
      cpuUtilization: 0.2,
      cpuCount,
      availableMemoryBytes: 8_000,
      totalMemoryBytes: 16_000,
      ...(state === undefined ? {} : { limits: limits(state) }),
    },
  });

  it("skips a machine over its limits, however much room it reports", () => {
    expect(
      chooseLoadBalancedEnvironment(
        [
          machine("paused", 32, "paused"),
          machine("critical", 32, "critical"),
          machine("ok", 4, "ok"),
        ],
        now,
      ),
    ).toBe("ok");
    expect(chooseLoadBalancedEnvironment([machine("paused", 32, "paused")], now)).toBeNull();
  });

  it("still balances onto machines without limits", () => {
    expect(
      chooseLoadBalancedEnvironment([machine("paused", 32, "paused"), machine("stock", 4)], now),
    ).toBe("stock");
  });
});
