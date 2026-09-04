/**
 * blueprintHelpers — SA-only pure helpers over `BlueprintDoc`.
 *
 * Mutation builders return `Mutation[]` for the caller to apply
 *     via `docStore.applyMany(mutations)`. Helpers cover every level of
 *     the tree (app / module / form / field) plus the scaffolding +
 *     case-type bulk operations used during initial generation.
 *
 * Nothing here mutates state directly; the mutation-first convention
 * keeps agent-side call sites and the store-side reducer decoupled.
 *
 * Kept in `lib/agent/` because every consumer lives here. The shared
 * `searchBlueprint` query lives at `lib/doc/searchBlueprint.ts` so the
 * client `useSearchBlueprint` hook stays on its side of the
 * server/client boundary.
 */

import { addModuleMutation } from "@/lib/doc/addModuleMutation";
import {
	columnAddMutation,
	columnContentEqualIgnoringGranularSlots,
	columnContentSnapshot,
	columnSortMutations,
	columnVisibilityMutations,
} from "@/lib/doc/caseListColumnMutations";
import {
	cleanupCaseSearchAfterFinalInputMutation,
	enableCaseSearchMutation,
} from "@/lib/doc/caseSearchConfigMutations";
import { buildFieldTree, type FieldWithChildren } from "@/lib/doc/fieldWalk";
import {
	type ModuleAuthoringPatch,
	modulePatchMutations,
} from "@/lib/doc/modulePatchMutations";
import { anchorForIndex, sequenceMovesTo } from "@/lib/doc/mutations/sequence";
import { searchInputUpdateMutation as planSearchInputUpdate } from "@/lib/doc/searchInputMutations";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	CaseOperation,
	Column,
	ConnectConfig,
	Field,
	FieldKind,
	FieldPatchFor,
	Form,
	FormIconRef,
	FormIconSlug,
	FormType,
	Media,
	MediaAssetId,
	Module,
	ModuleIconRef,
	PostSubmitDestination,
	SearchInputDef,
	Uuid,
} from "@/lib/domain";
import {
	asUuid,
	fieldKinds,
	isBuiltinIconRef,
	isContainer,
	isOwnerOnlyCaseSearchConfig,
	parseBuiltinIconSlug,
	slugifyId,
} from "@/lib/domain";
import { effectiveFilterForEmission } from "@/lib/domain/predicate";
import {
	removeByUuid,
	reorderByUuid,
	replaceByUuid,
} from "./tools/case-list-config/shared";

// ── Form-tree snapshot ──────────────────────────────────────────────────

/**
 * Shape returned by `formSnapshot` — the form entity augmented with its
 * ordered, nested field tree. It keeps domain names (`closeCondition`,
 * `postSubmit`, `formLinks`) and preserves the canonical UUID-backed
 * expression and lookup shapes SA/MCP callers can round-trip.
 *
 * Lives alongside the other `BlueprintDoc`-read derived shapes.
 */
export type FormSnapshot = Omit<Form, "caseOperations" | "icon"> & {
	/** Built-ins project to their accepted catalog slug; uploads stay UUIDs. */
	icon?: FormIconSlug | MediaAssetId;
	fields: FieldWithChildren[];
	caseOperations?: CaseOperation[];
};

/**
 * Build the canonical `FormSnapshot` for the given form UUID. Returns
 * `undefined` when the form doesn't exist in the doc — callers surface that
 * as a "form not found" error to the SA.
 */
