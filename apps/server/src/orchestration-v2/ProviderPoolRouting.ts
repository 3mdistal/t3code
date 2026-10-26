import {
  defaultInstanceIdForDriver,
  findProviderPool,
  isProviderAvailable,
  isProviderDriverKind,
  providerLimitedUntilMs,
  providerPoolDriver,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ProjectSettingsOverrides,
  ServerSettingsError,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
  type ThreadId,
} from "@t3tools/contracts";
import { isModelSelectionProviderEnabled } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";

export interface PoolMemberHealth {
  readonly instanceId: ProviderInstanceId;
  readonly eligible: boolean;
  /** Shared with every member on the same credential fingerprint or login email: one login is one quota. */
  readonly limitedUntilMs: number | null;
  readonly usedPercent: number | null;
  readonly continuationKey: string | null;
}

export interface PoolRoutingInput {
  /** Pool order; it breaks every tie. */
  readonly members: ReadonlyArray<PoolMemberHealth>;
  readonly threadId: ThreadId;
  readonly current: {
    readonly instanceId: ProviderInstanceId;
    /** A run is active on it: steering and queueing never move a live turn. */
    readonly busy: boolean;
  } | null;
  readonly excluded: ReadonlySet<ProviderInstanceId>;
  readonly nowMs: number;
}

export type PoolRoutingDecision =
  | {
      readonly type: "member";
      readonly instanceId: ProviderInstanceId;
      readonly reason: "busy" | "affinity" | "same_continuation" | "spread";
    }
  /**
   * Every eligible member is cooling. The turn still goes to one of them so
   * today's limit banner and auto-resume run, with the pool's earliest reset.
   */
  | {
      readonly type: "all_limited";
      readonly instanceId: ProviderInstanceId;
      readonly earliestResetAtMs: number;
    }
  | { readonly type: "no_eligible_member" };

