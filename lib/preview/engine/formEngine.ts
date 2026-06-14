/**
 * FormEngine — reactive form engine backed by a Zustand store.
 *
 * The engine manages two layers:
 * 1. **DataInstance + TriggerDag** — internal computation infrastructure for
 *    XPath evaluation and dependency tracking. Not reactive.
 * 2. **Zustand store** (`engine.store`) — flat map of path → FieldState.
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
 *
 * ## Domain types
 *
 * The engine consumes domain `Form` + `Field[]` entities (via the normalized
 * doc's `fields`/`fieldOrder` maps). Internally it walks the fields as a
 * `FieldTreeNode` rose tree built at construction / schema refresh.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { JsonObject, JsonValue } from "@/lib/case-store";
import type {
	CaseProperty,
	CasePropertyDataType,
	CaseType,
	Field,
	Form,
	Uuid,
} from "@/lib/domain";
import {
	casePropertyDataTypes,
	expressionSource,
	type XPathPrintableDoc,
} from "@/lib/domain";
import {
	compilerBugMessage,
	unhandledKindMessage,
} from "@/lib/domain/predicate/errors";
import { toBoolean, xpathToString } from "../xpath/coerce";
import { evaluate } from "../xpath/evaluator";
import type { EvalContext } from "../xpath/types";
import type { SubmissionMutation } from "./caseDataBindingTypes";
import { DataInstance } from "./dataInstance";
import { buildFieldTree, type FieldTreeNode } from "./fieldTree";
import { resolveLabel } from "./labelRefs";
import { TriggerDag } from "./triggerDag";
import { type FieldState, fieldStatesEqual } from "./types";

/** Stable fallback for paths that don't exist in the engine. Frozen so
 *  Zustand selectors always return the same reference — no spurious re-renders. */
export const DEFAULT_ENGINE_STATE: FieldState = Object.freeze({
	path: "",
	value: "",
	visible: true,
	required: false,
	valid: true,
	touched: false,
});

/** The Zustand store type — flat map of XForm path → immutable FieldState. */
export type EngineStoreState = Record<string, FieldState>;

/**
 * Convenience view passed to the engine. The engine builds the `FieldTreeNode`
 * rose tree internally from these flat maps; consumers only have to supply the
 * normalized doc slice, not pre-walked trees.
 */
export interface FormEngineInput {
	/** The form entity (no nested fields). */
	form: Form;
	/** The form's uuid — used as the root key into `fieldOrder`. */
	formUuid: Uuid;
	/** Flat uuid→field map (the `doc.fields` slice). */
	fields: Record<string, Field>;
	/** Adjacency list from parent uuid → ordered child uuids (`doc.fieldOrder`). */
	fieldOrder: Record<string, Uuid[]>;
}

/** The print surface for the engine's input slice: its one form plus
 *  the supplied field maps. Every expression the engine evaluates is
 *  form-local, so this is the whole resolution world. */
function printableDocOf(input: FormEngineInput): XPathPrintableDoc {
	return {
		forms: { [input.formUuid]: input.form },
		fields: input.fields,
		fieldOrder: input.fieldOrder,
	};
}

export class FormEngine {
	/** Zustand store holding per-path FieldState. Components subscribe
	 *  via `useStore(engine.store, s => s[path])` for surgical reactivity. */
	readonly store: StoreApi<EngineStoreState>;

	private instance: DataInstance;
	private dag: TriggerDag;
	/** Doc surface AST expression slots print against — the input's
	 *  field slice rooted at its one form. Rebuilt whenever the input
	 *  is re-supplied. */
	private printDoc: XPathPrintableDoc;
	/** Rose-tree of the active form's fields. Rebuilt on schema refresh so
	 *  every walker inside the engine agrees on the same snapshot. */
	private tree: FieldTreeNode[];
	private caseData: Map<string, string>;
	private moduleCaseType: string | undefined;
	private formType: string;

