import { CheckpointScopeId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause"; // fork: see FORK.md.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration"; // fork: see FORK.md.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore"; // fork: see FORK.md.

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class RunFinalizationError extends Schema.TaggedError<RunFinalizationError>()(
  "RunFinalizationError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    operation: Schema.Literals(["capture-checkpoint", "refresh-workspace"]),
    cause: Schema.Defect(),
  },
) {}

export class RunFinalizationRefreshError extends Schema.TaggedError<RunFinalizationRefreshError>()(
  "RunFinalizationRefreshError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {}

export class RunFinalizationObserver extends Context.Reference<{
  readonly refreshAfterTurn: (projectId: ProjectId) => Effect.Effect<void>;
  readonly refresh: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, RunFinalizationRefreshError>;
}>("t3/orchestration-v2/RunFinalizationObserver", {
  defaultValue: () => ({ refresh: () => Effect.void, refreshAfterTurn: () => Effect.void }),
}) {}

export class RunFinalizationService extends Context.Service<
  RunFinalizationService,
  {
    readonly finalize: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) => Effect.Effect<void, RunFinalizationError>;
  }
>()("t3/orchestration-v2/RunFinalizationService") {}

// fork: the workspace refresh after a checkpoint runs beside the effect workers, see FORK.md.
const REFRESH_AFTER_CAPTURE_CONCURRENCY = 2;
const REFRESH_AFTER_CAPTURE_DEADLINE = Duration.minutes(5);

const make = Effect.gen(function* () {
  const checkpointCapture = yield* CheckpointCapture.CheckpointCaptureServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const observer = yield* RunFinalizationObserver;
  // fork: see FORK.md.
  const refreshScope = yield* Effect.scope;
  const refreshPermits = yield* Semaphore.make(REFRESH_AFTER_CAPTURE_CONCURRENCY);

  // fork: was the tail of finalize, see FORK.md.
  const refreshAfterCapture = Effect.fn("RunFinalizationService.refreshAfterCapture")(
    function* (input: Parameters<RunFinalizationService["Service"]["finalize"]>[0]) {
      const projection = yield* projections
        .getCheckpointContext(input.threadId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
          ),
        );
      const cwd = projection.checkpointScopes.find((scope) => scope.id === input.scopeId)?.cwd;
      if (cwd !== undefined) {
        yield* observer.refresh({ cwd, threadId: input.threadId, runId: input.runId });
      }
    },
    (effect, input) =>
      effect.pipe(
        Effect.timeout(REFRESH_AFTER_CAPTURE_DEADLINE),
        refreshPermits.withPermit,
        // Nothing awaits this fiber, so log defects too.
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to refresh workspace after checkpoint capture", {
            ...input,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
  );

  const finalize: RunFinalizationService["Service"]["finalize"] = Effect.fn(
    "RunFinalizationService.finalize",
  )(function* (input) {
    yield* checkpointCapture
      .execute(input)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "capture-checkpoint", cause }),
        ),
      );
    // fork: the checkpoint is durable here. The refresh that follows only updates what the
    // Changes panel and PR badge show, and it has hung for minutes on git and the PR lookup. On an
    // effect worker that kept this thread's next turn waiting and, a few at a time, every turn.
    // It now runs in the service's scope instead, at most two at a time. See FORK.md.
    yield* refreshAfterCapture(input).pipe(Effect.forkIn(refreshScope, { startImmediately: true }));
  });
  return RunFinalizationService.of({ finalize });
});

export const layer = Layer.effect(RunFinalizationService, make);

export const layerObserver = Layer.effect(
  RunFinalizationObserver,
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const pullRequests = yield* PullRequestService.PullRequestService;
    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: Effect.fn("RunFinalizationService.refresh")(
        function* ({ cwd, threadId, runId }) {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          if (local.refName === null || local.isDefaultRef) return;
          const thread = yield* projections.getThreadShell(threadId);
          if (!thread || thread.branch !== local.refName) return;
          if (thread.activeRunId !== null && thread.activeRunId !== runId) return;
          yield* vcsStatus.refreshPullRequestStatus(cwd).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to refresh pull request status after run completion", {
                threadId,
                cwd,
                detail: error.message,
              }),
            ),
          );
        },
        (effect, { cwd }) =>
          effect.pipe(Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause }))),
      ),
    };
  }),
);
