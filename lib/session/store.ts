/**
 * BuilderSession store — ephemeral UI state for the builder.
 *
 * Owns preview mode, sidebar visibility + stash, active field tracking,
 * generation lifecycle, and app identity. Everything here
 * lives only while the builder route is mounted and is NEVER undoable.
 * Separated from BlueprintDoc so UI state can't bleed into undo history
 * and there's no need for a partialize allow-list.
 *
 * Middleware: `subscribeWithSelector` (targeted subscriptions) + `devtools`
 * (Redux DevTools in development). No Immer (shape is flat enough), no undo history
 * (nothing undoable).
 *
 * Actions are reducer-shaped where atomicity matters. `setPreviewing` is
 * the canonical example — it stashes/restores sidebar visibility in a single
 * `set()` call so intermediate states never leak to subscribers.
 *
 * Generation lifecycle actions (`beginRun`, `endRun`, plus the
 * `pushEvents` / `pushEvent` buffer mutators) bracket agent runs and
 * coordinate with the doc store's temporal middleware to pause/resume undo
 * tracking. Stage/error/status-message/postBuildEdit are derived from the
 * events buffer — see `lifecycle.ts`.
 */

import type { VirtualItem } from "@tanstack/react-virtual";
import { devtools, subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import type {
	HeldProvisioningOutcome,
	ProvisionedWorker,
	UnconfirmedWorker,
	WorkerProvisionRefusal,
} from "@/lib/deployment/workerProvisionPlan";
import {
	foldProvisioningOutcome,
	provisioningOutcomeKey,
	retainUnconfirmedWorkers,
} from "@/lib/deployment/workerProvisionPlan";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planConnectTargetState } from "@/lib/doc/connectTargetState";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { notifyRejectedCommit } from "@/lib/doc/mutations/notify";
import { docHasData } from "@/lib/doc/predicates";
import type { BlueprintDocStore } from "@/lib/doc/provider";
import { userFacingErrors } from "@/lib/doc/userFacingErrors";
import type { CommitOutcome, ConnectConfig, ConnectType } from "@/lib/domain";
import type { MediaKind } from "@/lib/domain/multimedia";
import type { Event } from "@/lib/log/types";
import type { ExportBudgetRowView } from "@/lib/media/exportBudget";
import type {
	PreviewCaseTarget,
	PreviewSelectedCase,
	StagedUpload,
} from "./types";

// ── Public types ──────────────────────────────────────────────────────────

/** Which sidebar column to target in `setSidebarOpen`. */
export type SidebarKind = "chat" | "structure";

/** Authorization state for the currently loaded app snapshot. `refreshing`
 *  starts at the instant a scope/access boundary is observed; `reconnecting`
 *  means the authoritative GET has not succeeded yet. Both are deliberately
 *  non-editable while the user's pending mutations remain in the reconciler. */
export type AccessPhase =
	| "authorized"
	| "refreshing"
	| "reconnecting"
	| "upgradeRequired"
	| "revoked";

/** The capability tuple returned atomically with an app blueprint. */
export interface BuilderAccessSnapshot {
	readonly projectId: string | undefined;
	readonly role: string | undefined;
	readonly canEdit: boolean;
}

/** Saved edit-canvas scroll state for one form. The edit canvas
 *  (`VirtualFormList`) is destroyed on every preview↔edit flip and on form
 *  navigation; this is what the next mount replays to land back in the exact
 *  same place. The `measurements` snapshot — the virtualizer's measured row
 *  heights — is the load-bearing half: replayed as `initialMeasurementsCache`,
 *  it makes the restore pixel-exact (without it, the fresh list re-measures
 *  from estimates and the content drifts ~half a row). TanStack's documented
 *  scroll-restoration API. */
export interface EditScrollMemory {
	/** Virtualizer scroll offset in px (`virtualizer.scrollOffset`). */
	offset: number;
	/** Snapshot of measured row sizes (`virtualizer.measurementsCache`). */
	measurements: VirtualItem[];
}

/**
 * Full state + actions for the BuilderSession store.
 *
 * Fields grouped by concern:
 *   - Generation lifecycle (`events`, `runCompletedAt`, `loading`) —
 *     run boundaries + the canonical event stream. The buffer holds
 *     events for the *currently active run only* (cleared at both run
 *     ends), so `events.length > 0` is the canonical "a run is in
 *     progress" signal — no mirror flag can drift. Stage, status
 *     message, error, validation-attempt, postBuildEdit, even the
 *     derived phase are computed from `events` via
 *     `lib/session/lifecycle.ts`.
 *   - App identity (`appId`) — current app being built/edited.
 *   - Interaction (`previewing`, `activeFieldId`) — how the user is editing.
 *   - Chrome (`sidebars`) — layout visibility + stash for mode transitions.
 *   - Connect stash — learn↔deliver toggle preservation.
 */
export interface BuilderSessionState {
	// ── Generation lifecycle ─────────────────────────────────────────────

	/** In-memory event-log buffer. Holds events for the *currently active
	 *  run only* — cleared at both `beginRun()` (opening a new run) and
	 *  `endRun()` (closing it). An empty buffer means no run is in
	 *  progress; a non-empty buffer means the SSE stream is open. Appended
	 *  by the stream dispatcher as `data-mutations` +
	 *  `data-conversation-event` envelopes arrive.
	 *
	 *  Every lifecycle derivation (phase, stage, error, status message,
	 *  validation attempt, postBuildEdit) reads from this buffer — see
	 *  `lib/session/lifecycle.ts`. There's no shadow `agentActive` flag;
	 *  `events.length > 0` is the canonical "a run is happening" signal,
	 *  and it can't drift because both run-boundary writes are atomic
	 *  state updates in `beginRun`/`endRun`. */
	events: Event[];

	/** Whether the page doc already had data when the current run OPENED —
	 *  captured once in `beginRun()`. The build-vs-edit discriminator for
	 *  lifecycle derivations: `/build/new` begins its run before the server's
	 *  canonical genesis receipt is activated, so `false` means initial build
	 *  (structural stages drive the Generating layout); `true` means a
	 *  post-build edit (the builder stays interactive while the agent works).
	 *  Stays `false` outside a run. */
	runStartedWithData: boolean;

	/** Timestamp of the most recent whole-build completion — stamped by
	 *  the dispatcher's `data-done` handler (the server-side marker from
	 *  the route's drain-end finalize). Cleared on `acknowledgeCompletion()` (after the
	 *  celebration animation) and on `beginRun()` (new run starts clean).
	 *  askQuestions / clarifying-text / edit-tool runs never stamp — they
	 *  close silently. Drives the Completed phase. */
	runCompletedAt: number | undefined;

	/** This session's app has a BUILD that never completed. Seeded true when
	 *  the page loads a `generating` app or an interrupted build admitted for
	 *  re-drive; latched true when this tab's materialization handoff
	 *  lands; released by `markBuildFinished()` from two channels: this tab's
	 *  own stream `onData` (`data-done`, or the doc-less `data-build-complete`
	 *  a conversational build turn emits instead), and the reconciler's
	 *  `app-status` SSE frame when the server observes `complete` — the path
	 *  for tabs never attached to the run's stream (a second tab, a co-member
	 *  watching a teammate's build; the frame's `generating`/`error` arms
	 *  re-latch, mirroring the server's only-`complete`-is-edit rule).
	 *  App-level, not run-level, on purpose: it survives stream closes and
	 *  the events-buffer clear, which the phase derivation cannot (an
	 *  askQuestions pause clears the buffer while the committed modules make
	 *  the doc read Ready). `deriveChatAppReady` keys on it so a mid-build
	 *  tab's sends and its cost chip both read as build-mode. */
	buildUnfinished: boolean;

