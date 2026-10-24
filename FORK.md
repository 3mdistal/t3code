# Alice's T3 Code fork

This is Alice's fork of [T3 Code](https://github.com/pingdotgg/t3code). It follows upstream's stable releases
(tags `vX.Y.Z`, no suffix) and carries a small stack of patches for her own features. This file is the brief for
anyone changing the stack, and above all for the agent that resolves a sync conflict.

## Why it exists

Alice used to run stock T3 Code Nightly. The fork lets her run features upstream doesn't have yet, such as
account pools and per-machine CPU and RAM limits, while staying on upstream's stable releases. She runs it on her
Windows PC (TEENYLILPC) and her Mac Mini. Agents may install and test on the Mac Mini, never on her MacBook.

## Branches

- `fork/main` is the newest upstream stable tag plus the patch stack, and the repository's default branch. Every
  release builds from it.
- `sync/vX.Y.Z` holds a sync's rebased stack while Fork CI checks it.
- `main`, and every other branch and tag that came with the fork, is upstream's and frozen. Never push to them,
  and never push another upstream branch or tag here: their commits carry upstream's workflows with live triggers.
- Features land through pull requests into `fork/main`, squashed to a few commits each, with titles prefixed
  `fork:`, `pools:` or `limits:`. Merge them by rebasing, so the stack stays linear.

## Rules for every fork change

- **Stock T3 must always be able to open the fork's data.** No database migrations, no new persisted event types,
  and settings only under new keys. Switching back to stock T3 is the rollback, so this is what keeps it safe.
- Keep patches small and attach them at upstream's existing seams. Mark each changed upstream line with a `fork:`
  comment that points here.
- Put fork-only tests in new `*.fork.test.ts` files or under `scripts/fork/`, so upstream never edits them.
- Never publish a release whose checks failed.

## Patches

Each entry says what the patch is for, the files it touches, and the tests that prove it.

### Releases come from this fork (`fork:`)

Every path that downloads T3 Code reads this fork's releases, so no fork build installs stock T3 over itself.

- `packages/shared/src/cliRelease.ts`: `CLI_RELEASE_REPOSITORY` drives `t3 update`, the server's self-update, and
  SSH installs.
- `apps/web/src/components/desktopUpdate.logic.ts`: `DEFAULT_DESKTOP_RELEASE_REPOSITORY` drives the release notes
  and history links.
- `scripts/install.sh` and `scripts/install.ps1`: the one-line installers.
- The desktop updater needs no patch. `scripts/build-desktop-artifact.ts` writes the update feed for the
  repository the release workflow runs in.
- `ModelManifest` is left alone: it fetches model lists, not builds.
- Tests: `packages/shared/src/cliRelease.fork.test.ts` and `scripts/fork/versionScheme.test.ts`. Upstream's
  `apps/server/src/cli/update.test.ts`, `apps/web/src/components/desktopUpdate.logic.test.ts` and
  `apps/mobile/src/features/settings/environment-maintenance.test.ts` expect the fork's URLs.

### `t3 triage` is off (`fork:`)

`t3 triage` searches and files public issues on `pingdotgg/t3code`. Alice reports this fork's bugs privately, so
the command prints why it's off and exits 1. File: `apps/server/src/cli/triage.ts` (`TRIAGE_ENABLED`).

### `t3 thread start --option` (`fork:`)

A repeatable `--option id=value` flag sets model options, such as `effort=xhigh`, so the sync's conflict thread
starts at the right effort. File: `apps/server/src/cli/thread.ts`. Test: `apps/server/src/cli/thread.fork.test.ts`.

### macOS signing without upstream's App ID (`fork:`)

Upstream's passkey entitlements need a provisioning profile for upstream's App ID, which the fork can't get.

- `scripts/build-desktop-artifact.ts`: a signed build without `T3CODE_MACOS_PROVISIONING_PROFILE` skips the
  passkey entitlements, and an unsigned build is signed ad hoc.
- `apps/desktop/resources/entitlements.mac.plist`: upstream's entitlements minus the ones that need a profile.
  electron-builder signs with it when there are no passkey entitlements.
- `.github/workflows/release-desktop.yml`: `APPLE_TEAM_ID` and `MACOS_PROVISIONING_PROFILE` are optional.
- Tests: `scripts/fork/versionScheme.test.ts` holds the plist to upstream's rendered entitlements and checks the
  ad hoc identity.

### Fork CI, release and sync (`fork:`)

- Only the fork's own workflows run here: `fork-ci.yml`, `fork-release.yml`, `fork-windows-tests.yml`, and
  upstream's `release-desktop.yml`, which `fork-release.yml` calls. Every other workflow is upstream's, with its
  `on:` triggers commented out and `workflow_call`, which nothing calls, in their place. This is deliberate:
  upstream's release, deploy and bot workflows would publish, deploy or label here, and GitHub can't disable a
  workflow before it first runs. The files stay, rather than being deleted, because upstream's tests and knip read
  them.
