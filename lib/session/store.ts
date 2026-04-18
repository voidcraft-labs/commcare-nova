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
 * Generation lifecycle actions (`beginAgentWrite`, `endAgentWrite`,
 * `failAgentWrite`, `advanceStage`, `setFixAttempt`) bracket agent stream
 * writes and coordinate with the doc store's temporal middleware to
 * pause/resume undo tracking.
 */

import { devtools, subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { Mutation, Uuid } from "@/lib/doc/types";
import type { ConnectConfig, ConnectType } from "@/lib/domain";
import type { Event } from "@/lib/log/types";
import {
	type CursorMode,
	type GenerationError,
	GenerationStage,
	type PartialScaffoldData,
	type ReplayChapter,
	type ReplayData,
	STAGE_LABELS,
} from "./types";

// ── Public types ──────────────────────────────────────────────────────────

/** Which sidebar column to target in `setSidebarOpen`. */
export type SidebarKind = "chat" | "structure";

/**
 * Full state + actions for the BuilderSession store.
 *
 * Fields grouped by concern:
 *   - Generation lifecycle (`agentActive`, `agentStage`, `agentError`,
 *     `statusMessage`, `postBuildEdit`, `justCompleted`, `loading`) —
 *     what mode we're in during a build or edit.
 *   - App identity (`appId`) — current app being built/edited.
 *   - Generation UI (`partialScaffold`) — transient scaffold preview.
 *   - Replay (`replay`) — build replay playback data.
 *   - Interaction (`cursorMode`, `activeFieldId`) — how the user is editing.
 *   - Chrome (`sidebars`) — layout visibility + stash for mode transitions.
 *   - Connect stash — learn↔deliver toggle preservation.
 */
export interface BuilderSessionState {
	// ── Generation lifecycle ─────────────────────────────────────────────

	/** Whether the agent is currently streaming a build or edit. While
	 *  true, doc undo tracking is paused and the UI shows build progress. */
	agentActive: boolean;

	/** Current stage within a generation run — drives the status message
	 *  and signal grid animation. `null` when idle or between stages. */
	agentStage: GenerationStage | null;

	/** Error metadata during generation. The session stays agent-active;
	 *  this describes what went wrong (recovering = retrying, failed = done). */
	agentError: GenerationError;

	/** Human-readable status text derived from the current stage or error.
	 *  Displayed in the signal grid panel and progress UI. */
	statusMessage: string;

	/** True when the agent activated on an app that already had blueprint
	 *  data — distinguishes initial generation from post-build edits. */
	postBuildEdit: boolean;

	/** Transient flag set when agent completes. Drives the celebration
	 *  animation; cleared by `acknowledgeCompletion()` (auto-decay to
	 *  ready state). */
	justCompleted: boolean;

	/** Generic loading flag for async operations outside of agent writes
	 *  (e.g. initial app load, import). */
	loading: boolean;

	// ── App identity ─────────────────────────────────────────────────────

	/** Firestore app document ID for the current builder session. Set
	 *  once when the builder mounts; undefined for new builds before
	 *  the app document is created. */
	appId: string | undefined;

	// ── Generation UI state (transient) ─────────────────────────────────

	/** Intermediate scaffold data streamed before the full Scaffold arrives.
	 *  Drives the "building..." preview showing module/form names as they
	 *  arrive from the SA's `setScaffold` tool call. Cleared on agent
	 *  write completion. */
	partialScaffold: PartialScaffoldData | undefined;

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

	// ── Transient UI hints (one-shot, consumed by a single component) ────

	/** Transient field key to focus after undo/redo. Set by `useUndoRedo`,
	 *  consumed once by InlineSettingsPanel's `useFocusHintForSection` hook.
	 *  Cleared after the matching section reads it. */
	focusHint: string | undefined;

	/** UUID of a just-added question — activates auto-focus and select-all
	 *  on the ID input in ContextualEditorHeader. One-shot: set by
	 *  FieldTypePicker on add, consumed once by the header on mount. */
	newQuestionUuid: string | undefined;

	// ── Actions ───────────────────────────────────────────────────────────

	/** Install or clear the doc store reference. Called by SyncBridge when
	 *  the BlueprintDocProvider mounts/unmounts. */
	_setDocStore: (store: BlueprintDocStore | null) => void;

	// ── Generation lifecycle actions ─────────────────────────────────────

	/** Begin an agent write stream. Pauses doc undo tracking, sets
	 *  agentActive=true, and initializes the generation stage. If `stage`
	 *  is provided, sets the initial stage and status message from
	 *  STAGE_LABELS; otherwise starts with no stage. */
	beginAgentWrite: (stage?: GenerationStage) => void;

	/** Complete an agent write stream. Resumes doc undo tracking, clears
	 *  all generation-transient state, and sets justCompleted=true. */
	endAgentWrite: () => void;

	/** Record an error during generation without ending the agent write.
	 *  Sets agentError and statusMessage; agentActive remains true.
	 *  Defaults to "failed" severity when omitted. */
	failAgentWrite: (message: string, severity?: "recovering" | "failed") => void;

	/** Advance to a new generation stage. Maps the stage string to the
	 *  GenerationStage enum, updates the status message, and clears any
	 *  prior error. */
	advanceStage: (stage: string) => void;

	/** Update the status message with fix attempt progress details.
	 *  Called by the validation/fix loop to show "Fixing N error(s),
	 *  attempt M". */
	setFixAttempt: (attempt: number, errorCount: number) => void;

	/** Clear the justCompleted flag after the celebration animation
	 *  has played. No-ops when already false. */
	acknowledgeCompletion: () => void;

	/** Toggle agent active state with post-build-edit detection. When
	 *  activating, checks the doc store for existing blueprint data
	 *  to set postBuildEdit. No-ops when value unchanged. */
	setAgentActive: (active: boolean) => void;

	/** Set the app ID for this builder session. No-ops when unchanged. */
	setAppId: (id: string) => void;

	/** Set the generic loading flag. No-ops when unchanged. */
	setLoading: (loading: boolean) => void;

	/** Set or clear the partial scaffold preview data. */
	setPartialScaffold: (data: PartialScaffoldData | undefined) => void;

	// ── Replay actions ──────────────────────────────────────────────────

	/** Load a replay session from a raw event log + derived chapters.
	 *  `initialCursor` is the scrub position to mount at (typically
	 *  `events.length - 1` so the user lands on the final frame). */
	loadReplay: (init: {
		events: Event[];
		chapters: ReplayChapter[];
		initialCursor: number;
		exitPath: string;
	}) => void;

	/** Update the replay scrub cursor. No-ops when replay is not loaded —
	 *  cursor has no meaning outside an active replay session. */
	setReplayCursor: (cursor: number) => void;

	// ── Connect stash actions ────────────────────────────────────────────

	/** Switch the app-level connect mode, or toggle it off/on.
	 *
	 *  Passing a mode (`'learn'` or `'deliver'`) enables that mode — stashing
	 *  the outgoing mode's form configs and restoring the incoming mode's stash.
	 *
	 *  Passing `null` disables Connect entirely. Passing `undefined` re-enables
	 *  with the user's last active mode (falling back to `'learn'`).
	 *
	 *  Dispatches all doc changes as a single `applyMany` batch so the entire
	 *  mode switch collapses to one undo entry. */
	switchConnectMode: (type: ConnectType | null | undefined) => void;

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

	/** Set the transient focus hint — used by undo/redo to tell
	 *  InlineSettingsPanel which field to focus after restoration. */
	setFocusHint: (fieldId: string | undefined) => void;

	/** Clear the focus hint. Called by the consuming section after it reads
	 *  the hint, so other sections don't see a stale value. */
	clearFocusHint: () => void;

	/** Mark a question uuid as newly added — triggers auto-focus and
	 *  select-all on the ID input in ContextualEditorHeader. */
	markNewField: (uuid: string) => void;

	/** Check whether a uuid matches the current new-question marker.
	 *  Imperative reader — usable outside of selectors. */
	isNewField: (uuid: string) => boolean;

	/** Clear the new-question marker. Called after the first rename or
	 *  when the component unmounts, so subsequent selections behave normally. */
	clearNewField: () => void;

	/** Reset all transient session state to the initial values.
	 *
	 *  Called from `resetBuilder` (the composite reset helper used by
	 *  `ReplayController` when navigating between replay stages). Restores
	 *  all generation lifecycle, replay, cursor mode, sidebars, connect
	 *  stash, and one-shot UI hints to defaults. The private doc-store
	 *  reference installed by SyncBridge is NOT cleared — the provider's
	 *  effect owns its lifetime. */
	reset: () => void;
}

// ── Store API type ────────────────────────────────────────────────────────

/** The Zustand store API — used for context typing and test setup. */
export type BuilderSessionStoreApi = ReturnType<
	typeof createBuilderSessionStore
>;

// ── Helpers ──────────────────────────────────────────────────────────────

/** Map a generation stage string value to the GenerationStage enum member.
 *  Returns undefined if the string doesn't match any known stage. */
function parseStage(value: string): GenerationStage | undefined {
	return Object.values(GenerationStage).includes(value as GenerationStage)
		? (value as GenerationStage)
		: undefined;
}

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
}