	/** This session OBSERVED the app's build reach `complete` (any
	 *  `markBuildFinished` channel). One-way enforcement for the latch above:
	 *  once set, `markBuildUnfinished` no-ops, because `complete` is terminal
	 *  in the app lifecycle (no path flips a complete app back to
	 *  `generating`/`error`), so any later arming signal is by definition
	 *  stale, e.g. an in-flight `app-status: generating` frame the stream
	 *  route read milliseconds before the completing run committed, delivered
	 *  after this tab's own `data-done` already released the latch. Without
	 *  the guard that frame re-prices a finished app's sends as builds for up
	 *  to one reauth cadence. Never reset: app truth, like the latch. */
	buildCompleted: boolean;

	/** Generic loading flag for async operations outside of agent writes
	 *  (e.g. initial app load, import). */
	loading: boolean;

	// ── App identity ─────────────────────────────────────────────────────

	/** App id for the current builder session. Set
	 *  once when the builder mounts; undefined for new builds before
	 *  the app row is created. */
	appId: string | undefined;

	/** Project + role + edit capability from the latest authoritative GET.
	 *  They update together through `applyAccessSnapshot`; no component owns a
	 *  second capability copy. New builds are pre-seeded from the active Project's
	 *  server-resolved role while `appId` remains absent until creation. */
	projectId: string | undefined;
	role: string | undefined;
	/** Project membership capability before the initial-build authoring lock.
	 * Chat uses this while `canEdit` remains false until the first complete
	 * build is explicitly finished or accepted. */
	projectCanEdit: boolean;
	canEdit: boolean;
	/** Whether the tuple is authoritative, being refreshed, waiting on a
	 *  retryable GET, or confirmed lost. */
	accessPhase: AccessPhase;
	/** Monotonic generation for Project-scoped client state. Incremented once
	 *  when an access refresh begins; reset subscribers clear before GET. */
	scopeEpoch: number;
	/** Local work preserved across a downgrade and waiting for edit capability.
	 *  This is presentation state derived by the reconciler at snapshot install,
	 *  not a second copy of the mutation batches themselves. */
	hasWaitingAccessChanges: boolean;

	// ── Interaction ──────────────────────────────────────────────────────

	/** Whether the builder is in preview mode — the canvas runs live (form
	 *  fill, case search, navigation) instead of click-to-select editing. */
	previewing: boolean;

	/** Which `[data-field-id]` element currently has focus. Transient UI hint,
	 *  not undoable. Used by composite undo/redo to restore focus after the
	 *  temporal state rolls back. */
	activeFieldId: string | undefined;

	/** In a running-app preview, the case-loading form the case list feeds
	 *  and the case the user selected for it — preview's stand-in for the
	 *  navigation-stack case datum. Set by the module menu (which form) and
	 *  the case list's Continue (which case); read by PreviewShell to preload
	 *  the form. Cleared on every preview-mode toggle (see `setPreviewing`)
	 *  so previewing a form fresh never reloads a stale case. */
	previewCaseTarget: PreviewCaseTarget | undefined;

	/** The case currently open in the running-app case list's detail/confirm
	 *  (the row clicked, before continuing). Mirrors the case list's local
	 *  selection so the breadcrumb can name it on the list. Cleared with the
	 *  selection and on every preview toggle. */
	previewSelectedCase: PreviewSelectedCase | undefined;

	/** Which persona Preview runs as, by uuid — `undefined` means the
	 *  signed-in member ("Preview as me"). Ephemeral like every other
	 *  preview field: a persona is a design actor, so which one you are
	 *  trying is a property of the running Preview session, not of the app.
	 *  Leaving Preview clears it before edit-mode case tools return, so a
	 *  hidden running identity can never influence authoring data surfaces. */
	previewPersonaUuid: string | undefined;

	// ── Chrome ───────────────────────────────────────────────────────────

	/** Sidebar visibility with stash support for preview transitions.
	 *  `stashed` records the pre-preview `open` value; `undefined` means
	 *  nothing is stashed. `setPreviewing` writes both fields atomically. */
	sidebars: {
		chat: { open: boolean; stashed: boolean | undefined };
		structure: { open: boolean; stashed: boolean | undefined };
	};

	// ── Connect stash (ephemeral, not undoable) ──────────────────────────

	/** Preserved form connect configs for the INACTIVE mode(s). Keyed by
	 *  connect type -> form uuid -> config. Written when a mode is switched
	 *  away from (or Connect disabled) so the work survives; the Connect
	 *  manager reads it to seed the inactive mode's drafts. Uses uuid instead
	 *  of moduleIndex/formIndex so renames and reorders don't invalidate the
	 *  stash. */
	connectStash: Record<
		ConnectType,
		Record<string /* formUuid */, ConnectConfig>
	>;

	/** Last active connect type — the mode the manager defaults its selector
	 *  to when Connect is currently off. Every `switchConnectMode` document
	 *  command still states its target mode exactly. */
	lastConnectType: ConnectType | undefined;

	// ── Staged media uploads (ephemeral, never doc state) ────────────────

	/** In-flight (or failed) slot uploads, keyed by carrier slot. The doc
	 *  must never reference an asset that isn't `ready`, so a picked file
	 *  lives HERE — progress, cancel, failure — until its upload confirms;
	 *  only then does the slot dispatch the normal gated attach. Keys are
	 *  carrier-slot identities (e.g. `field:<uuid>:label_media/image`,
	 *  `app:logo`) so a remounted slot re-renders its staged chip from the
	 *  store. The abort handles live OUTSIDE this state (a per-store
	 *  closure registry, like `_setDocStore`'s ref) so devtools never
	 *  serializes a function and cancel works from any mount. */
	stagedUploads: Record<string, StagedUpload>;

	/** Stage one slot upload: record `{ uploading, progress: 0 }` under
	 *  `slotKey` and register its `abort` in the closure registry.
	 *  Replaces any previous record on the same slot (a retry re-stages). */
	stageUpload: (
		slotKey: string,
		upload: { filename: string; kind: MediaKind; abort: () => void },
	) => void;

	/** Advance a staged upload's byte progress (clamped 0..1). No-op when
	 *  the slot isn't staged or already failed — a late progress event
	 *  from an aborted transfer must not resurrect the record. */
	setStagedUploadProgress: (slotKey: string, progress: number) => void;

	/** Flip a staged upload to its error state (the chip shows `message`
	 *  until dismissed or retried) and drop the abort handle — nothing is
	 *  in flight anymore. No-op when the slot isn't staged (a cancel that
	 *  raced the failure wins). */
	failStagedUpload: (slotKey: string, message: string) => void;

	/** Remove a staged record (upload confirmed and the attach dispatched,
	 *  or the user dismissed an error). Drops the abort handle. */
	clearStagedUpload: (slotKey: string) => void;

	/** Mobile-worker passwords for accounts CommCare HQ neither confirmed
	 *  nor ruled out, keyed by `<personaUuid>:<completeUsername>`.
	 *
	 *  It lives HERE rather than in the Publish dialog because of what the
	 *  refusal that produces one asks a person to do: go and look for that
	 *  username on their project space. Doing that means closing the
	 *  dialog, which unmounts its whole subtree — so dialog-local state
	 *  would be destroyed by the very action Nova just told them to take,
	 *  and CommCare HQ stores the password hashed, so it is gone for good.
	 *
	 *  It is transient like everything else in this store: nothing writes
	 *  it to Postgres, to a log, or to storage, and a page load clears it.
	 *  That is the deliberate ceiling — a credential Nova cannot show
	 *  twice must not be one Nova keeps. */
	unconfirmedWorkers: Record<string, UnconfirmedWorker>;