export function formSnapshot(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormSnapshot | undefined {
	const form = doc.forms[formUuid];
	if (!form) return undefined;
	const projected = {
		...form,
		fields: buildFieldTree(doc, formUuid),
	};
	const { icon, ...withoutStoredIcon } = projected;
	return {
		...withoutStoredIcon,
		...(icon !== undefined && {
			icon: projectFormIconForAuthoring(icon),
		}),
	};
}

function projectFormIconForAuthoring(
	icon: FormIconRef,
): FormIconSlug | MediaAssetId {
	if (!isBuiltinIconRef(icon)) return icon;
	return parseBuiltinIconSlug(icon) as FormIconSlug;
}

// ── Mutation builders — modules ─────────────────────────────────────────

/** Input shape for a new module. `uuid` may be supplied to pin identity
 *  (`createModule` pre-mints the uuid its later batch entries
 *  reference), otherwise the helper mints one. */
export interface NewModuleInput {
	uuid?: string;
	id?: string;
	name: string;
	parentModuleUuid?: Uuid;
	caseType?: string;
	caseListOnly?: boolean;
	purpose?: string;
	caseListConfig?: Module["caseListConfig"];
}

/** Build an `addModule` mutation. Mints a uuid when the caller doesn't
 *  supply one — mirrors the producer-side stamp pattern established by
 *  `addField` in the reducer. The module appends: the SA creates modules at
 *  the end of the app and reorders them with `moveModule`. */
export function addModuleMutations(input: NewModuleInput): Mutation[] {
	const uuid = asUuid(
		typeof input.uuid === "string" && input.uuid.length > 0
			? input.uuid
			: crypto.randomUUID(),
	);
	const module: Module = {
		uuid,
		// Modules carry a semantic `id` alongside their display `name`. SA
		// callers typically only know the name; derive a slug when id is
		// absent so round-tripping through the store stays consistent.
		id: input.id ?? slugifyModuleId(input.name),
		name: input.name,
		...(input.parentModuleUuid !== undefined && {
			parentModuleUuid: input.parentModuleUuid,
		}),
		...(input.caseType !== undefined && { caseType: input.caseType }),
		...(input.caseListOnly !== undefined && {
			caseListOnly: input.caseListOnly,
		}),
		...(input.purpose !== undefined && { purpose: input.purpose }),
		...(input.caseListConfig !== undefined && {
			caseListConfig: input.caseListConfig,
		}),
	};
	return [addModuleMutation(module)];
}

/** Remove a module (cascades forms + fields via the reducer). No-op when
 *  the uuid isn't present in the current doc. */
export function removeModuleMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): Mutation[] {
	if (doc.modules[moduleUuid] === undefined) return [];
	return [{ kind: "removeModule", uuid: moduleUuid }];
}

/** Patch module fields. Keys mirror the domain Module shape (camelCase).
 *
 *  Takes the resolved `Module` directly — every caller already looks the
 *  module up out of the doc to derive its uuid + read sibling fields, so
 *  re-resolving inside the helper would just repeat the same map lookup.
 *  The "module not found" defense lives at each tool's call boundary. */
export function updateModuleMutations(
	mod: Module,
	patch: ModuleAuthoringPatch,
): Mutation[] {
	return modulePatchMutations(mod, patch, {
		nullCaseSearchConfig: "settings",
	});
}

/**
 * Set or clear the blueprint-root `logo` (the app-level login/home-screen
 * image). The app has no other app-level setter — this is the only writer
 * for `doc.logo`. Passing an asset id sets it; passing `null` clears it.
 * The `setAppLogo` reducer maps `null → undefined` so the cleared key
 * drops off the doc rather than persisting as a literal `null`. */
export function setAppLogoMutations(logo: MediaAssetId | null): Mutation[] {
	return [{ kind: "setAppLogo", logo }];
}

/**
 * The four field message slots a media bundle attaches to, sourced from
 * the `setFieldMedia` mutation arm so the builder signature can't drift
 * from the wire schema.
 */
export type FieldMediaSlot = Extract<
	Mutation,
	{ kind: "setFieldMedia" }
>["slot"];

