/**
 * FormEngine — reactive form engine backed by a Zustand store.
 *
 * The engine manages two layers:
 * 1. **DataInstance + TriggerDag** — internal computation infrastructure for
 *    XPath evaluation and dependency tracking. Not reactive.
 * 2. **Zustand store** (`engine.store`) — flat map of path → QuestionState.
 *    Components subscribe via `useStore(engine.store, s => s[path])` and get
 *    the same per-path reactivity as the builder store's entity selectors.
 *
 * On `setValue`, the engine updates the DataInstance, evaluates affected
 * expressions, and writes only the changed paths to the Zustand store in a
 * single `setState` call. Zustand's shallow merge ensures unchanged paths
 * keep their old references — subscribers for those paths don't re-render.
 *
 * No custom subscription system, no notification code, no change detection
 * abstractions. Zustand handles all of it.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type {
	BlueprintForm,
	CaseType,
	Question,
} from "@/lib/schemas/blueprint";
import { toBoolean, xpathToString } from "../xpath/coerce";
import { evaluate } from "../xpath/evaluator";
import type { EvalContext } from "../xpath/types";
import { DataInstance } from "./dataInstance";
import { resolveLabel } from "./labelRefs";
import { TriggerDag } from "./triggerDag";
import type { QuestionState } from "./types";

/** Stable fallback for paths that don't exist in the engine. Frozen so
 *  Zustand selectors always return the same reference — no spurious re-renders. */
export const DEFAULT_ENGINE_STATE: QuestionState = Object.freeze({
	path: "",
	value: "",
	visible: true,
	required: false,
	valid: true,
	touched: false,
});

/** The Zustand store type — flat map of XForm path → immutable QuestionState. */
export type EngineStoreState = Record<string, QuestionState>;

/** Field-level equality check for QuestionState. Used by updateSchema to
 *  diff old vs new states and only notify subscribers for paths that
 *  actually changed. */