- `.github/workflows/fork-ci.yml` and `fork-windows-tests.yml` are generated from upstream's `ci.yml` and
  `windows-tests.yml`, with upstream's Blacksmith runners swapped for GitHub-hosted ones.
- `scripts/fork/ci-workflows.ts` does all of the above. Never edit its output by hand: run
  `node scripts/fork/ci-workflows.ts`. The sync runs it after every rebase, and `scripts/fork/ci-workflows.test.ts`
  fails CI if any upstream workflow could run.
- `.github/workflows/fork-release.yml`, `scripts/fork/versions.ts` and `scripts/fork/sync.ts`, described below.
- Tests: `scripts/fork/*.test.ts` and `apps/desktop/src/updates/updateChannels.fork.test.ts`.

### Account pools (`pools:`)

Two or more accounts of one provider act as one pool, so a thread that reaches a usage limit continues on the
account with the most usage left instead of stopping. Ported from ScriptedAlchemy's fork. Users read about it in
the Account pools section of `docs/user/providers-claude.md`.

- Pool-only files: `packages/contracts/src/providerPool.ts`, `packages/client-runtime/src/providerPools.ts`,
  `packages/shared/src/providerInstanceDisplay.ts`, `apps/server/src/provider/providerPoolSnapshot.ts`, and
  `ProviderPoolCatalog.ts`, `ProviderPoolRouting.ts`, `ProviderPoolDispatch.ts` and `ProviderPoolFailover.ts` in
  `apps/server/src/orchestration-v2/`. On the web, `ProviderPoolsSettings.tsx` and its `.logic.ts`,
  `ProviderLimitedUntil.tsx`, and `routes/settings.account-pools.tsx`.
- Upstream files it changes most:
  - `apps/server/src/orchestration-v2/Orchestrator.ts`: every command that starts or moves a turn routes its
    model choice through `ProviderPoolDispatch.ts`, and failover is the internal `run.pool-failover` command.
    Failover reuses upstream's steering restart, which the patch moves into `replaceRunAttempt` with upstream's
    variable names kept, so most upstream edits to that code rebase without conflicts.
  - `apps/server/src/provider/ProviderRegistry.ts`: publishes each pool as a provider and remembers limited
    accounts.
  - `apps/server/src/serverSettings.ts`: the `providerPools` key, and the reserved `pool_` instance ids. Pool
    validation lives in `ProviderPoolRouting.ts`.
  - `runtimeLayer.ts` and the replay harness build run execution over the orchestrator, because the usage-limit
    hook dispatches into it. Both keep upstream's layer order and reach the orchestrator through `Layer.suspend`.
  - The web model picker, the Providers settings, and the project default model picker, which lists the pool in
    place of its accounts as the composer does.
- Stock compatibility:
  - Pools live under the new `providerPools` settings key.
  - Failover emits only `turn-item.updated` and `system_notice`.
  - Every saved model choice names an account, never the pool: scheduled tasks, the default model in settings and
    project overrides, the project's own default, and the commit message, title and review guide models. Each
    stores the pool's first enabled account, which stock T3 runs as is. On the fork, a thread started on a pooled
    account still uses the pool. Settings saves do this in `serverSettings.ts`, and project updates in
    `ProjectService.ts`.
  - Stock T3 drops `providerPools` the next time it saves settings, so after a rollback the accounts stay but
    the pool is gone.
- Markers: each change to an upstream file has a `fork:` comment on its line, or above it for a block. The
  exceptions are `apps/web/src/routeTree.gen.ts`, which is generated, and the `package.json` files of
  `client-runtime` and `shared`, which can't hold comments.
- Tests: each pool-only module has a `.fork.test.ts`, and so does each upstream module the patch changes in a way
  a test can see, such as `serverSettings`, `ProjectService`, `OrchestratorMcpService`, `ScheduledTaskService`,
  `providerStatusCache`, `ChatView.logic`, `providerInstances` and `handoff`. Upstream test files keep only marked
  lines that the patch's required fields need, such as `providerPools: {}` or `markLimited` in a mock.

### Memory and CPU limits (`limits:`)

Each machine has its own memory and CPU limits, so agent sessions can't push it into running out of memory, as
they did on the PC on 2026-10-21. These are teenylilconfig's memory gate rules, moved into T3's run scheduler.
Users read about it in the Memory and CPU limits section of `docs/user/remote-access.md`.

- Every 15 s the server reads commit headroom and available memory on Windows, or memory pressure and available
  memory on macOS, plus CPU. Linux keeps upstream's cap and has no fork limits.