/**
 * Set or clear one of a field's message-slot media bundles
 * (`label`/`hint`/`help`/`validate_msg`). Emits the dedicated
 * `setFieldMedia` mutation — NOT an `updateField` patch — because a clear
 * must cross the SSE wire as an explicit `null` (the reducer maps it to
 * `undefined`). A clear encoded as `{ <slot>_media: undefined }` on an
 * `updateField` patch would be dropped by `JSON.stringify`, silently
 * leaving the stale asset ref on the client. Passing a `Media` bundle
 * sets the slot; passing `null` clears it. The reducer guards slot-vs-kind
 * (the SA tool also rejects an unsupported slot up front). */
export function setFieldMediaMutations(
	fieldUuid: Uuid,
	slot: FieldMediaSlot,
	media: Media | null,
): Mutation[] {
	return [{ kind: "setFieldMedia", fieldUuid, slot, media }];
}

/**
 * Set or clear a module's menu media (home-screen tile `icon` +
 * `audioLabel`). Emits the dedicated `setModuleMedia` mutation rather than
 * an `updateModule` patch, for the same wire-survival reason as
 * `setFieldMediaMutations`: a clear rides as explicit `null` (mapped to
 * `undefined` in the reducer) so it isn't dropped by `JSON.stringify`.
 * Both slots are set in one call — pass `null` on either to clear it. */
export function setModuleMediaMutations(
	moduleUuid: Uuid,
	icon: ModuleIconRef | null,
	audioLabel: MediaAssetId | null,
): Mutation[] {
	return [{ kind: "setModuleMedia", uuid: moduleUuid, icon, audioLabel }];
}

/**
 * Set or clear a form's menu media (tile `icon` + `audioLabel`). Mirrors
 * `setModuleMediaMutations` one level down — dedicated `setFormMedia`
 * mutation so a clear survives the SSE wire as an explicit `null`. */
export function setFormMediaMutations(
	formUuid: Uuid,
	icon: FormIconRef | null,
	audioLabel: MediaAssetId | null,
): Mutation[] {
	return [{ kind: "setFormMedia", uuid: formUuid, icon, audioLabel }];
}

// ── Mutation builders — case list config ────────────────────────────────
//
// One quartet of helpers per case-list slot — `caseListConfig.columns`
// and `caseListConfig.searchInputs`. Each quartet (`add`, `update`,
// `remove`, `reorder`) returns a tagged `CaseListMutationResult`: on
// success, `{ ok: true, mutations }` ready to record; on failure,
// `{ error }` carrying an Elm-style string the tool forwards verbatim.
// Failure returns expose the array-level predicates (uuid not found,
// length mismatch, duplicate, unknown) so the SA can repair its call.
//
// Other (non-SA) consumers — UI mutations — destructure the same
// shape and surface their own error UI.
//
// Each builder takes the resolved `Module` directly. Every call site already
// proves the UUID address and reads the module's sibling fields; passing `mod`
// straight in
// keeps the helper from re-running the same map lookup and lets the
// "module not found" defense live at the tool's call boundary
// (uniformly worded, in one place per tool).
//
// The array-walk primitives (`replaceByUuid` / `removeByUuid` /
// `reorderByUuid`) live in `tools/case-list-config/shared.ts` because
// they're pure generic utilities over `{ uuid: Uuid }[]` arrays —
// reusable by anything that walks a case-list-shaped array. The
// builders in this file produce admitted-writer `Mutation[]`, which is
// agent-specific.

/**
 * Success arm of a case-list-config mutation builder — the ready-to-record
 * `Mutation[]`. The list-append builders (`addColumnsMutation` /
 * `addSearchInputsMutation`) return ONLY this: a resolved `Module` can't
 * fail to append, so they carry no error arm and their callers need no
 * error branch.
 */
export interface CaseListMutationOk {
	ok: true;
	mutations: Mutation[];
}

/**
 * Tagged result of an addressed case-list-config mutation builder
 * (update / remove / reorder), which CAN fail on an unknown uuid. The
 * failure arm carries a single human-readable error string.
 */
export type CaseListMutationResult = CaseListMutationOk | { error: string };