	/** Each target's held provisioning outcome — the confirmed accounts a
	 *  call made (their passwords included) and the latest call's refusal —
	 *  keyed by `provisioningOutcomeKey(server, domain)`.
	 *
	 *  Here for the same reason `unconfirmedWorkers` is: the Workers panel
	 *  unmounts on an ordinary App setup section switch, and a new
	 *  account's password exists nowhere but on screen. Same transient
	 *  ceiling too — nothing persists it, and a page load clears it. */
	provisioningOutcomes: Record<string, HeldProvisioningOutcome>;

	/** Fold one provisioning answer into the held credentials and the
	 *  target's held outcome. `retainUnconfirmedWorkers` and
	 *  `foldProvisioningOutcome` own the rules; this is the store seam. */
	recordProvisioningOutcome: (answer: {
		readonly server: string;
		readonly domain: string;
		readonly workers: readonly ProvisionedWorker[];
		readonly unconfirmed?: readonly UnconfirmedWorker[];
		readonly refusal: WorkerProvisionRefusal | null;
	}) => void;

	/** Forget one held credential, once a person says they have it. The
	 *  only way one leaves short of a page load. */
	dismissUnconfirmedWorker: (key: string) => void;

	/** Bumped whenever a surface writes a deployment record — a publish
	 *  that landed or was refused with a record, or a Check status answer
	 *  folded in the Publish dialog. The Publishing section reloads on it,
	 *  so a publish made in the dialog reaches the section's held records
	 *  without waiting for a remount. */
	deploymentRecordsRevision: number;

	/** Say a deployment record changed. Called by every dialog upsert. */
	noteDeploymentRecordsChanged: () => void;

	/** A one-shot request to open the Publish dialog aimed at a project
	 *  space. Written by the App setup Publishing section's "Publish again"
	 *  and read by PublishPanel, which owns the dialog: the two live in
	 *  different render trees (the panel is portaled into the header band),
	 *  so the request rides the session store rather than a prop chain.
	 *  Consumed once — the panel clears it as it opens — so a later manual
	 *  open never inherits a stale target. */
	publishDialogRequest: { readonly domain: string } | null;

	/** Ask PublishPanel to open the Publish dialog preseeded to `domain`.
	 *  A second request before the first is consumed replaces it — the
	 *  latest click names the target the person means. */
	requestPublishDialog: (request: { readonly domain: string }) => void;

	/** Consume (or abandon) the pending open request. */
	clearPublishDialogRequest: () => void;

	/** Cancel a staged upload: abort the in-flight transfer (if any) and
	 *  remove the record. The upload driver sees the abort and stays
	 *  silent — cancel already cleared the slot. */
	cancelStagedUpload: (slotKey: string) => void;

	/** Budget-relevant asset metadata observed this session — every
	 *  library page the builder's pickers load, every upload confirm, and
	 *  every row the attach budget check fetches lands here, keyed by
	 *  asset id. The browser's pre-dispatch export-ceiling check
	 *  (`components/builder/media/useAttachBudget.ts`) resolves the doc's
	 *  referenced ids against this registry and fetches only the gaps.
	 *  Advisory data by design: the export boundary re-loads fresh rows
	 *  server-side, so a stale entry here can only mis-tune the courtesy
	 *  check, never the enforcement. */
	assetMeta: Record<string, ExportBudgetRowView>;

	/** Merge observed asset rows into the registry. Idempotent — a batch
	 *  that changes nothing writes nothing (no subscriber churn from
	 *  re-fetched pages). */
	recordAssetMeta: (
		assets: readonly ({ id: string } & ExportBudgetRowView)[],
	) => void;

	/** Clear every transient value whose authority follows the app's current
	 *  Project. Runs synchronously at the access boundary, before the
	 *  authoritative app reload: staged transfers are aborted, their records
	 *  and observed media rows are forgotten, and preview's selected case/form
	 *  identity is dropped. Authoring state and chat drafts deliberately live
	 *  outside this reset. Throws only after all aborts have been attempted and
	 *  the serializable state has been cleared. */
	resetProjectScope: () => void;

	// ── Transient UI hints (one-shot, consumed by a single component) ────

	/** Transient field key to focus after undo/redo. Set by `useUndoRedo`;
	 *  read by whichever editor owns the matching data-field-id (each
	 *  editor ignores non-matching values, so siblings see their own hints
	 *  on the same render). Scoped to the field selected when undo ran:
	 *  `useSelect` clears it on any selection change so a stale hint can't
	 *  auto-focus an editor on a later-selected field. */
	focusHint: string | undefined;

	/** UUID of a just-added field — activates auto-focus and select-all
	 *  on the ID input in FieldIdentitySection. One-shot: set by FieldTypePicker on
	 *  add, consumed once by the header on mount. */
	newFieldUuid: string | undefined;

	/** Saved edit-canvas scroll state per form uuid (offset + measured-row
	 *  snapshot). The edit canvas is a virtualized list (`VirtualFormList`)
	 *  that is destroyed on every preview↔edit flip and on form navigation; the
	 *  list saves this on unmount and replays it on the next mount via the
	 *  virtualizer's `initialOffset` + `initialMeasurementsCache` so the same
	 *  pixel position is restored exactly — which is what stops preview→edit
	 *  from snapping to the top. Keyed by form so each restores its own place.
	 *  Per-session and never persisted. */
	editScrollByForm: Record<string, EditScrollMemory>;

	/** The page (section uuid) each sectioned form is open on, keyed by
	 *  form uuid. Written by the preview pager as the worker moves between
	 *  pages and by the edit canvas on unmount (the page its first visible
	 *  row belonged to), read by whichever mode mounts next so a flip keeps
	 *  the same page on screen. Ephemeral: a form that was never paged has
	 *  no entry, and the entry is dropped when the form screen is left. */
	activeSectionByForm: Record<string, string>;

	// ── Actions ───────────────────────────────────────────────────────────

	/** Install or clear the doc store reference. Called by SyncBridge when
	 *  the BlueprintDocProvider mounts/unmounts. */
	_setDocStore: (store: BlueprintDocStore | null) => void;

	// ── Generation lifecycle actions ─────────────────────────────────────

	/** Open a new run. Clears the events buffer + `runCompletedAt` stamp
	 *  and pauses doc undo tracking (the whole run collapses into a
	 *  single undoable unit on resume). The non-empty buffer that
	 *  accumulates from this point until `endRun()` is the "a run is in
	 *  progress" signal for all lifecycle derivations. Called by
	 *  ChatContainer's chat-transport status effect on the
	 *  ready→submitted/streaming transition.
	 *
	 *  `startedWithData` overrides the build-vs-edit capture for a
	 *  RECONNECT to an in-flight BUILD run: the doc already carries the
	 *  build's committed modules at page load, so the default "does the
	 *  doc have data?" capture would misread the resumed build as an
	 *  edit (wrong phase chrome, and — via the client's `appReady`
	 *  derivation — generation tools stripped from follow-up sends). */
	beginRun: (opts?: { startedWithData?: boolean }) => void;