function statesEqual(a: QuestionState, b: QuestionState): boolean {
	return (
		a.path === b.path &&
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

export class FormEngine {
	/** Zustand store holding per-path QuestionState. Components subscribe
	 *  via `useStore(engine.store, s => s[path])` for surgical reactivity. */
	readonly store: StoreApi<EngineStoreState>;

	private instance: DataInstance;
	private dag: TriggerDag;
	private mergedQuestions: Question[];
	private caseData: Map<string, string>;
	private moduleCaseType: string | undefined;
	private formType: string;

	constructor(
		form: BlueprintForm,
		_caseTypes?: CaseType[] | null,
		moduleCaseType?: string,
		caseData?: Map<string, string>,
	) {
		this.store = createStore<EngineStoreState>(() => ({}));
		this.moduleCaseType = moduleCaseType;
		this.formType = form.type;
		this.caseData = caseData ?? new Map();
		this.mergedQuestions = form.questions;

		this.instance = new DataInstance();
		this.instance.initFromQuestions(this.mergedQuestions);

		if (form.type === "followup" && this.caseData.size > 0) {
			this.preloadCaseData(this.mergedQuestions);
		}

		this.dag = new TriggerDag();
		this.dag.build(this.mergedQuestions);

		/* Build initial states, apply defaults, and evaluate all expressions.
		 * The results are written to the Zustand store in one atomic setState. */
		const states: EngineStoreState = {};
		this.initStatesInto(states, this.mergedQuestions);
		this.applyDefaultsInto(states, this.mergedQuestions);
		this.store.setState(states);
		this.evaluateAllInto();
	}

	// ── Public API ───────────────────────────────────────────────────

	/** Set a value and trigger recalculation cascade. Only changed paths
	 *  are written to the store — Zustand's shallow merge keeps unchanged
	 *  paths' references stable, so their subscribers skip re-rendering. */
	setValue(path: string, value: string): void {
		this.instance.set(path, value);

		const updates: EngineStoreState = {};
		const current = this.store.getState()[path];
		if (current && current.value !== value) {
			updates[path] = { ...current, value };
		}

		/* Cascade: re-evaluate expressions for all affected paths. Only
		 * paths whose state actually changed are included in the update. */
		const affected = this.dag.getAffected(path);
		for (const affectedPath of affected) {
			this.evaluateAndCollect(affectedPath, updates);
		}

		/* Re-validate the changed question itself */
		const latestState = updates[path] ?? current;
		if (latestState) {
			if (latestState.touched) {
				this.validateAndCollect(path, latestState, updates);
			} else {
				this.evaluateValidationAndCollect(path, latestState, updates);
			}
		}

		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}
	}

	/** Add a new repeat instance. Returns the new index. */
	addRepeat(repeatPath: string): number {
		const newIndex = this.instance.addRepeatInstance(repeatPath);

		const updates: EngineStoreState = {};
		const templatePrefix = `${repeatPath}[0]/`;
		for (const [key] of this.instance.entries()) {
			if (key.startsWith(`${repeatPath}[${newIndex}]/`)) {
				const suffix = key.slice(`${repeatPath}[${newIndex}]/`.length);
				const templatePath = templatePrefix + suffix;
				const templateState = this.store.getState()[templatePath];
				updates[key] = {
					path: key,
					value: "",
					visible: templateState?.visible ?? true,
					required: templateState?.required ?? false,
					valid: true,
					touched: false,
				};
			}
		}

		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}
		return newIndex;
	}

	/** Remove a repeat instance. */
	removeRepeat(repeatPath: string, index: number): void {
		const count = this.instance.getRepeatCount(repeatPath);
		if (count <= 1) return;

		const currentState = this.store.getState();
		const updates: EngineStoreState = {};

		/* Mark removed paths as the frozen default — subscribers get a stable
		 * reference that won't change, effectively "unplugging" them. */
		const prefix = `${repeatPath}[${index}]/`;
		for (const key of Object.keys(currentState)) {
			if (key.startsWith(prefix)) {
				updates[key] = DEFAULT_ENGINE_STATE;
			}
		}

		/* Renumber states for higher indices */
		for (let i = index + 1; i < count; i++) {
			const oldPrefix = `${repeatPath}[${i}]/`;
			const newPrefix = `${repeatPath}[${i - 1}]/`;
			for (const [key, state] of Object.entries(currentState)) {
				if (key.startsWith(oldPrefix)) {
					const suffix = key.slice(oldPrefix.length);
					const newPath = newPrefix + suffix;
					updates[key] = DEFAULT_ENGINE_STATE;
					updates[newPath] = { ...state, path: newPath };
				}
			}
		}

		this.instance.removeRepeatInstance(repeatPath, index);
		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}
	}

	/** Get the repeat count for a repeat group path. */
	getRepeatCount(repeatPath: string): number {
		return this.instance.getRepeatCount(repeatPath);
	}

	/**
	 * Mark a field as touched (on blur). Runs validation rules only — required
	 * is intentionally deferred to submit.
	 */
	touch(path: string): void {
		const current = this.store.getState()[path];
		if (!current || current.touched) return;

		const updates: EngineStoreState = {};
		const touched = { ...current, touched: true };
		updates[path] = touched;
		this.evaluateValidationAndCollect(path, touched, updates);
		this.store.setState(updates);
	}

	/**
	 * Validate all visible fields. Marks every field as touched, runs required
	 * checks and validation rules. Returns true if the form is valid.
	 */
	validateAll(): boolean {
		let valid = true;
		const updates: EngineStoreState = {};
		const currentState = this.store.getState();

		for (const [path, state] of Object.entries(currentState)) {
			if (state === DEFAULT_ENGINE_STATE) continue;
			if (!state.visible) continue;

			const touched = state.touched ? state : { ...state, touched: true };
			if (touched !== state) updates[path] = touched;

			this.validateAndCollect(path, updates[path] ?? touched, updates);
			const final = updates[path] ?? touched;
			if (!final.valid) valid = false;
		}

		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}
		return valid;
	}

	/** Read a path's state directly (non-reactive). For reactive access,
	 *  use `useStore(engine.store, s => s[path])` in components. */
	getState(path: string): QuestionState {
		return this.store.getState()[path] ?? DEFAULT_ENGINE_STATE;
	}

	/** Get the merged question tree. */
	getQuestions(): Question[] {
		return this.mergedQuestions;
	}

	/** Get all paths affected by a change at the given path, in topological
	 *  evaluation order. Used by the EngineController to sync only the
	 *  affected UUIDs to the runtime store after a setValue cascade. */
	getAffectedPaths(path: string): string[] {
		return this.dag.getAffected(path);
	}

	/**
	 * Rebuild only the TriggerDag from a new form schema. Does NOT rebuild
	 * the DataInstance or question states — only the dependency graph.
	 *
	 * Used by the EngineController when a single question's expression
	 * changes: the DAG topology may have changed (new references), but
	 * existing values and states are still valid.
	 */
	rebuildDag(form: BlueprintForm): void {
		this.mergedQuestions = form.questions;
		this.dag = new TriggerDag();
		this.dag.build(this.mergedQuestions);
	}

	/**
	 * Re-evaluate expressions for specific paths and write only the changed
	 * results to the internal store. Used by the EngineController for
	 * targeted updates when a single question's expression changes —
	 * avoids re-evaluating the entire form.
	 */
	evaluatePathsInto(paths: string[]): void {
		const updates: EngineStoreState = {};
		for (const path of paths) {
			this.evaluateAndCollect(path, updates);
		}
		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}
	}

	/** Return all paths tracked by the DAG, in topological order. */
	getAllPaths(): string[] {
		return this.dag.getAllPaths();
	}

	// ── Incremental operations ───────────────────────────────────────

	/**
	 * Add a single question to the engine without rebuilding existing state.
	 *
	 * Initializes the DataInstance path, creates the question's runtime state,
	 * and evaluates its expressions. Existing questions are untouched — their
	 * state objects keep the same reference in the store.
	 *
	 * The DAG must be rebuilt externally (via rebuildDag) BEFORE calling this
	 * so the new question's dependency edges are present for evaluation.
	 */
	addQuestionState(path: string, question: Question): void {
		/* Add path to DataInstance with empty value */
		if (!this.instance.has(path)) {
			this.instance.set(path, "");
		}

		/* Initialize runtime state */
		const isRequired = question.required === "true()";
		const state: QuestionState = {
			path,
			value: this.instance.get(path) ?? "",
			visible: true,
			required: isRequired,
			valid: true,
			touched: false,
		};
		this.store.setState({ [path]: state });

		/* Apply default value if present */
		if (question.default_value) {
			const ctx = this.createEvalContext(path);
			const result = evaluate(question.default_value, ctx);
			const value = xpathToString(result);
			if (value && value !== "false") {
				this.instance.set(path, value);
				this.store.setState({ [path]: { ...state, value } });
			}
		}

		/* Evaluate expressions (calculate, relevant, required, validation) */
		this.evaluatePathsInto([path]);
	}

	/**
	 * Remove a single question from the engine without rebuilding existing state.
	 *
	 * Clears the question's runtime state from the store. The DataInstance
	 * retains the path (harmless — unused paths don't affect evaluation).
	 * The DAG should be rebuilt externally (via rebuildDag) AFTER removal
	 * so dependents can re-evaluate against the missing reference.
	 */
	removeQuestionState(path: string): void {
		this.store.setState({ [path]: DEFAULT_ENGINE_STATE });
	}

	/**
	 * Move a question's DataInstance value from one path to another.
	 * Used after ID renames where the XForm path changes.
	 */
	renamePath(oldPath: string, newPath: string): void {
		const value = this.instance.get(oldPath) ?? "";
		this.instance.set(newPath, value);

		/* Move runtime state to the new path */
		const oldState = this.store.getState()[oldPath];
		if (oldState) {
			this.store.setState({
				[oldPath]: DEFAULT_ENGINE_STATE,
				[newPath]: { ...oldState, path: newPath },
			});
		}
	}

	/**
	 * Re-evaluate a question's default_value expression and cascade.
	 * Used when a question's default_value field changes in the blueprint.
	 */
	reevaluateDefault(path: string, question: Question): void {
		if (question.default_value) {
			const ctx = this.createEvalContext(path);
			const result = evaluate(question.default_value, ctx);
			const value = xpathToString(result);
			if (value && value !== "false") {
				this.instance.set(path, value);
				const current = this.store.getState()[path];
				if (current && !current.touched) {
					/* Only apply default if the user hasn't touched this field */
					this.store.setState({ [path]: { ...current, value } });
				}
			}
		}

		/* Cascade — the value change may affect dependent questions */
		const affected = this.dag.getAffected(path);
		if (affected.length > 0) {
			this.evaluatePathsInto(affected);
		}
	}

	/**
	 * Update case data context and re-evaluate affected questions.
	 * Used when form type or module case type changes. Only re-evaluates
	 * questions whose case data values changed — not the entire form.
	 */
	refreshCaseContext(
		form: BlueprintForm,
		caseData: Map<string, string>,
		moduleCaseType?: string,
	): void {
		this.mergedQuestions = form.questions;
		this.formType = form.type;
		this.caseData = caseData;
		this.moduleCaseType = moduleCaseType;

		/* Re-preload case data for followup forms. Track which paths changed. */
		const changedPaths: string[] = [];
		if (form.type === "followup" && caseData.size > 0) {
			this.preloadCaseDataTracked(this.mergedQuestions, changedPaths);
		}

		/* Re-evaluate changed paths + their cascade */
		if (changedPaths.length > 0) {
			const allAffected = new Set(changedPaths);
			for (const path of changedPaths) {
				for (const dep of this.dag.getAffected(path)) {
					allAffected.add(dep);
				}
			}
			this.evaluatePathsInto([...allAffected]);
		}
	}

	/** Same as preloadCaseData but tracks which paths actually changed value. */
	private preloadCaseDataTracked(
		questions: Question[],
		changedPaths: string[],
		prefix = "/data",
	): void {
		for (const q of questions) {
			const path = `${prefix}/${q.id}`;
			if (
				q.case_property_on &&
				q.case_property_on === this.moduleCaseType &&
				this.caseData.has(q.id)
			) {
				const newValue = this.caseData.get(q.id) ?? "";
				const oldValue = this.instance.get(path) ?? "";
				if (newValue !== oldValue) {
					this.instance.set(path, newValue);
					changedPaths.push(path);
				}
			}
			if (q.children) {
				const childPrefix = q.type === "repeat" ? `${path}[0]` : path;
				this.preloadCaseDataTracked(q.children, changedPaths, childPrefix);
			}
		}
	}

	/**
	 * Update the engine's form schema in-place. Keeps the engine REFERENCE
	 * stable so context consumers don't cascade. Called from a Zustand
	 * subscription (outside React render).
	 */
	updateSchema(
		form: BlueprintForm,
		_caseTypes?: CaseType[] | null,
		moduleCaseType?: string,
		caseData?: Map<string, string>,
	): void {
		const snapshot = this.getValueSnapshot();

		this.moduleCaseType = moduleCaseType;
		this.formType = form.type;
		this.caseData = caseData ?? new Map();
		this.mergedQuestions = form.questions;

		this.instance = new DataInstance();
		this.instance.initFromQuestions(this.mergedQuestions);

		if (form.type === "followup" && this.caseData.size > 0) {
			this.preloadCaseData(this.mergedQuestions);
		}

		this.dag = new TriggerDag();
		this.dag.build(this.mergedQuestions);

		/* Capture old store state BEFORE rebuilding. After rebuild + evaluate +
		 * restore, we diff old vs new and only write paths that actually changed.
		 * This preserves old object references for unchanged paths — Zustand
		 * selectors see the same reference via Object.is and skip re-rendering. */
		const oldStates = this.store.getState();

		/* Rebuild into a local record (doesn't touch the store yet) */
		const newStates: EngineStoreState = {};
		this.initStatesInto(newStates, this.mergedQuestions);
		this.applyDefaultsInto(newStates, this.mergedQuestions);

		/* Temporarily write to store so evaluateAllInto can read current state
		 * via getState(). Use replace mode — we'll fix references below. */
		this.store.setState(newStates, true);
		this.evaluateAllInto();

		/* Restore user-touched values from the pre-rebuild snapshot */
		this.restoreValues(snapshot);

		/* Diff: compare rebuilt state against what was in the store before.
		 * For unchanged paths, restore the OLD reference so Object.is returns
		 * true in Zustand selectors → subscribers skip re-rendering. */
		const rebuiltStates = this.store.getState();
		const finalStates: EngineStoreState = {};
		for (const [path, rebuiltState] of Object.entries(rebuiltStates)) {
			const oldState = oldStates[path];
			/* Keep old reference if every field is identical */
			finalStates[path] =
				oldState && statesEqual(oldState, rebuiltState)
					? oldState
					: rebuiltState;
		}
		this.store.setState(finalStates, true);
	}

	/** Full reset — reinitialize all values, defaults, and expressions. */
	reset(): void {
		this.instance = new DataInstance();
		this.instance.initFromQuestions(this.mergedQuestions);

		if (this.formType === "followup" && this.caseData.size > 0) {
			this.preloadCaseData(this.mergedQuestions);
		}

		const states: EngineStoreState = {};
		this.initStatesInto(states, this.mergedQuestions);
		this.applyDefaultsInto(states, this.mergedQuestions);
		this.store.setState(states, true);
		this.evaluateAllInto();
	}

	/** Clear touched state and validation errors (for mode switches). */
	resetValidation(): void {
		const updates: EngineStoreState = {};
		for (const [path, state] of Object.entries(this.store.getState())) {
			if (state === DEFAULT_ENGINE_STATE) continue;
			if (state.touched || !state.valid || state.errorMessage) {
				updates[path] = {
					...state,
					touched: false,
					valid: true,
					errorMessage: undefined,
				};
			}
		}
		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}
	}

	/** Snapshot all values and touched state for persisting across schema updates. */
	getValueSnapshot(): { values: Map<string, string>; touched: Set<string> } {
		const values = new Map<string, string>();
		const touched = new Set<string>();
		for (const [path, state] of Object.entries(this.store.getState())) {
			if (state === DEFAULT_ENGINE_STATE) continue;
			if (state.value) values.set(path, state.value);
			if (state.touched) touched.add(path);
		}
		return { values, touched };
	}

	/** Restore values from a snapshot and re-evaluate expressions. */
	restoreValues(snapshot: {
		values: Map<string, string>;
		touched: Set<string>;
	}): void {
		const updates: EngineStoreState = {};
		const currentState = this.store.getState();

		/* Restore user-touched values; untouched fields keep new defaults */
		for (const path of snapshot.touched) {
			const value = snapshot.values.get(path);
			const current = currentState[path];
			if (value !== undefined && current) {
				this.instance.set(path, value);
				updates[path] = { ...current, value };
			}
		}

		/* Write restored values, then re-evaluate all expressions */
		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}

		/* Re-evaluate all expressions with restored values */
		this.evaluateAllInto();

		/* Restore touched state and validate */
		const touchUpdates: EngineStoreState = {};
		for (const path of snapshot.touched) {
			const current = this.store.getState()[path];
			if (current && !current.touched) {
				const touched = { ...current, touched: true };
				touchUpdates[path] = touched;
				this.validateAndCollect(path, touched, touchUpdates);
			}
		}
		if (Object.keys(touchUpdates).length > 0) {
			this.store.setState(touchUpdates);
		}
	}

	// ── Private: expression evaluation ───────────────────────────────

	/** Evaluate an expression for a path and add it to `updates` only if the
	 *  result differs from the current store state. This is the mechanism that
	 *  makes Zustand's selector-based subscriptions surgical: unchanged paths
	 *  keep their old reference, so their subscribers skip re-rendering. */
	private evaluateAndCollect(path: string, updates: EngineStoreState): void {
		const current = updates[path] ?? this.store.getState()[path];
		if (!current) return;

		const expressions = this.dag.getExpressions(path);
		if (expressions.length === 0) return;

		const ctx = this.createEvalContext(path);
		let changed = false;
		let visible = current.visible;
		let required = current.required;
		let value = current.value;
		let resolvedLabel = current.resolvedLabel;
		let resolvedHint = current.resolvedHint;
		let hasValidation = false;

		for (const { type, expr } of expressions) {
			switch (type) {
				case "calculate": {
					const result = evaluate(expr, ctx);
					const v = xpathToString(result);
					this.instance.set(path, v);
					if (v !== value) {
						value = v;
						changed = true;
					}
					break;
				}
				case "relevant": {
					const v = toBoolean(evaluate(expr, ctx));
					if (v !== visible) {
						visible = v;
						changed = true;
					}
					break;
				}
				case "required": {
					const v = toBoolean(evaluate(expr, ctx));
					if (v !== required) {
						required = v;
						changed = true;
					}
					break;
				}
				case "validation": {
					hasValidation = true;
					break;
				}
				case "output": {
					const q = this.findQuestion(path);
					if (q) {
						const resolve = (exprStr: string): string =>
							xpathToString(evaluate(exprStr, ctx));
						const rl = resolveLabel(q.label, resolve);
						const rh = resolveLabel(q.hint, resolve);
						if (rl !== resolvedLabel || rh !== resolvedHint) {
							resolvedLabel = rl;
							resolvedHint = rh;
							changed = true;
						}
					}
					break;
				}
			}
		}

		if (changed) {
			updates[path] = {
				...current,
				visible,
				required,
				value,
				resolvedLabel,
				resolvedHint,
			};
		}

		if (hasValidation) {
			this.evaluateValidationAndCollect(
				path,
				updates[path] ?? current,
				updates,
			);
		}
	}

	/** Evaluate all expressions and write results directly to the store.
	 *  Used during init and schema rebuild. */
	private evaluateAllInto(): void {
		const updates: EngineStoreState = {};
		const allPaths = this.dag.getAllPaths();
		for (const path of allPaths) {
			this.evaluateAndCollect(path, updates);
		}
		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}
	}

	// ── Private: validation ──────────────────────────────────────────

	private validateAndCollect(
		path: string,
		state: QuestionState,
		updates: EngineStoreState,
	): void {
		if (state.required && !state.value) {
			if (state.valid || state.errorMessage !== "This field is required") {
				updates[path] = {
					...state,
					valid: false,
					errorMessage: "This field is required",
				};
			}
			return;
		}
		this.evaluateValidationAndCollect(path, state, updates);
	}

	private evaluateValidationAndCollect(
		path: string,
		state: QuestionState,
		updates: EngineStoreState,
	): void {
		const expressions = this.dag.getExpressions(path);
		const validationExpr = expressions.find((e) => e.type === "validation");
		if (!validationExpr || !state.value) {
			if (!state.valid || state.errorMessage !== undefined) {
				updates[path] = { ...state, valid: true, errorMessage: undefined };
			}
			return;
		}

		const ctx = this.createEvalContext(path);
		const result = evaluate(validationExpr.expr, ctx);
		const valid = toBoolean(result);
		const errorMessage = valid
			? undefined
			: (this.findQuestion(path)?.validation_msg ?? "Invalid value");

		if (valid !== state.valid || errorMessage !== state.errorMessage) {
			updates[path] = { ...state, valid, errorMessage };
		}
	}

	// ── Private: state initialization ────────────────────────────────

	private preloadCaseData(questions: Question[], prefix = "/data"): void {
		for (const q of questions) {
			const path = `${prefix}/${q.id}`;
			if (
				q.case_property_on &&
				q.case_property_on === this.moduleCaseType &&
				this.caseData.has(q.id)
			) {
				this.instance.set(path, this.caseData.get(q.id) ?? "");
			}
			if (q.children) {
				const childPrefix = q.type === "repeat" ? `${path}[0]` : path;
				this.preloadCaseData(q.children, childPrefix);
			}
		}
	}

	/** Build initial QuestionState objects into the provided record. */
	private initStatesInto(
		states: EngineStoreState,
		questions: Question[],
		prefix = "/data",
	): void {
		for (const q of questions) {
			const path = `${prefix}/${q.id}`;

			if (q.type === "group" || q.type === "repeat") {
				states[path] = {
					path,
					value: "",
					visible: true,
					required: false,
					valid: true,
					touched: false,
				};
				if (q.children) {
					const childPrefix = q.type === "repeat" ? `${path}[0]` : path;
					this.initStatesInto(states, q.children, childPrefix);
				}
			} else {
				states[path] = {
					path,
					value: this.instance.get(path) ?? "",
					visible: true,
					required: q.required === "true()",
					valid: true,
					touched: false,
				};
			}
		}
	}

	/** Apply default_value expressions into the provided record. */
	private applyDefaultsInto(
		states: EngineStoreState,
		questions: Question[],
		prefix = "/data",
	): void {
		for (const q of questions) {
			const path = `${prefix}/${q.id}`;
			if (q.default_value) {
				const ctx = this.createEvalContext(path);
				const result = evaluate(q.default_value, ctx);
				const value = xpathToString(result);
				if (value && value !== "false") {
					this.instance.set(path, value);
					const state = states[path];
					if (state) {
						states[path] = { ...state, value };
					}
				}
			}
			if (q.children) {
				const childPrefix = q.type === "repeat" ? `${path}[0]` : path;
				this.applyDefaultsInto(states, q.children, childPrefix);
			}
		}
	}

	// ── Private: XPath evaluation context ────────────────────────────

	private createEvalContext(path: string): EvalContext {
		let position = 1;
		let size = 1;
		const repeatMatch = path.match(/\[(\d+)\]/);
		if (repeatMatch) {
			position = Number.parseInt(repeatMatch[1], 10) + 1;
			const repeatBase = path.slice(0, path.indexOf("["));
			size = this.instance.getRepeatCount(repeatBase);
		}

		return {
			getValue: (p: string) => this.instance.get(p),
			resolveHashtag: (ref: string) => {
				if (ref.startsWith("#form/")) {
					const questionId = ref.slice(6);
					return this.instance.get(`/data/${questionId}`) ?? "";
				}
				if (ref.startsWith("#case/")) {
					const prop = ref.slice(6);
					return this.caseData.get(prop) ?? "";
				}
				if (ref.startsWith("#user/")) {
					const prop = ref.slice(6);
					const userDefaults: Record<string, string> = {
						username: "demo_user",
						first_name: "Demo",
						last_name: "User",
						phone_number: "+1234567890",
					};
					return userDefaults[prop] ?? `[user:${prop}]`;
				}
				return "";
			},
			contextPath: path,
			position,
			size,
		};
	}

	private findQuestion(
		path: string,
		questions?: Question[],
		prefix = "/data",
	): Question | undefined {
		for (const q of questions ?? this.mergedQuestions) {
			const qPath = `${prefix}/${q.id}`;
			const normalizedPath = path.replace(/\[\d+\]/g, "[0]");
			const normalizedQPath = qPath.replace(/\[\d+\]/g, "[0]");
			if (normalizedPath === normalizedQPath) return q;
			if (q.children) {
				const childPrefix = q.type === "repeat" ? `${qPath}[0]` : qPath;
				const found = this.findQuestion(path, q.children, childPrefix);
				if (found) return found;
			}
		}
		return undefined;
	}
}