/**
 * Append one or more columns to a module's case list, each as a granular
 * `addColumn` naming its predecessor in both surface sequences — so a
 * concurrent edit to a different column merges. There
 * is no separate single-column builder: the SA surface is the plural
 * `addCaseListColumns`, and one column is a length-1 array.
 *
 * Always succeeds — the input is the resolved `Module`, so module existence
 * is the caller's invariant.
 */
export function addColumnsMutation(
	mod: Module,
	columns: readonly Column[],
): CaseListMutationOk {
	const config = mod.caseListConfig;
	// Each column appends to BOTH surfaces, after whatever the previous one in
	// this same batch landed on. Threading the running tail is what makes a
	// multi-column add arrive in the order it was written rather than reversed.
	let listTail = config?.listColumnOrder.at(-1) ?? null;
	let detailTail = config?.detailColumnOrder.at(-1) ?? null;
	const mutations: Mutation[] = columns.map((column) => {
		const mutation = columnAddMutation(mod.uuid, column, {
			afterInList: listTail,
			afterInDetail: detailTail,
		});
		listTail = column.uuid;
		detailTail = column.uuid;
		return mutation;
	});
	return { ok: true, mutations };
}

/**
 * Replace one column on a module's case list, keyed by `columnUuid` — a
 * granular `updateColumn` plus any per-surface visibility deltas (the reducer
 * preserves both surface sequences and current visibility while replaying the
 * content replacement).
 *
 * Failure arm: columnUuid not in the module's columns array.
 */
export function updateColumnMutation(
	mod: Module,
	columnUuid: Uuid,
	replacement: Column,
): CaseListMutationResult {
	const op = replaceByUuid(
		mod.caseListConfig?.columns ?? [],
		columnUuid,
		replacement,
		"case list column",
	);
	if ("error" in op) return { error: op.error };
	const current = mod.caseListConfig?.columns.find(
		(column) => column.uuid === columnUuid,
	);
	if (!current) {
		return {
			error: `Tried to update case list column ${columnUuid}. Found no entry with that uuid in the module's case list. Look at getModule's projection or run searchBlueprint to surface the current uuids.`,
		};
	}
	const nextColumn = { ...replacement, uuid: columnUuid };
	const mutations: Mutation[] = [];
	if (!columnContentEqualIgnoringGranularSlots(current, nextColumn)) {
		mutations.push({
			kind: "updateColumn",
			moduleUuid: mod.uuid,
			uuid: columnUuid,
			column: columnContentSnapshot(nextColumn),
		});
	}
	mutations.push(...columnVisibilityMutations(current, nextColumn, mod.uuid));
	mutations.push(...columnSortMutations(current, nextColumn, mod.uuid));
	return {
		ok: true,
		mutations,
	};
}

/**
 * Drop one column from a module's case list, keyed by `columnUuid` — a
 * granular `removeColumn`.
 *
 * Failure arm: columnUuid not in the module's columns array.
 */
export function removeColumnMutation(
	mod: Module,
	columnUuid: Uuid,
): CaseListMutationResult {
	const op = removeByUuid(
		mod.caseListConfig?.columns ?? [],
		columnUuid,
		"case list column",
	);
	if ("error" in op) return { error: op.error };
	return {
		ok: true,
		mutations: [
			{ kind: "removeColumn", moduleUuid: mod.uuid, uuid: columnUuid },
		],
	};
}

/**
 * Reorder the visible fields on ONE user-facing case screen. Results and
 * Details are independent compositions, so this changes only the selected
 * surface sequence and leaves the other screen untouched.
 *
 * Failure arms: length mismatch, duplicate uuid, unknown uuid in the request.
 */
