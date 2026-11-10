import {
  ProviderDriverKind,
  runStartRetryCommandId,
  type OrchestrationV2RunAttempt,
  type ProviderInstanceId,
  type RunAttemptId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { redactProviderFailureText } from "@t3tools/provider-core/server/failure";
import { RotatingFileSink } from "@t3tools/shared/logging";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "./Orchestrator.ts";

/** Kept apart from the busy server and provider logs so a start failure is still there weeks later. */
export const START_FAILURE_LOG_FILE = "turn-start-failures.ndjson";
const START_FAILURE_LOG_MAX_BYTES = 1024 * 1024;
const MAX_DETAIL_LENGTH = 8_000;
const encodeRecordLine = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/** Claude refuses these the same way every time, so a retry would only fail again. */
const REPEATING_FAILURE_TAGS = [
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  "ClaudeAppendSystemPromptFileError",
  "ClaudeAppendSystemPromptMissingValueError",
  "ClaudeSettingsLaunchArgError",
] as const;
const REPEATING_PROTOCOL_REASONS = ["previous_turn_active", "attachment_unreadable"] as const;
/**
 * The adapter gives these attachment refusals no reason, so they're matched on
 * their fixed text. If that text changes, the cost is a retry that fails again.
 */
const REPEATING_PROTOCOL_DETAILS = [
  "Unsupported Claude image attachment type",
  "Invalid attachment id",
] as const;

const repeatsEveryTime = (link: unknown): boolean => {
  if (REPEATING_FAILURE_TAGS.some((tag) => Predicate.isTagged(link, tag))) return true;
  if (!Predicate.isTagged(link, "ProviderAdapterProtocolError")) return false;
  const reason = Predicate.hasProperty(link, "reason") ? link.reason : undefined;
  const detail =
    Predicate.hasProperty(link, "detail") && typeof link.detail === "string" ? link.detail : "";
  return (
    REPEATING_PROTOCOL_REASONS.some((known) => reason === known) ||
    REPEATING_PROTOCOL_DETAILS.some((known) => detail.startsWith(known))
  );
};

export interface ProviderStartFailure {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly attemptReason: OrchestrationV2RunAttempt["reason"];
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model: string;
  /** From the start request to its failure. */
  readonly elapsedMs: number;
  readonly cause: Cause.Cause<unknown>;
  /** The provider reported this attempt's turn before the start failed. */
  readonly providerTurnReported: boolean;
  /** A turn the provider opened itself, such as a background task's wake. */
  readonly continuation: boolean;
  readonly compact: boolean;
}

const causeChain = (error: unknown): ReadonlyArray<unknown> => {
  const chain: Array<unknown> = [];
  for (let current = error; current !== undefined && chain.length < 16;) {
    chain.push(current);
    current = Predicate.hasProperty(current, "cause") ? current.cause : undefined;
  }
  return chain;
};

/**
 * Nothing after Claude queues a turn's prompt fails with a typed error, so a
 * Claude start that failed with one never sent its prompt and can run again
 * without doubling it. Stops, defects and other drivers make no such promise.
 * A turn Claude already reported holds its active-turn slot; a retry would fail.
 */
export function startFailureRetryable(failure: ProviderStartFailure): boolean {
  if (
    failure.driver !== CLAUDE_DRIVER ||
    failure.attemptReason === "retry" ||
    failure.providerTurnReported ||
    failure.continuation ||
    failure.compact ||
    Cause.hasInterruptsOnly(failure.cause)
  ) {
    return false;
  }
  const error = Cause.squash(failure.cause);
  if (!Predicate.isTagged(error, "ProviderAdapterTurnStartError")) return false;
  return !causeChain(error).some(repeatsEveryTime);
}

const describeLink = (link: unknown): string =>
  Predicate.hasProperty(link, "_tag") && typeof link._tag === "string"
    ? link._tag
    : link instanceof Error
      ? link.name
      : typeof link;

/** One line of the start failure log. Provider text is redacted and capped. */
export function startFailureRecord(
  failure: ProviderStartFailure,
  outcome: { readonly at: string; readonly retried: boolean },
) {
  const detail = redactProviderFailureText(Cause.pretty(failure.cause));
  return {
    at: outcome.at,
    threadId: failure.threadId,
    runId: failure.runId,
    attemptId: failure.attemptId,
    attemptReason: failure.attemptReason,
    driver: failure.driver,
    providerInstanceId: failure.providerInstanceId,
    model: failure.model,
    elapsedMs: failure.elapsedMs,
    retried: outcome.retried,
    error: causeChain(Cause.squash(failure.cause)).map(describeLink).join(" > "),
    detail:
      detail.length <= MAX_DETAIL_LENGTH ? detail : `${detail.slice(0, MAX_DETAIL_LENGTH - 1)}…`,
  };
}

/**
 * Runs when a provider turn fails to start, before the run fails. A reference
 * with a do-nothing default, shaped like ProviderUsageLimitHook, so
 * RunExecutionService gains no layer dependency on the orchestrator.
 */
export class ProviderStartFailureHook extends Context.Reference<{
  readonly onStartFailure: (failure: ProviderStartFailure) => Effect.Effect<void>;
}>("t3/orchestration-v2/ProviderStartFailureHook", {
  defaultValue: () => ({ onStartFailure: () => Effect.void }),
}) {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const filePath = path.join(config.logsDir, START_FAILURE_LOG_FILE);
  const sink = yield* Effect.try(
    () =>
      new RotatingFileSink({
        filePath,
        maxBytes: START_FAILURE_LOG_MAX_BYTES,
        maxFiles: 1,
        throwOnError: true,
      }),
  ).pipe(
    Effect.catch(() =>
      Effect.logWarning("turn start failure log unavailable", { filePath }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

  const onStartFailure = Effect.fn("ProviderStartRetry.onStartFailure")(function* (
    failure: ProviderStartFailure,
  ) {
    // The orchestrator checks again under the thread lock that the run is
    // still on this attempt and hasn't been retried already.
    const retried = startFailureRetryable(failure)
      ? yield* orchestrator
          .dispatch({
            type: "run.start-retry",
            commandId: runStartRetryCommandId(failure.attemptId),
            threadId: failure.threadId,
            runId: failure.runId,
            attemptId: failure.attemptId,
          })
          .pipe(
            Effect.map((result) => result.storedEvents.length > 0),
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.start-retry.dispatch-failed", {
                threadId: failure.threadId,
                runId: failure.runId,
                cause,
              }).pipe(Effect.as(false)),
            ),
          )
      : false;
    if (sink === undefined) return;
    const record = startFailureRecord(failure, {
      at: DateTime.formatIso(yield* DateTime.now),
      retried,
    });
    yield* encodeRecordLine(record).pipe(
      Effect.flatMap((line) => Effect.try(() => sink.write(`${line}\n`))),
      Effect.catch(() => Effect.logWarning("turn start failure log write failed", { filePath })),
    );
  });

  return { onStartFailure };
});

export const layer = Layer.effect(ProviderStartFailureHook, make);
