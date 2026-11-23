// fork: thread tags, see FORK.md. Moves the tags older fork builds kept in settings onto their threads.
import {
  CommandId,
  spellThreadTag,
  type ThreadId,
  threadTagKey,
  threadTagSpellings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ThreadTagNames } from "./ThreadTagNames.ts";

/** Each UTF-16 code unit as four hex digits: lossless for any text, lone surrogates included. */
const hexCodeUnits = (text: string) =>
  Array.from({ length: text.length }, (_, index) =>
    text.charCodeAt(index).toString(16).padStart(4, "0"),
  ).join("");

/** Adds per entry a live thread may refuse before the move gives up on its tag. */
const LEGACY_THREAD_TAG_ATTEMPTS = 3;

/**
 * Fixed per thread, tag and attempt, so a run that repeats replays the first run's receipt instead
 * of adding again a tag removed since. Thread and tag are hex-encoded, so no text throws and no two
 * pairs share an id.
 */
export const legacyThreadTagCommandId = (
  threadId: ThreadId,
  tag: string,
  attempt: number,
): CommandId =>
  CommandId.make(
    `command:system:legacy-thread-tag:${hexCodeUnits(threadId)}:${hexCodeUnits(threadTagKey(tag))}:${attempt}`,
  );

/**
 * Adds every tag in `settings.threadTags` to its thread with `thread.tag.set`, even one it has, so
 * each add leaves a receipt, and clears the entries that settled. A refusal settles only once the
 * thread is gone, has the tag, or refused three attempts; anything else stays for the next start.
 */
export const moveLegacyThreadTags = Effect.fn("LegacyThreadTags.move")(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const legacy = Object.entries((yield* settings.getSettings).threadTags) as Array<
    [ThreadId, ReadonlyArray<string>]
  >;
  if (legacy.length === 0) return;
  const inUse = threadTagSpellings(yield* (yield* ThreadTagNames).list);

  const add = Effect.fn("LegacyThreadTags.add")(function* (threadId: ThreadId, legacyTag: string) {
    let shell = yield* orchestrator.getThreadShell(threadId);
    // Each start dispatches at most once per entry: the first attempt with no receipt yet.
    for (let attempt = 0; ; attempt += 1) {
      const tag = spellThreadTag(legacyTag, "typed", threadTagSpellings(shell?.tags ?? []), inUse);
      if (tag === "") return "settled" as const;
      const commandId = legacyThreadTagCommandId(threadId, legacyTag, attempt);
      const earlier = yield* receipts.getByCommandId(commandId);
      const dispatched = Option.isNone(earlier);
      let receipt: CommandReceiptStore.CommandReceiptV2;
      if (Option.isSome(earlier)) {
        receipt = earlier.value;
      } else {
        const exit = yield* Effect.exit(
          orchestrator.dispatch({ type: "thread.tag.set", commandId, threadId, tag, tagged: true }),
        );
        if (Exit.isSuccess(exit)) {
          inUse.set(threadTagKey(tag), tag);
          return "settled" as const;
        }
        const refused = yield* receipts.getByCommandId(commandId);
        if (Option.isNone(refused)) {
          yield* Effect.logWarning("Could not move a thread tag out of settings", {
            threadId,
            tag,
            cause: Cause.pretty(exit.cause),
          });
          return "kept" as const;
        }
        receipt = refused.value;
        shell = yield* orchestrator.getThreadShell(threadId);
      }
      if (receipt.status !== "rejected") return "settled" as const;
      const reason = receipt.error;
      if (shell === null) {
        yield* Effect.logWarning("A thread tag in settings was refused, so it leaves settings", {
          threadId,
          tag,
          reason,
        });
        return "settled" as const;
      }
      if ((shell.tags ?? []).some((have) => threadTagKey(have) === threadTagKey(tag))) {
        return "settled" as const;
      }
      if (attempt + 1 >= LEGACY_THREAD_TAG_ATTEMPTS) {
        yield* Effect.logWarning(
          `A thread tag in settings was refused ${LEGACY_THREAD_TAG_ATTEMPTS} times, so it leaves settings`,
          { threadId, tag, reason },
        );
        return "settled" as const;
      }
      if (dispatched) {
        yield* Effect.logWarning(
          "A thread tag in settings was refused; the next start tries again",
          {
            threadId,
            tag,
            reason,
          },
        );
        return "kept" as const;
      }
    }
  });

  const settled: Record<string, Array<string>> = {};
  let kept = 0;
  for (const [threadId, tags] of legacy) {
    for (const tag of tags) {
      // One entry that fails or dies stays for the next start; the rest still move and clear.
      const outcome = yield* add(threadId, tag).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            Effect.logWarning("Could not move a thread tag out of settings", {
              threadId,
              tag,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as("kept" as const)),
        ),
      );
      if (outcome === "kept") kept += 1;
      else (settled[threadId] ??= []).push(tag);
    }
  }
  if (Object.keys(settled).length > 0) {
    yield* settings.clearLegacyThreadTags?.(settled) ?? Effect.void;
  }
  yield* kept > 0
    ? Effect.logWarning("Some thread tags stay in settings until the next start", { kept })
    : Effect.logInfo("Moved thread tags out of settings onto their threads", {
        threads: legacy.length,
      });
});

/** Runs the move once commands are accepted, after activation. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    yield* forkParked(
      startup.awaitCommandReady.pipe(
        Effect.andThen(moveLegacyThreadTags()),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Could not move thread tags out of settings", {
                cause: Cause.pretty(cause),
              }),
        ),
      ),
    );
  }),
);
