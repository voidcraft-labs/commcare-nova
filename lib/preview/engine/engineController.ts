/**
 * EngineController — per-field reactive coordination layer.
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
 * - **Runtime store** (owned by this controller): UUID-keyed per-field
 *   computed state (visibility, required, validation, resolved labels).
 *   Ephemeral — never persisted, never in undo history.
 *
 * ## Per-field subscriptions
 *
 * One Zustand subscription per field on the blueprint store. Immer
 * structural sharing means `s.fields[uuid]` only gets a new reference
 * when THAT specific field was mutated.
 *
 * When a subscription fires, the controller classifies what changed:
 * - **Label/hint without refs, options, kind** → do nothing
 * - **Expression field** → rebuild DAG, re-evaluate that field + cascade
 * - **Label/hint with hashtag refs** → re-evaluate resolved labels only
 * - **Field ID rename** → update paths, rebuild DAG, re-evaluate dependents
 * - **Default value** → re-evaluate default + cascade
 *
 * ## Fully incremental
 *
 * There is no "rebuild everything" path. Every operation — including
 * adding/removing fields and metadata changes — is targeted. Only the
 * affected fields' states change. Existing fields keep their original
 * object references in the runtime store. No diffing needed.
 *
 * ## Domain types
 *
 * All traversal uses the normalized doc directly (`fields` / `fieldOrder`).
 * There is no conversion to a legacy nested-form shape. The engine walks
 * a rose-tree built at construction time — see `fieldTree.ts`.
 */
import { shallow } from "zustand/shallow";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { BlueprintDocState } from "@/lib/doc/store";
import type { Field, Form, Uuid } from "@/lib/domain";
import type { FieldTreeNode } from "./fieldTree";
import { buildFieldTree } from "./fieldTree";
import { FormEngine, type FormEngineInput } from "./formEngine";
import type { FieldState } from "./types";

// ── Runtime store types ─────────────────────────────────────────────────

/** Per-field computed runtime state. Keyed by UUID, aligned with the
 *  blueprint store. Components subscribe via `useStore(store, s => s[uuid])`. */
export type RuntimeState = FieldState;

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

/**
 * Assemble the `FormEngineInput` for a given form from the current doc state.
 *
 * The engine takes domain types directly: the flat `fields` map, the
 * adjacency list in `fieldOrder`, and the form entity. There is no
 * intermediate wire-format representation — the engine's internal walkers
 * build a rose tree from these maps and operate on domain `Field` entities
 * throughout.
 */
function buildEngineInput(
	state: Pick<BlueprintDocState, "forms" | "fields" | "fieldOrder">,
	formUuid: Uuid,
): FormEngineInput | undefined {
	const form = state.forms[formUuid];
	if (!form) return undefined;
	return {
		form: form as Form,
		formUuid,
		fields: state.fields as unknown as Record<string, Field>,
		fieldOrder: state.fieldOrder as unknown as Record<string, Uuid[]>,
	};
}

/**
 * Locate the module that owns a given form by scanning `formOrder`.
 *
 * The blueprint doc stores forms and modules as separate entity maps with
 * `formOrder[moduleUuid]: Uuid[]` acting as the parent→children adjacency
 * list. There is no back-pointer on the form entity itself (see
 * `lib/domain/forms.ts`), so to resolve "which module owns this form" we
 * walk `moduleOrder` and check each module's child list. The controller
 * only needs this answer to fetch the owning module's `caseType` for
 * engine construction / metadata subscriptions — called at most a handful
 * of times per form activation. The loop bounds are tiny (N_modules *
 * avg_forms_per_module) and complexity stays well inside the budget.
 */
function findModuleForForm(
	state: Pick<BlueprintDocState, "moduleOrder" | "formOrder">,
	formUuid: Uuid,
): Uuid | undefined {
	for (const moduleUuid of state.moduleOrder) {
		if (state.formOrder[moduleUuid]?.includes(formUuid)) {
			return moduleUuid;
		}
	}
	return undefined;
}

/**
 * Build bidirectional UUID ↔ XForm path maps by walking the field tree.
 *
 * Paths are the ones the engine uses internally: `/data/<id>` at the root,
 * `/data/<group>/<child>` for groups, `/data/<repeat>[0]/<child>` for
 * repeats. We only materialise the `[0]` template here — per-instance paths
 * are derived on demand when a repeat value is read.
 */
function buildPathMaps(
	tree: FieldTreeNode[],
	prefix = "/data",
): { uuidToPath: Map<string, string>; pathToUuid: Map<string, string> } {
	const uuidToPath = new Map<string, string>();
	const pathToUuid = new Map<string, string>();
	function walk(nodes: FieldTreeNode[], pfx: string) {
		for (const node of nodes) {
			const f = node.field;
			const path = `${pfx}/${f.id}`;
			uuidToPath.set(f.uuid, path);
			pathToUuid.set(path, f.uuid);
			if (node.children) {
				const childPrefix = f.kind === "repeat" ? `${path}[0]` : path;
				walk(node.children, childPrefix);
			}
		}
	}
	walk(tree, prefix);
	return { uuidToPath, pathToUuid };
}