/** FNV-1a, 32-bit, over `${threadId}\u0000${instanceId}`. */
export function rendezvousScore(threadId: ThreadId, instanceId: ProviderInstanceId): number {
  const text = `${threadId}\u0000${instanceId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const isCooling = (member: PoolMemberHealth, nowMs: number): boolean =>
  member.limitedUntilMs !== null && member.limitedUntilMs > nowMs;

/**
 * Rendezvous hashing breaks quota ties with no cursor to persist, and a
 * member that cools moves only its own threads.
 */
export function choosePoolMember(input: PoolRoutingInput): PoolRoutingDecision {
  const candidates = input.members.filter(
    (member) => member.eligible && !input.excluded.has(member.instanceId),
  );
  const current = candidates.find((member) => member.instanceId === input.current?.instanceId);
  if (current !== undefined && input.current?.busy) {
    return { type: "member", instanceId: current.instanceId, reason: "busy" };
  }
  const healthy = candidates.filter((member) => !isCooling(member, input.nowMs));
  if (current !== undefined && !isCooling(current, input.nowMs)) {
    return { type: "member", instanceId: current.instanceId, reason: "affinity" };
  }
  const sibling =
    current?.continuationKey === null || current === undefined
      ? undefined
      : healthy.find((member) => member.continuationKey === current.continuationKey);
  if (sibling !== undefined) {
    return { type: "member", instanceId: sibling.instanceId, reason: "same_continuation" };
  }
  const spread = healthy.reduce<PoolMemberHealth | undefined>(
    (best, member) =>
      best === undefined ||
      (member.usedPercent ?? 0) < (best.usedPercent ?? 0) ||
      ((member.usedPercent ?? 0) === (best.usedPercent ?? 0) &&
        rendezvousScore(input.threadId, member.instanceId) >
          rendezvousScore(input.threadId, best.instanceId))
        ? member
        : best,
    undefined,
  );
  if (spread !== undefined) {
    return { type: "member", instanceId: spread.instanceId, reason: "spread" };
  }
  const earliest = candidates.reduce<PoolMemberHealth | undefined>(
    (best, member) =>
      best === undefined || (member.limitedUntilMs ?? 0) < (best.limitedUntilMs ?? 0)
        ? member
        : best,
    undefined,
  );
  if (earliest === undefined) {
    return { type: "no_eligible_member" };
  }
  return {
    type: "all_limited",
    instanceId: current?.instanceId ?? earliest.instanceId,
    earliestResetAtMs: earliest.limitedUntilMs ?? input.nowMs,
  };
}

export function earliestPoolResetAtMs(
  members: ReadonlyArray<PoolMemberHealth>,
  nowMs: number,
): number | null {
  const eligible = members.filter((member) => member.eligible);
  if (eligible.length === 0 || eligible.some((member) => !isCooling(member, nowMs))) return null;
  return Math.min(...eligible.map((member) => member.limitedUntilMs ?? nowMs));
}

const isMemberHealthy = (provider: ServerProvider): boolean =>
  provider.enabled &&
  provider.installed &&
  isProviderAvailable(provider) &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.auth.status !== "unauthenticated";

const sharesLogin = (a: ServerProvider, b: ServerProvider): boolean => {
  const aFingerprint = a.usageLimits?.credentialFingerprint;
  const bFingerprint = b.usageLimits?.credentialFingerprint;
  if (aFingerprint !== undefined && bFingerprint !== undefined) {
    return aFingerprint === bFingerprint;
  }
  const email = a.auth.email?.trim().toLowerCase();
  return email !== undefined && email !== "" && email === b.auth.email?.trim().toLowerCase();
};

/**
 * The windows that stop every model on an account. One model's own weekly
 * window or an extra-usage budget leaves the account's other work running.
 */
const ACCOUNT_WINDOW_IDS = new Map<string, ReadonlySet<string>>([
  ["claudeAgent", new Set(["five_hour", "seven_day"])],
  ["codex", new Set(["primary", "secondary", "individual"])],
]);

const accountWindows = (provider: ServerProvider) => {
  const ids = ACCOUNT_WINDOW_IDS.get(provider.driver);
  return (provider.usageLimits?.windows ?? []).filter(
    (window) => ids === undefined || ids.has(window.id),
  );
};

/** A spent window holds the account until it resets, as a limit error would. */
const spentUntilMs = (provider: ServerProvider, nowMs: number): ReadonlyArray<number> =>
  accountWindows(provider).flatMap((window) => {
    const resetsAtMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    return window.usedPercent >= 100 && resetsAtMs > nowMs ? [resetsAtMs] : [];
  });

export function poolMemberHealth(input: {
  readonly members: ReadonlyArray<ServerProvider>;
  readonly settings: Parameters<typeof resolveProjectProviderInstanceEnabled>[0];
  readonly projectId: ProjectId;
  readonly nowMs: number;
}): ReadonlyArray<PoolMemberHealth> {
  return input.members.map((member) => {
    const sharing = input.members.filter(
      (candidate) => candidate === member || sharesLogin(member, candidate),
    );
    const untilMs = sharing.flatMap((candidate) => {
      const limited = providerLimitedUntilMs(candidate, input.nowMs);
      const spent = spentUntilMs(candidate, input.nowMs);
      return limited === null ? spent : [...spent, limited];
    });
    const limitedUntilMs = untilMs.length === 0 ? null : Math.max(...untilMs);
    const usedPercent = sharing
      .flatMap(accountWindows)
      .reduce<number | null>((highest, window) => Math.max(highest ?? 0, window.usedPercent), null);
    return {
      instanceId: member.instanceId,
      eligible:
        isMemberHealthy(member) &&
        resolveProjectProviderInstanceEnabled(input.settings, input.projectId, member.instanceId),
      limitedUntilMs,
      usedPercent,
      continuationKey: member.continuation?.groupKey ?? null,
    };
  });
}

export type RoutedSelection =
  | { readonly type: "unrouted"; readonly selection: ModelSelection }
  | {
      readonly type: "routed";
      /** `instanceId` is always a concrete member. */
      readonly selection: ModelSelection;
      readonly pool: ServerProvider;
      readonly decision: Exclude<PoolRoutingDecision, { readonly type: "no_eligible_member" }>;
    }
  | { readonly type: "no_eligible_member"; readonly pool: ServerProvider };

/**
 * The one routing entry for every place a selection enters a thread. A
 * selection naming a pool or any of its members routes: pooling an account
 * declares it interchangeable. A dangling pool id (pool off or deleted)
 * resolves to the thread's current same-driver instance, else the driver's
 * default, so drafts and scheduled tasks never strand.
 */
export function routeModelSelection(input: {
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Parameters<typeof resolveProjectProviderInstanceEnabled>[0];
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly current: PoolRoutingInput["current"];
  readonly excluded?: ReadonlySet<ProviderInstanceId>;
  readonly nowMs: number;
}): RoutedSelection {
  const owner = findProviderPool(input.providers, input.selection.instanceId);
  if (owner === null) {
    const driver = providerPoolDriver(input.selection.instanceId);
    if (driver === null) return { type: "unrouted", selection: input.selection };
    const currentProvider = input.providers.find(
      (provider) => provider.instanceId === input.current?.instanceId,
    );
    const instanceId =
      currentProvider?.driver === driver
        ? currentProvider.instanceId
        : defaultInstanceIdForDriver(driver);
    return { type: "unrouted", selection: { ...input.selection, instanceId } };
  }
  const decision = choosePoolMember({
    members: poolMemberHealth({
      members: owner.members,
      settings: input.settings,
      projectId: input.projectId,
      nowMs: input.nowMs,
    }),
    threadId: input.threadId,
    current: input.current,
    excluded: input.excluded ?? new Set(),
    nowMs: input.nowMs,
  });
  if (decision.type === "no_eligible_member") {
    return { type: "no_eligible_member", pool: owner.pool };
  }
  return {
    type: "routed",
    selection: { ...input.selection, instanceId: decision.instanceId },
    pool: owner.pool,
    decision,
  };
}

/**
 * Stock T3 has no pool ids, so a selection saved for later names the pool's
 * first account instead. Here that account still routes through the pool;
 * after a rollback to stock T3 the saved selection still runs on it.
 */
export function storableModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): ModelSelection {
  const owner = findProviderPool(providers, selection.instanceId);
  const firstMember = owner?.members[0];
  return owner?.pool.instanceId === selection.instanceId && firstMember !== undefined
    ? { ...selection, instanceId: firstMember.instanceId }
    : selection;
}

/**
 * The same rule for a selection saved in settings, which sit below the
 * provider registry and so can only see the configured pool: its first
 * enabled account.
 */
export function storableSettingsModelSelection(
  settings: ServerSettings,
  selection: ModelSelection,
): ModelSelection {
  const driver = providerPoolDriver(selection.instanceId);
  const member = driver
    ? settings.providerPools[driver]?.memberInstanceIds.find((instanceId) =>
        isModelSelectionProviderEnabled(settings, { ...selection, instanceId }),
      )
    : undefined;
  return member === undefined ? selection : { ...selection, instanceId: member };
}

/** Every model choice settings save, environment-wide and per project, names an account. */
export function withStorablePoolSelections(settings: ServerSettings): ServerSettings {
  const store = (selection: ModelSelection) => storableSettingsModelSelection(settings, selection);
  const storeOverrides = (overrides: ProjectSettingsOverrides): ProjectSettingsOverrides => ({
    ...overrides,
    ...(overrides.defaultModelSelection
      ? { defaultModelSelection: store(overrides.defaultModelSelection) }
      : {}),
    ...(overrides.textGenerationModelSelection
      ? { textGenerationModelSelection: store(overrides.textGenerationModelSelection) }
      : {}),
    ...(overrides.sourceControlWriterModelSelection
      ? { sourceControlWriterModelSelection: store(overrides.sourceControlWriterModelSelection) }
      : {}),
    ...(overrides.reviewGuideModelSelection
      ? { reviewGuideModelSelection: store(overrides.reviewGuideModelSelection) }
      : {}),
  });
  return {
    ...settings,
    defaultModelSelection: settings.defaultModelSelection && store(settings.defaultModelSelection),
    textGenerationModelSelection: store(settings.textGenerationModelSelection),
    sourceControlWriterModelSelection:
      settings.sourceControlWriterModelSelection &&
      store(settings.sourceControlWriterModelSelection),
    reviewGuideModelSelection:
      settings.reviewGuideModelSelection && store(settings.reviewGuideModelSelection),
    projectSettingsOverrides: Record.map(settings.projectSettingsOverrides, storeOverrides),
  };
}

/** A removed account leaves every pool it was in. */
export function withoutPoolMember(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): ServerSettings {
  return {
    ...settings,
    providerPools: Record.map(settings.providerPools, (pool) => ({
      ...pool,
      memberInstanceIds: pool.memberInstanceIds.filter((memberId) => memberId !== instanceId),
    })),
  };
}

/**
 * A built-in driver's default instance exists without a settings entry, and
 * its id is the driver kind, so an unconfigured member resolves that way.
 */
const configuredInstanceDriver = (
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): ProviderDriverKind | undefined =>
  settings.providerInstances[instanceId]?.driver ??
  (isProviderDriverKind(instanceId) ? instanceId : undefined);

/** Fails a write that changes pools when a member is repeated or runs another driver. */
export function validatedProviderPools(
  next: ServerSettings,
  patch: ServerSettingsPatch,
  settingsPath: string,
): Effect.Effect<ServerSettings, ServerSettingsError> {
  if (patch.providerPools === undefined) return Effect.succeed(next);
  for (const [driver, pool] of Object.entries(next.providerPools)) {
    const seen = new Set<ProviderInstanceId>();
    for (const memberId of pool.memberInstanceIds) {
      if (seen.has(memberId) || configuredInstanceDriver(next, memberId) !== driver) {
        return Effect.fail(
          new ServerSettingsError({
            settingsPath,
            operation: "validate-provider-pool",
            providerInstanceId: memberId,
          }),
        );
      }
      seen.add(memberId);
    }
  }
  return Effect.succeed(next);
}
