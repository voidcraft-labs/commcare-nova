import type { PreviewScreen } from "@/lib/preview/engine/types";
import type {
	AppBlueprint,
	BlueprintForm,
	CaseType,
	Question,
	Scaffold,
} from "@/lib/schemas/blueprint";
import type { EditFocus } from "@/lib/signalGridController";
import type { HqApplication } from "./commcare/hqTypes";
import { type CursorMode, HistoryManager } from "./historyManager";
import { MutableBlueprint } from "./mutableBlueprint";
import type { QuestionPath } from "./questionPath";
import { countDeep } from "./questionTree";

export type { CursorMode } from "./historyManager";

/**
 * Complete UI context captured alongside each blueprint snapshot.
 * Stores the exact user state at mutation time so undo/redo can restore
 * selection, navigation screen, and cursor mode atomically — no derivation
 * from mutation metadata, no fragile type-based inference.
 */
export interface ViewContext {
	selected: SelectedElement | undefined;
	screen: PreviewScreen;
	cursorMode: CursorMode;
	/**
	 * Field key to focus after undo/redo restores this snapshot.
	 * Captured at snapshot time from the active DOM element's closest
	 * `[data-field-id]` ancestor — identifies which field within the
	 * InlineSettingsPanel the user was interacting with (e.g. "required",
	 * "validation", "hint"). Undefined when focus was outside a tracked field.
	 */
	focusHint?: string;
}

/** Apply a data part to a builder — shared between real-time streaming (onData) and replay. */
export function applyDataPart(
	builder: Builder,
	type: string,
	data: Record<string, unknown>,
): void {
	// Inject energy for signal grid based on data part significance
	switch (type) {
		case "data-module-done":
		case "data-form-done":
		case "data-form-fixed":
			builder.injectEnergy(200);
			break;
		case "data-form-updated":
		case "data-blueprint-updated":
			builder.injectEnergy(100);
			break;
		case "data-phase":
		case "data-schema":
		case "data-scaffold":
		case "data-partial-scaffold":
		case "data-fix-attempt":
			builder.injectEnergy(50);
			break;
	}

	switch (type) {
		case "data-start-build":
			builder.startGeneration();
			break;
		case "data-schema":
			builder.setSchema(data.caseTypes as CaseType[]);
			break;
		case "data-partial-scaffold":
			builder.setPartialScaffold(data);
			break;
		case "data-scaffold":
			builder.setScaffold(data as unknown as Scaffold);
			break;
		case "data-phase":
			builder.advanceStage(data.phase as string);
			break;
		case "data-module-done":
			builder.setModuleContent(
				data.moduleIndex as number,
				(data.caseListColumns as Array<{
					field: string;
					header: string;
				}> | null) ?? null,
			);
			break;
		case "data-form-done":
		case "data-form-fixed":
		case "data-form-updated":
			builder.setFormContent(
				data.moduleIndex as number,
				data.formIndex as number,
				data.form as BlueprintForm,
			);
			break;
		case "data-blueprint-updated":
			builder.updateBlueprint(data.blueprint as AppBlueprint);
			break;
		case "data-fix-attempt":
			builder.setFixAttempt(data.attempt as number, data.errorCount as number);
			break;
		case "data-done":
			builder.completeGeneration(
				data as {
					blueprint: AppBlueprint;
					hqJson: HqApplication;
					success: boolean;
				},
			);
			break;
		case "data-app-saved":
			builder.setAppId(data.appId as string);
			break;
		case "data-error":
			builder.setGenerationError(
				data.message as string,
				(data.fatal as boolean) ? "failed" : "recovering",
			);
			break;
	}
}

/** Builder lifecycle phases — what mode the builder is in right now.
 *  Generation progress (DataModel→Fix) is tracked separately via GenerationStage. */
export enum BuilderPhase {
	Idle = "idle",
	Loading = "loading",
	Generating = "generating",
	/** Transient celebration phase — a generation or edit just finished successfully.
	 *  Auto-decays to Ready after the signal grid's done animation settles. */
	Completed = "completed",
	Ready = "ready",
}

/** Progress stages within a generation run — metadata on the Generating phase.
 *  Only meaningful when `builder.phase === Generating`. */
export enum GenerationStage {
	DataModel = "data-model",
	Structure = "structure",
	Modules = "modules",
	Forms = "forms",
	Validate = "validate",
	Fix = "fix",
}

