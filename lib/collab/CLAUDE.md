# lib/collab — the client reconciler + real-time transport wiring

The browser side of multiplayer editing: one session-scoped **reconciler** that owns confirmed-vs-displayed blueprint state, and the **provider** that gives it a single `EventSource` onto the durable stream. The server side (the guarded writer, the `/stream` relay) lives in `lib/db` + `app/api/apps/[id]/stream`.

## The invariant (the whole design in one line)

```
displayed === fold(confirmedDoc, [...sentPending, humanUncommitted()])
```

`displayed` is the doc the store holds (what the user sees + edits). `confirmedDoc` is the last server-confirmed blueprint at `baseSeq`. `sentPending` is every batch this tab PUT whose own echo hasn't returned. `humanUncommitted` is the local human delta not yet PUT (`diff(localBase(), displayed)`). `localBase()` — the auto-save diff base — is `fold(confirmedDoc, sentPending)`.

**`confirmedDoc` advances ONLY via inbound `mutation` frames** — never on a PUT 200 (advisory; it just records the assigned `seq` on the sent batch so a later reload can drop it). A batch leaves `sentPending` only when its OWN echo frame returns. A solo editor receives its own batches back as echoes and reconciles exactly like a collaborator.

## Echo vs remote — the classification that keeps two tabs honest

