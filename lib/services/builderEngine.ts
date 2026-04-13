/**
 * BuilderEngine — thin adapter between the Zustand store and the DOM.
 *
 * The Zustand store (`builderStore.ts`) holds ALL reactive state and mutation
 * actions. The engine holds only non-reactive imperative state that doesn't
 * belong in the store:
 *
 * - **Energy counters** — consumed by SignalGrid's rAF loop, never triggers renders
 * - **Edit guard** — blocks selection changes when an editor has unsaved content
 * - **Drag state** — blocks undo during dnd-kit drag operations
 * - **Focus/panel hints** — one-shot transient state consumed by specific components
 * - **Edit scope** — signal grid zone focus
 * - **Connect stash** — session state for mode switching (not undoable)
 *
 * The engine also provides DOM helpers (scroll, undo highlight flash) and
 * connect-mode stash management used by routing hooks and form editors.
 */

import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { Mutation } from "@/lib/doc/types";
import { EngineController } from "@/lib/preview/engine/engineController";
import type { ConnectConfig, ConnectType } from "@/lib/schemas/blueprint";
import type { EditFocus } from "@/lib/signalGridController";
import { BuilderPhase, type EditScope, GenerationStage } from "./builder";
import { type BuilderStoreApi, createBuilderStore } from "./builderStore";
import { countQuestionsDeep } from "./normalizedState";

// ── Re-export types consumers need ──────────────────────────────────────

export type { CursorMode } from "./builderStore";

// ── BuilderEngine ───────────────────────────────────────────────────────

export class BuilderEngine {
	/** The Zustand store — holds all reactive state and mutation actions.
	 *  Provided to components via StoreContext. */
	readonly store: BuilderStoreApi;

	/** Form engine controller — manages the UUID-keyed runtime store for
	 *  test-mode values, computed visibility, validation, and expression
	 *  evaluation. Lives here (not in a React hook) so its lifecycle matches
	 *  the builder, not the component tree. */
	readonly engineController: EngineController;

	// ── Non-reactive state (never triggers React re-renders) ────────────

	/** Accumulated burst energy from data parts. Drained by SignalGrid rAF loop. */
	private _streamEnergy = 0;
	/** Accumulated token/reasoning energy. Drained by SignalGrid rAF loop. */
	private _thinkEnergy = 0;
	/** Current agent edit zone — read by computeEditFocus(). */
	private _editScope: EditScope | null = null;
	/** Callback that can block select() when an inline editor has unsaved content. */
	private _editGuard: (() => boolean) | null = null;
	/** Transient field key to focus after undo/redo. Consumed once by InlineSettingsPanel. */
	private _focusHint: string | undefined;
	/** Blocks undo/redo during dnd-kit drag operations. */
	private _isDragging = false;
	/** Transient rename notice — set after a cross-level move auto-renames
	 *  to avoid a sibling ID collision. Consumed once by ContextualEditorHeader
	 *  to show an inline notice on the ID field. */
	private _renameNotice:
		| { oldId: string; newId: string; xpathFieldsRewritten: number }
		| undefined;
	/** UUID of a just-added question — activates auto-focus and select-all behaviors. */
	private _newQuestionUuid?: string;
	/** Tracks whether post-build edits have mutated the blueprint (gates Completed phase). */
	private _editMadeMutations = false;

	/** Reference to the doc store — installed by SyncBridge when the provider
	 *  mounts, cleared on unmount. All entity mutations route through this
	 *  store when available; the legacy store is populated by the sync adapter. */
	private _docStore: BlueprintDocStore | null = null;

	// ── Connect stash (session state, not undoable) ─────────────────────

	/** Preserved form connect configs across mode switches. */
	private _connectStash = {
		learn: new Map<number, Map<number, ConnectConfig>>(),
		deliver: new Map<number, Map<number, ConnectConfig>>(),
	};
	/** Last active connect type — restored on toggle off/on. */
	private _lastConnectType: ConnectType | undefined;

	constructor(initialPhase: BuilderPhase = BuilderPhase.Idle) {
		this.store = createBuilderStore(initialPhase);
		/* Pause undo tracking until the app is loaded (existing) or generated
		 * (new). Without this, the empty→populated hydration transition creates
		 * an undoable entry whose undo restores a blank state. Call sites resume
		 * tracking after loadApp() or completeGeneration(). */
		this.store.temporal.getState().pause();

		/* Initialize the form engine controller and connect it to the blueprint
		 * store. The controller creates its own UUID-keyed runtime store —
		 * components subscribe to it for test-mode values and computed state. */
		this.engineController = new EngineController();
		this.engineController.setBlueprintStore(this.store);
	}

