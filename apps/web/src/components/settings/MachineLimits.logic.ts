// fork: limits, see FORK.md.
import type {
  EffectiveResourceLimits,
  ResourceLimitsSettings,
  ResourceLimitsStatus,
} from "@t3tools/contracts";

const GiB = 1024 ** 3;
const gib = (value: number) => `${Math.round(value * 10) / 10} GiB`;
const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

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

export function readingsLabel(status: ResourceLimitsStatus): string {
  if (status.sampledAt === null || status.availableBytes === null) return "No readings yet";
  const memory = status.limits.usesMemoryPressure
    ? `Memory pressure ${status.memoryPressure ?? "unknown"}`
    : status.commitLimitBytes !== null && status.committedBytes !== null
      ? `Headroom ${gib((status.commitLimitBytes - status.committedBytes) / GiB)}`
      : null;
  return [
    memory,
    `Available ${gib(status.availableBytes / GiB)}`,
    status.cpuUtilization === null ? null : `CPU ${percent(status.cpuUtilization)}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

export function limitsLabel(limits: EffectiveResourceLimits): string {
  const pause = [
    limits.usesMemoryPressure ? "memory pressure warns" : null,
    limits.pauseHeadroomGiB === null ? null : `headroom is under ${gib(limits.pauseHeadroomGiB)}`,
    limits.pauseAvailableGiB === null
      ? null
      : `available is under ${gib(limits.pauseAvailableGiB)}`,
    limits.pauseCpuPercent === null ? null : `CPU is over ${limits.pauseCpuPercent}%`,
  ].filter((part) => part !== null);
  const release = [
    limits.releaseHeadroomGiB === null ? null : `headroom ${gib(limits.releaseHeadroomGiB)}`,
    limits.releaseAvailableGiB === null ? null : `available ${gib(limits.releaseAvailableGiB)}`,
  ].filter((part) => part !== null);
  const critical = limits.usesMemoryPressure
    ? "memory pressure is critical"
    : limits.criticalHeadroomGiB === null
      ? null
      : `headroom is under ${gib(limits.criticalHeadroomGiB)}`;
  return [
    pause.length === 0 ? "Never pauses" : `Pauses when ${pause.join(" or ")}`,
    release.length === 0 ? null : `resumes over ${release.join(" and ")}`,
    critical === null ? null : `critical when ${critical}`,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

const LIMIT_FIELDS = [
  { key: "pauseHeadroomGiB", label: "Pause under headroom", unit: "GiB", commitOnly: true },
  { key: "pauseAvailableGiB", label: "Pause under available", unit: "GiB", commitOnly: false },
  { key: "releaseHeadroomGiB", label: "Resume over headroom", unit: "GiB", commitOnly: true },
  { key: "releaseAvailableGiB", label: "Resume over available", unit: "GiB", commitOnly: false },
  { key: "criticalHeadroomGiB", label: "Critical under headroom", unit: "GiB", commitOnly: true },
  { key: "pauseCpuPercent", label: "Pause over CPU", unit: "%", commitOnly: false },
] as const satisfies ReadonlyArray<{
  readonly key: keyof ResourceLimitsSettings;
  readonly label: string;
  readonly unit: "GiB" | "%";
  readonly commitOnly: boolean;
}>;

export type LimitsForm = Record<keyof ResourceLimitsSettings, string>;

/** The fields a machine uses: macOS has no commit charge, so its headroom lines don't apply. */
export const limitFieldsFor = (limits: EffectiveResourceLimits) =>
  LIMIT_FIELDS.filter((field) => !(field.commitOnly && limits.usesMemoryPressure));

/** The form holds only saved values, so an untouched default stays a default. */
export const limitsForm = (saved: ResourceLimitsSettings): LimitsForm =>
  Object.fromEntries(
    LIMIT_FIELDS.map(({ key }) => [key, saved[key] === undefined ? "" : String(saved[key])]),
  ) as LimitsForm;

/**
 * The limits to save, or null while a field isn't a number the server accepts. An empty field
 * goes back to the machine's default.
 */
export function limitsPatch(
  form: LimitsForm,
  limits: EffectiveResourceLimits,
): ResourceLimitsSettings | null {
  const patch: Record<string, number> = {};
  for (const { key, unit } of limitFieldsFor(limits)) {
    const text = form[key].trim();
    if (text === "") continue;
    const value = Number(text);
    const valid =
      Number.isFinite(value) && (unit === "%" ? value >= 1 && value <= 100 : value >= 0);
    if (!valid) return null;
    patch[key] = value;
  }
  return patch;
}