/** Error state during generation — metadata, not a phase.
 *  The builder stays in Generating; this describes what went wrong. */
export type GenerationError = {
	message: string;
	severity: "recovering" | "failed";
} | null;

/** Status label for each generation stage, shown in the Signal Grid panel. */
export const STAGE_LABELS: Record<GenerationStage, string> = {
	[GenerationStage.DataModel]: "Designing data model",
	[GenerationStage.Structure]: "Designing app structure",
	[GenerationStage.Modules]: "Building app content",
	[GenerationStage.Forms]: "Building app content",
	[GenerationStage.Validate]: "Validating blueprint",
	[GenerationStage.Fix]: "Fixing validation errors",
};

export interface SelectedElement {
	type: "module" | "form" | "question";
	moduleIndex: number;
	formIndex?: number;
	questionPath?: QuestionPath;
	/** Stable crypto UUID — the primary identity key for UI-layer concerns
	 *  (React keys, DOM selectors, dnd-kit, scroll targeting). Unlike
	 *  `questionPath` (which changes on rename), UUID never changes. */
	questionUuid?: string;
}

/** Scope the agent is currently editing — drives signal grid focus zone. */
export interface EditScope {
	moduleIndex: number;
	formIndex?: number;
	/** Flat question index within the form (0-based, depth-first). */
	questionIndex?: number;
}

/** Common shape for AppTree rendering — satisfied by both Scaffold and AppBlueprint */
export interface TreeData {
	app_name: string;
	connect_type?: string;
	modules: Array<{
		name: string;
		case_type?: string | null;
		purpose?: string;
		forms: Array<{
			name: string;
			type: string;
			purpose?: string;
			questions?: Question[];
			connect?: Record<string, unknown>;
		}>;
		case_list_columns?: Array<{ field: string; header: string }> | null;
		case_detail_columns?: Array<{ field: string; header: string }> | null;
	}>;
}

/** Partial module data being built during streaming generation.
 *  caseListColumns is undefined (not yet received), null (server said no columns), or an array. */
interface PartialModule {
	caseListColumns?: Array<{ field: string; header: string }> | null;
	forms: Map<number, BlueprintForm>;
}

export class Builder {
	// ── Private state ────────────────────────────────────────────────────

	private _phase: BuilderPhase;
	private _scaffold?: Scaffold;
	private _mb?: MutableBlueprint;
	private _history?: HistoryManager<ViewContext>;
	private _isDragging = false;
	private _agentActive = false;
	private _postBuildEdit = false;
	private _editMadeMutations = false;
	private _caseTypes?: CaseType[];
	private _statusMessage = "";
	private _selected?: SelectedElement;
	private _newQuestionUuid?: string;
	private _mutationCount = 0;
	private _progressCompleted = 0;
	private _progressTotal = 0;
	private _partialModules = new Map<number, PartialModule>();
	private _partialScaffold?: {
		appName?: string;
		description?: string;
		modules: TreeData["modules"];
	};
	private _generationStage: GenerationStage | null = null;
	private _generationError: GenerationError = null;
	private _listeners = new Set<() => void>();
	private _version = 0;
	private _mutationListeners = new Set<() => void>();

	// ── Stream energy (non-versioned — consumed by SignalGrid rAF loop, never triggers React re-renders) ──
	private _streamEnergy = 0;
	private _thinkEnergy = 0;

	// ── Edit scope (non-versioned — consumed by SignalGrid rAF loop) ──
	private _editScope: EditScope | null = null;

	// ── Edit guard (blocks select() when an inline editor has unsaved invalid content) ──
	private _editGuard: (() => boolean) | null = null;

	// ── Active field tracking (for undo/redo focus restoration) ──
	// Set eagerly on focusin within a [data-field-id] element, persists through
	// blur → commit → snapshot cycle so deriveViewContext captures the right field
	// even for blur-triggered saves. Cleared on selection change.
	private _activeFieldId: string | undefined;

	// ── Scroll callback (registered by BuilderLayout, which owns the DOM) ──
	private _scrollCallback:
		| ((questionUuid: string, prevUuid?: string) => void)
		| null = null;

	// ── View state (synced from component layer for undo/redo snapshots) ──
	private _currentScreen: PreviewScreen = { type: "home" };
	private _currentCursorMode: CursorMode = "inspect";

	// ── Focus hint (transient — consumed once by InlineSettingsPanel after undo/redo) ──
	private _focusHint: string | undefined;

