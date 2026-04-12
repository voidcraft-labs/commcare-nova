/**
 * BuilderEngine — thin adapter between the Zustand store and the DOM.
 *
 * The Zustand store (`builderStore.ts`) holds ALL reactive state and mutation
 * actions. The engine holds only non-reactive imperative state that doesn't
 * belong in the store:
 *
 * - **Energy counters** — consumed by SignalGrid's rAF loop, never triggers renders
 * - **Scroll callback** — DOM scroll implementation registered by BuilderLayout
 * - **Edit guard** — blocks selection changes when an editor has unsaved content
 * - **Drag state** — blocks undo during dnd-kit drag operations
 * - **Focus/panel hints** — one-shot transient state consumed by specific components
 * - **Edit scope** — signal grid zone focus
 * - **Connect stash** — session state for mode switching (not undoable)
 *
 * The engine also provides composing methods that combine store actions with
 * DOM side effects (e.g., `navigateTo` = store select + scroll callback).
 */

import { flushSync } from "react-dom";
import { EngineController } from "@/lib/preview/engine/engineController";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import type { ConnectConfig, ConnectType } from "@/lib/schemas/blueprint";
import type { EditFocus } from "@/lib/signalGridController";
import {
	BuilderPhase,
	type EditScope,
	GenerationStage,
	type SelectedElement,
} from "./builder";
import { type BuilderStoreApi, createBuilderStore } from "./builderStore";
import { assembleForm, countQuestionsDeep } from "./normalizedState";
import { flattenQuestionRefs } from "./questionPath";

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
	/** Scroll implementation owned by BuilderLayout. Fulfilled by the panel
	 *  mount effect when a pending scroll request exists. */
	private _scrollCallback:
		| ((
				questionUuid: string,
				overrideTarget?: HTMLElement,
				behavior?: ScrollBehavior,
				hasToolbar?: boolean,
		  ) => void)
		| null = null;
	/** Pending scroll request — set by `navigateTo()`, consumed by the
	 *  selected question's mount effect. This decouples intent ("scroll to
	 *  this question") from timing ("the panel is in the DOM and ready").
	 *  Carries the target UUID and desired scroll behavior so cross-screen
	 *  navigations can request instant scroll (smooth is meaningless when
	 *  the entire form content swaps out). */
	private _pendingScroll:
		| { uuid: string; behavior: ScrollBehavior; hasToolbar: boolean }
		| undefined;
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

	setEditGuard(guard: () => boolean): void {
		this._editGuard = guard;
	}

	clearEditGuard(): void {
		this._editGuard = null;
	}

	// ── Scroll ─────────────────────────────────────────────────────────

	/** Register the DOM scroll implementation owned by BuilderLayout. */
	registerScrollCallback(
		cb: (
			questionUuid: string,
			overrideTarget?: HTMLElement,
			behavior?: ScrollBehavior,
			hasToolbar?: boolean,
		) => void,
	): void {
		this._scrollCallback = cb;
	}

	clearScrollCallback(): void {
		this._scrollCallback = null;
	}

	/** Consume the pending scroll request if it matches the given UUID.
	 *  Called by the selected question's mount effect — the panel is in the
	 *  DOM and ready to be measured. Returns true if a scroll was executed. */
	fulfillPendingScroll(questionUuid: string): boolean {
		if (this._pendingScroll?.uuid !== questionUuid) return false;
		const { behavior, hasToolbar } = this._pendingScroll;
		this._pendingScroll = undefined;
		this._scrollCallback?.(questionUuid, undefined, behavior, hasToolbar);
		return true;
	}

	/** Directly scroll to a question without pending — used by undo/redo
	 *  where `flushSync` guarantees the DOM is already committed, and by
	 *  text-editable activation on an already-selected question. */
	scrollToQuestion(
		questionUuid: string,
		overrideTarget?: HTMLElement,
		behavior?: ScrollBehavior,
		hasToolbar?: boolean,
	): void {
		this._scrollCallback?.(questionUuid, overrideTarget, behavior, hasToolbar);
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

	// ── Selection with guard + scroll ───────────────────────────────────

	/** Pure state update — sets the selected element without any UI side effects.
	 *  Use for state maintenance (rename path update, deselect). */
	select(el?: SelectedElement): void {
		if (this._editGuard && !this._editGuard()) return;
		this.store.getState().select(el);
	}

	/** Navigate to a question — sets selection and requests a scroll.
	 *  The scroll executes when the selected question's panel mounts and
	 *  calls `fulfillPendingScroll()` from its effect. This guarantees the
	 *  panel is in the DOM before any position measurement — no flushSync,
	 *  no rAF, no collapsing-panel compensation.
	 *
	 *  `behavior` defaults to `"smooth"` for same-screen navigation (panel
	 *  swap within the same form). Cross-screen callers pass `"instant"`
	 *  because the entire form content swaps out — smooth scrolling from a
	 *  stale scroll position produces a disorienting animation. */
	navigateTo(
		el: SelectedElement,
		behavior: ScrollBehavior = "smooth",
		hasToolbar = false,
	): void {
		if (el.questionUuid) {
			this._pendingScroll = { uuid: el.questionUuid, behavior, hasToolbar };
		}
		this.select(el);
	}

	// ── Navigation + selection sync ─────────────────────────────────────
	//
	// These methods combine store navigation actions with tree selection
	// sync. Previously scattered as callbacks in BuilderLayout, but the
	// logic is a pure engine concern: store writes + optional scroll.

	/**
	 * Map a navigation screen to the corresponding tree selection element.
	 * Home → deselect, module → module selection, form/caseList → form selection.
	 */
	private syncSelectionToScreen(screen: PreviewScreen): void {
		if (screen.type === "home") {
			this.select();
		} else if (screen.type === "module") {
			this.select({ type: "module", moduleIndex: screen.moduleIndex });
		} else {
			/* form | caseList — both carry moduleIndex + formIndex */
			this.select({
				type: "form",
				moduleIndex: screen.moduleIndex,
				formIndex: screen.formIndex,
			});
		}
	}

	/** Navigate back in history and sync tree selection to the resulting screen. */
	navBackWithSync(): void {
		const newScreen = this.store.getState().navBack();
		if (newScreen) this.syncSelectionToScreen(newScreen);
	}

	/** Navigate up to parent screen and sync tree selection. */
	navUpWithSync(): void {
		this.store.getState().navUp();
		this.syncSelectionToScreen(this.store.getState().screen);
	}

	/** Push a screen and sync tree selection to match. Used by breadcrumb
	 *  clicks and any navigation that should update the tree highlight. */
	navigateToScreen(screen: PreviewScreen): void {
		this.store.getState().navPush(screen);
		this.syncSelectionToScreen(screen);
	}

	/**
	 * Handle tree selection: navigate engine (select + scroll) and push the
	 * correct preview screen. Combines `navigateTo()` (scroll side effect)
	 * with screen-level navigation based on the selection type.
	 *
	 * Uses instant scroll because tree clicks typically trigger a screen
	 * change (different form/module) — the entire content swaps out, so
	 * smooth scrolling from the old scroll position is disorienting. For
	 * same-form clicks the screen key is unchanged and AnimatePresence
	 * doesn't re-mount, so instant still feels natural. */
	navigateToSelection(sel: SelectedElement): void {
		this.navigateTo(sel, "instant");
		const s = this.store.getState();
		if (!sel) {
			s.navigateToHome();
			return;
		}
		if (s.moduleOrder.length === 0) return;
		if (sel.formIndex !== undefined) {
			/* Preserve the current caseId when navigating between forms in the
			 * same module — the user might be reviewing a specific case. */
			const currentCaseId =
				s.screen.type === "form" ? s.screen.caseId : undefined;
			s.navigateToForm(sel.moduleIndex, sel.formIndex, currentCaseId);
		} else {
			s.navigateToModule(sel.moduleIndex);
		}
	}

	// ── Undo/Redo ──────────────────────────────────────────────────────
	//
	// These methods encapsulate the full undo/redo flow: temporal store
	// action + flushSync (for immediate DOM commit) + scroll + flash.
	// Previously scattered as callbacks in BuilderLayout, but the logic
	// is purely imperative coordination — no React hooks needed.

	/**
	 * Undo the last mutation and scroll to the affected field with a
	 * violet flash highlight.
	 *
	 * zundo atomically restores entity data + navigation state. `flushSync`
	 * forces React to commit the store update before DOM queries — fields
	 * toggled into existence by the undo are immediately queryable.
	 */
	undo(): void {
		this.applyUndoRedo("undo");
	}

	/** Redo the last undone mutation. Same flow as undo. */
	redo(): void {
		this.applyUndoRedo("redo");
	}

	/** Shared implementation for undo/redo. */
	private applyUndoRedo(action: "undo" | "redo"): void {
		const temporal = this.store.temporal.getState();
		const canDo =
			action === "undo"
				? temporal.pastStates.length > 0
				: temporal.futureStates.length > 0;
		if (!canDo) return;

		/* Execute the undo/redo — zundo atomically restores entity data +
		 * screen + navEntries + navCursor + cursorMode + activeFieldId.
		 * flushSync ensures React commits the external store update to the
		 * DOM synchronously so element queries below find the right targets. */
		flushSync(() => {
			temporal[action]();
		});

		/* Read selected + activeFieldId from the LIVE store (excluded from
		 * partialize — they're derived from the restored entity state). */
		const s = this.store.getState();
		const questionUuid = s.selected?.questionUuid;
		if (!questionUuid) return;
		const fieldId = s.activeFieldId;

		/* Set focus hint so InlineSettingsPanel can consume it. */
		if (fieldId) {
			this.setFocusHint(fieldId);
		}

		/* Instant scroll + flash — undo/redo is a state-change affordance
		 * ("this changed"), not navigation. Target the specific field wrapper
		 * if activeFieldId names one, otherwise the question card itself. */
		const targetEl = this.findFieldElement(questionUuid, fieldId);
		this.scrollToQuestion(questionUuid, targetEl ?? undefined, "instant");
		const flashEl =
			targetEl ??
			(document.querySelector(
				`[data-question-uuid="${questionUuid}"]`,
			) as HTMLElement | null);
		if (flashEl) this.flashUndoHighlight(flashEl);
	}

	/**
	 * Find a specific field element within a question's InlineSettingsPanel.
	 * Queries by stable UUID so the element is found even after renames.
	 */
	private findFieldElement(
		questionUuid: string,
		fieldId?: string,
	): HTMLElement | null {
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
	private flashUndoHighlight(el: HTMLElement): void {
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

	// ── Delete ──────────────────────────────────────────────────────────

	/** Delete the currently selected question and navigate to the adjacent one. */
	deleteSelected(): void {
		const s = this.store.getState();
		const sel = s.selected;
		if (
			!sel ||
			sel.type !== "question" ||
			sel.formIndex === undefined ||
			!sel.questionPath
		)
			return;

		/* Assemble the form from normalized entities to get the question tree
		 * for adjacency lookup (flattenQuestionRefs). */
		const moduleId = s.moduleOrder[sel.moduleIndex];
		const formId = moduleId
			? s.formOrder[moduleId]?.[sel.formIndex]
			: undefined;
		const formEntity = formId ? s.forms[formId] : undefined;
		if (!formId || !formEntity) return;
		const form = assembleForm(formEntity, formId, s.questions, s.questionOrder);

		const refs = flattenQuestionRefs(form.questions);
		const curIdx = refs.findIndex((r) => r.uuid === sel.questionUuid);
		const next = refs[curIdx + 1] ?? refs[curIdx - 1];

		s.removeQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath);

		if (next) {
			this.navigateTo({
				type: "question",
				moduleIndex: sel.moduleIndex,
				formIndex: sel.formIndex,
				questionPath: next.path,
				questionUuid: next.uuid,
			});
		} else {
			this.select();
		}
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
	 */
	switchConnectMode(type: ConnectType | null | undefined): void {
		const s = this.store.getState();
		if (s.moduleOrder.length === 0) return;

		const currentType = s.connectType as ConnectType | undefined;
		const resolved =
			type === undefined ? (this._lastConnectType ?? "learn") : type;

		if (resolved === currentType) return;

		/* Stash outgoing mode's form configs */
		if (currentType) {
			this._lastConnectType = currentType;
			this.stashAllFormConnect(currentType);
		}

		/* Apply the new mode via store's setState with Immer */
		this.store.setState((draft) => {
			if (resolved) {
				draft.connectType = resolved;
				this.restoreAllFormConnect(draft, resolved);
			} else {
				draft.connectType = undefined;
			}
		});
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

	/** Stash all forms' connect configs from the current store state. */
	private stashAllFormConnect(mode: ConnectType): void {
		const s = this.store.getState();
		const stash = this._connectStash[mode];
		stash.clear();

		for (let mIdx = 0; mIdx < s.moduleOrder.length; mIdx++) {
			const moduleId = s.moduleOrder[mIdx];
			const formIds = s.formOrder[moduleId] ?? [];
			for (let fIdx = 0; fIdx < formIds.length; fIdx++) {
				const form = s.forms[formIds[fIdx]];
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

	/** Restore stashed connect configs onto forms in the draft. */
	private restoreAllFormConnect(
		draft: {
			forms: Record<string, { connect: ConnectConfig | null | undefined }>;
			moduleOrder: string[];
			formOrder: Record<string, string[]>;
		},
		mode: ConnectType,
	): void {
		for (const [mIdx, moduleMap] of this._connectStash[mode]) {
			const moduleId = draft.moduleOrder[mIdx];
			if (!moduleId) continue;
			const formIds = draft.formOrder[moduleId] ?? [];
			for (const [fIdx, config] of moduleMap) {
				const formId = formIds[fIdx];
				if (formId && draft.forms[formId]) {
					draft.forms[formId].connect = structuredClone(config);
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