/** Create a scoped Zustand session store. Called once per BuilderProvider
 *  mount — the parent provider's `buildId` controls the store lifetime.
 *
 *  @param init — optional initial overrides for lifecycle fields that must
 *  be correct before the first render (see `SessionStoreInit`). */
export function createBuilderSessionStore(init?: SessionStoreInit) {
	/* Non-reactive ref — lives outside Zustand state so it doesn't serialize
	 * to devtools and doesn't fire subscribers on install/clear. Read
	 * imperatively by `switchConnectMode`, `beginAgentWrite`, `endAgentWrite`,
	 * and `setAgentActive`. */
	let docStoreRef: BlueprintDocStore | null = null;

	return createStore<BuilderSessionState>()(
		devtools(
			subscribeWithSelector((set, get) => ({
				// ── Initial state ────────────────────────────────────────

				/* Generation lifecycle */
				agentActive: false,
				agentStage: null as GenerationStage | null,
				agentError: null as GenerationError,
				statusMessage: "",
				postBuildEdit: false,
				justCompleted: false,
				loading: init?.loading ?? false,

				/* App identity */
				appId: init?.appId as string | undefined,

				/* Generation UI state */
				partialScaffold: undefined as PartialScaffoldData | undefined,

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

				/* UI hints */
				focusHint: undefined as string | undefined,
				newQuestionUuid: undefined as string | undefined,

				// ── Reducer-shaped actions ───────────────────────────────

				_setDocStore(store: BlueprintDocStore | null) {
					docStoreRef = store;
				},

				// ── Generation lifecycle actions ─────────────────────────

				beginAgentWrite(stage?: GenerationStage) {
					/* Pause doc undo tracking so the entire agent write collapses
					 * to a single undo entry when tracking resumes. Uses the doc
					 * store's public API so any future behavior (e.g. snapshot
					 * markers) is automatically inherited. */
					docStoreRef?.getState().beginAgentWrite();

					set({
						agentActive: true,
						postBuildEdit: false,
						agentStage: stage ?? null,
						statusMessage: stage ? STAGE_LABELS[stage] : "",
						agentError: null,
						justCompleted: false,
						partialScaffold: undefined,
					});
				},

				endAgentWrite() {
					/* Resume doc undo tracking — the next user mutation starts
					 * a fresh undo entry. Uses the doc store's public API. */
					docStoreRef?.getState().endAgentWrite();

					/* Do NOT clear `agentActive` here. The chat transport status
					 * effect owns that lifecycle — it reads `wasActive` before
					 * calling `setAgentActive(false)`, and uses the transition to
					 * stamp `lastResponseAtRef` (Anthropic cache warmth signal).
					 * Clearing agentActive here would race with the effect and
					 * prevent the cache timestamp from being set.
					 *
					 * `justCompleted` takes priority in `derivePhase`, so setting
					 * it to true moves phase to Completed regardless of agentActive. */
					set({
						justCompleted: true,
						agentStage: null,
						agentError: null,
						statusMessage: "",
						partialScaffold: undefined,
					});
				},

				failAgentWrite(
					message: string,
					severity: "recovering" | "failed" = "failed",
				) {
					set({
						agentError: { message, severity },
						statusMessage: message,
					});
				},

				advanceStage(stageStr: string) {
					const stage = parseStage(stageStr);
					if (!stage) return;
					set({
						agentStage: stage,
						statusMessage: STAGE_LABELS[stage],
						agentError: null,
					});
				},

				setFixAttempt(attempt: number, errorCount: number) {
					const plural = errorCount === 1 ? "error" : "errors";
					set({
						statusMessage: `Fixing ${errorCount} ${plural}, attempt ${attempt}`,
					});
				},

				acknowledgeCompletion() {
					if (!get().justCompleted) return;
					set({ justCompleted: false });
				},

				setAgentActive(active: boolean) {
					if (active === get().agentActive) return;
					if (active) {
						/* Check whether the doc already has blueprint data — if so,
						 * this activation is a post-build edit, not initial generation. */
						const hasData =
							(docStoreRef?.getState().moduleOrder.length ?? 0) > 0;
						set({ agentActive: true, postBuildEdit: hasData });
					} else {
						set({ agentActive: false });
					}
				},

				setAppId(id: string) {
					if (id === get().appId) return;
					set({ appId: id });
				},

				setLoading(loading: boolean) {
					if (loading === get().loading) return;
					set({ loading });
				},

				setPartialScaffold(data: PartialScaffoldData | undefined) {
					set({ partialScaffold: data });
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
					set({ replay: { ...replay, cursor } });
				},

				// ── Connect stash actions ───────────────────────────────

				switchConnectMode(type: ConnectType | null | undefined) {
					if (!docStoreRef) return;
					const s = get();
					const docState = docStoreRef.getState();
					if (docState.moduleOrder.length === 0) return;

					const currentType = (docState.connectType ?? undefined) as
						| ConnectType
						| undefined;
					const resolved =
						type === undefined ? (s.lastConnectType ?? "learn") : type;

					/* Same-mode early return — no stash, no mutations. */
					if (resolved === currentType) return;

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

					/* Build doc mutations: setConnectType + restore/clear. */
					const mutations: Mutation[] = [
						{ kind: "setConnectType", connectType: resolved ?? null },
					];

					if (resolved) {
						/* Restore stashed configs onto forms by uuid. */
						const stashed = nextStash[resolved] ?? {};
						for (const [fUuid, config] of Object.entries(stashed)) {
							if (docState.forms[fUuid as Uuid]) {
								mutations.push({
									kind: "updateForm",
									uuid: fUuid as Uuid,
									patch: { connect: structuredClone(config) },
								});
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

					/* Commit doc first — applyMany is the operation that could fail.
					 * If it throws (malformed mutation), session state stays consistent
					 * with the pre-call doc state. The session stash update is a pure
					 * state write that cannot fail. */
					docStoreRef.getState().applyMany(mutations);
					set({
						connectStash: nextStash,
						lastConnectType: currentType ?? s.lastConnectType,
					});
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

				setFocusHint(fieldId: string | undefined) {
					if (fieldId === get().focusHint) return;
					set({ focusHint: fieldId });
				},

				clearFocusHint() {
					if (get().focusHint === undefined) return;
					set({ focusHint: undefined });
				},

				markNewField(uuid: string) {
					set({ newQuestionUuid: uuid });
				},

				isNewField(uuid: string): boolean {
					return get().newQuestionUuid === uuid;
				},

				clearNewField() {
					if (get().newQuestionUuid === undefined) return;
					set({ newQuestionUuid: undefined });
				},

				reset() {
					set({
						/* Generation lifecycle */
						agentActive: false,
						agentStage: null,
						agentError: null,
						statusMessage: "",
						postBuildEdit: false,
						justCompleted: false,
						loading: false,

						/* App identity */
						appId: undefined,

						/* Generation UI */
						partialScaffold: undefined,

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

						/* UI hints */
						focusHint: undefined as string | undefined,
						newQuestionUuid: undefined as string | undefined,
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