export function reorderColumnsMutation(
	mod: Module,
	order: readonly Uuid[],
	surface: "list" | "detail",
): CaseListMutationResult {
	const columns = mod.caseListConfig?.columns ?? [];
	const visible = columns.filter((column) =>
		surface === "list"
			? column.visibleInList !== false
			: column.visibleInDetail !== false,
	);
	const op = reorderByUuid(
		visible,
		order,
		`${surface === "list" ? "Results" : "Details"} field`,
	);
	if ("error" in op) return { error: op.error };
	// The request names the VISIBLE columns only, so the target sequence is the
	// current one with those repositioned — a hidden column keeps its place
	// rather than being shoved to the end by a reorder that never mentioned it.
	const current =
		surface === "list"
			? (mod.caseListConfig?.listColumnOrder ?? [])
			: (mod.caseListConfig?.detailColumnOrder ?? []);
	const requested = [...order];
	const target = current.map((uuid) =>
		visible.some((column) => column.uuid === uuid)
			? (requested.shift() ?? uuid)
			: uuid,
	);
	const mutations: Mutation[] = sequenceMovesTo(current, target).map((move) => {
		return {
			kind: "moveColumn",
			moduleUuid: mod.uuid,
			uuid: move.uuid,
			surface,
			after: move.after,
		} satisfies Mutation;
	});
	return {
		ok: true,
		mutations,
	};
}

/** Search-input parallel of `addColumnsMutation` — one granular
 *  `addSearchInput` per input, each appending (no anchor). */
export function addSearchInputsMutation(
	mod: Module,
	searchInputs: readonly SearchInputDef[],
): CaseListMutationOk {
	// Each add appends, so emitting them in order lands them in order.
	const mutations: Mutation[] = searchInputs.map((searchInput) => ({
		kind: "addSearchInput",
		moduleUuid: mod.uuid,
		searchInput,
	}));
	if (
		mod.caseSearchConfig === undefined ||
		isOwnerOnlyCaseSearchConfig(mod.caseSearchConfig)
	) {
		mutations.unshift(enableCaseSearchMutation(mod.uuid, mod.caseSearchConfig));
	}
	return { ok: true, mutations };
}

/** Search-input parallel of `updateColumnMutation`. */
export function updateSearchInputMutation(
	mod: Module,
	searchInputUuid: Uuid,
	replacement: SearchInputDef,
): CaseListMutationResult {
	const op = replaceByUuid(
		mod.caseListConfig?.searchInputs ?? [],
		searchInputUuid,
		replacement,
		"search input",
	);
	if ("error" in op) return { error: op.error };
	const current = mod.caseListConfig?.searchInputs.find(
		(input) => input.uuid === searchInputUuid,
	);
	if (current === undefined) {
		return { error: `Search input ${searchInputUuid} no longer exists.` };
	}
	return {
		ok: true,
		mutations: [planSearchInputUpdate(mod.uuid, current, replacement)],
	};
}

/** Search-input parallel of `removeColumnMutation`. */
export function removeSearchInputMutation(
	mod: Module,
	searchInputUuid: Uuid,
): CaseListMutationResult {
	const op = removeByUuid(
		mod.caseListConfig?.searchInputs ?? [],
		searchInputUuid,
		"search input",
	);
	if ("error" in op) return { error: op.error };
	const removesFinalInput = op.items.length === 0;
	return {
		ok: true,
		mutations: [
			{
				kind: "removeSearchInput",
				moduleUuid: mod.uuid,
				uuid: searchInputUuid,
			},
			...(removesFinalInput && mod.caseSearchConfig !== undefined
				? ([
						cleanupCaseSearchAfterFinalInputMutation({
							uuid: mod.uuid,
							config: mod.caseSearchConfig,
							hasCasesAvailableCondition:
								effectiveFilterForEmission(mod.caseListConfig?.filter) !==
								undefined,
						}),
					] satisfies Mutation[])
				: []),
		],
	};
}

/** Search-input parallel of `reorderColumnsMutation`. */
export function reorderSearchInputsMutation(
	mod: Module,
	order: readonly Uuid[],
): CaseListMutationResult {
	const op = reorderByUuid(
		mod.caseListConfig?.searchInputs ?? [],
		order,
		"search input",
	);
	if ("error" in op) return { error: op.error };
	// `reorderByUuid` has already proven the request is a permutation of the
	// current inputs, so the requested sequence IS the target.
	const current = (mod.caseListConfig?.searchInputs ?? []).map((i) => i.uuid);
	return {
		ok: true,
		mutations: sequenceMovesTo(current, order).map((move) => ({
			kind: "moveSearchInput",
			moduleUuid: mod.uuid,
			uuid: move.uuid,
			after: move.after,
		})),
	};
}

