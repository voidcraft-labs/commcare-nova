/**
 * EngineController — per-question reactive coordination layer.
 *
 * A plain TypeScript class (not a React hook) that mediates between the
 * blueprint store and the engine's Zustand runtime store. Lives on
 * BuilderEngine with the same lifecycle.
 *
 * ## Architecture
 *
 * Two Zustand stores with a unidirectional flow: blueprint → runtime.
 *
 * - **Blueprint store** (existing): normalized entities, Immer structural
 *   sharing, zundo undo tracking. Source of truth for form structure.
 * - **Runtime store** (owned by this controller): UUID-keyed per-question
 *   computed state (visibility, required, validation, resolved labels).
 *   Ephemeral — never persisted, never in undo history.
 *
 * ## Per-Question Subscriptions
 *
 * One Zustand subscription per question on the blueprint store. Immer
 * structural sharing means `s.questions[uuid]` only gets a new reference
 * when THAT specific question was mutated.
 *
 * When a subscription fires, the controller classifies what changed:
 * - **Label/hint without refs, options, type** → do nothing
 * - **Expression field** → rebuild DAG, re-evaluate that question + cascade
 * - **Label/hint with hashtag refs** → re-evaluate resolved labels only
 * - **Question ID rename** → update paths, rebuild DAG, re-evaluate dependents
 * - **Default value** → re-evaluate default + cascade
 *
 * ## Fully Incremental
 *
 * There is no "rebuild everything" path. Every operation — including
 * adding/removing questions and metadata changes — is targeted. Only the
 * affected questions' states change. Existing questions keep their original
 * object references in the runtime store. No diffing needed.
 */
import { shallow } from "zustand/shallow";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { BlueprintForm, Question } from "@/lib/schemas/blueprint";
import type { BuilderStoreApi } from "@/lib/services/builderStore";
import type { NForm, NQuestion } from "@/lib/services/normalizedState";
import { assembleForm } from "@/lib/services/normalizedState";
import { FormEngine } from "./formEngine";
import type { QuestionState } from "./types";

// ── Runtime store types ─────────────────────────────────────────────────

/** Per-question computed runtime state. Keyed by UUID, aligned with the
 *  blueprint store. Components subscribe via `useStore(store, s => s[uuid])`. */
export type RuntimeState = QuestionState;

/** The Zustand store shape — flat map of UUID → RuntimeState. */
export type RuntimeStoreState = Record<string, RuntimeState>;

/** Stable fallback for UUIDs that don't exist. Frozen so Zustand selectors
 *  always return the same reference — no spurious re-renders. */
export const DEFAULT_RUNTIME_STATE: RuntimeState = Object.freeze({
	path: "",
	value: "",
	visible: true,
	required: false,
	valid: true,
	touched: false,
});

// ── Helpers ─────────────────────────────────────────────────────────────

const EMPTY_FORM: BlueprintForm = { name: "", type: "survey", questions: [] };

/** Assemble a BlueprintForm from the current blueprint store state. */
function assembleFormFromStore(
	state: {
		moduleOrder: string[];
		formOrder: Record<string, string[]>;
		forms: Record<string, NForm>;
		questions: Record<string, NQuestion>;
		questionOrder: Record<string, string[]>;
	},
	moduleIndex: number,
	formIndex: number,
): BlueprintForm | undefined {
	const moduleId = state.moduleOrder[moduleIndex];
	if (!moduleId) return undefined;
	const formId = state.formOrder[moduleId]?.[formIndex];
	if (!formId) return undefined;
	const form = state.forms[formId];
	if (!form) return undefined;
	return assembleForm(form, formId, state.questions, state.questionOrder);
}