	/** Close a run. Clears the events buffer and resumes doc undo
	 *  tracking. Does NOT touch `runCompletedAt` — stream-close is not
	 *  the completion signal. A run that was just a chat turn
	 *  (askQuestions, clarifying text, edit-tool response) closes
	 *  silently because `runCompletedAt` was never stamped. Called on
	 *  the active→ready transition. */
	endRun: () => void;

	/** Stamp `runCompletedAt` = now. Called by the stream dispatcher
	 *  when `data-done` arrives — the server-side "whole build
	 *  succeeded" marker from the route's drain-end finalize. Drives the Completed phase
	 *  + celebration animation until `acknowledgeCompletion()` clears
	 *  it. */
	markRunCompleted: () => void;

	/** Clear `runCompletedAt` after the celebration animation has played,
	 *  moving the derived phase from Completed → Ready. No-ops when
	 *  already cleared. */
	acknowledgeCompletion: () => void;

	/** Latch `buildUnfinished` from two channels: a `/build/new` tab's
	 *  app-creation handoff (this tab now owns a build in progress), and the
	 *  reconciler's `app-status` SSE frame reporting `generating`/`error`
	 *  (the arm for a tab whose page seed missed it, e.g. an `error` app
	 *  loaded before the frame channel existed for it). No-ops when set, and
	 *  no-ops FOREVER once `buildCompleted` is set: a finished build cannot
	 *  re-arm, so a stale frame delivered after the release is ignored. */
	markBuildUnfinished: () => void;

	/** Release `buildUnfinished` and latch `buildCompleted` — the build run
	 *  completed. Three channels: `ChatContainer`'s stream `onData` on
	 *  `data-done` or `data-build-complete`, and the reconciler's
	 *  `app-status` SSE frame reporting `complete` (the release for tabs
	 *  never attached to the run's own chat stream). */
	markBuildFinished: () => void;

	/** Set the app ID for this builder session. No-ops when unchanged. */
	setAppId: (id: string) => void;

	/** Promote a dormant new-build session using the server's complete creation
	 * handoff. App identity and Project capability move together so no observer
	 * can see the new app under the Project tuple seeded by another request. */
	activateCreatedApp: (id: string, snapshot: BuilderAccessSnapshot) => void;

	/** Pause writes and begin one serialized authoritative access refresh.
	 *  Returns the current scope epoch; repeated calls while already refreshing
	 *  or reconnecting coalesce without incrementing it again. */
	beginAccessRefresh: () => number;

	/** Record a retryable reload failure without reopening the edit path. */
	markAccessReconnecting: () => void;

	/** Atomically install the tuple returned with the reloaded blueprint. */
	applyAccessSnapshot: (
		snapshot: BuilderAccessSnapshot,
		options?: { hasWaitingChanges?: boolean },
	) => void;

	/** Confirm that the authoritative view capability is gone. */
	revokeAccess: () => void;

	/** Freeze behind an explicit refresh action after the automatic one-shot
	 *  receiver upgrade was already attempted in this browser session. */
	requireClientUpgrade: () => void;

	/** Set the generic loading flag. No-ops when unchanged. */
	setLoading: (loading: boolean) => void;

	/** Append events to the buffer. Used by the stream dispatcher's
	 *  `data-mutations` and `data-conversation-event` handlers. No-ops on
	 *  empty arrays — identity preserved so memoized subscribers don't
	 *  needlessly fire. */
	pushEvents: (events: Event[]) => void;

	/** Append a single event. Convenience wrapper over `pushEvents`. */
	pushEvent: (event: Event) => void;

	// ── Connect stash actions ────────────────────────────────────────────

	/** Apply an app-level Connect configuration — ONE gated batch:
	 *  `setConnectType` (when the mode changes) plus the per-form connect
	 *  blocks needed to reach the requested state.
	 *
	 *  Passing a mode (`'learn'` or `'deliver'`) sets that mode and makes
	 *  `desiredBlocks` the AUTHORITATIVE complete set of participating forms:
	 *  a form present in the map participates with that config; a form absent
	 *  has any existing block cleared and stays auxiliary. The store does NOT
	 *  consult the stash to restore blocks — the Connect manager seeds its
	 *  drafts from the live doc (current mode) and the stash (the other mode)
	 *  and hands over the whole truth, so an edited block is never overwritten
	 *  by a stale stash entry. Every incoming block is already a complete
	 *  final `ConnectConfig`; app-wide identity conflicts are rejected by the
	 *  same atomic admission gate as every other invalid batch. Switching AWAY from a
	 *  non-null mode stashes that mode's live blocks first (the manager reads
	 *  the stash to repopulate the inactive mode later).
	 *
	 *  Passing `null` disables Connect entirely (always valid — standard apps
	 *  need no blocks; the outgoing mode is stashed so re-enabling restores
	 *  the work). A non-null call must state the exact mode and complete
	 *  participant set; the session never infers a document command from its
	 *  UI-only `lastConnectType`.
	 *
	 *  The whole batch runs the shared commit verdict before anything
	 *  dispatches — a state that would leave the app with NO participating
	 *  form is rejected (findings returned in the outcome) and the doc +
	 *  stash stay untouched. An apply that leaves the doc unchanged commits
	 *  nothing. A pass commits as one undo entry. A rejection announces via
	 *  the error toast unless the caller opts out with `announce: false`
	 *  because it presents the outcome itself (the manager's footer) — one
	 *  rejection, one presentation. */
	switchConnectMode: (
		type: ConnectType | null,
		desiredBlocks?: Record<string, ConnectConfig>,
		opts?: { announce?: boolean },
	) => CommitOutcome;

	/** Get a single form's stashed connect config (does not remove it). */
	getFormConnectStash: (
		mode: ConnectType,
		formUuid: string,
	) => ConnectConfig | undefined;

	// ── Preview + sidebar actions ────────────────────────────────────────

	/** Atomically enter/leave preview mode with sidebar stash/restore.
	 *
	 *  - Entering: stash current `open` values, then close both sidebars —
	 *    preview is the app full-bleed, no builder chrome beside it.
	 *  - Leaving (with stash): restore stashed values, clear stash.
	 *  - Leaving (no stash): update the flag only, no sidebar change.
	 *  - Same value: no-op (guards against double-entry that would overwrite
	 *    the stash with `{ stashed: false }` values). */
	setPreviewing: (on: boolean) => void;
	/** Choose which persona Preview runs as. `undefined` = the signed-in
	 *  member. Changing identity mid-session drops the case target: the
	 *  case one worker picked is not the case the next one is looking at. */
	setPreviewPersonaUuid: (personaUuid: string | undefined) => void;

	/** Update which field has focus. No-ops when the value is unchanged to
	 *  avoid unnecessary subscriber notifications. */
	setActiveFieldId: (fieldId: string | undefined) => void;

	/** Set (or clear) the preview case target — the case-loading form the
	 *  case list feeds and the selected case. No-ops when shallow-equal so
	 *  repeated sets don't notify subscribers. */
	setPreviewCaseTarget: (target: PreviewCaseTarget | undefined) => void;

	/** Set (or clear) the case open in the running-app case list. No-ops when
	 *  shallow-equal. */
	setPreviewSelectedCase: (selected: PreviewSelectedCase | undefined) => void;

	/** Set one sidebar's visibility. Preserves the other sidebar + all stash
	 *  values. No-ops when the value is unchanged. */
	setSidebarOpen: (kind: SidebarKind, open: boolean) => void;

	// ── UI hint actions ──────────────────────────────────────────────────

