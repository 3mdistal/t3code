// fork: limits. Per-machine memory and CPU limits; see FORK.md.
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

const GiB = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 16_384 }));
const Percent = Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 100 }));

export const USE_PERCENT = { minimum: 50, maximum: 90, default: 80 } as const;

/**
 * A machine's limits, saved in its own server settings. A missing field uses
 * the machine's platform default, and a patch replaces the whole object, so
 * leaving a field out returns it to the default. `usePercent` sets every
 * memory line at once; a saved line wins over the one it sets.
 */
export const ResourceLimitsSettings = Schema.Struct({
  usePercent: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: USE_PERCENT.minimum, maximum: USE_PERCENT.maximum }),
    ),
  ),
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

/** The limits in force: saved lines over the percentage's. `null` means the rule is off. */
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

/**
 * The percentage in force: macOS has none until one is saved, because its memory pressure already
 * decides there and an available-memory line may hold work the pressure level wouldn't.
 */
export const usePercentFor = (saved: ResourceLimitsSettings, commitCharge: boolean) =>
  saved.usePercent ?? (commitCharge ? USE_PERCENT.default : null);

/**
 * The limits a machine's saved settings put in force. "Use up to N%" keeps a reserve of
 * (100 - N)% of RAM, and each memory line is the reserve times one of the memory gate's ratios,
 * so 80% of the PC's 128 GiB gives its 25 / 8 GiB pause, 35 / 12 GiB release and 10 GiB critical
 * lines. "Left" is commit headroom with a commit charge (Windows) and available memory without
 * one (macOS), where memory pressure decides what's critical. A saved line wins over its derived
 * one.
 */
export function resolveResourceLimits(
  saved: ResourceLimitsSettings,
  commitCharge: boolean,
  totalBytes: number,
): EffectiveResourceLimits {
  const percent = usePercentFor(saved, commitCharge);
  const reserve = percent === null ? null : ((100 - percent) / 100) * (totalBytes / 2 ** 30);
  const line = (ratio: number) => (reserve === null ? null : Math.round(reserve * ratio * 10) / 10);
  return commitCharge
    ? {
        pauseHeadroomGiB: saved.pauseHeadroomGiB ?? line(1),
        pauseAvailableGiB: saved.pauseAvailableGiB ?? line(0.32),
        releaseHeadroomGiB: saved.releaseHeadroomGiB ?? line(1.4),
        releaseAvailableGiB: saved.releaseAvailableGiB ?? line(0.48),
        criticalHeadroomGiB: saved.criticalHeadroomGiB ?? line(0.4),
        pauseCpuPercent: saved.pauseCpuPercent ?? null,
        usesMemoryPressure: false,
      }
    : {
        pauseHeadroomGiB: null,
        pauseAvailableGiB: saved.pauseAvailableGiB ?? line(1),
        releaseHeadroomGiB: null,
        releaseAvailableGiB: saved.releaseAvailableGiB ?? line(1.4),
        criticalHeadroomGiB: null,
        pauseCpuPercent: saved.pauseCpuPercent ?? null,
        usesMemoryPressure: true,
      };
}

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