// ── Mutation builders — forms ───────────────────────────────────────────

/** Input shape for a new form. `uuid` may be supplied (e.g. during
 *  scaffold) to pin identity; otherwise the helper mints one. */
export interface NewFormInput {
	uuid?: string;
	id?: string;
	name: string;
	type: FormType;
	purpose?: string;
	closeCondition?: Form["closeCondition"];
	postSubmit?: PostSubmitDestination;
	entry?: Form["entry"];
}

/** Build an `addForm` mutation. Mints a uuid when the caller doesn't
 *  supply one. Forms are keyed under their owning module via the
 *  `moduleUuid` argument — the reducer refuses to install a form whose
 *  module isn't registered. `moduleAddedInBatch` skips the existence
 *  check for a module an earlier mutation in the SAME batch creates
 *  (`createModule`'s atomic module + forms + fields shape) — the caller
 *  owns the uuid in that case, so an unknown-module guard would only
 *  reject a module that is about to exist. */
export function addFormMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	input: NewFormInput,
	opts?: { moduleAddedInBatch?: boolean },
): Mutation[] {
	if (!opts?.moduleAddedInBatch && doc.modules[moduleUuid] === undefined) {
		return [];
	}
	const uuid = asUuid(
		typeof input.uuid === "string" && input.uuid.length > 0
			? input.uuid
			: crypto.randomUUID(),
	);
	const form: Form = {
		uuid,
		// Forms carry a semantic id alongside name, mirroring modules.
		id: input.id ?? slugifyFormId(input.name),
		name: input.name,
		type: input.type,
		...(input.purpose !== undefined && { purpose: input.purpose }),
		...(input.closeCondition !== undefined && {
			closeCondition: input.closeCondition,
		}),
		...(input.postSubmit !== undefined && { postSubmit: input.postSubmit }),
		...(input.entry !== undefined && { entry: input.entry }),
	};
	return [
		// The form appends; `moveForm` is how the SA reorders one.
		{ kind: "addForm", moduleUuid, form },
	];
}

/** Remove a form (cascades field subtree via the reducer). No-op when
 *  the uuid isn't present in the current doc. */
export function removeFormMutations(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Mutation[] {
	if (doc.forms[formUuid] === undefined) return [];
	return [{ kind: "removeForm", uuid: formUuid }];
}

/**
 * Patch non-Connect form-level fields. Nullable fields (`closeCondition`,
 * `postSubmit`) follow a convention: passing `null` clears the field (the
 * reducer stores `undefined`), passing an object replaces it, and omitting
 * the key leaves it untouched. Connect participation is deliberately absent;
 * the app-wide target planner owns membership.
 */
export function updateFormMutations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	patch: Partial<{
		name: string;
		type: FormType;
		closeCondition: Form["closeCondition"] | null;
		postSubmit: PostSubmitDestination | null;
		purpose: string | null;
	}>,
): Mutation[] {
	if (doc.forms[formUuid] === undefined) return [];
	const mutations: Mutation[] = [];
	if (patch.name !== undefined) {
		mutations.push({ kind: "renameForm", uuid: formUuid, newId: patch.name });
	}
	const reducerPatch: Extract<Mutation, { kind: "updateForm" }>["patch"] = {};
	if (patch.type !== undefined) reducerPatch.type = patch.type;
	if (patch.closeCondition !== undefined) {
		reducerPatch.closeCondition =
			patch.closeCondition === null ? null : patch.closeCondition;
	}
	if (patch.postSubmit !== undefined) {
		reducerPatch.postSubmit =
			patch.postSubmit === null ? null : patch.postSubmit;
	}
	if (patch.purpose !== undefined) {
		reducerPatch.purpose = patch.purpose === null ? null : patch.purpose;
	}
	if (Object.keys(reducerPatch).length > 0) {
		mutations.push({ kind: "updateForm", uuid: formUuid, patch: reducerPatch });
	}
	return mutations;
}