- While a machine is over its limits, a run Alice didn't start herself from web or mobile waits in its thread's
  queue, held, with a `system_notice`. Her own messages always start, and so does a queue holding one of them.
  Work launched from a thread whose latest message is her "launch anyway" starts too. Idle sessions close on
  every pass over the limits, before anything waits. Below the critical line, the newest running turn is
  interrupted every 30 s, and its thread queues a resume note. Held threads start oldest first, 90 s apart.
- Limit-only files: `apps/server/src/resourceLimits/`, and `packages/contracts/src/resourceLimits.ts`.
- Upstream files it changes:
  - `apps/server/src/orchestration-v2/Orchestrator.ts`: the three places a run can start call into
    `resourceLimits/OrchestratorAdmission.ts`: `dispatchMessage`, `startNextQueuedRun`, and
    `dispatchPreparedRunRelease`. Resume, Send now, and the governor's releases pass `admitted`. A run held with
    nothing to queue behind takes upstream's queue branch, which the patch lets run without an active run.
  - `ProviderSessionManager.ts`: `releaseIdleSessions`, which picks sessions with `idleSessionsToClose` and closes
    them through upstream's `releaseEntry`.
  - `runtimeLayer.ts` wires the governor. `ws.ts` adds the limits to `serverGetHostResources`.
  - Contracts and `serverSettings.ts`: the `resourceLimits` settings key, the `resourceLimits` capability, and
    `HostResourcesSnapshot.limits`.
- The memory gate's hook reads the governor's files under `<stateDir>/resource-limits/`:
  - `state.json`: state, readings, waiting threads, and each running session's thread and "launch anyway". It's
    rewritten every pass, so a stale file means T3 isn't guarding.
  - `off.json`: `memgate off` writes `{ at, until }` in epoch ms. It switches the limits off for at most a day.
  - `inbox/`: one record per subagent launch the hook refused. Its thread resumes with a note listing them.
- Stock compatibility: holds, notices and resume notes reuse `run.updated`, `turn-item.updated` and system
  notifications. Stock T3 drops `resourceLimits` the next time it saves settings.
- Known gaps:
  - Forks and merge-backs aren't held.
  - Upstream refuses to snooze a thread with a queued message of its own. So held agent messages stay in the
    inbox, and only threads holding notifications alone (interrupted turns, refused launches) get snoozed.
- Tests: `apps/server/src/resourceLimits/*.fork.test.ts` and `packages/shared/src/serverSettings.fork.test.ts`.
  `Governor.fork.test.ts` runs the real orchestrator with fake readings and a test clock.

## Versions

A release is `vX.Y.Z-alice.N`. `X.Y.Z` is the upstream stable tag the stack sits on, and `N` counts the fork's
releases on that base, from 1. The tag needs the `v`, because installers download from `/releases/download/v<version>`.

Upstream's code already handles this shape, and `scripts/fork/versionScheme.test.ts` fails a sync if that changes:

- Anything without `-nightly` or `-preview` builds as a production app on the `latest` update channel.
- electron-updater compares semver, so `0.1.3-alice.2` is newer than `0.1.3-alice.1`, and `0.1.4-alice.1` is
  newer than any `0.1.3-alice.N`.
- The `t3` CLI treats it as a stable release.

## Releasing

Every push to `fork/main` runs **Fork release**. It:

1. Picks the next version (`node scripts/fork/versions.ts release-version`). A commit that already has a release
   tag publishes nothing, so re-running is safe.
2. Runs Fork CI on that exact commit. A rebased pull request lands as new commits, so the PR's own run doesn't count.
3. Builds macOS arm64, Linux x64 and Windows x64 on GitHub's runners with `release-desktop.yml`. Windows builds on
   Linux like upstream's, runs its checks on `windows-2025`, and embeds the Linux CLI archive as its WSL runtime.
4. Publishes `vX.Y.Z-alice.N` as the latest release, with the installers, the update manifests (`latest.yml`,
   `latest-mac.yml`, `latest-linux.yml`), the blockmaps, the CLI archives, and `SHA256SUMS`.

Nothing is published unless CI and every build pass. If publishing fails partway, delete the half-made release
with `gh release delete vX.Y.Z-alice.N --cleanup-tag --yes` and re-run the workflow.

Installed apps check the fork's latest release 15 seconds after launch and then every 4 minutes. A new release
shows in the sidebar's update pill, which downloads it and then restarts into it. This is upstream's flow: the app
never downloads or installs an update on its own. Headless servers update with `t3 update`.

### Signing

- **Windows** builds are unsigned. SmartScreen warns once on a fresh install (More info, then Run anyway).
  Updates aren't signature-checked, since an unsigned build carries no publisher name.