A frame is a self-**echo** when `batchId ∈ awaitingEcho`, OR when `actorId === selfUserId && runId != null && runId === selfActiveRunId` (a chat frame from this tab's active run). A `runId`-less frame carrying the same user's `actorId` — a peer TAB's autosave — is **remote**, because one user's two tabs share a single `actorId`; an `actorId`-only match would make one tab's autosave look like a self-echo of the other. An echo advances `confirmedDoc` + drops the batch, no undo rebase (the change is already in `displayed`); a remote frame advances `confirmedDoc`, re-folds `sentPending`, and folds the peer's batch through the undo/redo stacks (`rebaseHistory`) so an undo target still carries the merge.

## Reload reconciliation (gap / retention / migration sentinel / a PUT 409)

Defer until no PUT is un-acked (never GET mid-PUT), GET the fresh blueprint at seq `M`, then drop from `sentPending`/`awaitingEcho` **(a)** every batch with `ackedSeq <= M` (already folded into the fresh doc) **and (b) the specific batchId a 409 rejected** — without (b) the rejected batch (no `ackedSeq`) re-folds + re-sends → 409 → reload, an infinite loop. Re-fold the remaining un-acked batches + `humanUncommitted` onto the reloaded doc, clear undo, resubscribe at `M`. Reseeding is a **suppressed `commitDoc` inside a `beginRemoteApply` bracket, never `store.load()`** — a reload can land while the agent bracket is open (mid-chat-run), and `load()` asserts inside an open bracket.

### Recovery-path invariants (the reload/retry/dispose machine — don't regress these)

The recovery path must survive a failing reload GET, a failing blocking PUT, unmount, and concurrency. Five rules hold it together (each has a `__tests__/reconciler.test.ts` "recovery-path hardening" test that fails without it):

- **One recovery tick drives BOTH re-sends AND a stranded reload.** `runRetry` re-sends failed batches FIRST, then attempts a stranded reload — the re-send bumps `putsInFlight` so the reload defers behind it (never a reload GET mid-PUT). A quiet tab (a gap frame, no local edit) whose reload GET failed has nothing to re-send, so the tick's reload attempt runs immediately — the tab isn't frozen at a stale `baseSeq`.
- **Every PUT resolution runs a deferred reload.** A reload deferred behind an in-flight PUT runs the instant no PUT is in flight — however the blocking PUT resolved (200/409/network/notFound/reauth), not only on a 200. `sendBatch` calls `maybeRunDeferredReload()` on every terminal path.
- **`dispose()` sets `disposed` FIRST.** An in-flight reload/PUT promise resolving after unmount is a no-op (`inert()` guards `resubscribe`/`commitDoc`/reschedule) — otherwise it opens a fresh, untear-downable `EventSource` and writes into a torn-down store.
- **Exactly one reload at a time (`reloadInFlight` coalesces).** A gap/409/retention trigger arriving during an awaited reload GET re-arms `reloadPending` instead of starting a second concurrent reload (which would double-resubscribe and clear `rejectedBatchId` out from under the first, weakening the 409-loop break). The follow-up runs once the current reload completes.
- **`baseSeq` is monotonic; no committed frame is silently discarded.** A frame arriving while `reloadInFlight`/`reloadPending` re-arms `reloadPending` and is NOT applied — applying it would advance `baseSeq` only for the reload's `M` to regress it backward and drop the frame's change. The authoritative reload sets `baseSeq = M`; anything past `M` re-trips the gap check on the resubscribe and a follow-up reload folds it in. Both `runReload` and `onDataDone` carry a `M < baseSeq` monotonic guard, so the `onDataDone`↔reload race (a `data-done` reseeding forward while an older reload GET is in flight) never regresses `baseSeq` from either side.
- **The retry loop never double-sends an in-flight batch** (`putInFlight` excludes a batch whose PUT is still open) AND re-sends failed batches FIRST, THEN attempts a stranded reload — the re-send bumps `putsInFlight` so the reload defers behind it (never a reload GET mid-PUT).

### Every `sentPending` mutation re-folds `displayed` (the structural discipline)

The invariant `displayed === fold(confirmedDoc, [...sentPending, humanUncommitted()])` means ANY structural change to `sentPending` must re-fold `displayed`, or the display keeps a stale value the next autosave re-PUTs (clobbering a peer / inverting commit order). `withRefold(change)` is the primitive: it captures `humanUncommitted` relative to the CURRENT `localBase` (which still includes what `change` mutates), runs the drop, then re-folds `localBase ⊕ human`. Single-batch drops route through it (false-network drop, and any future one). The batched-drop loops (reload / data-done) splice directly and do ONE reseed at the end — that reseed IS the refold. `applyEcho` captures human, advances `confirmedDoc`, drops, then `refoldDisplayed` (it can't use `withRefold` — it advances `confirmedDoc` between capture and refold). `refoldDisplayed` short-circuits when the fold already equals `displayed` (the solo echo hot path owes nothing).

### PUT outcome classification — a fine-grained 4xx taxonomy

The provider's PUT adapter maps each status to a distinct outcome; the guiding rule is **never freeze-and-discard a user's unsaved work on a RECOVERABLE failure**:

- **400 "Invalid mutations"** → `permanent`. The client commit gate PASSED but the server refused — a genuine client↔server gate disagreement (a bug). Re-sending re-hits it forever, and dropping only the rejected batch would SILENTLY lose a dependent later batch (a `B2` editing a field `B1` added no-ops once `B1` is gone). So it is TERMINAL: `sendBatch` FREEZES the reconciler (like revocation — no more PUTs, ignore frames), stops the retry loop, surfaces "these edits couldn't be saved — reload to continue", and reports it. No silent partial application; the whole doomed local stack is discarded only on the user's explicit reload.
- **401** (session lapsed / rotated) → `network` (transient). KEEP the batch and retry — a cookie refresh / re-login makes the retry succeed. Freezing + discarding a user's work because their session lapsed would be data loss.
- **413** (accumulated unsaved delta > the request cap) → `tooLarge`. Retrying the same body won't shrink it, so STOP the retry loop (no 413-storm) and surface it — but do NOT freeze or discard; the batch stays in `sentPending` and a reload is the user's explicit choice.
- **403** → `reauth` (terminal), **404** → `notFound` (retryable + warned), **409** → `conflict` (reload). Any **other 4xx** → `network` (transient/retry), and **5xx** → `network`.

Collapsing a permanent 400 into `network` would wedge the batch (it never acks, never echoes, never gets a 409's `rejectedBatchId`, so nothing drops it and the retry loop re-PUTs it forever); over-broadening `permanent` to 401/413 would discard recoverable work. Only 400 freezes.

**A 200 must carry a real seq.** The route always returns the committed seq on a 200; the adapter NEVER fabricates a mount-time `baseSeq` fallback (a fabricated seq `<= baseSeq` would trip the false-network drop on a genuinely-fresh accepted batch → its real echo mis-classifies as remote → double-apply). A seq-less 200 is treated as a transient failure (retry, re-derive a real seq via `batchDedup`).

**False-network drop.** A `sendBatch` 200 whose `ackedSeq <= baseSeq` means the batch is ALREADY in `confirmedDoc` (a false-network re-send of a batch that actually committed — the idempotent PUT returns the original seq via `batchDedup`, and that batch's echo frame was already dropped as stale by `onFrame`). Drop it there (via `withRefold`, so the display picks up `confirmedDoc`'s value for any slot the dropped batch held a stale local value for — else the next autosave re-PUTs the stale value and clobbers a peer's newer edit) — no future echo will drop it, so it would double-fold forever otherwise.

**409 retry storm.** The retry loop's re-send set EXCLUDES `rejectedBatchId` — a 409'd batch is awaiting the deferred reload that drops it, and re-sending it before then just re-409s in a storm.

### The collaborative undo gate verdicts the SAME delta the reconciler PUTs

`undoRedoGateVerdict(displayed, target, localBase)` verdicts `diff(localBase, rebasedTarget)` against `localBase` — NOT `diff(displayed, target)`. After `temporal.undo()`, `dispatchHumanBatch` PUTs `diff(localBase(), displayed-after-undo) = diff(localBase, rebasedTarget)`; when `sentPending` is non-empty those two deltas differ, so a gate keyed on `displayed` would verdict a batch the reconciler never sends — approving a transition whose real PUT then 409s on an unseen finding (a conflict-reload instead of the clean Elm-message refusal the gate exists for). `localBase()` falls back to the displayed doc with no reconciler (replay).

## Observability (two-channel rule)

A persistent 5xx / network PUT failure and a reload-GET failure route through the `onSaveError` dep → the provider's `reportClientError` (deduped per-app via the message set), so an app-wide save-path outage is visible in Sentry. A 403 reports EXACTLY ONCE — the reconciler's `onReauthDenied` owns it, so `useAutoSave`'s "not writable" warning reports only for a 404 (a duplicate would double-count every revocation).

## Bootstrap (new build) + chat wiring

A brand-new build mounts the reconciler **dormant** (`appId` undefined): no stream, human PUTs disabled, `data-mutations` apply directly to the store. On `data-app-id` the provider `activate`s it — seeds `{ appId, baseSeq: 0, baseDoc: current doc }` and opens the stream at cursor 0. During a chat run the `data-mutations` handler **registers each server-minted `batchId` (+ the run's `runId` + committed `seq`) into `sentPending`/`awaitingEcho` before `applyMany`**, so the batch's own echo is recognized and `useAutoSave` sees an empty `humanUncommitted` delta (no spurious re-PUT of the SA's own edit). `data-done` reseeds `confirmedDoc`/`baseSeq` via `onDataDone` (same suppressed reseed a reload runs); `data-run-id` sets `selfActiveRunId` before any frame can arrive.

## Files

- **`reconciler.ts`** — `createReconciler(docStore, sessionApi, init, deps)`. A **headless state machine**: every side effect (the PUT, the reload GET, the retry scheduler, the stream resubscribe) is an injected `ReconcilerDeps`, so the echo/remote/gap/reload/409/two-tab/bootstrap/data-done paths are driven synchronously in `__tests__/reconciler.test.ts` with no network, no timers, no React. A network/5xx PUT failure keeps the batch in `sentPending` (it's already in `localBase()`, so the diff path won't re-emit it) and re-sends it via a **dedicated retry loop**, idempotent through the P3 `batchDedup` latch.
- **`ReconcilerProvider.tsx`** — owns the SINGLE reconciler + SINGLE `EventSource`, wires the real network deps, re-opens the stream at the reload cursor, and exposes the reconciler + `subscribePresence` (P7 rides the same stream) + `activate` via `context.ts`. Guards `EventSource` presence so a non-browser render (SSR / a jsdom test mounting the builder) mounts the state machine without a live stream.
- **`context.ts`** — `ReconcilerContext` + `useReconcilerContext()` (null in replay, which mounts no reconciler).
- **`presenceTypes.ts`** — the `event: presence` roster frame shape (`PresenceEntry[]`); `ReconcilerProvider` routes each frame through `subscribePresence`, and the presence layer below consumes it.

## Presence (the roster / follow / canvas-marker layer)

The who-else-is-here surface rides the reconciler's single `EventSource` (the `subscribePresence` seam) — no second connection. The decisions live in pure functions so they are a state model (`__tests__/presence.test.ts`, `usePeersAt.test.ts`), not DOM tests; the roster + markers are the Playwright E2E's job.

- **`presence.ts`** — the pure core (`hashColor(userId)` → a stable `PEER_PALETTE` hue, `visiblePeers(frame, selfUserId, now)` = self-dedupe by `userId` across BOTH of a user's sessions + stale-hide + per-user newest-wins, `presenceCanBeat(appId, name, hasStream)`) plus `usePresence`, which mints one per-tab `sessionId`, heartbeats `POST /api/apps/{id}/presence` on a cadence and (debounced) on every `useLocation()` change, `DELETE`s on unmount / `beforeunload`, and subscribes the roster. `canBeat` gates on a resolved app id (a new build's is minted mid-run) AND a resolved display name (no blank-name `POST` a peer would render "?").
- **`PresenceProvider.tsx`** — calls `usePresence` ONCE (one `sessionId` / heartbeat / subscription for the whole builder) and exposes the roster via `usePresenceRoster()`; reads the LIVE app id from the session store (`useAppId`), not the static build page prop, so the creator of a fresh build heartbeats the instant the SA mints the id, with no reload.
- **`usePeersAt.ts`** — pure `peerTarget(location)` (the ONE most-specific blueprint entity per `Location` kind; `home` → none) + `groupPeersByEntity` (roster → `byEntity` markers + the `editingByEntity` "editing this" set), and the `usePeersAt()` hook reading the shared roster. The canvas markers (`components/builder/PeerBadge.tsx`) and the header roster (`PresenceRoster.tsx`) are the only consumers.

## Store coupling (why `lib/doc/store.ts` grew a suppression-depth model)

The reconciler writes to the store through `commitDoc` inside `beginRemoteApply`/`endRemoteApply` — a bracket that keeps the write off the undo stack AND flips `remoteFrameApplyInProgress` for the synchronous window, which `useAutoSave` reads as its FIRST gate (its leading edge fires synchronously from the store subscriber, so a server-applied frame must not bounce back out as a PUT). The store owns tracking through a `suppressionDepth` counter so the agent-write bracket and a remote-apply bracket compose (two suppression sources can't fight over a raw `temporal.resume()`); see the store's own file docs.
