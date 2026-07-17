/**
 * blueprintHelpers — SA-only pure helpers over `BlueprintDoc`.
 *
 * Two surfaces:
 *
 *   - Positional lookups the SA's tool handlers use to resolve a
 *     `(moduleIndex, formIndex, fieldRef)` triple to a `{ field, path, formUuid }`
 *     record: `findFieldByBareId`, `resolveFieldTarget`.
 *   - Mutation builders that return `Mutation[]` for the caller to apply
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

import {
	columnContentEqualIgnoringGranularSlots,
	columnVisibilityMutations,
} from "@/lib/doc/caseListColumnMutations";
import { normalizeConnectConfig } from "@/lib/doc/connectConfig";
import {
	buildFieldTree,
	type FieldWithChildren,
	orderedFieldUuids,
	orderedFormUuids,
	orderedModuleUuids,
} from "@/lib/doc/fieldWalk";
import {
	computeFieldPath,
	findContainingForm,
} from "@/lib/doc/mutations/helpers";
import { sequenceOrderKeys, sortedOrderKeys } from "@/lib/doc/order/append";
import {
	type ColumnSurface,
	resolvedColumnSurfaceOrder,
} from "@/lib/doc/order/columnSurface";
import {
	byDetailColumnOrder,
	byListColumnOrder,
} from "@/lib/doc/order/compare";
import { keysBetween } from "@/lib/doc/order/keys";
import {
	formOrderKeyAtIndex,
	moduleOrderKeyAtIndex,
} from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import type {
	AssetId,
	BlueprintDoc,
	Column,
	ConnectConfig,
	Field,
	FieldKind,
	FieldPatchFor,
	Form,
	FormType,
	Media,
	Module,
	PostSubmitDestination,
	SearchInputDef,
	Uuid,
} from "@/lib/domain";
import {
	asUuid,
	caseSearchConfigHasAuthoredSettings,
	fieldKinds,
	isContainer,
	slugifyId,
} from "@/lib/domain";
import { effectiveFilterForEmission } from "@/lib/domain/predicate";
import {
	removeByUuid,
	reorderByUuid,
	replaceByUuid,
} from "./tools/case-list-config/shared";

// ── Positional lookup helpers ───────────────────────────────────────────

/**
 * Every field in a form's subtree, in display order, each with its full
 * slash path. The DFS records the current path prefix alongside each
 * uuid so the returned `path` matches the order of traversal (visual
 * order of the form).
 */
