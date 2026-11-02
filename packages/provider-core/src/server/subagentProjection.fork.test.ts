// fork: limits, see FORK.md.
import { assert, describe, it } from "@effect/vitest";
import { DateTime } from "effect";

import { MessageId, RunId, type OrchestrationV2Run } from "@t3tools/contracts";

import { delegatedTaskProgress } from "./subagentProjection.ts";

const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000);

const run = (
  ordinal: number,
  status: OrchestrationV2Run["status"],
  extra: Partial<OrchestrationV2Run> = {},
) =>
  ({
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    status,
    startedAt: status === "queued" ? null : at(ordinal),
    completedAt: status === "queued" ? null : at(ordinal + 1),
    ...extra,
  }) as OrchestrationV2Run;

const message = (id: string, ordinal: number) => ({
  id: MessageId.make(id),
  runId: RunId.make(`run:${ordinal}`),
});

const progress = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  messages: ReadonlyArray<ReturnType<typeof message>>,
) => delegatedTaskProgress({ runs, messages, subagents: [], providerThreads: [] });

describe("delegatedTaskProgress", () => {
  const stopped = run(1, "interrupted");

  it.each(["limits:stopped:run:1", "limits:stopped-work:t:1", "limits:interrupted:run:1"])(
    "keeps a child working while its note %s waits to resume it",
    (id) => {
      const held = progress([stopped, run(2, "queued", { queueHeld: true })], [message(id, 2)]);
      assert.equal(held.state, "working");
    },
  );

  it("still counts any other held message as nothing left to do", () => {
    const held = progress(
      [stopped, run(2, "queued", { queueHeld: true })],
      [message("message:alice", 2)],
    );
    assert.equal(held.state, "result_available");
    assert.equal(held.resultRun?.id, stopped.id);
  });

  it("reports the interrupted turn once Alice cancels the note", () => {
    const cancelled = progress(
      [stopped, run(2, "cancelled", { startedAt: null })],
      [message("limits:stopped:run:1", 2)],
    );
    assert.equal(cancelled.state, "result_available");
    assert.equal(cancelled.resultRun?.id, stopped.id);
  });

  it("reports the resumed turn once the note's run ends", () => {
    const resumed = run(2, "completed");
    const done = progress([stopped, resumed], [message("limits:stopped:run:1", 2)]);
    assert.equal(done.state, "result_available");
    assert.equal(done.resultRun?.id, resumed.id);
  });
});
