// fork: limits. Moves a thread held here to the linked machine in the overflow settings, and forwards what's sent to
// it afterwards; see FORK.md.
import {
  CommandId,
  type EnvironmentId,
  MessageId,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OVERFLOW_DEFAULTS,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffCoverage,
  historicalMessage,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeJsonFiles } from "./jsonFiles.ts";
import {
  isBufferedWake,
  type MoveCandidate,
  moveBlocker,
  moveBrief,
  movedBranchName,
  movePlan,
  type MoveTarget,
  type ThreadThere,
  threadThere,
  TIMING,
  type Upstream,
  upstreamOf,
} from "./policy.ts";
import {
  type MovedThread,
  type MoveLaunch,
  movedThreads,
  type OverflowMover,
  ResourceLimits,
} from "./ResourceLimits.ts";

/** The modes a call to the linked machine carries, which it enforces with the link's own access. */
interface Modes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** What a move reads and calls outside the orchestrator: this machine's git and projects, and the linked machine. */
export interface OverflowHost {
  readonly project: (projectId: ProjectId) => Effect.Effect<{
    readonly workspaceRoot: string;
    readonly repositoryKey: string | null;
  } | null>;
  readonly gitStatus: (cwd: string) => Effect.Effect<MoveCandidate["git"]>;
  readonly label: (environmentId: EnvironmentId) => Effect.Effect<string>;
  readonly projectsThere: (
    environmentId: EnvironmentId,
    modes: Modes,
    repositoryKey: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: ProjectId; readonly remotes: ReadonlyMap<string, string> }>,
    OrchestratorMcpFailure
  >;
  readonly providersThere: (
    environmentId: EnvironmentId,
    modes: Modes,
  ) => Effect.Effect<MoveTarget["providers"], OrchestratorMcpFailure>;
  readonly launch: (
    environmentId: EnvironmentId,
    modes: Modes,
    input: MoveLaunch,
  ) => Effect.Effect<
    { readonly threadId: string; readonly link: string | null },
    OrchestratorMcpFailure
  >;
  readonly readThere: (
    environmentId: EnvironmentId,
    modes: Modes,
    threadId: string,
  ) => Effect.Effect<ThreadThere, OrchestratorMcpFailure>;
  readonly send: (
    environmentId: EnvironmentId,
    modes: Modes,
    input: {
      readonly threadId: string;
      readonly message: string;
      readonly clientRequestId: string;
    },
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
}

/** The notification a move queues, so its notice is the thread's last item; it's cancelled, never sent. */
const MOVE_NOTE_PREFIX = "limits:moved:";

const modesOf = (shell: OrchestrationV2ThreadShell): Modes => ({
  runtimeMode: shell.runtimeMode,
  interactionMode: shell.interactionMode,
});

const failureMessage = (failure: OrchestratorMcpFailure) => failure.message;

export const makeOverflowMover = Effect.fn("makeOverflowMover")(function* (host: OverflowHost) {
  const limits = yield* ResourceLimits;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const { readJson, writeJson } = yield* makeJsonFiles;
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const hereId = Option.isSome(environment)
    ? yield* environment.value.getEnvironmentId
    : "this environment";
  const movedFile = path.join(config.stateDir, "resource-limits", "moved.json");
  // The file is the record: what a restart left under way carries on from its phase.
  const saved = movedThreads(yield* readJson(movedFile));
  yield* limits.update((snapshot) => ({ ...snapshot, moved: saved }));
  // Threads that couldn't move, or failed to, and when to look at them again.
  const retryAt = yield* Ref.make<ReadonlyMap<ThreadId, number>>(new Map());

  const dispatch = (
    command: Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0],
  ) =>
    threads.dispatch(command).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("resource-limits.dispatch-failed", { type: command.type, cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const skip = Effect.fn("Overflow.skip")(function* (
    threadId: ThreadId,
    reason: string,
    now: number,
  ) {
    yield* Effect.logInfo("resource-limits.move-skipped", { threadId, reason });
    yield* Ref.update(retryAt, (current) =>
      new Map(current).set(threadId, now + TIMING.moveRetryMs),
    );
  });

  /** Saves the change to `moved.json`, then applies it here; nothing changes when the file can't be written. */
  const save = Effect.fn("Overflow.save")(function* (
    threadId: ThreadId,
    entry: MovedThread | null,
  ) {
    const next = new Map((yield* limits.read).moved);
    if (entry === null) next.delete(threadId);
    else next.set(threadId, entry);
    const written = yield* writeJson(movedFile, { version: 2, threads: Object.fromEntries(next) });
    if (!written) return false;
    yield* limits.update((snapshot) => {
      const moved = new Map(snapshot.moved);
      if (entry === null) moved.delete(threadId);
      else moved.set(threadId, entry);
      return { ...snapshot, moved };
    });
    return true;
  });

  const queuedOf = Effect.fn("Overflow.queuedOf")(function* (threadId: ThreadId) {
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    const queued = runs
      .filter((run) => run.status === "queued")
      .toSorted(
        (left, right) =>
          (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
      );
    const { messages } =
      queued.length === 0
        ? { messages: [] }
        : yield* projections.getThreadRecords(threadId, ["messages"], {
            messageIds: queued.map((run) => run.userMessageId),
          });
    return queued.flatMap((run) => {
      const message = messages.find((candidate) => candidate.id === run.userMessageId);
      return message === undefined ? [] : [{ run, message }];
    });
  });

  /** The thread's history, as a provider switch hands it on. */
  const summaryOf = Effect.fn("Overflow.summaryOf")(function* (threadId: ThreadId) {
    const { runs, turnItems } = yield* projections.getThreadRecords(threadId, [
      "runs",
      "turnItems",
    ]);
    const executed = runs.filter((run) => run.status !== "queued");
    if (executed.length === 0) return "";
    const ordinals = executed.map((run) => run.ordinal);
    const executedIds = new Set(executed.map((run) => run.id));
    const items = turnItems.filter((item) => item.runId === null || executedIds.has(item.runId));
    const selected = selectHistory({
      messages: items.flatMap((item) => {
        const message = historicalMessage(item);
        return message === null ? [] : [message];
      }),
      coverage: handoffCoverage({
        threadId,
        coveredRunOrdinals: { from: Math.min(...ordinals), to: Math.max(...ordinals) },
        items,
      }),
      budget: DEFAULT_HANDOFF_TOKEN_CAP,
    });
    return renderHistory(selected.messages, selected.context);
  });

  /** Cancels these runs here while they're still queued; false when one couldn't be, to try again next pass. */
  const cancelQueued = Effect.fn("Overflow.cancelQueued")(function* (
    threadId: ThreadId,
    runIds: ReadonlyArray<string>,
  ) {
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    const wanted = new Set(runIds);
    for (const run of runs) {
      if (!wanted.has(run.id) || run.status !== "queued") continue;
      const cancelled = yield* dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make(`limits:move-cancel:${run.id}`),
        threadId,
        runId: run.id,
      });
      if (!cancelled) return false;
    }
    return true;
  });

  /** Sends what's queued on a moved thread there, in order, and cancels it here. Stops at the first failure. */
  const forward = Effect.fn("Overflow.forward")(function* (
    threadId: ThreadId,
    entry: MovedThread,
    shell: OrchestrationV2ThreadShell,
  ) {
    const batch = new Set(entry.batch);
    for (const { run, message } of yield* queuedOf(threadId)) {
      // Its turn already started here; holdQueuedRun lets it run.
      if (isBufferedWake(message)) continue;
      if (!batch.has(run.id) && !message.id.startsWith(MOVE_NOTE_PREFIX)) {
        const attached = message.attachments.map((attachment) => attachment.name);
        const sent = yield* host
          .send(entry.environmentId as EnvironmentId, modesOf(shell), {
            threadId: entry.threadId!,
            message:
              attached.length === 0
                ? message.text
                : `${message.text}\n\n[Attachments left on the original machine: ${attached.join(", ")}]`,
            // A retry after a lost reply, or after the cancel below failed, finds the same message there.
            clientRequestId: `limits-forward:${run.id}`,
          })
          .pipe(Effect.result);
        if (sent._tag === "Failure") {
          yield* Effect.logWarning("resource-limits.forward-failed", {
            threadId,
            reason: failureMessage(sent.failure),
          });
          return;
        }
        yield* Effect.logInfo("resource-limits.forwarded", { threadId, runId: run.id });
      }
      const cancelled = yield* dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make(`limits:forward-cancel:${run.id}`),
        threadId,
        runId: run.id,
      });
      if (!cancelled) return;
    }
  });

