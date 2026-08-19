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
import {
	assertAndProjectCaseWriteInventory,
	type ProjectedCaseWriteInventory,
} from "@/lib/commcare/caseWriteAdmission";
import type {
	BlueprintDoc,
	CaseProperty,
	CasePropertyDataType,
	CaseType,
	CaseWriteBucket,
	Field,
	Form,
	FormType,
	LookupOptionsSource,
	Uuid,
} from "@/lib/domain";
import {
	asUuid,
	CASE_LOADING_FORM_TYPES,
	type CaseWriteField,
	casePropertyDataTypes,
	deriveCaseWriteInventory,
	expressionSource,
	fieldProseTemplate,
	isCaptureFieldKind,
	isReadableTemporalValue,
	orderedCaseOperations,
	ownRecordValue,
	prepareCaseScalarTextValue,
	storageDatetimeValue,
	storageTimeValue,
	type XPathPrintableDoc,
} from "@/lib/domain";
import {
	compilerBugMessage,
	unhandledKindMessage,
} from "@/lib/domain/predicate/errors";
import { toBoolean, xpathToString } from "../xpath/coerce";
import { evaluate } from "../xpath/evaluator";
import type { EvalContext } from "../xpath/types";
import type {
	SubmissionAnswerEntry,
	SubmissionAttachmentReference,
	SubmissionMutation,
	SubmissionOperationAnswers,
} from "./caseDataBindingTypes";
import { DataInstance } from "./dataInstance";
import { buildFieldTree, type FieldTreeNode } from "./fieldTree";
import {
	previewSessionValues,
	previewUserPropertySlugMap,
	type ResolvedPreviewIdentity,
} from "./identity";
import {
	rebaseOntoContext,
	remapInstancePath,
	stripIndices,
} from "./instancePaths";
import { resolveLabel } from "./labelRefs";
import {
	evaluateLookupChoices,
	lookupOptionsSourceCovered,
	type PreviewLookupData,
} from "./lookupEvaluation";
import { sessionInstancePathValue } from "./searchExpressionEvaluation";
import { TriggerDag } from "./triggerDag";
import {
	type FieldState,
	fieldStatesEqual,
	type LookupChoice,
	lookupChoicesEqual,
	stringRecordsEqual,
} from "./types";

export type AttachmentPathDisposition = "active" | "dormant" | "removed";
export interface InvalidFieldTarget {
	readonly fieldUuid: Uuid;
	readonly instancePath: string;
	readonly ancestorUuids: readonly Uuid[];
}

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
 * map is a flattened property bag: JSONB keys plus the canonical
 * scalar names (`case_id`, `date_opened`, …).
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
	/** Complete case-type catalog used to admit own/direct-child writes. */
	caseTypes: readonly CaseType[];
	/** Custom worker-information identities used to print `#user/*` refs. */
	userProperties?: XPathPrintableDoc["userProperties"];
}

/** The print surface for the engine's input slice: its one form plus
 *  the supplied field maps. Every expression the engine evaluates is
 *  form-local, so this is the whole resolution world. */
function printableDocOf(input: FormEngineInput): XPathPrintableDoc {
	return {
		forms: { [input.formUuid]: input.form },
		fields: input.fields,
		fieldOrder: input.fieldOrder,
		userProperties: input.userProperties,
	};
}

function caseWriteDocOf(
	input: FormEngineInput,
): Pick<BlueprintDoc, "fields" | "fieldOrder" | "caseTypes"> {
	return {
		fields: input.fields,
		fieldOrder: input.fieldOrder as BlueprintDoc["fieldOrder"],
		caseTypes: [...input.caseTypes],
	};
}

/**
 * Drop a select's answer tokens that are no longer among its live
 * choices — the device unselects a value its rebuilt choice list no
 * longer offers. Single-select clears wholesale; multi-select keeps
 * the surviving space-joined tokens in their original order.
 */
function retainSelection(
	kind: "single_select" | "multi_select",
	value: string,
	choices: readonly LookupChoice[],
): string {
	if (value === "") return value;
	const offered = new Set(choices.map((c) => c.value));
	if (kind === "single_select") {
		return offered.has(value) ? value : "";
	}
	const kept = value.split(" ").filter((token) => token && offered.has(token));
	const joined = kept.join(" ");
	return joined === value ? value : joined;
}

/**
 * Strip every attachment writer from an admitted inventory.
 *
 * Preview's own rule, applied after admission rather than inside it: the
 * document is genuinely valid and the device genuinely writes these
 * properties. What preview lacks is the CommCare HQ submission the address
 * would point at, so it declines to invent one. Keeping this out of
 * `assertAndProjectCaseWriteInventory` matters — that projection is what
 * the wire emitters consume, and they must keep seeing every writer.
 */