	// ── Convenience readers (non-reactive, for imperative code) ─────────

	get isReady(): boolean {
		const phase = this.store.getState().phase;
		return phase === BuilderPhase.Ready || phase === BuilderPhase.Completed;
	}

	get isGenerating(): boolean {
		return this.store.getState().phase === BuilderPhase.Generating;
	}

	get isThinking(): boolean {
		const s = this.store.getState();
		return s.agentActive && s.phase !== BuilderPhase.Generating;
	}

	/** Scaffold progress (0-1) derived from current state. Polled by SignalGrid rAF loop. */
	get scaffoldProgress(): number {
		const s = this.store.getState();
		if (s.phase !== BuilderPhase.Generating) return this.isReady ? 1.0 : 0;
		if (s.generationStage === GenerationStage.DataModel)
			return s.caseTypes.length > 0 ? 0.3 : 0.05;
		if (s.generationStage === GenerationStage.Structure) {
			const gen = s.generationData;
			if (gen?.scaffold) return 0.85;
			if (gen?.partialScaffold) return 0.55;
			return 0.35;
		}
		return 1.0;
	}

	// ── Focus hint (transient — consumed once by InlineSettingsPanel) ────

	get focusHint(): string | undefined {
		return this._focusHint;
	}

	/** Set the transient focus hint — used by undo/redo to tell
	 *  InlineSettingsPanel which field to focus after restoration. */
	setFocusHint(fieldId: string | undefined): void {
		this._focusHint = fieldId;
	}

	clearFocusHint(): void {
		this._focusHint = undefined;
	}

	// ── Rename notice (transient — consumed once by ContextualEditorHeader) ──

	get renameNotice() {
		return this._renameNotice;
	}

	setRenameNotice(notice: {
		oldId: string;
		newId: string;
		xpathFieldsRewritten: number;
	}): void {
		this._renameNotice = notice;
	}

	consumeRenameNotice() {
		const notice = this._renameNotice;
		this._renameNotice = undefined;
		return notice;
	}

	// ── New question state ──────────────────────────────────────────────

	markNewQuestion(uuid: string): void {
		this._newQuestionUuid = uuid;
	}

	isNewQuestion(uuid: string): boolean {
		return this._newQuestionUuid === uuid;
	}

	clearNewQuestion(): void {
		this._newQuestionUuid = undefined;
	}

	// ── Edit guard ──────────────────────────────────────────────────────

	/** Run the edit guard callback. Returns true if selection can proceed
	 *  (no guard installed, or guard says OK). Used by routing hooks to
	 *  gate URL-driven selection changes when an inline editor has unsaved
	 *  content (e.g. XPath editor with uncommitted edits). */
	checkEditGuard(): boolean {
		if (!this._editGuard) return true;
		return this._editGuard();
	}

	setEditGuard(guard: () => boolean): void {
		this._editGuard = guard;
	}

	clearEditGuard(): void {
		this._editGuard = null;
	}

	// ── Doc store reference ────────────────────────────────────────────

	/** Install or clear the doc store reference. Called by SyncBridge when
	 *  the BlueprintDocProvider mounts/unmounts. Entity mutations and
	 *  undo/redo route through this store when installed. */
	setDocStore(store: BlueprintDocStore | null): void {
		this._docStore = store;
	}

	/** Current doc store, or null before SyncBridge has mounted. */
	get docStore(): BlueprintDocStore | null {
		return this._docStore;
	}

	// ── Drag state ──────────────────────────────────────────────────────

	setDragging(active: boolean): void {
		this._isDragging = active;
	}

	get isDragging(): boolean {
		return this._isDragging;
	}

	// ── Energy (non-reactive — consumed by SignalGrid rAF loop) ─────────

	injectEnergy(amount: number): void {
		this._streamEnergy += amount;
	}

	injectThinkEnergy(amount: number): void {
		this._thinkEnergy += amount;
	}

	drainEnergy(): number {
		const e = this._streamEnergy;
		this._streamEnergy = 0;
		return e;
	}

	drainThinkEnergy(): number {
		const e = this._thinkEnergy;
		this._thinkEnergy = 0;
		return e;
	}

	// ── Edit focus (non-reactive — signal grid zone) ────────────────────

	setEditScope(scope: EditScope | null): void {
		this._editScope = scope;
	}