/** Build bidirectional UUID ↔ XForm path maps by walking the question tree. */
function buildPathMaps(
	questions: Question[],
	prefix = "/data",
): { uuidToPath: Map<string, string>; pathToUuid: Map<string, string> } {
	const uuidToPath = new Map<string, string>();
	const pathToUuid = new Map<string, string>();
	function walk(qs: Question[], pfx: string) {
		for (const q of qs) {
			const path = `${pfx}/${q.id}`;
			uuidToPath.set(q.uuid, path);
			pathToUuid.set(path, q.uuid);
			if (q.children) {
				const childPrefix = q.type === "repeat" ? `${path}[0]` : path;
				walk(q.children, childPrefix);
			}
		}
	}
	walk(questions, prefix);
	return { uuidToPath, pathToUuid };
}

/** Recursively collect all question UUIDs belonging to a form. */
function collectFormUuids(
	formId: string,
	questionOrder: Record<string, string[]>,
): string[] {
	const result: string[] = [];
	function walk(parentId: string) {
		const children = questionOrder[parentId];
		if (!children) return;
		for (const uuid of children) {
			result.push(uuid);
			walk(uuid);
		}
	}
	walk(formId);
	return result;
}

/** Classify what changed between two question entity versions. */
function classifyChange(
	current: NQuestion,
	previous: NQuestion,
): "none" | "expression" | "label_refs" | "id_rename" | "default_value" {
	if (current.id !== previous.id) return "id_rename";

	if (
		current.calculate !== previous.calculate ||
		current.relevant !== previous.relevant ||
		current.required !== previous.required ||
		current.validation !== previous.validation
	) {
		return "expression";
	}

	if (current.default_value !== previous.default_value) return "default_value";

	const labelChanged = current.label !== previous.label;
	const hintChanged = current.hint !== previous.hint;
	if (labelChanged || hintChanged) {
		const hasRefs =
			(current.label?.includes("#") ?? false) ||
			(previous.label?.includes("#") ?? false) ||
			(current.hint?.includes("#") ?? false) ||
			(previous.hint?.includes("#") ?? false);
		if (hasRefs) return "label_refs";
	}

	return "none";
}

/** Field-level equality for QuestionState. Only used for validateAll/resetValidation
 *  which operate on all questions but most states don't actually change. */
function statesEqual(a: QuestionState, b: QuestionState): boolean {
	return (
		a.value === b.value &&
		a.visible === b.visible &&
		a.required === b.required &&
		a.valid === b.valid &&
		a.touched === b.touched &&
		a.errorMessage === b.errorMessage &&
		a.resolvedLabel === b.resolvedLabel &&
		a.resolvedHint === b.resolvedHint
	);
}

// ── EngineController ────────────────────────────────────────────────────

export class EngineController {
	/** UUID-keyed Zustand runtime store. Components subscribe via
	 *  `useStore(controller.store, s => s[uuid])`. */
	readonly store: StoreApi<RuntimeStoreState>;

	/** The computation engine — DataInstance, TriggerDag, expression evaluation. */
	private engine: FormEngine | undefined;

	/** Bidirectional UUID ↔ XForm path mapping. */
	private uuidToPath = new Map<string, string>();
	private pathToUuid = new Map<string, string>();

	/** The active form's position in the module/form ordering arrays. */
	private activeModuleIndex = 0;
	private activeFormIndex = 0;
	private activeCaseData: Map<string, string> | undefined;

	/** Question UUIDs with active per-question subscriptions. */
	private trackedUuids = new Set<string>();

	/** Cleanup functions for all subscriptions. */
	private unsubscribers: (() => void)[] = [];

	/** Reference to the blueprint store. */
	private blueprintStore: BuilderStoreApi | undefined;

	constructor() {
		this.store = createStore<RuntimeStoreState>(() => ({}));
	}

