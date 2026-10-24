// fork: limits. Per-machine memory and CPU limits; see FORK.md.
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

const GiB = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 16_384 }));
const Percent = Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 100 }));

/**
 * A machine's limits, saved in its own server settings. A missing field uses
 * the machine's platform default, and a patch replaces the whole object, so
 * leaving a field out returns it to the default.
 */
export const ResourceLimitsSettings = Schema.Struct({
  pauseHeadroomGiB: Schema.optionalKey(GiB),
  pauseAvailableGiB: Schema.optionalKey(GiB),
  releaseHeadroomGiB: Schema.optionalKey(GiB),
  releaseAvailableGiB: Schema.optionalKey(GiB),
  criticalHeadroomGiB: Schema.optionalKey(GiB),
  pauseCpuPercent: Schema.optionalKey(Percent),
});
export type ResourceLimitsSettings = typeof ResourceLimitsSettings.Type;

export const ResourceLimitsState = Schema.Literals(["ok", "paused", "critical"]);
export type ResourceLimitsState = typeof ResourceLimitsState.Type;

export const MemoryPressureLevel = Schema.Literals(["normal", "warn", "critical"]);
export type MemoryPressureLevel = typeof MemoryPressureLevel.Type;

/** The limits in force: saved values over platform defaults. `null` means the rule is off. */
export const EffectiveResourceLimits = Schema.Struct({
  pauseHeadroomGiB: Schema.NullOr(Schema.Number),
  pauseAvailableGiB: Schema.NullOr(Schema.Number),
  releaseHeadroomGiB: Schema.NullOr(Schema.Number),
  releaseAvailableGiB: Schema.NullOr(Schema.Number),
  criticalHeadroomGiB: Schema.NullOr(Schema.Number),
  pauseCpuPercent: Schema.NullOr(Schema.Number),
  /** macOS: memory pressure pauses at "warn" and is critical at "critical". */
  usesMemoryPressure: Schema.Boolean,
});
export type EffectiveResourceLimits = typeof EffectiveResourceLimits.Type;

/** What a machine reports about its limits alongside its host resources. */
export const ResourceLimitsStatus = Schema.Struct({
  state: ResourceLimitsState,
  /** Epoch ms until which the limits are switched off, or null. */
  offUntil: Schema.NullOr(NonNegativeInt),
  waitingThreadCount: NonNegativeInt,
  sampledAt: Schema.NullOr(NonNegativeInt),
  availableBytes: Schema.NullOr(NonNegativeInt),
  commitLimitBytes: Schema.NullOr(NonNegativeInt),
  committedBytes: Schema.NullOr(NonNegativeInt),
  memoryPressure: Schema.NullOr(MemoryPressureLevel),
  /** Average over the last minute, 0 to 1. */
  cpuUtilization: Schema.NullOr(Schema.Number),
  limits: EffectiveResourceLimits,
});
export type ResourceLimitsStatus = typeof ResourceLimitsStatus.Type;
