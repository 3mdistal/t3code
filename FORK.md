# Alice's T3 Code fork

This is Alice's fork of [T3 Code](https://github.com/pingdotgg/t3code). It follows upstream's stable releases
(tags `vX.Y.Z`, no suffix) and carries a small stack of patches for her own features. This file is the brief for
anyone changing the stack, and above all for the agent that resolves a sync conflict.

## Why it exists

Alice used to run stock T3 Code Nightly. The fork lets her run features upstream doesn't have yet, such as
account pools and per-machine CPU and RAM limits, while staying on upstream's stable releases. She runs it on her
Windows PC (TEENYLILPC), her MacBook and her Mac Mini. When she approves a landing, agents install the release on
the PC and the MacBook, reaching the MacBook through T3's linked environments. Other agent work on the MacBook stays
headless, and agents may install and test freely on the Mac Mini.

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
- `apps/web/src/lib/bootError.ts`: `DOWNLOAD_URL`, the reinstall link on the screen T3 shows when it can't start.
- `scripts/install.sh` and `scripts/install.ps1`: the one-line installers.
- The desktop updater needs no patch. `scripts/build-desktop-artifact.ts` writes the update feed for the
  repository the release workflow runs in.
- `ModelManifest` is left alone: it fetches model lists, not builds.
- Tests: `packages/shared/src/cliRelease.fork.test.ts` and `scripts/fork/versionScheme.test.ts`. Upstream's
  `apps/server/src/cli/update.test.ts`, `apps/web/src/components/desktopUpdate.logic.test.ts`,
  `apps/mobile/src/features/settings/environment-maintenance.test.ts` and `scripts/install.test.ts` expect the
  fork's URLs.

### Triage is off (`fork:`)

Triage searches and files public issues on `pingdotgg/t3code`. Alice reports this fork's bugs privately, so it's
off. `t3 triage` prints why and exits 1. Upstream v0.1.4 also added Triage to the web and mobile command palettes,
which start an agent on the same playbook through `apps/server/src/triage/`. The server doesn't advertise the
`triage` capability, so the palettes leave it out. It also refuses `server.prepareTriage`, for a client that
offers it anyway: the error's cause carries the reason, but clients show the error's own message, "Could not write
the triage session files." The screen T3 shows when it can't start used to suggest `npx t3 triage`, upstream's npm
package, where triage is on, and to link to upstream's issue form. Neither is there now. The error details and
their copy button stay, for reporting by hand.

- `apps/server/src/triage/triageOff.ts`: `TRIAGE_ENABLED`, the reason, and the refusal.
- `apps/server/src/cli/triage.ts`, `apps/server/src/ws.ts` and `apps/server/src/environment/ServerEnvironment.ts`
  read it.
- `apps/web/src/lib/bootError.ts` and its styles in `apps/web/index.html`: the startup failure screen. Upstream's
  tests of `resolveTriageCommand` went with it.
- Tests: `apps/server/src/triage/triageOff.fork.test.ts`,
  `apps/server/src/environment/ServerEnvironment.fork.test.ts` and
  `apps/web/src/lib/bootError.fork.browser.test.ts`. Upstream's `TriageService.test.ts` passes unchanged, since
  only the request handler refuses.

### `t3 thread start --option` (`fork:`)

A repeatable `--option id=value` flag sets model options, such as `effort=xhigh`, so the sync's conflict thread
starts at the right effort. File: `apps/server/src/cli/thread.ts`. Test: `apps/server/src/cli/thread.fork.test.ts`.

### Codex's `$` menu hides `user-invocable: false` skills (`fork:`)

Skills Alice doesn't type carry `user-invocable: false` in their SKILL.md frontmatter. T3 already hides those
from Claude's `$` menu, but Codex's `skills/list` has no such flag, so every Codex skill showed. The fork reads each
listed skill's SKILL.md with Claude's frontmatter parser and marks it. Only the menu changes; the model still sees
every skill. A missing or unreadable file leaves its skill visible. Reads get 2 s at most, and in the machine probe
they run alongside model discovery and stop at its deadline, so a slow disk can't cost the probe its account and
models; skills come back unmarked, so visible, when time runs out.

- `apps/server/src/provider/codexSkillInvocability.ts`: `markCodexSkillsUserInvocable`.
- `apps/server/src/provider/CodexProvider.ts`: the machine probe marks its skills inside its discovery deadline,
  and `probeCodexSkillsForCwd` passes its parsed skills through it.
- `apps/server/src/provider/Drivers/CodexDriver.ts` and `CodexManagedProvider.ts`: provide the file system to
  their `probeCodexSkillsForCwd` calls.
- `apps/server/src/provider/Drivers/ClaudeSkills.ts`: exports `parseSkillFrontmatter`.
- Test: `apps/server/src/provider/codexSkillInvocability.fork.test.ts`, with the slow-disk cases on the test
  clock.

### Git starts off the event loop on Windows (`fork:`)

Node starts a child process with a synchronous `CreateProcessW` on the event loop. On the PC, one start of Git
for Windows' `git.exe` took about half a second, and pull request discovery starts hundreds of git processes a
minute, so the server froze for seconds at a time. On Windows, plain git commands now start from a worker thread
that relays their stdio, exit codes and kills. Pipelines, shell commands, `git.cmd` shims, detached runs, non-pipe
stdio and every other program keep Effect's spawner. If the worker dies or the server stops, the server ends the
git process trees it knows about with taskkill, or a plain kill when taskkill can't run. Proposed upstream; drop
this patch once upstream ships it or an equivalent.

- `apps/server/src/process/GitSpawnWorker.ts`: the worker and the `ChildProcessSpawner` in front of it.
- `apps/server/src/server.ts`: provides it inside the HTTP server layer, whose `NodeServices` would otherwise give
  every layer it wraps Node's spawner, and outside it for `ProcessRunner` and the rest.
- Test: `apps/server/src/process/GitSpawnWorker.fork.test.ts`, which runs live git.

### Deleting a worktree on Windows no longer starves the file pool (`fork:`)

On Windows, `removeLinkedWorktree` deletes a worktree's folder itself before Git drops its metadata. Node's
recursive `rm` queues an async request per entry on the four-thread pool that every file read and DNS lookup
shares, so deleting a worktree with a pnpm `node_modules` queued 81,180 requests on the PC, a secret read waited
73 seconds and clients showed "reconnecting". The folder is now deleted by a synchronous `lstat` walk on one worker
thread, which leaves that pool free. It unlinks junctions and symlinks without entering them, makes read-only files
writable, and deletes `.git` last (in any case), so a delete stopped partway leaves a worktree that a forced retry
finishes. Interrupting the removal or stopping the server terminates the worker, and the `.git` restore that
followed a failed delete now also follows an interruption, which can land just after `.git` goes. Windows removals
run one at a time, and the slot covers Git's checks too, so a removal queued behind a long delete checks after it
waits rather than acting on stale checks. Not `fs.rmSync`: under Electron 44 it deleted nothing from a folder
holding junctions and reported no error, and a worker can't stop it partway. Git's checks, the final
`git worktree remove --force --force` and other hosts are unchanged. Drop this patch if upstream moves the delete
off the pool.