/**
 * Refine the complete Connect configuration of an existing participant.
 * This named helper cannot create or remove participation: a form without a
 * live block, or a nullish runtime value from an untyped caller, is refused
 * with an empty plan. App-wide membership transitions use
 * `planConnectTargetState` instead.
 */
export function refineFormConnectMutations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	connect: ConnectConfig,
): Mutation[] {
	if (doc.forms[formUuid]?.connect === undefined || connect == null) return [];
	return [{ kind: "updateForm", uuid: formUuid, patch: { connect } }];
}

// ── Mutation builders — fields ──────────────────────────────────────────

/** Build an `addField` mutation from the canonical domain entity. */
export function addFieldMutations(
	doc: BlueprintDoc,
	input: {
		parentUuid: Uuid;
		field: Field;
		index?: number;
	},
): Mutation[] {
	// Parent must be a form or an existing container field.
	const parentForm = doc.forms[input.parentUuid];
	const parentField = doc.fields[input.parentUuid];
	const parentExists =
		parentForm !== undefined ||
		(parentField !== undefined && isContainer(parentField));
	if (!parentExists) return [];
	// The SA speaks display indexes; a mutation carries the sibling it follows,
	// so the index resolves HERE, against the live document, and the durable
	// event names a place a peer's concurrent insert cannot shift.
	const after = anchorForIndex(
		doc.fieldOrder[input.parentUuid] ?? [],
		input.index,
	);
	return [
		{
			kind: "addField",
			parentUuid: input.parentUuid,
			field: structuredClone(input.field),
			...(after !== undefined && { after }),
		},
	];
}

/** Remove a field (cascades children via the reducer). */
export function removeFieldMutations(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): Mutation[] {
	if (doc.fields[fieldUuid] === undefined) return [];
	return [{ kind: "removeField", uuid: fieldUuid }];
}

/** Patch arbitrary fields on a field entity. The `Field` union is
 *  discriminated by `kind`; the helper takes the target kind as an
 *  explicit generic so the patch type narrows to that variant's
 *  partial shape. A patch with a key the kind doesn't carry is a
 *  compile error at the call site. The reducer also parses the
 *  merged shape against `fieldSchema` to catch bad value types on
 *  legitimate keys. */
export function updateFieldMutations<K extends FieldKind>(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	targetKind: K,
	patch: FieldPatchFor<K>,
): Mutation[] {
	if (doc.fields[fieldUuid] === undefined) return [];
	// The mutation literal's structural shape matches the per-kind
	// `updateField` arm, but the generic `K` doesn't widen back to a
	// concrete arm of the discriminated union — cast through `Mutation`
	// to align the shape with the union at the value level.
	return [
		{ kind: "updateField", uuid: fieldUuid, targetKind, patch } as Mutation,
	];
}

// ── Private helpers ─────────────────────────────────────────────────────

/** Derive a module's wire id from its display name.
 *
 *  DISPLAY ONLY. Nothing addresses a module or a form by this slug any more —
 *  the case-operation tools were the last consumer and now take uuids — so it
 *  is not unique, is not maintained through a rename, and must not become a
 *  key again. The slug rule lives in `lib/domain/idSlug.ts`. */
function slugifyModuleId(name: string): string {
	return slugifyId(name, "module");
}

/** Derive a form's wire id from its display name. Same rule and the same
 *  display-only status as the module wire id. */
function slugifyFormId(name: string): string {
	return slugifyId(name, "form");
}

// ── Re-exports for consumers that need type-level narrowing ─────────────

export type { FieldKind };
export { fieldKinds };