	// ── Pending panel scroll (one-shot callback for undo/redo scroll-after-animation) ──
	private _pendingPanelScroll?: {
		questionUuid: string;
		callback: () => void;
	};

	// ── App persistence ─────────────────────────────────────────────────
	private _appId: string | undefined;

	constructor(initialPhase: BuilderPhase = BuilderPhase.Idle) {
		this._phase = initialPhase;
	}

	// ── Read-only public accessors ───────────────────────────────────────

	get phase(): BuilderPhase {
		return this._phase;
	}
	get agentActive(): boolean {
		return this._agentActive;
	}

	/** Firestore app ID — set after first save, persisted across re-generations. */
	get appId(): string | undefined {
		return this._appId;
	}

	/** True when agent activates in Done phase after the initial summary has completed.
	 *  Used by ChatSidebar to distinguish post-build summary (reasoning) from user-initiated edits (editing). */
	get postBuildEdit(): boolean {
		return this._postBuildEdit;
	}

	/** True when the blueprint is hydrated and interactive — covers both the
	 *  transient Completed celebration and the steady-state Ready phase. Use this
	 *  instead of `phase === Ready` when gating on "builder has a usable blueprint." */
	get isReady(): boolean {
		return (
			this._phase === BuilderPhase.Ready ||
			this._phase === BuilderPhase.Completed
		);
	}

	/** True when the build pipeline is running. */
	get isGenerating(): boolean {
		return this._phase === BuilderPhase.Generating;
	}

	/** True when the agent is actively working but the build pipeline isn't running.
	 *  Drives the thinking indicator in the chat sidebar. */
	get isThinking(): boolean {
		return this._agentActive && !this.isGenerating;
	}

	/** Current generation stage — only meaningful when phase === Generating. */
	get generationStage(): GenerationStage | null {
		return this._generationStage;
	}

	/** Error state during generation — null when no error. Phase stays Generating. */
	get generationError(): GenerationError {
		return this._generationError;
	}

	get errorSeverity(): "recovering" | "failed" | undefined {
		return this._generationError?.severity;
	}
	get isRecovering(): boolean {
		return this._generationError?.severity === "recovering";
	}

	get scaffold(): Scaffold | undefined {
		return this._scaffold;
	}
	get caseTypes(): CaseType[] | undefined {
		return this._caseTypes;
	}
	get statusMessage(): string {
		return this._statusMessage;
	}
	get selected(): SelectedElement | undefined {
		return this._selected;
	}

	/**
	 * Transient field key to focus after undo/redo restore.
	 * Read once by InlineSettingsPanel to auto-focus the matching control,
	 * then cleared via `clearFocusHint()`. Undefined outside of undo/redo.
	 */
	get focusHint(): string | undefined {
		return this._focusHint;
	}

	/** Clear the focus hint after the target field has consumed it. */
	clearFocusHint() {
		this._focusHint = undefined;
	}

	/**
	 * Register a one-shot scroll callback to fire when the InlineSettingsPanel
	 * finishes its entrance animation for the given question.
	 *
	 * Used by undo/redo to defer scroll-to-field until the panel reaches full
	 * height. The UUID acts as a guard — only the matching panel's
	 * `onAnimationComplete` fires the callback, preventing stale exit animations
	 * from triggering premature scrolls.
	 */
	setPendingPanelScroll(questionUuid: string, callback: () => void): void {
		this._pendingPanelScroll = { questionUuid, callback };
	}

	/**
	 * Signal that the InlineSettingsPanel's entrance animation has completed.
	 * Called by FormRenderer's motion.div `onAnimationComplete` callback.
	 * Fires and clears the pending scroll callback if the question UUID matches.
	 *
	 * When undo/redo changes selection, both the old panel (exit) and new panel
	 * (entrance) fire this — but only the new panel's UUID matches, so only
	 * the entrance triggers the scroll.
	 */
	completePanelAnimation(questionUuid: string): void {
		if (this._pendingPanelScroll?.questionUuid === questionUuid) {
			const cb = this._pendingPanelScroll.callback;
			this._pendingPanelScroll = undefined;
			cb();
		}
	}

	get mutationCount(): number {
		return this._mutationCount;
	}
	get progressCompleted(): number {
		return this._progressCompleted;
	}
	get progressTotal(): number {
		return this._progressTotal;
	}