- `apps/server/src/vcs/worktreeDeleteWorker.ts`: the worker and the one-at-a-time slot.
- `apps/server/src/vcs/worktreeRemoval.ts`: deletes with the worker, restores `.git` on interruption, and exports
  `removeLinkedWorktree` through the slot.
- Test: `apps/server/src/vcs/worktreeDeleteWorker.fork.test.ts`.

### Pull request sweeps skip a redundant git recheck (`fork:`)

`branchPullRequest` rechecks every merged or closed answer against fresh git state, because settlement and worktree
cleanup act on one. Discovery asked for that recheck on every group on every one-minute sweep, although it checks
fresh git state itself before persisting a change, so the recheck started about 105 git processes per sweep on the
PC while changing nothing. Discovery now passes `confirmClosed: false`; settlement and cleanup keep the recheck.
Upstream's open pull request #24099 does this for discovery and settlement both; drop this patch when it lands.

- `apps/server/src/git/GitManager.ts`: the `confirmClosed` option.
- `apps/server/src/orchestration-v2/ThreadPullRequestService.ts`: discovery passes it.
- Tests: `apps/server/src/git/GitManager.fork.test.ts` and
  `apps/server/src/orchestration-v2/ThreadPullRequestService.fork.test.ts`.

### A steer sent before the provider turn starts waits in the queue (`fork:`)

The web composer offers Steer as soon as a run reads as running, which can be seconds before its provider turn
starts. The server sent an explicit steer straight to the run, which then failed with "No running provider turn
found for active run". The fork carries upstream's open pull request #23559, which checks an explicit steer against
the same gaps as automatic delivery, so it queues there. Its manual live check,
`apps/server/scripts/verify-steer-running-turn.ts`, isn't carried. Drop this patch when #23559 lands.

- `apps/server/src/orchestration-v2/CommandPolicy.ts`: `resolveDeliveryIntent`.
- Test: #23559's own changes to `apps/server/src/orchestration-v2/CommandPolicy.test.ts`, which replace upstream's
  assertion that an explicit steer goes straight to the run.

### Connections recover when SQLite is busy (`fork:`)

The checkpoint worker used WAL allocation and a failed truncate as reasons to hold writers, even after every
frame was checkpointed. A reader can prevent reset indefinitely. Admission now counts outstanding frames,
keeping the 10,000-frame backpressure threshold; busy truncation retries in the background. The physical WAL
can retain a reader's pinned prefix plus that backlog and the current transaction until the reader closes.
The existing journal size limit and checkpoint durability settings are unchanged.

