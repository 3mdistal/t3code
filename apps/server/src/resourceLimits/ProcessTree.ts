// fork: limits. Reads the machine's process table and ends a process with what's under it, for Stop now on Windows;
// see FORK.md.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import type { ProcessRow } from "./policy.ts";

const READ_COMMAND =
  'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { if ($_.CreationDate) { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.ToFileTimeUtc())" } }';
// Stop now waits for this reading before it interrupts, so it can't take long. It usually takes half a second.
const READ_TIMEOUT = "3 seconds";
const MAX_READ_BYTES = 1024 * 1024;
const END_TIMEOUT = "5 seconds";

export const parseProcessRows = (stdout: string): ReadonlyArray<ProcessRow> =>
  stdout.split(/\r?\n/g).flatMap((line) => {
    const [pid, parentPid, createdAt] = line.trim().split("|").map(Number);
    return pid !== undefined &&
      parentPid !== undefined &&
      createdAt !== undefined &&
      Number.isInteger(pid) &&
      Number.isInteger(parentPid) &&
      Number.isFinite(createdAt)
      ? [{ pid, parentPid, createdAt }]
      : [];
  });

export class ProcessTree extends Context.Service<
  ProcessTree,
  {
    /** The machine's processes, or null when they couldn't all be read in time. */
    readonly read: Effect.Effect<ReadonlyArray<ProcessRow> | null>;
    /** Ends a process and what's under it. */
    readonly end: (pid: number) => Effect.Effect<void>;
  }
>()("t3/resourceLimits/ProcessTree") {}

export const layer = Layer.effect(
  ProcessTree,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
    return ProcessTree.of({
      read: runner
        .run({
          command: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-Command", READ_COMMAND],
          timeout: READ_TIMEOUT,
          maxOutputBytes: MAX_READ_BYTES,
          outputMode: "truncate",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          // A partial table would make the processes missing from it look dead.
          Effect.map((result) =>
            result.code === 0 && !result.timedOut && !result.stdoutTruncated
              ? parseProcessRows(result.stdout)
              : null,
          ),
          Effect.orElseSucceed(() => null),
        ),
      end: Effect.fn("ProcessTree.end")(function* (pid) {
        yield* runner
          .run({
            command: taskkill,
            args: ["/PID", String(pid), "/T", "/F"],
            timeout: END_TIMEOUT,
            outputMode: "truncate",
            timeoutBehavior: "timedOutResult",
          })
          .pipe(Effect.ignore);
      }),
    });
  }),
).pipe(Layer.provide(ProcessRunner.layer));
