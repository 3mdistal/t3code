// fork: limits, see FORK.md.
import {
  type EffectiveResourceLimits,
  resolveResourceLimits,
  type ResourceLimitsSettings,
  type ResourceLimitsStatus,
  usePercentFor,
} from "@t3tools/contracts";

const GiB = 1024 ** 3;
const gib = (value: number) => `${Math.round(value)} GiB`;

/** How full a machine is with this much left, as a share of its RAM. */
const fullAt = (leftGiB: number, totalBytes: number) =>
  Math.min(100, Math.max(0, Math.round(100 - ((leftGiB * GiB) / totalBytes) * 100)));

/** "Left" is commit headroom where there's a commit charge, and available memory on macOS. */
const leftWord = (limits: EffectiveResourceLimits) =>
  limits.usesMemoryPressure ? "available" : "left";

export function limitsStateLabel(
  status: Pick<ResourceLimitsStatus, "state" | "offUntil" | "waitingThreadCount">,
  formatUntil: (epochMs: number) => string,
): string {
  const state =
    status.offUntil !== null
      ? `Off until ${formatUntil(status.offUntil)}`
      : status.state === "ok"
        ? "Within limits"
        : status.state === "paused"
          ? "Paused"
          : "Critically low on memory";
  const waiting = status.waitingThreadCount;
  return waiting === 0
    ? state
    : `${state} · ${waiting} ${waiting === 1 ? "thread" : "threads"} waiting`;
}

/** How full the machine is, measured the way its own lines measure it. */
export function usageLabel(status: ResourceLimitsStatus, totalBytes: number): string {
  const leftBytes = status.limits.usesMemoryPressure
    ? status.availableBytes
    : status.commitLimitBytes === null || status.committedBytes === null
      ? null
      : status.commitLimitBytes - status.committedBytes;
  if (status.sampledAt === null || leftBytes === null) return "no readings yet";
  const left = leftBytes / GiB;
  // Windows also holds on available memory, which the percentage alone doesn't show.
  const available =
    status.state === "ok" || status.limits.usesMemoryPressure || status.availableBytes === null
      ? ""
      : `, ${gib(status.availableBytes / GiB)} available`;
  const usage = `${fullAt(left, totalBytes)}% in use (${gib(left)} ${leftWord(status.limits)}${available})`;
  return status.limits.pauseCpuPercent === null || status.cpuUtilization === null
    ? usage
    : `${usage} · CPU ${Math.round(status.cpuUtilization * 100)}%`;
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
): string {
  const line = limits.usesMemoryPressure ? limits.pauseAvailableGiB : limits.pauseHeadroomGiB;
  const when = [
    line === null ? null : `at ${fullAt(line, totalBytes)}%`,
    limits.usesMemoryPressure ? "when memory pressure warns" : null,
    limits.pauseCpuPercent === null ? null : `over ${limits.pauseCpuPercent}% CPU`,
  ].filter((part) => part !== null);
  const custom = MEMORY_LINES.some((key) => saved[key] !== undefined) ? " (custom lines)" : "";
  return when.length === 0
    ? "Never holds new agent work"
    : `Holds new agent work ${when.join(", or ")}${custom}`;
}

export interface Consequence {
  readonly text: string;
  readonly detail: string;
}

/** What the memory lines do, in the order a filling machine meets them. */
export function consequences(
  limits: EffectiveResourceLimits,
  totalBytes: number,
): ReadonlyArray<Consequence> {
  const word = leftWord(limits);
  const hold = limits.usesMemoryPressure ? limits.pauseAvailableGiB : limits.pauseHeadroomGiB;
  const release = limits.usesMemoryPressure
    ? limits.releaseAvailableGiB
    : limits.releaseHeadroomGiB;
  return [
    hold === null
      ? null
      : {
          text: `Holds new agent work at ${fullAt(hold, totalBytes)}%`,
          detail: `under ${gib(hold)} ${word}`,
        },
    release === null
      ? null
      : {
          text: `Starts it again under ${fullAt(release, totalBytes)}%`,
          detail: `over ${gib(release)} ${word}`,
        },
    limits.criticalHeadroomGiB === null
      ? null
      : {
          text: `Stops the newest turn at ${fullAt(limits.criticalHeadroomGiB, totalBytes)}%`,
          detail: `under ${gib(limits.criticalHeadroomGiB)} ${word}`,
        },
  ].filter((line) => line !== null);
}

type LineKey = Exclude<keyof ResourceLimitsSettings, "usePercent">;

const LINE_FIELDS = [
  { key: "pauseHeadroomGiB", label: "Hold new work under", unit: "GiB left", commitOnly: true },
  {
    key: "pauseAvailableGiB",
    label: "…or under",
    macLabel: "Hold new work under",
    unit: "GiB available",
  },
  { key: "releaseHeadroomGiB", label: "Start again over", unit: "GiB left", commitOnly: true },
  {
    key: "releaseAvailableGiB",
    label: "…and over",
    macLabel: "Start again over",
    unit: "GiB available",
  },
  {
    key: "criticalHeadroomGiB",
    label: "Stop the newest turn under",
    unit: "GiB left",
    commitOnly: true,
  },
  { key: "pauseCpuPercent", label: "Hold new work over CPU", unit: "%" },
] as const satisfies ReadonlyArray<{
  readonly key: LineKey;
  readonly label: string;
  readonly macLabel?: string;
  readonly unit: string;
  readonly commitOnly?: true;
}>;

/** The line fields a machine uses: macOS has no commit charge, so its headroom lines don't apply. */
export const limitFieldsFor = (commitCharge: boolean) =>
  LINE_FIELDS.filter((field) => commitCharge || !("commitOnly" in field)).map((field) => ({
    key: field.key,
    unit: field.unit,
    label: !commitCharge && "macLabel" in field ? field.macLabel : field.label,
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