/** Recursively collect all field UUIDs belonging to a form. */
function collectFormUuids(
	rootUuid: string,
	fieldOrder: Record<string, string[]>,
): string[] {
	const result: string[] = [];
	function walk(parentId: string) {
		const children = fieldOrder[parentId];
		if (!children) return;
		for (const uuid of children) {
			result.push(uuid);
			walk(uuid);
		}
	}
	walk(rootUuid);
	return result;
}

/** Classify what changed between two domain `Field` entity versions. */
function classifyChange(
	current: Field,
	previous: Field,
): "none" | "expression" | "label_refs" | "id_rename" | "default_value" {
	if (current.id !== previous.id) return "id_rename";

	// Expression-carrying keys live on most but not all variants. Reading
	// through the variants' common intersection keeps the access type-safe
	// without switching on `kind` for every property.
	const cur = current as Field & {
		calculate?: string;
		relevant?: string;
		required?: string;
		validate?: string;
		default_value?: string;
		label?: string;
		hint?: string;
	};
	const prev = previous as Field & {
		calculate?: string;
		relevant?: string;
		required?: string;
		validate?: string;
		default_value?: string;
		label?: string;
		hint?: string;
	};

	if (
		cur.calculate !== prev.calculate ||
		cur.relevant !== prev.relevant ||
		cur.required !== prev.required ||
		cur.validate !== prev.validate
	) {
		return "expression";
	}

	if (cur.default_value !== prev.default_value) return "default_value";

	const labelChanged = cur.label !== prev.label;
	const hintChanged = cur.hint !== prev.hint;
	if (labelChanged || hintChanged) {
		const hasRefs =
			(cur.label?.includes("#") ?? false) ||
			(prev.label?.includes("#") ?? false) ||
			(cur.hint?.includes("#") ?? false) ||
			(prev.hint?.includes("#") ?? false);
		if (hasRefs) return "label_refs";
	}

	return "none";
}

/** Field-level equality for FieldState. Only used for validateAll/resetValidation
 *  which operate on all fields but most states don't actually change. */
