// fork: limits. Moves a thread held here to the linked machine in the overflow settings, and forwards what's sent to
// it afterwards; see FORK.md.
import {
  CommandId,
  type EnvironmentId,
  MessageId,
  type ModelSelection,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadSendResult,
  OVERFLOW_DEFAULTS,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
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
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeJsonFiles } from "./jsonFiles.ts";
import {
  type MoveCandidate,
  moveBlocker,
  moveBrief,
  movedBranchName,
  moveModel,
  type MoveTarget,
  TIMING,
  upstreamBranch,
} from "./policy.ts";
import { type MovedThread, type OverflowMover, ResourceLimits } from "./ResourceLimits.ts";

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
  ) => Effect.Effect<ReadonlyArray<ProjectId>, OrchestratorMcpFailure>;
  readonly providersThere: (
    environmentId: EnvironmentId,
    modes: Modes,
  ) => Effect.Effect<MoveTarget["providers"], OrchestratorMcpFailure>;
  readonly launch: (
    environmentId: EnvironmentId,
    modes: Modes,
    input: {
      readonly projectId: ProjectId;
      readonly title: string;
      readonly modelSelection: ModelSelection;
      readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
      readonly message: string;
      readonly clientRequestId: string;
    },
  ) => Effect.Effect<
    { readonly threadId: string; readonly link: string | null },
    OrchestratorMcpFailure
  >;
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

  const record = Effect.fn("Overflow.record")(function* (threadId: ThreadId, entry: MovedThread) {
    const saved = (yield* readJson(movedFile)) as { readonly threads?: unknown } | null;
    const before =
      typeof saved?.threads === "object" && saved.threads !== null ? saved.threads : {};
    yield* writeJson(movedFile, { version: 1, threads: { ...before, [threadId]: entry } });
    yield* limits.update((snapshot) => ({
      ...snapshot,
      moved: new Map(snapshot.moved).set(threadId, entry),
      forwardDue: new Set([...snapshot.forwardDue, threadId]),
    }));
  });

  const move: OverflowMover["move"] = Effect.fn("Overflow.move")(function* (candidates, now) {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const overflow = current?.resourceLimits.overflow;
    if (current === null) return null;
    if (overflow === undefined || overflow.mode === "off") return null;
    const moveAfterMs = overflow.moveAfterMs ?? OVERFLOW_DEFAULTS.moveAfterMs;
    const rules = {
      provides: overflow.provides ?? [],
      assumeNeeds: overflow.assumeNeeds ?? OVERFLOW_DEFAULTS.assumeNeeds,
    };
    const waitUntil = yield* Ref.get(retryAt);
    const due = candidates.filter(
      (candidate) =>
        now - candidate.heldAt >= moveAfterMs && (waitUntil.get(candidate.threadId) ?? 0) <= now,
    );
    const target = overflow.environmentId;
    let providers: MoveTarget["providers"] | undefined;
    for (const { threadId } of due) {
      const shell = yield* projections
        .getThreadShell(threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null) continue;
      const project = yield* host.project(shell.projectId);
      const held = yield* queuedOf(threadId).pipe(Effect.orElseSucceed(() => []));
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
      const model = moveModel(candidate, {
        matchingProjects: there.success.projects.length,
        providers: there.success.providers,
        hasFallbackModel: overflow.fallbackModel !== undefined,
      });
      if ("blocker" in model) {
        yield* skip(threadId, model.blocker, now);
        continue;
      }
      // moveBlocker checked the branch and its upstream.
      const remoteBranch = upstreamBranch(git!.upstreamRef)!;
      const localBranch = movedBranchName(remoteBranch, threadId);
      const machine = yield* host.label(target);
      const brief = moveBrief({
        title: shell.title,
        threadId,
        environmentId: hereId,
        machine: (yield* limits.read).machine,
        remoteBranch,
        localBranch,
        summary: yield* summaryOf(threadId).pipe(Effect.orElseSucceed(() => "")),
        held: held.map(({ message }) => message.text),
      });
      const launched = yield* host
        .launch(target, modes, {
          projectId: there.success.projects[0]!,
          title: shell.title,
          modelSelection:
            model.use === "fallback" && overflow.fallbackModel !== undefined
              ? overflow.fallbackModel
              : shell.modelSelection,
          workspaceStrategy: {
            type: "worktree",
            baseRef: remoteBranch,
            branch: localBranch,
            startFromOrigin: true,
          },
          message: brief,
          // A retry after a lost reply finds the same thread there.
          clientRequestId: `limits-move:${threadId}`,
        })
        .pipe(Effect.result);
      if (launched._tag === "Failure") {
        yield* skip(threadId, `the launch there failed: ${failureMessage(launched.failure)}`, now);
        return null;
      }
      yield* record(threadId, {
        environmentId: target,
        threadId: launched.success.threadId,
        machine,
        link: launched.success.link,
        at: now,
      });
      // What it carried there leaves the queue here.
      yield* Effect.forEach(
        held,
        ({ run }) =>
          dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`limits:move-cancel:${run.id}`),
            threadId,
            runId: run.id,
          }),
        { discard: true },
      );
      // Held with the moved notice, which stays as the thread's last item once forwarding cancels it.
      yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${MOVE_NOTE_PREFIX}${threadId}`),
        messageId: MessageId.make(`${MOVE_NOTE_PREFIX}${threadId}`),
        threadId,
        text: `Moved to ${machine}.`,
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: `Continues on ${machine}`,
          detail: launched.success.link ?? launched.success.threadId,
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      yield* Effect.logInfo("resource-limits.moved", {
        threadId,
        environmentId: target,
        threadIdThere: launched.success.threadId,
      });
      return threadId;
    }
    return null;
  });

  const forward: OverflowMover["forward"] = Effect.fn("Overflow.forward")(function* () {
    const { moved, forwardDue: due } = yield* limits.read;
    if (due.size === 0) return;
    yield* limits.update((snapshot) => ({
      ...snapshot,
      forwardDue: new Set([...snapshot.forwardDue].filter((threadId) => !due.has(threadId))),
    }));
    for (const threadId of due) {
      const entry = moved.get(threadId);
      const shell = yield* projections
        .getThreadShell(threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (entry === undefined || shell === null) continue;
      const queued = yield* queuedOf(threadId).pipe(Effect.orElseSucceed(() => []));
      for (const { run, message } of queued) {
        if (!message.id.startsWith(MOVE_NOTE_PREFIX)) {
          const attached = message.attachments.map((attachment) => attachment.name);
          const sent = yield* host
            .send(entry.environmentId as EnvironmentId, modesOf(shell), {
              threadId: entry.threadId,
              message:
                attached.length === 0
                  ? message.text
                  : `${message.text}\n\n[Attachments left on the original machine: ${attached.join(", ")}]`,
              clientRequestId: `limits-forward:${run.id}`,
            })
            .pipe(Effect.result);
          if (sent._tag === "Failure") {
            yield* Effect.logWarning("resource-limits.forward-failed", {
              threadId,
              reason: failureMessage(sent.failure),
            });
            // Tried again next pass, in order.
            yield* limits.update((snapshot) => ({
              ...snapshot,
              forwardDue: new Set([...snapshot.forwardDue, threadId]),
            }));
            break;
          }
          yield* Effect.logInfo("resource-limits.forwarded", { threadId, runId: run.id });
        }
        yield* dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`limits:forward-cancel:${run.id}`),
          threadId,
          runId: run.id,
        });
      }
    }
  });

  return { move, forward } satisfies OverflowMover;
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
    gitStatus: (cwd) =>
      git.statusDetails(cwd).pipe(
        Effect.map((status) =>
          status.isRepo
            ? {
                branch: status.branch,
                isDefaultBranch: status.isDefaultBranch,
                hasWorkingTreeChanges: status.hasWorkingTreeChanges,
                upstreamRef: status.hasUpstream ? status.upstreamRef : null,
                aheadCount: status.aheadCount,
              }
            : null,
        ),
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
      const found: Array<ProjectId> = [];
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
          if (project.repositoryIdentity?.canonicalKey === key) found.push(project.id);
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