	/** Set the transient focus hint — used by undo/redo to tell the
	 *  field inspector which property's editor to focus after the
	 *  doc-store restoration commits. */
	setFocusHint: (fieldId: string | undefined) => void;

	/** Clear the focus hint. Call sites are responsible for deciding
	 *  when the hint has served its purpose — e.g. a new undo cycle
	 *  overwrites via `setFocusHint`, or the hint is invalidated by a
	 *  route change. Editor components do NOT clear the hint on read;
	 *  they simply ignore non-matching values so sibling editors can
	 *  still see their own hints on the same render. */
	clearFocusHint: () => void;

	/** Mark a field uuid as newly added — triggers auto-focus and
	 *  select-all on the ID input in FieldIdentitySection. */
	markNewField: (uuid: string) => void;

	/** Check whether a uuid matches the current new-field marker.
	 *  Imperative reader — usable outside of selectors. */
	isNewField: (uuid: string) => boolean;

	/** Clear the new-field marker. Called after the first rename or
	 *  when the component unmounts, so subsequent selections behave normally. */
	clearNewField: () => void;

	/** Remember the edit-canvas scroll state for a form. Called by
	 *  `VirtualFormList` on unmount with the virtualizer's offset + snapshot. */
	setEditScroll: (formUuid: string, memory: EditScrollMemory) => void;

	/** Read the remembered edit-canvas scroll state for a form (or
	 *  `undefined`). Imperative reader — `VirtualFormList` calls it at
	 *  virtualizer-creation time to seed `initialOffset` +
	 *  `initialMeasurementsCache`, so it must NOT drive a re-render (no
	 *  selector subscription). */
	getEditScroll: (formUuid: string) => EditScrollMemory | undefined;

	/** Remember which page a sectioned form is open on. `undefined` clears
	 *  the entry (the form screen was left, or the form lost its pages). */
	setActiveSection: (formUuid: string, sectionUuid: string | undefined) => void;

	/** Imperative reader for the remembered page (no subscription), for the
	 *  edit canvas's one-time `initialOffset` computation. The preview
	 *  pager subscribes through `useActiveSection` instead. */
	getActiveSection: (formUuid: string) => string | undefined;

	/** Reset all transient session state to the initial values — generation
	 *  lifecycle, preview mode, sidebars, connect stash, and one-shot UI
	 *  hints. The private doc-store reference installed by SyncBridge is NOT
	 *  cleared — the provider's effect owns its lifetime. */
	reset: () => void;
}

// ── Store API type ────────────────────────────────────────────────────────

/** The Zustand store API — used for context typing and test setup. */
export type BuilderSessionStoreApi = ReturnType<
	typeof createBuilderSessionStore
>;

// ── Factory ───────────────────────────────────────────────────────────────

/** Optional initialization parameters for the session store. Allows the
 *  provider stack to pre-seed lifecycle state that must be correct on the
 *  FIRST render (e.g. `loading=true` for existing apps so `derivePhase`
 *  returns `Loading` before any effect runs). */
export interface SessionStoreInit {
	/** Start in loading state — used when hydrating an existing app so the
	 *  builder shows the loading skeleton immediately rather than flashing
	 *  the idle/chat state. */
	loading?: boolean;
	/** Seed the unfinished-build latch — true when the page loaded a
	 *  `generating` app or an interrupted build admitted for re-drive, so the
	 *  first send already reads as build-mode. */
	buildUnfinished?: boolean;
	/** Pre-set the app id. */
	appId?: string;
	/** Pre-set the atomic access tuple from the server-rendered app snapshot. */
	projectId?: string;
	role?: string;
	canEdit?: boolean;
}

/** Create a scoped Zustand session store. Called once per BuilderProvider
 *  mount — the parent provider's `buildId` controls the store lifetime.
 *
 *  @param init — optional initial overrides for lifecycle fields that must
 *  be correct before the first render (see `SessionStoreInit`). */
