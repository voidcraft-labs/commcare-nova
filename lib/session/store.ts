/**
 * BuilderSession store — ephemeral UI state for the builder.
 *
 * Owns cursor mode, sidebar visibility + stash, active field tracking,
 * generation lifecycle, replay state, and app identity. Everything here
 * lives only while the builder route is mounted and is NEVER undoable.
 * Separated from BlueprintDoc so UI state can't bleed into undo history
 * and there's no need for a partialize allow-list.
 *
 * Middleware: `subscribeWithSelector` (targeted subscriptions) + `devtools`
 * (Redux DevTools in development). No Immer (shape is flat enough), no zundo
 * (nothing undoable).
 *
 * Actions are reducer-shaped where atomicity matters. `switchCursorMode` is
 * the canonical example — it stashes/restores sidebar visibility in a single
 * `set()` call so intermediate states never leak to subscribers.
 *
 * Generation lifecycle actions (`beginRun`, `endRun`, plus the
 * `pushEvents` / `pushEvent` / `replaceEvents` buffer mutators) bracket
 * agent runs and coordinate with the doc store's temporal middleware to
 * pause/resume undo tracking. Stage/error/status-message/postBuildEdit
 * are derived from the events buffer — see `lifecycle.ts`.
 */

import { devtools, subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { dedupeRestoredConnectIds } from "@/lib/doc/connectConfig";
import type { AppConnectId } from "@/lib/doc/hooks/useAppConnectIds";
import { notifyRejectedCommit } from "@/lib/doc/mutations/notify";
import { docHasData } from "@/lib/doc/predicates";
import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { Mutation, Uuid } from "@/lib/doc/types";
import type { CommitOutcome, ConnectConfig, ConnectType } from "@/lib/domain";
import type { MediaKind } from "@/lib/domain/multimedia";
import type { Event } from "@/lib/log/types";
import type { ExportBudgetRowView } from "@/lib/media/exportBudget";
import type { CursorMode, ReplayData, ReplayInit, StagedUpload } from "./types";

// ── Public types ──────────────────────────────────────────────────────────

/** Which sidebar column to target in `setSidebarOpen`. */
export type SidebarKind = "chat" | "structure";

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
 *   - Replay (`replay`) — build replay playback data.
 *   - Interaction (`cursorMode`, `activeFieldId`) — how the user is editing.
 *   - Chrome (`sidebars`) — layout visibility + stash for mode transitions.
 *   - Connect stash — learn↔deliver toggle preservation.
 */
export interface BuilderSessionState {
	// ── Generation lifecycle ─────────────────────────────────────────────

	/** In-memory event-log buffer. Holds events for the *currently active
	 *  run only* — cleared at both `beginRun()` (opening a new run) and
	 *  `endRun()` (closing it). An empty buffer means no run is in
	 *  progress; a non-empty buffer means the SSE stream is open (live)
	 *  or the replay cursor is past the chapter start (replay). Live:
	 *  appended by the stream dispatcher as `data-mutations` +
	 *  `data-conversation-event` envelopes arrive. Replay: seeded by the
	 *  hydrator + replaced on scrub.
	 *
	 *  Every lifecycle derivation (phase, stage, error, status message,
	 *  validation attempt, postBuildEdit) reads from this buffer — see
	 *  `lib/session/lifecycle.ts`. There's no shadow `agentActive` flag;
	 *  `events.length > 0` is the canonical "a run is happening" signal,
	 *  and it can't drift because both run-boundary writes are atomic
	 *  state updates in `beginRun`/`endRun`. */
	events: Event[];

	/** Whether the doc already had data when the current run OPENED —
	 *  captured once in `beginRun()`. The build-vs-edit discriminator for
	 *  the lifecycle derivations: a run that started on an empty doc is an
	 *  initial build (its structural stages drive the Generating layout);
	 *  a run that started on a populated doc is a post-build edit (the
	 *  builder stays interactive while the agent works). Stays `false`
	 *  outside a run and for replay (which always replays builds). */
	runStartedWithData: boolean;

	/** Timestamp of the most recent whole-build completion — stamped by
	 *  the dispatcher's `data-done` handler (the server-side marker from
	 *  the route's drain-end finalize). Cleared on `acknowledgeCompletion()` (after the
	 *  celebration animation) and on `beginRun()` (new run starts clean).
	 *  askQuestions / clarifying-text / edit-tool runs never stamp — they
	 *  close silently. Drives the Completed phase. */
	runCompletedAt: number | undefined;

	/** Generic loading flag for async operations outside of agent writes
	 *  (e.g. initial app load, import). */
	loading: boolean;

	// ── App identity ─────────────────────────────────────────────────────

	/** Firestore app document ID for the current builder session. Set
	 *  once when the builder mounts; undefined for new builds before
	 *  the app document is created. */
	appId: string | undefined;

	/** Auto-save optimistic basis — the server `blueprint_token` this
	 *  client last observed (seeded from the build page's server load,
	 *  advanced by each PUT response, re-synced on a stale-basis reload).
	 *  `null` for an app no out-of-window writer has touched. Echoed on
	 *  every auto-save PUT; see `useAutoSave`. */
	saveBasis: string | null;

	// ── Replay ───────────────────────────────────────────────────────────

	/** Replay session data — present only during replay mode. Holds the
	 *  raw event log, derived chapter metadata, the current scrub cursor
	 *  (index into `events`), and the URL to navigate to on exit. Chat
	 *  messages are derived on read via `useReplayMessages`. */
	replay: ReplayData | undefined;

	// ── Interaction ──────────────────────────────────────────────────────

	/** Current cursor mode — "pointer" (interact/live preview) or "edit"
	 *  (click-to-select + inline text editing). */
	cursorMode: CursorMode;

	/** Which `[data-field-id]` element currently has focus. Transient UI hint,
	 *  not undoable. Used by composite undo/redo to restore focus after the
	 *  temporal state rolls back. */
	activeFieldId: string | undefined;

	// ── Chrome ───────────────────────────────────────────────────────────

	/** Sidebar visibility with stash support for cursor mode transitions.
	 *  `stashed` records the pre-pointer-mode `open` value; `undefined` means
	 *  nothing is stashed. `switchCursorMode` writes both fields atomically. */
	sidebars: {
		chat: { open: boolean; stashed: boolean | undefined };
		structure: { open: boolean; stashed: boolean | undefined };
	};

	// ── Connect stash (ephemeral, not undoable) ──────────────────────────

	/** Preserved form connect configs across mode switches. Keyed by
	 *  connect type -> form uuid -> config. Uses uuid instead of
	 *  moduleIndex/formIndex so renames and reorders don't invalidate
	 *  the stash. */
	connectStash: Record<
		ConnectType,
		Record<string /* formUuid */, ConnectConfig>
	>;

	/** Last active connect type — restored on toggle off/on when the
	 *  caller passes `undefined` to `switchConnectMode`. */
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

	// ── Transient UI hints (one-shot, consumed by a single component) ────

	/** Transient field key to focus after undo/redo. Set by `useUndoRedo`;
	 *  read by whichever editor owns the matching data-field-id (each
	 *  editor ignores non-matching values rather than clearing the hint,
	 *  so sibling editors still see their own hints on the same render).
	 *  Remains set until `setFocusHint(undefined)` or `clearFocusHint()`
	 *  is called explicitly. */
	focusHint: string | undefined;

	/** UUID of a just-added field — activates auto-focus and select-all
	 *  on the ID input in FieldHeader. One-shot: set by FieldTypePicker on
	 *  add, consumed once by the header on mount. */
	newFieldUuid: string | undefined;

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
	 *  ready→submitted/streaming transition. */
	beginRun: () => void;

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

	/** Set the app ID for this builder session. No-ops when unchanged. */
	setAppId: (id: string) => void;

	/** Advance the auto-save optimistic basis (each PUT response carries
	 *  the freshly rotated token; a stale-basis reload re-syncs from the
	 *  GET). No-ops when unchanged. */
	setSaveBasis: (token: string | null) => void;

	/** Set the generic loading flag. No-ops when unchanged. */
	setLoading: (loading: boolean) => void;

	/** Append events to the buffer. Used by the stream dispatcher's
	 *  `data-mutations` and `data-conversation-event` handlers (live),
	 *  and by the replay hydrator. No-ops on empty arrays — identity
	 *  preserved so memoized subscribers don't needlessly fire. */
	pushEvents: (events: Event[]) => void;

	/** Append a single event. Convenience wrapper over `pushEvents`. */
	pushEvent: (event: Event) => void;

	/** Replace the events buffer wholesale. Used by `ReplayController`
	 *  when scrubbing — every scrub is a full reconstruction from
	 *  `events[0..cursor]`, not a delta, so appending would corrupt the
	 *  buffer. Not exposed as an SSE handler path. */
	replaceEvents: (events: Event[]) => void;

	// ── Replay actions ──────────────────────────────────────────────────

	/** Load a replay session from a raw event log + derived chapters.
	 *  `initialCursor` is the scrub position to mount at (typically
	 *  `events.length - 1` so the user lands on the final frame).
	 *
	 *  Takes `ReplayInit` directly — the same shape the RSC page builds
	 *  and the BuilderProvider forwards. One source of truth for the
	 *  page → provider → store handoff. */
	loadReplay: (init: ReplayInit) => void;

	/** Update the replay scrub cursor. Clamps to `[0, events.length - 1]`
	 *  so callers don't have to repeat the bounds check, and no-ops when
	 *  replay is not loaded or the clamped cursor equals the current one.
	 *  The store is the source of truth for scrub position. */
	setReplayCursor: (cursor: number) => void;

	// ── Connect stash actions ────────────────────────────────────────────

	/** Switch the app-level connect mode, or toggle it off/on — ONE gated
	 *  batch: `setConnectType` plus each participating form's connect
	 *  block.
	 *
	 *  Passing a mode (`'learn'` or `'deliver'`) enables that mode — stashing
	 *  the outgoing mode's form configs, restoring the incoming mode's stash,
	 *  and landing the caller-collected `stagedBlocks` on the forms the user
	 *  picked as participating (the enable flow collects those BEFORE
	 *  anything commits — see `AppConnectSection`). Forms with neither a
	 *  stashed nor a staged block stay auxiliary — they carry no block and
	 *  need nothing. Every incoming block routes through
	 *  `dedupeRestoredConnectIds` under one accumulating id scope, so two
	 *  forms can't land the same slug in one flip.
	 *
	 *  Passing `null` disables Connect entirely (always valid — standard
	 *  apps need no blocks; the stash preserves the work). Passing
	 *  `undefined` re-enables with the user's last active mode (falling
	 *  back to `'learn'`).
	 *
	 *  The whole batch runs the shared commit verdict before anything
	 *  dispatches — a flip that would leave the app with NO participating
	 *  form is rejected (findings returned in the outcome) and the doc +
	 *  stash stay untouched. A pass commits as one undo entry. A rejection
	 *  announces via the error toast unless the caller opts out with
	 *  `announce: false` because it presents the outcome itself (the
	 *  enable dialog's footer) — one rejection, one presentation. */
	switchConnectMode: (
		type: ConnectType | null | undefined,
		stagedBlocks?: Record<string, ConnectConfig>,
		opts?: { announce?: boolean },
	) => CommitOutcome;

	/** Stash a single form's connect config by uuid. Used by form-level
	 *  toggles that disable connect on an individual form. */
	stashFormConnect: (
		mode: ConnectType,
		formUuid: string,
		config: ConnectConfig,
	) => void;

	/** Get a single form's stashed connect config (does not remove it). */
	getFormConnectStash: (
		mode: ConnectType,
		formUuid: string,
	) => ConnectConfig | undefined;

	// ── Cursor + sidebar actions ─────────────────────────────────────────

	/** Atomically switch cursor mode with sidebar stash/restore.
	 *
	 *  - To pointer: stash current `open` values, then close both sidebars.
	 *  - To edit (with stash): restore stashed values, clear stash.
	 *  - To edit (no stash): update mode only, no sidebar change.
	 *  - Same mode: no-op (guards against double-entry that would overwrite
	 *    the stash with `{ stashed: false }` values). */
	switchCursorMode: (mode: CursorMode) => void;

	/** Non-atomic cursor mode setter for non-toggle cases (e.g. initial mode
	 *  or forced reset). Does NOT stash/restore sidebars. */
	setCursorMode: (mode: CursorMode) => void;

	/** Update which field has focus. No-ops when the value is unchanged to
	 *  avoid unnecessary subscriber notifications. */
	setActiveFieldId: (fieldId: string | undefined) => void;

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
	 *  select-all on the ID input in FieldHeader. */
	markNewField: (uuid: string) => void;

	/** Check whether a uuid matches the current new-field marker.
	 *  Imperative reader — usable outside of selectors. */
	isNewField: (uuid: string) => boolean;

	/** Clear the new-field marker. Called after the first rename or
	 *  when the component unmounts, so subsequent selections behave normally. */
	clearNewField: () => void;

	/** Reset all transient session state to the initial values.
	 *
	 *  Composed alongside `resetBuilder` (the doc + engine + signal-grid
	 *  reset helper) by callers that want a full clean slate — notably
	 *  `ReplayController.handleExit`, which wipes both when the user
	 *  leaves replay mode. Scrub callers (e.g. `goToChapter`) call
	 *  `resetBuilder` without `reset()` so `replay.*` survives the click.
	 *  Restores all generation lifecycle, replay, cursor mode, sidebars,
	 *  connect stash, and one-shot UI hints to defaults. The private
	 *  doc-store reference installed by SyncBridge is NOT cleared — the
	 *  provider's effect owns its lifetime. */
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
	/** Start in loading state — used when hydrating an existing app or
	 *  replaying a build so the builder shows the loading skeleton
	 *  immediately rather than flashing the idle/chat state. */
	loading?: boolean;
	/** Pre-set the Firestore app document ID. */
	appId?: string;
	/** Pre-seed the auto-save basis (`blueprint_token`) from the build
	 *  page's server load, so the first PUT echoes the right basis
	 *  instead of bouncing off a token a prior session rotated. */
	saveBasis?: string | null;
}

/** Create a scoped Zustand session store. Called once per BuilderProvider
 *  mount — the parent provider's `buildId` controls the store lifetime.
 *
 *  @param init — optional initial overrides for lifecycle fields that must
 *  be correct before the first render (see `SessionStoreInit`). */
export function createBuilderSessionStore(init?: SessionStoreInit) {
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
				loading: init?.loading ?? false,

				/* App identity */
				appId: init?.appId as string | undefined,
				saveBasis: init?.saveBasis ?? null,

				/* Replay */
				replay: undefined as ReplayData | undefined,

				/* Interaction */
				cursorMode: "edit" as CursorMode,
				activeFieldId: undefined,

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
				assetMeta: {} as Record<string, ExportBudgetRowView>,

				/* UI hints */
				focusHint: undefined as string | undefined,
				newFieldUuid: undefined as string | undefined,

				// ── Reducer-shaped actions ───────────────────────────────

				_setDocStore(store: BlueprintDocStore | null) {
					docStoreRef = store;
				},

				// ── Generation lifecycle actions ─────────────────────────

				beginRun() {
					/* Open a run atomically: pause doc undo (whole run
					 * collapses into one undoable unit on resume), clear the
					 * events buffer, clear any stale completion stamp, and
					 * capture the build-vs-edit discriminator (whether the doc
					 * already has data) for the lifecycle derivations. The
					 * non-empty buffer that accumulates from here is the
					 * "a run is in progress" signal — no agentActive mirror
					 * to maintain. */
					const docState = docStoreRef?.getState();
					docState?.beginAgentWrite();
					set({
						events: [],
						runCompletedAt: undefined,
						runStartedWithData: docState ? docHasData(docState) : false,
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

				pushEvents(events: Event[]) {
					if (events.length === 0) return;
					set((s) => ({ events: [...s.events, ...events] }));
				},

				pushEvent(event: Event) {
					set((s) => ({ events: [...s.events, event] }));
				},

				replaceEvents(events: Event[]) {
					set({ events });
				},

				setAppId(id: string) {
					if (id === get().appId) return;
					set({ appId: id });
				},

				setSaveBasis(token: string | null) {
					if (token === get().saveBasis) return;
					set({ saveBasis: token });
				},

				setLoading(loading: boolean) {
					if (loading === get().loading) return;
					set({ loading });
				},

				// ── Replay actions ──────────────────────────────────────

				loadReplay({ events, chapters, initialCursor, exitPath }) {
					set({
						replay: {
							events,
							chapters,
							cursor: initialCursor,
							exitPath,
						},
					});
				},

				setReplayCursor(cursor: number) {
					const replay = get().replay;
					/* No-op outside an active replay session — cursor has no
					 * meaning without an event log to index into. */
					if (!replay) return;
					/* Clamp to valid event indices. Empty-events replay pins the
					 * cursor at 0 (`max` collapses to 0). Clamping here lets UI
					 * code pass deltas like `cursor - 1` without guarding. */
					const max = Math.max(0, replay.events.length - 1);
					const clamped = Math.min(Math.max(cursor, 0), max);
					/* Skip redundant state writes — matches the setLoading /
					 * setAppId idiom where same-value calls don't notify
					 * subscribers. */
					if (clamped === replay.cursor) return;
					set({ replay: { ...replay, cursor: clamped } });
				},

				// ── Connect stash actions ───────────────────────────────

				switchConnectMode(
					type: ConnectType | null | undefined,
					stagedBlocks?: Record<string, ConnectConfig>,
					opts?: { announce?: boolean },
				): CommitOutcome {
					if (!docStoreRef) return { ok: false, messages: [] };
					const s = get();
					const docState = docStoreRef.getState();
					/* An app with zero forms has nothing to stage or stash — the
					 * walks below collect no form mutations and the batch is the
					 * bare `setConnectType` flip, which the gate passes (the
					 * participation floor binds only once forms exist). The same
					 * flip the SA's `updateApp` lands on an empty app. */

					const currentType = (docState.connectType ?? undefined) as
						| ConnectType
						| undefined;
					const resolved =
						type === undefined ? (s.lastConnectType ?? "learn") : type;

					/* Same-mode early return — no stash, no mutations. */
					if (resolved === currentType) return { ok: true };

					/* Stash outgoing mode — walk the doc to collect live form configs. */
					let nextStash = s.connectStash;
					if (currentType) {
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

					/* Build doc mutations: setConnectType + restore/stage/clear. */
					const mutations: Mutation[] = [
						{ kind: "setConnectType", connectType: resolved ?? null },
					];

					if (resolved) {
						/* Land each participating form's incoming-mode block AND
						 * clear any outgoing-mode block with no incoming config.
						 * Walk every form once with three cases:
						 *   - in the incoming stash, or covered by a caller-staged
						 *     block → land that config (stash wins — it is the
						 *     user's prior work for this mode);
						 *   - no incoming config but currently has `connect` → clear
						 *     it (a stray from the outgoing mode; the outgoing
						 *     config was already stashed above, so switch-back
						 *     recovers it — no work lost);
						 *   - otherwise → no mutation (the form stays auxiliary —
						 *     a Connect app's forms participate per form, not
						 *     wholesale).
						 * Every incoming config routes through the shared
						 * `dedupeRestoredConnectIds` under ONE accumulating id
						 * scope: a stashed id another form claimed while the mode
						 * was off re-derives instead of landing a duplicate, and a
						 * staged (id-less) block autofills a valid unique id —
						 * same source enforcement as the agent path. */
						const stashed = nextStash[resolved] ?? {};
						const assigned: AppConnectId[] = [];
						const recordAssigned = (
							formUuid: Uuid,
							config: ConnectConfig,
						): void => {
							for (const kind of [
								"learn_module",
								"assessment",
								"deliver_unit",
								"task",
							] as const) {
								const id = config[kind]?.id;
								if (id) assigned.push({ formUuid, kind, id });
							}
						};
						for (const moduleUuid of docState.moduleOrder) {
							const formUuids = docState.formOrder[moduleUuid] ?? [];
							for (const formUuid of formUuids) {
								const incoming = stashed[formUuid] ?? stagedBlocks?.[formUuid];
								if (incoming) {
									const config = dedupeRestoredConnectIds(
										structuredClone(incoming),
										{
											formUuid,
											appConnectIds: assigned,
											moduleName: docState.modules[moduleUuid]?.name ?? "",
											formName: docState.forms[formUuid]?.name ?? "",
										},
									);
									recordAssigned(formUuid, config);
									mutations.push({
										kind: "updateForm",
										uuid: formUuid,
										patch: { connect: config },
									});
								} else if (docState.forms[formUuid]?.connect !== undefined) {
									mutations.push({
										kind: "updateForm",
										uuid: formUuid,
										patch: { connect: undefined },
									});
								}
							}
						}
					} else {
						/* Disabling connect entirely: clear `connect` on every form. */
						for (const moduleUuid of docState.moduleOrder) {
							const formUuids = docState.formOrder[moduleUuid] ?? [];
							for (const formUuid of formUuids) {
								if (docState.forms[formUuid]?.connect !== undefined) {
									mutations.push({
										kind: "updateForm",
										uuid: formUuid as Uuid,
										patch: { connect: undefined },
									});
								}
							}
						}
					}

					/* The shared commit verdict — the same gate every other write
					 * surface runs. A flip that would leave the app with no
					 * participating form (or land any other finding) rejects with
					 * NOTHING dispatched: the doc and the stash stay exactly as
					 * they were. The findings announce as the error toast unless
					 * the caller renders them itself (`announce: false` — the
					 * enable dialog's footer). */
					const verdict = mutationCommitVerdict(docState, mutations);
					if (!verdict.ok) {
						if (opts?.announce !== false) {
							notifyRejectedCommit(verdict.introduced);
						}
						return {
							ok: false,
							messages: verdict.introduced.map((err) => err.message),
						};
					}
					/* Commit the validated candidate (one reducer run, one undo
					 * entry), THEN the stash — a pure state write that can't fail. */
					docStoreRef.getState().commitDoc(verdict.nextDoc);
					set({
						connectStash: nextStash,
						lastConnectType: currentType ?? s.lastConnectType,
					});
					return { ok: true };
				},

				stashFormConnect(
					mode: ConnectType,
					formUuid: string,
					config: ConnectConfig,
				) {
					const s = get();
					set({
						connectStash: {
							...s.connectStash,
							[mode]: {
								...s.connectStash[mode],
								[formUuid]: structuredClone(config),
							},
						},
					});
				},

				getFormConnectStash(
					mode: ConnectType,
					formUuid: string,
				): ConnectConfig | undefined {
					return get().connectStash[mode]?.[formUuid];
				},

				switchCursorMode(next: CursorMode) {
					const s = get();

					/* Guard: switching to the same mode is a no-op. Without this,
					 * entering pointer mode twice would overwrite the stash with
					 * `{ stashed: false }` (the already-closed sidebar values),
					 * losing the original pre-pointer state. */
					if (next === s.cursorMode) return;

					if (next === "pointer") {
						/* Stash current open values, then close both for the
						 * immersive pointer-mode experience. */
						set({
							cursorMode: next,
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

					/* next === "edit": restore stashed values if present,
					 * otherwise leave sidebars as-is. */
					const chatStashed = s.sidebars.chat.stashed;
					const structureStashed = s.sidebars.structure.stashed;
					set({
						cursorMode: next,
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

				setCursorMode(mode: CursorMode) {
					if (mode === get().cursorMode) return;
					set({ cursorMode: mode });
				},

				setActiveFieldId(fieldId: string | undefined) {
					if (fieldId === get().activeFieldId) return;
					set({ activeFieldId: fieldId });
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
					if (!record || record.status.state !== "uploading") return;
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

				reset() {
					/* Abort any in-flight staged uploads — their drivers hold
					 * closures into a session that's being torn down, so letting
					 * them run would attach into a dead store. */
					for (const abort of stagedUploadAborts.values()) abort();
					stagedUploadAborts.clear();
					set({
						/* Generation lifecycle */
						events: [],
						runStartedWithData: false,
						runCompletedAt: undefined,
						loading: false,

						/* App identity */
						appId: undefined,
						saveBasis: null,

						/* Replay */
						replay: undefined,

						/* Interaction */
						cursorMode: "edit" as CursorMode,
						activeFieldId: undefined,

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
						assetMeta: {} as Record<string, ExportBudgetRowView>,

						/* UI hints */
						focusHint: undefined as string | undefined,
						newFieldUuid: undefined as string | undefined,
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