	constructor(
		input: FormEngineInput,
		moduleCaseType?: string,
		caseData?: Map<string, string>,
	) {
		this.store = createStore<EngineStoreState>(() => ({}));
		this.moduleCaseType = moduleCaseType;
		this.formType = input.form.type;
		this.caseData = caseData ?? new Map();
		this.tree = buildFieldTree(input.formUuid, input.fields, input.fieldOrder);
		this.printDoc = printableDocOf(input);

		this.instance = new DataInstance();
		this.instance.initFromFields(this.tree);

		if (input.form.type === "followup" && this.caseData.size > 0) {
			this.preloadCaseData(this.tree);
		}

		this.dag = new TriggerDag();
		this.dag.build(this.tree, this.printDoc);

		/* Build initial states, apply defaults, and evaluate all expressions.
		 * The results are written to the Zustand store in one atomic setState. */
		const states: EngineStoreState = {};
		this.initStatesInto(states, this.tree);
		this.applyDefaultsInto(states, this.tree);
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

		/* Re-validate the changed field itself */
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

		// Bump `repeatCount` on the repeat's own state — this is what
		// `useEngineState` subscribers observe to re-render with the new
		// cardinality. New `[N]/...` child writes don't reach the
		// runtime store because `pathToUuid` only registers the `[0]`
		// template path; the parent's `repeatCount` is the only signal
		// per-field subscribers can observe to drive a re-render.
		const repeatState = this.store.getState()[repeatPath];
		if (repeatState) {
			updates[repeatPath] = { ...repeatState, repeatCount: newIndex + 1 };
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

		// Decrement `repeatCount` so subscribers re-render — see `addRepeat`.
		const repeatState = currentState[repeatPath];
		if (repeatState) {
			updates[repeatPath] = { ...repeatState, repeatCount: count - 1 };
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

	/**
	 * Walk the engine's template tree and emit one submission's worth
	 * of case-store mutations. The walk is structural — it consults the
	 * `FieldTreeNode` rose-tree the engine already maintains, plus the
	 * runtime `DataInstance` for per-instance values inside repeats —
	 * so the materialized paths follow from the tree shape directly
	 * without parsing the path string. `caseTypes` is call-time
	 * injected so the engine stays state-pure across the JSONB-coercion
	 * dimension.
	 *
	 * For each leaf field whose `case_property_on` matches the module's
	 * case type the value lands in the primary's `properties`; any
	 * other case-property-bound field buckets into a child case keyed
	 * by `(destination case type, repeat-instance-key)`. Repeat regions
	 * fan out one bucket per instance per destination case type.
	 *
	 * Empty values (`undefined` from an absent path or `""` from a
	 * cleared leaf) are excluded from the JSONB document — `state.visible`
	 * is intentionally NOT consulted, so a hidden field with a non-empty
	 * value lands in the mutation. This matches the "two-state JSONB
	 * collapse" rule: absent is the only shape that passes AJV strict-mode
	 * validation against `format: date` / `time` / `datetime` / geopoint
	 * patterns and aligns with Postgres-strict null semantics.
	 *
	 * Throws when `formType` is `followup` or `close` and no `caseId`
	 * is supplied — both arms operate on a bound case row.
	 */
	computeSubmissionMutation(args: {
		caseId?: string;
		caseTypes: ReadonlyArray<CaseType>;
	}): SubmissionMutation {
		if (this.formType === "survey") {
			return { kind: "survey" };
		}

		if (
			(this.formType === "followup" || this.formType === "close") &&
			args.caseId === undefined
		) {
			throw new Error(
				compilerBugMessage({
					where: "preview.formEngine.computeSubmissionMutation",
					invariant: `form type \`${this.formType}\` requires a bound \`caseId\`, but none was supplied`,
					detail:
						"Followup and close forms operate on a bound case row; the running-app view's nav stack carries the bound case id. Reaching this throw means the consumer invoked the engine method without threading the bound id through the call.",
				}),
			);
		}

		const caseTypeLookup = new Map<string, CaseType>();
		for (const caseType of args.caseTypes) {
			caseTypeLookup.set(caseType.name, caseType);
		}

		const primaryProperties: JsonObject = {};
		// `case_name` is plucked into a separate slot rather than included
		// in `properties` because the case-store routes the case display
		// name to the top-level `cases.case_name` column (see
		// `lib/case-store/store.ts` — `CaseInsert.case_name` is a top-level
		// field, not extracted from the JSONB document).
		let primaryCaseName: string | undefined;
		// Encounter-ordered child buckets so the emitted mutation is
		// deterministic per (engine state, caseTypes) pair.
		const childBuckets: ChildBucket[] = [];
		// Composite key `<caseType>::<repeatInstanceKey>` so multiple
		// fields contributing to the same child case coalesce into one
		// bucket; distinct repeat instances of the same case type produce
		// distinct buckets.
		const childBucketIndex = new Map<string, ChildBucket>();
		const requireBucket = (
			caseType: string,
			repeatInstanceKey: string,
		): ChildBucket => {
			const key = `${caseType}::${repeatInstanceKey}`;
			const existing = childBucketIndex.get(key);
			if (existing !== undefined) return existing;
			const created: ChildBucket = {
				caseType,
				properties: {},
			};
			childBucketIndex.set(key, created);
			childBuckets.push(created);
			return created;
		};

		const walk = (
			nodes: ReadonlyArray<FieldTreeNode>,
			pathPrefix: string,
			repeatInstanceKey: string,
		): void => {
			for (const node of nodes) {
				const f = node.field;
				const fieldPath = `${pathPrefix}/${f.id}`;

				if (f.kind === "group") {
					if (node.children) {
						walk(node.children, fieldPath, repeatInstanceKey);
					}
					continue;
				}
				if (f.kind === "repeat") {
					if (!node.children) continue;
					const instanceCount = this.instance.getRepeatCount(fieldPath);
					for (let i = 0; i < instanceCount; i++) {
						const instancePath = `${fieldPath}[${i}]`;
						walk(node.children, instancePath, instancePath);
					}
					continue;
				}

				const casePropertyOn = readCasePropertyOn(f);
				if (casePropertyOn === undefined) continue;

				const raw = this.instance.get(fieldPath);
				if (raw === undefined || raw === "") continue;

				const isPrimary =
					this.moduleCaseType !== undefined &&
					casePropertyOn === this.moduleCaseType;

				// `case_name` routes to the top-level `cases.case_name`
				// column, not the JSONB document. Field id is the case
				// property name (project convention), so the discriminator
				// is `f.id === "case_name"`. The string passes through
				// verbatim — `text NOT NULL` at the column means the
				// property's `data_type` is irrelevant for the column write.
				if (f.id === "case_name") {
					if (isPrimary) {
						primaryCaseName = raw;
					} else {
						const bucket = requireBucket(casePropertyOn, repeatInstanceKey);
						bucket.caseName = raw;
					}
					continue;
				}

				const property = caseTypeLookup
					.get(casePropertyOn)
					?.properties.find((p) => p.name === f.id);
				const coerced = coerceValueForProperty(raw, property);

				if (isPrimary) {
					primaryProperties[f.id] = coerced;
					continue;
				}

				const bucket = requireBucket(casePropertyOn, repeatInstanceKey);
				bucket.properties[f.id] = coerced;
			}
		};

		walk(this.tree, "/data", "");

		// A bucket that received only a `caseName` write (no scalar
		// properties) is still a legitimate child — the child has a
		// display name and platform defaults for everything else.
		// Buckets with neither a `caseName` nor any property write are
		// dropped; the walker only creates buckets when a contributing
		// field lands in them, so the predicate is defensive against an
		// upstream change to bucket creation.
		const isContentfulBucket = (b: ChildBucket): boolean =>
			b.caseName !== undefined || Object.keys(b.properties).length > 0;

		switch (this.formType) {
			case "registration": {
				if (this.moduleCaseType === undefined) {
					throw new Error(
						compilerBugMessage({
							where: "preview.formEngine.computeSubmissionMutation",
							invariant:
								"registration form reached the engine method without a `moduleCaseType`",
							detail:
								"A registration form creates a case OF the module's case type, so the case-type slot is required to derive the primary insert. The blueprint validator's `NO_CASE_TYPE` rule rejects modules without one upstream.",
						}),
					);
				}
				const children = childBuckets.filter(isContentfulBucket).map((b) => ({
					caseType: b.caseType,
					...(b.caseName !== undefined ? { caseName: b.caseName } : {}),
					properties: b.properties,
				}));
				return {
					kind: "registration",
					primary: {
						caseType: this.moduleCaseType,
						...(primaryCaseName !== undefined
							? { caseName: primaryCaseName }
							: {}),
						properties: primaryProperties,
					},
					children,
				};
			}
			case "followup":
			case "close": {
				// Top-of-method guard already rejected `args.caseId === undefined`
				// for these arms; the assertion here keeps the narrowing honest if
				// the upstream guard ever regresses.
				const caseId = args.caseId;
				if (caseId === undefined) {
					throw new Error(
						compilerBugMessage({
							where: "preview.formEngine.computeSubmissionMutation",
							invariant:
								"`caseId` narrowing failed after the followup/close form-type guard",
						}),
					);
				}
				const children = childBuckets.filter(isContentfulBucket).map((b) => ({
					caseType: b.caseType,
					...(b.caseName !== undefined ? { caseName: b.caseName } : {}),
					properties: b.properties,
					parentCaseId: caseId,
				}));
				const patch = {
					...(primaryCaseName !== undefined
						? { caseName: primaryCaseName }
						: {}),
					properties: primaryProperties,
				};
				if (this.formType === "followup") {
					return { kind: "followup", caseId, patch, children };
				}
				return { kind: "close", caseId, patch, children };
			}
			default:
				// `survey` is handled at the top of the method; the form type
				// enum carries no other arms today. The exhaustive throw guards
				// against a future arm landing without a case here.
				throw new Error(
					compilerBugMessage({
						where: "preview.formEngine.computeSubmissionMutation",
						invariant: `unhandled form type \`${this.formType}\``,
					}),
				);
		}
	}

	/** Read a path's state directly (non-reactive). For reactive access,
	 *  use `useStore(engine.store, s => s[path])` in components. */
	getState(path: string): FieldState {
		return this.store.getState()[path] ?? DEFAULT_ENGINE_STATE;
	}

	/** Get the engine's active field tree — used by the controller when it
	 *  needs to look up a field by UUID after a subscription fires. */
	getFieldTree(): FieldTreeNode[] {
		return this.tree;
	}

	/** Get all paths affected by a change at the given path, in topological
	 *  evaluation order. Used by the EngineController to sync only the
	 *  affected UUIDs to the runtime store after a setValue cascade. */
	getAffectedPaths(path: string): string[] {
		return this.dag.getAffected(path);
	}

	/**
	 * Rebuild only the TriggerDag from a refreshed form input. Does NOT rebuild
	 * the DataInstance or field states — only the dependency graph + the
	 * cached field tree.
	 *
	 * Used by the EngineController when a single field's expression changes:
	 * the DAG topology may have changed (new references) but existing values
	 * and states are still valid.
	 */
	rebuildDag(input: FormEngineInput): void {
		this.tree = buildFieldTree(input.formUuid, input.fields, input.fieldOrder);
		this.printDoc = printableDocOf(input);
		this.dag = new TriggerDag();
		this.dag.build(this.tree, this.printDoc);
	}

	/**
	 * Re-evaluate expressions for specific paths and write only the changed
	 * results to the internal store. Used by the EngineController for
	 * targeted updates when a single field's expression changes —
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
	 * Add a single field's runtime state to the engine without rebuilding
	 * existing state.
	 *
	 * Initializes the DataInstance path, creates the field's FieldState,
	 * and evaluates its expressions. Existing fields are untouched — their
	 * state objects keep the same reference in the store.
	 *
	 * The DAG must be rebuilt externally (via rebuildDag) BEFORE calling this
	 * so the new field's dependency edges are present for evaluation.
	 */
	addFieldState(path: string, field: Field): void {
		// Containers are structural — no value, no `default_value`, no
		// `required` expression. They only carry `relevant`, which the
		// `evaluatePathsInto` call below resolves into the visibility
		// flag. Skipping the DataInstance write keeps the value Map
		// pristine: only leaf fields own value paths.
		if (field.kind === "group" || field.kind === "repeat") {
			this.store.setState({
				[path]: this.initialContainerState(path, field.kind),
			});
			this.evaluatePathsInto([path]);
			return;
		}

		/* Add path to DataInstance with empty value */
		if (!this.instance.has(path)) {
			this.instance.set(path, "");
		}

		/* Initialize runtime state */
		const isRequired =
			expressionSource(field, "required", this.printDoc) === "true()";
		const state: FieldState = {
			path,
			value: this.instance.get(path) ?? "",
			visible: true,
			required: isRequired,
			valid: true,
			touched: false,
		};
		this.store.setState({ [path]: state });

		/* Apply default value if present */
		const defaultValue = expressionSource(
			field,
			"default_value",
			this.printDoc,
		);
		if (defaultValue) {
			const ctx = this.createEvalContext(path);
			const result = evaluate(defaultValue, ctx);
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
	 * Build the initial `FieldState` for a structural container. Groups
	 * and repeats carry no value of their own — the shell exists so
	 * visibility and (for repeats) instance count have a reactive home
	 * subscribers can read via `useEngineState`. Repeats seed
	 * `repeatCount: 1` because instance `[0]` is materialised at form
	 * load; `addRepeat` / `removeRepeat` are the only mutators after that.
	 *
	 * Both the bulk initializer (`initStatesInto`) and the incremental
	 * path (`addFieldState`) build container states through here so the
	 * shape stays in lockstep when slots change.
	 */
	private initialContainerState(
		path: string,
		kind: "group" | "repeat",
	): FieldState {
		const base: FieldState = {
			path,
			value: "",
			visible: true,
			required: false,
			valid: true,
			touched: false,
		};
		return kind === "repeat" ? { ...base, repeatCount: 1 } : base;
	}

	/**
	 * Remove a single field's runtime state from the engine without rebuilding
	 * existing state.
	 *
	 * Clears the field's runtime state from the store. The DataInstance
	 * retains the path (harmless — unused paths don't affect evaluation).
	 * The DAG should be rebuilt externally (via rebuildDag) AFTER removal
	 * so dependents can re-evaluate against the missing reference.
	 */
	removeFieldState(path: string): void {
		this.store.setState({ [path]: DEFAULT_ENGINE_STATE });
	}

	/**
	 * Move a field's DataInstance value from one path to another.
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
	 * Re-evaluate a field's default_value expression and cascade.
	 * Used when a field's default_value changes in the blueprint.
	 */
	reevaluateDefault(path: string, field: Field): void {
		const defaultValue = expressionSource(
			field,
			"default_value",
			this.printDoc,
		);
		if (defaultValue) {
			const ctx = this.createEvalContext(path);
			const result = evaluate(defaultValue, ctx);
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

		/* Cascade — the value change may affect dependent fields */
		const affected = this.dag.getAffected(path);
		if (affected.length > 0) {
			this.evaluatePathsInto(affected);
		}
	}

	/**
	 * Update case data context and re-evaluate affected fields.
	 * Used when form type or module case type changes. Only re-evaluates
	 * fields whose case data values changed — not the entire form.
	 */
	refreshCaseContext(
		input: FormEngineInput,
		caseData: Map<string, string>,
		moduleCaseType?: string,
	): void {
		this.tree = buildFieldTree(input.formUuid, input.fields, input.fieldOrder);
		this.formType = input.form.type;
		this.caseData = caseData;
		this.moduleCaseType = moduleCaseType;

		/* Re-preload case data for followup forms. Track which paths changed. */
		const changedPaths: string[] = [];
		if (input.form.type === "followup" && caseData.size > 0) {
			this.preloadCaseDataTracked(this.tree, changedPaths);
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
		tree: FieldTreeNode[],
		changedPaths: string[],
		prefix = "/data",
	): void {
		for (const node of tree) {
			const f = node.field;
			const path = `${prefix}/${f.id}`;
			const withCP = f as Field & { case_property_on?: string };
			if (
				withCP.case_property_on &&
				withCP.case_property_on === this.moduleCaseType &&
				this.caseData.has(f.id)
			) {
				const newValue = this.caseData.get(f.id) ?? "";
				const oldValue = this.instance.get(path) ?? "";
				if (newValue !== oldValue) {
					this.instance.set(path, newValue);
					changedPaths.push(path);
				}
			}
			if (node.children) {
				const childPrefix = f.kind === "repeat" ? `${path}[0]` : path;
				this.preloadCaseDataTracked(node.children, changedPaths, childPrefix);
			}
		}
	}

	/**
	 * Update the engine's form schema in-place. Keeps the engine REFERENCE
	 * stable so context consumers don't cascade. Called from a Zustand
	 * subscription (outside React render).
	 */
	updateSchema(
		input: FormEngineInput,
		moduleCaseType?: string,
		caseData?: Map<string, string>,
	): void {
		const snapshot = this.getValueSnapshot();

		this.moduleCaseType = moduleCaseType;
		this.formType = input.form.type;
		this.caseData = caseData ?? new Map();
		this.tree = buildFieldTree(input.formUuid, input.fields, input.fieldOrder);
		this.printDoc = printableDocOf(input);

		this.instance = new DataInstance();
		this.instance.initFromFields(this.tree);

		if (input.form.type === "followup" && this.caseData.size > 0) {
			this.preloadCaseData(this.tree);
		}

		this.dag = new TriggerDag();
		this.dag.build(this.tree, this.printDoc);

		/* Capture old store state BEFORE rebuilding. After rebuild + evaluate +
		 * restore, we diff old vs new and only write paths that actually changed.
		 * This preserves old object references for unchanged paths — Zustand
		 * selectors see the same reference via Object.is and skip re-rendering. */
		const oldStates = this.store.getState();

		/* Rebuild into a local record (doesn't touch the store yet) */
		const newStates: EngineStoreState = {};
		this.initStatesInto(newStates, this.tree);
		this.applyDefaultsInto(newStates, this.tree);

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
				oldState && fieldStatesEqual(oldState, rebuiltState)
					? oldState
					: rebuiltState;
		}
		this.store.setState(finalStates, true);
	}

	/** Full reset — reinitialize all values, defaults, and expressions. */
	reset(): void {
		this.instance = new DataInstance();
		this.instance.initFromFields(this.tree);

		if (this.formType === "followup" && this.caseData.size > 0) {
			this.preloadCaseData(this.tree);
		}

		const states: EngineStoreState = {};
		this.initStatesInto(states, this.tree);
		this.applyDefaultsInto(states, this.tree);
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
					const f = this.findField(path);
					if (f) {
						const resolve = (exprStr: string): string =>
							xpathToString(evaluate(exprStr, ctx));
						const rl = resolveLabel(
							expressionSource(f, "label", this.printDoc),
							resolve,
						);
						const rh = resolveLabel(
							expressionSource(f, "hint", this.printDoc),
							resolve,
						);
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
		state: FieldState,
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
		state: FieldState,
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
		const field = this.findField(path);
		const errorMessage = valid
			? undefined
			: ((field
					? expressionSource(field, "validate_msg", this.printDoc)
					: undefined) ?? "Invalid value");

		if (valid !== state.valid || errorMessage !== state.errorMessage) {
			updates[path] = { ...state, valid, errorMessage };
		}
	}

	// ── Private: state initialization ────────────────────────────────

	private preloadCaseData(tree: FieldTreeNode[], prefix = "/data"): void {
		for (const node of tree) {
			const f = node.field;
			const path = `${prefix}/${f.id}`;
			const withCP = f as Field & { case_property_on?: string };
			if (
				withCP.case_property_on &&
				withCP.case_property_on === this.moduleCaseType &&
				this.caseData.has(f.id)
			) {
				this.instance.set(path, this.caseData.get(f.id) ?? "");
			}
			if (node.children) {
				const childPrefix = f.kind === "repeat" ? `${path}[0]` : path;
				this.preloadCaseData(node.children, childPrefix);
			}
		}
	}

	/** Build initial FieldState objects into the provided record. */
	private initStatesInto(
		states: EngineStoreState,
		tree: FieldTreeNode[],
		prefix = "/data",
	): void {
		for (const node of tree) {
			const f = node.field;
			const path = `${prefix}/${f.id}`;

			if (f.kind === "group" || f.kind === "repeat") {
				states[path] = this.initialContainerState(path, f.kind);
				if (node.children) {
					const childPrefix = f.kind === "repeat" ? `${path}[0]` : path;
					this.initStatesInto(states, node.children, childPrefix);
				}
			} else {
				states[path] = {
					path,
					value: this.instance.get(path) ?? "",
					visible: true,
					required: expressionSource(f, "required", this.printDoc) === "true()",
					valid: true,
					touched: false,
				};
			}
		}
	}

	/** Apply default_value expressions into the provided record. */
	private applyDefaultsInto(
		states: EngineStoreState,
		tree: FieldTreeNode[],
		prefix = "/data",
	): void {
		for (const node of tree) {
			const f = node.field;
			const path = `${prefix}/${f.id}`;
			const defaultValue = expressionSource(f, "default_value", this.printDoc);
			if (defaultValue) {
				const ctx = this.createEvalContext(path);
				const result = evaluate(defaultValue, ctx);
				const value = xpathToString(result);
				if (value && value !== "false") {
					this.instance.set(path, value);
					const state = states[path];
					if (state) {
						states[path] = { ...state, value };
					}
				}
			}
			if (node.children) {
				const childPrefix = f.kind === "repeat" ? `${path}[0]` : path;
				this.applyDefaultsInto(states, node.children, childPrefix);
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
					const fieldId = ref.slice(6);
					return this.instance.get(`/data/${fieldId}`) ?? "";
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

	private findField(
		path: string,
		tree?: FieldTreeNode[],
		prefix = "/data",
	): Field | undefined {
		for (const node of tree ?? this.tree) {
			const f = node.field;
			const fPath = `${prefix}/${f.id}`;
			const normalizedPath = path.replace(/\[\d+\]/g, "[0]");
			const normalizedFPath = fPath.replace(/\[\d+\]/g, "[0]");
			if (normalizedPath === normalizedFPath) return f;
			if (node.children) {
				const childPrefix = f.kind === "repeat" ? `${fPath}[0]` : fPath;
				const found = this.findField(path, node.children, childPrefix);
				if (found) return found;
			}
		}
		return undefined;
	}
}

// ── Submission-mutation helpers ──────────────────────────────────────

/**
 * Per-destination-bucket of field reads. The walker indexes one
 * bucket per `(caseType, repeatInstanceKey)` pair so a registration
 * form whose `child_visit` repeat carries three iterations produces
 * three separate child-case ops, not one merged op. The empty-string
 * `repeatInstanceKey` collapses fields outside any repeat into a
 * single bucket per case type.
 *
 * `caseName` is mutable because the walker encounters the
 * `case_name`-id field at most once per bucket. The slot stays
 * separate from `properties` because `case_name` routes to the
 * top-level `cases.case_name` column, not the JSONB document.
 */
interface ChildBucket {
	caseType: string;
	caseName?: string;
	properties: JsonObject;
}

/**
 * Read `case_property_on` off a domain `Field` generically. The
 * property lives on `inputFieldBaseSchema` only, but reading through
 * the discriminated union without per-kind narrowing keeps the
 * walker free of N×M branching.
 */
function readCasePropertyOn(field: Field): string | undefined {
	const value = (field as unknown as Record<string, unknown>).case_property_on;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Coerce the form engine's string value into the typed JSON value
 * the case-store JSON Schema validator expects. Mirrors
 * `caseTypeToJsonSchema`'s per-`data_type` mapping. Properties whose
 * declaration cannot be resolved (missing case type or missing
 * property) default to `text` pass-through — preserves the value
 * verbatim rather than dropping it. Empty raw values never reach
 * this function — the walker filters them upstream.
 */
function coerceValueForProperty(
	raw: string,
	property: CaseProperty | undefined,
): JsonValue {
	const dataType: CasePropertyDataType = property?.data_type ?? "text";
	switch (dataType) {
		case "text":
		case "single_select":
		case "geopoint":
		case "date":
		case "time":
		case "datetime":
			return raw;
		case "int": {
			const parsed = Number.parseInt(raw, 10);
			return Number.isInteger(parsed) && Number.isFinite(parsed) ? parsed : raw;
		}
		case "decimal": {
			const parsed = Number.parseFloat(raw);
			return Number.isFinite(parsed) ? parsed : raw;
		}
		case "multi_select":
			return raw.split(/\s+/).filter((token) => token.length > 0);
		default: {
			const _exhaustive: never = dataType;
			throw new Error(
				unhandledKindMessage({
					where: "preview.formEngine.coerceValueForProperty",
					family: "CasePropertyDataType",
					received: _exhaustive,
					knownKinds: [...casePropertyDataTypes],
				}),
			);
		}
	}
}
