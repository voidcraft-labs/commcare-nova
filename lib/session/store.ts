/**
 * BuilderSession store — ephemeral UI state for the builder.
 *
 * Owns cursor mode, sidebar visibility + stash, and active field tracking.
 * Everything here lives only while the builder route is mounted and is NEVER
 * undoable. Separated from BlueprintDoc so UI state can't bleed into undo
 * history and there's no need for a partialize allow-list.
 *
 * Middleware: `subscribeWithSelector` (targeted subscriptions) + `devtools`
 * (Redux DevTools in development). No Immer (shape is flat enough), no zundo
 * (nothing undoable).
 *
 * Actions are reducer-shaped where atomicity matters. `switchCursorMode` is
 * the canonical example — it stashes/restores sidebar visibility in a single
 * `set()` call so intermediate states never leak to subscribers.
 */

import { devtools, subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { Mutation, Uuid } from "@/lib/doc/types";
import type { ConnectConfig, ConnectType } from "@/lib/schemas/blueprint";
import type { CursorMode } from "./types";

// ── Public types ──────────────────────────────────────────────────────────

/** Which sidebar column to target in `setSidebarOpen`. */
export type SidebarKind = "chat" | "structure";

/**
 * Full state + actions for the BuilderSession store.
 *
 * Fields grouped by concern:
 *   - Interaction (`cursorMode`, `activeFieldId`) — how the user is editing.
 *   - Chrome (`sidebars`) — layout visibility + stash for mode transitions.
 */
export interface BuilderSessionState {
	/** Current cursor mode — "pointer" (interact/live preview) or "edit"
	 *  (click-to-select + inline text editing). */
	cursorMode: CursorMode;

	/** Which `[data-field-id]` element currently has focus. Transient UI hint,
	 *  not undoable. Used by composite undo/redo to restore focus after the
	 *  temporal state rolls back. */
	activeFieldId: string | undefined;

	/** Sidebar visibility with stash support for cursor mode transitions.
	 *  `stashed` records the pre-pointer-mode `open` value; `undefined` means
	 *  nothing is stashed. `switchCursorMode` writes both fields atomically. */
	sidebars: {
		chat: { open: boolean; stashed: boolean | undefined };
		structure: { open: boolean; stashed: boolean | undefined };
	};

	// ── Connect stash (ephemeral, not undoable) ──────────────────────────

	/** Reference to the BlueprintDoc store — installed by SyncBridge after
	 *  both providers mount. Used by `switchConnectMode` to dispatch doc
	 *  mutations atomically alongside session-state updates. */
	_docStore: BlueprintDocStore | null;

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

	// ── Actions ───────────────────────────────────────────────────────────

	/** Install or clear the doc store reference. Called by SyncBridge when
	 *  the BlueprintDocProvider mounts/unmounts. */
	_setDocStore: (store: BlueprintDocStore | null) => void;

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
}

// ── Store API type ────────────────────────────────────────────────────────

/** The Zustand store API — used for context typing and test setup. */
export type BuilderSessionStoreApi = ReturnType<
	typeof createBuilderSessionStore
>;

// ── Factory ───────────────────────────────────────────────────────────────

/** Create a scoped Zustand session store. Called once per BuilderProvider
 *  mount — the parent provider's `buildId` controls the store lifetime. */
export function createBuilderSessionStore() {
	return createStore<BuilderSessionState>()(
		devtools(
			subscribeWithSelector((set, get) => ({
				// ── Initial state ────────────────────────────────────────
				cursorMode: "edit" as CursorMode,
				activeFieldId: undefined,
				sidebars: {
					chat: { open: true, stashed: undefined },
					structure: { open: true, stashed: undefined },
				},
				_docStore: null,
				connectStash: { learn: {}, deliver: {} } as Record<
					ConnectType,
					Record<string, ConnectConfig>
				>,
				lastConnectType: undefined as ConnectType | undefined,

				// ── Reducer-shaped actions ───────────────────────────────

				_setDocStore(store: BlueprintDocStore | null) {
					set({ _docStore: store });
				},

				switchConnectMode(type: ConnectType | null | undefined) {
					const s = get();
					const docStore = s._docStore;
					if (!docStore) return;
					const docState = docStore.getState();
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

					/* Atomic commit: update session state AND doc state.
					 * Doc's applyMany collapses into one undo entry; the session
					 * state change is not undoable (intended — stash is transient). */
					set({
						connectStash: nextStash,
						lastConnectType: currentType ?? s.lastConnectType,
					});
					docStore.getState().applyMany(mutations);
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
			})),
			{
				name: "BuilderSession",
				enabled: process.env.NODE_ENV === "development",
			},
		),
	);
}