	/** Scaffold progress (0-1) derived from current state. Polled by SignalGrid rAF loop. */
	get scaffoldProgress(): number {
		if (this._phase !== BuilderPhase.Generating) return this.isReady ? 1.0 : 0;
		if (this._generationStage === GenerationStage.DataModel)
			return this._caseTypes ? 0.3 : 0.05;
		if (this._generationStage === GenerationStage.Structure) {
			if (this._scaffold) return 0.85;
			if (this._partialScaffold) return 0.55;
			return 0.35;
		}
		return 1.0;
	}

	/** The current blueprint as plain data, or undefined. */
	get blueprint(): AppBlueprint | undefined {
		return this._mb?.getBlueprint();
	}

	/** The persistent MutableBlueprint instance for direct mutation.
	 *  Returns the Proxy-wrapped version when history is active. */
	get mb(): MutableBlueprint | undefined {
		return this._history?.proxied ?? this._mb;
	}

	// ── Subscribe ────────────────────────────────────────────────────────

	subscribe = (listener: () => void) => {
		this._listeners.add(listener);
		return () => {
			this._listeners.delete(listener);
		};
	};

	/** Subscribe to blueprint/selection changes that invalidate derived caches.
	 *  Fires when the blueprint is mutated, replaced, or the active form changes —
	 *  NOT on UI-only state changes (phase labels, panel toggles, agent status).
	 *  Returns an unsubscribe function. */
	subscribeMutation = (listener: () => void): (() => void) => {
		this._mutationListeners.add(listener);
		return () => {
			this._mutationListeners.delete(listener);
		};
	};

	getSnapshot = () => this._version;

	private notify() {
		this._version++;
		for (const fn of this._listeners) fn();
	}

	private notifyMutation() {
		for (const fn of this._mutationListeners) fn();
	}

	// ── New question state ───────────────────────────────────────────────

	/** Mark a question as newly added. Activates auto-focus and select-all behaviors. */
	markNewQuestion(uuid: string): void {
		this._newQuestionUuid = uuid;
	}

	/** Returns true if the question with `uuid` was just added and hasn't been saved yet. */
	isNewQuestion(uuid: string): boolean {
		return this._newQuestionUuid === uuid;
	}

	/** Deactivate new-question behaviors (called on first save). */
	clearNewQuestion(): void {
		this._newQuestionUuid = undefined;
	}

	// ── Edit guard ──────────────────────────────────────────────────────

	/** Register an edit guard that `select()` consults before changing selection.
	 *  The callback returns false to block, true to allow. Only one guard at a time.
	 *  Intentionally does not gate `undo()`/`redo()` — those bypass selection guards
	 *  because they restore full snapshots including selection state. */
	setEditGuard(guard: () => boolean): void {
		this._editGuard = guard;
	}

	/** Clear the active edit guard. */
	clearEditGuard(): void {
		this._editGuard = null;
	}

	// ── Active field tracking ───────────────────────────────────────────

	/** Record which [data-field-id] element currently has focus.
	 *  Called by InlineSettingsPanel's delegated focusin handler so the
	 *  value persists through blur → commit → snapshot for blur-triggered saves. */
	setActiveField(fieldId: string | undefined): void {
		if (fieldId === this._activeFieldId) return;
		this._activeFieldId = fieldId;
	}

	// ── Scroll callback ─────────────────────────────────────────────────

	/** Register the scroll implementation owned by BuilderLayout.
	 *  The callback receives the target question UUID and the previously
	 *  selected UUID (used for collapsing-panel compensation). */
	registerScrollCallback(
		cb: (questionUuid: string, prevUuid?: string) => void,
	): void {
		this._scrollCallback = cb;
	}

	/** Unregister the scroll callback (cleanup on unmount). */
	clearScrollCallback(): void {
		this._scrollCallback = null;
	}

	// ── Progress ─────────────────────────────────────────────────────────

	/** Derive progress counts from the scaffold and partialModules state. */
	private updateProgress() {
		if (
			!this._scaffold ||
			(this._generationStage !== GenerationStage.Modules &&
				this._generationStage !== GenerationStage.Forms)
		) {
			this._progressCompleted = 0;
			this._progressTotal = 0;
			return;
		}

		// Total = modules + all forms across modules
		this._progressTotal =
			this._scaffold.modules.length +
			this._scaffold.modules.reduce((sum, m) => sum + m.forms.length, 0);

		// Completed = modules with columns + forms with content
		this._progressCompleted = 0;
		for (const [, partial] of this._partialModules) {
			if (partial.caseListColumns !== undefined) this._progressCompleted++;
			this._progressCompleted += partial.forms.size;
		}
	}