- **macOS** builds are signed and notarized when the repository has the secrets `CSC_LINK`, `CSC_KEY_PASSWORD`,
  `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. Without them, they're signed ad hoc: clear the
  quarantine flag once with `xattr -dr com.apple.quarantine "/Applications/T3 Code (Beta).app"`. macOS only
  updates an app in place when every version carries the same real signature, so a Mac without signed builds
  updates by hand.

## Syncing with upstream

Task Scheduler on the PC runs `node scripts/fork/sync.ts run` every Monday and Thursday at 6:00 ET. teenylilconfig
registers the task and passes the PC's flags (`--thread-project`, `--t3`, `--usage-tool`, `--memgate`). Each run:

1. Finds upstream's newest stable tag. If `fork/main` already sits on it, the run ends.
2. Rebases the stack (`<old base>..fork/main`) onto the new tag in a scratch worktree beside the clone
   (`<clone>-sync/vX.Y.Z`). A stack commit upstream has since released, such as a backport, drops out. A conflict
   in one of upstream's own workflows resolves itself: the sync takes upstream's side, including a deletion, and
   comments the triggers out again.
3. Reruns `scripts/fork/ci-workflows.ts`, so upstream's new or changed workflows get their triggers commented out
   and the fork CI copies follow upstream's.
4. Pushes `sync/vX.Y.Z`, then waits for Fork CI. It refuses to push a stack where any upstream workflow could run.
   Upstream's stable tags never go to the fork; the release workflow reads them from upstream.
5. If CI passes, it promotes: tags the old `fork/main` as `backup/fork-main-before-vX.Y.Z` and moves `fork/main`
   to the new stack, after the same workflow check. The release workflow then publishes `vX.Y.Z-alice.1`.
6. On any other conflict or a CI failure, it starts **one** Claude Opus 5.5 thread at xhigh effort in Alice's
   teenylilthoughts project, on the Claude account with the most room, once the memory gate allows. The thread
   gets this file, upstream's changes since the last base with their pull requests, and the failing step. Later
   runs leave it alone while it works. State lives in `<clone>-sync/state.json`.

No agent runs when nothing conflicts. `node scripts/fork/sync.ts run --dry-run` reports what a run would do
without pushing or starting anything.

## Resolving a sync conflict

You've been given a worktree where the stack is rebased onto a new upstream release, and either the rebase
stopped on a conflict or Fork CI failed. Your job is a passing release, or a clear note to Alice about what you need.

- **Assume upstream's maintainers are smart.** When they changed code a patch touches, read their pull request to
  learn why, then rebuild the patch on their new design. Don't paste the old patch back over it.
- **If upstream now does what a patch does,** propose dropping the patch. Ask Alice before removing a feature.
- **Never revert or weaken an upstream change to make a patch apply.**
- Keep the rules for every fork change above.
- **Never publish a release whose checks failed.** `sync.ts promote` refuses to move `fork/main` until Fork CI
  passes on the branch.
- If you change what a patch does or where it lives, update its entry in this file in the same commit.

When the stack is fixed, push it with `node scripts/fork/sync.ts push vX.Y.Z`, then run
`node scripts/fork/sync.ts promote vX.Y.Z` from the worktree. Both refuse a stack where one of upstream's workflows
could run; `node scripts/fork/ci-workflows.ts` fixes that. If `fork/main` gained commits since the sync started,
`promote` says so: rebase those onto your branch too, push, and pass `--based-on <new fork/main sha>`.

## Rolling back

- **To stock T3:** install stock T3 Code over the fork. The rules above keep the fork's data readable by it.
- **To an earlier fork release:** install that release's installer from the releases page. The updater never
  moves backwards on its own.
- **After a bad sync:** move `fork/main` back with
  `git push --force-with-lease origin backup/fork-main-before-vX.Y.Z:refs/heads/fork/main`. That publishes
  nothing; the next push to `fork/main` publishes the next `N`.

## Known limitations

- The desktop updater's nightly channel finds no updates, since the fork publishes no nightly builds.
- "Update everything" waits for npm before updating servers that install `t3` from npm, and the fork doesn't
  publish to npm. Those servers stay where they are until updated with `t3 update`. Desktop-hosted servers update
  with their app.
- The stock mobile app may suggest stock versions for a fork server. Applying one fails harmlessly, because the
  server downloads from the fork, which has no such release.
- Upstream's branches on the fork, `main` among them, still have live triggers, so a pull request into one could
  run upstream's workflows. Point pull requests at `fork/main`. The workflows that ran here before their triggers
  were commented out are disabled in the repository's Actions settings.
- Signed macOS builds have no passkey entitlements, so passkey and Touch ID sign-in to T3 Connect don't work in
  them.
- A `t3` older than the `--option` flag starts the conflict thread at the model's default effort. The sync log says
  when that happens.
- An account pool remembers a limited account only until the server restarts. Until fresh usage arrives, a
  restarted server may try that account again.
- A pooled Claude account reads earlier turns with `t3_thread_read`, which Claude's read-only mode doesn't
  pre-approve.