	/** Connect to the blueprint store. Called once during BuilderEngine construction. */
	setBlueprintStore(blueprintStore: BuilderStoreApi): void {
		this.blueprintStore = blueprintStore;
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	/**
	 * Activate the engine for a specific form. Builds the computation engine,
	 * UUID↔path maps, initial runtime state, and per-question subscriptions.
	 */
	activateForm(
		moduleIndex: number,
		formIndex: number,
		caseData?: Map<string, string>,
	): void {
		this.deactivate();
		if (!this.blueprintStore) return;

		const s = this.blueprintStore.getState();
		const moduleId = s.moduleOrder[moduleIndex];
		if (!moduleId) return;
		const formId = s.formOrder[moduleId]?.[formIndex];
		if (!formId) return;

		this.activeModuleIndex = moduleIndex;
		this.activeFormIndex = formIndex;
		this.activeCaseData = caseData;

		/* Build the computation engine (constructor does full init) */
		const form = assembleFormFromStore(s, moduleIndex, formIndex) ?? EMPTY_FORM;
		const mod = moduleId ? s.modules[moduleId] : undefined;
		this.engine = new FormEngine(form, s.caseTypes, mod?.caseType, caseData);

		/* Build UUID ↔ path mapping */
		const maps = buildPathMaps(form.questions);
		this.uuidToPath = maps.uuidToPath;
		this.pathToUuid = maps.pathToUuid;

		/* Sync initial engine state to the UUID-keyed runtime store */
		this.syncAllToStore();

		/* Set up subscriptions */
		const uuids = collectFormUuids(formId, s.questionOrder);
		this.setupPerQuestionSubscriptions(uuids);
		this.setupStructuralSubscription(formId);
		this.setupMetadataSubscription();
	}

	/** Clean up all subscriptions and reset state. */
	deactivate(): void {
		for (const unsub of this.unsubscribers) unsub();
		this.unsubscribers = [];
		this.trackedUuids.clear();
		this.engine = undefined;
		this.uuidToPath.clear();
		this.pathToUuid.clear();
		this.store.setState({}, true);
	}

	// ── Public actions (called by components) ────────────────────────

	/** Set a test-mode value and cascade through the DAG. */
	onValueChange(uuid: string, value: string): void {
		if (!this.engine) return;
		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		this.engine.setValue(path, value);
		const affectedPaths = [path, ...this.engine.getAffectedPaths(path)];
		this.syncPathsToStore(affectedPaths);
	}

	/** Mark a field as touched (on blur). */
	onTouch(uuid: string): void {
		if (!this.engine) return;
		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		this.engine.touch(path);
		this.syncPathsToStore([path]);
	}

	/** Validate all visible fields. Returns true if valid. */
	validateAll(): boolean {
		if (!this.engine) return true;
		const result = this.engine.validateAll();
		/* validateAll touches many questions (marks touched, runs validation).
		 * Sync all paths but only write those that actually changed. */
		this.syncAllPathsSelectively();
		return result;
	}

	/** Full reset — reinitialize all runtime state. */
	reset(): void {
		if (!this.engine) return;
		this.engine.reset();
		this.syncAllToStore();
	}

	/** Clear touched/validation state (for mode switches). */
	resetValidation(): void {
		if (!this.engine) return;
		this.engine.resetValidation();
		this.syncAllPathsSelectively();
	}

	/** Get the repeat count for a repeat group. */
	getRepeatCount(uuid: string): number {
		if (!this.engine) return 1;
		const path = this.uuidToPath.get(uuid);
		if (!path) return 1;
		return this.engine.getRepeatCount(path);
	}

	/** Add a repeat instance. Returns the new index. */
	addRepeat(uuid: string): number {
		if (!this.engine) return 0;
		const path = this.uuidToPath.get(uuid);
		if (!path) return 0;
		const result = this.engine.addRepeat(path);
		this.syncAllToStore();
		return result;
	}

	/** Remove a repeat instance. */
	removeRepeat(uuid: string, index: number): void {
		if (!this.engine) return;
		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		this.engine.removeRepeat(path, index);
		this.syncAllToStore();
	}

	/** Get the XForm path for a UUID. */
	getPath(uuid: string): string | undefined {
		return this.uuidToPath.get(uuid);
	}

	// ── Per-question subscriptions ───────────────────────────────────

	/**
	 * One Zustand subscription per question. Immer structural sharing means
	 * the callback only fires when THAT specific question was mutated.
	 *
	 * classifyChange determines what happened:
	 * - "none" → zero engine work
	 * - "expression" → rebuild DAG, evaluate question + cascade
	 * - "label_refs" → re-evaluate resolved labels
	 * - "id_rename" → update paths, rebuild DAG, re-evaluate dependents
	 * - "default_value" → re-evaluate default + cascade
	 */
	private setupPerQuestionSubscriptions(uuids: string[]): void {
		if (!this.blueprintStore) return;
		const store = this.blueprintStore;

		for (const uuid of uuids) {
			this.trackedUuids.add(uuid);

			const unsub = store.subscribe(
				(s) => s.questions[uuid],
				(current, previous) => {
					if (!current || !previous || !this.engine) return;
					const changeType = classifyChange(current, previous);

					switch (changeType) {
						case "none":
							return;
						case "expression":
							this.onExpressionChanged(uuid);
							return;
						case "label_refs":
							this.onLabelRefsChanged(uuid);
							return;
						case "id_rename":
							this.onIdRenamed(uuid, previous.id, current.id);
							return;
						case "default_value":
							this.onDefaultValueChanged(uuid, current);
							return;
					}
				},
			);

			this.unsubscribers.push(unsub);
		}
	}

	/**
	 * Structural subscription — detects add/remove by watching the full set
	 * of question UUIDs in this form (recursively from questionOrder).
	 */
	private setupStructuralSubscription(formId: string): void {
		if (!this.blueprintStore) return;
		const store = this.blueprintStore;

		const unsub = store.subscribe(
			(s) => collectFormUuids(formId, s.questionOrder),
			(currentUuids, previousUuids) => {
				const currentSet = new Set(currentUuids);
				const previousSet = new Set(previousUuids);
				const added = currentUuids.filter((u) => !previousSet.has(u));
				const removed = previousUuids.filter((u) => !currentSet.has(u));

				if (added.length > 0) this.onQuestionsAdded(added);
				if (removed.length > 0) this.onQuestionsRemoved(removed);
			},
			{ equalityFn: shallow },
		);

		this.unsubscribers.push(unsub);
	}

	/** Metadata subscription — form type or module case type changes. */
	private setupMetadataSubscription(): void {
		if (!this.blueprintStore) return;
		const store = this.blueprintStore;

		const unsub = store.subscribe(
			(s) => {
				const moduleId = s.moduleOrder[this.activeModuleIndex];
				const form = moduleId
					? s.forms[s.formOrder[moduleId]?.[this.activeFormIndex] ?? ""]
					: undefined;
				const mod = moduleId ? s.modules[moduleId] : undefined;
				return `${form?.type}|${mod?.caseType}`;
			},
			() => this.onMetadataChanged(),
		);

		this.unsubscribers.push(unsub);
	}

	// ── Targeted change handlers ─────────────────────────────────────

	/** A question's expression field changed. Rebuild DAG (sub-ms), then
	 *  re-evaluate only that question + its downstream dependents. */
	private onExpressionChanged(uuid: string): void {
		if (!this.engine || !this.blueprintStore) return;

		const s = this.blueprintStore.getState();
		const form = assembleFormFromStore(
			s,
			this.activeModuleIndex,
			this.activeFormIndex,
		);
		if (!form) return;

		this.engine.rebuildDag(form);

		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		const affectedPaths = [path, ...this.engine.getAffectedPaths(path)];
		this.engine.evaluatePathsInto(affectedPaths);
		this.syncPathsToStore(affectedPaths);
	}

	/** A question's label/hint with hashtag references changed.
	 *  Re-evaluate resolved labels for just this one question. */
	private onLabelRefsChanged(uuid: string): void {
		if (!this.engine) return;
		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		this.engine.evaluatePathsInto([path]);
		this.syncPathsToStore([path]);
	}

	/** A question's ID was renamed. Update path mappings, move DataInstance
	 *  values, rebuild DAG, and re-evaluate dependents. */
	private onIdRenamed(uuid: string, _oldId: string, _newId: string): void {
		if (!this.engine || !this.blueprintStore) return;

		const s = this.blueprintStore.getState();
		const form = assembleFormFromStore(
			s,
			this.activeModuleIndex,
			this.activeFormIndex,
		);
		if (!form) return;

		/* Rebuild path maps — the renamed question has a new path */
		const oldPath = this.uuidToPath.get(uuid);
		const maps = buildPathMaps(form.questions);
		this.uuidToPath = maps.uuidToPath;
		this.pathToUuid = maps.pathToUuid;
		const newPath = this.uuidToPath.get(uuid);

		/* Move the DataInstance value to the new path */
		if (oldPath && newPath && oldPath !== newPath) {
			this.engine.renamePath(oldPath, newPath);
		}

		/* Rebuild DAG (references may point to the new ID now) */
		this.engine.rebuildDag(form);

		/* Re-evaluate the renamed question + dependents */
		if (newPath) {
			const affectedPaths = [newPath, ...this.engine.getAffectedPaths(newPath)];
			this.engine.evaluatePathsInto(affectedPaths);
			this.syncPathsToStore(affectedPaths);
		}
	}

	/** A question's default_value expression changed. Re-evaluate the
	 *  default and cascade through dependents. */
	private onDefaultValueChanged(uuid: string, question: NQuestion): void {
		if (!this.engine || !this.blueprintStore) return;

		/* Rebuild DAG in case the default expression references new paths */
		const s = this.blueprintStore.getState();
		const form = assembleFormFromStore(
			s,
			this.activeModuleIndex,
			this.activeFormIndex,
		);
		if (form) this.engine.rebuildDag(form);

		const path = this.uuidToPath.get(uuid);
		if (!path) return;

		/* Re-evaluate the default value — engine handles the cascade */
		this.engine.reevaluateDefault(path, question as Question);

		const affectedPaths = [path, ...this.engine.getAffectedPaths(path)];
		this.syncPathsToStore(affectedPaths);
	}

	/** Questions were added to the form. Initialize their states
	 *  incrementally without rebuilding existing questions. */
	private onQuestionsAdded(uuids: string[]): void {
		if (!this.engine || !this.blueprintStore) return;

		const s = this.blueprintStore.getState();
		const form = assembleFormFromStore(
			s,
			this.activeModuleIndex,
			this.activeFormIndex,
		);
		if (!form) return;

		/* Rebuild path maps and DAG to include the new questions */
		const maps = buildPathMaps(form.questions);
		this.uuidToPath = maps.uuidToPath;
		this.pathToUuid = maps.pathToUuid;
		this.engine.rebuildDag(form);

		/* Initialize state for each new question — existing questions untouched */
		for (const uuid of uuids) {
			const path = this.uuidToPath.get(uuid);
			const question = this.findQuestionInTree(form.questions, uuid);
			if (path && question) {
				this.engine.addQuestionState(path, question);
			}
		}

		/* Sync only the new questions to the runtime store */
		const newPaths = uuids
			.map((u) => this.uuidToPath.get(u))
			.filter((p): p is string => !!p);
		this.syncPathsToStore(newPaths);

		/* Set up per-question subscriptions for the new questions */
		this.setupPerQuestionSubscriptions(uuids);
	}

	/** Questions were removed from the form. Clean up their states
	 *  without rebuilding existing questions. */
	private onQuestionsRemoved(uuids: string[]): void {
		if (!this.engine || !this.blueprintStore) return;

		/* Remove states from the engine and runtime store */
		const runtimeUpdates: RuntimeStoreState = {};
		for (const uuid of uuids) {
			const path = this.uuidToPath.get(uuid);
			if (path) {
				this.engine.removeQuestionState(path);
			}
			runtimeUpdates[uuid] = DEFAULT_RUNTIME_STATE;
			this.trackedUuids.delete(uuid);
		}
		this.store.setState(runtimeUpdates);

		/* Rebuild path maps and DAG without the removed questions */
		const s = this.blueprintStore.getState();
		const form = assembleFormFromStore(
			s,
			this.activeModuleIndex,
			this.activeFormIndex,
		);
		if (form) {
			const maps = buildPathMaps(form.questions);
			this.uuidToPath = maps.uuidToPath;
			this.pathToUuid = maps.pathToUuid;
			this.engine.rebuildDag(form);

			/* Re-evaluate questions that depended on the removed ones.
			 * Their expressions now reference missing paths — the evaluator
			 * returns empty/default values for missing references. */
			const allPaths = this.engine.getAllPaths();
			if (allPaths.length > 0) {
				this.engine.evaluatePathsInto(allPaths);
				this.syncPathsToStore(allPaths);
			}
		}
	}

	/** Form type or module case type changed. Update case data context
	 *  and re-evaluate only the affected case-property questions. */
	private onMetadataChanged(): void {
		if (!this.engine || !this.blueprintStore) return;

		const s = this.blueprintStore.getState();
		const form = assembleFormFromStore(
			s,
			this.activeModuleIndex,
			this.activeFormIndex,
		);
		if (!form) return;

		const moduleId = s.moduleOrder[this.activeModuleIndex];
		const mod = moduleId ? s.modules[moduleId] : undefined;

		this.engine.refreshCaseContext(
			form,
			this.activeCaseData ?? new Map(),
			mod?.caseType,
		);

		/* Sync any paths that changed from the case data refresh */
		this.syncAllPathsSelectively();
	}

	// ── Store sync ───────────────────────────────────────────────────

	/** Sync ALL engine state to the UUID-keyed runtime store. Used only
	 *  during initial activation and full reset. */
	private syncAllToStore(): void {
		if (!this.engine) return;
		const engineState = this.engine.store.getState();
		const runtime: RuntimeStoreState = {};
		for (const [path, state] of Object.entries(engineState)) {
			const uuid = this.pathToUuid.get(path);
			if (uuid) runtime[uuid] = state;
		}
		this.store.setState(runtime, true);
	}

	/** Sync ALL paths but only write UUIDs whose state actually changed.
	 *  Used by validateAll and resetValidation where many questions are
	 *  touched but most states don't change. */
	private syncAllPathsSelectively(): void {
		if (!this.engine) return;
		const engineState = this.engine.store.getState();
		const currentRuntime = this.store.getState();
		const updates: RuntimeStoreState = {};
		let hasChanges = false;

		for (const [path, newState] of Object.entries(engineState)) {
			const uuid = this.pathToUuid.get(path);
			if (!uuid) continue;
			const oldState = currentRuntime[uuid];
			if (!oldState || !statesEqual(oldState, newState)) {
				updates[uuid] = newState;
				hasChanges = true;
			}
		}

		if (hasChanges) {
			this.store.setState(updates);
		}
	}

	/** Sync specific paths to the runtime store. The primary sync method —
	 *  used after every targeted operation. Only writes UUIDs whose state
	 *  actually changed. */
	private syncPathsToStore(paths: string[]): void {
		if (!this.engine) return;
		const engineState = this.engine.store.getState();
		const currentRuntime = this.store.getState();
		const updates: RuntimeStoreState = {};
		let hasChanges = false;

		for (const path of paths) {
			const uuid = this.pathToUuid.get(path);
			if (!uuid) continue;
			const newState = engineState[path];
			if (!newState) continue;
			const oldState = currentRuntime[uuid];
			if (!oldState || !statesEqual(oldState, newState)) {
				updates[uuid] = newState;
				hasChanges = true;
			}
		}

		if (hasChanges) {
			this.store.setState(updates);
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────

	/** Find a question by UUID in the assembled question tree. */
	private findQuestionInTree(
		questions: Question[],
		uuid: string,
	): Question | undefined {
		for (const q of questions) {
			if (q.uuid === uuid) return q;
			if (q.children) {
				const found = this.findQuestionInTree(q.children, uuid);
				if (found) return found;
			}
		}
		return undefined;
	}
}