function statesEqual(a: FieldState, b: FieldState): boolean {
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

	/** UUID of the form this controller is currently activated for. Undefined
	 *  between `deactivate()` and the next `activateForm()`. Subscription
	 *  callbacks and the `currentEngineInput()` helper read this to re-derive
	 *  the owning module + form state from the latest doc snapshot. */
	private activeFormUuid: Uuid | undefined;
	private activeCaseData: Map<string, string> | undefined;

	/** Field UUIDs with active per-field subscriptions. */
	private trackedUuids = new Set<string>();

	/** Cleanup functions for all subscriptions. */
	private unsubscribers: (() => void)[] = [];

	/** Reference to the doc store — installed by SyncBridge when the
	 *  BlueprintDocProvider mounts, cleared on unmount. */
	private docStore: BlueprintDocStore | undefined;

	constructor() {
		this.store = createStore<RuntimeStoreState>(() => ({}));
	}

	/** Connect to the doc store. Called by SyncBridge when the provider mounts. */
	setDocStore(docStore: BlueprintDocStore | null): void {
		this.docStore = docStore ?? undefined;
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	/**
	 * Activate the engine for a specific form. Builds the computation engine,
	 * UUID↔path maps, initial runtime state, and per-field subscriptions.
	 *
	 * The form is identified by UUID — the controller resolves the owning
	 * module internally via `findModuleForForm` so callers never have to
	 * thread positional indices through React state.
	 */
	activateForm(formUuid: Uuid, caseData?: Map<string, string>): void {
		this.deactivate();
		if (!this.docStore) return;

		const s = this.docStore.getState();
		// Bail out silently if the form no longer exists — the hook uses an
		// effect-based lifecycle so a transient "form deleted during
		// re-render" window is normal; the next effect tick reactivates
		// against the new active form.
		if (!s.forms[formUuid]) return;
		const moduleUuid = findModuleForForm(s, formUuid);
		if (!moduleUuid) return;

		this.activeFormUuid = formUuid;
		this.activeCaseData = caseData;

		/* Build the FormEngine input from the doc store */
		const input = buildEngineInput(s, formUuid);
		if (!input) return;

		const mod = s.modules[moduleUuid];
		this.engine = new FormEngine(input, s.caseTypes, mod?.caseType, caseData);

		/* Build UUID ↔ path mapping from the engine's walked tree */
		const tree = this.engine.getFieldTree();
		const maps = buildPathMaps(tree);
		this.uuidToPath = maps.uuidToPath;
		this.pathToUuid = maps.pathToUuid;

		/* Sync initial engine state to the UUID-keyed runtime store */
		this.syncAllToStore();

		/* Set up subscriptions */
		const uuids = collectFormUuids(
			formUuid as string,
			s.fieldOrder as unknown as Record<string, string[]>,
		);
		this.setupPerFieldSubscriptions(uuids);
		this.setupStructuralSubscription(formUuid);
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
		this.activeFormUuid = undefined;
		this.activeCaseData = undefined;
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
		/* validateAll touches many fields (marks touched, runs validation).
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

	// ── Per-field subscriptions ──────────────────────────────────────

	/**
	 * One Zustand subscription per field. Immer structural sharing means
	 * the callback only fires when THAT specific field was mutated.
	 *
	 * classifyChange determines what happened:
	 * - "none" → zero engine work
	 * - "expression" → rebuild DAG, evaluate field + cascade
	 * - "label_refs" → re-evaluate resolved labels
	 * - "id_rename" → update paths, rebuild DAG, re-evaluate dependents
	 * - "default_value" → re-evaluate default + cascade
	 */
	private setupPerFieldSubscriptions(uuids: string[]): void {
		if (!this.docStore) return;
		const store = this.docStore;

		for (const uuid of uuids) {
			this.trackedUuids.add(uuid);

			const unsub = store.subscribe(
				(s) => s.fields[uuid as Uuid],
				(current, previous) => {
					if (!current || !previous || !this.engine) return;
					const changeType = classifyChange(
						current as Field,
						previous as Field,
					);

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
							this.onDefaultValueChanged(uuid, current as Field);
							return;
					}
				},
			);

			this.unsubscribers.push(unsub);
		}
	}

	/**
	 * Structural subscription — detects add/remove by watching the full set
	 * of field UUIDs in this form (recursively from fieldOrder).
	 */
	private setupStructuralSubscription(formUuid: Uuid): void {
		if (!this.docStore) return;
		const store = this.docStore;

		const unsub = store.subscribe(
			(s) =>
				collectFormUuids(
					formUuid as string,
					s.fieldOrder as unknown as Record<string, string[]>,
				),
			(currentUuids, previousUuids) => {
				const currentSet = new Set(currentUuids);
				const previousSet = new Set(previousUuids);
				const added = currentUuids.filter((u) => !previousSet.has(u));
				const removed = previousUuids.filter((u) => !currentSet.has(u));

				if (added.length > 0) this.onFieldsAdded(added);
				if (removed.length > 0) this.onFieldsRemoved(removed);
			},
			{ equalityFn: shallow },
		);

		this.unsubscribers.push(unsub);
	}

	/** Metadata subscription — form type or module case type changes. */
	private setupMetadataSubscription(): void {
		if (!this.docStore) return;
		const store = this.docStore;

		const unsub = store.subscribe(
			(s) => {
				const formUuid = this.activeFormUuid;
				const form = formUuid ? s.forms[formUuid] : undefined;
				const moduleUuid = formUuid
					? findModuleForForm(s, formUuid)
					: undefined;
				const mod = moduleUuid ? s.modules[moduleUuid] : undefined;
				return `${form?.type}|${mod?.caseType}`;
			},
			() => this.onMetadataChanged(),
		);

		this.unsubscribers.push(unsub);
	}

	// ── Targeted change handlers ─────────────────────────────────────

	/** Helper: resolve the active form's FormEngineInput from the current
	 *  doc state. Returns undefined if the form no longer exists (deleted
	 *  mid-subscription). */
	private currentEngineInput(): FormEngineInput | undefined {
		if (!this.docStore) return undefined;
		const formUuid = this.activeFormUuid;
		if (!formUuid) return undefined;
		const s = this.docStore.getState();
		return buildEngineInput(s, formUuid);
	}

	/** A field's expression changed. Rebuild DAG (sub-ms), then
	 *  re-evaluate only that field + its downstream dependents. */
	private onExpressionChanged(uuid: string): void {
		if (!this.engine) return;
		const input = this.currentEngineInput();
		if (!input) return;

		this.engine.rebuildDag(input);

		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		const affectedPaths = [path, ...this.engine.getAffectedPaths(path)];
		this.engine.evaluatePathsInto(affectedPaths);
		this.syncPathsToStore(affectedPaths);
	}

	/** A field's label/hint with hashtag references changed.
	 *  Re-evaluate resolved labels for just this one field. */
	private onLabelRefsChanged(uuid: string): void {
		if (!this.engine) return;
		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		this.engine.evaluatePathsInto([path]);
		this.syncPathsToStore([path]);
	}

	/** A field's ID was renamed. Update path mappings, move DataInstance
	 *  values, rebuild DAG, and re-evaluate dependents. */
	private onIdRenamed(uuid: string, _oldId: string, _newId: string): void {
		if (!this.engine) return;
		const input = this.currentEngineInput();
		if (!input) return;

		/* Rebuild path maps — the renamed field has a new path */
		const oldPath = this.uuidToPath.get(uuid);
		const newTree = buildFieldTree(
			input.formUuid,
			input.fields,
			input.fieldOrder,
		);
		const maps = buildPathMaps(newTree);
		this.uuidToPath = maps.uuidToPath;
		this.pathToUuid = maps.pathToUuid;
		const newPath = this.uuidToPath.get(uuid);

		/* Move the DataInstance value to the new path */
		if (oldPath && newPath && oldPath !== newPath) {
			this.engine.renamePath(oldPath, newPath);
		}

		/* Rebuild DAG (references may point to the new ID now) */
		this.engine.rebuildDag(input);

		/* Re-evaluate the renamed field + dependents */
		if (newPath) {
			const affectedPaths = [newPath, ...this.engine.getAffectedPaths(newPath)];
			this.engine.evaluatePathsInto(affectedPaths);
			this.syncPathsToStore(affectedPaths);
		}
	}

	/** A field's default_value expression changed. Re-evaluate the
	 *  default and cascade through dependents. */
	private onDefaultValueChanged(uuid: string, field: Field): void {
		if (!this.engine) return;
		const input = this.currentEngineInput();
		if (input) this.engine.rebuildDag(input);

		const path = this.uuidToPath.get(uuid);
		if (!path) return;

		/* Re-evaluate the default value — engine handles the cascade */
		this.engine.reevaluateDefault(path, field);

		const affectedPaths = [path, ...this.engine.getAffectedPaths(path)];
		this.syncPathsToStore(affectedPaths);
	}

	/** Fields were added to the form. Initialize their states
	 *  incrementally without rebuilding existing fields. */
	private onFieldsAdded(uuids: string[]): void {
		if (!this.engine) return;
		const input = this.currentEngineInput();
		if (!input) return;

		/* Rebuild path maps and DAG to include the new fields */
		const tree = buildFieldTree(input.formUuid, input.fields, input.fieldOrder);
		const maps = buildPathMaps(tree);
		this.uuidToPath = maps.uuidToPath;
		this.pathToUuid = maps.pathToUuid;
		this.engine.rebuildDag(input);

		/* Initialize state for each new field — existing fields untouched */
		for (const uuid of uuids) {
			const path = this.uuidToPath.get(uuid);
			const field = input.fields[uuid];
			if (path && field) {
				this.engine.addFieldState(path, field);
			}
		}

		/* Sync only the new fields to the runtime store */
		const newPaths = uuids
			.map((u) => this.uuidToPath.get(u))
			.filter((p): p is string => !!p);
		this.syncPathsToStore(newPaths);

		/* Set up per-field subscriptions for the new fields */
		this.setupPerFieldSubscriptions(uuids);
	}

	/** Fields were removed from the form. Clean up their states
	 *  without rebuilding existing fields. */
	private onFieldsRemoved(uuids: string[]): void {
		if (!this.engine) return;

		/* Remove states from the engine and runtime store */
		const runtimeUpdates: RuntimeStoreState = {};
		for (const uuid of uuids) {
			const path = this.uuidToPath.get(uuid);
			if (path) {
				this.engine.removeFieldState(path);
			}
			runtimeUpdates[uuid] = DEFAULT_RUNTIME_STATE;
			this.trackedUuids.delete(uuid);
		}
		this.store.setState(runtimeUpdates);

		/* Rebuild path maps and DAG without the removed fields */
		const input = this.currentEngineInput();
		if (input) {
			const tree = buildFieldTree(
				input.formUuid,
				input.fields,
				input.fieldOrder,
			);
			const maps = buildPathMaps(tree);
			this.uuidToPath = maps.uuidToPath;
			this.pathToUuid = maps.pathToUuid;
			this.engine.rebuildDag(input);

			/* Re-evaluate fields that depended on the removed ones.
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
	 *  and re-evaluate only the affected case-property fields. */
	private onMetadataChanged(): void {
		if (!this.engine || !this.docStore) return;
		const input = this.currentEngineInput();
		if (!input) return;

		const s = this.docStore.getState();
		const moduleUuid = this.activeFormUuid
			? findModuleForForm(s, this.activeFormUuid)
			: undefined;
		const mod = moduleUuid ? s.modules[moduleUuid] : undefined;

		this.engine.refreshCaseContext(
			input,
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
	 *  Used by validateAll and resetValidation where many fields are
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
}
