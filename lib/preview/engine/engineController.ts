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
 * - **Field kind change (retype)** → drop the stale value, re-init the field
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
import type { CaseType, Field, Form, Uuid } from "@/lib/domain";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";
import type { SubmissionMutation } from "./caseDataBindingTypes";
import type { FieldTreeNode } from "./fieldTree";
import { buildFieldTree } from "./fieldTree";
import {
	type CaseDataByType,
	FormEngine,
	type FormEngineInput,
} from "./formEngine";
import { type FieldState, fieldStatesEqual } from "./types";

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
):
	| "none"
	| "expression"
	| "label_refs"
	| "id_rename"
	| "default_value"
	| "kind_change" {
	// Checked FIRST — before the id-first short-circuit and the
	// expression/label fall-through. A `convertField` keeps the field's uuid
	// and id, so a same-id retype otherwise classifies as `none`/`expression`
	// and the stale value survives under the new kind. A combined retype+rename
	// (kind AND id both differ) also routes here — `onKindChanged` rebuilds the
	// path maps, so it subsumes `onIdRenamed`'s work.
	if (current.kind !== previous.kind) return "kind_change";

	if (current.id !== previous.id) return "id_rename";

	// Expression-carrying keys live on most but not all variants. Reading
	// through the variants' common intersection keeps the access type-safe
	// without switching on `kind` for every property. The AST-stored slots
	// (`calculate` / `relevant` / `required` / `validate` / `default_value`)
	// compare by REFERENCE: an untouched slot keeps its object identity
	// through Immer, and any commit installs a freshly parsed value — so
	// identity diff ≡ "this slot was written", which is exactly the rebuild
	// trigger.
	const cur = current as Field & {
		calculate?: unknown;
		relevant?: unknown;
		required?: unknown;
		validate?: unknown;
		default_value?: unknown;
		label?: string;
		hint?: string;
	};
	const prev = previous as Field & {
		calculate?: unknown;
		relevant?: unknown;
		required?: unknown;
		validate?: unknown;
		default_value?: unknown;
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
	private activeCaseData: CaseDataByType | undefined;

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
	activateForm(formUuid: Uuid, caseData?: CaseDataByType): void {
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
		this.engine = new FormEngine(input, mod?.caseType, caseData);

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

	/** Set a test-mode value and cascade through the DAG. Resolves the
	 *  uuid to its template path — edit-mode rows have no instance
	 *  dimension. Interactive rows call `setValueAt` with their concrete
	 *  path instead. */
	onValueChange(uuid: string, value: string): void {
		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		this.setValueAt(path, value);
	}

	/** Set a value at a concrete engine path — the interactive renderer's
	 *  entry point, where repeat children carry per-instance indexed paths
	 *  the uuid map can't address. */
	setValueAt(path: string, value: string): void {
		if (!this.engine) return;
		this.engine.setValue(path, value);
		const affectedPaths = [path, ...this.engine.getAffectedPaths(path)];
		this.syncPathsToStore(affectedPaths);
	}

	/** Mark a field as touched (on blur). Uuid-resolved template path —
	 *  see `onValueChange`. */
	onTouch(uuid: string): void {
		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		this.touchAt(path);
	}

	/** Mark the field at a concrete engine path as touched (on blur). */
	touchAt(path: string): void {
		if (!this.engine) return;
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

	/**
	 * Add a repeat instance. Returns the new index, or 0 (the template
	 * slot) when the call is rejected.
	 *
	 * Only `user_controlled` repeats accept add/remove at runtime —
	 * `count_bound` and `query_bound` repeats freeze their cardinality
	 * at form load (JavaRosa spec). The preview UI hides the Add button
	 * for those modes (`RepeatField.tsx` gates on `isUserControlled`),
	 * but this method is the authoritative second gate: tests, console
	 * invocations, replay, and any future caller can't mutate
	 * cardinality on a non-user-controlled repeat. Pattern matches the
	 * "UI is first defense, reducer is authoritative" rule documented
	 * for `convertField`.
	 */
	addRepeat(uuid: string, atPath?: string): number {
		if (!this.engine) return 0;
		if (!this.isUserControlledRepeat(uuid)) return 0;
		const path = atPath ?? this.uuidToPath.get(uuid);
		if (!path) return 0;
		const result = this.engine.addRepeat(path);
		// Cardinality changes touch the repeat's own `repeatCount`, the
		// new instance's per-path states, and any outside dependents —
		// the selective sweep diff-writes only entries that actually
		// changed, so untouched rows keep their references.
		this.syncAllPathsSelectively();
		return result;
	}

	/** Remove a repeat instance. Same gate as `addRepeat` — only
	 *  `user_controlled` repeats can shed instances at runtime. */
	removeRepeat(uuid: string, index: number, atPath?: string): void {
		if (!this.engine) return;
		if (!this.isUserControlledRepeat(uuid)) return;
		const path = atPath ?? this.uuidToPath.get(uuid);
		if (!path) return;
		this.engine.removeRepeat(path, index);
		// Selective sweep — see `addRepeat`.
		this.syncAllPathsSelectively();
	}

	/** True iff `uuid` resolves to a repeat field whose `repeat_mode`
	 *  is `user_controlled`. Defensive lookup — returns false for
	 *  unknown ids, non-repeats, and the count_bound / query_bound
	 *  modes whose cardinality is frozen. */
	private isUserControlledRepeat(uuid: string): boolean {
		if (!this.docStore) return false;
		const field = this.docStore.getState().fields[uuid];
		if (field?.kind !== "repeat") return false;
		return field.repeat_mode === "user_controlled";
	}

	/** Get the XForm path for a UUID. */
	getPath(uuid: string): string | undefined {
		return this.uuidToPath.get(uuid);
	}

	/**
	 * Walk the active form's template tree and emit one submission's
	 * worth of case-store mutations. Pass-through to
	 * `FormEngine.computeSubmissionMutation`.
	 *
	 * Requires an active engine — call `activateForm` first. Throws if
	 * the controller has no active engine, and if the active form is
	 * `followup` or `close` and no `caseId` is supplied. Consumers gate
	 * on `validateAll()` first; the engine assumes a valid form.
	 */
	computeSubmissionMutation(args: {
		caseId?: string;
		caseTypes: ReadonlyArray<CaseType>;
	}): SubmissionMutation {
		if (!this.engine) {
			throw new Error(
				compilerBugMessage({
					where: "preview.engineController.computeSubmissionMutation",
					invariant:
						"controller has no active engine; `activateForm` must be called before submission",
				}),
			);
		}
		return this.engine.computeSubmissionMutation(args);
	}

	// ── Per-field subscriptions ──────────────────────────────────────

	/**
	 * One Zustand subscription per field. Immer structural sharing means
	 * the callback only fires when THAT specific field was mutated.
	 *
	 * classifyChange determines what happened:
	 * - "none" → zero engine work
	 * - "kind_change" → drop the stale value at the old path, re-init the field
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
						case "kind_change":
							this.onKindChanged(uuid);
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

	/**
	 * A field's kind changed (a remote `convertField` retype). Two shapes,
	 * with opposite value semantics:
	 *
	 * - **Leaf retype** (e.g. text→secret, group→… never lands here): the
	 *   answer is meaningless under the new kind — a text value is not a valid
	 *   `int`/`date` — so the field's value is DROPPED and the field re-seeds
	 *   empty (re-applying its new default, if any).
	 * - **Container conversion** (group↔repeat): the container itself carries
	 *   no value, and its descendants' in-progress answers are still valid —
	 *   only their XForm paths shift (`/data/<c>/<child>` ↔ `/data/<c>[0]/<child>`
	 *   as the `[0]` template segment appears/disappears). Those descendant
	 *   values are RE-PATHED, not dropped, so a peer converting a group with
	 *   answered children to a repeat doesn't silently lose them.
	 *
	 * Either way the path maps + DAG rebuild (the conversion, and any
	 * co-incident rename, moves paths and rewires references), so this subsumes
	 * `onIdRenamed`'s work. When the retyped field has no path in the rebuilt
	 * tree (it was also removed in the same batch), it's cleaned up like a
	 * removal rather than left in a stale half-state.
	 */
	private onKindChanged(uuid: string): void {
		if (!this.engine) return;
		const input = this.currentEngineInput();
		if (!input) return;

		const field = input.fields[uuid];
		const isContainerConversion =
			field?.kind === "group" || field?.kind === "repeat";

		/* Snapshot old paths (container + every descendant) against the
		 * PRE-rebuild maps — that's where the current values live. For a
		 * container conversion these feed the descendant re-path below; for a
		 * leaf retype only the field's own old path matters (dropped). */
		const oldPath = this.uuidToPath.get(uuid);
		const oldDescendantPaths = isContainerConversion
			? new Map(
					collectFormUuids(
						uuid,
						input.fieldOrder as unknown as Record<string, string[]>,
					).map((d) => [d, this.uuidToPath.get(d)] as const),
				)
			: undefined;

		/* A leaf retype drops its own stale value up front — at every live
		 * instance; `addFieldState` only seeds `""` when the path is absent,
		 * so deleting is what makes the re-init start empty. A container has
		 * no value of its own to drop. */
		if (!isContainerConversion && oldPath) this.engine.deleteValue(oldPath);

		/* Rebuild path MAPS — the conversion (and any co-incident rename)
		 * moves paths. The engine's DAG rebuild waits until AFTER the value
		 * moves below: old paths materialize against the pre-change topology. */
		const newTree = buildFieldTree(
			input.formUuid,
			input.fields,
			input.fieldOrder,
		);
		const maps = buildPathMaps(newTree);
		this.uuidToPath = maps.uuidToPath;
		this.pathToUuid = maps.pathToUuid;

		const newPath = this.uuidToPath.get(uuid);

		/* Re-path descendant values for a container conversion: move each
		 * descendant's value + runtime state — every live instance — from its
		 * old path to its new (reindexed) path so answered children survive.
		 * One batch call, so materialization happens before any move. */
		const newDescendantPaths: string[] = [];
		if (oldDescendantPaths && field) {
			const pairs: Array<{ oldPath: string; newPath: string }> = [];
			for (const [descendantUuid, oldDescendantPath] of oldDescendantPaths) {
				const newDescendantPath = this.uuidToPath.get(descendantUuid);
				if (!newDescendantPath) continue;
				newDescendantPaths.push(newDescendantPath);
				if (oldDescendantPath && oldDescendantPath !== newDescendantPath) {
					pairs.push({
						oldPath: oldDescendantPath,
						newPath: newDescendantPath,
					});
				}
			}
			this.engine.renamePaths(pairs);
			/* A repeat→group conversion retires the container's instance
			 * count (instances ≥ 1 were dropped by the re-path above) —
			 * `deleteValue` clears it; containers own no value key. */
			if (field.kind === "group" && oldPath) this.engine.deleteValue(oldPath);
		}

		this.engine.rebuildDag(input);

		/* No path in the rebuilt tree → the field was also removed in this
		 * batch. Clean it up like a removal so it isn't left stale-but-blank
		 * with no engine value backing it. */
		if (!newPath) {
			this.onFieldsRemoved([uuid]);
			return;
		}

		if (field) {
			/* Re-seed the field's runtime state under the new kind. For a
			 * container conversion this is only the shell (a repeat carries
			 * `repeatCount`, a group doesn't) — `addFieldState` skips the value
			 * write for containers, leaving the re-pathed descendant values
			 * intact. For a leaf retype it re-seeds empty with the new kind's
			 * required flag and default. */
			this.engine.addFieldState(newPath, field);
		}

		/* Re-evaluate the converted field + its descendants + downstream
		 * dependents at every live instance, then sync. The selective sweep
		 * also propagates the unplugged old-path entries. */
		const affectedPaths = new Set<string>();
		for (const p of [newPath, ...newDescendantPaths]) {
			for (const concrete of this.engine.materializePaths(p)) {
				affectedPaths.add(concrete);
			}
			for (const dep of this.engine.getAffectedPaths(p)) affectedPaths.add(dep);
		}
		this.engine.evaluatePathsInto([...affectedPaths]);
		this.syncAllPathsSelectively();
	}

	/** A field's expression changed. Rebuild DAG (sub-ms), then
	 *  re-evaluate that field — every live instance — plus its
	 *  downstream dependents. */
	private onExpressionChanged(uuid: string): void {
		if (!this.engine) return;
		const input = this.currentEngineInput();
		if (!input) return;

		this.engine.rebuildDag(input);

		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		const affectedPaths = [
			...this.engine.materializePaths(path),
			...this.engine.getAffectedPaths(path),
		];
		this.engine.evaluatePathsInto(affectedPaths);
		this.syncPathsToStore(affectedPaths);
	}

	/** A field's label/hint with hashtag references changed. Rebuild the
	 *  DAG (it carries the printDoc the output resolution reads the new
	 *  label text through), then re-resolve at every live instance. */
	private onLabelRefsChanged(uuid: string): void {
		if (!this.engine) return;
		const input = this.currentEngineInput();
		if (input) this.engine.rebuildDag(input);
		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		const targets = this.engine.materializePaths(path);
		this.engine.evaluatePathsInto(targets);
		this.syncPathsToStore(targets);
	}

	/** A field's ID was renamed. Update path mappings, move DataInstance
	 *  values — every live instance, descendants included when a container
	 *  was renamed — rebuild DAG, and re-evaluate dependents. */
	private onIdRenamed(uuid: string, _oldId: string, _newId: string): void {
		if (!this.engine) return;
		const input = this.currentEngineInput();
		if (!input) return;

		/* Snapshot old paths (the field + every descendant — renaming a
		 * container moves the whole subtree) against the PRE-rebuild maps. */
		const oldPath = this.uuidToPath.get(uuid);
		const descendantUuids = collectFormUuids(
			uuid,
			input.fieldOrder as unknown as Record<string, string[]>,
		);
		const oldDescendantPaths = new Map(
			descendantUuids.map((d) => [d, this.uuidToPath.get(d)] as const),
		);

		const newTree = buildFieldTree(
			input.formUuid,
			input.fields,
			input.fieldOrder,
		);
		const maps = buildPathMaps(newTree);
		this.uuidToPath = maps.uuidToPath;
		this.pathToUuid = maps.pathToUuid;
		const newPath = this.uuidToPath.get(uuid);

		/* Move values + states — one batch, BEFORE the DAG rebuild so the
		 * old paths materialize against the pre-rename topology. */
		const pairs: Array<{ oldPath: string; newPath: string }> = [];
		if (oldPath && newPath && oldPath !== newPath) {
			pairs.push({ oldPath, newPath });
		}
		for (const [descendantUuid, oldDescendantPath] of oldDescendantPaths) {
			const newDescendantPath = this.uuidToPath.get(descendantUuid);
			if (
				oldDescendantPath &&
				newDescendantPath &&
				oldDescendantPath !== newDescendantPath
			) {
				pairs.push({ oldPath: oldDescendantPath, newPath: newDescendantPath });
			}
		}
		this.engine.renamePaths(pairs);

		/* Rebuild DAG (references may point to the new ID now) */
		this.engine.rebuildDag(input);

		/* Re-evaluate the renamed field + descendants + dependents at every
		 * live instance. The selective sweep also propagates the unplugged
		 * old-path entries. */
		if (newPath) {
			const affectedPaths = new Set<string>();
			const renamedRoots = [
				newPath,
				...descendantUuids
					.map((d) => this.uuidToPath.get(d))
					.filter((p): p is string => !!p),
			];
			for (const p of renamedRoots) {
				for (const concrete of this.engine.materializePaths(p)) {
					affectedPaths.add(concrete);
				}
				for (const dep of this.engine.getAffectedPaths(p)) {
					affectedPaths.add(dep);
				}
			}
			this.engine.evaluatePathsInto([...affectedPaths]);
			this.syncAllPathsSelectively();
		}
	}

	/** A field's default_value expression changed. Re-evaluate the
	 *  default (every live instance) and cascade through dependents. */
	private onDefaultValueChanged(uuid: string, field: Field): void {
		if (!this.engine) return;
		const input = this.currentEngineInput();
		if (input) this.engine.rebuildDag(input);

		const path = this.uuidToPath.get(uuid);
		if (!path) return;

		/* Re-evaluate the default value — engine handles the cascade */
		this.engine.reevaluateDefault(path, field);

		const affectedPaths = [
			...this.engine.materializePaths(path),
			...this.engine.getAffectedPaths(path),
		];
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

		/* Initialize state for each new field — every live instance when the
		 * field sits inside a repeat; existing fields untouched */
		const engine = this.engine;
		for (const uuid of uuids) {
			const path = this.uuidToPath.get(uuid);
			const field = input.fields[uuid];
			if (path && field) {
				engine.addFieldState(path, field);
			}
		}

		/* Sync only the new fields' concrete paths to the runtime store */
		const newPaths = uuids
			.map((u) => this.uuidToPath.get(u))
			.filter((p): p is string => !!p)
			.flatMap((p) => engine.materializePaths(p));
		this.syncPathsToStore(newPaths);

		/* Set up per-field subscriptions for the new fields */
		this.setupPerFieldSubscriptions(uuids);
	}

	/** Fields were removed from the form. Clean up their states
	 *  without rebuilding existing fields. */
	private onFieldsRemoved(uuids: string[]): void {
		if (!this.engine) return;

		/* Remove states from the engine and runtime store — every live
		 * instance in one batch (`removeFieldStates` materializes all paths
		 * before deleting, so removing a repeat container can't blind its
		 * children's instance expansion). It also drops the fields'
		 * `DataInstance` values so the path-keyed engine store and the value
		 * map stay consistent — a field re-added at the same path seeds empty
		 * rather than resurrecting the removed answer. */
		this.engine.removeFieldStates(
			uuids.map((u) => this.uuidToPath.get(u)).filter((p): p is string => !!p),
		);
		const runtimeUpdates: RuntimeStoreState = {};
		for (const uuid of uuids) {
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
			 * returns empty/default values for missing references. The
			 * selective sweep also propagates the unplugged removed-instance
			 * entries to the runtime store. */
			const allPaths = this.engine.getAllPaths();
			if (allPaths.length > 0) {
				this.engine.evaluatePathsInto(allPaths);
			}
			this.syncAllPathsSelectively();
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

	/**
	 * Runtime-store keys for one engine path. Every path with a uuid
	 * mapping gets its uuid key (the edit-mode rows' subscription);
	 * every path inside a repeat instance (any `[N]` segment) ALSO gets
	 * a path key — one entry per live instance, the interactive
	 * renderer's subscription. The two sets overlap on `[0]` template
	 * paths, which carry both keys. Uuid strings never start with `/`,
	 * so the two key spaces can't collide.
	 */
	private runtimeKeysFor(path: string): string[] {
		const keys: string[] = [];
		const uuid = this.pathToUuid.get(path);
		if (uuid) keys.push(uuid);
		if (path.includes("[")) keys.push(path);
		return keys;
	}

	/** Sync ALL engine state to the runtime store. Used only during
	 *  initial activation and full reset. */
	private syncAllToStore(): void {
		if (!this.engine) return;
		const engineState = this.engine.store.getState();
		const runtime: RuntimeStoreState = {};
		for (const [path, state] of Object.entries(engineState)) {
			for (const key of this.runtimeKeysFor(path)) {
				runtime[key] = state;
			}
		}
		this.store.setState(runtime, true);
	}

	/** Sync ALL paths but only write entries whose state actually changed.
	 *  Used by validateAll, resetValidation, and repeat cardinality
	 *  changes, where many fields are touched but most states don't
	 *  change. */
	private syncAllPathsSelectively(): void {
		if (!this.engine) return;
		const engineState = this.engine.store.getState();
		const currentRuntime = this.store.getState();
		const updates: RuntimeStoreState = {};
		let hasChanges = false;

		for (const [path, newState] of Object.entries(engineState)) {
			for (const key of this.runtimeKeysFor(path)) {
				const oldState = currentRuntime[key];
				if (!oldState || !fieldStatesEqual(oldState, newState)) {
					updates[key] = newState;
					hasChanges = true;
				}
			}
		}

		if (hasChanges) {
			this.store.setState(updates);
		}
	}

	/** Sync specific paths to the runtime store. The primary sync method —
	 *  used after every targeted operation. Only writes entries whose
	 *  state actually changed. */
	private syncPathsToStore(paths: string[]): void {
		if (!this.engine) return;
		const engineState = this.engine.store.getState();
		const currentRuntime = this.store.getState();
		const updates: RuntimeStoreState = {};
		let hasChanges = false;

		for (const path of paths) {
			const newState = engineState[path];
			if (!newState) continue;
			for (const key of this.runtimeKeysFor(path)) {
				const oldState = currentRuntime[key];
				if (!oldState || !fieldStatesEqual(oldState, newState)) {
					updates[key] = newState;
					hasChanges = true;
				}
			}
		}

		if (hasChanges) {
			this.store.setState(updates);
		}
	}
}