export function createBuilderSessionStore(init?: SessionStoreInit) {
	const initialAccess: BuilderAccessSnapshot = {
		projectId: init?.projectId,
		role: init?.role,
		canEdit: init?.canEdit ?? true,
	};
	/* Non-reactive ref — lives outside Zustand state so it doesn't serialize
	 * to devtools and doesn't fire subscribers on install/clear. Read
	 * imperatively by `switchConnectMode`, `beginRun`, and `endRun`. */
	let docStoreRef: BlueprintDocStore | null = null;

	/* Abort handles for staged uploads — functions, so they live beside the
	 * store (the `docStoreRef` pattern) rather than inside serializable
	 * state. Keyed identically to `stagedUploads`; every record mutation
	 * below keeps the two in step. */
	const stagedUploadAborts = new Map<string, () => void>();

	return createStore<BuilderSessionState>()(
		devtools(
			subscribeWithSelector((set, get) => ({
				// ── Initial state ────────────────────────────────────────

				/* Generation lifecycle */
				events: [] as Event[],
				runStartedWithData: false,
				runCompletedAt: undefined as number | undefined,
				buildUnfinished: init?.buildUnfinished ?? false,
				buildCompleted: false,
				loading: init?.loading ?? false,

				/* App identity */
				appId: init?.appId as string | undefined,
				projectId: initialAccess.projectId,
				role: initialAccess.role,
				projectCanEdit: initialAccess.canEdit,
				canEdit: initialAccess.canEdit && !(init?.buildUnfinished ?? false),
				accessPhase: "authorized" as AccessPhase,
				scopeEpoch: 0,
				hasWaitingAccessChanges: false,

				/* Interaction */
				previewing: false,
				activeFieldId: undefined,
				previewCaseTarget: undefined as PreviewCaseTarget | undefined,
				previewSelectedCase: undefined as PreviewSelectedCase | undefined,
				previewPersonaUuid: undefined as string | undefined,

				/* Chrome */
				sidebars: {
					chat: { open: true, stashed: undefined },
					structure: { open: true, stashed: undefined },
				},

				/* Connect stash */
				connectStash: { learn: {}, deliver: {} } as Record<
					ConnectType,
					Record<string, ConnectConfig>
				>,
				lastConnectType: undefined as ConnectType | undefined,

				/* Staged media uploads */
				stagedUploads: {} as Record<string, StagedUpload>,
				unconfirmedWorkers: {} as Record<string, UnconfirmedWorker>,
				provisioningOutcomes: {} as Record<string, HeldProvisioningOutcome>,
				assetMeta: {} as Record<string, ExportBudgetRowView>,
				publishDialogRequest: null as { readonly domain: string } | null,
				deploymentRecordsRevision: 0,

				/* UI hints */
				focusHint: undefined as string | undefined,
				newFieldUuid: undefined as string | undefined,
				editScrollByForm: {} as Record<string, EditScrollMemory>,
				activeSectionByForm: {} as Record<string, string>,

				// ── Reducer-shaped actions ───────────────────────────────

				_setDocStore(store: BlueprintDocStore | null) {
					docStoreRef = store;
				},

				// ── Generation lifecycle actions ─────────────────────────

				beginRun(opts) {
					/* Open a run atomically: pause doc undo (whole run
					 * collapses into one undoable unit on resume), clear the
					 * events buffer, clear any stale completion stamp, and
					 * capture the build-vs-edit discriminator (whether the doc
					 * already has data) for the lifecycle derivations — unless
					 * the caller overrides it (a reconnect to an in-flight
					 * build, whose committed modules would otherwise read as
					 * pre-existing data). The non-empty buffer that
					 * accumulates from here is the "a run is in progress"
					 * signal — no agentActive mirror to maintain. */
					const docState = docStoreRef?.getState();
					docState?.beginAgentWrite();
					set({
						events: [],
						runCompletedAt: undefined,
						runStartedWithData:
							opts?.startedWithData ??
							(docState ? docHasData(docState) : false),
					});
				},

				endRun() {
					/* Close a run atomically: resume doc undo and clear the
					 * events buffer. The empty buffer after this point means
					 * no run is in progress — same signal, no drift possible.
					 * `runCompletedAt` is intentionally NOT touched — the
					 * dispatcher's `data-done` handler already stamped it
					 * (for full builds), and askQuestions / clarifying-text /
					 * edit-tool runs close silently because the stamp was
					 * never set. */
					docStoreRef?.getState().endAgentWrite();
					set({ events: [] });
				},

				markRunCompleted() {
					/* `data-done` arrived — the build run finished, the
					 * whole build is complete. Stamp the celebration. Phase
					 * transitions to Completed and stays there until
					 * `acknowledgeCompletion()` fires (3.5s after the
					 * animation begins). */
					set({ runCompletedAt: Date.now() });
				},

				acknowledgeCompletion() {
					if (get().runCompletedAt === undefined) return;
					set({ runCompletedAt: undefined });
				},

				markBuildUnfinished() {
					const s = get();
					/* One-way per build: `complete` is terminal in the app
					 * lifecycle, so an arming signal after an observed completion
					 * is a stale frame, never fresh truth. */
					if (s.buildCompleted || s.buildUnfinished) return;
					set({ buildUnfinished: true, canEdit: false });
				},

				markBuildFinished() {
					const s = get();
					if (s.buildCompleted && !s.buildUnfinished) return;
					set({
						buildUnfinished: false,
						buildCompleted: true,
						canEdit: s.projectCanEdit,
					});
				},

				pushEvents(events: Event[]) {
					if (events.length === 0) return;
					set((s) => ({ events: [...s.events, ...events] }));
				},

				pushEvent(event: Event) {
					set((s) => ({ events: [...s.events, event] }));
				},

				setAppId(id: string) {
					if (id === get().appId) return;
					set({ appId: id });
				},

				activateCreatedApp(id: string, snapshot: BuilderAccessSnapshot) {
					set({
						appId: id,
						projectId: snapshot.projectId,
						role: snapshot.role,
						projectCanEdit: snapshot.canEdit,
						canEdit: snapshot.canEdit && !get().buildUnfinished,
						accessPhase: "authorized",
						hasWaitingAccessChanges: false,
					});
				},

				beginAccessRefresh() {
					const state = get();
					if (
						state.accessPhase === "refreshing" ||
						state.accessPhase === "reconnecting" ||
						state.accessPhase === "upgradeRequired" ||
						state.accessPhase === "revoked"
					) {
						return state.scopeEpoch;
					}
					const scopeEpoch = state.scopeEpoch + 1;
					set({
						projectCanEdit: false,
						canEdit: false,
						accessPhase: "refreshing",
						scopeEpoch,
					});
					return scopeEpoch;
				},

				markAccessReconnecting() {
					const state = get();
					if (
						state.accessPhase === "revoked" ||
						state.accessPhase === "upgradeRequired"
					)
						return;
					if (!state.canEdit && state.accessPhase === "reconnecting") return;
					set({
						projectCanEdit: false,
						canEdit: false,
						accessPhase: "reconnecting",
					});
				},

				applyAccessSnapshot(
					snapshot: BuilderAccessSnapshot,
					options?: { hasWaitingChanges?: boolean },
				) {
					set((state) => {
						const confirmedProjectChanged =
							state.projectId !== undefined &&
							state.projectId !== snapshot.projectId;
						return {
							projectId: snapshot.projectId,
							role: snapshot.role,
							projectCanEdit: snapshot.canEdit,
							canEdit: snapshot.canEdit && !state.buildUnfinished,
							accessPhase: "authorized",
							hasWaitingAccessChanges:
								!snapshot.canEdit && (options?.hasWaitingChanges ?? false),
							/* A refresh is only evidence that Project authority may have
							 * changed. Preserve the active worker/case binding through an
							 * ordinary same-Project round trip; clear it atomically only
							 * after the authoritative snapshot confirms a different
							 * tenant. */
							...(confirmedProjectChanged
								? {
										previewCaseTarget: undefined,
										previewSelectedCase: undefined,
										previewPersonaUuid: undefined,
									}
								: {}),
						};
					});
				},

				revokeAccess() {
					const state = get();
					if (!state.canEdit && state.accessPhase === "revoked") return;
					set({
						projectCanEdit: false,
						canEdit: false,
						accessPhase: "revoked",
					});
				},

				requireClientUpgrade() {
					const state = get();
					if (!state.canEdit && state.accessPhase === "upgradeRequired") return;
					set({
						projectCanEdit: false,
						canEdit: false,
						accessPhase: "upgradeRequired",
					});
				},

				setLoading(loading: boolean) {
					if (loading === get().loading) return;
					set({ loading });
				},

				// ── Connect stash actions ───────────────────────────────

				switchConnectMode(
					type: ConnectType | null,
					desiredBlocks?: Record<string, ConnectConfig>,
					opts?: { announce?: boolean },
				): CommitOutcome {
					if (!docStoreRef) return { ok: false, messages: [] };
					const s = get();
					const docState = docStoreRef.getState();

					const currentType = (docState.connectType ?? undefined) as
						| ConnectType
						| undefined;
					/* `desiredBlocks` is the AUTHORITATIVE complete set of
					 * participating forms for `type`: a form present here
					 * participates with this config, a form absent stays auxiliary.
					 * The manager seeds these drafts from the live doc (current
					 * mode) and the stash (the other mode), so the store no longer
					 * restores from the stash itself — what the caller hands over
					 * is the whole truth. */
					const blocks = desiredBlocks ?? {};

					const plan = planConnectTargetState(
						docState,
						type === null
							? { mode: null }
							: {
									mode: type,
									participants: Object.entries(blocks).map(
										([formUuid, connect]) => ({
											formUuid,
											connect,
										}),
									),
								},
					);
					if (!plan.ok) {
						if (opts?.announce !== false) {
							notifyRejectedCommit([...plan.messages]);
						}
						return { ok: false, messages: [...plan.messages] };
					}

					/* Stash the OUTGOING mode's live blocks when the mode is
					 * actually leaving a non-null type (a mode switch or a disable),
					 * so the work survives for a later switch-back — the manager
					 * reads this stash to seed the inactive mode's drafts. A
					 * same-mode apply leaves the active configs on the doc, so it
					 * stashes nothing. */
					let nextStash = s.connectStash;
					if (currentType && currentType !== type) {
						const outgoing: Record<string, ConnectConfig> = {};
						for (const moduleUuid of docState.moduleOrder) {
							const formUuids = docState.formOrder[moduleUuid] ?? [];
							for (const formUuid of formUuids) {
								const form = docState.forms[formUuid];
								if (form?.connect) {
									outgoing[formUuid] = structuredClone(form.connect);
								}
							}
						}
						nextStash = { ...nextStash, [currentType]: outgoing };
					}

					/* Blocks dropped by a SAME-mode apply (a form the manager removed
					 * from participation) — stashed below so removal stays reversible,
					 * the same guarantee the per-form toggle gives. A mode switch /
					 * disable already stashed its outgoing blocks wholesale above, so
					 * this only collects the same-mode case. */
					const droppedBlocks: Record<string, ConnectConfig> = {};
					if (type && currentType === type) {
						for (const moduleUuid of docState.moduleOrder) {
							const formUuids = docState.formOrder[moduleUuid] ?? [];
							for (const formUuid of formUuids) {
								const current = docState.forms[formUuid]?.connect;
								if (current !== undefined && blocks[formUuid] === undefined) {
									droppedBlocks[formUuid] = structuredClone(current);
								}
							}
						}
					}

					/* Fold any same-mode drops into the outgoing mode's stash so a
					 * removed form is restorable — per-form-toggle parity. */
					if (currentType && Object.keys(droppedBlocks).length > 0) {
						nextStash = {
							...nextStash,
							[currentType]: { ...nextStash[currentType], ...droppedBlocks },
						};
					}

					/* Nothing to do — the doc already matches the request. Return
					 * success without committing so an unchanged apply is inert. */
					if (plan.mutations.length === 0) return { ok: true };

					/* The shared commit verdict — the same gate every other write
					 * surface runs. The pure planner has already rejected malformed
					 * target-state input; this gate adjudicates the complete app
					 * candidate. A refusal dispatches nothing, so the doc and the UI
					 * stash stay exactly as they were. */
					const verdict = mutationCommitVerdict(
						docState,
						plan.mutations,
						LOOKUP_CONTEXT_UNAVAILABLE,
					);
					if (!verdict.ok) {
						// Concise builder copy for both the toast and the returned
						// outcome (the manager footer reads it); the SA keeps the
						// verbose `ValidationError.message`.
						const lines = userFacingErrors(verdict.findings);
						if (opts?.announce !== false) {
							notifyRejectedCommit(lines);
						}
						return { ok: false, messages: lines };
					}
					/* Commit the validated candidate (one reducer run, one undo
					 * entry) with the batch that produced it — this is an author
					 * edit, so it joins the command queue persistence sends. THEN
					 * the stash, a pure state write that can't fail. */
					docStoreRef.getState().commitDoc(verdict.nextDoc, verdict.mutations);
					set({
						connectStash: nextStash,
						// "Last active connect type" = the mode now in effect, or the
						// one just left when turning off. It is only a manager-default
						// hint; every document command still states its mode exactly.
						lastConnectType: type ?? currentType ?? s.lastConnectType,
					});
					return { ok: true };
				},

				getFormConnectStash(
					mode: ConnectType,
					formUuid: string,
				): ConnectConfig | undefined {
					return get().connectStash[mode]?.[formUuid];
				},

				setPreviewing(on: boolean) {
					const s = get();

					/* Guard: setting the same value is a no-op. Without this,
					 * entering preview twice would overwrite the stash with
					 * `{ stashed: false }` (the already-closed sidebar values),
					 * losing the original pre-preview state. */
					if (on === s.previewing) return;

					if (on) {
						/* Stash current open values, then close both for the
						 * immersive full-bleed preview. Clear any case target so
						 * the preview session starts caseless. */
						set({
							previewing: true,
							previewCaseTarget: undefined,
							previewSelectedCase: undefined,
							sidebars: {
								chat: {
									open: false,
									stashed: s.sidebars.chat.open,
								},
								structure: {
									open: false,
									stashed: s.sidebars.structure.open,
								},
							},
						});
						return;
					}

					/* Leaving preview: restore stashed values if present,
					 * otherwise leave sidebars as-is. Drop the case target —
					 * it's running-app state with no meaning outside preview. */
					const chatStashed = s.sidebars.chat.stashed;
					const structureStashed = s.sidebars.structure.stashed;
					set({
						previewing: false,
						previewPersonaUuid: undefined,
						previewCaseTarget: undefined,
						previewSelectedCase: undefined,
						sidebars: {
							chat: {
								open: chatStashed ?? s.sidebars.chat.open,
								stashed: undefined,
							},
							structure: {
								open: structureStashed ?? s.sidebars.structure.open,
								stashed: undefined,
							},
						},
					});
				},

				setPreviewPersonaUuid(personaUuid: string | undefined) {
					if (personaUuid === get().previewPersonaUuid) return;
					/* One `set` so the identity and the case it was looking at
					 * can never be observed apart: a case the previous worker
					 * selected has no standing in the next worker's session. */
					set({
						previewPersonaUuid: personaUuid,
						previewCaseTarget: undefined,
						previewSelectedCase: undefined,
					});
				},

				setActiveFieldId(fieldId: string | undefined) {
					if (fieldId === get().activeFieldId) return;
					set({ activeFieldId: fieldId });
				},

				setPreviewCaseTarget(target: PreviewCaseTarget | undefined) {
					const current = get().previewCaseTarget;
					/* Shallow no-op guard — the three fields fully describe the
					 * target, so equal formUuid + caseId + caseName means nothing
					 * changed. */
					if (
						current?.formUuid === target?.formUuid &&
						current?.caseId === target?.caseId &&
						current?.caseName === target?.caseName
					) {
						return;
					}
					set({ previewCaseTarget: target });
				},

				setPreviewSelectedCase(selected: PreviewSelectedCase | undefined) {
					const current = get().previewSelectedCase;
					if (
						current?.caseId === selected?.caseId &&
						current?.caseName === selected?.caseName
					) {
						return;
					}
					set({ previewSelectedCase: selected });
				},

				setSidebarOpen(kind: SidebarKind, open: boolean) {
					const s = get();
					if (s.sidebars[kind].open === open) return;
					set({
						sidebars: {
							...s.sidebars,
							[kind]: { ...s.sidebars[kind], open },
						},
					});
				},

				// ── Staged media upload actions ──────────────────────────

				stageUpload(
					slotKey: string,
					upload: { filename: string; kind: MediaKind; abort: () => void },
				) {
					/* Re-staging over a transfer still running on this slot
					 * displaces it — abort the displaced transfer FIRST. Once its
					 * handle is overwritten the transfer is unreachable: cancel
					 * can't stop it, and if it confirmed it would attach the
					 * DISPLACED file and clear this record out from under the new
					 * upload. The displaced driver settles against its own aborted
					 * signal (the same silent branch a user cancel takes). */
					stagedUploadAborts.get(slotKey)?.();
					stagedUploadAborts.set(slotKey, upload.abort);
					set((s) => ({
						stagedUploads: {
							...s.stagedUploads,
							[slotKey]: {
								filename: upload.filename,
								kind: upload.kind,
								status: { state: "uploading", progress: 0 },
							},
						},
					}));
				},

				setStagedUploadProgress(slotKey: string, progress: number) {
					const record = get().stagedUploads[slotKey];
					if (record?.status.state !== "uploading") return;
					const clamped = Math.min(Math.max(progress, 0), 1);
					if (clamped === record.status.progress) return;
					set((s) => ({
						stagedUploads: {
							...s.stagedUploads,
							[slotKey]: {
								...record,
								status: { state: "uploading", progress: clamped },
							},
						},
					}));
				},

				failStagedUpload(slotKey: string, message: string) {
					const record = get().stagedUploads[slotKey];
					if (!record) return;
					stagedUploadAborts.delete(slotKey);
					set((s) => ({
						stagedUploads: {
							...s.stagedUploads,
							[slotKey]: { ...record, status: { state: "error", message } },
						},
					}));
				},

				clearStagedUpload(slotKey: string) {
					stagedUploadAborts.delete(slotKey);
					if (get().stagedUploads[slotKey] === undefined) return;
					set((s) => {
						const { [slotKey]: _dropped, ...rest } = s.stagedUploads;
						return { stagedUploads: rest };
					});
				},

				recordProvisioningOutcome(answer) {
					const key = provisioningOutcomeKey(answer.server, answer.domain);
					set((s) => ({
						unconfirmedWorkers: retainUnconfirmedWorkers(
							s.unconfirmedWorkers,
							answer,
						),
						provisioningOutcomes: {
							...s.provisioningOutcomes,
							[key]: foldProvisioningOutcome(
								s.provisioningOutcomes[key],
								answer,
							),
						},
					}));
				},

				noteDeploymentRecordsChanged() {
					set((s) => ({
						deploymentRecordsRevision: s.deploymentRecordsRevision + 1,
					}));
				},

				dismissUnconfirmedWorker(key: string) {
					if (get().unconfirmedWorkers[key] === undefined) return;
					set((s) => {
						const { [key]: _dropped, ...rest } = s.unconfirmedWorkers;
						return { unconfirmedWorkers: rest };
					});
				},

				requestPublishDialog(request: { readonly domain: string }) {
					set({ publishDialogRequest: request });
				},

				clearPublishDialogRequest() {
					if (get().publishDialogRequest === null) return;
					set({ publishDialogRequest: null });
				},

				cancelStagedUpload(slotKey: string) {
					const abort = stagedUploadAborts.get(slotKey);
					/* Abort BEFORE clearing so the driver's rejection handler
					 * observes the canceled signal against an already-removed
					 * record — its "cancel wins" branch stays a no-op. */
					abort?.();
					get().clearStagedUpload(slotKey);
				},

				recordAssetMeta(
					assets: readonly ({ id: string } & ExportBudgetRowView)[],
				) {
					if (assets.length === 0) return;
					const current = get().assetMeta;
					/* Skip the write when every incoming row is already recorded
					 * verbatim — library pages re-fetch on every picker open, and
					 * an unchanged registry must not notify subscribers. */
					const changed = assets.some((asset) => {
						const known = current[asset.id];
						return (
							known === undefined ||
							known.status !== asset.status ||
							known.kind !== asset.kind ||
							known.sizeBytes !== asset.sizeBytes
						);
					});
					if (!changed) return;
					const next = { ...current };
					for (const asset of assets) {
						next[asset.id] = {
							status: asset.status,
							kind: asset.kind,
							sizeBytes: asset.sizeBytes,
						};
					}
					set({ assetMeta: next });
				},

				resetProjectScope() {
					const failures: unknown[] = [];
					for (const abort of stagedUploadAborts.values()) {
						try {
							abort();
						} catch (error) {
							/* Keep draining the registry. One broken abort callback must
							 * never leave another source-Project transfer alive. */
							failures.push(error);
						}
					}
					stagedUploadAborts.clear();
					set({
						/* Conversation/mutation events can carry Project asset ids,
						 * filenames, tool inputs/results, and media-bearing mutations. The
						 * transport owner closes the agent-write bracket; the session reset
						 * synchronously retires the payload/phase projection itself. */
						events: [],
						runStartedWithData: false,
						runCompletedAt: undefined,
						stagedUploads: {},
						assetMeta: {},
						/* A pending dialog-open request names a project space the
						 * OLD Project's records offered; the destination must not
						 * open a publish aimed by it. */
						publishDialogRequest: null,
						/* Case/persona identity is retained until
						 * `applyAccessSnapshot` can distinguish an ordinary refresh from
						 * a confirmed Project move. Clearing it here would rotate a
						 * same-worker form entry before the GET returned. */
					});
					if (failures.length > 0) {
						throw new AggregateError(
							failures,
							"One or more Project-scoped uploads failed to abort",
						);
					}
				},

				setFocusHint(fieldId: string | undefined) {
					if (fieldId === get().focusHint) return;
					set({ focusHint: fieldId });
				},

				clearFocusHint() {
					if (get().focusHint === undefined) return;
					set({ focusHint: undefined });
				},

				markNewField(uuid: string) {
					set({ newFieldUuid: uuid });
				},

				isNewField(uuid: string): boolean {
					return get().newFieldUuid === uuid;
				},

				clearNewField() {
					if (get().newFieldUuid === undefined) return;
					set({ newFieldUuid: undefined });
				},

				setEditScroll(formUuid: string, memory: EditScrollMemory) {
					set((s) => ({
						editScrollByForm: { ...s.editScrollByForm, [formUuid]: memory },
					}));
				},

				getEditScroll(formUuid: string): EditScrollMemory | undefined {
					return get().editScrollByForm[formUuid];
				},

				setActiveSection(formUuid: string, sectionUuid: string | undefined) {
					set((s) => {
						if (s.activeSectionByForm[formUuid] === sectionUuid) return s;
						const next = { ...s.activeSectionByForm };
						if (sectionUuid === undefined) delete next[formUuid];
						else next[formUuid] = sectionUuid;
						return { activeSectionByForm: next };
					});
				},

				getActiveSection(formUuid: string): string | undefined {
					return get().activeSectionByForm[formUuid];
				},

				reset() {
					/* Abort any in-flight staged uploads — their drivers hold
					 * closures into a session that's being torn down, so letting
					 * them run would attach into a dead store. */
					for (const abort of stagedUploadAborts.values()) abort();
					stagedUploadAborts.clear();
					set({
						/* Generation lifecycle. `buildUnfinished` is deliberately NOT
						 * re-seeded here: it tracks a fact about the APP (its build never
						 * completed), not this session, and the constructor-time `init`
						 * snapshot goes stale the moment a run releases the latch —
						 * re-seeding would resurrect it and re-price edits as builds.
						 * Same reasoning as `resetProjectScope` leaving it alone; the
						 * app-status stream keeps it converged with the server. */
						events: [],
						runStartedWithData: false,
						runCompletedAt: undefined,
						loading: false,

						/* App identity */
						appId: undefined,
						projectId: initialAccess.projectId,
						role: initialAccess.role,
						projectCanEdit: initialAccess.canEdit,
						canEdit: initialAccess.canEdit && !get().buildUnfinished,
						accessPhase: "authorized",
						scopeEpoch: 0,
						hasWaitingAccessChanges: false,

						/* Interaction */
						previewing: false,
						activeFieldId: undefined,
						previewCaseTarget: undefined,
						previewSelectedCase: undefined,
						previewPersonaUuid: undefined,

						/* Chrome */
						sidebars: {
							chat: { open: true, stashed: undefined },
							structure: { open: true, stashed: undefined },
						},

						/* Connect stash */
						connectStash: { learn: {}, deliver: {} } as Record<
							ConnectType,
							Record<string, ConnectConfig>
						>,
						lastConnectType: undefined as ConnectType | undefined,

						/* Staged media uploads */
						stagedUploads: {} as Record<string, StagedUpload>,
						unconfirmedWorkers: {} as Record<string, UnconfirmedWorker>,
						provisioningOutcomes: {} as Record<string, HeldProvisioningOutcome>,
						assetMeta: {} as Record<string, ExportBudgetRowView>,
						publishDialogRequest: null as { readonly domain: string } | null,
						deploymentRecordsRevision: 0,

						/* UI hints */
						focusHint: undefined as string | undefined,
						newFieldUuid: undefined as string | undefined,
						editScrollByForm: {} as Record<string, EditScrollMemory>,
						activeSectionByForm: {} as Record<string, string>,
					});
				},
			})),
			{
				name: "BuilderSession",
				enabled: process.env.NODE_ENV === "development",
			},
		),
	);
}