	// ── View context sync ────────────────────────────────────────────

	/**
	 * Sync the current navigation screen from the component layer.
	 * Called by BuilderLayout during render — plain assignment, no side effects.
	 * The HistoryManager reads this lazily at snapshot time via deriveView().
	 */
	setScreen(screen: PreviewScreen) {
		this._currentScreen = screen;
	}

	/**
	 * Sync the current cursor mode from the component layer.
	 * Same pattern as setScreen — plain assignment consumed at snapshot time.
	 */
	setCursorMode(mode: CursorMode) {
		this._currentCursorMode = mode;
	}

	/**
	 * Assemble the full ViewContext from current state.
	 * Called lazily by HistoryManager at snapshot time (during mutations and
	 * undo/redo), never during render. Uses `_activeFieldId` (set eagerly on
	 * focusin) rather than querying `document.activeElement` — blur-triggered
	 * commits move focus away before the snapshot fires, so the DOM query would
	 * miss the field.
	 */
	private deriveViewContext = (): ViewContext => ({
		selected: this._selected,
		screen: this._currentScreen,
		cursorMode: this._currentCursorMode,
		focusHint: this._activeFieldId,
	});

	// ── Drag state ────────────────────────────────────────────────────

	setDragging(active: boolean) {
		this._isDragging = active;
	}

	/** Called by BuilderLayout to sync chat transport status with builder state. */
	setAgentActive(active: boolean) {
		if (this._agentActive === active) return;
		// Agent reactivating after Ready/Completed = user-initiated edit
		if (
			active &&
			(this._phase === BuilderPhase.Ready ||
				this._phase === BuilderPhase.Completed)
		) {
			// Absorb any lingering Completed phase — new edit supersedes old celebration
			this._phase = BuilderPhase.Ready;
			this._postBuildEdit = true;
			this._editMadeMutations = false;
		}
		// Agent deactivating after a post-build edit that mutated the blueprint —
		// transition to Completed so the signal grid shows the done celebration.
		if (!active && this._postBuildEdit && this._editMadeMutations) {
			this._phase = BuilderPhase.Completed;
			this._postBuildEdit = false;
			this._editMadeMutations = false;
		}
		this._agentActive = active;
		this.notify();
	}

	/** Inject burst energy from data parts (UI-visible changes). Drives building-mode flashes. */
	injectEnergy(amount: number): void {
		this._streamEnergy += amount;
	}

	/** Inject think energy from token generation (text, reasoning, tool args). Drives neural firing. */
	injectThinkEnergy(amount: number): void {
		this._thinkEnergy += amount;
	}

	/** Read and drain accumulated burst energy. Called by SignalGridController each animation frame. */
	drainEnergy(): number {
		const e = this._streamEnergy;
		this._streamEnergy = 0;
		return e;
	}

	/** Read and drain accumulated think energy. Called by SignalGridController each animation frame. */
	drainThinkEnergy(): number {
		const e = this._thinkEnergy;
		this._thinkEnergy = 0;
		return e;
	}

	// ── Edit focus (non-versioned — drives signal grid zone during editing) ──

	/** Update the scope the agent is currently editing. Null = no specific scope. */
	setEditScope(scope: EditScope | null): void {
		this._editScope = scope;
	}