function walkFormFields(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Array<{ field: Field; path: string }> {
	const out: Array<{ field: Field; path: string }> = [];
	const stack: Array<{ uuid: Uuid; prefix: string }> = [];
	const topOrder = orderedFieldUuids(doc, formUuid);
	// Push in reverse so iteration order matches visual (sorted) form order.
	for (let i = topOrder.length - 1; i >= 0; i--) {
		stack.push({ uuid: topOrder[i], prefix: "" });
	}
	while (stack.length > 0) {
		const next = stack.pop();
		if (!next) break;
		const { uuid, prefix } = next;
		const field = doc.fields[uuid];
		if (!field) continue;
		const path = prefix ? `${prefix}/${field.id}` : field.id;
		out.push({ field, path });
		// Only container kinds have children in the order map.
		if (isContainer(field)) {
			const children = orderedFieldUuids(doc, uuid);
			for (let i = children.length - 1; i >= 0; i--) {
				stack.push({ uuid: children[i], prefix: path });
			}
		}
	}
	return out;
}

/** Resolve a field by bare id within a form (first match, depth-first).
 *  Every SA-boundary lookup resolves through `resolveFieldTarget` /
 *  `resolveFieldInForm` instead — those refuse an ambiguous bare id
 *  rather than silently taking the first match. */
export function findFieldByBareId(
	doc: BlueprintDoc,
	formUuid: Uuid,
	bareId: string,
): { field: Field; path: string } | undefined {
	return walkFormFields(doc, formUuid).find(
		(entry) => entry.field.id === bareId,
	);
}

/** Render a form's addressable location for an error message — its name
 *  plus the positional (module, form) indices the SA's tools take. */
function describeFormLocation(
	doc: BlueprintDoc,
	formUuid: Uuid,
): string | undefined {
	const moduleUuids = orderedModuleUuids(doc);
	for (let mi = 0; mi < moduleUuids.length; mi++) {
		const fi = orderedFormUuids(doc, moduleUuids[mi]).indexOf(formUuid);
		if (fi !== -1) {
			return `"${doc.forms[formUuid]?.name ?? formUuid}" (m${mi}-f${fi})`;
		}
	}
	return undefined;
}

/**
 * The one-line contract for every SA slot that resolves through
 * `resolveFieldTarget` / `resolveFieldInForm` — composed into each tool
 * schema's `describe` so the addressing contract is stated once and the
 * six field-addressing tools can't drift apart in wording.
 */
export const FIELD_REF_HINT =
	"its id, or its uuid when duplicate ids make the bare id ambiguous";

/**
 * Tagged result of `resolveFieldTarget` / `resolveFieldInForm`. The
 * failure arm carries a ready-to-forward Elm-style message so every
 * field-addressing tool reports misses, ambiguity, and wrong-form uuids
 * identically, plus a `reason` discriminant for the one caller (the
 * batch assembly's parent lookups) whose handling differs by arm.
 */
export type FieldTargetResolution =
	| { ok: true; field: Field; path: string; formUuid: Uuid }
	| {
			ok: false;
			reason: "form_missing" | "not_found" | "ambiguous" | "wrong_form";
			error: string;
	  };

/**
 * Form-scoped resolution core: a field ref against a known form uuid.
 * `fieldRef` is a field's bare id OR its uuid — sibling-uniqueness is
 * per parent level, so one form can legally hold two fields with the
 * same bare id in different groups, and the uuid is the unambiguous
 * handle the read tools already surface. Resolution order:
 *
 *   1. A ref matching a field uuid resolves to that field — rejected
 *      with its actual location when it lives in a different form (a
 *      silent cross-form edit would hit an entity the SA can't see at
 *      this address). Uuids are `crypto.randomUUID()`-minted, so a bare
 *      id shadowing another field's uuid is not a practical collision.
 *   2. Otherwise the ref is a bare id: exactly one depth-first match
 *      resolves; zero is a miss; two or more is REFUSED with every
 *      match's path + uuid, so the SA re-targets instead of silently
 *      editing the first match.
 */
export function resolveFieldInForm(
	doc: BlueprintDoc,
	formUuid: Uuid,
	fieldRef: string,
): FieldTargetResolution {
	const here = describeFormLocation(doc, formUuid) ?? `form ${formUuid}`;
	// The uuid probe must be an OWN-key check: `doc.fields` is a plain
	// prototype-bearing record, so a bare id that collides with an
	// inherited Object.prototype key ("constructor", "toString", …)
	// would otherwise take this branch and make the field permanently
	// unaddressable by its id.
	const byUuid = Object.hasOwn(doc.fields, fieldRef)
		? doc.fields[asUuid(fieldRef)]
		: undefined;
	if (byUuid) {
		const homeFormUuid = findContainingForm(doc, byUuid.uuid);
		if (homeFormUuid === formUuid) {
			return {
				ok: true,
				field: byUuid,
				path: computeFieldPath(doc, byUuid.uuid) ?? byUuid.id,
				formUuid,
			};
		}
		const home = homeFormUuid
			? describeFormLocation(doc, homeFormUuid)
			: undefined;
		return {
			ok: false,
			reason: "wrong_form",
			error: home
				? `Field "${byUuid.id}" (uuid ${fieldRef}) is not in ${here} — it lives in ${home}. Re-issue against that form.`
				: `Field "${byUuid.id}" (uuid ${fieldRef}) isn't attached to any form`,
		};
	}
	const matches = walkFormFields(doc, formUuid).filter(
		(entry) => entry.field.id === fieldRef,
	);
	if (matches.length === 1) {
		return {
			ok: true,
			field: matches[0].field,
			path: matches[0].path,
			formUuid,
		};
	}
	if (matches.length === 0) {
		return {
			ok: false,
			reason: "not_found",
			error: `Field "${fieldRef}" not found in ${here}`,
		};
	}
	return {
		ok: false,
		reason: "ambiguous",
		error: `Field id "${fieldRef}" is ambiguous in ${here} — ${matches.length} fields share it: ${matches
			.map((m) => `"${m.path}" (uuid ${m.field.uuid})`)
			.join(", ")}. Re-issue with the uuid of the one you mean.`,
	};
}

/**
 * Resolve the SA's `(moduleIndex, formIndex, fieldRef)` triple to a
 * `{ field, path, formUuid }` record — the positional wrapper over
 * `resolveFieldInForm` every field-addressing tool goes through.
 */
export function resolveFieldTarget(
	doc: BlueprintDoc,
	moduleIndex: number,
	formIndex: number,
	fieldRef: string,
): FieldTargetResolution {
	const formUuid = resolveFormUuid(doc, moduleIndex, formIndex);
	if (!formUuid) {
		return {
			ok: false,
			reason: "form_missing",
			error: `Form m${moduleIndex}-f${formIndex} not found`,
		};
	}
	return resolveFieldInForm(doc, formUuid, fieldRef);
}

/**
 * Map a `(moduleIndex, formIndex)` pair to the doc's form uuid. Returns
 * `undefined` when either index is out of range — tool bodies surface
 * that as an error string to the SA.
 *
 * The lighter cousin of `resolveFieldTarget`: callers that don't need a
 * field lookup (per-form reads, structural edits) use this to skip the
 * DFS walk over the form's field subtree.
 */
export function resolveFormUuid(
	doc: BlueprintDoc,
	moduleIndex: number,
	formIndex: number,
): Uuid | undefined {
	const moduleUuid = orderedModuleUuids(doc)[moduleIndex];
	if (!moduleUuid) return undefined;
	return orderedFormUuids(doc, moduleUuid)[formIndex];
}

/**
 * Map a `moduleIndex` to the doc's module uuid in DISPLAY order
 * (`sort-by-(order, uuid)`) — the SAME sequence the SA reads from
 * `summarizeBlueprint` / `get_app` / `searchBlueprint`, so "module N"
 * addresses the entity the SA sees at position N, not the `moduleOrder`
 * array slot (which a same-parent reorder leaves untouched). Returns
 * `undefined` when the index is out of range; tool bodies surface that as
 * an error string. Every module-addressing tool resolves through this (or
 * `resolveFormUuid` / `resolveFormContext`, which sort the same way) — a
 * raw `doc.moduleOrder[moduleIndex]` in a tool body is a defect.
 */
export function resolveModuleUuid(
	doc: BlueprintDoc,
	moduleIndex: number,
): Uuid | undefined {
	return orderedModuleUuids(doc)[moduleIndex];
}

/**
 * The four handles shared tool modules need when resolving a positional
 * `(moduleIndex, formIndex)` triple: the `moduleUuid` / `formUuid` for
 * mutation emission and index → uuid resolution, plus the `mod` / `form`
 * entities for the `form.type` + `mod.caseType` signals downstream
 * helpers (e.g. `applyDefaults`) consume.
 */
export interface FormContext {
	moduleUuid: Uuid;
	mod: Module;
	formUuid: Uuid;
	form: Form;
}

/**
 * Resolve the module + form entities for a positional
 * `(moduleIndex, formIndex)` triple. Returns `undefined` when either
 * index is out of range — callers map that to a tool-specific error
 * string, so the message wording stays at the call site and the SA
 * keeps its existing voice.
 *
 * Use this instead of `resolveFormUuid` when the tool body also needs
 * the resolved `mod` / `form` entities (e.g. `form.type` for preload
 * auto-defaults, `mod.caseType` for case-type lookup). The shared add-
 * path pipeline in `contentProcessing.applyDefaults` consumes both.
 */
export function resolveFormContext(
	doc: BlueprintDoc,
	moduleIndex: number,
	formIndex: number,
): FormContext | undefined {
	const moduleUuid = orderedModuleUuids(doc)[moduleIndex];
	if (!moduleUuid) return undefined;
	const mod = doc.modules[moduleUuid];
	if (!mod) return undefined;
	const formUuid = orderedFormUuids(doc, moduleUuid)[formIndex];
	if (!formUuid) return undefined;
	const form = doc.forms[formUuid];
	if (!form) return undefined;
	return { moduleUuid, mod, formUuid, form };
}

// ── Form-tree snapshot ──────────────────────────────────────────────────

/**
 * Shape returned by `formSnapshot` — the form entity augmented with its
 * ordered, nested field tree. Uses the domain `Form` type verbatim so
 * downstream consumers (SA `getForm` tool, MCP adapter) read domain
 * names (`closeCondition`, `postSubmit`, `formLinks`) and don't carry
 * any CommCare wire-format translation.
 *
 * Lives alongside the positional lookup helpers because it's a
 * `BlueprintDoc`-read derived shape — the same category of surface.
 */
export type FormSnapshot = Form & { fields: FieldWithChildren[] };

/**
 * Build a `FormSnapshot` for the given form uuid. Returns `undefined`
 * when the form doesn't exist in the doc — callers surface that as a
 * "form not found" error to the SA.
 */
export function formSnapshot(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormSnapshot | undefined {
	const form = doc.forms[formUuid];
	if (!form) return undefined;
	// The SA speaks field ids; the stored close-condition ref is the
	// field's stable uuid — project it back (a dangler shows its text).
	const closeCondition = form.closeCondition
		? {
				...form.closeCondition,
				field: asUuid(
					doc.fields[form.closeCondition.field]?.id ??
						form.closeCondition.field,
				),
			}
		: undefined;
	return {
		...form,
		...(closeCondition !== undefined && { closeCondition }),
		fields: buildFieldTree(doc, formUuid),
	};
}

// ── Mutation builders — modules ─────────────────────────────────────────

/** Input shape for a new module. `uuid` may be supplied to pin identity
 *  (`createModule` pre-mints the uuid its later batch entries
 *  reference), otherwise the helper mints one. */
export interface NewModuleInput {
	uuid?: string;
	id?: string;
	name: string;
	caseType?: string;
	caseListOnly?: boolean;
	purpose?: string;
	caseListConfig?: Module["caseListConfig"];
}

/** Build an `addModule` mutation. Mints a uuid when the caller doesn't
 *  supply one — mirrors the producer-side stamp pattern established by
 *  `addField` in the reducer. Accepts an optional `index` for ordered
 *  insertion; omit to append at the end. */
export function addModuleMutations(
	doc: BlueprintDoc,
	input: NewModuleInput,
	opts?: { index?: number },
): Mutation[] {
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
		// A born module needs an `order` key at the requested slot (append when
		// none) — same key the builder's `moduleOrderKeyAtIndex` mints — or an
		// order-less SA module sorts ahead of every keyed sibling until a
		// reload's backfill.
		order: moduleOrderKeyAtIndex(doc, opts?.index),
		...(input.caseType !== undefined && { caseType: input.caseType }),
		...(input.caseListOnly !== undefined && {
			caseListOnly: input.caseListOnly,
		}),
		...(input.purpose !== undefined && { purpose: input.purpose }),
		...(input.caseListConfig !== undefined && {
			caseListConfig: input.caseListConfig,
		}),
	};
	return [
		{
			kind: "addModule",
			module,
			...(opts?.index !== undefined && { index: opts.index }),
		},
	];
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
	patch: Partial<Omit<Module, "uuid">>,
): Mutation[] {
	return [{ kind: "updateModule", uuid: mod.uuid, patch }];
}

/**
 * Set or clear the blueprint-root `logo` (the app-level login/home-screen
 * image). The app has no other app-level setter — this is the only writer
 * for `doc.logo`. Passing an asset id sets it; passing `null` clears it.
 * The `setAppLogo` reducer maps `null → undefined` so the cleared key
 * drops off the doc rather than persisting as a literal `null`. */
export function setAppLogoMutations(logo: AssetId | null): Mutation[] {
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
	icon: AssetId | null,
	audioLabel: AssetId | null,
): Mutation[] {
	return [{ kind: "setModuleMedia", uuid: moduleUuid, icon, audioLabel }];
}

/**
 * Set or clear a form's menu media (tile `icon` + `audioLabel`). Mirrors
 * `setModuleMediaMutations` one level down — dedicated `setFormMedia`
 * mutation so a clear survives the SSE wire as an explicit `null`. */
export function setFormMediaMutations(
	formUuid: Uuid,
	icon: AssetId | null,
	audioLabel: AssetId | null,
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
// Each builder takes the resolved `Module` directly. Every call site
// already looks the module up out of the doc to map a `moduleIndex`
// to a uuid and to read its sibling fields; passing `mod` straight in
// keeps the helper from re-running the same map lookup and lets the
// "module not found" defense live at the tool's call boundary
// (uniformly worded, in one place per tool).
//
// The array-walk primitives (`replaceByUuid` / `removeByUuid` /
// `reorderByUuid`) live in `tools/case-list-config/shared.ts` because
// they're pure generic utilities over `{ uuid: Uuid }[]` arrays —
// reusable by anything that walks a case-list-shaped array. The
// builders in this file produce `Mutation[]` for the saga, which is
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
 * `addColumn` carrying a fresh fractional `order` placed after the last
 * existing column — so a concurrent edit to a different column merges. There
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
	const existing = mod.caseListConfig?.columns ?? [];
	const keys = sortedOrderKeys(existing);
	const listKeys = [...existing]
		.sort(byListColumnOrder)
		.map((column) => resolvedColumnSurfaceOrder(column, "list"))
		.filter((order): order is string => order !== undefined);
	const detailKeys = [...existing]
		.sort(byDetailColumnOrder)
		.map((column) => resolvedColumnSurfaceOrder(column, "detail"))
		.filter((order): order is string => order !== undefined);
	// One ascending run of fractional keys after the last existing column
	// (`hi = null` ≡ a clean append), minted in one call by the shared
	// `keysBetween` primitive rather than a hand-rolled place-after chain.
	const orders = keysBetween(keys.at(-1) ?? null, null, columns.length);
	const listOrders = keysBetween(listKeys.at(-1) ?? null, null, columns.length);
	const detailOrders = keysBetween(
		detailKeys.at(-1) ?? null,
		null,
		columns.length,
	);
	const mutations: Mutation[] = columns.map((column, i) => ({
		kind: "addColumn",
		moduleUuid: mod.uuid,
		column: {
			...column,
			order: orders[i],
			listOrder: listOrders[i],
			detailOrder: detailOrders[i],
		},
	}));
	return { ok: true, mutations };
}

/**
 * Replace one column on a module's case list, keyed by `columnUuid` — a
 * granular `updateColumn` plus any per-surface visibility deltas (the reducer
 * preserves the column's current order + visibility slots while replaying the
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
			column: nextColumn,
			preserveVisibility: true,
		});
	}
	mutations.push(...columnVisibilityMutations(current, nextColumn, mod.uuid));
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
 * surface key and leaves generic/legacy order plus the other screen untouched.
 *
 * Failure arms: length mismatch, duplicate uuid, unknown uuid in the request.
 */
export function reorderColumnsMutation(
	mod: Module,
	order: readonly Uuid[],
	surface: ColumnSurface,
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
	const keys = sequenceOrderKeys(order.length);
	const mutations: Mutation[] = order.map((uuid, i) =>
		surface === "list"
			? {
					kind: "moveColumnInList" as const,
					moduleUuid: mod.uuid,
					uuid,
					order: keys[i],
				}
			: {
					kind: "moveColumnInDetail" as const,
					moduleUuid: mod.uuid,
					uuid,
					order: keys[i],
				},
	);
	return {
		ok: true,
		mutations,
	};
}

/** Search-input parallel of `addColumnsMutation` — one granular
 *  `addSearchInput` per input, each carrying a fresh append `order`. */
export function addSearchInputsMutation(
	mod: Module,
	searchInputs: readonly SearchInputDef[],
): CaseListMutationOk {
	const keys = sortedOrderKeys(mod.caseListConfig?.searchInputs ?? []);
	// One ascending run after the last existing input (`hi = null` ≡ append) —
	// the same `keysBetween` primitive `addColumnsMutation` uses.
	const orders = keysBetween(keys.at(-1) ?? null, null, searchInputs.length);
	const mutations: Mutation[] = searchInputs.map((searchInput, i) => ({
		kind: "addSearchInput",
		moduleUuid: mod.uuid,
		searchInput: { ...searchInput, order: orders[i] },
	}));
	if (mod.caseSearchConfig === undefined) {
		mutations.unshift({
			kind: "setCaseSearchMarker",
			uuid: mod.uuid,
			enabled: true,
		});
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
	return {
		ok: true,
		mutations: [
			{
				kind: "updateSearchInput",
				moduleUuid: mod.uuid,
				uuid: searchInputUuid,
				searchInput: { ...replacement, uuid: searchInputUuid },
			},
		],
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
	const removesLastSearchableInput =
		op.items.length === 0 &&
		mod.caseSearchConfig !== undefined &&
		!caseSearchConfigHasAuthoredSettings(mod.caseSearchConfig) &&
		effectiveFilterForEmission(mod.caseListConfig?.filter) === undefined;
	return {
		ok: true,
		mutations: [
			{
				kind: "removeSearchInput",
				moduleUuid: mod.uuid,
				uuid: searchInputUuid,
			},
			...(removesLastSearchableInput
				? ([
						{
							kind: "setCaseSearchMarker",
							uuid: mod.uuid,
							enabled: false,
						},
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
	const keys = sequenceOrderKeys(order.length);
	return {
		ok: true,
		mutations: order.map((uuid, i) => ({
			kind: "moveSearchInput",
			moduleUuid: mod.uuid,
			uuid,
			order: keys[i],
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
	connect?: ConnectConfig | null;
	postSubmit?: PostSubmitDestination;
	/** Explicit `order` key — supplied by a caller adding SEVERAL forms to a
	 *  module in ONE batch (`createModule`), which pre-mints a sequential run
	 *  since none of the sibling forms is in `doc` yet. Omitted for a single
	 *  `addForm`, where the key is derived from the module's existing forms. */
	order?: string;
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
	opts?: { index?: number; moduleAddedInBatch?: boolean },
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
		// A born form needs an `order` key: an explicit one from a batch that
		// pre-minted a sequential run (`createModule`), else derived at the
		// requested slot (append) from the module's existing forms — same key
		// the builder's `formOrderKeyAtIndex` mints.
		order: input.order ?? formOrderKeyAtIndex(doc, moduleUuid, opts?.index),
		...(input.purpose !== undefined && { purpose: input.purpose }),
		...(input.closeCondition !== undefined && {
			closeCondition: input.closeCondition,
		}),
		...(input.connect != null && {
			// `normalizeConnectConfig` strips empty sub-configs. A returned
			// `undefined` means "every sub-config was empty" — which for
			// `addForm` means "don't stamp connect at all".
			connect: normalizeConnectConfig(input.connect),
		}),
		...(input.postSubmit !== undefined && { postSubmit: input.postSubmit }),
	};
	return [
		{
			kind: "addForm",
			moduleUuid,
			form,
			...(opts?.index !== undefined && { index: opts.index }),
		},
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
 * Patch form-level fields. Nullable fields (`closeCondition`, `connect`,
 * `postSubmit`) follow a convention: passing `null` clears the field
 * (the reducer stores `undefined`), passing an object replaces it, and
 * omitting the key leaves it untouched.
 *
 * `connect` additionally runs through `normalizeConnectConfig` so an
 * empty / all-empty connect config is stripped — it lands as absent
 * rather than as an empty `{ connect: {} }` marker.
 */
export function updateFormMutations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	patch: Partial<{
		name: string;
		type: FormType;
		closeCondition: Form["closeCondition"] | null;
		connect: ConnectConfig | null;
		postSubmit: PostSubmitDestination | null;
		purpose: string | null;
	}>,
): Mutation[] {
	if (doc.forms[formUuid] === undefined) return [];
	const reducerPatch: Partial<Omit<Form, "uuid">> = {};
	if (patch.name !== undefined) reducerPatch.name = patch.name;
	if (patch.type !== undefined) reducerPatch.type = patch.type;
	if (patch.closeCondition !== undefined) {
		// `null` → clear (reducer treats `undefined` as "remove" via
		// Object.assign — not perfect, but Immer's Object.assign with an
		// explicit `undefined` clears the key in strict mode).
		reducerPatch.closeCondition =
			patch.closeCondition === null ? undefined : patch.closeCondition;
	}
	if (patch.connect !== undefined) {
		reducerPatch.connect =
			patch.connect === null
				? undefined
				: (normalizeConnectConfig(patch.connect) ?? undefined);
	}
	if (patch.postSubmit !== undefined) {
		reducerPatch.postSubmit =
			patch.postSubmit === null ? undefined : patch.postSubmit;
	}
	if (patch.purpose !== undefined) {
		reducerPatch.purpose = patch.purpose === null ? undefined : patch.purpose;
	}
	return [{ kind: "updateForm", uuid: formUuid, patch: reducerPatch }];
}

// ── Mutation builders — fields ──────────────────────────────────────────

/** Build an `addField` mutation. The caller supplies a full `Field`
 *  entity (with uuid); helpers that mint fields from SA wire format live
 *  elsewhere — this helper stays type-tight against the domain shape. */
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
	return [
		{
			kind: "addField",
			parentUuid: input.parentUuid,
			field: input.field,
			...(input.index !== undefined && { index: input.index }),
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

/** Rename a field's semantic id. The reducer rewrites XPath references
 *  to the old id across the entire doc atomically. */
export function renameFieldMutations(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	newId: string,
): Mutation[] {
	if (doc.fields[fieldUuid] === undefined) return [];
	return [{ kind: "renameField", uuid: fieldUuid, newId }];
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

/** Derive a module's semantic id slug from its display name. Keeps us from
 *  having to surface a separate slug input at every creation site. The slug
 *  rule itself lives in `lib/domain/idSlug.ts` so the SA and the builder's
 *  in-tree scaffolds derive ids identically. */
function slugifyModuleId(name: string): string {
	return slugifyId(name, "module");
}

/** Derive a form's semantic id slug from its display name. Same shared rule
 *  as the module slug, defaulting to "form" if sanitizing strips everything. */
function slugifyFormId(name: string): string {
	return slugifyId(name, "form");
}

// ── Re-exports for consumers that need type-level narrowing ─────────────

export type { FieldKind };
export { fieldKinds };
