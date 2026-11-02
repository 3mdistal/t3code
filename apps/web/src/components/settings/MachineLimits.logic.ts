// fork: limits, see FORK.md.
import {
  type EffectiveResourceLimits,
  resolveResourceLimits,
  type ResourceLimitsSettings,
  type ResourceLimitsStatus,
  usePercentFor,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

const GiB = 1024 ** 3;
const gib = (value: number) => `${Math.round(value)} GiB`;

/** How full a machine is with this much left, as a share of its RAM. */
const fullAt = (leftGiB: number, totalBytes: number) =>
  Math.min(100, Math.max(0, Math.round(100 - ((leftGiB * GiB) / totalBytes) * 100)));

/** "Left" is commit headroom where there's a commit charge, and available memory on macOS. */
const amountLeft = (limits: EffectiveResourceLimits, leftGiB: number, resolve: MessageResolver) =>
  limits.usesMemoryPressure
    ? resolve(msg("{amount} available", { amount: gib(leftGiB) }))
    : resolve(msg("{amount} left", { amount: gib(leftGiB) }));

export function limitsStateLabel(
  status: Pick<ResourceLimitsStatus, "state" | "offUntil" | "pause" | "waitingThreadCount">,
  formatUntil: (epochMs: number) => string,
  resolve: MessageResolver = m,
): string {
  const state =
    status.pause !== undefined
      ? status.pause.mode === "stop"
        ? resolve(msg("All agents stopped"))
        : resolve(msg("All agents paused"))
      : status.offUntil !== null
        ? resolve(msg("Off until {time}", { time: formatUntil(status.offUntil) }))
        : status.state === "ok"
          ? resolve(msg("Within limits"))
          : status.state === "paused"
            ? resolve(msg("Paused"))
            : resolve(msg("Critically low on memory"));
  const waiting = status.waitingThreadCount;
  return waiting === 0
    ? state
    : resolve(
        msg(
          "{count, plural, one {{state} · {count} thread waiting} other {{state} · {count} threads waiting}}",
          { state, count: waiting },
        ),
      );
}

/** How full the machine is, measured the way its own lines measure it. */
export function usageLabel(
  status: ResourceLimitsStatus,
  totalBytes: number,
  resolve: MessageResolver = m,
): string {
  const leftBytes = status.limits.usesMemoryPressure
    ? status.availableBytes
    : status.commitLimitBytes === null || status.committedBytes === null
      ? null
      : status.commitLimitBytes - status.committedBytes;
  if (status.sampledAt === null || leftBytes === null) return resolve(msg("no readings yet"));
  const left = leftBytes / GiB;
  // Windows also holds on available memory, which the percentage alone doesn't show.
  const percent = fullAt(left, totalBytes);
  const leftText = amountLeft(status.limits, left, resolve);
  const usage =
    status.state === "ok" || status.limits.usesMemoryPressure || status.availableBytes === null
      ? resolve(msg("{percent}% in use ({left})", { percent, left: leftText }))
      : resolve(
          msg("{percent}% in use ({left}, {available} available)", {
            percent,
            left: leftText,
            available: gib(status.availableBytes / GiB),
          }),
        );
  return status.limits.pauseCpuPercent === null || status.cpuUtilization === null
    ? usage
    : resolve(msg("{usage} · CPU {cpu}%", { usage, cpu: Math.round(status.cpuUtilization * 100) }));
}

const MEMORY_LINES = [
  "pauseHeadroomGiB",
  "pauseAvailableGiB",
  "releaseHeadroomGiB",
  "releaseAvailableGiB",
  "criticalHeadroomGiB",
] as const;

/** When the machine holds new agent work, read from the lines in force. */
export function holdLabel(
  limits: EffectiveResourceLimits,
  saved: ResourceLimitsSettings,
  totalBytes: number,
  resolve: MessageResolver = m,
): string {
  const line = limits.usesMemoryPressure ? limits.pauseAvailableGiB : limits.pauseHeadroomGiB;
  const when = [
    line === null ? null : resolve(msg("at {percent}%", { percent: fullAt(line, totalBytes) })),
    limits.usesMemoryPressure ? resolve(msg("when memory pressure warns")) : null,
    limits.pauseCpuPercent === null
      ? null
      : resolve(msg("over {percent}% CPU", { percent: limits.pauseCpuPercent })),
  ].filter((part) => part !== null);
  if (when.length === 0) return resolve(msg("Never holds new agent work"));
  const conditions = when.join(", or ");
  return MEMORY_LINES.some((key) => saved[key] !== undefined)
    ? resolve(msg("Holds new agent work {conditions} (custom lines)", { conditions }))
    : resolve(msg("Holds new agent work {conditions}", { conditions }));
}

export interface Consequence {
  readonly text: string;
  readonly detail: string;
}

/** What the memory lines do, in the order a filling machine meets them. */
export function consequences(
  limits: EffectiveResourceLimits,
  totalBytes: number,
  resolve: MessageResolver = m,
): ReadonlyArray<Consequence> {
  const hold = limits.usesMemoryPressure ? limits.pauseAvailableGiB : limits.pauseHeadroomGiB;
  const release = limits.usesMemoryPressure
    ? limits.releaseAvailableGiB
    : limits.releaseHeadroomGiB;
  return [
    hold === null
      ? null
      : {
          text: resolve(
            msg("Holds new agent work at {percent}%", { percent: fullAt(hold, totalBytes) }),
          ),
          detail: resolve(msg("under {amount}", { amount: amountLeft(limits, hold, resolve) })),
        },
    release === null
      ? null
      : {
          text: resolve(
            msg("Starts it again under {percent}%", { percent: fullAt(release, totalBytes) }),
          ),
          detail: resolve(msg("over {amount}", { amount: amountLeft(limits, release, resolve) })),
        },
    limits.criticalHeadroomGiB === null
      ? null
      : {
          text: resolve(
            msg("Stops the newest turn at {percent}%", {
              percent: fullAt(limits.criticalHeadroomGiB, totalBytes),
            }),
          ),
          detail: resolve(
            msg("under {amount}", {
              amount: amountLeft(limits, limits.criticalHeadroomGiB, resolve),
            }),
          ),
        },
  ].filter((line) => line !== null);
}

type LineKey = Exclude<keyof ResourceLimitsSettings, "usePercent">;

const LINE_FIELDS = [
  {
    key: "pauseHeadroomGiB",
    label: msg("Hold new work under"),
    unit: "GiB left",
    commitOnly: true,
  },
  {
    key: "pauseAvailableGiB",
    label: msg("…or under"),
    macLabel: msg("Hold new work under"),
    unit: "GiB available",
  },
  { key: "releaseHeadroomGiB", label: msg("Start again over"), unit: "GiB left", commitOnly: true },
  {
    key: "releaseAvailableGiB",
    label: msg("…and over"),
    macLabel: msg("Start again over"),
    unit: "GiB available",
  },
  {
    key: "criticalHeadroomGiB",
    label: msg("Stop the newest turn under"),
    unit: "GiB left",
    commitOnly: true,
  },
  { key: "pauseCpuPercent", label: msg("Hold new work over CPU"), unit: "%" },
] as const satisfies ReadonlyArray<{
  readonly key: LineKey;
  readonly label: string;
  readonly macLabel?: string;
  readonly unit: string;
  readonly commitOnly?: true;
}>;

/** The line fields a machine uses: macOS has no commit charge, so its headroom lines don't apply. */
export const limitFieldsFor = (commitCharge: boolean, resolve: MessageResolver = m) =>
  LINE_FIELDS.filter((field) => commitCharge || !("commitOnly" in field)).map((field) => ({
    key: field.key,
    unit: field.unit,
    label: resolve(!commitCharge && "macLabel" in field ? field.macLabel : field.label),
  }));

export interface LimitsForm {
  /** Null on macOS while memory pressure alone decides. */
  readonly usePercent: number | null;
  /** Only saved lines, so an untouched line keeps following the percentage. */
  readonly lines: Readonly<Record<LineKey, string>>;
}

export const limitsForm = (saved: ResourceLimitsSettings, commitCharge: boolean): LimitsForm => ({
  usePercent: usePercentFor(saved, commitCharge),
  lines: Object.fromEntries(
    LINE_FIELDS.map(({ key }) => [key, saved[key] === undefined ? "" : String(saved[key])]),
  ) as Record<LineKey, string>,
});

/**
 * The limits to save, or null while a line isn't a number the server accepts. The percentage is
 * saved only when it differs from the machine's default, and an empty line follows it.
 */
export function limitsPatch(
  form: LimitsForm,
  commitCharge: boolean,
): ResourceLimitsSettings | null {
  const patch: Record<string, number> = {};
  if (form.usePercent !== null && form.usePercent !== usePercentFor({}, commitCharge)) {
    patch.usePercent = form.usePercent;
  }
  for (const { key, unit } of limitFieldsFor(commitCharge)) {
    const text = form.lines[key].trim();
    if (text === "") continue;
    const value = Number(text);
    const valid =
      Number.isFinite(value) && (unit === "%" ? value >= 1 && value <= 100 : value >= 0);
    if (!valid) return null;
    patch[key] = value;
  }
  return patch;
}

/** The lines the percentage alone sets, which empty fields follow. */
export const percentOnlyLimits = (form: LimitsForm, commitCharge: boolean, totalBytes: number) =>
  resolveResourceLimits(
    form.usePercent === null ? {} : { usePercent: form.usePercent },
    commitCharge,
    totalBytes,
  );

/** What saving the form would put in force, skipping lines that aren't valid yet. */
export const previewLimits = (form: LimitsForm, commitCharge: boolean, totalBytes: number) => {
  const patch = limitsPatch(form, commitCharge);
  return patch === null
    ? percentOnlyLimits(form, commitCharge, totalBytes)
    : resolveResourceLimits(patch, commitCharge, totalBytes);
};
