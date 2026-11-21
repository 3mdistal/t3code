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
- Wrap fork copy for translation the way upstream does (`docs/internals/i18n.md`): `<T>` or `gt()` in
  components, `msg()` in tables and helpers. The fork's keys live in one commit at the top of the stack, `fork: add
  the fork's copy to the translation catalogs`, in English in every locale until someone translates them. A sync
  rebuilds that commit: take upstream's catalogs, run `vp run i18n:generate` in `apps/web`, `apps/mobile` and
  `apps/desktop`, and fill each new key in every locale with its English. `vp run i18n:check` fails until then.
- Never publish a release whose checks failed.

## Patches

Each entry says what the patch is for, the files it touches, and the tests that prove it.

### Claude prompts end when their callback is superseded (`fork:`)

An accepted steer retires the root permission or question callbacks that preceded it. The old tool is denied
without interrupting the run, its waiting card is cancelled, and its request becomes resolved and non-resumable.
Late answers cannot reach the provider. Parallel subagent permissions remain pending. Clearing a superseded
prompt also prevents it from incorrectly blocking the existing restart continuation. The fork used to retire a
callback on an SDK abort too; upstream v0.1.7 (#27320) now cancels a request Claude withdraws, and its card,
which does the same job, so the fork leaves that case to upstream. Upstream's cancel skips a request a steer
already retired.

- `apps/server/src/orchestration-v2/Adapters/ClaudeRuntimeRequests.ts` owns callback claims and retirement;
  `ClaudeAdapterV2.ts` connects SDK callbacks and accepted steers to it.
- `ClaudeAdapterV2.testkit.ts` exposes SDK callbacks to deterministic replays.
- `apps/server/src/orchestration-v2/ClaudeApprovalLifecycle.fork.test.ts` covers steer, SDK abort (upstream's
  cancel), questions, a parallel subagent permission, late Cancel, and shutdown/startup against a temporary
  SQLite database.
- `Adapters/ClaudeRuntimeRequests.fork.test.ts` covers interrupted or failed offers after enqueue acceptance,
  rejection before acceptance, and offers that return without an acceptance callback.

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
  only the request handler refuses. Upstream's `cli/triage.test.ts` launches agents through `t3 triage`, so it
  skips them while triage is off.

### `t3 thread send --environment` (`fork:`)

`--environment <id>` sends to a thread on a linked machine, so task wake can pass Alice's own board answers to a
thread on her Mac. `t3_thread_send` already routes on `environmentId`, and the CLI signs in as an MCP client session,
which may forward; the flag only names the target. `--wait` is refused with it, since the CLI follows runs here. Each
call signs in afresh and a request key is scoped to its session, so a retry can't be deduplicated: a caller that must
send once records its attempt first. File: `apps/server/src/cli/thread.ts`. Test:
`apps/server/src/cli/thread.fork.test.ts`.

### `t3 thread list --environment` (`fork:`)

`--environment <id>` lists threads on a linked machine, so the PR poller on the PC can find the Mac thread that owns
an approved PR and wake it with `t3 thread send --environment`. `t3_thread_list` already routes on `environmentId`.
A path names a project on this machine only, so with the flag `--project` takes that machine's project id, and
without one the list covers all of its projects (`allProjects`). File: `apps/server/src/cli/thread.ts`. Test:
`apps/server/src/cli/thread.fork.test.ts`.

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
- `apps/server/src/provider/Drivers/CodexDriver.ts`: passes what upstream's `makeCodexSkillsProbe` returns through
  it, so the probe itself stays upstream's. `CodexManagedProvider.ts`: provides the file system to its
  `probeCodexSkillsForCwd` call.
- `apps/server/src/provider/Drivers/ClaudeSkills.ts`: exports `parseSkillFrontmatter`.
- Test: `apps/server/src/provider/codexSkillInvocability.fork.test.ts`, with the slow-disk cases on the test
  clock.

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

### A Claude session that was never saved recovers (`fork:`)

Claude only writes a session's transcript once a prompt reaches it, but T3 records a provider turn either way. When
a pool moved a thread to another account on a provider notification, which sends no prompt, the new session had an
accepted turn and no transcript. Every later run asked `claude --resume` for it and failed with "No conversation
found with session ID", so the thread stayed broken and a retry couldn't help. Upstream v0.1.11 (#37610) now marks
the session gone after that failure, so the next send starts fresh, but the failed run's prompt still has to be sent
again, and an agent left waiting on it stalls. A transcript deleted some other way would end the same way.

Before each resume T3 now asks the adapter whether the session can be resumed. It can't when the next query would pass
`--resume` and no project folder in the account's Claude home holds the transcript. That failure takes upstream's
existing fallback: a fresh native session with the whole thread as a context handoff. The run succeeds, and threads
already broken this way recover on their next run. A live process, a session with no turns that the next query will
create, and a home T3 can't read are all left as they were, as is a replayed session, which has no files to look for
(`keepsTranscriptsOnDisk` is set only on the real query runner). The check runs apart from `resumeThread` because the
session manager skips `resumeThread` for a thread it has loaded. The notification itself isn't delivered: the
process it belonged to is gone, and the handoff carries the history.

- `packages/provider-core/src/server/ProviderAdapter.ts`: the optional `assertNativeThreadResumable`.
- `apps/server/src/orchestration-v2/Adapters/ClaudeLostSession.ts`: the transcript scan, used by
  `Adapters/ClaudeAdapterV2.ts`.
- `apps/server/src/orchestration-v2/ProviderTurnStartService.ts`: calls it before `resumeThread`, and shares the
  "has turns" rule with the turn input through `nativeThreadHasTurnsIn`.
- Tests: `apps/server/src/orchestration-v2/Adapters/ClaudeLostSession.fork.test.ts` and
  `apps/server/src/orchestration-v2/testkit/LostClaudeSession.integration.fork.test.ts`. Upstream's resume tests pass
  unchanged.

### Session checks get their own database reader (`fork:`)

Session and WebSocket-ticket verification reserve a separate, lazy read-only worker for their indexed session
lookup. They retain the writer inside an existing write transaction. Upstream added a pool of four reader
workers in v0.1.6 (#27097), and since v0.1.11 a read waits for whichever pool reader frees first (#27979); the lane is one
more worker beside the pool, which the pool never routes to, so session checks still don't wait behind four long
reads. If the lane's worker can't start, those lookups use
the pool and the pool stays on. Without the lane, session checks would wait only while all four pool readers
are held by long reads, so it may be droppable later. Since v0.1.6 upstream itself retries a failed
permission load with backoff while the connection stays up (#27008), so the fork no longer patches the
client; its test checks that sending recovers without a reload after a failed or timed-out load.

Until v0.1.11 this patch also changed when the checkpoint worker held writers back. v0.1.11 no longer holds writers
for checkpoints at all (#23496, #31804): the writer checkpoints its own log past 10,000 frames instead. That part is
gone.

- `packages/shared/src/nodeSqliteClient.ts`: the interactive read lane. It also
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
- The refresh of the Changes panel and PR status after a capture runs at most two at a time, and is dropped after
  five minutes. Since v0.1.11 upstream detaches that refresh, so the capture effect settles once its checkpoint
  is committed; the fork adds only the cap and the deadline.

Upstream hasn't been asked yet.

- `apps/server/src/orchestration-v2/EffectOutbox.ts`: `CONTROL_EFFECT_TYPES`, the `effectTypes` filter on
  `claimNext`, and `nextClaimableAtFor`.
- `apps/server/src/orchestration-v2/EffectWorker.ts`: the background slots, and six workers by default.
- `apps/server/src/orchestration-v2/RunFinalizationService.ts`: the cap and deadline on the refresh.
- Tests: `apps/server/src/orchestration-v2/EffectWorker.fork.test.ts` and
  `apps/server/src/orchestration-v2/RunFinalizationService.fork.test.ts`.

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

### Watch the settings files, not the state directory, on Windows (`fork:`)

The settings and keybindings watchers each watched the state directory, three watches in all, and that directory holds
the database. With a directory watch, libuv on Windows calls `GetLongPathNameW` on every entry that changes, from the
main thread, inside its poll phase, where a CPU profile shows it as `(idle)`. A native stack of a 6.8-second freeze
on the PC showed the main thread in `ZwQueryAttributesFile`, under `GetLongPathNameW`, under `uv_run`. The database
file changes all the time, and a lookup of a file can wait while another handle flushes it: during a 3 GB flush one
lookup took 1.9 seconds, while a lookup of the file next to it took 1 ms.

A watch on a file is the same directory watch underneath, matched by name in libuv, with no lookup, and it still sees
an atomic save. Elsewhere a watch on a file loses it on an atomic save, so other platforms keep the directory. So does
a file that doesn't exist when the watch starts, a path that is a directory, and a file's watch that fails, which can
happen if the file is replaced just as the watch attaches. Upstream v0.1.11's settings watcher also watches a symlink
target's directory for a rename through the same function.

- `apps/server/src/watchOneFile.ts`: picks the file or the directory.
- `apps/server/src/keybindings.ts`, `apps/server/src/serverSettings.ts`: watch through it.
- Test: `apps/server/src/watchOneFile.fork.test.ts`, which runs live watches.

### Don't check Git for Windows or read npm shims on the event loop (`fork:`)

On the PC any stat on the event loop can take seconds while Windows is slow. Upstream v0.1.12 searches PATH before
each start on the file pool and reuses PATH listings (#27391, #40634), which covers what this patch first did with
a five-minute cache and then an off-thread search, so the fork cut those. Two checks in `resolveSpawnCommand` still
block there: the stats for Git for Windows' own `git.exe` behind its `cmd` launcher, and the read of an npm shim to
run its program directly. They now run on the file pool too; the synchronous `preferGitForWindowsBinary` and
`npmShimExecutable` stay for upstream's other callers.

- `packages/shared/src/shell.ts`: `preferGitForWindowsBinaryOffThread` and `npmShimExecutableOffThread`, which share
  `gitForWindowsBinaryCandidates` and `npmShimTarget` with the synchronous checks.
- Test: `packages/shared/src/shell.fork.test.ts`.

### A CPU profile of each freeze on Windows (`fork:`)

On the PC the server's event loop freezes for 4 to 13 seconds within a minute after every noon and midnight, and
for up to 24 seconds at other times. The trace and the stall log show only what was waiting when it stopped, never
the call that held it. On Windows a worker thread now keeps a rolling CPU profile of the main thread, sampled every
10 ms, while the main thread bumps a shared counter four times a second. When the counter stops for 3 seconds or
more, the worker reads the profile back once the main thread is free and saves it as
`logs/freeze-profiles/freeze-<start>-<length>ms.cpuprofile`, which Chrome's DevTools and VS Code open. The profile
covers the freeze and up to two minutes before it; without a freeze it is dropped and restarted every two minutes.
The newest 20 are kept. A pause long enough to stop the worker too, such as a sleeping PC, isn't saved. Each save
logs "freeze profile saved".

It's off unless `T3CODE_FREEZE_PROFILES=1`, because it caused freezes of its own. Each profile start walks the heap
on the main thread, which on the PC held it for 0.4 to 3.8 seconds every two minutes and after every save, so one
freeze could set off the next. The profile also can't see into libuv's poll phase, where it shows a blocked call as
`(idle)`. Native stacks taken from outside the process found what those were. Drop this patch once the freezes are
fixed.

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

### Storage cleanup keeps a worktree whose submodule listing runs past its limit (`fork:`)

Storage cleanup keeps a worktree when a check's git output runs past its limit. Upstream's #26593 asks for
truncated output in the local-changes and ignored-files checks, but not in the submodule checks, which test
`stdoutTruncated` too and still fail past the limit, so the report shows such a worktree as a failed cleanup
instead of "submodule inspection exceeded the limit". Nothing is deleted either way. Drop this patch once upstream
passes the flag there too.

- `apps/server/src/storageCleanup.ts`: `appendTruncationMarker` in `submoduleRemoval`'s `inspect`. Despite its
  name, the flag leaves `stdout` as is and sets `stdoutTruncated`.
- No test: the limit needs about a thousand submodules. The fork's tests for the other two checks went with
  upstream's in `apps/server/src/storageCleanup.test.ts`.

### Browser screenshots while Windows hides T3 (`fork:`)

While Windows counts T3's window hidden, such as minimized or behind a locked screen, it composites none of it, so
the preview's page paints no frames, even while the client paints it behind the app. An agent's screenshot then
waits on a frame that never comes, until the server gives up. A screenshot still unanswered 500 ms after it was
sent, while it's still the tab's screenshot, gets one `webContents.capturePage()`, which composites a frame, and the
waiting screenshot finishes with it. On the PC, a screenshot stuck this way finished about a second after the call.
One answered in time gets no call. The call is a second frame copy, and Chromium below 157 can crash when a guest's
renderer exits with copies in flight (why screenshots go one at a time), so the tab's next screenshot isn't sent
until the call settles, even when a navigation ends the first screenshot's turn early. It waits 5 s at most: Electron
can't cancel `capturePage()`, so a call still running then overlaps the next screenshot, though no other call starts
until it settles. The wait goes by guest, so a guest attached again after a debugger reattach still waits on the call.

- `apps/desktop/src/preview/DesktopBrowserHost.ts`: `nudgeCapture` around each screenshot the relay sends to the
  guest.
- Test: `apps/desktop/src/preview/DesktopBrowserHost.fork.test.ts`.

The same goes for a stream. Someone viewing a desktop tab from another device saw it freeze, or never draw, while
T3's window on the PC was minimized, hidden or covered by other windows. In Electron 44.10.0 (Chromium 152) on the
PC, a webview's screencast sent no frames in any of those states, and its `requestAnimationFrame` stopped, though
direct screenshots and mouse input still worked. Each `capturePage()` on the guest drew one frame, which reached the
screencast too, so a capture every 250 ms gave about 4 frames a second. A capture on the window's own page drew
nothing. Electron 44 has no lasting way to keep a hidden page drawing: `incrementCapturerCount()` is gone, and
`capturePage()` holds the page visible only while it runs.

So while a tab streams, the host checks it every 250 ms. A frame no capture brought (any frame after a tick without
a capture, the stream's or a nudge's, or a second frame after a tick with one) means the window draws, so the tab
gets no capture for the next 1.5 s, and a page that changes once a second, like a clock, gets none once one of its
frames lands that way. Otherwise the tab gets a `capturePage()` each tick for 3 s after an input, a stream's start
included, and after that each tick only while each capture brings a frame, else every 2 s. So a page that changes
keeps drawing at about 4 frames a second while someone uses it or while it changes. A single frame after a capture
can't hold that rate, since it may be the page's own: a clock in a window that shows, whose ticks keep landing just
after captures, gets captures for the first 3 s and stops at the first capture that brings none. A still page gets
no screencast frame from a capture, so it costs a copy every 2 s and no bandwidth. When a page that drew on its own
stops, as when the window hides, the 3 s start over. A tick is skipped while a screenshot or another capture runs,
and a screenshot waits for the stream's capture as it does for a nudge. A capture took 10 to 25 ms on the PC, so one
is in flight about 4% of the time at the fastest rate.

- `apps/desktop/src/preview/DesktopBrowserHost.ts`: `pumpFrames`, started by each screencast the relay starts;
  `captureFrame`, shared with `nudgeCapture`, and its `nudgeCaptures` and `capturesRunning` by guest; the `frames`,
  `inputs` and `captures` counts.
- Test: `apps/desktop/src/preview/DesktopBrowserHost.fork.test.ts`, "a streamed tab in a hidden window".

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
regardless of case, and a new tag takes the spelling already in use. A tag holds up to 40 characters (an agent's
longer tag, up to upstream's 64, is cut to 40), and a thread up to 20 tags.

- Upstream v0.1.11 added its own tags (#29053): stored on the thread, set by the `thread.tag.set` command, and
  used only to hide tagged threads while recording (`hideTaggedThreads`). It has no menu, agent tool or filter
  that sets or reads them. The fork's tags stay a separate store for now, so upstream's hiding doesn't see them.
  `packages/contracts/src/threadTags.ts` holds both; the fork's agent tools check each tag with upstream's
  `ThreadTag`.

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

### Sidebar filter and sort (`fork:`)

With the boring sidebar on (Labs, "Boring sidebar (group by project)"), the header's project picker becomes two
buttons. Filter picks projects, tags, statuses, pull requests (open, merged, closed, no PR), pinned or not, and the
machine, shown when there is more than one. A thread matches any pick within a kind, and each kind of filter applies
on top of the others; a thread with several pull requests matches if any of them does. A badge on the button counts
what is on, the menu's search finds any option, and Clear filters turns them all off. A picked tag no thread has now, or a picked machine since removed, stays in the menu so it can be unticked. Sort picks the
thread order (my latest message, needs me first, last activity, newest first) and the grouping (project, tag,
status or none). Project folders follow the sort by their top thread, pinned folders first and archived ones last,
unless the user has set a manual project order. Filters never change the sort or the grouping.

- Stock compatibility: the view lives in browser storage under `t3code:sidebar-view:v2`, and picked projects stay
  in the existing project filter. A saved `v1` view is the starting point until the view first changes (Pinned only becomes Pinned, Has an open PR
  becomes Open), and stays in place for older builds. Nothing changes on the server. With the Labs switch off the list and its header
  are stock, project picker included; only the row icon slots below change.
- Rows keep their icons in fixed slots, in both sidebars: the agent icons sit on the title line whether or not the row
  has a meta line (a two-line folder row keeps them on line two), and a pinned card row shows its pin on the title
  line instead of in the project label. Upstream v0.1.12 shows the machine as the meta line's label (#40736), so the
  machine icon no longer needs a slot.
- The thread on screen stays listed when it doesn't match a tag, status, pull request, pinned or machine filter. Picking projects hides
  other projects' threads, as the stock picker does. A tagged thread sits in one tag folder, a picked tag first,
  then the first by name. A thread with no run counts as Done. The Settled count adds older settled threads that
  haven't loaded yet, which the filters can't see. Right-click a project in the menu to open its settings; pinning
  a project stays on the folder's own menu.
- Fork files: in `apps/web/src/components/sidebar/`, `sidebarView.ts`, `SidebarFilterMenu.tsx`,
  `SidebarSortMenu.tsx` and `SidebarViewFolderHeader.tsx`.
- Upstream files it changes: `Sidebar.tsx` (the header buttons, and filtering, sorting and folders in the boring
  sidebar) and `SidebarThreadRow.tsx` (the icon slots, and the project icon on tag and status folder rows). It also
  extends the fork's `threadTags.ts` and `ThreadTagChips.tsx`.
- Tests: `apps/web/src/components/sidebar/sidebarView.fork.test.ts`.

### Working section and grouped rows in the boring sidebar (`fork:`)

The Working section setting (General) now applies to the boring sidebar too. Working and monitoring threads sit in
a Working section docked above Snoozed and Settled, as in the classic sidebar, and go back to their folder when they
stop. The section steps aside when threads are grouped or filtered by status, so those threads show under their own
status instead of in a closed section. Pinned threads stay pinned.

Group by none is the classic list. A grouped list (project, tag or status) has one row type, including pinned and
working rows, so cards and one-liners never mix:

- One-line rows show the status as its icon only, so the title keeps the room, and the hover card names it. Under a
  heading that already says the status the row shows its age instead; Needs you rows keep the icon, since that
  heading covers several kinds of wait.
- A row outside a project folder has its favicon in the left slot, in color, so its title starts where Snoozed and
  Settled titles do. Rows in a project folder leave that slot empty, lining up with the folder name.
- "Two-line folder rows" now means two lines on every row: the title alone on line one, then the branch, tag marks,
  pull request, agent, status and age on line two.
- Folder headings always show their thread count, like the section headings. They sit quieter than the titles under
  them, with more space above each one and above the first section, so they don't read as rows.
- A tag's color mark is a short upright bar, because a round dot in the sidebar means a status needs attention.
- Snoozed and Settled rows give the title the room they held for the hover action, as folder rows do.

- Stock compatibility: no new settings, storage or server changes. With the Labs switch off the list is stock, apart
  from the wider titles in Snoozed and Settled.
- Fork files: `sidebarView.ts` (`sidebarViewAllowsWorkingShelf`, `sidebarGroupNamesRowStatus`) and
  `ThreadTagChips.tsx` in `apps/web/src/components/sidebar/`.
- Upstream files it changes: `Sidebar.tsx` (the Working section's gate, row types, shelf spacing),
  `SidebarThreadRow.tsx` (the folder and two-line layouts, the hover card's status),
  `SidebarProjectFolderHeader.tsx` (the count), and the setting descriptions in `SettingsPanels.tsx` and
  `LabsSettingsPanel.tsx`.

### Bulk thread actions (`fork:`)

Right-clicking several selected threads offers what a single thread's menu does, so a batch doesn't take one click
per thread: Pin, Un-settle, Wake, Tags and Archive join upstream's Unpin, Settle, Snooze, Regenerate titles, Mark
unread and Delete. Each new entry and Settle count only the threads they apply to, and are left out when that's
none.

- Tags ticks a tag every selected thread has. Native menus have no mixed state, so a tag only some have reads
  `bugs (2 of 3)`. Picking a tag adds it to all of them, or removes it from all when every one has it. New tag…
  adds to all. Tagging keeps the selection, so a second tag doesn't need the threads picked again.
- Pin keeps the listed order and puts the batch above the current pins, including any a filter hides, by giving
  each thread its order key up front. One at a time they would each land on top and reverse.
- Archive leaves out running threads, which the server refuses, and asks first only when the single-thread setting
  does.
- Stock compatibility: nothing new is stored. These are the thread commands and the `threadTags` settings patch
  the single-thread menu already uses.
- Fork file: `apps/web/src/components/sidebar/bulkThreadActions.ts`. `threadTags.ts` gains the bulk tag handler.
- Upstream files it changes: `Sidebar.tsx` (the multi-select menu, and `attemptPin` taking an order key).
- Tests: `apps/web/src/components/sidebar/bulkThreadActions.fork.test.ts`.

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

A child starts in its parent's checkout unless it was given its own worktree. The fork used to keep such a child
from running the project's settle script there; upstream v0.1.11 does the same for every subagent in its parent's
worktree (#19665), so the fork dropped its own check. A delegated child's path is its parent's, copied as is.
The same upstream change settles a subagent only with its parent, so its settlement read skips a child whose
parent is live; the release reads its child with an option that lifts that one filter.

There's no setting: switching to stock T3 is the rollback, and stock T3 reads the data unchanged. A task in a
linked environment runs as an ordinary thread there, so that machine doesn't release it early; upstream's idle
unload still does. A child with a long-lived dynamic tool open, such as a monitor, is held until it closes. Drop
this patch if upstream starts releasing finished delegated threads itself.

- `apps/server/src/orchestration-v2/DelegatedChildRelease.ts` (fork only): the guards and the release.
- `apps/server/src/orchestration-v2/ProjectionStore.ts`: `getReleasableDelegatedChildren`, on upstream's recovery
  and waiting-link indexes, and `getSettlementCandidates`' `withLiveParent` option.
- `apps/server/src/orchestration-v2/ThreadSettlementService.ts`: the sweep releases children before it reads the
  settings, and a finished task also enqueues its child.
- Tests: `apps/server/src/orchestration-v2/DelegatedChildRelease.fork.test.ts` pins the query against SQLite, the
  guards, a wake queued between the worker's two reads, held children ahead of a ready one, and the worker with
  auto-settle off. Upstream's `ThreadSettlementService.test.ts` and `ProviderTurnControlService.test.ts` gain a
  stub for the new read and otherwise pass unchanged. Upstream already covers the rest: settling detaches the
  session (`ProviderSessionManager.test.ts`), Codex unsubscribes on unload (`CodexAdapterV2.test.ts`), a subagent
  in its parent's worktree skips the settle script (`ThreadSettlementService.test.ts`), and a stale auto-settle is
  refused while a message reopens a settled thread (`runtimeLayer.test.ts`).

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

In the boring sidebar (Settings > Labs), upstream lets a row drag only out to the composer (#26724), because
project folders draw their rows in a different order from the list that sorting reads. Pinned rows sit above the
folders in list order, though, so they can reorder among themselves again, and still drag out to the composer. A
pinned row drops only onto another pinned row, and the order saves through the same write the flat sidebar uses,
so it holds after a reload and on other machines. Folder rows still only drag out to the composer, and a pinned row
let go over a folder goes back to its place. The Pinned and Active labels that show during a drag stay hidden here:
they'd sit over folder rows, which don't move apart to make room.

- `apps/web/src/components/sidebar/boringPinDrag.ts`: `createBoringSidebarSortingStrategy` moves only pinned rows.
- `apps/web/src/components/Sidebar.tsx`: a pinned row's drag isn't a composer-only drag (`isContextDrag`); uses
  the strategy in the boring sidebar, keeps drops to pinned rows, and keeps the drag labels hidden there.
- Tests: `apps/web/src/components/sidebar/boringPinDrag.fork.test.ts`.

### Mod+L cites selected assistant text (`fork:`)

Selecting text in an assistant reply shows upstream's floating Cite button. Cmd+L on a Mac, or Ctrl+L elsewhere,
now presses it while it shows, the way Cursor's Cmd+L adds a selection to chat, and the button shows the shortcut.
The shortcut lives in the toolbar rather than in the keybindings config: a new default would be written into
`keybindings.json`, where stock T3 reports the unknown command as an invalid entry. So it can't be rebound, and it
takes Mod+L only while the button shows; the preview's Mod+L (`preview.focusUrl`) is unchanged. Unlike Tab, it
also works in a side chat, whose button cites into that chat as a click does.

- `apps/web/src/components/chat/citeSelectionShortcut.ts`: the shortcut, its label and its `aria-keyshortcuts`.
- `apps/web/src/components/chat/AssistantSelectionToolbar.tsx`: a capture-phase keydown listener clicks Cite, so
  a disabled (too long) selection ignores it too, and a `Kbd` shows the shortcut on the button.
- Tests: `apps/web/src/components/chat/citeSelectionShortcut.fork.test.ts` and
  `apps/web/src/components/chat/AssistantSelectionToolbar.fork.browser.test.tsx`.

### Fork CI, release and sync (`fork:`)

- Only the fork's own workflows run here: `fork-ci.yml`, `fork-release.yml`, `fork-windows-tests.yml`,
  `fork-mac-update-check.yml`, and upstream's `release-desktop.yml`, which `fork-release.yml` calls. Every other workflow is upstream's, with its
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
  `fork-release.yml` runs `fork-ci.yml` as a called workflow, which gets no more permissions than its caller, so its
  `ci` job grants whatever `fork-ci.yml`'s jobs ask for (`id-token: write` since v0.1.3, for upstream's task cache).
  Otherwise GitHub won't start the release. `scripts/fork/ci-workflows.test.ts` checks this.
- Tests: `scripts/fork/*.test.ts` and `apps/desktop/src/updates/updateChannels.fork.test.ts`.

### Account pools (`pools:`)

Two or more accounts of one provider act as one pool, so a thread that reaches a usage limit continues on another
account instead of stopping. New threads go first to the account whose week resets soonest, since a week's unused
allowance is lost at its reset; ScriptedAlchemy's fork, where pools were ported from, picks the least-used account.
Users read about it in the Account pools section of `docs/user/providers-claude.md`.

- Pool-only files: `packages/contracts/src/providerPool.ts`, `packages/client-runtime/src/providerPools.ts`,
  `packages/shared/src/providerInstanceDisplay.ts`, `apps/server/src/provider/providerPoolSnapshot.ts`, and
  `ProviderPoolCatalog.ts`, `ProviderPoolRouting.ts`, `ProviderPoolDispatch.ts` and `ProviderPoolFailover.ts` in
  `apps/server/src/orchestration-v2/`. On the web, `ProviderPoolsSettings.tsx` and its `.logic.ts`,
  `ProviderLimitedUntil.tsx`, `ProviderSignInEnd.tsx` and its `.logic.ts`, and
  `routes/_chat.settings.account-pools.tsx`.
- Claude login end dates: `apps/server/src/provider/claudeSignIn.ts` reads `claudeAiOauth.refreshTokenExpiresAt`
  from `.credentials.json`, or on macOS from the Keychain with the `/usr/bin/security find-generic-password` call
  and names Claude Code uses, so the item Claude Code created answers without a prompt. It keeps only the date.
  `ClaudeProvider.ts` publishes it as `auth.expiresAt` for a first-party login Claude Code stored, and reports an ended one as
  unauthenticated, which drops it from pool routing. When failover finds no account, `run.pool-failover` emits a
  `system_notice` naming what each account waits on, instead of producing no events. A new turn routed to a pool
  with no usable account is refused with the same breakdown (`unavailablePoolNotice`).
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
  - `ServerProviderAuth.expiresAt` is optional, so a stock client or server leaves it out.
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
  joined the line faster than one every 90 s. A release whose start fails (its `queue.resume` dispatch fails)
  isn't a release: the thread keeps its place, the spacing doesn't move, no move to the linked machine starts that
  pass, and the next pass tries the same thread again, once a pass. It used to be logged as released and dropped
  from the list, which left its run held with nothing to release it.
- An idle session stays open while one of its threads has a run preparing, starting, running or waiting, or while
  an open is attaching a thread to it. A run marks its session busy only once its turn starts, so opening, resuming
  or compacting looked idle: on Nov 9 the pass closed one session during Alice's `/compact` and another while her
  next message was reopening it, and both messages failed with nothing retrying them. The pass reads a session's
  runs just before it closes the session. A run written after that read still has to open the session, and `open`
  marks a live session (`opening`) in the same step as it looks it up, so an idle release, this pass's or the idle
  timer's, leaves the session alone until the open ends. From then on the release's idle-generation guard keeps
  it. Checkpoint rollback opens a session and rolls back with no run, so a pass during a slow rollback can still
  close it, as before this patch.
- A wake a provider buffered (`isBufferedWake`) starts at once, over the limits and during a pause. It records a
  turn Claude's CLI started by itself when a background command finished, so holding it saved no memory: the turn
  ran anyway, with no T3 run, and every T3 tool it called failed with `parent_not_active` until the hold lifted
  (13 of 15 such failures in the day to Nov 10). Codex's wakes are prompted by T3, arrive as server messages, and
  are still held. Upstream's queue still holds a wake that arrives behind held messages once Stop has reached the
  thread's running turn (`wakeSkipsHold` in `Orchestrator.ts`), Stop now's included; that stays upstream's call.
- A parent can tell a held child from a working one. On Nov 9 a PC child's wake waited 9 hours behind the limits
  while its session kept working, and the parent on the Mac read `running` and `working` the whole time, so nobody
  looked. `task_status` and `t3_thread_read` now carry `held` (`runId`, `since`, `reason`) while T3 holds every
  queued run on a thread and nothing runs there (`mcp/heldRuns.ts`): the scheduler starts any queued run it doesn't
  hold. `held` names the run that starts first once the hold ends, in the scheduler's order (`QueuedRunOrder.ts`).
  The reason is the limits' notice when they hold it, and otherwise says the queue waits to be resumed, as after a Stop. A held run that is a buffered Claude wake
  also says the session may still be working outside T3. `t3_thread_read`'s runs mark each held one `held: true`.
  A task in a linked environment asks its thread there, as its follower does, for at most 3 s (`heldThere` in
  `RemoteDelegation.ts`); a machine asleep, a dropped route or an older peer reads as before. Upstream's `runStatus`
  (#24475) reads the same thread there for `starting`; the held read stays its own, since it waits 3 s at most and
  reads one run, where upstream's has no limit. `status` and
  `workState` keep their values, so a client that ignores `held` reads what it read before.
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
  - `ProviderSessionManager.ts`: `releaseIdleSessions`, which picks sessions with `idleSessionsToClose`, tells the
    governor each session it looks at (`onSession`, for `passes.json`), skips one whose threads have a working
    run, and closes the rest through upstream's `releaseEntry`. `open` sets the
    entry's `opening` while it attaches a thread to a live session, and `removeLiveEntry` keeps an entry so marked
    when releasing it as idle. Upstream dropped `lastActivityAtMs` in v0.1.4, since nothing of its
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
  - `orchestratorMcp.ts` in contracts adds `OrchestratorMcpHeldRun` and the optional `held` fields.
    `OrchestratorMcpService.ts` fills them in `readTask`, `readRemoteTask`, `readThread` and `threadRun`, and the
    orchestrator toolkit's `tools.ts` names `held` in `task_status` and `t3_thread_read`, which
    `agentContextBudget.json` records as 121 more bytes of MCP tool list. `RemoteDelegation.ts` adds `heldThere`.
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
    line. Buffered wakes now start at once in a hold, but upstream's queue can still hold one after a Stop, and an
    earlier version of the fork left held ones behind.
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
  - The waiting list is the only thing that releases a held run, so a pass mustn't take off a thread that's about to
    have one. Admission records a thread a moment before its run is written, and before the thread itself for a new
    delegated child, so a thread held in the last minute (`holdWriteMs`, from `lastHeldAt`) stays even with nothing
    queued and no record yet. The pass measures that minute when it reads the list, not when it began, since a pass can
    wait a long time on idle sessions first. A run that has started ends that wait: each
    thread's commands run one at a time and admission holds nothing new while a run is active, so no write can still
    be coming. A started run with nothing held behind it takes the thread off, as a release does, even with work queued
    behind it, which is admitted when that run ends. That keeps Stop stopped, since a thread started by hand and left on
    the list would have its stopped run released by the next pass. A thread held again since the pass read the list
    stays too, which the pass tells from admission having replaced its entry. A thread whose records can't be read is still dropped, because keeping
    it could hold all new work behind one thread for as long as the read keeps failing.
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
  - `passes.json`: T3's own record of its last 1,024 passes (`PassRecord.ts`), one JSON entry a line. Nothing
    outside T3 reads it. Held work barely moved on the PC for two and a half hours on Nov 16 while T3 read memory
    as fine, and the trace log keeps only 8 to 10 minutes, so nothing said why.
    - Each entry has the pass's server (`pid@startedAt`), number, start, end and length; the reading's time and
      memory; the state the readings gave and the one the pass acted on; pause and off; how many threads waited,
      were held, blocked, dropped, ready or moving; the oldest held thread; up to 10 blocking runs, with status
      and since when; whether a release was due and why; each start with its rank, the thread that rank came
      from, how long it was held, and how its unsnooze and resume went; and a result, such as `not due`,
      `none ready`, `released` or `start failed`. A pass that failed keeps its phase and error. Ranks are read
      only to order two or more ready threads, so a lone one shows no rank and `ranks` is null. A switched-off
      pass can start more than the 10 listed: failed starts are listed first, with `startCount` and
      `failedStarts`.
    - Passes that decide the same thing share an entry (`count`, `lastPass`, `maxMs`), so quiet hours cost one
      line, rewritten at most once a minute while nothing else changes.
    - `current` is the pass under way. The pass notes its phase in memory just before each await that can block,
      with the thread or session involved where there is one (inspecting, ranks, idle-session closes, dispatches,
      the state file; the overflow mover's steps name none, and `moved.json` says which move is under way). A
      loop of its own writes it once that phase has lasted a second, so a stuck pass shows where and a slow disk
      can't hold up a pass. A pass the last server never finished stays as `unfinished`, with `seenAt`, when the
      file was last written.
    - A failed write logs a warning and is tried again in full 15 s later. Every write here now removes its
      temporary file when the rename fails, as it does on Windows onto a file another process has open; 33
      `state.json.*.tmp` files had piled up on the PC since Nov 3.
- Stock compatibility: holds, notices and resume notes reuse `run.updated`, `turn-item.updated` and system
  notifications. Pause all adds no event type, and stock T3 ignores `pause.json`, treating a typed order as an
  ordinary message. Stock T3 drops `resourceLimits` the next time it saves settings. The `held` fields are tool
  output only, read from runs and notices already stored.
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
  - A held thread whose start keeps failing is tried again every pass, and in board-rank order everything behind
    it waits meanwhile. `passes.json` shows it as `start failed`.
  - A crash less than a second after a run is held can lose its place in the line. **Resume** still starts it. A
    refused launch whose session has already closed stays unmatched (`resource-limits.inbox-unmatched`), with no note.
  - Mobile has no Load balancing settings, so limits are edited from web or desktop. Mobile's Resume starts held
    work like web's.
  - Upstream refuses to snooze a thread with a queued message of its own. So held agent messages stay in the
    inbox, and only threads holding notifications alone (interrupted turns, refused launches) get snoozed.
- Tests: `apps/server/src/resourceLimits/*.fork.test.ts`,
  `apps/server/src/orchestration-v2/LimitsSweepKeepsRuns.fork.test.ts`,
  `apps/server/src/orchestration-v2/LimitsSweepKeepsOpens.fork.test.ts`, `packages/shared/src/serverSettings.fork.test.ts`,
  `packages/client-runtime/src/load-balancing.fork.test.ts`,
  `packages/provider-core/src/server/subagentProjection.fork.test.ts`, `apps/server/src/mcp/heldRuns.fork.test.ts`,
  and `MachineLimits.logic.fork.test.ts`. `Governor.fork.test.ts` runs the real orchestrator with fake readings and a test clock.
  Its D tests cover `passes.json`: a pass's decision fields and a run of repeats as one entry (D1), the phase and
  thread a stuck await shows (D2), the 1,024-entry bound and a last server's `unfinished` pass (D3), and a failed
  `queue.resume` keeping its thread in line and off the linked machine, tried once a pass (D4), and failed starts
  kept when a switched-off pass starts more than it lists (D5).

### Held threads move to a linked machine (`limits:`)

On Nov 16 the PC held a long line of threads for about seven hours while the cloud machine sat mostly idle. Only
brand-new threads went to the cloud, at launch. Now a thread the PC holds continues on the linked machine named in
`resourceLimits.overflow`, as a new thread there, and the PC thread forwards to it. Users read about it in the
Memory and CPU limits section of `docs/user/remote-access.md`.

- Settings, in the held machine's `resourceLimits.overflow` (no UI yet; the limits dialog keeps it when it saves):
  `environmentId`, `mode` (`auto` or `off`, default `auto`), `provides` (capabilities the target has),
  `assumeNeeds` (default `vault`, `content`, `gateway`), `moveAfterMs` (default 10 minutes), an optional
  `fallbackModel`, which counts only where the target lists it, and an optional `checkoutFree` (below).
- When: in the governor pass, while threads are waiting and nothing was released that pass, unless Pause all is on
  or the limits are switched off. It walks the release path's ranked list (board rank, then oldest) and starts
  moving the first thread that has waited `moveAfterMs` and may move. One move is under way at a time, and a pass
  in which a move launched or finished starts no other. The rest keep their place for the PC.
- Which threads may move is `moveBlocker` (what the PC knows) and `movePlan` (what the target has) in `policy.ts`:
  a top-level thread (no parent here, not delegated from elsewhere); every `needs:<capability>` tag in `provides`,
  with `assumeNeeds` standing in for a thread with no such tag, and `needs:none` needing nothing; no attachments on
  held messages; a clean checkout on a branch with an upstream and nothing unpushed, and for a root-checkout thread,
  the default branch; exactly one project there with the same repository, with a remote for the branch's
  repository; and the thread's provider there (a listed model, or unlisted models), or a listed fallback. Held
  messages that don't fit in one 110,000-character brief stop a move rather than being cut. A thread that can't
  move, or whose move fails, isn't looked at again for 30 minutes (`moveRetryMs`), with the reason logged as
  `resource-limits.move-skipped`. Those waits are saved in `moved.json` (`retryAt`), so a restart keeps them.
- The claim: once a thread passes those checks, the mover takes the thread's command lock
  (`ThreadCommandExecutor`, the per-thread lock admission and Resume run under), installs a `claiming` entry, and
  reads the batch inside the lock. A run admitted before the claim has started by then, and the thread doesn't
  move ("it started here"); a message or Resume after it is held. The claim lives only in memory, since nothing
  has left the PC yet, and is dropped if the move doesn't reach `pending`. Attachments and the brief's size are
  checked again on the batch read under the claim. `server.ts` gives the mover the same lock instance as the
  orchestrator by layer memoization; that's the only reason the mover's layer provides it.
- Which commit: the branch's upstream comes from `branch.<name>.remote` and `.merge`, so a remote that isn't
  `origin`, or has a slash in its name, reads right. Its URL's repository key picks the remote there from the
  project's identity there (its primary remote, or `origin`), so a fork tracked as `fork` here and `origin` there
  works. The launch names that remote branch (`<remote>/<branch>`, `startFromOrigin`), so the target fetches it
  rather than following a local branch's tracking. `baseRef` can't be the commit itself: the target fetches only
  branches by name, so a commit it hasn't fetched fails. So right before the launch, the PC asks the real remote
  for the branch's head (`git ls-remote <remote> refs/heads/<branch>`) and moves only if that is its HEAD or a
  descendant of it (`git merge-base --is-ancestor`); a rewound or force-pushed branch, a deleted one, or one moved to
  a commit the PC doesn't have is skipped with the reason. The brief still gives the PC's HEAD, and the thread there
  checks it has it, fetching and resetting if not, before it starts. It pushes back with
  `git push <remote there> HEAD:<branch>`.
- Checkout-free moves (`overflow.checkoutFree`: `repositories`, `project`, optional `note`): Alice's task threads work
  in her notes vault's own checkout on `main`, usually with unrelated uncommitted edits, and that repository must
  never be cloned onto the cloud machine, which reaches the vault through a tool service instead. A thread whose
  project's repository key (`RepositoryIdentityResolver`'s lower-case key) is listed, and which runs in the project
  checkout rather than a worktree of its own (`checkoutFreeRepository`), skips the branch, change and push checks, the `ls-remote` and
  the same-repository project lookup (git is still read for the repository key); the rest of `moveBlocker` still applies. It launches with no
  `workspaceStrategy` (the project's own folder there) into the one project there whose ID, or else title, is
  `project` (`checkoutFreePlan`), and its brief says the repository isn't there and must not be cloned, then adds
  `note`. A thread of that repository in its own worktree moves the usual way. Everything from `pending` on is the
  same. Since `threadThere` can't tell a root launch from a worktree one, a checkout-free thread that fails before
  it starts there is logged as "its worktree wasn't set up".
- The branch there is `t3-moved/<branch>-<6 chars of the thread ID>-<move start, base 36>`, never the branch's own
  name: `git branch` refuses a name that exists there, and `git worktree add` one checked out in another worktree.
  The start time is frozen in the launch, so a retry of the same launch keeps the name, and a later move, after a
  failed setup there left a branch behind, gets a new one.
- Every call to the linked machine (and the `ls-remote`) is bounded by 20 s (`overflowCallMs`), well under the 60 s
  after which admission treats the governor's reading as stale. A timeout leaves the move in its phase, and the rest
  of that pass makes no more calls there.
- A move is a handoff in phases, each saved to `<stateDir>/resource-limits/moved.json` (`{ version: 2, threads:
  { [threadId]: { phase, environmentId, machine, at, batch, launch, threadId, link, outbox } }, retryAt }`) before
  the next step (`Overflow.ts`, `step`):
  - `pending`: the held runs it carries (`batch`, each with its text as sent) and the whole launch, brief included,
    are frozen. The launch is keyed `limits-move:<threadId>:<at>`, so a retry after a lost reply repeats the same
    launch and finds the same thread there. A message that arrives meanwhile isn't in it, and is forwarded later
    like any other. A `pending` move is never given up while the answer is unknown: a transport failure or timeout
    may hide a launch the target took, so it's sent again each pass, logged as
    `resource-limits.move-launch-waiting`, for as long as that takes. Only a refusal from the target itself
    (`isDefiniteRefusal`: only the codes a launch's own checks refuse with, such as `invalid_request` or
    `model_unavailable`; any other code, including one added later, counts as no answer) ends it, leaving the batch
    held here; the target replays a key it already took before the checks that refuse, so a refusal means it took none.
    A link removed here counts as no answer, not a refusal.
  - `launched`: the thread there exists. Its worktree is prepared after the launch returns, so each pass reads it
    with `t3_thread_read` (`threadThere` in `policy.ts`) until its first run (ordinal 1) has started: a `startedAt`,
    or a status only a started run reaches. A run still queued there, as that machine's own Pause all leaves it,
    keeps the move `launched`, and the batch stays held here.
  - `confirmed`: it started there. The batch's runs are cancelled here, each under its own key, and a batch message
    edited here since the launch (its text no longer the frozen one) is queued to go there as it now reads, marked as
    an edit. A system note is queued and later cancelled, which leaves the "continues on" notice, with the link, as
    the thread's last item. All of it is keyed, so repeating it after a crash or a failed cancel does nothing twice.
  - `moved`: done. If the thread there fails before it starts (a fetch, checkout or setup failure), the entry is
    removed, the batch stays held here in its place on the line, and the thread waits 30 minutes before trying
    again. A step whose `moved.json` write fails stops there without changing anything in memory, and the next
    pass repeats it.
- While a thread has an entry in any phase, `claiming` included, every run on it is held
  (`ResourceLimits.movedHold`, read in `admit` and `holdQueuedRun`), Alice's own messages and Resume included, and
  the governor neither releases nor moves it. The notice says it's moving until it starts there. A restart carries a
  move on from its saved phase: the mover reads `moved.json` when it starts.
- Forwarding is read from the database each pass, not from a flag: for every `moved` thread, each queued run joins
  the entry's `outbox` in `moved.json`, is cancelled here (keyed), and only then is its text read and sent to the
  thread there with `t3_thread_send` (`mode: "queue"`, keyed `limits-forward:<runId>`, or `limits-edit:<runId>` for
  an edited batch message), in order. Cancelled, a message can't be edited any more, so what's sent is its final
  text, and a crash between the cancel and the send still sends it. Before sending, the keyed cancel is repeated:
  it replays if this machine cancelled the run, and fails if someone else cancelled or started it, which drops it.
  A failed send or cancel stops that thread until the next pass. Runs in the batch are only cancelled, never sent.
- Pause all quiets this machine, and forwarding runs no agent here, so moved threads keep forwarding during Pause
  all, and a move already launched carries on. No move starts, and a `pending` one doesn't launch, while paused;
  the switch is read again right before a launch, so one set during a move's reads stops it.
- A buffered Claude wake always stays here on a moved thread, queued or not: Claude already started that turn
  here, so `holdQueuedRun` checks for it before the moved hold, and forwarding skips it.
- The PC thread keeps its ID for the board, task wake and parents. Removing a thread's entry from `moved.json` and
  restarting brings it back.
- The governor runs inside the orchestration runtime, which has no peer links, so `server.ts` installs the mover
  into `ResourceLimits` (`setOverflow`) once the links are up. Without it nothing moves.
- Upstream files it changes: `apps/server/src/server.ts` (the layer, and the thread lock it shares).
  `MachineLimits.tsx` keeps `overflow` on save.
- Known gaps: the PC can't see the cloud's free memory, and the cloud has no rank file, so moved threads there queue
  only behind upstream's own cap. The thread there gets a summary, not the tool-level history. Forwarding carries an
  attachment's name, not the file. A moved thread's later messages leave its transcript here, as cancelled queued
  messages do. Eligibility is read when the move starts; the thread can't run here after that, but someone working
  in its checkout by hand isn't seen. A move whose link never answers again stays `pending`, holding its batch here,
  until someone removes its entry; the log says so each pass. A Resume during the brief claim is held, and stays
  held if the claim is then dropped (the remote check fails, or Pause all is set).
- Tests: the `moveBlocker`, `movePlan`, `upstreamOf`, `moveBrief`, `threadThere`, `remoteHeadBlocker` and
  `isDefiniteRefusal` rows in `policy.fork.test.ts`, and O1 to O17 in `Governor.fork.test.ts`. Its fake cloud
  replays launches and sends by key, records every send, refuses a new launch onto a branch an earlier one took,
  answers reads decoded with the real `t3_thread_read` schema, and can lose replies, stall, refuse, fail late and
  fail cancels here. They cover rank order, ineligible threads, Pause all (also set during a move's reads),
  forwarding (also during Pause all, after a failed send or cancel, across a restart, and with a message arriving
  meanwhile), a queued buffered wake, a link down for hours without giving up and a refusal that does, a lost reply
  with a message and a Resume during the move, a Resume during the claim and one just before it, a restart at each
  phase, an unwritable `moved.json`, a first run that's queued or preparing there, a failed setup there, edited
  batch and forwarded messages, a rewound or deleted remote branch, a later move after a failed setup, a stalled
  launch, two moves in one pass, and a skip surviving a restart.

### Awaited Claude tasks keep their wake owner (`fork:`)

Claude can remove a finished background command from its roster before its native wake arrives. Releasing or
settling the thread in that interval closed the SDK query and lost the wake. The adapter now retains awaited
commands in the existing pending-work roster, and its runtime probes retain both those commands and buffered
notifications. The hold ends after a committed continuation attaches and consumes the buffer. Offering an
in-memory request or queueing a run does not end it. Empty roster levels cannot erase the hold.

Missing native wake evidence expires after two minutes, with a warning. Native evidence claims only the task IDs
in its notifications; consuming one wake leaves other tasks held under their original deadlines. Clearing Waiting
also matches retained task IDs and releases only the requested holds, and drops a cleared task that already left
the roster from upstream's owed wakes (#34568), which would otherwise keep publishing it as awaited. Failed reads or
dispatches retry with capped backoff, fresh command receipts and a stable message ID. Admission can wait for the
governor up to the existing idle pin limit (four hours by default). At that limit the manager persists a visible
"Background wake cancelled" notice before closing the session, then retries a failed notice write with the other
release records. This bounds memory retention without silently losing a wake. The existing restart reconciler
operates on the whole server; using it for one idle session would affect unrelated work.

Upstream #24891 lets settling cancel a queued message the user didn't write, where it used to refuse. Auto-settle
still gives a queued turn two minutes to start, but a background wake held for admission can wait far longer, so
the settlement read skips a thread while one is queued.

Stop, disabled-provider cancellation and process replacement retire the owning query's state; restart uses the
existing awaited-work recovery. An unexpected provider exit also cancels an undeliverable native wake with a
visible notice. Intentional Stop stays quiet. There is no migration, event type or setting.

- `apps/server/src/orchestration-v2/Adapters/ClaudeWakeOwnership.ts` owns the query-scoped deadline and handoff;
  `ClaudeAdapterV2.ts` publishes and probes it at the existing roster and continuation seams.
- `ProviderSessionManager.ts`, `ClaudeWakeCancellation.ts` and the optional in-memory adapter callback persist
  cancellation at bounded idle release independently of the closing reader, using existing turn-item events.
- `ProjectionStore.ts`: `getSettlementCandidates` skips a thread with a held background wake queued.
- Upstream now covers part of this. It publishes owed wakes for opaque tasks that left the roster (#34568), and its
  wake latch retires an unstarted wake's frames (#28173, #30114). The fork merges its held commands into that
  published list, and a retired wake also ends its query's hold on the tasks it reported. Upstream #31840 keeps
  the old run's event reader open while its last consumed roster lists pending work, so `RunExecutionService.ts`
  carries no fork code. The fork's own share is the hold for awaited commands, the deadline, retries and the idle
  check.
- `packages/provider-core/src/server/ProviderContinuationRequests.ts` and
  `apps/server/src/orchestration-v2/ProviderContinuationService.ts` carry the optional receipt and retry callback.
- Tests: `Adapters/ClaudeWakeOwnership.fork.test.ts` and `ClaudeWakeOwnership.fork.test.ts`, with the real session
  manager, continuation worker, settlement worker and SQLite replay. The replay testkits expose dispatch and
  close gates. Existing Claude assertions retain buffered notifications and distinguish roster gaps from ID reuse.
- `CodexWakeGap.fork.test.ts` asserts delivery and a new run as an expected failure for the known Codex gap below.
  Its completed-command handler can still be interrupted before enqueueing; Codex code is unchanged.

### Delegated attention reaches its owner (`fork:`)

Local delegated questions already notified their parent, but approvals did not. Linked-environment followers
waited only for completion, and a lost background wake remained only a transcript notice. The question reactor
now also relays approvals and wake cancellation to the parent. Upstream v0.1.11 runs the reactor under each
parent's lock and passes it only the events it can key to a parent, so the fork keys these two by the child's
parent as well. An approval relay tells the parent to inform the user; it grants no approval capability.
Resolving an approval cancels a still-queued local relay. Notifications use ordinary queued messages and keep the
existing pause and resource-governor holds. Upstream v0.1.11 (#25680) drops a delegated task's queued notice as a
stale question wake unless a question it names is still pending, so its check in `Orchestrator.ts` skips the
fork's approval and lost-wake notices, which the fork withdraws itself.

Peer thread waits opt in to attention summaries with `seenAttentionIds`. The remote follower acknowledges each
request or notice after delivery, with stable message IDs for deduplication across retries and restarts. An
attention-only return never substitutes for the final delegated result, even when its run has ended. Old
peers retain their completion-only behavior. There is no persisted schema, event type or setting change.

Web and desktop notifications identify the newest pending request, including linked children, so a second prompt
in one run alerts again without re-alerting when an older prompt is exposed. Upstream v0.1.11 (#32719, #25866) now
keys a thread's own request by its ID alone and alerts once per ID, so the fork keeps only which request names the
alert: a linked task's, which upstream leaves without an ID, and the newest one still announced after it is
answered. For a root thread's lost wake, the client reads a bounded recent projection when a run settles, or an
idle thread gains items or loses awaited work. This includes completion and wake loss coalesced into one shell
update. Deferred completions retain their run identity and are discarded when work resumes; a late wake warning
supersedes only its own run's completion. Completion deferral expires after fifteen seconds even behind stalled
transport reads. Upstream v0.1.7 (#29146) sends completions without its old two-second wait, so the coordinator
queues the read before the notification gate sees the same update. A completion that also lets go of awaited
background work waits for that read instead. Any other completion goes out at once, as upstream's do: a running
shell lists no awaited work, so when a run's end and its lost wake arrive in one update, the warning follows the
completion. A disconnect keeps a held completion for the read after reconnecting, still within those fifteen
seconds.
Reads are coalesced, limited and retried. A wake warning replaces a pending completion alert; existing notification
settings and focused-thread suppression apply. Historical notices remain quiet after reload. Mobile notification behavior
is unchanged. The title `Background wake cancelled` is shared by the Claude adapter, relay and client tracker;
changing it requires updating all three.

- Server seams: `DelegatedTaskQuestionReactor.ts`, `DelegatedAttention.ts`, `ThreadAttention.ts`,
  `ThreadManagementService.ts`, `OrchestratorMcpService.ts`, `RemoteDelegation.ts` and one line in
  `Orchestrator.ts`'s `isStaleQuestionWake`. Upstream's peer wait now
  forwards its whole input, so `PeerForwarding.ts` carries `seenAttentionIds` with no fork line.
- Client seams: `ThreadNotificationCoordinator.tsx` and its gate, with fork files `ThreadAttentionRequests`,
  `ThreadWakeNotices` and `ThreadWakeNoticeRead`. The wait additions in `packages/contracts/src/orchestratorMcp.ts`
  are optional wire fields.
- Tests: `DelegatedAttention.fork.test.ts` exercises SQLite and the real question reactor and thread wait;
  `RemoteAttention.fork.test.ts` covers the remote follower; `PeerAttention.fork.test.ts` drives an authenticated
  peer HTTP wait. The three client fork suites cover request identity, wake reads and notification wiring.
  The existing badge browser fixture returns an explicit empty projection; fork tests control delayed reads
  across reconnects, so completion assertions do not depend on a missing fixture server's response timing.

### Full access can review flagged commands (`fork:`)

Upstream's full access turns down every ask but MCP elicitations (#37104 moved it off `never` so browser prompts
reach T3), so Codex refuses any command its classifier flags, such as a forced delete, with "blocked by policy". The thread can't ask anyone, and agents tend to wrap the command
in another shell to get past the classifier. The new Codex setting "Review flagged commands in full access" sends
those commands to Codex's auto-review instead, using a granular approval policy with the sandbox still off. Unflagged
commands run as before. A command Codex's own rules forbid stays forbidden.

With `auto_review`, Codex also sends its reviewer any MCP call not annotated as safe, whatever the granular flags
say. So the setting adds `default_tools_approval_mode = "approve"` to the thread config for T3's two servers, each
server upstream's per-thread `config/read` lists, and `apps._default`, at thread start, resume, rollback and native
fork. The fork reads no config of its own: it takes the names from the read upstream makes for stdio servers. A server or tool with its own approval mode keeps
it. Some calls stay reviewed: plugin servers, and project-level servers in a thread with no folder, aren't in
`config/read`; a dot in a server name would split the config path; and nested elicitations (from `node_repl`, say) go to
the reviewer, where upstream's full access accepts them. If the read fails, the thread still starts and those calls
are reviewed. A server removed from the config between that read and the thread start would fail the start,
since the override leaves it with no transport.

Codex ignores thread config when T3 rejoins a thread it still has loaded. So a loaded thread switched into full access
has its connector calls reviewed, and one switched out of it keeps skipping review for them, until T3 unloads it when
idle and Codex loads it again.

The setting is read when Codex's session opens, and all threads on a Codex instance share one session, so a change
applies after T3 restarts, or after every thread on the instance has gone idle long enough for the session to close.
The setting's description says so. Reading it per turn would put a loaded thread on the reviewed policy without its
connector exemption.

Two more things change with the setting on. Codex's instructions to the model describe the approval policy, so they
differ from `never`'s. And Codex's reviewer interrupts the whole turn after 3 denials in a row or 10 of its last 50, and
sooner on cyber models.

When a review denies or times out, in any runtime mode, the thread shows a `system_notice` with what was stopped,
the risk and reason, and how to try again. A reply approving the exact command is what the reviewer reads next. An
agent's `t3_thread_send` also arrives as a user message, so that reply doesn't prove a person wrote it.

The setting is on by default, as Alice asked on Nov 10, 2026, and stored under a new key; turning it off stores
`false`. Off, every request matches upstream's, so the shared settings in `CodexAdapterV2.test.ts` and
`CodexAdapterV2.testkit.ts` turn it off and the recorded Codex fixtures stay untouched. There is no migration or new
event type.

- `apps/server/src/orchestration-v2/Adapters/CodexReviewedFullAccess.ts` holds the policy, thread config, which
  servers to exempt and notice text. `CodexAdapterV2.ts` calls it at turn start and from upstream's `config/read` at
  thread start, resume, fork and rollback, and handles `item/autoApprovalReview/completed`.
- `packages/contracts/src/settings.ts` adds `reviewFlaggedCommandsInFullAccess`, which the provider settings form
  shows as a switch on the Codex card.
- Tests: `Adapters/CodexReviewedFullAccess.fork.test.ts` runs sessions against a scripted Codex with the setting on
  and off, using a real 0.167.0 denial, and compares the requests sent exactly, because replay matching ignores MCP
  server config. `ProviderSettingsForm.fork.test.ts` covers the switch and its default.

### A Claude turn that fails to start gets one retry (`fork:`)

When Claude couldn't start a turn, for example because Claude Code never answered its MCP server registration, the
run failed with "The provider could not start this turn." The reason was only in the server log, which on a busy
machine rolls over within minutes, and a message another agent sent died with the run.

Claude queues the prompt as the last step of starting a turn, so a start that failed never sent its prompt. Run
execution now hands the failure to a hook before the run fails. For a Claude turn, the hook dispatches the internal
`run.start-retry` command, which closes the attempt as failed and opens a second one on the same account with the
same message, through the `replaceRunAttempt` path that pool failover uses. The thread shows "Claude could not start
this turn. Trying once more." If the second start fails too, the run fails as before, with its error on the second
attempt. A run is retried at most once.

There's no retry for other drivers, which don't promise that a failed start sent nothing. There's none for a turn
Claude already reported, a provider wake, `/compact`, upstream's resume of an interrupted turn (#27079), which a retry
would send as a new prompt, or a Stop. Refusals that would repeat get none either:
background work blocking a new query, an unreadable appended system prompt or settings argument, a turn still
active, or an attachment Claude can't take (an unsupported image type, or an attachment that's missing or
unreadable). The adapter gives the first two attachment refusals no reason, so they're matched on their text.

An MCP registration timeout is retried. A resumed session already retries that once inside the adapter, so a
resumed turn whose registration keeps timing out now waits up to four 90-second timeouts before it fails, not two.

Every failed start, retried or not, is appended to `logs/turn-start-failures.ndjson` in the state directory. Each
line has the thread, run, attempt, account, model, time to failure, whether it was retried, the chain of error
names, and the error text, redacted and capped at 8,000 characters. The file keeps 1 MB and one backup, and storage
cleanup only removes the backup. Failures before the run starts, such as a session that won't open, already retry
through the effect worker and show their reason in the thread, so they aren't logged here.

The retry writes only existing events: the `retry` attempt reason was already in the schema, and the notice is a
`system_notice` turn item. There is no migration, event type or setting.

- `apps/server/src/orchestration-v2/ProviderStartRetry.ts` decides whether to retry, dispatches the command and
  writes the log. `RunExecutionService.ts` calls it from the start failure handler. Its failure write that follows is
  gated on the attempt, so after a retry it commits nothing.
- `Orchestrator.ts` handles `run.start-retry` and lets `replaceRunAttempt` take the `retry` reason;
  `packages/contracts/src/orchestrationV2.ts` adds the command. `packages/provider-core/src/server/failure.ts`
  exports its redaction. `runtimeLayer.ts` provides the hook. The replay harness provides it only with its
  `startRetry` option, because upstream's provider switch tests fail a start on purpose to test the manual resend.
- Tests: `ProviderStartRetry.fork.test.ts` covers which failures retry, the log line and the log file.
  `ProviderStartRetry.integration.fork.test.ts` runs the orchestrator over SQLite with a Claude adapter whose first
  start fails, then whose first two starts fail. Two more switch a thread from Codex to Claude: when the start fails
  after the history was injected, the retry reuses the native thread without injecting it again, and when the
  injection fails, the retry moves to a new native thread with the history. A last one has Claude refuse a start
  and its retry for an MCP registration timeout: the native session is kept, and the next turn carries the missed
  request once, as upstream's refused-start test expects without the retry.

### Pull request numbers in replies link (`fork:`)

Agents often name a pull request by its number alone ("#554 is green"). Upstream links GitHub references like that
only in a pull request's own body and comments, so in a reply the number stayed plain text unless the agent wrote
the URL out. A finished assistant reply now links a bare `#123`, or `owner/repo#123`, using what T3 already knows:

1. A pull request linked to the reply's own thread.
2. A pull request linked to any other thread, when only one repository has that number, or when one of them is the
   thread's repository.
3. The thread's repository, when T3 has seen a pull request there numbered that high. T3 can't tell a pull request
   from an issue by its number, so this link carries upstream's reference marker: clicking it checks GitHub and
   opens the pull request, or the issue when it isn't one.

The thread's repository is the one its linked pull requests belong to, or else its project's GitHub repository.
Nothing else links: a number past the highest T3 has seen there, a number two other repositories share, and
anything in code or already in a link stay as written. GitHub's own grammar decides what counts as a reference, so
`a#12`, `#12abc` and `#0` don't. A reply that is still streaming isn't linked, since any Markdown extension turns
off its block-by-block render; it links when it finishes. The extension comes from the quiet thread-shell atoms and
keeps its identity while a thread's pull requests don't change, so a running thread's ticks don't re-render or
re-parse finished replies.

Since v0.1.12 the links come from a fork-only `replyPullRequestLinks` field on upstream's `MarkdownExtensions`:
upstream's Words pipeline (#27866) replaced remark, so there are no remark plugins to add. It links text the way
upstream's change request autolinks do, in the same pass, and never inside code or a link. Upstream's own
`changeRequest` extension isn't used because it also resolves root-relative images against the repository.

- `apps/web/src/components/chat/replyPullRequestLinks.ts`: matching and the cached extension.
- `apps/web/src/markdown/wordsHast.ts`: the `replyPullRequestLinks` field, applied in `linkText`.
- `apps/web/src/components/chat/useReplyPullRequestLinks.ts`: the atoms that gather every thread's pull requests and
  the reply thread's repository.
- `apps/web/src/components/chat/TimelineAssistantRows.tsx`: passes the extension to a finished reply's
  `ChatMarkdown`.
- Tests: `apps/web/src/components/chat/replyPullRequestLinks.fork.test.ts`.

### A delegated task on a linked machine can have its own worktree (`fork:`)

Alice's agents send code work to her cloud machine when the PC is short of memory, and each child there needs a
checkout T3 makes and tracks. Upstream refused `isolation: "worktree"` for a `delegate_task` with
`target.environmentId`: a local worktree starts from the parent's commit, which the other machine may not have.
Such a task now needs `baseRef`, a branch, tag or commit on that project's origin, such as the PR's branch or `main`,
and the launch there gets `workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: true }`, which fetches the
ref from origin when that machine doesn't have it. There's no default: the caller always knows whether it means the
PR or `main`, and a silent `main` would test the wrong code. A missing `baseRef` is refused before anything launches,
and so is `baseRef` on a shared task there or on any local task, whose worktree still starts from the parent's
commit. A retry reuses the launch's key, which the other side replays as the same thread and worktree. The other
machine needs no patch: stock `t3_thread_launch` already takes that strategy.

- `packages/contracts/src/orchestratorMcp.ts`: `baseRef` on `delegate_task`, and the `isolation` description.
- `apps/server/src/peer/RemoteDelegation.ts` forwards the strategy; `apps/server/src/mcp/OrchestratorMcpService.ts`
  refuses `baseRef` for a local task; `apps/server/src/mcp/toolkits/orchestrator/tools.ts` names it in the tool
  description. `apps/server/src/provider/agentContextBudget.json` records the longer tool list.
- Tests: `apps/server/src/peer/RemoteDelegation.fork.test.ts` covers the forwarded strategy, a shared task, both
  refusals and a retry. `apps/server/src/mcp/OrchestratorMcpService.fork.test.ts` shows a local worktree task still
  starts from the parent's commit and refuses `baseRef`. Upstream's "refuses worktree isolation for a task there"
  in `RemoteDelegation.test.ts` passes unchanged, as the missing `baseRef` refusal.

### An agent recording's repaint ends with its recorder (`fork:`)

Upstream v0.1.12 (#42445) repaints the newest frame of an agent's recording (`preview_recording_start`) at the
recording's frame rate, so a still page records as repeated frames. Its timer stops when the recording stops or
grows too large, but not when the `MediaRecorder` stops on its own, as on an encoding error: the repaint then ran
until the encoder's page closed. The recorder's own stop now ends it too.

This patch used to add the repaint itself, with the click ring fading on those repaints. Upstream's #42445 covers
the repaint, so the fork cut it to this. A late decode painting over a newer frame and a hidden tab's first frame
were cut at v0.1.11: upstream's #36215 hands the encoder one frame at a time, and its #25862 bounds every capture of
the tab at 3 s, with the advice to show the T3 window.

- `apps/server/src/preview/ServerBrowserPage.ts`: the recorder's `onstop` in `recordingEncoderScript`.
- Test: `apps/server/src/preview/ServerBrowserPage.fork.test.ts`.

### A viewer of a hidden tab (`fork:`)

A server tab hosted in the desktop app paints only while T3's window on that computer is drawn. Viewing one from
another device while that window was minimized or covered showed "Connecting..." on a blank canvas forever:
`attachViewer` waited on an opening still the tab never painted, and that capture held the tab's capture lock.
Upstream v0.1.11 fixed that part, so the fork cut its own: #25381 no longer awaits the opening still and gives the
lock back after 2 s, and #38865 has the web viewer say, 10 s after it connects with no frame, that the server's
browser isn't drawing the page and to try reloading.

That advice doesn't fit a desktop tab, which a reload doesn't help. A viewer of a desktop tab that hasn't been sent
a frame 5 s after it attached gets one `unpainted` message, and the web viewer's notice then says the tab can't draw
while T3's window is minimized or covered, until a frame paints, the stream disconnects or the viewer stops. A tab of
the server's own Chromium gets upstream's notice alone. A PDF tab draws in its own embed, so it never shows either.
Older clients ignore the message, and the mobile viewer doesn't show it yet. An opening still that lands after a
screencast frame is older than it and is dropped. Upstream v0.1.12 now unthrottles a hidden desktop tab while it has a
viewer (#39198), so the notice should show only when that fails; whether the fork still needs it is open.

- `apps/server/src/preview/ServerBrowser.ts`: in `attachViewer`, `VIEWER_FIRST_FRAME_TIMEOUT`, the `unpainted`
  viewer output and the opening still's drop.
- `apps/server/src/preview/ServerBrowserStream.ts` sends it as `{"type":"unpainted"}`;
  `packages/client-runtime/src/preview/serverBrowserStream.ts` reports it as `onUnpainted`;
  `apps/web/src/browser/ServerBrowserSurface.tsx` shows its text in upstream's notice.
- Tests: in `ServerBrowser.test.ts`, `fork:` tests for desktop tabs that draw nothing (one notice at 5 s) and that
  draw (none), a server tab that draws nothing (none), and an opening still beaten by a frame.
  `packages/client-runtime/src/preview/serverBrowserStream.fork.test.ts` and
  `apps/web/src/browser/ServerBrowserSurface.fork.browser.test.tsx`.

## Dropped patches

A sync drops a patch once upstream does the same thing, and cuts one down to what upstream still doesn't do. A
cut patch keeps its entry above, which names the upstream pull request. These left the stack whole:

| Dropped in | Patch                                                                    | Upstream                                |
| ---------- | ------------------------------------------------------------------------ | --------------------------------------- |
| v0.1.11    | Git and every plain program start from a worker thread on Windows        | #32260, #37180, #36327 (spawn workers)  |
| v0.1.11    | A Claude session keeps its unread output and ends its stdin at exit      | #32260 (Claude starts from its workers) |
| v0.1.11    | Database writes run on their own thread on Windows                       | #35728 (a writer worker everywhere)     |
| v0.1.11    | A stuck checkpoint doesn't hold every save, timed on the monotonic clock | #23496, #31804                          |
| v0.1.11    | Pull request sweeps skip a redundant git recheck                         | #24099                                  |
| v0.1.11    | Storage cleanup reads git 2.56's message for a broken worktree           | #33423                                  |
| v0.1.11    | Open approval opens a delegated child on its own machine                 | #28592                                  |
| v0.1.11    | A steer sent before the provider turn starts waits in the queue          | #34581 (a steer waits for its turn)     |

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

1. Fetches the clone's full history if it's shallow (`git fetch --unshallow`), then finds upstream's newest
   stable tag. If `fork/main` already sits on it, the run ends.
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
   gets this file, upstream's changes since the last base with their pull requests, and the failing step, in a
   message kept under 120,000 characters: past that, the list of upstream commits is cut and a `git log` command
   gives the rest. It asks for the dedupe pass below, and for questions to go on Alice's Task Priorities board.
   Later runs leave it alone while it works. State lives in `<clone>-sync/state.json`.

A run that throws, such as a fetch that fails, starts a thread the same way, once per distinct error: the same error
on a later run starts none. If a thread can't start (no `--thread-project`, the memory gate held launches too long,
or `t3 thread start` failed), the state records why and the next run tries again. `sync.ts push` marks the state
`ci-pending` and keeps the thread that owns the sync.

No agent runs when nothing conflicts. `node scripts/fork/sync.ts run --dry-run` reports what a run would do
without pushing or starting anything.

## Resolving a sync conflict

You've been given a worktree where the stack is rebased onto a new upstream release, and either the rebase
stopped on a conflict or Fork CI failed. Your job is a passing release, or a clear note to Alice about what you need.

- **Assume upstream's maintainers are smart.** When they changed code a patch touches, read their pull request to
  learn why, then rebuild the patch on their new design. Don't paste the old patch back over it.
- **Run the dedupe pass.** For each patch in this file, check whether upstream's new commits cover it. Drop a patch
  upstream covers fully, cut one it covers partly down to what upstream still lacks, and keep the rest. Prove each
  with the fork's tests, and name the upstream pull request in the commit and in this file. Ask Alice before
  removing anything upstream doesn't cover.
- **Ask Alice on her Task Priorities board, never only in chat.** Find the fork sync task with
  `node ~/.claude/skills/sync-to-vault/scripts/task-log.mjs find fork sync`, write a short Content decision page
  (the question, the options and your suggested answer), and mark the task `needs` with that page linked.
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
- A `t3` older than v0.1.11, which added `t3 thread start --option`, starts the conflict thread at the model's
  default effort. The sync log says when that happens.
- An account pool remembers a limited account only until the server restarts. Until fresh usage arrives, a
  restarted server may try that account again.
- A pooled Claude account reads earlier turns with `t3_thread_read`, which Claude's read-only mode doesn't
  pre-approve.
- Upstream's fallback model checks the usage of the account a saved default names, not its pool. With a
  fallback model set, a new thread whose default is a pooled account goes to the fallback once that one
  account is out of usage, even while the pool's other accounts have room.

### Codex background continuations

A Codex background command's continuation can be lost if memory cleanup closes its session before the
continuation is queued. `CodexWakeGap.fork.test.ts` records the desired delivery and new run as an expected
failure. The Claude wake patch leaves Codex unchanged.
