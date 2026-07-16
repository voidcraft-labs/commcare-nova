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
	CASE_LOADING_FORM_TYPES,
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
import {
	rebaseOntoContext,
	remapInstancePath,
	stripIndices,
} from "./instancePaths";
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
 * Case data threaded into the engine, keyed by case-type NAME: the
 * loaded case under the module's own type plus one entry per ancestor
 * type in its parent chain (the shallowest row of a type owns the
 * namespace — `caseRowsToFormPreloads` builds the shape). Each inner
 * map is a flattened property bag: JSONB keys plus the reserved
 * scalar aliases (`case_id`, `date_opened`, …).
 */
export type CaseDataByType = Map<string, Map<string, string>>;

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
	private caseData: CaseDataByType;
	private moduleCaseType: string | undefined;
	/** The module case type `caseData` was SUPPLIED under — the type
	 *  whose entry is the bound row. Stamped only where a fresh
	 *  (caseData, moduleCaseType) pair arrives together (constructor,
	 *  `updateSchema`), NOT by `refreshCaseContext`, which re-pairs the
	 *  existing data with new metadata — so after a mid-preview module
	 *  retype the mismatch is detectable and preload can't seed fields
	 *  from an ancestor's row as if it were the bound case. */
	private caseDataOwnType: string | undefined;
	private formType: string;
	/** Live repeat-instance counts for the DAG's generic→concrete
	 *  materialization. Arrow property so it can pass as a bare callback. */
	private repeatCounts = (repeatPath: string): number =>
		this.instance.getRepeatCount(repeatPath);

	constructor(
		input: FormEngineInput,
		moduleCaseType?: string,
		caseData?: CaseDataByType,
	) {
		this.store = createStore<EngineStoreState>(() => ({}));
		this.moduleCaseType = moduleCaseType;
		this.caseDataOwnType = moduleCaseType;
		this.formType = input.form.type;
		this.caseData = caseData ?? new Map();
		this.tree = buildFieldTree(input.formUuid, input.fields, input.fieldOrder);
		this.printDoc = printableDocOf(input);

		this.instance = new DataInstance();
		this.instance.initFromFields(this.tree);

		if (
			CASE_LOADING_FORM_TYPES.has(input.form.type) &&
			this.caseData.size > 0
		) {
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
		const affected = this.dag.getAffected(path, this.repeatCounts);
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
		const instancePrefix = `${repeatPath}[${newIndex}]`;

		const updates: EngineStoreState = {};
		const templatePrefix = `${repeatPath}[0]/`;
		const newLeafPaths: string[] = [];
		for (const [key] of this.instance.entries()) {
			if (key.startsWith(`${instancePrefix}/`)) {
				newLeafPaths.push(key);
				const suffix = key.slice(`${instancePrefix}/`.length);
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

		/* Containers inside the new instance need their own FieldState —
		 * group visibility and nested-repeat cardinality are per-instance.
		 * The DataInstance walk above only covers leaves. */
		const repeatNode = this.findTreeNode(repeatPath);
		if (repeatNode?.children) {
			this.seedContainerStates(updates, repeatNode.children, instancePrefix);
		}

		// Bump `repeatCount` on the repeat's own state — this is what
		// repeat-container subscribers observe to re-render with the new
		// cardinality; the per-instance child states above are keyed by
		// their concrete `[N]/...` paths.
		const repeatState = this.store.getState()[repeatPath];
		if (repeatState) {
			updates[repeatPath] = { ...repeatState, repeatCount: newIndex + 1 };
		}

		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}

		/* One-time defaults for the new instance's leaves, then evaluate
		 * EVERY instance's expressions plus every outside dependent — the
		 * same defaults-then-evaluate order form load runs for `[0]`.
		 * Existing instances re-evaluate too: `position()` / `last()`
		 * expressions shift when cardinality grows, same as on remove. */
		this.applyInstanceDefaults(newLeafPaths);
		this.evaluateRepeatCascade(`${repeatPath}[`, newLeafPaths);

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

		/* Re-evaluate the surviving instances — `position()` / `last()` and
		 * renumbered sibling values shift — plus every outside dependent. */
		const survivingLeaves: string[] = [];
		for (const [key] of this.instance.entries()) {
			if (key.startsWith(`${repeatPath}[`)) survivingLeaves.push(key);
		}
		this.evaluateRepeatCascade(`${repeatPath}[`, survivingLeaves);
	}

	/**
	 * Evaluate every DAG node inside a repeat's subtree (all paths under
	 * `subtreePrefix`) plus everything outside it that depends on the given
	 * leaf paths — one multi-seed BFS, since per-leaf walks re-derive the
	 * same generic dependents. Runs after instance cardinality changes,
	 * where the instances' own expressions AND cross-repeat dependents
	 * both need a fresh pass.
	 */
	private evaluateRepeatCascade(
		subtreePrefix: string,
		leafPaths: string[],
	): void {
		const toEvaluate = new Set<string>();
		for (const path of this.dag.getAllPaths(this.repeatCounts)) {
			if (path.startsWith(subtreePrefix)) toEvaluate.add(path);
		}
		for (const dep of this.dag.getAffectedMany(leafPaths, this.repeatCounts)) {
			toEvaluate.add(dep);
		}
		if (toEvaluate.size > 0) {
			this.evaluatePathsInto([...toEvaluate]);
		}
	}

	/** Evaluate a field's `default_value` for one concrete path. Returns
	 *  the value to apply, or undefined when the slot is absent or the
	 *  result is empty/`"false"` — the one gate every default-applying
	 *  flow (form load, new repeat instance, incremental add, default
	 *  edit) shares. */
	private computeDefault(field: Field, path: string): string | undefined {
		const defaultValue = expressionSource(
			field,
			"default_value",
			this.printDoc,
		);
		if (!defaultValue) return undefined;
		const result = evaluate(defaultValue, this.createEvalContext(path));
		const value = xpathToString(result);
		return value && value !== "false" ? value : undefined;
	}

	/**
	 * Apply `default_value` one-time to freshly created repeat-instance
	 * leaves — the live-store counterpart of `applyDefaultsInto`. The eval
	 * context binds to each leaf's own instance, so a default reading a
	 * repeat sibling reads the new instance, not `[0]`.
	 */
	private applyInstanceDefaults(paths: string[]): void {
		const updates: EngineStoreState = {};
		for (const path of paths) {
			const field = this.findField(path);
			if (!field) continue;
			const value = this.computeDefault(field, path);
			if (value !== undefined) {
				this.instance.set(path, value);
				const state = this.store.getState()[path];
				if (state) updates[path] = { ...state, value };
			}
		}
		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}
	}

	/**
	 * Create container FieldStates for a freshly added repeat instance —
	 * groups carry per-instance visibility, nested repeats per-instance
	 * cardinality. Nested-repeat counts read from the DataInstance, whose
	 * instance walk seeded the new subtree first; recursion covers every
	 * live nested instance, not just `[0]`.
	 */
	private seedContainerStates(
		updates: EngineStoreState,
		nodes: ReadonlyArray<FieldTreeNode>,
		prefix: string,
	): void {
		for (const node of nodes) {
			const f = node.field;
			if (f.kind !== "group" && f.kind !== "repeat") continue;
			const path = `${prefix}/${f.id}`;
			const base = this.initialContainerState(path, f.kind);
			if (f.kind === "repeat") {
				updates[path] = {
					...base,
					repeatCount: this.instance.getRepeatCount(path),
				};
				if (node.children) {
					const count = this.instance.getRepeatCount(path);
					for (let i = 0; i < count; i++) {
						this.seedContainerStates(updates, node.children, `${path}[${i}]`);
					}
				}
			} else {
				updates[path] = base;
				if (node.children) {
					this.seedContainerStates(updates, node.children, path);
				}
			}
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
	 *  affected entries to the runtime store after a setValue cascade. */
	getAffectedPaths(path: string): string[] {
		return this.dag.getAffected(path, this.repeatCounts);
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
		return this.dag.getAllPaths(this.repeatCounts);
	}

	/** Expand a template/generic path to every live concrete instance
	 *  path. Every incremental operation below routes through this so a
	 *  doc mutation touching a repeat child lands on ALL instances, not
	 *  just the `[0]` template the uuid maps know about. */
	materializePaths(path: string): string[] {
		return this.dag.materializePath(path, this.repeatCounts);
	}

	// ── Incremental operations ───────────────────────────────────────

	/**
	 * Add a single field's runtime state to the engine without rebuilding
	 * existing state — at every live instance when the field sits inside
	 * a repeat.
	 *
	 * Initializes the DataInstance paths, creates the field's FieldStates,
	 * and evaluates its expressions. Existing fields are untouched — their
	 * state objects keep the same reference in the store.
	 *
	 * The DAG must be rebuilt externally (via rebuildDag) BEFORE calling this
	 * so the new field's dependency edges — and, for a field inside a
	 * repeat, the repeat expansion points — are present.
	 */
	addFieldState(path: string, field: Field): void {
		// Containers are structural — no value, no `default_value`, no
		// `required` expression. They only carry `relevant`, which the
		// `evaluatePathsInto` call below resolves into the visibility
		// flag. Skipping the DataInstance value write keeps the value Map
		// pristine: only leaf fields own value paths. A repeat container
		// does register its instance count so its children materialize.
		if (field.kind === "group" || field.kind === "repeat") {
			const updates: EngineStoreState = {};
			for (const concrete of this.materializePaths(path)) {
				if (field.kind === "repeat") {
					this.instance.ensureRepeat(concrete);
					updates[concrete] = {
						...this.initialContainerState(concrete, "repeat"),
						repeatCount: this.instance.getRepeatCount(concrete),
					};
				} else {
					updates[concrete] = this.initialContainerState(concrete, "group");
				}
			}
			this.store.setState(updates);
			this.evaluatePathsInto(Object.keys(updates));
			return;
		}

		const concretes = this.materializePaths(path);

		/* Seed DataInstance values + runtime states */
		const isRequired =
			expressionSource(field, "required", this.printDoc) === "true()";
		const states: EngineStoreState = {};
		for (const concrete of concretes) {
			if (!this.instance.has(concrete)) {
				this.instance.set(concrete, "");
			}
			states[concrete] = {
				path: concrete,
				value: this.instance.get(concrete) ?? "",
				visible: true,
				required: isRequired,
				valid: true,
				touched: false,
			};
		}
		this.store.setState(states);

		/* Apply default value per instance if present */
		const defaults: EngineStoreState = {};
		for (const concrete of concretes) {
			const value = this.computeDefault(field, concrete);
			if (value !== undefined) {
				this.instance.set(concrete, value);
				const state = this.store.getState()[concrete];
				if (state) defaults[concrete] = { ...state, value };
			}
		}
		if (Object.keys(defaults).length > 0) {
			this.store.setState(defaults);
		}

		/* Evaluate expressions (calculate, relevant, required, validation) */
		this.evaluatePathsInto(concretes);
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
	 * Remove fields' runtime state from the engine without rebuilding
	 * existing state — at every live instance when a field sits inside a
	 * repeat.
	 *
	 * Clears each field's runtime states from the store AND drops its
	 * `DataInstance` values, so the path-keyed engine store and the value map
	 * stay consistent — a field re-added at the same path later seeds empty
	 * (`addFieldState` only writes `""` when `!instance.has(path)`) rather than
	 * resurrecting the removed answer. All paths materialize BEFORE anything
	 * is deleted: removing a repeat container drops its instance count, which
	 * would blind its children's materialization. The DAG should be rebuilt
	 * externally (via rebuildDag) AFTER removal so dependents can re-evaluate
	 * against the missing reference.
	 */
	removeFieldStates(paths: readonly string[]): void {
		const concretes = new Set<string>();
		for (const path of paths) {
			for (const concrete of this.materializePaths(path)) {
				concretes.add(concrete);
			}
		}
		const updates: EngineStoreState = {};
		for (const concrete of concretes) {
			this.instance.delete(concrete);
			updates[concrete] = DEFAULT_ENGINE_STATE;
		}
		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}
	}

	/**
	 * Drop a path's `DataInstance` values AND reset its runtime states to the
	 * frozen default — at every live instance. Used when a field is retyped
	 * (`onKindChanged`): the old value is stale under the new kind, so it's
	 * cleared before `addFieldState` re-seeds the field, which only writes
	 * `""` when `!instance.has(path)`.
	 */
	deleteValue(path: string): void {
		const updates: EngineStoreState = {};
		for (const concrete of this.materializePaths(path)) {
			this.instance.delete(concrete);
			if (this.store.getState()[concrete]) {
				updates[concrete] = DEFAULT_ENGINE_STATE;
			}
		}
		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}
	}

	/**
	 * Move fields' DataInstance values and runtime states from old template
	 * paths to new ones — every live instance, in one batch. Used after ID
	 * renames and group⇄repeat conversions, where the XForm paths change.
	 *
	 * MUST run before `rebuildDag`: the old paths materialize against the
	 * pre-change topology and counts. All pairs materialize before anything
	 * moves — renaming a repeat container relocates its instance count, which
	 * would blind its descendants' materialization mid-batch. An instance the
	 * new shape has no home for (repeat→group keeps only instance 0) drops
	 * its value and unplugs its state.
	 */
	renamePaths(
		pairs: ReadonlyArray<{ oldPath: string; newPath: string }>,
	): void {
		const moves: Array<{ from: string; to: string | null }> = [];
		for (const { oldPath, newPath } of pairs) {
			for (const from of this.materializePaths(oldPath)) {
				moves.push({ from, to: remapInstancePath(from, oldPath, newPath) });
			}
		}

		const updates: EngineStoreState = {};
		const current = this.store.getState();
		for (const { from, to } of moves) {
			if (to === null) {
				this.instance.delete(from);
				if (current[from]) updates[from] = DEFAULT_ENGINE_STATE;
				continue;
			}
			this.instance.rename(from, to);
			const oldState = current[from];
			if (oldState) {
				updates[from] = DEFAULT_ENGINE_STATE;
				updates[to] = { ...oldState, path: to };
			}
		}
		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}
	}

	/**
	 * Re-evaluate a field's default_value expression and cascade — at every
	 * live instance. Used when a field's default_value changes in the
	 * blueprint. A touched field keeps the user's answer in BOTH the store
	 * and the DataInstance — writing the instance while skipping the store
	 * made the screen and the submission disagree.
	 */
	reevaluateDefault(path: string, field: Field): void {
		const concretes = this.materializePaths(path);
		const updates: EngineStoreState = {};
		for (const concrete of concretes) {
			const current = this.store.getState()[concrete];
			if (current?.touched) continue;
			const value = this.computeDefault(field, concrete);
			if (value !== undefined) {
				this.instance.set(concrete, value);
				if (current) updates[concrete] = { ...current, value };
			}
		}
		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}

		/* Cascade — the value changes may affect dependent fields */
		const affected = this.dag.getAffectedMany(concretes, this.repeatCounts);
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
		caseData: CaseDataByType,
		moduleCaseType?: string,
	): void {
		this.tree = buildFieldTree(input.formUuid, input.fields, input.fieldOrder);
		this.formType = input.form.type;
		this.caseData = caseData;
		this.moduleCaseType = moduleCaseType;

		/* Re-preload case data for followup forms. Track which paths changed. */
		const changedPaths: string[] = [];
		if (CASE_LOADING_FORM_TYPES.has(input.form.type) && caseData.size > 0) {
			this.preloadCaseDataTracked(this.tree, changedPaths);
		}

		/* Re-evaluate changed paths + their cascade */
		if (changedPaths.length > 0) {
			const allAffected = new Set(changedPaths);
			for (const path of changedPaths) {
				for (const dep of this.dag.getAffected(path, this.repeatCounts)) {
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
		const own = this.ownCaseData();
		if (own === undefined) return;
		for (const node of tree) {
			const f = node.field;
			const path = `${prefix}/${f.id}`;
			const withCP = f as Field & { case_property_on?: string };
			if (
				withCP.case_property_on &&
				withCP.case_property_on === this.moduleCaseType &&
				own.has(f.id)
			) {
				const newValue = own.get(f.id) ?? "";
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
		caseData?: CaseDataByType,
	): void {
		const snapshot = this.getValueSnapshot();

		this.moduleCaseType = moduleCaseType;
		this.caseDataOwnType = moduleCaseType;
		this.formType = input.form.type;
		this.caseData = caseData ?? new Map();
		this.tree = buildFieldTree(input.formUuid, input.fields, input.fieldOrder);
		this.printDoc = printableDocOf(input);

		this.instance = new DataInstance();
		this.instance.initFromFields(this.tree);

		if (
			CASE_LOADING_FORM_TYPES.has(input.form.type) &&
			this.caseData.size > 0
		) {
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

		if (isCaseLoadingFormType(this.formType) && this.caseData.size > 0) {
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
		const allPaths = this.dag.getAllPaths(this.repeatCounts);
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

	/** The loaded case's own property map — the entry under the module's
	 *  case type. Preload reads ONLY this map: ancestor namespaces are
	 *  read-only reference data (a form never writes an ancestor's
	 *  properties), so they seed no field values. After a mid-preview
	 *  module retype (`refreshCaseContext` with a new `moduleCaseType`
	 *  but the old data), the supplied-under type no longer matches and
	 *  preload is withheld entirely — the entry under the NEW type would
	 *  be an ancestor's row, not the bound case, and seeding field
	 *  values from it would submit the parent's data onto the bound
	 *  row. The React layer re-resolves and rebuilds the engine with a
	 *  fresh matched pair moments later. */
	private ownCaseData(): Map<string, string> | undefined {
		if (this.moduleCaseType === undefined) return undefined;
		if (this.moduleCaseType !== this.caseDataOwnType) return undefined;
		return this.caseData.get(this.moduleCaseType);
	}

	private preloadCaseData(tree: FieldTreeNode[], prefix = "/data"): void {
		const own = this.ownCaseData();
		if (own === undefined) return;
		for (const node of tree) {
			const f = node.field;
			const path = `${prefix}/${f.id}`;
			const withCP = f as Field & { case_property_on?: string };
			if (
				withCP.case_property_on &&
				withCP.case_property_on === this.moduleCaseType &&
				own.has(f.id)
			) {
				this.instance.set(path, own.get(f.id) ?? "");
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
			const value = this.computeDefault(f, path);
			if (value !== undefined) {
				this.instance.set(path, value);
				const state = states[path];
				if (state) {
					states[path] = { ...state, value };
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
		// The DEEPEST instance segment carries the evaluating node's own
		// position — for `/data/a[1]/b[0]/c`, position() is b's index.
		const repeatMatch = path.match(/\[(\d+)\][^[]*$/);
		if (repeatMatch) {
			position = Number.parseInt(repeatMatch[1], 10) + 1;
			const repeatBase = path.slice(0, path.lastIndexOf("["));
			size = this.instance.getRepeatCount(repeatBase);
		}

		/* References print index-free (`#form/orders/name`), but repeat
		 * children live at indexed paths — bind each read onto the
		 * evaluating node's own instance, CommCare's relative-reference
		 * semantic. Reads outside the context's repeats pass through. */
		const read = (p: string): string | undefined =>
			this.instance.get(rebaseOntoContext(p, path));

		return {
			getValue: read,
			resolveHashtag: (ref: string) => {
				if (ref.startsWith("#form/")) {
					const fieldId = ref.slice(6);
					return read(`/data/${fieldId}`) ?? "";
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
				// Case references. The authoring vocabulary is per-case-type —
				// `#<case_type>/<prop>` (printXPath's `case-ref` spelling) —
				// resolved by looking the namespace up in the per-type case
				// data: the form's OWN module case type addresses the loaded
				// case (wire depth 0), an ANCESTOR type addresses the matching
				// row of the parent chain (the preview counterpart of the
				// wire's `…/index/parent × depth …` casedb walk — depth is
				// implicit in which row claimed the type name). The
				// transitional `#case/<prop>` spelling aliases the own type.
				// On a registration form no case is loaded, the map is empty,
				// and every case ref reads blank, matching the wire's
				// narrowing (the new case isn't in casedb at form init).
				const match = /^#([^/]+)\/(.+)$/.exec(ref);
				if (match) {
					const namespace =
						match[1] === "case" ? this.moduleCaseType : match[1];
					const data =
						namespace !== undefined ? this.caseData.get(namespace) : undefined;
					return data?.get(match[2] ?? "") ?? "";
				}
				return "";
			},
			contextPath: path,
			position,
			size,
		};
	}

	private findField(path: string): Field | undefined {
		return this.findTreeNode(path)?.field;
	}

	/** Locate the tree node a concrete OR generic path addresses —
	 *  instance indices are stripped on both sides before comparing. */
	private findTreeNode(
		path: string,
		tree?: FieldTreeNode[],
		prefix = "/data",
	): FieldTreeNode | undefined {
		const target = stripIndices(path);
		for (const node of tree ?? this.tree) {
			const f = node.field;
			const fPath = `${prefix}/${f.id}`;
			if (stripIndices(fPath) === target) return node;
			if (node.children) {
				const childPrefix = f.kind === "repeat" ? `${fPath}[0]` : fPath;
				const found = this.findTreeNode(path, node.children, childPrefix);
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

/** String-typed membership check for the engine's `formType` slot (the
 *  constructor keeps it as `string`), widening the domain set once. */
function isCaseLoadingFormType(formType: string): boolean {
	return (CASE_LOADING_FORM_TYPES as ReadonlySet<string>).has(formType);
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