	/** Compute the normalized edit focus zone from the current scope and blueprint structure.
	 *  Returns null when there's no blueprint or no scope (= full-width fallback). */
	computeEditFocus(): EditFocus | null {
		const bp = this._mb?.getBlueprint();
		if (!bp || !this._editScope) return null;

		// Build a flat map: for each module, for each form, the cumulative question count.
		// This gives us the total question count and the position of any form within it.
		let total = 0;
		const formPositions: Array<{
			moduleIndex: number;
			formIndex: number;
			start: number;
			count: number;
		}> = [];

		for (let mi = 0; mi < bp.modules.length; mi++) {
			const mod = bp.modules[mi];
			if (!mod.forms) continue;
			for (let fi = 0; fi < mod.forms.length; fi++) {
				const count = countDeep(mod.forms[fi].questions);
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

		// Module-level scope (no formIndex): span all forms in the module
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

		// Form-level scope
		const form = formPositions.find(
			(f) =>
				f.moduleIndex === scope.moduleIndex && f.formIndex === scope.formIndex,
		);
		if (!form || form.count === 0) return null;

		// Question-level scope
		if (scope.questionIndex != null) {
			const qPos =
				(form.start + Math.min(scope.questionIndex, form.count - 1)) / total;
			// Zone centered on the question, min 15% width
			const halfZone = Math.max(MIN_EDIT_ZONE / 2, (form.count / total) * 0.3);
			return clampEditFocus(qPos - halfZone, qPos + halfZone);
		}

		// Form-level: span the whole form
		return clampEditFocus(
			form.start / total,
			(form.start + form.count) / total,
		);
	}

	// ── Undo/Redo ──────────────────────────────────────────────────────

	/**
	 * Undo the most recent mutation.
	 * Restores the blueprint and selection from the snapshot, then returns
	 * the full ViewContext so BuilderLayout can atomically restore the
	 * navigation screen and cursor mode.
	 *
	 * Blocked during drag — dnd-kit state would become inconsistent.
	 */
	undo(): ViewContext | undefined {
		if (this._isDragging) return undefined;
		const result = this._history?.undo();
		if (!result) return undefined;
		this._mb = result.mb;
		this._selected = result.view.selected;
		this._focusHint = result.view.focusHint;
		this._mutationCount++;
		this.notifyMutation();
		this.notify();
		return result.view;
	}

	/**
	 * Redo the most recently undone mutation.
	 * Same restoration logic as undo — blueprint + selection from snapshot,
	 * ViewContext returned for screen + cursor mode restoration.
	 */
	redo(): ViewContext | undefined {
		if (this._isDragging) return undefined;
		const result = this._history?.redo();
		if (!result) return undefined;
		this._mb = result.mb;
		this._selected = result.view.selected;
		this._focusHint = result.view.focusHint;
		this._mutationCount++;
		this.notifyMutation();
		this.notify();
		return result.view;
	}

	get canUndo(): boolean {
		return this._history?.canUndo ?? false;
	}

	get canRedo(): boolean {
		return this._history?.canRedo ?? false;
	}

	/** Begin a new generation run — transitions to Generating phase with DataModel stage. */
	startGeneration() {
		if (this._history) {
			this._history.clear();
			this._history.enabled = false;
		}
		this._phase = BuilderPhase.Generating;
		this._generationStage = GenerationStage.DataModel;
		this._generationError = null;
		this._statusMessage = STAGE_LABELS[GenerationStage.DataModel];
		this.notify();
	}

	/** Store case types from data model generation. */
	setSchema(caseTypes: CaseType[]) {
		this._caseTypes = caseTypes;
		this.notify();
	}

	/** Update partial scaffold from streaming tool call args. */
	setPartialScaffold(partial: Record<string, unknown>) {
		const modules = partial?.modules as
			| Array<Record<string, unknown>>
			| undefined;
		if (!modules?.length) return;
		this._partialScaffold = {
			appName: partial.app_name as string | undefined,
			modules: modules
				.filter((m) => m?.name)
				.map((m) => ({
					name: m.name as string,
					case_type: m.case_type as string | undefined,
					purpose: m.purpose as string | undefined,
					forms: ((m.forms as Array<Record<string, unknown>> | undefined) ?? [])
						.filter((f) => f?.name)
						.map((f) => ({
							name: f.name as string,
							type: f.type as string,
							purpose: f.purpose as string | undefined,
						})),
				})),
		};
		this._generationStage = GenerationStage.Structure;
		this._statusMessage = STAGE_LABELS[GenerationStage.Structure];
		this.notify();
	}

	/** Store the completed scaffold for tree display. */
	setScaffold(scaffold: Scaffold) {
		this._scaffold = scaffold;
		this._mb = undefined;
		this._partialScaffold = undefined;
		this.notify();
	}

	/** Update module content (case list columns). */
	setModuleContent(
		moduleIndex: number,
		caseListColumns: Array<{ field: string; header: string }> | null,
	) {
		let partial = this._partialModules.get(moduleIndex);
		if (!partial) {
			partial = { forms: new Map() };
			this._partialModules.set(moduleIndex, partial);
		}
		partial.caseListColumns = caseListColumns;
		this.updateProgress();
		this.notify();
	}

	/** Update form content (assembled form with questions). */
	setFormContent(moduleIndex: number, formIndex: number, form: BlueprintForm) {
		if (this._postBuildEdit) this._editMadeMutations = true;
		// During edit mode (_mb exists), update the blueprint directly
		if (this._mb) {
			this._mb.replaceForm(moduleIndex, formIndex, form);
		} else {
			// During initial build, accumulate in partialModules
			let partial = this._partialModules.get(moduleIndex);
			if (!partial) {
				partial = { forms: new Map() };
				this._partialModules.set(moduleIndex, partial);
			}
			partial.forms.set(formIndex, form);
			this.updateProgress();
		}
		this.notify();
	}

	/** Advance to a named generation stage. Clears any previous error (auto-recovery). */
	advanceStage(stage: string) {
		const stageMap: Record<string, GenerationStage> = {
			structure: GenerationStage.Structure,
			modules: GenerationStage.Modules,
			forms: GenerationStage.Forms,
			validate: GenerationStage.Validate,
			fix: GenerationStage.Fix,
		};
		const newStage = stageMap[stage];
		if (!newStage) return;
		this._generationStage = newStage;
		this._generationError = null;
		this._statusMessage = STAGE_LABELS[newStage] || this._statusMessage;
		this.updateProgress();
		this.notify();
	}

	/** Update status message for fix attempt progress. */
	setFixAttempt(attempt: number, errorCount: number) {
		this._statusMessage = `${STAGE_LABELS[GenerationStage.Fix]} — ${errorCount} error${errorCount !== 1 ? "s" : ""} (attempt ${attempt})`;
		this.notify();
	}

	/** Complete generation — transition Generating → Completed with the final blueprint.
	 *  Completed is a transient celebration phase; call acknowledgeCompletion() to decay to Ready. */
	completeGeneration(result: {
		blueprint: AppBlueprint;
		hqJson: HqApplication;
		success: boolean;
	}) {
		this.enterReady(new MutableBlueprint(result.blueprint));
		this._phase = BuilderPhase.Completed;
		this._progressCompleted = 0;
		this._progressTotal = 0;
		this.notify();
	}

	/** Decay Completed → Ready after the done celebration finishes.
	 *  No-ops if the builder has already moved on (e.g. a new edit started). */
	acknowledgeCompletion() {
		if (this._phase !== BuilderPhase.Completed) return;
		this._phase = BuilderPhase.Ready;
		this.notify();
	}

	/** Store the Firestore app ID after first save. Does not trigger re-render
	 *  — the URL update is handled by BuilderLayout's onData callback directly. */
	setAppId(id: string) {
		this._appId = id;
	}

	/** Atomic Loading → Ready transition for hydrating a saved app.
	 *  Single notify() — no transient states, no entrance animations. */
	loadApp(id: string, blueprint: AppBlueprint) {
		this.enterReady(new MutableBlueprint(blueprint));
		this._appId = id;
		this.notify();
	}

	/** Shared Ready-state setup — hydrates blueprint + history, clears generation
	 *  metadata and edit tracking. Called by both completeGeneration and loadApp. */
	private enterReady(mb: MutableBlueprint) {
		this._mb = mb;
		this._history = new HistoryManager<ViewContext>(
			this._mb,
			this.deriveViewContext,
		);
		this._partialModules.clear();
		this._phase = BuilderPhase.Ready;
		this._generationStage = null;
		this._generationError = null;
		this._postBuildEdit = false;
		this._editMadeMutations = false;
		this._statusMessage = "";
	}

	/** Set error state during generation. Phase stays Generating — error is metadata.
	 *  'failed' = terminal (generation stuck), 'recovering' = SA is retrying. */
	setGenerationError(
		message: string,
		severity: "failed" | "recovering" = "failed",
	) {
		this._generationError = { message, severity };
		this._statusMessage = message;
		if (severity === "failed") {
			this._partialModules.clear();
		}
		this.notify();
	}

	/** Provides a common shape for AppTree — uses blueprint if available, otherwise merges partials with scaffold, otherwise scaffold. */
	get treeData(): TreeData | undefined {
		if (this.blueprint) return this.blueprint;

		if (this._scaffold && this._partialModules.size > 0) {
			// Overlay partial data on top of the scaffold
			return {
				app_name: this._scaffold.app_name,
				modules: this._scaffold.modules.map((sm, mIdx) => {
					const partial = this._partialModules.get(mIdx);
					return {
						name: sm.name,
						case_type: sm.case_type,
						purpose: sm.purpose,
						case_list_columns:
							partial?.caseListColumns !== undefined
								? partial.caseListColumns
								: undefined,
						forms: sm.forms.map((sf, fIdx) => {
							const assembledForm = partial?.forms.get(fIdx);
							if (assembledForm) {
								return { ...assembledForm, purpose: sf.purpose };
							}
							return {
								name: sf.name,
								type: sf.type,
								purpose: sf.purpose,
							};
						}),
					};
				}),
			};
		}

		if (this._scaffold) return this._scaffold;

		if (this._partialScaffold && this._partialScaffold.modules.length > 0) {
			return {
				app_name: this._partialScaffold.appName ?? "",
				modules: this._partialScaffold.modules,
			};
		}

		return undefined;
	}

	/** Pure state update — sets the selected element without any UI side effects.
	 *  Use for state maintenance (e.g. rename changing the path, deselect) where
	 *  the user is already looking at the right place. */
	select(el?: SelectedElement) {
		/* Edit guard — an inline editor (e.g. XPathField) can block selection
		 * changes while it has unsaved invalid content. */
		if (this._editGuard && !this._editGuard()) return;

		/* History intentionally NOT cleared on form/module navigation.
		 * Undo is app-wide: each snapshot captures the full view context
		 * (selection + screen + cursor mode) so undo/redo navigates the user
		 * back to wherever they were when the mutation occurred. */
		/* Only clear active field tracking when navigating away from the
		 * current question. Rename calls select() to update the path but the
		 * user stays on the same field — preserving _activeFieldId ensures the
		 * redo snapshot captures the correct focusHint even before React has
		 * re-rendered the autoFocus. navigateTo() always means a different
		 * question, so it handles its own clearing via the focusin handler. */
		if (!el || el.type !== "question") {
			this._activeFieldId = undefined;
		}
		this._selected = el;
		this.notifyMutation();
		this.notify();
	}

	/** Navigate to a question — sets selection and scrolls the design canvas
	 *  to bring the question into view. Use for intentional user navigation
	 *  (click, keyboard nav, insert, duplicate, delete-to-next). */
	navigateTo(el: SelectedElement) {
		const prevUuid = this._selected?.questionUuid;
		/* Clear active field — navigating to a different question means the
		 * previous question's field context is stale. The new question's
		 * focusin handler will set it fresh when the user interacts. */
		this._activeFieldId = undefined;
		this.select(el);
		if (el.questionUuid && this._scrollCallback) {
			this._scrollCallback(el.questionUuid, prevUuid);
		}
	}

	updateBlueprint(bp: AppBlueprint) {
		if (this._postBuildEdit) this._editMadeMutations = true;
		this._mb = new MutableBlueprint(bp);
		this.notifyMutation();
		this.notify();
	}

	/** Notify subscribers that the blueprint was mutated in-place via mb. */
	notifyBlueprintChanged = () => {
		this._mutationCount++;
		this.notifyMutation();
		this.notify();
	};

	reset() {
		this._phase = BuilderPhase.Idle;
		this._generationStage = null;
		this._generationError = null;
		this._scaffold = undefined;
		this._mb = undefined;
		this._history?.clear();
		this._history = undefined;
		this._caseTypes = undefined;
		this._statusMessage = "";
		this._selected = undefined;
		this._newQuestionUuid = undefined;
		this._agentActive = false;
		this._postBuildEdit = false;
		this._editMadeMutations = false;
		this._mutationCount = 0;
		this._progressCompleted = 0;
		this._progressTotal = 0;
		this._partialModules.clear();
		this._partialScaffold = undefined;
		this._streamEnergy = 0;
		this._thinkEnergy = 0;
		this._editScope = null;
		this._editGuard = null;
		this._appId = undefined;
		this.notify();
	}
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Minimum zone width fraction for edit focus (matches signalGridController constant). */
const MIN_EDIT_ZONE = 0.15;

/** Clamp an edit focus zone: enforce minimum width, don't wrap, stay in 0-1. */
function clampEditFocus(start: number, end: number): EditFocus {
	let width = end - start;
	if (width < MIN_EDIT_ZONE) {
		const center = (start + end) / 2;
		start = center - MIN_EDIT_ZONE / 2;
		end = center + MIN_EDIT_ZONE / 2;
		width = MIN_EDIT_ZONE;
	}
	// Clamp to 0-1 without wrapping — shift the window instead
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
