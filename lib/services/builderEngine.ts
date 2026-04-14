/**
 * BuilderEngine — thin adapter between the Zustand store and the DOM.
 *
 * The Zustand store (`builderStore.ts`) holds ALL reactive state and mutation
 * actions. The engine holds only non-reactive imperative state that doesn't
 * belong in the store:
 *
 * - **Edit mutation tracking** — gates Completed phase after post-build edits
 *
 * The engine also provides DOM helpers (undo highlight flash, field element
 * lookup) used by routing hooks and form editors. Transient UI hints
 * (focus hint, new-question marker) live on BuilderSession instead.
 *
 * Signal grid edit focus computation lives in `lib/signalGrid/editFocus.ts`
 * as a pure function — no engine state needed.
 */

import type { BlueprintDocStore } from "@/lib/doc/provider";
import { EngineController } from "@/lib/preview/engine/engineController";
import { signalGrid } from "@/lib/signalGrid/store";
import { BuilderPhase, GenerationStage } from "./builder";
import { type BuilderStoreApi, createBuilderStore } from "./builderStore";

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

	/** Tracks whether post-build edits have mutated the blueprint (gates Completed phase). */
	private _editMadeMutations = false;

	/** Reference to the doc store — installed by SyncBridge when the provider
	 *  mounts, cleared on unmount. All entity mutations route through this
	 *  store when available; the legacy store is populated by the sync adapter. */
	private _docStore: BlueprintDocStore | null = null;

	constructor(initialPhase: BuilderPhase = BuilderPhase.Idle) {
		this.store = createBuilderStore(initialPhase);
		/* Undo tracking lives exclusively on the BlueprintDoc store now —
		 * this legacy store no longer carries entity data, so there is
		 * nothing here worth pausing or resuming. */

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
		if (s.generationStage === GenerationStage.DataModel) {
			/* Case types live on the doc store; fall back to 0.05 (no case
			 * types received yet) when the bridge hasn't connected a doc. */
			const doc = this._docStore?.getState();
			const hasCaseTypes = (doc?.caseTypes?.length ?? 0) > 0;
			return hasCaseTypes ? 0.3 : 0.05;
		}
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
		this._editMadeMutations = false;
		this.store.getState().reset();
		/* Clear signal grid energy so stale accumulation from the previous
		 * lifecycle doesn't cause a spurious burst after replay navigation. */
		signalGrid.reset();
		/* The BlueprintDoc store owns undo history — callers that need to
		 * wipe and re-hydrate the doc during a lifecycle reset should do so
		 * through its own `load()` API, not through the legacy engine. */
	}
}
