/**
 * BuilderEngine — thin adapter between the Zustand store and the DOM.
 *
 * The Zustand store (`builderStore.ts`) holds ALL reactive state and mutation
 * actions. The engine holds only non-reactive imperative state that doesn't
 * belong in the store:
 *
 * - **Edit scope** — signal grid zone focus
 * - **Edit mutation tracking** — gates Completed phase after post-build edits
 *
 * The engine also provides DOM helpers (undo highlight flash, field element
 * lookup) used by routing hooks and form editors. Transient UI hints
 * (focus hint, new-question marker) live on BuilderSession instead.
 */

import type { BlueprintDocStore } from "@/lib/doc/provider";
import { EngineController } from "@/lib/preview/engine/engineController";
import { signalGrid } from "@/lib/signalGrid/store";
import type { EditFocus } from "@/lib/signalGridController";
import { BuilderPhase, type EditScope, GenerationStage } from "./builder";
import { type BuilderStoreApi, createBuilderStore } from "./builderStore";
import { countQuestionsDeep } from "./normalizedState";

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

	/** Current agent edit zone — read by computeEditFocus(). */
	private _editScope: EditScope | null = null;
	/** Tracks whether post-build edits have mutated the blueprint (gates Completed phase). */
	private _editMadeMutations = false;

	/** Reference to the doc store — installed by SyncBridge when the provider
	 *  mounts, cleared on unmount. All entity mutations route through this
	 *  store when available; the legacy store is populated by the sync adapter. */
	private _docStore: BlueprintDocStore | null = null;

	constructor(initialPhase: BuilderPhase = BuilderPhase.Idle) {
		this.store = createBuilderStore(initialPhase);
		/* Pause undo tracking until the app is loaded (existing) or generated
		 * (new). Without this, the empty→populated hydration transition creates
		 * an undoable entry whose undo restores a blank state. Call sites resume
		 * tracking after loadApp() or completeGeneration(). */
		this.store.temporal.getState().pause();

		/* Initialize the form engine controller. Its own UUID-keyed runtime
		 * store handles test-mode values and computed state. The doc store
		 * reference is installed later by SyncBridge when the provider mounts. */
		this.engineController = new EngineController();
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
		this._editScope = null;
		this._editMadeMutations = false;
		this.store.getState().reset();
		/* Clear signal grid energy so stale accumulation from the previous
		 * lifecycle doesn't cause a spurious burst after replay navigation. */
		signalGrid.reset();
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
