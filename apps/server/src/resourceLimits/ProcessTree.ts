// fork: limits. Reads the machine's process table and ends one process, for Stop now on Windows; see FORK.md.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import type { ProcessRow } from "./policy.ts";

// CreationDate comes in whole microseconds. Counted from 1970 they fit a JavaScript number exactly.
const microseconds = (row: string) =>
  `[long]((${row}.CreationDate.ToFileTimeUtc() - 116444736000000000) / 10)`;
const READ_COMMAND = `Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { if ($_.CreationDate) { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$(${microseconds("$_")})|$($_.Name)" } }`;
// Stop now waits for this reading before it interrupts, so it can't take long. It usually takes half a second.
const READ_TIMEOUT = "3 seconds";
const MAX_READ_BYTES = 1024 * 1024;
const END_TIMEOUT = "5 seconds";

// Windows gives a process's id to nothing new while a handle to it is open, so holding one keeps the id this process's
// through the check, and the kill goes through that handle. Not taskkill's /T: it follows parent ids with no check of
// start times, and a process still names its long-dead parent's id, which this process may now hold.
// Exit 3 means the process is gone, or the id already belongs to something else.
const endCommand = ({ pid, createdAt }: ProcessRow) =>
  `$ErrorActionPreference = 'Stop'; $held = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $held) { exit 3 }; $null = $held.Handle; $row = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if (-not $row -or ${microseconds("$row")} -ne ${createdAt}) { exit 3 }; try { $held.Kill() } catch { if ($held.HasExited) { exit 3 }; throw }; exit 0`;

export const parseProcessRows = (stdout: string): ReadonlyArray<ProcessRow> =>
  stdout.split(/\r?\n/g).flatMap((line) => {
    const [pid, parentPid, createdAt, name] = line.trim().split("|");
    if (name === undefined || name === "") return [];
    const row = {
      pid: Number(pid),
      parentPid: Number(parentPid),
      createdAt: Number(createdAt),
      name,
    };
    return Number.isInteger(row.pid) &&
      Number.isInteger(row.parentPid) &&
      Number.isSafeInteger(row.createdAt)
      ? [row]
      : [];
  });

export class ProcessTree extends Context.Service<
  ProcessTree,
  {
    /** The machine's processes, or null when they couldn't all be read in time. */
    readonly read: Effect.Effect<ReadonlyArray<ProcessRow> | null>;
    /** Ends this one process, if it's still that process. */
    readonly end: (row: ProcessRow) => Effect.Effect<"ended" | "gone" | "failed">;
  }
>()("t3/resourceLimits/ProcessTree") {}

export const layer = Layer.effect(
  ProcessTree,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
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
      end: Effect.fn("ProcessTree.end")(function* (row) {
        return yield* runner
          .run({
            command: "powershell.exe",
            args: ["-NoProfile", "-NonInteractive", "-Command", endCommand(row)],
            timeout: END_TIMEOUT,
            outputMode: "truncate",
            timeoutBehavior: "timedOutResult",
          })
          .pipe(
            Effect.map((result) =>
              result.timedOut
                ? ("failed" as const)
                : result.code === 0
                  ? ("ended" as const)
                  : result.code === 3
                    ? ("gone" as const)
                    : ("failed" as const),
            ),
            Effect.orElseSucceed(() => "failed" as const),
          );
      }),
    });
  }),
).pipe(Layer.provide(ProcessRunner.layer));