	computeEditFocus(): EditFocus | null {
		const s = this.store.getState();
		if (s.moduleOrder.length === 0 || !this._editScope) return null;

		/* Count total questions and build positional map for each form */
		let total = 0;
		const formPositions: Array<{
			moduleIndex: number;
			formIndex: number;
			start: number;
			count: number;
		}> = [];

		for (let mi = 0; mi < s.moduleOrder.length; mi++) {
			const moduleId = s.moduleOrder[mi];
			const formIds = s.formOrder[moduleId] ?? [];
			for (let fi = 0; fi < formIds.length; fi++) {
				const formId = formIds[fi];
				const count = countQuestionsDeep(s.questionOrder, formId);
				formPositions.push({
					moduleIndex: mi,
					formIndex: fi,
					start: total,
					count,
				});
				total += count;
			}
		}

		if (total === 0) return null;

		const scope = this._editScope;

		if (scope.formIndex == null) {
			const modForms = formPositions.filter(
				(f) => f.moduleIndex === scope.moduleIndex,
			);
			if (modForms.length === 0) return null;
			const start = modForms[0].start / total;
			const end =
				(modForms[modForms.length - 1].start +
					modForms[modForms.length - 1].count) /
				total;
			return clampEditFocus(start, end);
		}

		const form = formPositions.find(
			(f) =>
				f.moduleIndex === scope.moduleIndex && f.formIndex === scope.formIndex,
		);
		if (!form || form.count === 0) return null;

		if (scope.questionIndex != null) {
			const qPos =
				(form.start + Math.min(scope.questionIndex, form.count - 1)) / total;
			const halfZone = Math.max(MIN_EDIT_ZONE / 2, (form.count / total) * 0.3);
			return clampEditFocus(qPos - halfZone, qPos + halfZone);
		}

		return clampEditFocus(
			form.start / total,
			(form.start + form.count) / total,
		);
	}

	/**
	 * Find a specific field element within a question's InlineSettingsPanel.
	 * Queries by stable UUID so the element is found even after renames.
	 */
	findFieldElement(questionUuid: string, fieldId?: string): HTMLElement | null {
		if (!fieldId) return null;
		const questionEl = document.querySelector(
			`[data-question-uuid="${questionUuid}"]`,
		) as HTMLElement | null;
		const panel = questionEl?.nextElementSibling as HTMLElement | null;
		if (!panel?.hasAttribute("data-settings-panel")) return null;
		return panel.querySelector(`[data-field-id="${fieldId}"]`);
	}