  /** Gives up a move whose thread there didn't start: the batch stays held here, and the thread waits to try again. */
  const abandon = Effect.fn("Overflow.abandon")(function* (
    threadId: ThreadId,
    reason: string,
    now: number,
  ) {
    if (!(yield* save(threadId, null))) return;
    yield* skip(threadId, reason, now);
  });

  /** One step of one move, from its saved phase, carrying on to the next while each succeeds. */
  const step = Effect.fn("Overflow.step")(function* (
    threadId: ThreadId,
    now: number,
    paused: boolean,
  ) {
    const shell = yield* projections
      .getThreadShell(threadId)
      .pipe(Effect.orElseSucceed(() => null));
    let entry = (yield* limits.read).moved.get(threadId);
    if (entry === undefined) return;
    if (shell === null || shell.deletedAt !== null) {
      if (entry.phase !== "moved") yield* abandon(threadId, "the thread is gone", now);
      return;
    }
    const target = entry.environmentId as EnvironmentId;
    const modes = modesOf(shell);
    if (entry.phase === "pending") {
      // Pause all quiets this machine's work, and a move that hasn't launched is new work.
      if (paused) return;
      const launch = entry.launch!;
      const launched = yield* host.launch(target, modes, launch).pipe(Effect.result);
      if (launched._tag === "Failure") {
        // The reply may be what was lost, so the same launch is sent again for as long as a move may wait.
        if (now - entry.at < TIMING.moveRetryMs) {
          yield* Effect.logWarning("resource-limits.move-launch-failed", {
            threadId,
            reason: failureMessage(launched.failure),
          });
          return;
        }
        return yield* abandon(
          threadId,
          `the launch there failed: ${failureMessage(launched.failure)}`,
          now,
        );
      }
      const next: MovedThread = {
        ...entry,
        phase: "launched",
        launch: null,
        threadId: launched.success.threadId,
        link: launched.success.link,
      };
      if (!(yield* save(threadId, next))) return;
      entry = next;
    }
    if (entry.phase === "launched") {
      const there = yield* host.readThere(target, modes, entry.threadId!).pipe(Effect.result);
      if (there._tag === "Failure") {
        yield* Effect.logWarning("resource-limits.move-read-failed", {
          threadId,
          reason: failureMessage(there.failure),
        });
        return;
      }
      if (there.success.state === "starting") return;
      if (there.success.state === "failed") {
        return yield* abandon(threadId, `the thread there failed: ${there.success.reason}`, now);
      }
      const next: MovedThread = { ...entry, phase: "confirmed" };
      if (!(yield* save(threadId, next))) return;
      entry = next;
    }
    if (entry.phase === "confirmed") {
      // What it carried there leaves the queue here; anything held since is forwarded below.
      if (!(yield* cancelQueued(threadId, entry.batch))) return;
      // Held with the moved notice, which stays as the thread's last item once forwarding cancels it.
      const noted = yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${MOVE_NOTE_PREFIX}${threadId}:${entry.at}`),
        messageId: MessageId.make(`${MOVE_NOTE_PREFIX}${threadId}:${entry.at}`),
        threadId,
        text: `Moved to ${entry.machine}.`,
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: `Continues on ${entry.machine}`,
          detail: entry.link ?? entry.threadId!,
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      if (!noted) return;
      const next: MovedThread = { ...entry, phase: "moved" };
      if (!(yield* save(threadId, next))) return;
      entry = next;
      yield* Effect.logInfo("resource-limits.moved", {
        threadId,
        environmentId: target,
        threadIdThere: entry.threadId,
      });
    }
    yield* forward(threadId, entry, shell);
  });

  /** A failed read or write leaves the move in its phase for the next pass. */
  const stepOrLog = (threadId: ThreadId, now: number, paused: boolean) =>
    step(threadId, now, paused).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("resource-limits.move-step-failed", { threadId, cause }),
      ),
    );

  const advance: OverflowMover["advance"] = Effect.fn("Overflow.advance")(function* (now, paused) {
    for (const threadId of (yield* limits.read).moved.keys()) {
      yield* stepOrLog(threadId, now, paused);
    }
  });

  const move: OverflowMover["move"] = Effect.fn("Overflow.move")(function* (candidates, now) {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const overflow = current?.resourceLimits.overflow;
    if (current === null) return null;
    if (overflow === undefined || overflow.mode === "off") return null;
    const { moved } = yield* limits.read;
    // One move at a time.
    if ([...moved.values()].some((entry) => entry.phase !== "moved")) return null;
    const moveAfterMs = overflow.moveAfterMs ?? OVERFLOW_DEFAULTS.moveAfterMs;
    const rules = {
      provides: overflow.provides ?? [],
      assumeNeeds: overflow.assumeNeeds ?? OVERFLOW_DEFAULTS.assumeNeeds,
    };
    const waitUntil = yield* Ref.get(retryAt);
    const due = candidates.filter(
      (candidate) =>
        !moved.has(candidate.threadId) &&
        now - candidate.heldAt >= moveAfterMs &&
        (waitUntil.get(candidate.threadId) ?? 0) <= now,
    );
    const target = overflow.environmentId;
    let providers: MoveTarget["providers"] | undefined;
    for (const { threadId } of due) {
      const shell = yield* projections
        .getThreadShell(threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null) continue;
      const project = yield* host.project(shell.projectId);
      const held = (yield* queuedOf(threadId).pipe(Effect.orElseSucceed(() => []))).filter(
        ({ message }) => !isBufferedWake(message),
      );
      if (project === null || held.length === 0) {
        yield* skip(threadId, project === null ? "its project is gone" : "nothing is held", now);
        continue;
      }
      const git = yield* host.gitStatus(shell.worktreePath ?? project.workspaceRoot);
      const candidate: MoveCandidate = {
        topLevel: shell.lineage.parentThreadId == null && shell.delegatedFrom === undefined,
        tags: current.threadTags[threadId] ?? [],
        git,
        worktree: shell.worktreePath !== null,
        heldAttachments: held.reduce((sum, { message }) => sum + message.attachments.length, 0),
        model: shell.modelSelection,
      };
      const blocker = moveBlocker(candidate, rules);
      if (blocker !== null) {
        yield* skip(threadId, blocker, now);
        continue;
      }
      // moveBlocker checked the branch, its upstream and its commit.
      const { upstream, head } = git! as {
        readonly upstream: Upstream;
        readonly head: string;
      };
      const modes = modesOf(shell);
      const there = yield* Effect.gen(function* () {
        providers ??= yield* host.providersThere(target, modes);
        const projects =
          project.repositoryKey === null
            ? []
            : yield* host.projectsThere(target, modes, project.repositoryKey);
        return { providers, projects };
      }).pipe(Effect.result);
      if (there._tag === "Failure") {
        // The machine isn't answering, so nothing else moves this pass.
        yield* skip(threadId, `the linked machine: ${failureMessage(there.failure)}`, now);
        return null;
      }
      const plan = movePlan(
        { model: candidate.model, upstream },
        {
          projects: there.success.projects,
          providers: there.success.providers,
          fallbackModel: overflow.fallbackModel ?? null,
        },
      );
      if ("blocker" in plan) {
        yield* skip(threadId, plan.blocker, now);
        continue;
      }
      const localBranch = movedBranchName(upstream.branch, threadId);
      const brief = moveBrief({
        title: shell.title,
        threadId,
        environmentId: hereId,
        machine: (yield* limits.read).machine,
        remote: plan.remote,
        remoteBranch: upstream.branch,
        localBranch,
        head,
        summary: yield* summaryOf(threadId).pipe(Effect.orElseSucceed(() => "")),
        held: held.map(({ message }) => message.text),
      });
      if (brief === null) {
        yield* skip(threadId, "its held messages are too long to send in one message", now);
        continue;
      }
      const pending: MovedThread = {
        phase: "pending",
        environmentId: target,
        machine: yield* host.label(target),
        at: now,
        batch: held.map(({ run }) => run.id),
        launch: {
          projectId: there.success.projects[0]!.id,
          title: shell.title,
          modelSelection:
            plan.use === "fallback" && overflow.fallbackModel !== undefined
              ? overflow.fallbackModel
              : shell.modelSelection,
          // Named as a remote branch there, so the launch fetches it rather than following a local branch's tracking.
          workspaceStrategy: {
            type: "worktree",
            baseRef: `${plan.remote}/${upstream.branch}`,
            branch: localBranch,
            startFromOrigin: true,
          },
          message: brief,
          // A retry after a lost reply finds the same thread there; a later move of this thread is a new one.
          clientRequestId: `limits-move:${threadId}:${now}`,
        },
        threadId: null,
        link: null,
      };
      if (!(yield* save(threadId, pending))) {
        yield* skip(threadId, "moved.json couldn't be written", now);
        return null;
      }
      yield* stepOrLog(threadId, now, false);
      return threadId;
    }
    return null;
  });

  return { move, advance } satisfies OverflowMover;
});

/** The host the server runs with: git and projects here, and the linked machine's T3 tools. */
const makeLiveHost = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;

  const requireLinks = links.enabled.pipe(
    Effect.flatMap((enabled) =>
      enabled
        ? Effect.void
        : Effect.fail(
            new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "Linked environments are turned off here.",
            }),
          ),
    ),
  );

  return {
    project: (projectId) =>
      projects.getById(projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.flatMap((project) =>
          project === undefined
            ? Effect.succeed(null)
            : identities.resolve(project.workspaceRoot).pipe(
                Effect.map((identity) => ({
                  workspaceRoot: project.workspaceRoot,
                  repositoryKey: identity?.canonicalKey ?? null,
                })),
              ),
        ),
        Effect.orElseSucceed(() => null),
      ),
    gitStatus: Effect.fn("Overflow.gitStatus")(
      function* (cwd) {
        const status = yield* git.statusDetails(cwd);
        if (!status.isRepo) return null;
        const read = (args: ReadonlyArray<string>) =>
          git
            .execute({ operation: "Overflow.gitStatus", cwd, args, allowNonZeroExit: true })
            .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));
        // The branch's own config, not `<remote>/<branch>` split at a slash, since remote names may hold one.
        const tracked =
          status.branch === null
            ? null
            : upstreamOf({
                remote: yield* read(["config", "--get", `branch.${status.branch}.remote`]),
                merge: yield* read(["config", "--get", `branch.${status.branch}.merge`]),
              });
        const url =
          tracked === null ? null : yield* read(["remote", "get-url", "--", tracked.remote]);
        return {
          branch: status.branch,
          isDefaultBranch: status.isDefaultBranch,
          hasWorkingTreeChanges: status.hasWorkingTreeChanges,
          upstream:
            tracked === null || !status.hasUpstream
              ? null
              : {
                  ...tracked,
                  repositoryKey:
                    url === null || url === ""
                      ? null
                      : sourceControlDefinitions.repositoryKeyFromRemote(url),
                },
          aheadCount: status.aheadCount,
          head: yield* read(["rev-parse", "--verify", "HEAD^{commit}"]),
        };
      },
      Effect.orElseSucceed(() => null),
    ),
    label: (environmentId) =>
      links.get(environmentId).pipe(
        Effect.map((link) => (Option.isSome(link) ? link.value.label : environmentId)),
        Effect.orElseSucceed(() => environmentId),
      ),
    projectsThere: Effect.fn("Overflow.projectsThere")(function* (environmentId, modes, key) {
      yield* requireLinks;
      const tool = ProjectToolkit.tools.t3_project_list;
      const found: Array<{
        readonly id: ProjectId;
        readonly remotes: ReadonlyMap<string, string>;
      }> = [];
      let cursor: number | null = 0;
      while (cursor !== null) {
        const listed: typeof tool.successSchema.Type = yield* peers.call({
          environmentId,
          tool: tool.name,
          arguments: { cursor, limit: 100 },
          limits: modes,
          success: tool.successSchema,
        });
        for (const project of listed.projects) {
          const identity = project.repositoryIdentity;
          if (identity?.canonicalKey !== key) continue;
          // The remotes the identity names: its primary one, and origin when that's another repository.
          const remotes = new Map([[identity.canonicalKey, identity.locator.remoteName]]);
          if (identity.origin !== undefined) remotes.set(identity.origin.canonicalKey, "origin");
          found.push({ id: project.id, remotes });
        }
        cursor = listed.nextCursor;
      }
      return found;
    }),
    providersThere: (environmentId, modes) =>
      requireLinks.pipe(
        Effect.andThen(
          peers.call({
            environmentId,
            tool: "orchestrator_capabilities",
            arguments: {},
            limits: modes,
            success: OrchestratorMcpCapabilitiesResult,
          }),
        ),
        Effect.map((result) =>
          result.providers.map((provider) => ({
            instanceId: provider.providerInstanceId,
            models: provider.models.map((model) => model.id),
            omittedModels: provider.omittedModels ?? 0,
          })),
        ),
      ),
    launch: (environmentId, modes, input) =>
      requireLinks.pipe(
        Effect.andThen(
          peers.call({
            environmentId,
            tool: ProjectToolkit.tools.t3_thread_launch.name,
            arguments: {
              ...input,
              runtimeMode: modes.runtimeMode,
              interactionMode: modes.interactionMode,
            },
            limits: modes,
            success: ProjectToolkit.tools.t3_thread_launch.successSchema,
          }),
        ),
        Effect.map((launched) => ({ threadId: launched.threadId, link: launched.link ?? null })),
      ),
    readThere: (environmentId, modes, threadId) =>
      requireLinks.pipe(
        Effect.andThen(
          peers.call({
            environmentId,
            tool: "t3_thread_read",
            arguments: { threadId, view: "messages", limit: 1, maxCharsPerItem: 1, runLimit: 50 },
            limits: modes,
            success: OrchestratorMcpThreadReadResult,
          }),
        ),
        Effect.map(({ thread, recentRuns }) =>
          threadThere({
            worktreePath: thread.worktreePath,
            runCount: thread.runCount,
            firstRun: recentRuns.find((run) => run.ordinal === 1) ?? null,
          }),
        ),
      ),
    send: (environmentId, modes, input) =>
      requireLinks.pipe(
        Effect.andThen(
          peers.call({
            environmentId,
            tool: "t3_thread_send",
            arguments: { ...input, mode: "queue" },
            limits: modes,
            success: OrchestratorMcpThreadSendResult,
          }),
        ),
        Effect.asVoid,
      ),
  } satisfies OverflowHost;
});

/** Hands the governor a mover once the links are up; without this layer nothing moves. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const limits = yield* ResourceLimits;
    const mover = yield* makeOverflowMover(yield* makeLiveHost);
    yield* limits.setOverflow(mover);
  }),
);