Session and WebSocket-ticket verification reserve a separate, lazy read-only worker for their indexed session
lookup. They retain the writer inside an existing write transaction. Upstream added a pool of four reader
workers in v0.1.6 (#27097); the lane is one more worker beside the pool, which the pool never routes to, so
session checks still don't wait behind four long reads. If the lane's worker can't start, those lookups use
the pool and the pool stays on. Without the lane, session checks would wait only while all four pool readers
are held by long reads, so it may be droppable later. Since v0.1.6 upstream itself retries a failed
permission load with backoff while the connection stays up (#27008), so the fork no longer patches the
client; its test checks that sending recovers without a reload after a failed or timed-out load.

- `packages/shared/src/nodeSqliteClient.ts`: checkpoint admission and the interactive read lane. It also
  exports `READER_POOL_SIZE` so the tests can hold every pool reader.
- `apps/server/src/persistence/AuthSessions.ts`: the session lookup uses that lane. Upstream moved this
  lookup from the writer to the bulk reader in v0.1.3 (#23902); the fork swaps that `readOnly` step for the
  reserved lane. The environment descriptor uses static/filesystem state and has no database-read queue.
- Tests: `packages/shared/src/nodeSqliteClient.fork.test.ts`,
  `apps/server/src/auth/SessionStore.fork.test.ts` and
  `packages/client-runtime/src/state/session.fork.test.ts`. The auth test holds the writer, then every pool
  reader, and calls the real repository, session and ticket verifiers, so a sync that bypasses the reserved
  lane fails CI whichever connection upstream otherwise chooses.

### Stalled checkpoint captures can't hold up turns (`fork:`)

On Oct 26, all four orchestration effect workers sat on `checkpoint.capture` effects for over a quarter of an hour.
Seven turn starts and a steer waited behind them until the backend was killed. Three of those captures had already
committed their checkpoint and were stuck in the workspace refresh that follows it. The fork makes two changes:

- Background effects hold at most four workers, and the daemon runs six, so two are always free for the effects
  that drive a turn (`CONTROL_EFFECT_TYPES`: start, steer, interrupt, restart, continue after a restart, answer a
  runtime request, detach a session, and stop an interrupted thread's delegated tasks, which an interrupt that
  holds the queue waits for). A worker with no background slot claims only those. A type upstream adds later
  counts as background. A worker gives its slot back in one uninterruptible step, so an interrupted claim can't
  leak it.
- Once a capture's checkpoint is committed, the capture effect settles. The refresh of the Changes panel and PR
  status runs beside the workers, at most two at a time, and is dropped after five minutes. The thread's next turn
  no longer waits for it. Upstream's refresh skips the PR lookup once a queued follow-up turn has started, and
  that turn can now start before the refresh runs, so the lookup is skipped more often; the follow-up turn's own
  refresh does it.

Upstream hasn't been asked yet.

- `apps/server/src/orchestration-v2/EffectOutbox.ts`: `CONTROL_EFFECT_TYPES`, the `effectTypes` filter on
  `claimNext`, and `nextClaimableAtFor`.
- `apps/server/src/orchestration-v2/EffectWorker.ts`: the background slots, and six workers by default.
- `apps/server/src/orchestration-v2/RunFinalizationService.ts`: the refresh after a capture.
- Tests: `apps/server/src/orchestration-v2/EffectWorker.fork.test.ts` and
  `apps/server/src/orchestration-v2/RunFinalizationService.fork.test.ts`. Upstream's
  `RunFinalizationService.test.ts` and `RunFinalizationQueue.test.ts` pass unchanged: the refresh starts before
  the capture effect returns.

### Restarts retry dispatch and stagger provider starts (`fork:`)

A continuation could fail once while a newly enabled account pool was still loading its health. Its next
four attempts reused the rejected command's receipt and never tried dispatch again, even after the pool
became ready. A temporary SQLite restart snapshot with fake providers reproduces that sequence. The Mac's
Nov 2 continuation rows prove the repeated rejection, but compaction and log rotation removed the first
reason, so the pool-health trigger is reproduced rather than established for that historical attempt.

Each outbox attempt now uses its own dispatch command id and the same continuation message id. A committed
message still deduplicates delivery, while a rejected command no longer poisons later attempts. Continuation
retries wait 5, 10, 20 and 40 seconds instead of spending every attempt during startup.

Provider starts for restart continuations and runs requested before this server started are claimed at
most two at a time, with three seconds between claims. The limit covers provider initialization, not the
entire agent turn. Pending starts wait in the outbox rather than occupying workers; the existing six-worker
and four-background-worker reservation stays in place. New work
requested after startup keeps its ordinary admission. There is no new setting. Memory limits and Pause all
still run before a provider start is enqueued. Stale start effects for terminal runs drain without consuming
the gap, so they cannot block a continuation's startup retry.

A queue behind a turn that will continue retains its existing holds: recovery does not add a hold to messages
that were already waiting to run. Messages already held by Stop, Pause all or the governor remain held.
Idle, stopped, settled and currently snoozed threads retain upstream's restart policy; a restart does not
unsnooze a thread. Threads queued behind an earlier failure without interrupted work are not revived by
this patch. No schema, persisted event type or settings format changes.

- `apps/server/src/orchestration-v2/RestartPacing.ts`: admission predicates and retry identity/delays.
- `EffectOutbox.ts`: applies admission when claiming and calculating the next wake, without sleeping in a worker.
- `EffectWorker.ts` and `RestartContinuation.ts`: pass the attempt to dispatch and use the longer retry delays.
- `ProviderRuntimeRecoveryService.ts`: preserves the queue behind a continuing run, including a continuation
  prepared before a clean shutdown.
- Tests: `RestartPacing.fork.test.ts` exercises claims, stale terminal starts, the gap and control availability on the test
  clock; `ProviderPoolFailover.integration.fork.test.ts` reopens temporary SQLite snapshots with fake providers
  to exercise a rejected pool dispatch, six Claude/Codex continuations and ordered queued messages. Upstream's
  `ProviderRuntimeRecoveryService.test.ts` supplies the new empty-outbox lookup in its queued-work fixture;
  its assertions are unchanged.

### A CPU profile of each freeze on Windows (`fork:`)

On the PC the server's event loop freezes for 4 to 13 seconds within a minute after every noon and midnight, and
for up to 24 seconds at other times. The trace and the stall log show only what was waiting when it stopped, never
the call that held it. On Windows a worker thread now keeps a rolling CPU profile of the main thread, sampled every
10 ms, while the main thread bumps a shared counter four times a second. When the counter stops for 3 seconds or
more, the worker reads the profile back once the main thread is free and saves it as
`logs/freeze-profiles/freeze-<start>-<length>ms.cpuprofile`, which Chrome's DevTools and VS Code open. The profile
covers the freeze and up to two minutes before it; without a freeze it is dropped and restarted every two minutes.
The newest 20 are kept. A pause long enough to stop the worker too, such as a sleeping PC, isn't saved. Each save
logs "freeze profile saved". `T3CODE_FREEZE_PROFILES=0` turns it off. Drop this patch once the freezes are fixed.

- `apps/server/src/observability/FreezeProfiler.ts`: the heartbeat, the worker and its layer.
- `apps/server/src/server.ts`: merges the layer with `EventLoopMonitor`'s.
- Test: `apps/server/src/observability/FreezeProfiler.fork.test.ts` blocks its own main thread and reads the saved
  profile back.

### The ownership lock check stats off the event loop on Windows (`fork:`)

Every 5 seconds the server stats `server-owner.sqlite` to notice if the lock was deleted or replaced. The stat was
synchronous, so a slow disk stopped the whole server: on the PC, profiles of the freezes at noon and midnight show
`statSync` from this loop holding the event loop for 6.8 and 4.9 seconds while a volume snapshot ran. On Windows the
check now uses an asynchronous stat by the same path, and only one runs at a time. A stat stuck on the disk delays
the next check and nothing else. Other platforms keep upstream's call, which upstream's tests rely on: they advance
the test clock and read the result straight away. Proposed upstream once the fork proves it; drop this patch when
upstream ships it or an equivalent.

- `apps/server/src/serverOwnershipLockStat.ts`: the asynchronous stat, with the same result as
  `throwIfNoEntry: false`.
- `apps/server/src/serverOwnership.ts`: picks it on Windows.
- Test: `apps/server/src/serverOwnership.fork.test.ts` holds a stat open and shows the loop waits on it. Upstream's
  "lock file checks" in `serverRuntimeState.test.ts` pass unchanged.

### Database writes run on their own thread on Windows (`fork:`)

T3's reads and checkpoints already run on worker threads, but its one writer connection ran on the event loop. A
statement that waits on the disk stopped the whole server: on the PC, freeze profiles show single statements
holding the event loop for 3 to 12 seconds, three of the five with no volume snapshot running. On Windows the
writer now lives on a worker thread. Each statement is one round trip, and the caller holds the client's writer
lock across it, so statements still run one at a time and in order. Nothing about the database file changes, and
stock T3 opens it as before. Other platforms and in-memory databases keep upstream's writer.
`T3CODE_SQLITE_WRITER_WORKER=0` turns it off. Drop this patch once upstream ships an equivalent.

The checkpoint coordinator's reads of the writer used to be synchronous, and nothing could run while a statement
did. Now it reads what the worker last reported, and a statement on the worker counts as an open transaction, so
no truncate is acknowledged against it. A statement goes to the worker in the same step as its admission check, so
no truncate can get in between. Statement classes come from the same authorizer rules, run on the worker;
keep `writerWorkerSource` in step with the authorizer in `nodeSqliteClient.ts` when upstream changes it. A statement
can't be interrupted once sent, as before. If the worker can't start, the client logs a warning and opens the
writer on the event loop. If it dies later, every write fails with a `SqlError` and an error is logged until T3
restarts, including writes the checkpoint gate was holding: reopening would lose the connection's pragmas and could
resume a transaction that no longer exists.

- `packages/shared/src/nodeSqliteWriterWorker.ts`: the worker, the connection in front of it, and the writer view the
  coordinator reads.
- `packages/shared/src/nodeSqliteClient.ts`: the `writerWorker` option; the coordinator takes that view,
  `runWithAdmission` waits for a statement still on the worker before electing the next writer, and `retire` lets
  held writes through to fail when the worker stops.
- `apps/server/src/persistence/Sqlite.ts`: turns it on for Windows.
- Tests: `packages/shared/src/nodeSqliteWriterWorker.fork.test.ts`, and `nodeSqliteClient.writerWorker.fork.test.ts`
  and `nodeSqliteClient.fork.writerWorker.fork.test.ts`, which rerun the client's tests with the writer on its worker.
  `apps/server/src/persistence/Sqlite.fork.test.ts` covers when it turns on.

### Storage cleanup reads git 2.56's message for a broken worktree (`fork:`)

Git 2.56 reports a linked worktree whose `.git` file points at a missing repository as "gitfile does not point to a
valid repository" instead of "not a git repository". Storage cleanup only matched the old text, so on git 2.56 it
reported such a worktree as a failed cleanup instead of keeping it as "Repository or branch changed". Either way
nothing is deleted. Fork CI's GitHub runner has git 2.56, while upstream's runners are still on 2.55. Drop this
patch once upstream matches the new text.

- `apps/server/src/storageCleanup.ts`: `branchChanged` matches both messages.
- Test: upstream's `apps/server/src/storageCleanup.test.ts` ("compares the checked-out branch without a full
  status") fails on git 2.56 without it.

### Storage cleanup keeps a worktree whose file list runs past its limit (`fork:`)

Storage cleanup reads up to 64 KiB of a worktree's local changes, and under the strictest keep rule of its ignored
files, and keeps the worktree when the list runs longer ("Local changes exceed the inspection limit"). But
upstream's git calls failed past the limit instead of returning what fit, so the report showed such a worktree as a
failed cleanup. Nothing was deleted either way. The patch asks for truncated output in those two checks and in the
submodule checks, which handled it already.

- `apps/server/src/storageCleanup.ts`: `appendTruncationMarker` in `localChangesReason`'s two git calls and in
  `submoduleRemoval`'s `inspect`. Despite its name, the flag leaves `stdout` as is and sets `stdoutTruncated`.
- Test: `apps/server/src/storageCleanup.fork.test.ts`.

### Browser screenshots while Windows hides T3 (`fork:`)

While Windows counts T3's window hidden, such as minimized or behind a locked screen, it composites none of it, so
the preview's page paints no frames, even while the client paints it behind the app. An agent's screenshot then
waits on a frame that never comes, until the server gives up. A screenshot still unanswered 500 ms after it was
sent, while it's still the tab's screenshot, gets one `webContents.capturePage()`, which composites a frame, and the
waiting screenshot finishes with it. On the PC, a screenshot stuck this way finished about a second after the call.
One answered in time gets no call. The call is a second frame copy, and Chromium below 157 can crash when a guest's
renderer exits with copies in flight (why screenshots go one at a time), so the tab's next screenshot isn't sent
until the call settles, even when a navigation ends the first screenshot's turn early. It waits 5 s at most: Electron
can't cancel `capturePage()`, so a call still running then overlaps the next screenshot.

- `apps/desktop/src/preview/DesktopBrowserHost.ts`: `nudgeCapture` around each screenshot the relay sends to the
  guest.
- Test: `apps/desktop/src/preview/DesktopBrowserHost.fork.test.ts`.

### Links that open one thread (`fork:`)

Alice's vault and task board link to agents' threads as `t3-thread://v1/<threadId>`, sometimes with a `#fragment`,
which is ignored, or as `t3-thread://v2/<environmentId>/<threadId>`. The desktop app opens them like upstream's
`t3code://threads/<environmentId>/<threadId>`: from a launch, a second instance or macOS's open-url, focusing the
window and opening the thread once the renderer is ready. IDs are read raw, as the vault writes them, because some
thread IDs hold a literal `%3A`. A v1 link has no environment, so the renderer takes the one whose thread list has
the thread, preferring this machine's. A thread no list has yet (an archived one, say) waits up to 5 s for the lists
to load, then falls back to this machine's environment, or the only connected one; the thread page shows it there
or, like a deleted thread's page, goes to the new-thread screen. A v2 link opens only while its environment is
connected, and otherwise shows "Could not open the link". Installed Windows and macOS builds register the scheme:
Windows at startup with `setAsDefaultProtocolClient`, macOS through the app's `Info.plist` as well. Linux and
development builds don't, and the phone app doesn't read these links; it does read upstream's `t3code://` form.

- `packages/shared/src/promptLinks.ts`: `readThreadLink` and `THREAD_LINK_SCHEME`.
- `apps/desktop/src/app/DesktopClerk.ts`: hands thread links to the renderer and registers the scheme.
- `apps/web/src/components/desktop/DesktopWebLinkCoordinator.tsx` and `threadLinkTarget.ts`: pick the thread and
  open it.
- `scripts/build-desktop-artifact.ts`: the macOS `t3-thread` URL type.
- Tests: `packages/shared/src/promptLinks.fork.test.ts`, `apps/desktop/src/app/DesktopClerk.fork.test.ts` and
  `apps/web/src/components/desktop/threadLinkTarget.fork.test.ts`.

### Thread tags (`fork:`)

Threads carry free-form tags. Right-click a thread, open Tags, and tick a tag or add a new one; the row shows its
tags as small colored chips on the branch line of two-line rows, as colored dots after the title on one-line
rows, and in full in the hover card. Agents tag and untag with `t3_thread_organize` (`tag` and `untag`, with
`tags`), and `t3_thread_list` returns each thread's tags and filters by `tags`, matching any of them. Tags match
regardless of case, and a new tag takes the spelling already in use. A tag holds up to 40 characters, and a
thread up to 20 tags.

- Stock compatibility: tags live under the new `threadTags` settings key on the server that owns the thread,
  mapping thread id to tags. Stock T3 ignores the key, and drops it the next time it saves settings, so after a
  rollback the threads stay but their tags are gone.
- A patch adds or removes one tag at a time, removals first, and the server applies it to the tags it holds, so
  ticks from two windows both land. A list replaces a thread's tags. Writing tags from the app needs the
  settings-write scope, and the server reports the `threadTags` capability so older servers hide the menu. An agent
  tags with the thread permissions that pin and snooze use, not the environment-settings ones, because a tag only
  organizes one thread.
- Tags of a deleted thread stay in settings, so their names stay in the Tags menu.
- Fork files: `packages/contracts/src/threadTags.ts`, and in `apps/web/src/components/sidebar/`, `threadTags.ts`,
  `ThreadTagChips.tsx` and `NewThreadTagDialog.tsx`.
- Upstream files it changes: the settings schema, patch and capability in `packages/contracts`, the patch in
  `packages/shared/src/serverSettings.ts`, the capability in `ServerEnvironment.ts`, the two MCP tools, the thread
  menu in `threadActionMenu.logic.ts`, `Sidebar.tsx` and `useThreadActionMenu.ts`, the chips in
  `SidebarThreadRow.tsx`, the dialog host in `routes/__root.tsx`, and the menu's tag icon in
  `contextMenuFallback.ts`. `apps/server/src/mcp/toolkits/core.test.ts` provides settings to the thread tools,
  `useThreadActionMenu.test.ts` stubs the tag menu, and `agentContextBudget.json` records the larger MCP tool list.
- Tests: `packages/contracts/src/threadTags.fork.test.ts`, `packages/shared/src/serverSettings.fork.test.ts`,
  `apps/server/src/mcp/threadTags.fork.test.ts` and `apps/web/src/components/threadActionMenu.logic.fork.test.ts`.

### A delegated thread settles as soon as its task ends (`fork:`)

T3 runs every Codex thread in one shared `codex app-server`, and each loaded thread starts its own MCP helpers. On
Windows enough of them stall Codex (openai/codex#42740). A delegated child, such as a review or a collector, stays
loaded after its task ends until upstream unloads it after 30 idle minutes, so a burst of them still piles up; one
overloaded Codex on Oct 19. Until now a scheduled script on the PC settled finished children every two minutes.

The settlement worker now does it, whatever the sidebar's auto-settle settings are. Once every task that ran in a
child thread has ended, the child still holds a live provider session, and nothing in it is running, the worker
sends the child the same `thread.auto-settle` command. Settling detaches the child's sessions, which unloads a Codex
thread and ends a Claude child's process. Nothing running means:

- no run that hasn't finished, queued ones included, since settling cancels queued notifications and wakes;
- no pending runtime request or waiting link request;
- no open command, dynamic tool or subagent item outside a rolled-back run;
- no pending provider effect, a restart continuation included;
- none of its own tasks unfinished or still owing it a wake;
- no guest message, and the thread isn't snoozed, pinned or kept active.

A message Alice wrote after the task ended leaves the thread to ordinary auto-settle. The command carries the
thread's `updatedAt` from the worker's first read, so the orchestrator refuses it if anything happened on the
thread since, such as a wake being queued. The worker checks a child when its run or its task ends, and on every
sweep. It settles at most 40 a sweep, oldest first, counting only children that pass every check, so children held
by a snooze or by Alice can't crowd out the rest. A follow-up reopens a released child like any settled thread.

A child starts in its parent's checkout unless it was given its own worktree, and upstream runs the project's
settle script in a settled thread's worktree. A delegated child in its parent's checkout never runs that script,
even once the parent has settled; the parent's own settle does. Its terminals still close. Paths compare the way the
platform does, so on Windows case and slash style don't matter. That holds for every settle of a delegated child,
manual ones too. Other threads someone opens on the same checkout aren't checked.

There's no setting: switching to stock T3 is the rollback, and stock T3 reads the data unchanged. A task in a
linked environment runs as an ordinary thread there, so that machine doesn't release it early; upstream's idle
unload still does. A child with a long-lived dynamic tool open, such as a monitor, is held until it closes. Drop
this patch if upstream starts releasing finished delegated threads itself.

- `apps/server/src/orchestration-v2/DelegatedChildRelease.ts` (fork only): the guards, the release, and the
  parent-checkout check.
- `apps/server/src/orchestration-v2/ProjectionStore.ts`: `getReleasableDelegatedChildren`, on upstream's recovery
  and waiting-link indexes.
- `apps/server/src/orchestration-v2/ThreadSettlementService.ts`: the sweep releases children before it reads the
  settings, a finished task also enqueues its child, and `cleanUpSettledThread` skips the script in the
  parent's checkout.
- Tests: `apps/server/src/orchestration-v2/DelegatedChildRelease.fork.test.ts` pins the query against SQLite, the
  guards, a wake queued between the worker's two reads, held children ahead of a ready one, the parent-checkout
  rule, and the worker with auto-settle off. Upstream's `ThreadSettlementService.test.ts` and
  `ProviderTurnControlService.test.ts` gain a stub for the new read and otherwise pass unchanged. Upstream already
  covers the rest: settling detaches the session (`ProviderSessionManager.test.ts`), Codex unsubscribes on unload
  (`CodexAdapterV2.test.ts`), and a stale auto-settle is refused while a message reopens a settled thread
  (`runtimeLayer.test.ts`).

### macOS signing without upstream's App ID (`fork:`)

Upstream's passkey entitlements need a provisioning profile for upstream's App ID, which the fork can't get.

- `scripts/build-desktop-artifact.ts`: a signed build without `T3CODE_MACOS_PROVISIONING_PROFILE` skips the
  passkey entitlements, and an unsigned build is signed ad hoc.
- `apps/desktop/resources/entitlements.mac.plist`: upstream's entitlements minus the ones that need a profile.
  electron-builder signs with it when there are no passkey entitlements.
- `.github/workflows/release-desktop.yml`: `APPLE_TEAM_ID` and `MACOS_PROVISIONING_PROFILE` are optional.
- Tests: `scripts/fork/versionScheme.test.ts` holds the plist to upstream's rendered entitlements and checks the
  ad hoc identity.

### Ad hoc-signed Macs install their own updates (`fork:`)

electron-updater hands a Mac update to Squirrel.Mac, which only installs a build that meets the running app's
designated requirement. An ad hoc signature's requirement is that one build's code hash, so Squirrel.Mac refuses
every new build, and the sidebar's "restart and install" did nothing. On a bundle signed ad hoc, or not at all, the
app now installs the update itself:

1. It unpacks the zip electron-updater already downloaded and checked against `latest-mac.yml` into a hidden folder
   beside the installed app, so the swap stays on one volume. The folder must hold one app, with the installed
   app's bundle ID, the version being installed, a valid signature, and no quarantine flag.
2. It starts a detached script, waits until the script is running, and quits. The script waits for the app to
   exit, swaps the two bundles, removes the folder with the old one in it, and reopens the app. The swap is one
   step (`renamex_np` with `RENAME_SWAP`, which `osascript` reaches through JavaScript's ObjC bridge), so the
   installed path is never empty, even if the script is killed or the Mac loses power. If the swap fails, as on a
   volume that can't do it, nothing moves: the old app reopens, and the sidebar says the update didn't apply. If
   the app hasn't quit after two minutes, it leaves everything as it was. It logs to `mac-update-install.log` in
   the app's log folder.
3. If anything fails before the quit, such as unpacking, a check, or reading the installed app's signature,
   nothing quits, and upstream's recovery reports the failed install as before.

A build with a Developer ID signature still goes through Squirrel.Mac, as do Windows and Linux. The app downloads
the zip itself, so nothing quarantines the new build, and the `xattr` step is only for the first install from a
`.dmg`. A Mac on a release older than this patch updates by hand once. Drop this patch when the fork's Mac builds
are signed with a Developer ID.

- `apps/desktop/src/updates/MacAdHocUpdate.ts` (fork only): the signature check, the staging and its checks, and
  the install script.
- `apps/desktop/src/electron/ElectronUpdater.ts`: `quitAndInstall` tries it before Squirrel.Mac, and takes the app's
  log folder and the version being installed.
- `apps/desktop/src/updates/DesktopUpdates.ts`: keeps the downloaded zip once the update is offerable, and passes
  the log folder and the downloaded version.
- `.github/workflows/fork-mac-update-check.yml` and `scripts/fork/smoke-mac-update.ts`: on pull requests that touch
  the updater, a GitHub macOS runner packages one bundle as two versions, installs the older one in
  `/Applications`, and updates it to the newer one through the app's own update calls, from a local feed. The new
  build must be in place, signed, swapped in one step, and still running 15 seconds after it reopens, with no
  staging folder left. First the last release without this patch tries the same update and must stay as it was.
  Each launch first deletes the app's `t3code Safe Storage` keychain key, since a key another build made would hold
  the app on a keychain prompt nobody answers there.
- Tests: `apps/desktop/src/updates/MacAdHocUpdate.fork.test.ts` covers the signature check and the bundle path, and
  runs the install script against temporary folders, with a stand-in for macOS's swap: a normal swap, an app that
  doesn't quit, and a refused swap. Off macOS it also runs the script's own swap, which must move nothing.

### Update notes show the newest patches (`fork:`)

The update popover shows a release's last eight list items. Fork releases listed the install steps after the
patches with a blank line between them, which GitHub renders as one loose list. Each item then came wrapped in a
paragraph, which split it from its bullet and left a lone "-" between items, and the install steps took up the
popover.

- `.github/workflows/fork-release.yml`: the notes put the install steps first, under their own heading, then the
  patches.
- `apps/desktop/src/updates/releaseNotes.ts`: a list item's opening paragraph stays on its bullet.
- Tests: `apps/desktop/src/updates/releaseNotes.fork.test.ts`.

### Pinned threads drag in the boring sidebar (`fork:`)

Upstream turns off every drag in the boring sidebar (Settings > Labs), because project folders draw their rows in a
different order from the list that sorting reads. Pinned rows sit above the folders in list order, though, so they
can drag among themselves again. A pinned row drops only onto another pinned row, and the order saves through the
same write the flat sidebar uses, so it holds after a reload and on other machines. Folder rows still can't drag,
and a pinned row let go over a folder goes back to its place. The Pinned and Active labels that show during a drag
stay hidden here: they'd sit over folder rows, which don't move apart to make room.

- `apps/web/src/components/sidebar/boringPinDrag.ts`: `createBoringSidebarSortingStrategy` moves only pinned rows.
- `apps/web/src/components/Sidebar.tsx`: uses it in the boring sidebar, keeps drops to pinned rows, and keeps
  the drag labels hidden there.
- Tests: `apps/web/src/components/sidebar/boringPinDrag.fork.test.ts`.

### Fork CI, release and sync (`fork:`)

- Only the fork's own workflows run here: `fork-ci.yml`, `fork-release.yml`, `fork-windows-tests.yml`,
  `fork-mac-update-check.yml`, and upstream's `release-desktop.yml`, which `fork-release.yml` calls. Every other workflow is upstream's, with its
  `on:` triggers commented out and `workflow_call`, which nothing calls, in their place. This is deliberate:
  upstream's release, deploy and bot workflows would publish, deploy or label here, and GitHub can't disable a
  workflow before it first runs. The files stay, rather than being deleted, because upstream's tests and knip read
  them.
- `.github/workflows/fork-ci.yml` and `fork-windows-tests.yml` are generated from upstream's `ci.yml` and
  `windows-tests.yml`, with upstream's Blacksmith runners swapped for GitHub-hosted ones.
- GitHub's 4-vCPU runners are slower than upstream's 8-vCPU Blacksmith ones. Upstream's "keeps workspace PDF
  scroll and zoom after reloads" test (new in v0.1.6) takes about 7 s on Alice's PC but hits the 15 s per-test
  limit there, so `apps/web/src/components/files/AttachmentFilePreview.browser.test.tsx` gives that one test
  30 s, with a reasoned `t3code/no-test-timeout-or-unreasoned-skip` exception like upstream's in
  `reactCompilerCoverage.test.ts`. Remove it once upstream's own limit or the runner makes it unnecessary.
- `scripts/fork/ci-workflows.ts` does all of the above. Never edit its output by hand: run
  `node scripts/fork/ci-workflows.ts`. The sync runs it after every rebase, and `scripts/fork/ci-workflows.test.ts`
  fails CI if any upstream workflow could run.
- `.github/workflows/fork-release.yml`, `scripts/fork/versions.ts` and `scripts/fork/sync.ts`, described below.
  `fork-release.yml` runs `fork-ci.yml` as a called workflow, which gets no more permissions than its caller, so its
  `ci` job grants whatever `fork-ci.yml`'s jobs ask for (`id-token: write` since v0.1.3, for upstream's task cache).
  Otherwise GitHub won't start the release. `scripts/fork/ci-workflows.test.ts` checks this.
- Tests: `scripts/fork/*.test.ts` and `apps/desktop/src/updates/updateChannels.fork.test.ts`.

### Account pools (`pools:`)

Two or more accounts of one provider act as one pool, so a thread that reaches a usage limit continues on the
account with the most usage left instead of stopping. Ported from ScriptedAlchemy's fork. Users read about it in
the Account pools section of `docs/user/providers-claude.md`.

- Pool-only files: `packages/contracts/src/providerPool.ts`, `packages/client-runtime/src/providerPools.ts`,
  `packages/shared/src/providerInstanceDisplay.ts`, `apps/server/src/provider/providerPoolSnapshot.ts`, and
  `ProviderPoolCatalog.ts`, `ProviderPoolRouting.ts`, `ProviderPoolDispatch.ts` and `ProviderPoolFailover.ts` in
  `apps/server/src/orchestration-v2/`. On the web, `ProviderPoolsSettings.tsx` and its `.logic.ts`,
  `ProviderLimitedUntil.tsx`, and `routes/_chat.settings.account-pools.tsx`.
- Upstream files it changes most:
  - `apps/server/src/orchestration-v2/Orchestrator.ts`: every command that starts or moves a turn routes its
    model choice through `ProviderPoolDispatch.ts`, and failover is the internal `run.pool-failover` command.
    Failover reuses upstream's steering restart, which the patch moves into `replaceRunAttempt` with upstream's
    variable names kept, so most upstream edits to that code rebase without conflicts.
  - `apps/server/src/provider/ProviderRegistry.ts`: publishes each pool as a provider and remembers limited
    accounts.
  - `apps/server/src/serverSettings.ts`: the `providerPools` key, and the reserved `pool_` instance ids. Pool
    validation lives in `ProviderPoolRouting.ts`.
  - `packages/shared/src/serverSettings.ts` applies a pool patch with `applyProviderPoolsPatch`. A tick names one
    account and the server applies it to the pool it holds, so quick ticks from a page that hasn't caught up all
    land.
  - `runtimeLayer.ts` and the replay harness build run execution over the orchestrator, because the usage-limit
    hook dispatches into it. Both keep upstream's layer order and reach the orchestrator through `Layer.suspend`.
  - The web model picker, the Providers settings, and the project default model picker, which lists the pool in
    place of its accounts as the composer does. In a pooled thread the picker's label adds the account that ran
    it, and its tooltip names the pool and the account, except on the composer's own picker, which has had no
    tooltip since upstream's v0.1.6 picker put model and effort in one control.
- Stock compatibility:
  - Pools live under the new `providerPools` settings key.
  - Failover emits only `turn-item.updated` and `system_notice`.
  - Every saved model choice names an account, never the pool: scheduled tasks, the default model in settings and
    project overrides, the fallback model, the project's own default, and the commit message, title and review
    guide models. Each stores the pool's first enabled account, which stock T3 runs as is. On the fork, a thread
    started on a pooled account still uses the pool. Settings saves do this in `serverSettings.ts`, and project
    updates in `ProjectService.ts`.
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
  interrupted every 30 s, and its thread queues a resume note. A held thread the Task Priorities board ranks
  starts first, best rank first. A thread without a rank, such as a task's helper or a fork of its thread, takes
  the rank of the nearest ranked thread above it (`lineage.parentThreadId`, up to 10 levels; a deleted thread
  ends the walk). A thread another thread launched at the top level doesn't inherit, since the waiting list
  doesn't record who launched it. The rest start oldest first. Either way they start 90 s apart,
  or one every pass while the reading would stay at its release lines once each session released in the
  last two minutes, and the next one, grows by 2 GiB (`releaseDue`). Without a reading or a release line,
  the 90 s spacing holds. On Oct 29, 18 threads waited on the PC with 30 to 50 GB free, because new work
  joined the line faster than one every 90 s.
- `resourceLimits.usePercent` (50 to 90) sets every memory line from one number. The reserve is (100 - N)% of RAM,
  and each line is the reserve times one of the memory gate's ratios, so 80% of the PC's RAM gives its
  25 / 8 GiB pause, 35 / 12 GiB release and 10 GiB critical lines. A saved line wins over its derived one.
  Windows defaults to 80%. macOS has no percentage until one is saved, because memory pressure already decides
  there, and R7 hasn't yet checked on the Mini whether 80% would hold work while pressure is normal.
  `resolveResourceLimits` in contracts does the derivation for both the server and the dialog. CPU stays out of
  the percentage and is off by default.
- Limit-only files: `apps/server/src/resourceLimits/`, `packages/contracts/src/resourceLimits.ts`,
  `apps/web/src/components/settings/MachineLimits*`, and the `apps/web/src/components/ui/slider.tsx` primitive.
- Upstream files it changes:
  - `apps/server/src/orchestration-v2/Orchestrator.ts`: the three places a run can start call into
    `resourceLimits/OrchestratorAdmission.ts`: `dispatchMessage`, `startNextQueuedRun`, and
    `dispatchPreparedRunRelease`. Resume, Send now, and the governor's releases pass `admitted`. A run held with
    nothing to queue behind takes upstream's queue branch, which the patch lets run without an active run.
  - `ProviderSessionManager.ts`: `releaseIdleSessions`, which picks sessions with `idleSessionsToClose` and closes
    them through upstream's `releaseEntry`. Upstream dropped `lastActivityAtMs` in v0.1.4, since nothing of its
    own read it, so the patch keeps it: set when a session opens and each time its idle timer restarts, which
    every path that leaves a session idle goes through. `idleSessionsToClose` closes the oldest first by it.
  - `runtimeLayer.ts` wires the governor. `ws.ts` adds the limits to `serverGetHostResources`.
  - Contracts and `serverSettings.ts`: the `resourceLimits` settings key, the `resourceLimits` capability, and
    `HostResourcesSnapshot.limits`.
  - `LoadBalancingSettings.tsx` shows each machine's limits under its row, and hands a lone machine to
    `MachineLimitsSection`. `settingsSearch.ts` adds search terms.
  - `packages/client-runtime/src/load-balancing.ts`: Auto balance skips a machine over its limits.
  - `ProviderAdapter.ts` and `ClaudeAdapterV2.ts`: the optional `stopBackgroundTasks`, for Stop now.
  - `subagentProjection.ts`: `delegatedTaskProgress` counts a child held with a resume note as still working.
- **Pause all** is a manual hold on top of the same path, for when Alice wants every agent on a machine quiet, with
  memory to spare or not. It holds until she resumes, and has no expiry.
  - Two modes: `finish` lets running turns end, then everything waits. `stop` also interrupts every running turn at
    once, each with a resume note like the critical line's, ends the background work of threads whose turn is over,
    with a note of their own, and closes idle sessions, so the machine is quiet and safe to shut down. Turns waiting
    on Alice's answer keep their turn and question, and only their background work ends.
  - On Windows a Claude background command outlives both an interrupt and closing its session, so Stop now ends
    background commands first, through the adapter's `stopBackgroundTasks` (Claude's `query.stopTask`, for the IDs in
    its roster). Codex has no such method, because interrupting its turn already ends its terminals that have a
    console. A pull request watch keeps running, and a delegated child's task is held through its own thread.
  - On Windows, interrupting a Codex turn ends a foreground command's shell and leaves what the shell started running,
    with no parent left to find it by. T3's own Stop button does the same, and this fork leaves that alone. Stop now
    reads the process table once before it acts on what's new (`ProcessTree.ts`, about half a second), then every 2
    seconds for 14 seconds ends anything under a `codex.exe` under this server whose parent has died since
    (`orphanedProcesses`, in its own loop so it can't hold up the switch). Who started what is judged inside one reading,
    because a dead process's ID can be reused between two, and a process older than the parent it names isn't that
    parent's child (`withDescendants`). It ends each process on its own: it holds a handle, checks the start time and
    kills through that handle, so a reused ID can't be hit. `taskkill /T` isn't safe here, because it follows parent IDs
    with no check of start times, so it can reach a long-running process whose parent died and whose ID an orphan now
    holds. A shell that hasn't died isn't touched, so the servers a provider keeps stay up, and while Alice has a turn of
    her own running, whatever is newer than the pause is left alone, because the table can't say whose a new process is.
    Other providers and T3's terminals aren't looked at. Other platforms don't read.
  - Claude reports an interrupted tool call as the user rejecting it, and agents read that as a no. So the notes say
    nobody refused anything, and that whatever was running has to be started again.
  - A child T3 interrupted to hold is still working: `delegatedTaskProgress` counts a held queued run as active when
    its message ID is one of the governor's resume notes (`limits:stopped:`, `limits:stopped-work:`,
    `limits:interrupted:`). Its parent gets no false "interrupted" result, and hears the real one when the resumed
    run ends. Cancelling the note reports the interrupted turn. This covers the critical line's interrupts too.
  - A restart cancels a queued wake from a provider session, since that session is gone. The governor's first pass
    after a restart turns one that was being held into a note, so the thread still comes back, in its place in the
    line.
  - While paused, every run start waits in its thread's queue: agents, delegated children, schedules, queued
    messages, usage-limit resumes and restart continuations. The off switch and "launch anyway" don't pass it. A
    message Alice types after the pause began still starts: at once in an idle thread, with its older queue waiting
    again afterwards, or, when a turn is still running, behind what's already queued there, which then goes first. A
    thread she hasn't typed in keeps waiting. Resume and Send now still start a thread by hand, and agents have no tool
    for those.
  - Resuming goes through the normal line: one thread at a time, board rank first, under the memory limits.
  - Set it from any thread by typing `pause all`, `stop all` or `resume all` as the whole message. Only a message
    Alice types herself counts. The model never sees it, and it asks for no thread title: `pauseOrderMessage` sets the switch, and `dispatchMessage`
    queues the run with its notice, then cancels it at once, so the notice stays in the transcript and the message
    leaves it, as a cancelled queued message does. The words stop, on their own, would be too easy to mean for one
    thread, so the kill switch is `stop all`.
  - Other processes set it by writing `pause.json`, so a change is read every second (`followPause`). Stop now keeps
    interrupting for its first 30 seconds, to catch any turn that was just starting; a turn running after that got
    there through Alice. Asking for Stop now again renews its time, so it sweeps again and also stops what she started
    since. Asking to pause again keeps its time. `ResourceLimits` reads the file when it's built, before anything can dispatch, so a restart
    while paused starts nothing.
  - `followPause` also saves the waiting list to `state.json` when it changes, because a pass saves only every 15
    seconds and "Stop now, then shut down" would otherwise lose the threads it just held.
  - A subagent launch the hook refused can reach the inbox after its turn ended, so the inbox is matched against
    idle sessions as well as running ones.
- teenylilconfig's memory gate and task wake share the governor's files under `<stateDir>/resource-limits/`:
  - `state.json`: state, readings, waiting threads, recent release times, and each running session's thread and
    "launch anyway". It's rewritten every pass, so a stale file means T3 isn't guarding.
  - `off.json`: `memgate off` writes `{ at, until }` in epoch ms. It switches the limits off for at most a day.
  - `pause.json`: `{ version: 1, mode, at }`, where `mode` is `finish` or `stop`. T3, `memgate pause|stop|resume` and
    task wake's board switch all write it, and removing it resumes. A malformed file counts as no pause. While it's
    set, `state.json` reads `state: "paused"` (or `critical`), with `pause` set, `off` null and no session marked "launch
    anyway", so the hook refuses native subagents.
  - `inbox/`: one record per subagent launch the hook refused. Its thread resumes with a note listing them.
  - `priority.json`: teenylilconfig's task wake writes `{ version: 1, at, ranks }` from the board every 10 minutes,
    each ranked task's thread ID with its rank (1 is the top). One more than a day old, more than a minute
    ahead, over 1 MiB, or malformed counts as no ranks (`priorityRanks`).
- Stock compatibility: holds, notices and resume notes reuse `run.updated`, `turn-item.updated` and system
  notifications. Pause all adds no event type, and stock T3 ignores `pause.json`, treating a typed order as an
  ordinary message. Stock T3 drops `resourceLimits` the next time it saves settings.
- Known gaps:
  - Forks and merge-backs aren't held, during a pause either.
  - Each machine has its own switch. An order typed in a thread pauses the machine that thread runs on, and Linux,
    which has no fork limits, treats the words as an ordinary message, though one gets no generated title.
  - Pause all holds what T3 runs. A steer into a turn that's still finishing joins that turn, and an agent CLI started
    outside T3 is only held at the hook, for its subagents.
  - An agent restarts its interrupted work by choice, from the note. T3 doesn't replay a tool call.
  - Ending what an interrupted Codex command left running took up to about 6 seconds in replay, which nothing enforces,
    so quitting T3 sooner than that can leave it behind. Whether a Codex command outlives an interrupt on macOS hasn't
    been checked.
  - A command that starts in the half second between Stop now's reading and its interrupt isn't in the reading, so it
    survives. So does what an orphan starts in the moment before it's ended, and a command newer than the pause while
    Alice has a turn running, even if it isn't hers. A Codex shell that ends by itself in those 14 seconds, in a thread
    Stop now isn't stopping (one waiting on her, or one she steered during the pause), loses what it left running.
  - The interrupt and the note are separate dispatches, so a child that finalizes between them could give its parent
    a false "[interrupted]". A Codex turn waiting on Alice keeps its question and may keep a background command, since
    only an interrupt ends those.
  - A crash less than a second after a run is held can lose its place in the line. **Resume** still starts it. A
    refused launch whose session has already closed stays unmatched (`resource-limits.inbox-unmatched`), with no note.
  - Mobile has no Load balancing settings, so limits are edited from web or desktop. Mobile's Resume starts held
    work like web's.
  - Upstream refuses to snooze a thread with a queued message of its own. So held agent messages stay in the
    inbox, and only threads holding notifications alone (interrupted turns, refused launches) get snoozed.
- Tests: `apps/server/src/resourceLimits/*.fork.test.ts`, `packages/shared/src/serverSettings.fork.test.ts`,
  `packages/client-runtime/src/load-balancing.fork.test.ts`,
  `packages/provider-core/src/server/subagentProjection.fork.test.ts`, and `MachineLimits.logic.fork.test.ts`.
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

Nothing is published unless CI and the Linux and Windows builds pass. macOS can be missing: GitHub sometimes has no
macOS arm64 runner free, and cancels a job that waits about 15 minutes for one. On Nov 2 that happened to four
releases in a row in the afternoon. The release then publishes without macOS, says so in its notes and as a warning
on the run, and a Mac's update check finds no `latest-mac.yml`. Re-running the macOS job doesn't add it to a
published release, but the workflow catches up on its own:

- Every two hours (at :40) a scheduled run looks at `fork/main`'s newest commit. If that commit's release has no
  `latest-mac.yml`, it builds the JS bundle and macOS only, then `add-mac` uploads the installers, the CLI archive,
  the macOS line of `SHA256SUMS` and, last, `latest-mac.yml`, and swaps the release note's macOS line for the
  install steps. Otherwise it stops after picking the version. A scheduled run never publishes a new release, so a
  commit whose release failed isn't retried every two hours.
- Scheduled runs queue in their own concurrency group, `fork-release-mac`. GitHub keeps one pending run per group
  and cancels the older one, so a scheduled run can't drop a push's pending release.
- To try sooner, run the workflow by hand (`gh workflow run fork-release.yml --ref fork/main`). On an already
  released commit it does the same macOS catch-up, and on an unreleased one it publishes as a push would.
- Only the newest commit's release is caught up. Once a newer release publishes, an older one without macOS stays
  that way.

If publishing fails partway, delete the half-made release with `gh release delete vX.Y.Z-alice.N --cleanup-tag --yes`
and re-run the workflow.

Installed apps check the fork's latest release 15 seconds after launch and then every 4 minutes. A new release
shows in the sidebar's update pill, which downloads it and then restarts into it. This is upstream's flow: the app
never downloads or installs an update on its own. Headless servers update with `t3 update`.

### Signing

- **Windows** builds are unsigned. SmartScreen warns once on a fresh install (More info, then Run anyway).
  Updates aren't signature-checked, since an unsigned build carries no publisher name.
- **macOS** builds are signed and notarized when the repository has the secrets `CSC_LINK`, `CSC_KEY_PASSWORD`,
  `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. Without them, they're signed ad hoc: after the first
  install from a `.dmg`, clear the quarantine flag once with
  `xattr -dr com.apple.quarantine "/Applications/T3 Code (Beta).app"`. Squirrel.Mac refuses ad hoc-signed updates,
  so those builds install their own (see "Ad hoc-signed Macs install their own updates"). The keychain also trusts
  only the build that made the app's `t3code Safe Storage` key, so each new ad hoc build asks once for keychain
  access when it first opens, whether it was installed by hand or updated itself.

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
- Upstream's fallback model checks the usage of the account a saved default names, not its pool. With a
  fallback model set, a new thread whose default is a pooled account goes to the fallback once that one
  account is out of usage, even while the pool's other accounts have room.
