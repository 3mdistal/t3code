// fork: limits. The memory and CPU readings the per-machine limits act on, every 15 s; see FORK.md.
import * as NodeOS from "node:os";
import type { MemoryPressureLevel } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { darwinAvailableMemory } from "../resourceTelemetry/HostResources.ts";
import { type HostReading, TIMING } from "./policy.ts";

export class HostReadings extends Context.Service<
  HostReadings,
  {
    /** Waits for the next reading. Never resolves on a platform without limits. */
    readonly next: Effect.Effect<HostReading>;
  }
>()("t3/resourceLimits/HostReadings") {}

// English counter paths, as the memory gate uses. Committed Bytes and Commit Limit give commit
// headroom, the number that ran out on 2026-10-21; Available Bytes includes standby memory.
const WINDOWS_COUNTERS = [
  "\\Memory\\Committed Bytes",
  "\\Memory\\Commit Limit",
  "\\Memory\\Available Bytes",
  "\\Processor(_Total)\\% Processor Time",
];

/** One line of `typeperf` CSV output, or null for its header and anything unreadable. */
export function parseTypeperfLine(
  line: string,
  totalBytes: number,
  sampledAt: number,
): HostReading | null {
  const fields = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
  if (fields.length !== 5 || fields[0]?.startsWith("(PDH-CSV")) return null;
  const [committedBytes, commitLimitBytes, availableBytes, cpuPercent] = fields
    .slice(1)
    .map((value) => Number.parseFloat(value.replace(",", ".")));
  if (
    ![committedBytes, commitLimitBytes, availableBytes].every(
      (value) => value !== undefined && Number.isFinite(value) && value > 0,
    )
  ) {
    return null;
  }
  return {
    sampledAt,
    availableBytes: availableBytes!,
    totalBytes,
    commitLimitBytes: commitLimitBytes!,
    committedBytes: committedBytes!,
    memoryPressure: null,
    cpuUtilization:
      cpuPercent !== undefined && Number.isFinite(cpuPercent)
        ? Math.min(1, Math.max(0, cpuPercent / 100))
        : null,
  };
}

/** `sysctl kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parsePressureLevel(output: string): MemoryPressureLevel | null {
  switch (output.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warn";
    case "4":
      return "critical";
    default:
      return null;
  }
}

function cpuTimes() {
  return NodeOS.cpus().reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
}

const make = Effect.fn("makeHostReadings")(function* () {
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  if (platform === "win32") {
    const latest = yield* Queue.sliding<HostReading>(1);
    // One long-lived typeperf costs a few MB and nothing per pass.
    const runTypeperf = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            "typeperf",
            [...WINDOWS_COUNTERS, "-si", String(TIMING.passMs / 1000)],
            { stdin: "ignore", stderr: "ignore", shell: false, windowsHide: true },
          ),
        );
        yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          // A typeperf that stops printing is restarted.
          Stream.timeout(Duration.millis(TIMING.passMs * 4)),
          Stream.runForEach((line) =>
            Effect.gen(function* () {
              const reading = parseTypeperfLine(
                line,
                NodeOS.totalmem(),
                yield* Clock.currentTimeMillis,
              );
              if (reading !== null) yield* Queue.offer(latest, reading);
            }),
          ),
        );
      }),
    );
    yield* runTypeperf.pipe(
      Effect.catchCause((cause) => Effect.logWarning("resource-limits.typeperf-failed", { cause })),
      Effect.andThen(Effect.sleep("5 seconds")),
      Effect.forever,
      Effect.forkScoped,
    );
    return HostReadings.of({ next: Queue.take(latest) });
  }

  if (platform === "darwin") {
    const previousCpu = yield* Ref.make(cpuTimes());
    const run = (command: string, args: ReadonlyArray<string>) =>
      spawner.string(ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" })).pipe(
        Effect.timeout("2 seconds"),
        Effect.orElseSucceed(() => ""),
      );
    const sample = Effect.gen(function* () {
      const [pressure, vmStat] = yield* Effect.all(
        [
          run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
          run("/usr/bin/vm_stat", []),
        ],
        { concurrency: 2 },
      );
      const cpu = cpuTimes();
      const before = yield* Ref.getAndSet(previousCpu, cpu);
      const totalDelta = cpu.total - before.total;
      const idleDelta = cpu.idle - before.idle;
      const totalBytes = NodeOS.totalmem();
      return {
        sampledAt: yield* Clock.currentTimeMillis,
        // vm_stat counts inactive and speculative pages, which macOS reclaims on demand.
        availableBytes: Math.min(totalBytes, darwinAvailableMemory(vmStat) ?? NodeOS.freemem()),
        totalBytes,
        commitLimitBytes: null,
        committedBytes: null,
        memoryPressure: parsePressureLevel(pressure),
        cpuUtilization:
          totalDelta > 0 && idleDelta >= 0
            ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
            : null,
      } satisfies HostReading;
    });
    return HostReadings.of({
      next: Effect.sleep(Duration.millis(TIMING.passMs)).pipe(Effect.andThen(sample)),
    });
  }

  return HostReadings.of({ next: Effect.never });
});

export const layer = Layer.effect(HostReadings, make());