function dropCaptureWriters(
	projected: ProjectedCaseWriteInventory,
): ProjectedCaseWriteInventory {
	const isCapture = (writer: { readonly writer: CaseWriteField }) =>
		isCaptureFieldKind(writer.writer.fieldKind);
	if (!projected.buckets.some((bucket) => bucket.writers.some(isCapture))) {
		return projected;
	}
	const writerByUuid = new Map(projected.writerByUuid);
	for (const bucket of projected.buckets) {
		for (const writer of bucket.writers) {
			if (isCapture(writer)) writerByUuid.delete(writer.writer.fieldUuid);
		}
	}
	return {
		inventory: projected.inventory,
		buckets: projected.buckets.map((bucket) => ({
			...bucket,
			writers: bucket.writers.filter((writer) => !isCapture(writer)),
		})),
		writerByUuid,
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
	/** Exact topology surface consumed by the shared case-write inventory. */
	private caseWriteDoc: Pick<
		BlueprintDoc,
		"fields" | "fieldOrder" | "caseTypes"
	>;
	/** Rose-tree of the active form's fields. Rebuilt on schema refresh so
	 *  every walker inside the engine agrees on the same snapshot. */
	private tree: FieldTreeNode[];
	private caseData: CaseDataByType;
	/** The resolved identity `#user/*` reads — fixed for the engine's
	 *  lifetime; an identity change rebuilds the engine so every computed
	 *  value agrees on one evaluation world. `null` (signed-out client
	 *  paint) reads every user slice as absent. */
	private previewIdentity: ResolvedPreviewIdentity | null;
	private moduleCaseType: string | undefined;
	/** The module case type `caseData` was SUPPLIED under — the type
	 *  whose entry is the bound row. Stamped only where a fresh
	 *  (caseData, moduleCaseType) pair arrives together (constructor,
	 *  `updateSchema`), NOT by `refreshCaseContext`, which re-pairs the
	 *  existing data with new metadata — so after a mid-preview module
	 *  retype the mismatch is detectable and preload can't seed fields
	 *  from an ancestor's row as if it were the bound case. */
	private caseDataOwnType: string | undefined;
	private formType: FormType;
	/** One Project lookup fixture snapshot captured for the engine's
	 *  LIFETIME — lookup-backed choices stay stable within a form
	 *  session (the wire's install/upgrade fixture semantic); the next
	 *  activation captures the builder session's refreshed cache.
	 *  `null` when the caller supplied none — evaluating a lookup
	 *  carrier then throws the validation-bypass invariant. */
	private lookupData: PreviewLookupData | null;
	/** uuid → generic path cache for lookup-filter `formFields` bindings,
	 *  keyed by tree identity so every tree rebuild refreshes it lazily. */
	private fieldPathsCache: ReadonlyMap<Uuid, string> = new Map();
	private fieldPathsCacheTree: FieldTreeNode[] | undefined;
	/** Live repeat-instance counts for the DAG's generic→concrete
	 *  materialization. Arrow property so it can pass as a bare callback. */
	private repeatCounts = (repeatPath: string): number =>
		this.instance.getRepeatCount(repeatPath);
	/** Render-only identities that survive positional compaction. */
	private repeatInstanceKeys = new Map<string, string[]>();

	constructor(
		input: FormEngineInput,
		moduleCaseType?: string,
		caseData?: CaseDataByType,
		previewIdentity?: ResolvedPreviewIdentity | null,
		lookupData?: PreviewLookupData | null,
	) {
		this.store = createStore<EngineStoreState>(() => ({}));
		this.lookupData = lookupData ?? null;
		this.previewIdentity = previewIdentity ?? null;
		this.moduleCaseType = moduleCaseType;
		this.caseDataOwnType = moduleCaseType;
		this.formType = input.form.type;
		this.caseData = caseData ?? new Map();
		this.tree = buildFieldTree(input.formUuid, input.fields, input.fieldOrder);
		this.printDoc = printableDocOf(input);
		this.caseWriteDoc = caseWriteDocOf(input);

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
		this.ensureRepeatInstanceKeys(repeatPath, newIndex + 1);
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
		 * Existing instances re-evaluate too so this path stays symmetric with
		 * removal, where `position()` and renumbered sibling reads can shift. */
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
		const remappedRepeatKeys = new Map<string, string[]>();
		for (const [path, keys] of this.repeatInstanceKeys) {
			if (path === repeatPath) {
				const remaining = [...keys];
				remaining.splice(index, 1);
				remappedRepeatKeys.set(path, remaining);
				continue;
			}
			const instancePrefix = `${repeatPath}[`;
			if (!path.startsWith(instancePrefix)) {
				remappedRepeatKeys.set(path, keys);
				continue;
			}
			const close = path.indexOf("]", instancePrefix.length);
			const enclosingIndex = Number(path.slice(instancePrefix.length, close));
			if (
				close === -1 ||
				!Number.isInteger(enclosingIndex) ||
				enclosingIndex < index
			) {
				remappedRepeatKeys.set(path, keys);
			} else if (enclosingIndex > index) {
				remappedRepeatKeys.set(
					`${repeatPath}[${enclosingIndex - 1}]${path.slice(close + 1)}`,
					keys,
				);
			}
			// Equal means the nested identity belonged to the removed instance.
		}
		this.repeatInstanceKeys = remappedRepeatKeys;
		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}

		/* Re-evaluate the surviving instances — `position()` and
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

	getRepeatInstanceKey(repeatPath: string, index: number): string {
		const keys = this.ensureRepeatInstanceKeys(
			repeatPath,
			this.instance.getRepeatCount(repeatPath),
		);
		return keys[index] ?? `${repeatPath}:${index}`;
	}

	getRepeatInstanceKeySnapshot(): ReadonlyMap<string, readonly string[]> {
		return new Map(
			[...this.repeatInstanceKeys].map(([path, keys]) => [path, [...keys]]),
		);
	}

	getRepeatCountSnapshot(): ReadonlyMap<string, number> {
		const counts = new Map<string, number>();
		for (const [path, state] of Object.entries(this.store.getState())) {
			if (state.repeatCount !== undefined) {
				counts.set(path, state.repeatCount);
			}
		}
		return counts;
	}

	restoreRepeatCountSnapshot(snapshot: ReadonlyMap<string, number>): void {
		const paths = [...snapshot.keys()].sort((a, b) => {
			const depth = (path: string) => path.split("/").length;
			return depth(a) - depth(b) || a.localeCompare(b);
		});
		for (const path of paths) {
			const target = snapshot.get(path) ?? 1;
			let current = this.getRepeatCount(path);
			while (current < target) {
				this.addRepeat(path);
				current++;
			}
			while (current > Math.max(target, 1)) {
				this.removeRepeat(path, current - 1);
				current--;
			}
		}
	}

	restoreRepeatInstanceKeySnapshot(
		snapshot: ReadonlyMap<string, readonly string[]>,
	): void {
		this.repeatInstanceKeys = new Map(
			[...snapshot].map(([path, keys]) => [path, [...keys]]),
		);
	}

	private ensureRepeatInstanceKeys(
		repeatPath: string,
		count: number,
	): string[] {
		const keys = this.repeatInstanceKeys.get(repeatPath) ?? [];
		while (keys.length < count) keys.push(crypto.randomUUID());
		if (keys.length > count) keys.length = count;
		this.repeatInstanceKeys.set(repeatPath, keys);
		return keys;
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
		const effectivelyVisible = this.effectivelyVisiblePaths(currentState);

		for (const [path, state] of Object.entries(currentState)) {
			if (state === DEFAULT_ENGINE_STATE) continue;
			if (!effectivelyVisible.has(path)) continue;

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
	 * First effectively visible invalid question in runtime document order.
	 *
	 * Structural ancestors are returned by UUID because preview collapse state
	 * is structural, while the target itself keeps its concrete repeat path.
	 * Call after `validateAll()` so required checks have populated validity.
	 */
	firstInvalidFieldTarget(): InvalidFieldTarget | undefined {
		const states = this.store.getState();
		const walk = (
			nodes: ReadonlyArray<FieldTreeNode>,
			prefix: string,
			ancestorsVisible: boolean,
			ancestorUuids: readonly Uuid[],
		): InvalidFieldTarget | undefined => {
			for (const node of nodes) {
				const instancePath = `${prefix}/${node.field.id}`;
				const effective =
					ancestorsVisible && states[instancePath]?.visible !== false;
				if (!effective) continue;
				const structural =
					node.field.kind === "group" || node.field.kind === "repeat";
				if (
					!structural &&
					node.field.kind !== "label" &&
					node.field.kind !== "hidden" &&
					states[instancePath]?.valid === false
				) {
					return {
						fieldUuid: node.field.uuid,
						instancePath,
						ancestorUuids,
					};
				}
				if (node.field.kind === "repeat") {
					const nextAncestors = [...ancestorUuids, node.field.uuid];
					const count = this.instance.getRepeatCount(instancePath);
					for (let index = 0; index < count; index++) {
						const target = walk(
							node.children ?? [],
							`${instancePath}[${index}]`,
							effective,
							nextAncestors,
						);
						if (target !== undefined) return target;
					}
				} else if (node.children !== undefined) {
					const target = walk(node.children, instancePath, effective, [
						...ancestorUuids,
						node.field.uuid,
					]);
					if (target !== undefined) return target;
				}
			}
			return undefined;
		};
		return walk(this.tree, "/data", true, []);
	}

	/**
	 * Resolve one concrete runtime question to the structural containers that
	 * can hide it. Attachment recovery uses this after its queue reports the
	 * exact stable slot/path that blocked Submit.
	 */
	fieldTarget(
		targetPath: string,
		fieldUuid?: string,
	): InvalidFieldTarget | undefined {
		const walk = (
			nodes: ReadonlyArray<FieldTreeNode>,
			prefix: string,
			ancestorUuids: readonly Uuid[],
		): InvalidFieldTarget | undefined => {
			for (const node of nodes) {
				const instancePath = `${prefix}/${node.field.id}`;
				const structural =
					node.field.kind === "group" || node.field.kind === "repeat";
				if (
					!structural &&
					instancePath === targetPath &&
					(fieldUuid === undefined || node.field.uuid === fieldUuid)
				) {
					return {
						fieldUuid: node.field.uuid,
						instancePath,
						ancestorUuids,
					};
				}
				if (node.field.kind === "repeat") {
					const nextAncestors = [...ancestorUuids, node.field.uuid];
					const count = this.instance.getRepeatCount(instancePath);
					for (let index = 0; index < count; index++) {
						const target = walk(
							node.children ?? [],
							`${instancePath}[${index}]`,
							nextAncestors,
						);
						if (target !== undefined) return target;
					}
				} else if (node.children !== undefined) {
					const target = walk(node.children, instancePath, [
						...ancestorUuids,
						node.field.uuid,
					]);
					if (target !== undefined) return target;
				}
			}
			return undefined;
		};
		return walk(this.tree, "/data", []);
	}

	/**
	 * Materialize effective relevance through the structural tree.
	 *
	 * A child's own `visible` flag is only its authored expression. The wire
	 * suppresses the entire subtree of an irrelevant group/repeat, so every
	 * submission-facing consumer must also inherit all ancestor visibility.
	 */
	private effectivelyVisiblePaths(
		states: Readonly<EngineStoreState>,
	): ReadonlySet<string> {
		const visible = new Set<string>();
		const walk = (
			nodes: ReadonlyArray<FieldTreeNode>,
			prefix: string,
			ancestorsVisible: boolean,
		): void => {
			for (const node of nodes) {
				const fieldPath = `${prefix}/${node.field.id}`;
				const effective =
					ancestorsVisible && states[fieldPath]?.visible !== false;
				if (effective) visible.add(fieldPath);
				if (node.field.kind === "repeat") {
					const count = this.instance.getRepeatCount(fieldPath);
					for (let index = 0; index < count; index++) {
						walk(node.children ?? [], `${fieldPath}[${index}]`, effective);
					}
				} else if (node.children) {
					walk(node.children, fieldPath, effective);
				}
			}
		};
		walk(this.tree, "/data", true);
		return visible;
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
	 * For each leaf field in the shared case-write inventory, an own-type
	 * destination lands in the primary's `properties`; an exact direct-child
	 * destination buckets into a child case keyed by `(destination case type,
	 * repeat-instance-key)`. Repeat regions fan out one bucket per instance
	 * per destination case type.
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
	/** The one form this engine's input slice is rooted at. */
	private activeFormUuid(): Uuid {
		const formUuid = Object.keys(this.printDoc.forms)[0];
		if (formUuid === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "preview.formEngine.activeFormUuid",
					invariant: "the engine's print surface holds no form",
				}),
			);
		}
		return asUuid(formUuid);
	}

	/**
	 * Derive and admit case writes through the same path-aware inventory used
	 * by validation and wire emission. Preview never re-interprets field ids as
	 * case properties and never invents child membership independently.
	 *
	 * An attachment's destination is dropped, and this is the one place
	 * Preview deliberately writes LESS than the device. The address a URL
	 * mode property carries is
	 * `<origin>/a/<domain>/api/form_attachment/v1/<instance id>/<name>`, and
	 * a preview submission has no CommCare HQ instance behind any of it: the
	 * bytes live in Nova's own submission-scoped lane, `meta/instanceID`
	 * names no form on any project space, and the endpoint would resolve to
	 * nothing whatever origin preceded it. Writing a plausible-looking
	 * address would put a broken link in real case data and make an author
	 * believe the column works. So the property stays unwritten and a column
	 * over it reads empty — which is the truth about what preview knows.
	 */
	private projectedCaseWrites(): ProjectedCaseWriteInventory {
		const inventory = deriveCaseWriteInventory(
			this.caseWriteDoc,
			this.activeFormUuid(),
			{ caseType: this.moduleCaseType },
			this.formType,
		);
		return dropCaptureWriters(assertAndProjectCaseWriteInventory(inventory));
	}

	private primaryCaseWritesByField(
		projected: ProjectedCaseWriteInventory = this.projectedCaseWrites(),
	): ReadonlyMap<Uuid, CaseWriteField> {
		const primary = projected.buckets.find(
			({ bucket }) => bucket.kind === "primary",
		);
		return new Map(
			(primary?.writers ?? []).map(({ writer }) => [writer.fieldUuid, writer]),
		);
	}

	/**
	 * Collect the per-scope operation answer bindings for this form's
	 * case operations — `undefined` when the form carries none. Each
	 * repeat iteration's list is COMPLETE (root answers, every enclosing
	 * repeat's answers for that concrete instance, and the iteration's
	 * own answers), flattened parent-major in live instance order —
	 * exactly the completeness the storage executor binds each
	 * expression with. Values are raw instance strings; multi-select
	 * answers carry the real token array (the one namespace the SQL
	 * term compiler admits arrays in). Nested repeats form their OWN
	 * scopes, so an iteration's list excludes deeper repeats' answers —
	 * mirroring the validator's operation-correlation contract.
	 */
	computeOperationAnswers(): SubmissionOperationAnswers | undefined {
		const form = this.printDoc.forms[this.activeFormUuid() as string] as
			| Form
			| undefined;
		if (form === undefined || orderedCaseOperations(form).length === 0) {
			return undefined;
		}

		const repeatScopes = new Map<string, SubmissionAnswerEntry[][]>();
		const scopeFor = (repeatUuid: string): SubmissionAnswerEntry[][] => {
			const existing = repeatScopes.get(repeatUuid);
			if (existing !== undefined) return existing;
			const created: SubmissionAnswerEntry[][] = [];
			repeatScopes.set(repeatUuid, created);
			return created;
		};

		const entryFor = (
			field: Field,
			concretePath: string,
		): SubmissionAnswerEntry => {
			const raw = this.instance.get(concretePath) ?? "";
			return {
				fieldUuid: field.uuid as string,
				value:
					field.kind === "multi_select"
						? raw.split(/\s+/).filter(Boolean)
						: raw,
			};
		};

		/* Two-phase per level: gather the level's own leaf answers first
		 * (groups inline), THEN expand deferred repeats with the complete
		 * inherited + level context — a repeat later in document order
		 * still inherits its whole enclosing level. */
		const collectLevel = (
			nodes: ReadonlyArray<FieldTreeNode>,
			pathPrefix: string,
			inherited: ReadonlyArray<SubmissionAnswerEntry>,
		): SubmissionAnswerEntry[] => {
			const level: SubmissionAnswerEntry[] = [];
			const deferredRepeats: Array<{
				node: FieldTreeNode;
				path: string;
			}> = [];
			const gather = (
				levelNodes: ReadonlyArray<FieldTreeNode>,
				prefix: string,
			): void => {
				for (const node of levelNodes) {
					const f = node.field;
					const fieldPath = `${prefix}/${f.id}`;
					if (f.kind === "group") {
						if (node.children) gather(node.children, fieldPath);
						continue;
					}
					if (f.kind === "repeat") {
						deferredRepeats.push({ node, path: fieldPath });
						continue;
					}
					if (f.kind === "label") continue;
					level.push(entryFor(f, fieldPath));
				}
			};
			gather(nodes, pathPrefix);

			for (const { node, path } of deferredRepeats) {
				const iterations = scopeFor(node.field.uuid as string);
				if (!node.children) continue;
				const instanceCount = this.instance.getRepeatCount(path);
				for (let i = 0; i < instanceCount; i++) {
					const enclosing = [...inherited, ...level];
					const own = collectLevel(node.children, `${path}[${i}]`, enclosing);
					iterations.push([...enclosing, ...own]);
				}
			}
			return level;
		};

		const root = collectLevel(this.tree, "/data", []);
		return {
			root,
			repeats: [...repeatScopes.entries()].map(([repeat, iterations]) => ({
				repeat,
				iterations,
			})),
		};
	}

	/**
	 * The attachment names this submission actually carries.
	 *
	 * Walks every capture question, including one instance per live repeat
	 * iteration, and collects the non-empty answers of the questions that
	 * are still RELEVANT. That set is what the server prepares; everything
	 * else staged under this form entry is discarded.
	 *
	 * ## Why this consults visibility when the case-property collector does not
	 *
	 * The case-property walk deliberately ignores `state.visible`, for a
	 * storage reason: an omitted key is the only JSONB shape that passes
	 * AJV strict-mode validation, so a hidden field's value still lands.
	 * That reason has nothing to say about attachments, and the wire
	 * semantics here point the other way — an irrelevant question's node is
	 * omitted from the submitted instance entirely
	 * (`XFormSerializingVisitor::serializeNode` returns null for a
	 * non-relevant node), so its attachment is genuinely not part of the
	 * submission.
	 *
	 * Nova then diverges from the platform in one direction, on purpose.
	 * The real runtime uploads the FILE anyway, because
	 * `FormSubmissionHelper::getMultiPartFormBody` enumerates the session's
	 * media directory rather than the answers — so an irrelevant question's
	 * bytes, and a deleted repeat instance's, still ride the submission,
	 * still consume one of the 50 attachment slots, and land in HQ
	 * referenced by nothing. Replicating that would import a known defect
	 * into a lane with no reason to inherit it.
	 */
	collectAttachmentReferences(): SubmissionAttachmentReference[] {
		const references: SubmissionAttachmentReference[] = [];
		const states = this.store.getState();
		const walk = (
			nodes: FieldTreeNode[],
			prefix: string,
			ancestorsVisible: boolean,
		): void => {
			for (const node of nodes) {
				const f = node.field;
				const fieldPath = `${prefix}/${f.id}`;
				const effective =
					ancestorsVisible && states[fieldPath]?.visible !== false;
				if (f.kind === "repeat") {
					const count = this.instance.getRepeatCount(fieldPath);
					for (let i = 0; i < count; i++) {
						walk(node.children ?? [], `${fieldPath}[${i}]`, effective);
					}
					continue;
				}
				if (node.children) {
					walk(node.children, fieldPath, effective);
					continue;
				}
				if (!isCaptureFieldKind(f.kind)) continue;
				if (!effective) continue;
				const raw = this.instance.get(fieldPath);
				if (typeof raw === "string" && raw !== "") {
					references.push({
						attachmentName: raw,
						fieldUuid: f.uuid,
						instancePath: fieldPath,
					});
				}
			}
		};
		walk(this.tree, "/data", true);
		return references;
	}

	/**
	 * Answers this form saves to the worker's own record.
	 *
	 * Independent of the primary case action, matching the wire: a survey form
	 * carries these as readily as a followup does, so this runs before the
	 * form-type switch and rides every submission arm.
	 *
	 * Every usercase slot is text (`usercaseCaseType` derives them all that
	 * way, because HQ stores user data as strings), so a submitted value goes
	 * across as it was answered rather than through `coerceValueForProperty` —
	 * there is no declared type to coerce toward.
	 *
	 * A blank or hidden answer writes nothing. The emitted bind carries
	 * `relevant="count(<path>) > 0"` for exactly that reason: a device skips
	 * the write rather than erasing what is on the record, and Preview has to
	 * agree or the two disagree the first time a question is conditional.
	 */
	private collectUsercaseWrites(): JsonObject | undefined {
		const projected = this.projectedCaseWrites();
		const properties: Record<string, string> = {};
		const states = this.store.getState();
		const walk = (
			nodes: FieldTreeNode[],
			prefix: string,
			ancestorsVisible: boolean,
		): void => {
			for (const node of nodes) {
				const f = node.field;
				const fieldPath = `${prefix}/${f.id}`;
				const effective =
					ancestorsVisible && states[fieldPath]?.visible !== false;
				if (f.kind === "repeat") {
					// Admission refuses a usercase writer inside a repeat, so
					// there is nothing to collect below one.
					continue;
				}
				if (node.children) {
					walk(node.children, fieldPath, effective);
					continue;
				}
				const write = projected.writerByUuid.get(f.uuid);
				if (write === undefined || write.bucket.kind !== "usercase") continue;
				if (!effective) continue;
				const raw = this.instance.get(fieldPath);
				if (typeof raw !== "string" || raw === "") continue;
				properties[write.writer.property] = raw;
			}
		};
		walk(this.tree, "/data", true);
		return Object.keys(properties).length > 0 ? properties : undefined;
	}

	/**
	 * Classify a capture slot at the instant Submit reaches its form-wide
	 * attachment barrier.
	 *
	 * A relevance-hidden slot is dormant: its draft and any failed-encoding
	 * diagnostic remain available if the question reappears, but neither is
	 * part of this submission. A path absent from the current runtime tree
	 * (field deletion or repeat-instance removal) is retired permanently.
	 */
	attachmentPathDisposition(path: string): AttachmentPathDisposition {
		const node = this.findTreeNode(path);
		if (node === undefined || !isCaptureFieldKind(node.field.kind)) {
			return "removed";
		}
		const states = this.store.getState();
		const state = states[path];
		if (state === undefined || state === DEFAULT_ENGINE_STATE) {
			return "removed";
		}
		return this.effectivelyVisiblePaths(states).has(path)
			? "active"
			: "dormant";
	}

	computeSubmissionMutation(args: {
		caseId?: string;
		/**
		 * This form entry's attachment scope, supplied by the CONTROLLER
		 * rather than owned here.
		 *
		 * The engine is recreated mid-entry whenever the blueprint changes
		 * during live preview (that is what makes an edited `default_value`
		 * visible immediately), so a key minted here would rotate under the
		 * worker and orphan every attachment they had already staged. The
		 * controller's lifetime is the entry's lifetime, so the key lives
		 * there.
		 */
		entryKey: string;
		/**
		 * The viewer's IANA timezone — the offset a datetime answer is
		 * stamped with, standing in for the zone the device would stamp.
		 * Explicit rather than read from `Intl` here so the engine keeps no
		 * hidden environment dependency and a test pins a zone instead of
		 * inheriting the machine's. Absent falls back to UTC, matching
		 * every other viewer-zone consumer.
		 */
		viewerTimeZone?: string;
	}): SubmissionMutation {
		const zone = args.viewerTimeZone ?? "UTC";
		/* The operation identity riding every arm: the submitting form's
		 * uuid (the authored-key scope half and the server-side program
		 * builder's doc anchor) plus the collected per-scope answers when
		 * the form carries case operations. A survey with operations must
		 * NOT short-circuit — its program still executes. */
		const operationAnswers = this.computeOperationAnswers();
		const attachmentRefs = this.collectAttachmentReferences();
		const projectedCaseWrites = this.projectedCaseWrites();
		const usercaseProperties = this.collectUsercaseWrites();
		const operationIdentity = {
			formUuid: this.activeFormUuid() as string,
			entryKey: args.entryKey,
			...(usercaseProperties !== undefined && {
				usercase: usercaseProperties,
			}),
			// Always present, even when empty: an empty list is the exact
			// projection that retires every unreferenced staged attachment for
			// this entry.
			attachmentRefs,
			...(operationAnswers !== undefined && { operationAnswers }),
		};
		if (this.formType === "survey") {
			return { kind: "survey", ...operationIdentity };
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
		for (const caseType of this.caseWriteDoc.caseTypes ?? []) {
			caseTypeLookup.set(caseType.name, caseType);
		}

		const primaryProperties: JsonObject = {};
		// Standard writable scalars are plucked into dedicated slots. They
		// never enter the custom JSON property document.
		let primaryCaseName: string | undefined;
		let primaryExternalId: string | undefined;
		const effectivelyVisible = this.effectivelyVisiblePaths(
			this.store.getState(),
		);
		// Encounter-ordered materializations of canonical child buckets. The
		// inventory owns action identity; runtime traversal contributes only a
		// concrete iteration key for a bucket whose repeat UUID already matches.
		const childBuckets: ChildBucket[] = [];
		const childBucketIndex = new Map<
			CaseWriteBucket,
			Map<string, ChildBucket>
		>();
		const requireBucket = (
			bucket: CaseWriteBucket,
			repeatInstanceKey: string,
		): ChildBucket => {
			let byIteration = childBucketIndex.get(bucket);
			if (byIteration === undefined) {
				byIteration = new Map();
				childBucketIndex.set(bucket, byIteration);
			}
			const existing = byIteration.get(repeatInstanceKey);
			if (existing !== undefined) return existing;
			const created: ChildBucket = {
				caseType: bucket.caseType,
				properties: {},
			};
			byIteration.set(repeatInstanceKey, created);
			childBuckets.push(created);
			return created;
		};

		const walk = (
			nodes: ReadonlyArray<FieldTreeNode>,
			pathPrefix: string,
			activeRepeat:
				| { readonly uuid: Uuid; readonly instanceKey: string }
				| undefined,
		): void => {
			for (const node of nodes) {
				const f = node.field;
				const fieldPath = `${pathPrefix}/${f.id}`;

				if (f.kind === "group") {
					if (node.children) {
						walk(node.children, fieldPath, activeRepeat);
					}
					continue;
				}
				if (f.kind === "repeat") {
					if (!node.children) continue;
					const instanceCount = this.instance.getRepeatCount(fieldPath);
					for (let i = 0; i < instanceCount; i++) {
						const instancePath = `${fieldPath}[${i}]`;
						walk(node.children, instancePath, {
							uuid: f.uuid,
							instanceKey: instancePath,
						});
					}
					continue;
				}

				const projected = projectedCaseWrites.writerByUuid.get(f.uuid);
				if (projected === undefined) continue;
				const { writer, bucket } = projected;
				if (bucket.repeatUuid !== activeRepeat?.uuid) {
					throw new Error(
						compilerBugMessage({
							where: "preview.formEngine.computeSubmissionMutation",
							invariant: `canonical case-write bucket repeat \`${bucket.repeatUuid ?? "root"}\` does not match active nearest repeat \`${activeRepeat?.uuid ?? "root"}\` for writer \`${writer.fieldUuid}\``,
							detail:
								"Preview materializes the shared inventory bucket; it must never infer a new bucket from a rendered path or case-type name.",
						}),
					);
				}

				const isPrimary = bucket.kind === "primary";
				const repeatInstanceKey = activeRepeat?.instanceKey ?? "";
				const raw = this.instance.get(fieldPath);

				if (
					writer.property === "case_name" ||
					writer.property === "external_id"
				) {
					// An absent or irrelevant scalar writer means no write. An ACTIVE
					// empty external-id answer is different: it explicitly clears the
					// scalar to `""`.
					if (raw === undefined || !effectivelyVisible.has(fieldPath)) continue;
					const blank = writer.property === "external_id" ? "allow" : "reject";
					const prepared = prepareCaseScalarTextValue(raw, blank);
					if (!prepared.ok) {
						throw new Error(
							`Case field "${f.id}" cannot write ${writer.property}: the value is ${prepared.reason === "blank" ? "blank after CommCare-compatible boundary control characters are removed" : "longer than 255 UTF-16 code units"}.`,
						);
					}
					if (isPrimary) {
						if (writer.property === "case_name") {
							primaryCaseName = prepared.value;
						} else {
							primaryExternalId = prepared.value;
						}
					} else {
						const child = requireBucket(bucket, repeatInstanceKey);
						if (writer.property === "case_name") {
							child.caseName = prepared.value;
						} else {
							child.externalId = prepared.value;
						}
					}
					continue;
				}

				if (raw === undefined || raw === "") continue;

				const property = caseTypeLookup
					.get(writer.caseType)
					?.properties.find((candidate) => candidate.name === writer.property);
				if (property === undefined) {
					throw new Error(
						compilerBugMessage({
							where: "preview.formEngine.computeSubmissionMutation",
							invariant: `materializable case type \`${writer.caseType}\` has no property \`${writer.property}\` for writer \`${writer.fieldUuid}\``,
							detail:
								"Engine input must carry materializableCaseTypes(doc), which appends every writer-derived property before Preview coerces a submitted value.",
						}),
					);
				}
				const coerced = coerceValueForProperty(raw, property, zone);

				if (isPrimary) {
					primaryProperties[writer.property] = coerced;
					continue;
				}

				requireBucket(bucket, repeatInstanceKey).properties[writer.property] =
					coerced;
			}
		};

		walk(this.tree, "/data", undefined);

		// A bucket that received only a `caseName` or `externalId` scalar
		// write (no custom properties) is still a legitimate child. Buckets
		// with no scalar or custom-property write are dropped; the walker
		// only creates buckets when a contributing field lands in them, so
		// the predicate is defensive against an upstream change to creation.
		const isContentfulBucket = (b: ChildBucket): boolean =>
			b.caseName !== undefined ||
			b.externalId !== undefined ||
			Object.keys(b.properties).length > 0;

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
					...(b.externalId !== undefined ? { externalId: b.externalId } : {}),
					properties: b.properties,
				}));
				return {
					kind: "registration",
					...operationIdentity,
					primary: {
						caseType: this.moduleCaseType,
						...(primaryCaseName !== undefined
							? { caseName: primaryCaseName }
							: {}),
						...(primaryExternalId !== undefined
							? { externalId: primaryExternalId }
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
					...(b.externalId !== undefined ? { externalId: b.externalId } : {}),
					properties: b.properties,
					parentCaseId: caseId,
				}));
				const patch = {
					...(primaryCaseName !== undefined
						? { caseName: primaryCaseName }
						: {}),
					...(primaryExternalId !== undefined
						? { externalId: primaryExternalId }
						: {}),
					properties: primaryProperties,
				};
				if (this.formType === "followup") {
					return {
						kind: "followup",
						...operationIdentity,
						caseId,
						patch,
						children,
					};
				}
				return { kind: "close", ...operationIdentity, caseId, patch, children };
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
		this.caseWriteDoc = caseWriteDocOf(input);
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
		pairs: ReadonlyArray<{
			oldPath: string;
			newPath: string;
			oldSegmentKeys?: readonly string[];
			newSegmentKeys?: readonly string[];
		}>,
	): void {
		const moves: Array<{ from: string; to: string | null }> = [];
		for (const { oldPath, newPath, oldSegmentKeys, newSegmentKeys } of pairs) {
			const identity =
				oldSegmentKeys !== undefined && newSegmentKeys !== undefined
					? { oldSegmentKeys, newSegmentKeys }
					: undefined;
			for (const from of this.materializePaths(oldPath)) {
				moves.push({
					from,
					to: remapInstancePath(from, oldPath, newPath, identity),
				});
			}
		}

		const updates: EngineStoreState = {};
		const current = this.store.getState();
		const stateMoves = moves.map(({ from, to }) => ({
			from,
			to,
			state: current[from],
			instanceKeys: this.repeatInstanceKeys.get(from),
		}));
		this.instance.renameMany(moves);
		for (const { from } of stateMoves) {
			if (current[from]) updates[from] = DEFAULT_ENGINE_STATE;
			this.repeatInstanceKeys.delete(from);
		}
		// Destinations land only after every source is retired. Besides making
		// DataInstance atomic, this keeps the reactive store and repeat-row
		// identity map correct for swaps and rename chains in the same batch.
		for (const { to, state, instanceKeys } of stateMoves) {
			if (to === null) continue;
			if (state) updates[to] = { ...state, path: to };
			if (instanceKeys !== undefined) {
				this.repeatInstanceKeys.set(to, instanceKeys);
			}
		}
		if (Object.keys(updates).length > 0) {
			this.store.setState(updates);
		}
	}

	/**
	 * Seed only the concrete paths that a topology move newly exposes.
	 *
	 * A group moved into an already-expanded repeat has one preserved answer
	 * for instance 0 and brand-new empty/default slots for the other live
	 * instances. `renamePaths` deliberately moves only states that existed in
	 * the old topology; this fills those new holes without resetting moved
	 * values, touched flags, or validation state.
	 *
	 * Call after `rebuildDag`, so materialization follows the new topology.
	 */
	ensureFieldStates(path: string, field: Field): void {
		const current = this.store.getState();
		const updates: EngineStoreState = {};
		const createdPaths: string[] = [];
		const isStructural = field.kind === "group" || field.kind === "repeat";
		const isRequired =
			!isStructural &&
			expressionSource(field, "required", this.printDoc) === "true()";

		for (const concrete of this.materializePaths(path)) {
			const existing = current[concrete];
			if (existing !== undefined && existing !== DEFAULT_ENGINE_STATE) continue;

			if (field.kind === "repeat") {
				this.instance.ensureRepeat(concrete);
				updates[concrete] = {
					...this.initialContainerState(concrete, "repeat"),
					repeatCount: this.instance.getRepeatCount(concrete),
				};
			} else if (field.kind === "group") {
				updates[concrete] = this.initialContainerState(concrete, "group");
			} else {
				let value = this.instance.get(concrete);
				if (value === undefined) {
					value = this.computeDefault(field, concrete) ?? "";
					this.instance.set(concrete, value);
				}
				updates[concrete] = {
					path: concrete,
					value,
					visible: true,
					required: isRequired,
					valid: true,
					touched: false,
				};
			}
			createdPaths.push(concrete);
		}

		if (createdPaths.length === 0) return;
		this.store.setState(updates);
		this.evaluatePathsInto(createdPaths);
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
		this.printDoc = printableDocOf(input);
		this.caseWriteDoc = caseWriteDocOf(input);
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
		writesByField: ReadonlyMap<
			Uuid,
			CaseWriteField
		> = this.primaryCaseWritesByField(),
		prefix = "/data",
	): void {
		const own = this.ownCaseData();
		if (own === undefined) return;
		for (const node of tree) {
			const f = node.field;
			const path = `${prefix}/${f.id}`;
			const writer = writesByField.get(f.uuid);
			if (writer !== undefined && own.has(writer.property)) {
				const newValue = own.get(writer.property) ?? "";
				const oldValue = this.instance.get(path) ?? "";
				if (newValue !== oldValue) {
					this.instance.set(path, newValue);
					changedPaths.push(path);
				}
			}
			if (node.children) {
				const childPrefix = f.kind === "repeat" ? `${path}[0]` : path;
				this.preloadCaseDataTracked(
					node.children,
					changedPaths,
					writesByField,
					childPrefix,
				);
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
		this.caseWriteDoc = caseWriteDocOf(input);

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
		this.repeatInstanceKeys.clear();
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

	/** Snapshot values and touched state for persisting across engine rebuilds.
	 * Schema changes normally retain only touched answers. Presentation-only
	 * rebuilds can request every value because their value schema is identical,
	 * including an in-focus edit that has not blurred yet. */
	getValueSnapshot(options?: { includeAllValues?: boolean }): {
		values: Map<string, string>;
		touched: Set<string>;
	} {
		const values = new Map<string, string>();
		const touched = new Set<string>();
		for (const [path, state] of Object.entries(this.store.getState())) {
			if (state === DEFAULT_ENGINE_STATE) continue;
			if (options?.includeAllValues || state.value || state.touched) {
				values.set(path, state.value);
			}
			if (state.touched) touched.add(path);
		}
		return { values, touched };
	}

	/** Restore values from a snapshot and re-evaluate expressions. */
	restoreValues(
		snapshot: {
			values: Map<string, string>;
			touched: Set<string>;
		},
		options?: { restoreAllValues?: boolean },
	): void {
		const updates: EngineStoreState = {};
		const currentState = this.store.getState();

		/* Schema changes restore user-touched values so new defaults win. A
		 * presentation-only rebuild restores all values because no value-bearing
		 * schema changed and an active input may not have blurred yet. */
		const restoredPaths = options?.restoreAllValues
			? snapshot.values.keys()
			: snapshot.touched;
		for (const path of restoredPaths) {
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
		let resolvedHelp = current.resolvedHelp;
		let resolvedOptionLabels = current.resolvedOptionLabels;
		let choices = current.choices;
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
							fieldProseTemplate(f, "label"),
							this.printDoc,
							resolve,
						);
						const rh = resolveLabel(
							fieldProseTemplate(f, "hint"),
							this.printDoc,
							resolve,
						);
						const rhelp = resolveLabel(
							fieldProseTemplate(f, "help"),
							this.printDoc,
							resolve,
						);
						const roptions =
							(f.kind === "single_select" || f.kind === "multi_select") &&
							f.optionsSource.kind === "inline"
								? Object.fromEntries(
										f.optionsSource.options.flatMap((option) => {
											const value = resolveLabel(
												option.label,
												this.printDoc,
												resolve,
											);
											return value === undefined
												? []
												: [[option.uuid, value] as const];
										}),
									)
								: undefined;
						const normalizedOptions =
							roptions && Object.keys(roptions).length > 0
								? roptions
								: undefined;
						if (
							rl !== resolvedLabel ||
							rh !== resolvedHint ||
							rhelp !== resolvedHelp ||
							!stringRecordsEqual(normalizedOptions, resolvedOptionLabels)
						) {
							resolvedLabel = rl;
							resolvedHint = rh;
							resolvedHelp = rhelp;
							resolvedOptionLabels = normalizedOptions;
							changed = true;
						}
					}
					break;
				}
				case "choices": {
					const f = this.findField(path);
					if (
						f !== undefined &&
						(f.kind === "single_select" || f.kind === "multi_select") &&
						f.optionsSource.kind === "lookup"
					) {
						const next = this.computeLookupChoices(f.optionsSource, ctx);
						/* `undefined` is the typed loading state: no snapshot captured
						 * yet (the cold-load race before the builder session's fetch
						 * settles). The renderer shows loading, and the controller's
						 * first-arrival rebuild recomputes; nothing is unselected on
						 * unknown — unknown is not empty. */
						if (next === undefined) break;
						if (!lookupChoicesEqual(next, choices)) {
							choices = next;
							changed = true;
						}
						/* Unselect-on-removal: a selected value no longer among the
						 * filtered choices is dropped (multi-select token-wise). The
						 * DAG cascade already covers downstream readers — the seed's
						 * BFS closure includes this field's own dependents, and topo
						 * order evaluates them after this write lands. */
						const retained = retainSelection(f.kind, value, next);
						if (retained !== value) {
							this.instance.set(path, retained);
							value = retained;
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
				resolvedHelp,
				resolvedOptionLabels,
				choices,
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
		const shapeError = this.temporalShapeError(path, state.value);
		if (shapeError !== undefined) {
			if (state.valid || state.errorMessage !== shapeError) {
				updates[path] = { ...state, valid: false, errorMessage: shapeError };
			}
			return;
		}

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

	/**
	 * The message for a temporal answer that is not yet in a shape anything
	 * downstream can read, or `undefined` when there is nothing wrong.
	 *
	 * This exists because a clock is TYPED. Every other answer a person can
	 * half-finish is still a legal value of its type — "abc" is a string —
	 * but "2:3" is not a time, and without a gate it travels all the way to
	 * the case store and comes back as a schema rejection naming a property
	 * instead of a question. So the shape is checked here, where the field
	 * that owns it can say so.
	 *
	 * It rides with authored validation rather than with required, so it
	 * surfaces on blur — the moment the answer stopped being half-typed —
	 * and again for every field at submit. An empty answer is not
	 * ill-shaped; whether it is allowed is `required`'s question.
	 *
	 * The bar is READABILITY, never canonicality. Anything the storage
	 * boundary can canonicalize belongs to the person, not to this gate: a
	 * pre-millisecond `08:45:00Z` sitting in a case row and a `today()`
	 * default landing a bare date in a datetime slot are both fine, and
	 * refusing them would block a submission over an answer nobody typed and
	 * nobody can fix.
	 */
	private temporalShapeError(path: string, value: string): string | undefined {
		if (value === "") return undefined;
		const kind = this.findField(path)?.kind;
		if (kind !== "date" && kind !== "time" && kind !== "datetime") {
			return undefined;
		}
		if (isReadableTemporalValue(kind, value)) return undefined;
		switch (kind) {
			case "date":
				return `“${value}” isn't a date. Pick one from the calendar.`;
			case "time":
				return clockShapeMessage(value);
			case "datetime":
				return datetimeShapeMessage(value);
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

	private preloadCaseData(
		tree: FieldTreeNode[],
		writesByField: ReadonlyMap<
			Uuid,
			CaseWriteField
		> = this.primaryCaseWritesByField(),
		prefix = "/data",
	): void {
		const own = this.ownCaseData();
		if (own === undefined) return;
		for (const node of tree) {
			const f = node.field;
			const path = `${prefix}/${f.id}`;
			const writer = writesByField.get(f.uuid);
			if (writer !== undefined && own.has(writer.property)) {
				// Verbatim: the instance holds a temporal value exactly as the
				// case store holds it, so this path, its `Tracked` twin, and
				// typed case-ref resolution in `createEvalContext` cannot
				// disagree about the same property (see
				// `lib/domain/temporalValues.ts`).
				this.instance.set(path, own.get(writer.property) ?? "");
			}
			if (node.children) {
				const childPrefix = f.kind === "repeat" ? `${path}[0]` : path;
				this.preloadCaseData(node.children, writesByField, childPrefix);
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
		// The DEEPEST instance segment carries the evaluating node's own
		// position — for `/data/a[1]/b[0]/c`, position() is b's index.
		const repeatMatch = path.match(/\[(\d+)\][^[]*$/);
		if (repeatMatch) {
			position = Number.parseInt(repeatMatch[1], 10) + 1;
		}

		/* References print index-free (`#form/orders/name`), but repeat
		 * children live at indexed paths — bind each read onto the
		 * evaluating node's own instance, CommCare's relative-reference
		 * semantic. Reads outside the context's repeats pass through. */
		const read = (p: string): string | undefined =>
			this.instance.get(rebaseOntoContext(p, path));
		const session = previewSessionValues(this.previewIdentity);

		return {
			getValue: read,
			resolveInstance: (instanceId, instancePath) =>
				instanceId === "commcaresession"
					? {
							kind: "supported",
							value: sessionInstancePathValue(instancePath, session),
						}
					: { kind: "unsupported" },
			resolveHashtag: (ref: string) => {
				if (ref.startsWith("#form/")) {
					const fieldId = ref.slice(6);
					return read(`/data/${fieldId}`) ?? "";
				}
				/* `#user/<prop>` is the USERCASE, not the session block: on the
				 * wire it expands to the `commcare-user` case joined on the
				 * session's user id (`lib/commcare/hashtags.ts`), which HQ
				 * builds from a different set of built-in keys than the
				 * registration block does. The identity carries both
				 * projections for exactly this reason. An absent key reads
				 * blank — the device exposes a missing property as an empty
				 * node. */
				if (ref.startsWith("#user/")) {
					const prop = ref.slice(6);
					return ownRecordValue(this.previewIdentity?.usercase, prop) ?? "";
				}
				// Case references. The authoring vocabulary is per-case-type —
				// `#<case_type>/<prop>` (printXPath's `case-ref` spelling) —
				// resolved by looking the namespace up in the per-type case
				// data: the form's OWN module case type addresses the loaded
				// case (wire depth 0), an ANCESTOR type addresses the matching
				// row of the parent chain (the preview counterpart of the
				// wire's `…/index/parent × depth …` casedb walk — depth is
				// implicit in which row claimed the type name). On a
				// registration form no case is loaded, the map is empty,
				// and every case ref reads blank, matching the wire's
				// narrowing (the new case isn't in casedb at form init).
				const match = /^#([^/]+)\/(.+)$/.exec(ref);
				if (match) {
					const namespace = match[1];
					if (namespace === "case") {
						throw new Error(
							'Authored "#case/..." is not a Nova reference; Preview requires an explicit case-type namespace',
						);
					}
					const data =
						namespace !== undefined ? this.caseData.get(namespace) : undefined;
					return data?.get(match[2] ?? "") ?? "";
				}
				return "";
			},
			contextPath: path,
			position,
		};
	}

	// ── Private: lookup-carrier evaluation ───────────────────────────

	/** Whether any field in the active tree carries a lookup-backed
	 *  options source — the signal the controller uses to decide if a
	 *  late-arriving lookup snapshot warrants a rebuild. */
	usesLookupData(): boolean {
		let found = false;
		const walk = (nodes: FieldTreeNode[]): void => {
			for (const node of nodes) {
				const f = node.field;
				if (
					(f.kind === "single_select" || f.kind === "multi_select") &&
					f.optionsSource.kind === "lookup"
				) {
					found = true;
					return;
				}
				if (node.children) walk(node.children);
				if (found) return;
			}
		};
		walk(this.tree);
		return found;
	}

	/** Whether this engine captured a lookup snapshot at construction. */
	hasLookupData(): boolean {
		return this.lookupData !== null;
	}

	/** Does the CAPTURED snapshot cover every lookup identity this
	 *  form's carriers reference? False when none was captured or when
	 *  a validly committed edit outran the captured referenced set —
	 *  the controller's rebuild-on-arrival heal keys on it, so ordinary
	 *  data refreshes (covered) preserve per-form-session stability
	 *  while an identity gap rebuilds the moment fresh data lands. */
	lookupDataCoversForm(): boolean {
		let covered = true;
		const walk = (nodes: FieldTreeNode[]): void => {
			for (const node of nodes) {
				const f = node.field;
				if (
					(f.kind === "single_select" || f.kind === "multi_select") &&
					f.optionsSource.kind === "lookup" &&
					!lookupOptionsSourceCovered(
						f.optionsSource,
						this.lookupData ?? undefined,
					)
				) {
					covered = false;
					return;
				}
				if (node.children) walk(node.children);
				if (!covered) return;
			}
		};
		walk(this.tree);
		return covered;
	}

	/** `undefined` while the captured snapshot doesn't cover this
	 *  source's identities — no snapshot at all, or a validly committed
	 *  edit referencing a table/column the snapshot predates. Both are
	 *  the typed loading state the renderer presents; the controller's
	 *  coverage-keyed rebuild resolves them when fresh data arrives.
	 *  Only a COVERED snapshot evaluates, so `evaluateLookupChoices`'s
	 *  identity throws stay a genuine validation-bypass surface. */
	private computeLookupChoices(
		source: LookupOptionsSource,
		ctx: EvalContext,
	): readonly LookupChoice[] | undefined {
		const data = this.lookupData;
		if (data === null || !lookupOptionsSourceCovered(source, data)) {
			return undefined;
		}
		return evaluateLookupChoices(source, data, {
			outer: this.lookupOuterContext(ctx),
			formFields: this.fieldPathsByUuid(),
			userPropertySlugs: previewUserPropertySlugMap(
				previewSessionValues(this.previewIdentity),
			),
		});
	}

	/** The engine's eval context extended with the session-instance path
	 *  spellings the on-device emitters print for session/user terms —
	 *  a lookup filter's non-row reads resolve here. */
	private lookupOuterContext(base: EvalContext): EvalContext {
		const session = previewSessionValues(this.previewIdentity);
		return {
			...base,
			getValue: (p) => sessionInstancePathValue(p, session) ?? base.getValue(p),
			resolveInstance: (instanceId, path) =>
				instanceId === "commcaresession"
					? {
							kind: "supported",
							value: sessionInstancePathValue(path, session),
						}
					: (base.resolveInstance?.(instanceId, path) ?? {
							kind: "unsupported",
						}),
		};
	}

	/** uuid → generic path over the live tree, cached per tree identity —
	 *  the `formFields` binding surface lookup filters emit against
	 *  (generic paths; the outer context's rebasing read materializes the
	 *  evaluating node's own instance). */
	private fieldPathsByUuid(): ReadonlyMap<Uuid, string> {
		if (this.fieldPathsCacheTree !== this.tree) {
			const paths = new Map<Uuid, string>();
			const walk = (nodes: FieldTreeNode[], prefix: string): void => {
				for (const node of nodes) {
					const nodePath = `${prefix}/${node.field.id}`;
					paths.set(node.field.uuid, nodePath);
					if (node.children) walk(node.children, nodePath);
				}
			};
			walk(this.tree, "/data");
			this.fieldPathsCache = paths;
			this.fieldPathsCacheTree = this.tree;
		}
		return this.fieldPathsCache;
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
 * `caseName` and `externalId` are mutable because admission guarantees at
 * most one writer for each standard scalar per bucket. Both slots stay
 * separate from `properties` because they route to the top-level
 * `cases.case_name` and `cases.external_id` columns, not the JSONB document.
 */
interface ChildBucket {
	caseType: string;
	caseName?: string;
	externalId?: string;
	properties: JsonObject;
}

/** Domain-typed membership check for the engine's active form type. */
function isCaseLoadingFormType(formType: FormType): boolean {
	return CASE_LOADING_FORM_TYPES.has(formType);
}

/**
 * Coerce the form engine's string value into the typed JSON value
 * the case-store JSON Schema validator expects. Mirrors
 * `caseTypeToJsonSchema`'s per-`data_type` mapping. Engine input carries the
 * materializable case-type view, so every explicit writer has an entry here;
 * a present property with no pinned `data_type` follows the shared
 * effective-type convention and reads as text. Empty raw values never reach
 * this function.
 *
 * The two temporal arms are the storage boundary: the engine holds what
 * the device's instance holds, and the strict row schema wants more than
 * the wire carries. A time takes the `Z` storage tag; a datetime takes the
 * viewer's own offset, because that is what the device stamps and what the
 * viewer-local `format-date` reads back. `lib/domain/temporalValues.ts`
 * carries the reasoning and the CommCare citations.
 */
/** The one sentence a clock that isn't a clock gets, wherever it appears. */
function clockShapeMessage(clock: string): string {
	return `“${clock}” isn't a time yet. Enter a clock time like 2:30 PM.`;
}

/**
 * What to tell someone whose date-and-time answer isn't one yet.
 *
 * A datetime is edited as two halves and stored as one string, so the
 * string can be incomplete in two different ways and the person needs to
 * hear which. Quoting the whole value would put the join's own spelling
 * (`T09:15:00.000-04:00`) in front of them — internal punctuation they
 * never typed, about a field they can see is simply missing its date.
 */
function datetimeShapeMessage(value: string): string {
	const separator = value.indexOf("T");
	const datePart = separator === -1 ? value : value.slice(0, separator);
	const clock = separator === -1 ? "" : value.slice(separator + 1);
	if (clock !== "" && !isReadableTemporalValue("time", clock)) {
		return clockShapeMessage(clock);
	}
	if (clock === "") return "Enter a clock time: this question needs both.";
	if (datePart === "") return "Pick a date: this question needs both.";
	return `“${value}” isn't a date and time.`;
}

function coerceValueForProperty(
	raw: string,
	property: CaseProperty,
	zone: string,
): JsonValue {
	const dataType: CasePropertyDataType = property.data_type ?? "text";
	switch (dataType) {
		case "text":
		case "single_select":
		case "geopoint":
		case "date":
			return raw;
		case "time":
			return storageTimeValue(raw);
		case "datetime":
			return storageDatetimeValue(raw, zone);
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
