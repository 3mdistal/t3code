// fork: kept apart from the tracker so its logic can be tested without a connection; see FORK.md.
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { ORCHESTRATION_V2_WS_METHODS, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import type { WakeNoticeItems } from "./ThreadWakeNotices.fork";

// One-shot, and the server bounds this projection to its newest rows.
const readThreadProjection = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "notifications:read-thread-projection",
  tag: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
});

export async function readWakeNoticeItems(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<WakeNoticeItems | null> {
  const result = await runAtomCommand(
    registry,
    readThreadProjection,
    { environmentId, input: { threadId } },
    { reportFailure: false, reportDefect: false },
  );
  return result._tag === "Success" ? result.value.visibleTurnItems : null;
}