	/** Flash a subtle violet highlight on an element to signal an undo/redo
	 *  state change. Web Animations API — fire-and-forget, no cleanup needed.
	 *  Toggles get a scale press instead of a backgroundColor overlay. */
	flashUndoHighlight(el: HTMLElement): void {
		if (el.getAttribute("role") === "switch") {
			el.animate(
				[
					{ transform: "scale(1)" },
					{ transform: "scale(0.8)" },
					{ transform: "scale(1)" },
				],
				{ duration: 300, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
			);
			return;
		}
		el.animate(
			[
				{ backgroundColor: "rgba(139, 92, 246, 0.12)" },
				{ backgroundColor: "transparent" },
			],
			{ duration: 600, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
		);
	}

	// ── Connect stash ───────────────────────────────────────────────────

	/**
	 * Switch the app-level connect mode, or toggle it off/on.
	 *
	 * Passing a mode (`'learn'` or `'deliver'`) enables that mode — stashing
	 * the outgoing mode's form configs and restoring the incoming mode's stashed configs.
	 *
	 * Passing `null` disables Connect entirely. Passing `undefined` re-enables
	 * with the user's last active mode (falling back to `'learn'` for first-time enable).
	 *
	 * Dispatches all changes as a single `applyMany` batch so the entire
	 * mode switch collapses to one undo entry.
	 */
	switchConnectMode(type: ConnectType | null | undefined): void {
		if (!this._docStore) return;
		const docState = this._docStore.getState();
		if (docState.moduleOrder.length === 0) return;

		const currentType = docState.connectType ?? undefined;
		const resolved =
			type === undefined ? (this._lastConnectType ?? "learn") : type;

		if (resolved === currentType) return;

		/* Stash outgoing mode's form configs (reads directly from the doc store). */
		if (currentType) {
			this._lastConnectType = currentType;
			this.stashAllFormConnect(currentType);
		}

		/* Build a batch of mutations: setConnectType + one updateForm per form
		 * whose connect config needs to change. */
		const mutations: Mutation[] = [
			{ kind: "setConnectType", connectType: resolved ?? null },
		];

		if (resolved) {
			/* Restore stashed configs onto forms by uuid. */
			for (const [mIdx, moduleMap] of this._connectStash[resolved]) {
				const moduleUuid = docState.moduleOrder[mIdx];
				if (!moduleUuid) continue;
				const formUuids = docState.formOrder[moduleUuid] ?? [];
				for (const [fIdx, config] of moduleMap) {
					const formUuid = formUuids[fIdx];
					if (!formUuid) continue;
					mutations.push({
						kind: "updateForm",
						uuid: formUuid,
						patch: { connect: structuredClone(config) },
					});
				}
			}
		} else {
			/* Disabling connect entirely: clear `connect` on every form. */
			for (const modUuid of docState.moduleOrder) {
				const formUuids = docState.formOrder[modUuid] ?? [];
				for (const formUuid of formUuids) {
					const form = docState.forms[formUuid];
					if (form?.connect !== undefined) {
						mutations.push({
							kind: "updateForm",
							uuid: formUuid,
							patch: { connect: undefined },
						});
					}
				}
			}
		}

		this._docStore.getState().applyMany(mutations);
	}

	/** Stash a single form's connect config. Used by form-level toggles. */
	stashFormConnect(
		mode: ConnectType,
		mIdx: number,
		fIdx: number,
		config: ConnectConfig,
	): void {
		const stash = this._connectStash[mode];
		let moduleMap = stash.get(mIdx);
		if (!moduleMap) {
			moduleMap = new Map();
			stash.set(mIdx, moduleMap);
		}
		moduleMap.set(fIdx, structuredClone(config));
	}

	/** Get a single form's stashed connect config (does not remove it). */
	getFormConnectStash(
		mode: ConnectType,
		mIdx: number,
		fIdx: number,
	): ConnectConfig | undefined {
		return this._connectStash[mode].get(mIdx)?.get(fIdx);
	}

	/** Stash all forms' connect configs from the doc store. */
	private stashAllFormConnect(mode: ConnectType): void {
		const docState = this._docStore?.getState();
		if (!docState) return;
		const stash = this._connectStash[mode];
		stash.clear();

		for (let mIdx = 0; mIdx < docState.moduleOrder.length; mIdx++) {
			const moduleUuid = docState.moduleOrder[mIdx];
			const formUuids = docState.formOrder[moduleUuid] ?? [];
			for (let fIdx = 0; fIdx < formUuids.length; fIdx++) {
				const form = docState.forms[formUuids[fIdx]];
				if (form?.connect) {
					let moduleMap = stash.get(mIdx);
					if (!moduleMap) {
						moduleMap = new Map();
						stash.set(mIdx, moduleMap);
					}
					moduleMap.set(fIdx, structuredClone(form.connect));
				}
			}
		}
	}

	// ── Agent status ────────────────────────────────────────────────────

	setAgentActive(active: boolean): void {
		const s = this.store.getState();
		if (s.agentActive === active) return;

		s.setAgentActive(active);

		/* Track whether post-build edits produced mutations for Completed phase gating. */
		if (
			active &&
			(s.phase === BuilderPhase.Ready || s.phase === BuilderPhase.Completed)
		) {
			this._editMadeMutations = false;
		}

		if (!active && s.postBuildEdit && this._editMadeMutations) {
			this._editMadeMutations = false;
		}
	}

	/** Mark that a post-build edit made mutations (for Completed phase gating). */
	markEditMadeMutations(): void {
		this._editMadeMutations = true;
	}

	get editMadeMutations(): boolean {
		return this._editMadeMutations;
	}

	// ── Reset ───────────────────────────────────────────────────────────

	reset(): void {
		this._streamEnergy = 0;
		this._thinkEnergy = 0;
		this._editScope = null;
		this._editGuard = null;
		this._newQuestionUuid = undefined;
		this._editMadeMutations = false;
		this._connectStash.learn.clear();
		this._connectStash.deliver.clear();
		this._lastConnectType = undefined;
		this.store.getState().reset();
		/* Clear undo history and pause tracking — the engine is back to its
		 * initial state, so the next loadApp/generation hydration should be
		 * invisible to undo just like the first one. */
		const temporal = this.store.temporal.getState();
		temporal.clear();
		temporal.pause();
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────

const MIN_EDIT_ZONE = 0.15;

function clampEditFocus(start: number, end: number): EditFocus {
	let width = end - start;
	if (width < MIN_EDIT_ZONE) {
		const center = (start + end) / 2;
		start = center - MIN_EDIT_ZONE / 2;
		end = center + MIN_EDIT_ZONE / 2;
		width = MIN_EDIT_ZONE;
	}
	if (start < 0) {
		end -= start;
		start = 0;
	}
	if (end > 1) {
		start -= end - 1;
		end = 1;
	}
	return { start: Math.max(0, start), end: Math.min(1, end) };
}
