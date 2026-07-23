/**
 * Diff two `BlueprintDoc`s into the minimal-enough `Mutation[]` whose
 * replay on the FIRST doc reproduces the SECOND. This is what backs
 * mutation-only persistence: the client diffs its working doc against the
 * doc it last saw, ships the diff, and the server replays it on the fresh
 * stored doc (`applyMutations`). The result is correct — not necessarily
 * globally minimal — and every emitted mutation is one the reducer applies
 * without throwing.
 *
 * MERGE SEMANTICS under concurrent edits (replay on a doc a co-member has
 * advanced): EVERY mutation is identity-keyed — a uuid (module/form/field/
 * column/search-input/option), a `(type, property)` name pair (catalog), or an
 * owning-entity uuid — and a reorder carries an absolute fractional `order`
 * key rather than an array position, so a co-member's edit to a DIFFERENT
 * entity / property / list item, or a reorder of DIFFERENT things, survives the
 * replay untouched. The only last-writer-wins residual is two members
 * replacing the SAME scalar slot (or the same property/type name) at the same
 * instant — deterministic by commit order. A concurrent DELETE of an entity
 * this diff targets is caught separately — the guarded commit's
 * `batchTargetsMissing` rejects it as a 409 rather than letting it silently
 * no-op.
 *
 * The emission order is dictated by the reducer's semantics, not by the
 * mutation union's declaration order:
 *
 *   1. App-level scalars (`setAppName` / `setConnectType` / `setAppLogo`).
 *      No entity side effects, so they can lead.
 *   2. Module + form ADDS — parent before child. Added entities are landed
 *      before the removes so an evacuation (next step) can move a survivor
 *      into a freshly-added module/form.
 *   3. EVACUATIONS — moves of surviving forms/fields OUT of a parent that
 *      is about to be removed. `removeModule` / `removeForm` / `removeField`
 *      cascade their subtrees, so a survivor still inside a doomed parent
 *      would be deleted by the cascade; it must move out first.
 *   4. Removes — TOP survivors only. A child whose parent is also removed
 *      gets no explicit remove; the parent's cascade took it.
 *   5. Field structural REST — field adds (parent-before-child), cross-parent
 *      moves, and same-parent reorders (each `moveField` carries the field's
 *      `order`), plus cross-module form moves + same-module reorders. A
 *      `moveField`'s sibling-id dedup may transiently suffix a moved field;
 *      step 7's `updateField` patch pins the id back.
 *   6. Module + form renames, then field converts (`convertField`).
 *   7. Updates — `updateModule` / `updateForm` / `updateField` patches of
 *      ONLY the changed keys (excluding `order`, `caseListConfig`,
 *      `caseSearchConfig`, `options`, and media, each diffed separately). A field's `id` rides its
 *      `updateField` patch, not `renameField`.
 *   8. Media — the dedicated clear-safe kinds (`setFieldMedia` /
 *      `setModuleMedia` / `setFormMedia`).
 *   9. Granular COLLECTIONS — case-list column / search-input / semantic
 *      `updateModule` case-list/Search operations / `setCaseListMeta` +
 *      select-option kinds, keyed by item uuid.
 *      Case-list birth is an idempotent ensure followed by granular contents;
 *      only an explicit whole-config removal uses
 *      `updateModule{caseListConfig:null}`.
 *  10. Module order — `moveModule{order}` for a module whose `order` changed.
 *  11. Catalog LAST — granular `declareCaseType` / `setCaseTypeMeta` /
 *      `addCaseProperty` / `setCaseProperty` / `removeCaseProperty` /
 *      `retireCaseType`, diffed against the catalog the field reducers'
 *      `ensureCatalogProperty` side effect leaves after the structural replay
 *      (so a property a writer add reproduces is never re-emitted, merging a
 *      concurrent add). No wholesale `setCaseTypes` is emitted on this path.
 *
 * `renameField` and `duplicateField` are never emitted: the former for its
 * cascade (id rides `updateField`), the latter because it mints a fresh
 * uuid and so can't express a diff between two fixed docs (an added field
 * travels as `addField` carrying the verbatim entity).
 *
 * The commit gate validates only the final candidate, so an intermediate
 * invalid state across the batch is fine; the one hard rule is that no
 * individual mutation may make the reducer throw.
 */

import { produce } from "immer";
import { addModuleMutation } from "@/lib/doc/addModuleMutation";
import {
	columnAddMutation,
	columnSnapshotMutations,
} from "@/lib/doc/caseListColumnMutations";
import {
	cleanupCaseSearchAfterFinalInputMutation,
	disableUnusedCaseSearchMutation,
	enableCaseSearchMutation,
	setOwnerOnlyCaseSearchMutation,
} from "@/lib/doc/caseSearchConfigMutations";
import {
	caseSearchConfigPatchMutations,
	clearCaseSearchConfigSettingsMutations,
} from "@/lib/doc/caseSearchConfigPatchMutations";
import {
	orderedFieldUuids,
	orderedFormUuids,
	orderedModuleUuids,
} from "@/lib/doc/fieldWalk";
import { applyMutations } from "@/lib/doc/mutations";
import { searchInputUpdateMutation } from "@/lib/doc/searchInputMutations";
import {
	type BlueprintDoc,
	FIELD_MEDIA_SLOTS,
	type Mutation,
	type Uuid,
} from "@/lib/doc/types";
import type {
	AssetId,
	CaseListConfig,
	CaseType,
	Column,
	Field,
	Form,
	Media,
	Module,
	SearchInputDef,
	SelectOption,
} from "@/lib/domain";
import {
	caseSearchConfigAfterFinalInputRemoval,
	caseSearchConfigHasAuthoredSettings,
} from "@/lib/domain";
import { effectiveFilterForEmission } from "@/lib/domain/predicate";

// ── Value comparison ─────────────────────────────────────────────────
//
// Structural deep-equality over the JSON-shaped values blueprint slots
// hold (scalars, arrays, plain objects, the AST objects in expression
// slots). No `Map` / `Set` / `Date` appear in a doc, so a recursive
// structural compare is exact.

/**
 * Deep-copy an entity / patch / media value before it enters a mutation
 * payload. The reducer stores some payloads BY REFERENCE — `addModule` /
 * `addForm` keep the passed entity, `updateModule` / `updateForm` assign
 * patch values onto the draft per key, and `setFieldMedia` writes
 * the media object directly. A later cascade (a case-property rename
 * rewriting a module config it shares structure with) then mutates that
 * object in place; if the object came verbatim from `next` — which is
 * frozen when `next` is itself an Immer product — the in-place write
 * throws. Cloning gives every payload its own writable copy, matching the
 * production wire path where a payload is JSON-serialized before replay.
 */
function cloneEntity<T>(value: T): T {
	return structuredClone(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== "object" || typeof b !== "object") return false;
	const aArr = Array.isArray(a);
	const bArr = Array.isArray(b);
	if (aArr !== bArr) return false;
	if (aArr && bArr) {
		if (a.length !== b.length) return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}
	const aObj = a as Record<string, unknown>;
	const bObj = b as Record<string, unknown>;
	const aKeys = Object.keys(aObj);
	const bKeys = Object.keys(bObj);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.hasOwn(bObj, key)) return false;
		if (!deepEqual(aObj[key], bObj[key])) return false;
	}
	return true;
}

// ── Media key partitions ─────────────────────────────────────────────
//
// Media slots ride dedicated clear-safe mutation kinds, never the generic
// update patch. A field's four message-media slots key off
// `<slot>_media`; module/form menu media is `icon` + `audioLabel`; the
// app logo is `logo`. These keys are stripped from every generic
// `update*` patch and diffed through their own kinds.

const FIELD_MEDIA_KEYS = FIELD_MEDIA_SLOTS.map(
	(slot) => `${slot}_media` as const,
);
const MENU_MEDIA_KEY_SET = new Set<string>(["icon", "audioLabel"]);

// The field generic patch skips the media slots (their own kinds), the `order`
// sort key (a `moveField` carries it), and `options` (diffed per-uuid into the
// granular option kinds).
const FIELD_PATCH_SKIP = new Set<string>([
	...FIELD_MEDIA_KEYS,
	"order",
	"options",
	// Lookup source intent uses the top-level rolling-compatible
	// addField/updateField extension; the nested fallback remains the strict
	// inline-options shape understood by pre-S05 receivers.
	"optionsSource",
]);

// ── Entity-set deltas ────────────────────────────────────────────────

interface SetDelta {
	/** Uuids present in `prev` but absent from `next`. */
	removed: Uuid[];
	/** Uuids present in `next` but absent from `prev`. */
	added: Uuid[];
	/** Uuids present in both — candidates for in-place change. */
	common: Uuid[];
}

function setDelta(
	prevKeys: readonly string[],
	nextKeys: readonly string[],
): SetDelta {
	const prevSet = new Set(prevKeys);
	const nextSet = new Set(nextKeys);
	const removed: Uuid[] = [];
	const added: Uuid[] = [];
	const common: Uuid[] = [];
	for (const k of prevKeys) {
		if (nextSet.has(k)) common.push(k as Uuid);
		else removed.push(k as Uuid);
	}
	for (const k of nextKeys) {
		if (!prevSet.has(k)) added.push(k as Uuid);
	}
	return { removed, added, common };
}

// ── Generic property patch (media keys excluded) ─────────────────────
//
// Compare two entity records key-by-key, skipping uuid / kind / the
// caller-named excluded keys (media, and the order-bearing slots a parent
// owns). A key present in `prev` but absent in `next` — OR present-but-
// `undefined` in `next` — clears with `null` (the reducer deletes the key
// on `null` or `undefined`); a changed value sets; an unchanged value is
// omitted. The clear must carry `null`, never `undefined`: the patch is
// JSON-serialized onto the persistence wire (`PUT /api/apps/[id]`), and
// `JSON.stringify` DROPS `undefined`-valued keys, so an `undefined` clear
// arrives as an absent key — a no-op that silently leaves the stale value.

function propertyPatch(
	prev: Record<string, unknown>,
	next: Record<string, unknown>,
	skip: ReadonlySet<string>,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(next)) {
		if (key === "uuid" || key === "kind" || skip.has(key)) continue;
		if (!deepEqual(value, prev[key])) {
			patch[key] = value === undefined ? null : cloneEntity(value);
		}
	}
	for (const key of Object.keys(prev)) {
		if (key === "uuid" || key === "kind" || skip.has(key)) continue;
		if (!Object.hasOwn(next, key)) patch[key] = null;
	}
	return patch;
}

// ── Module / form generic-patch skip sets ────────────────────────────
//
// Modules and forms carry their menu media on `icon` + `audioLabel`,
// diffed via `setModuleMedia` / `setFormMedia`. Everything else (incl.
// `name`, which `renameModule` / `renameForm` own) is handled by the
// generic patch or a rename, never both: a `name` change emits a rename,
// so the generic patch skips it too.

// `order` is carried by `moveModule` / `moveForm`; `caseListConfig` is diffed
// granularly (column / search-input / `setCaseListMeta` kinds), and empty
// `caseSearchConfig` presence via semantic `updateModule` extensions, so the
// module-common loop never co-emits a wholesale present-config patch that
// would clobber a concurrent collection edit. An explicit config removal still
// travels as `updateModule{caseListConfig:null}`.
const MODULE_PATCH_SKIP = new Set<string>([
	"icon",
	"audioLabel",
	"name",
	"order",
	"caseListConfig",
	"caseSearchConfig",
]);
const FORM_PATCH_SKIP = new Set<string>([
	"icon",
	"audioLabel",
	"name",
	"order",
	"caseOperations",
]);

// ── Field media diff ─────────────────────────────────────────────────

function diffFieldMedia(
	prev: Record<string, unknown>,
	next: Record<string, unknown>,
	uuid: Uuid,
): Mutation[] {
	const out: Mutation[] = [];
	for (const slot of FIELD_MEDIA_SLOTS) {
		const key = `${slot}_media`;
		const prevMedia = prev[key];
		const nextMedia = next[key];
		if (deepEqual(prevMedia, nextMedia)) continue;
		out.push({
			kind: "setFieldMedia",
			fieldUuid: uuid,
			slot,
			media: (nextMedia == null
				? null
				: cloneEntity(nextMedia)) as Media | null,
		});
	}
	return out;
}

// ── Menu media diff (module / form) ──────────────────────────────────
//
// `setModuleMedia` / `setFormMedia` carry BOTH slots at once and map each
// `null` to a cleared key. Emit only when either slot actually changed,
// carrying the full next-state of both slots.

function menuMediaChanged(
	prev: Record<string, unknown>,
	next: Record<string, unknown>,
): boolean {
	for (const key of MENU_MEDIA_KEY_SET) {
		if (!deepEqual(prev[key], next[key])) return true;
	}
	return false;
}

// ── Parent reverse index ─────────────────────────────────────────────
//
// `BlueprintDoc.fieldParent` materializes child → parent, but the diff's
// inputs are `toPersistableDoc` snapshots that strip it, so it's rebuilt
// here from `fieldOrder`. Built ONCE per diff per doc and threaded to the
// ancestor / evacuation helpers — a per-call scan of `fieldOrder` would be
// O(fields) on every lookup, O(fields²) over a field-heavy doc.

function buildParentMap(doc: BlueprintDoc): Map<Uuid, Uuid> {
	const parentByChild = new Map<Uuid, Uuid>();
	for (const [parentUuid, order] of Object.entries(doc.fieldOrder)) {
		for (const childUuid of order) {
			parentByChild.set(childUuid as Uuid, parentUuid as Uuid);
		}
	}
	return parentByChild;
}

// ── Field tree walk (parent-before-child) ────────────────────────────
//
// Pre-order over `next`'s field tree under a given parent uuid, yielding
// each (uuid, parentUuid, index). Drives add emission so a container
// lands before its descendants, and each field at the index it occupies
// in `next`.

function* walkFieldTree(
	doc: BlueprintDoc,
	parentUuid: Uuid,
): Generator<{ uuid: Uuid; parentUuid: Uuid; index: number }> {
	const order = orderedFieldUuids(doc, parentUuid);
	for (let index = 0; index < order.length; index++) {
		const uuid = order[index];
		yield { uuid, parentUuid, index };
		yield* walkFieldTree(doc, uuid);
	}
}

// ── The diff ─────────────────────────────────────────────────────────

export function diffDocsToMutations(
	prev: BlueprintDoc,
	next: BlueprintDoc,
): Mutation[] {
	const appLevel: Mutation[] = [];
	const removes: Mutation[] = [];
	const adds: Mutation[] = [];
	const evacuations: Mutation[] = [];
	const fieldStructure: Mutation[] = [];
	const renames: Mutation[] = [];
	const converts: Mutation[] = [];
	const updates: Mutation[] = [];
	const media: Mutation[] = [];
	const orders: Mutation[] = [];
	// Granular collection edits — case-list columns / search-inputs /
	// case-list metadata + select options — keyed by item uuid so concurrent
	// edits to different items merge.
	const collections: Mutation[] = [];

	// (1) App-level scalars. `caseTypes` is deferred to the very end —
	// the field reducers mutate it as a catalog side effect, so pinning
	// it must follow every structural mutation.
	if (prev.appName !== next.appName) {
		appLevel.push({ kind: "setAppName", name: next.appName });
	}
	if (prev.connectType !== next.connectType) {
		appLevel.push({ kind: "setConnectType", connectType: next.connectType });
	}
	if (prev.logo !== next.logo) {
		appLevel.push({ kind: "setAppLogo", logo: next.logo ?? null });
	}

	// ── Module / form / field set deltas ──────────────────────────────
	const moduleDelta = setDelta(
		Object.keys(prev.modules),
		Object.keys(next.modules),
	);
	const formDelta = setDelta(Object.keys(prev.forms), Object.keys(next.forms));
	const fieldDelta = setDelta(
		Object.keys(prev.fields),
		Object.keys(next.fields),
	);

	const removedModuleSet = new Set(moduleDelta.removed);

	// Child → parent reverse indexes, built once and threaded to the
	// ancestor / evacuation helpers (the inputs are persistable snapshots
	// with no derived `fieldParent`).
	const prevParentMap = buildParentMap(prev);
	const nextParentMap = buildParentMap(next);

	// Field structural reconciliation (adds + moves) — computed up front so
	// the field-update loop can force-pin the `id` of every cross-parent-
	// moved field (undoing any `moveField` sibling-id dedup). Its mutations
	// are emitted later, in the phase order.
	const fieldTree = reconcileFieldTree(
		prev,
		next,
		fieldDelta,
		prevParentMap,
		nextParentMap,
	);

	// (2) Removes — top survivors only.
	//
	// A removed module cascades its forms + their fields; a removed form
	// cascades its fields. So only emit `removeForm` for a form whose
	// owning module survives, and `removeField` for a field whose owning
	// form AND every ancestor container survive — otherwise a parent
	// remove already deletes it.
	for (const uuid of moduleDelta.removed) {
		removes.push({ kind: "removeModule", uuid });
	}
	for (const uuid of formDelta.removed) {
		const owningModule = ownerModuleOfForm(prev, uuid);
		if (owningModule !== undefined && removedModuleSet.has(owningModule)) {
			continue; // Module remove cascades this form away.
		}
		removes.push({ kind: "removeForm", uuid });
	}
	for (const uuid of fieldDelta.removed) {
		if (fieldRemovedByAncestor(uuid, next, prevParentMap)) continue;
		removes.push({ kind: "removeField", uuid });
	}

	// (3) Adds — parent before child.
	//
	// Modules in `next.moduleOrder` order; for each added module its forms
	// (in `next.formOrder`) and fields (pre-order) follow. For modules
	// that already existed, their newly-added forms + fields still need
	// adding — handled by the form/field add passes below, keyed off the
	// set deltas.
	const addedModuleSet = new Set(moduleDelta.added);
	const addedFormSet = new Set(formDelta.added);

	for (const uuid of next.moduleOrder) {
		if (!addedModuleSet.has(uuid)) continue;
		const index = next.moduleOrder.indexOf(uuid);
		adds.push(addModuleMutation(cloneEntity(next.modules[uuid]), index));
	}

	// Forms: in next.formOrder order per module, so each lands at its
	// target index relative to forms already present.
	for (const moduleUuid of next.moduleOrder) {
		const order = next.formOrder[moduleUuid] ?? [];
		for (let index = 0; index < order.length; index++) {
			const formUuid = order[index];
			if (!addedFormSet.has(formUuid)) continue;
			adds.push({
				kind: "addForm",
				moduleUuid,
				form: cloneEntity(next.forms[formUuid]),
				index,
			});
		}
	}

	// Field adds + cross-parent moves + reorders were reconciled together in
	// `reconcileFieldTree` above (its mutations are emitted later in the
	// phase order); the field-update loop below reads its `crossParentMoved`
	// set to force-pin moved ids.

	// ── Common entities: renames, converts, updates, media ────────────

	// Modules.
	for (const uuid of moduleDelta.common) {
		const p = prev.modules[uuid] as unknown as Record<string, unknown>;
		const n = next.modules[uuid] as unknown as Record<string, unknown>;
		if (p.name !== n.name) {
			renames.push({ kind: "renameModule", uuid, newId: n.name as string });
		}
		const patch = propertyPatch(p, n, MODULE_PATCH_SKIP);
		if (Object.keys(patch).length > 0) {
			updates.push({
				kind: "updateModule",
				uuid,
				patch: patch as Partial<Module>,
			});
		}
		if (menuMediaChanged(p, n)) {
			media.push({
				kind: "setModuleMedia",
				uuid,
				icon: (n.icon ?? null) as AssetId | null,
				audioLabel: (n.audioLabel ?? null) as AssetId | null,
			});
		}
		// `caseListConfig` is excluded from the generic patch — its content is
		// diffed into an idempotent birth plus granular column / search-input /
		// `setCaseListMeta` kinds. A case-type flip never snapshots the config;
		// only an explicit config removal uses `updateModule{caseListConfig:null}`.
		collections.push(
			...diffCaseListConfig(prev.modules[uuid], next.modules[uuid], uuid),
			...diffCaseSearchConfig(prev.modules[uuid], next.modules[uuid], uuid),
		);
	}

	// Forms.
	for (const uuid of formDelta.common) {
		const p = prev.forms[uuid] as unknown as Record<string, unknown>;
		const n = next.forms[uuid] as unknown as Record<string, unknown>;
		if (p.name !== n.name) {
			renames.push({ kind: "renameForm", uuid, newId: n.name as string });
		}
		const patch = propertyPatch(p, n, FORM_PATCH_SKIP);
		if (Object.keys(patch).length > 0) {
			updates.push({
				kind: "updateForm",
				uuid,
				patch: patch as Partial<Form>,
			});
		}
		updates.push(
			...diffCaseOperations(prev.forms[uuid], next.forms[uuid], uuid),
		);
		if (menuMediaChanged(p, n)) {
			media.push({
				kind: "setFormMedia",
				uuid,
				icon: (n.icon ?? null) as AssetId | null,
				audioLabel: (n.audioLabel ?? null) as AssetId | null,
			});
		}
	}

	// Fields.
	//
	// A field's `id` is reconciled through the `updateField` patch, NOT
	// `renameField`. `renameField` runs a case-property cascade — peer-field
	// renames + `#case/`/`#<type>/` prose rewrites + a catalog rename — whose
	// side effects collide with the rest of a multi-entity diff (it can drag
	// a freshly-added peer's id, or re-key prose this diff separately pins).
	// `updateField` sets `id` with none of that: it's a plain key on the
	// per-kind patch schema (only `uuid` / `kind` are immutable), the reducer
	// applies it in place, and every OTHER entity's slots + the catalog are
	// pinned directly elsewhere in this batch (their own `updateField`
	// patches, `setCaseTypes` last). A `moveField`'s sibling-id dedup may
	// transiently suffix a moved field, but this patch — emitted after the
	// structural pass — overrides it to the exact `next.id`, which makes the
	// move's dedup harmless rather than something to order around.
	for (const uuid of fieldDelta.common) {
		const pField = prev.fields[uuid];
		const nField = next.fields[uuid];
		const p = pField as unknown as Record<string, unknown>;
		const n = nField as unknown as Record<string, unknown>;

		// kind change → convertField. The reducer reconciles the field to
		// the new kind, carrying over only the destination kind's declared
		// slots from the OLD field; the update pass below then pins every
		// remaining slot to its `next` value against the new kind.
		const kindChanged = pField.kind !== nField.kind;
		if (kindChanged) {
			converts.push({
				kind: "convertField",
				uuid,
				toKind: nField.kind,
			});
		}

		// Generic property patch — every non-media, non-uuid, non-kind,
		// non-`order`, non-`options` key, INCLUDING `id`. On a kind change the
		// patch must cover EVERY differing key the new kind declares (the convert
		// carried the old field's values, not next's), so build it against
		// `next`'s value for every key present there plus a clear for any key the
		// convert may have carried that `next` doesn't have.
		const skip = FIELD_PATCH_SKIP;
		const patch = kindChanged
			? fieldPatchForConvertedField(p, n, skip)
			: propertyPatch(p, n, skip);
		// Force-pin `id` for a cross-parent-moved field even when it didn't
		// change: the move's sibling-id dedup may have suffixed it
		// (`inner` → `inner_2`), and only this patch restores the exact
		// `next.id`. (A same-parent reorder never dedups, so it's excluded.)
		if (fieldTree.crossParentMoved.has(uuid) && !("id" in patch)) {
			patch.id = nField.id;
		}
		const previousOptionsSource =
			"optionsSource" in pField ? pField.optionsSource : undefined;
		const nextOptionsSource =
			"optionsSource" in nField ? nField.optionsSource : undefined;
		const optionsSourceChanged =
			(nField.kind === "single_select" || nField.kind === "multi_select") &&
			!deepEqual(previousOptionsSource, nextOptionsSource);
		if (Object.keys(patch).length > 0 || optionsSourceChanged) {
			updates.push({
				kind: "updateField",
				uuid,
				targetKind: nField.kind,
				patch,
				...(optionsSourceChanged && {
					optionsSource: nextOptionsSource ?? null,
				}),
			} as Mutation);
		}

		// Field message media — one `setFieldMedia` per changed slot.
		media.push(...diffFieldMedia(p, n, uuid));

		// Select options — diffed per-uuid into the granular option kinds (a
		// content change excludes `order`/`uuid`; an `order` shift emits a
		// `moveOption`). A field added this batch carries its options inline on
		// `addField`, so the option diff runs for COMMON fields only.
		collections.push(...diffOptions(pField, nField, uuid));
	}

	// (5) Module order — a reorder is detected by an order-key change on a
	// COMMON module (independent of `moduleOrder` array position); adds carry
	// their own `order` on the entity.
	for (const uuid of moduleDelta.common) {
		const nOrder = next.modules[uuid].order;
		if (nOrder !== undefined && prev.modules[uuid].order !== nOrder) {
			orders.push({ kind: "moveModule", uuid, order: nOrder });
		}
	}

	// Form structural — cross-module moves (incl. forms evacuated out of
	// removed modules) + same-module reorders, both order-key-detected.
	const formStructure = reconcileFormOrders(prev, next, formDelta);

	// `fieldTree` (field ADDS + cross-parent MOVES + reorders) was computed
	// up front. EVACUATIONS — moves of surviving forms/fields OUT of a
	// soon-to-be-removed parent — must precede the removes, or the cascade
	// would delete the survivor. Everything else is structural `rest`,
	// emitted after the removes.
	evacuations.push(...formStructure.evacuations, ...fieldTree.evacuations);
	fieldStructure.push(...formStructure.rest, ...fieldTree.rest);

	// Phase order (see the function header):
	//   app scalars → module/form adds → evacuations (survivors out of
	//   removed parents) → removes → field/form structural (rest: adds,
	//   moves, reorders) → module/form renames → converts → field updates
	//   (incl. id) → media → granular collections (columns/search-inputs/
	//   options/case-list meta) → module order → catalog.
	const structural: Mutation[] = [
		...appLevel,
		...adds,
		...evacuations,
		...removes,
		...fieldStructure,
		...renames,
		...converts,
		...updates,
		...media,
		...collections,
		...orders,
	];

	// (6) Case-type catalog — granular catalog mutations (declare / retire /
	// add-property / set-property / remove-property / set-meta) keyed by
	// `(type, property)` name, REPLACING the wholesale `setCaseTypes` on the
	// live path so a co-member's concurrent catalog add survives the re-apply.
	//
	// ONLY the FIELD reducers mutate the catalog as a side effect
	// (`ensureCatalogProperty`, which now appends a writer's property to an
	// EXISTING declared type — it no longer mints the type). So when a field
	// add/convert/update is present, diff the catalog against the REPLAYED
	// structural state — the residual the side effects didn't reproduce (a
	// direct declaration / retirement / meta change / property edit). With no
	// field edit, the catalog is reached only by the granular kinds, so diff
	// `prev → next` directly (skipping the O(doc) replay).
	//
	// (A genuinely concurrent edit to the SAME property name stays
	// last-writer-wins — the documented multiplayer-GA limit.)
	// Only `updateField` reaches the catalog (its `ensureCatalogProperty`
	// side effect) — `updateModule` / `updateForm` patches never do. Gating on
	// any `updates` entry fired the O(doc) replay on a routine module-purpose /
	// form-settings save; gate on a field-touching mutation instead.
	const fieldCatalogTouched =
		fieldStructure.length > 0 ||
		converts.length > 0 ||
		updates.some((m) => m.kind === "updateField");
	const fromCatalog = fieldCatalogTouched
		? // `structuredClone` the batch for the simulation: `applyMutations`
			// aliases payload objects into the immer draft, and immer's auto-freeze
			// would otherwise deep-freeze the very objects this function RETURNS.
			produce(prev, (draft) => {
				applyMutations(draft, structuredClone(structural));
			}).caseTypes
		: prev.caseTypes;
	structural.push(...diffCatalog(fromCatalog, next.caseTypes));

	return structural;
}

function diffCaseOperations(
	prev: Form,
	next: Form,
	formUuid: Uuid,
): Mutation[] {
	const before = new Map(
		(prev.caseOperations ?? []).map((operation) => [operation.uuid, operation]),
	);
	const after = new Map(
		(next.caseOperations ?? []).map((operation) => [operation.uuid, operation]),
	);
	const mutations: Mutation[] = [];
	for (const [uuid] of before) {
		if (after.has(uuid)) continue;
		mutations.push({
			kind: "updateForm",
			uuid: formUuid,
			patch: {},
			caseOperationChange: { operation: "remove", uuid },
		});
	}
	for (const [uuid, operation] of after) {
		const prior = before.get(uuid);
		if (prior === undefined) {
			mutations.push({
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationChange: {
					operation: "add",
					value: cloneEntity(operation),
				},
			});
			continue;
		}
		const priorWithoutOrder = { ...prior, order: undefined };
		const operationWithoutOrder = { ...operation, order: undefined };
		if (!deepEqual(priorWithoutOrder, operationWithoutOrder)) {
			mutations.push({
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationChange: {
					operation: "update",
					uuid,
					value: cloneEntity(operation),
				},
			});
		} else if (prior.order !== operation.order) {
			mutations.push(
				operation.order === undefined
					? {
							kind: "updateForm",
							uuid: formUuid,
							patch: {},
							caseOperationChange: {
								operation: "update",
								uuid,
								value: cloneEntity(operation),
							},
						}
					: {
							kind: "updateForm",
							uuid: formUuid,
							patch: {},
							caseOperationChange: {
								operation: "move",
								uuid,
								order: operation.order,
							},
						},
			);
		}
	}
	return mutations;
}

// ── Field-patch helpers ──────────────────────────────────────────────

/**
 * Build the reconciliation patch for a field whose kind changed. The
 * `convertField` reducer already ran (carrying the OLD field's values for
 * the destination kind's shared slots), so the patch must restore every
 * differing slot to `next`'s value — set each key `next` declares (that
 * isn't skipped) whose value the convert couldn't have produced, and
 * clear any non-skipped key that survived the carry-over but is absent in
 * `next`. Since the post-convert intermediate state isn't computed here,
 * the patch conservatively sets EVERY key `next` declares and clears every
 * key `prev` declared but `next` doesn't — both are reducer-safe and the
 * final state equals `next`.
 */
function fieldPatchForConvertedField(
	prev: Record<string, unknown>,
	next: Record<string, unknown>,
	skip: ReadonlySet<string>,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(next)) {
		if (key === "uuid" || key === "kind" || skip.has(key)) continue;
		// A present-but-`undefined` slot clears with `null`, not `undefined`:
		// the patch is JSON-serialized onto the persistence wire and
		// `JSON.stringify` drops `undefined`-valued keys.
		patch[key] = value === undefined ? null : cloneEntity(value);
	}
	for (const key of Object.keys(prev)) {
		if (key === "uuid" || key === "kind" || skip.has(key)) continue;
		if (!Object.hasOwn(next, key)) patch[key] = null;
	}
	return patch;
}

// ── Cascade / ownership helpers ──────────────────────────────────────

/** The module uuid whose `formOrder` lists `formUuid`, or undefined. */
function ownerModuleOfForm(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Uuid | undefined {
	for (const [moduleUuid, order] of Object.entries(doc.formOrder)) {
		if (order.includes(formUuid)) return moduleUuid as Uuid;
	}
	return undefined;
}

/**
 * Does a removed field get cascade-deleted by its parent's removal — so it
 * needs no explicit `removeField`?
 *
 * A removed field is cascaded EXACTLY when its `prev` parent is itself
 * removed: that parent gets a `removeForm` / `removeField` (when ITS own
 * parent survives, by this same rule applied up the chain), and the reducer
 * cascade deletes the whole subtree. So the only field that needs an
 * explicit `removeField` is one whose parent SURVIVES into `next`.
 *
 * The survivor case includes the subtle one: a SURVIVING container nested
 * in a removed parent is EVACUATED out before the remove runs (see the
 * evacuation phase), carrying its children with it. A removed child of that
 * evacuated survivor escaped the doomed-ancestor cascade and so still needs
 * its own `removeField` — which this rule emits, because its parent (the
 * evacuated survivor) is in `next`.
 */
function fieldRemovedByAncestor(
	fieldUuid: Uuid,
	next: BlueprintDoc,
	prevParentMap: ReadonlyMap<Uuid, Uuid>,
): boolean {
	const parent = prevParentMap.get(fieldUuid);
	if (parent === undefined) return false;
	// Cascaded iff the parent does NOT survive — a removed form/container
	// parent owns the cascade; a surviving parent does not.
	return next.forms[parent] === undefined && next.fields[parent] === undefined;
}

// ── Order reconciliation per module / parent ─────────────────────────

/**
 * Reconcile each module's forms to `next` — cross-module form moves +
 * same-module reorders, BOTH detected by order key (a common form whose owning
 * module or whose `order` changed), independent of `formOrder` array position.
 * A form leaving a REMOVED module must move out before the `removeModule`
 * cascade, so it is emitted in `evacuations` (pre-removes); every other
 * cross-module move + all reorders are `rest` (post-removes).
 */
function reconcileFormOrders(
	prev: BlueprintDoc,
	next: BlueprintDoc,
	formDelta: SetDelta,
): { evacuations: Mutation[]; rest: Mutation[] } {
	const evacuations: Mutation[] = [];
	const rest: Mutation[] = [];
	const prevModuleOf = buildFormModuleMap(prev);
	const nextModuleOf = buildFormModuleMap(next);

	for (const formUuid of formDelta.common) {
		const nextModule = nextModuleOf.get(formUuid);
		if (nextModule === undefined) continue; // unreachable in next (shouldn't happen)
		const prevModule = prevModuleOf.get(formUuid);
		const nextOrder = next.forms[formUuid].order;
		if (prevModule !== nextModule) {
			const move: Mutation = {
				kind: "moveForm",
				uuid: formUuid,
				toModuleUuid: nextModule,
				...(nextOrder !== undefined && { order: nextOrder }),
			};
			// A form leaving a REMOVED module evacuates before the cascade.
			if (prevModule !== undefined && next.modules[prevModule] === undefined) {
				evacuations.push(move);
			} else {
				rest.push(move);
			}
		} else if (
			nextOrder !== undefined &&
			prev.forms[formUuid].order !== nextOrder
		) {
			rest.push({
				kind: "moveForm",
				uuid: formUuid,
				toModuleUuid: nextModule,
				order: nextOrder,
			});
		}
	}
	return { evacuations, rest };
}

/** Child form uuid → owning module uuid, from `formOrder`. */
function buildFormModuleMap(doc: BlueprintDoc): Map<Uuid, Uuid> {
	const out = new Map<Uuid, Uuid>();
	for (const [moduleUuid, order] of Object.entries(doc.formOrder)) {
		for (const formUuid of order) out.set(formUuid as Uuid, moduleUuid as Uuid);
	}
	return out;
}
/**
 * Reconcile the field tree to `next` — field ADDS, cross-parent MOVES, and
 * same-parent reorders.
 *
 * Membership (adds / cross-parent moves) is detected by parent-set comparison;
 * a REORDER is an order-key change on a common, same-parent field (independent
 * of `fieldOrder` array position). Adds are emitted parent-before-child
 * (top-down parents, sorted children) so a container lands before the fields it
 * holds; each carries the field's `order`. A cross-parent move carries `order`
 * and joins `crossParentMoved` so the field-update loop force-pins its `id`
 * (undoing any move-time sibling-id dedup).
 *
 * Cross-parent moves out of a DOOMED parent (one removed this batch) are
 * EVACUATIONS — emitted before the removes so the cascade can't delete the
 * survivor; the rest follow the removes. Every emitted move is same-form: a
 * surviving field's containing form is invariant (only `moveField` changes a
 * field's form, and that path rejects cross-form), so the reducer's same-form
 * guard never trips.
 */
function reconcileFieldTree(
	prev: BlueprintDoc,
	next: BlueprintDoc,
	fieldDelta: SetDelta,
	prevParentMap: ReadonlyMap<Uuid, Uuid>,
	nextParentMap: ReadonlyMap<Uuid, Uuid>,
): {
	evacuations: Mutation[];
	rest: Mutation[];
	crossParentMoved: Set<Uuid>;
} {
	const evacuations: Mutation[] = [];
	const adds: Mutation[] = [];
	const moves: Mutation[] = [];
	const crossParentMoved = new Set<Uuid>();
	const addedFieldSet = new Set(fieldDelta.added);

	// A prev parent is "doomed" when it won't exist after the removes — a
	// removed form or container field (covers parents under a removed module).
	const isDoomed = (parentUuid: Uuid | undefined): boolean =>
		parentUuid !== undefined &&
		next.forms[parentUuid] === undefined &&
		next.fields[parentUuid] === undefined;

	// Adds — parent-before-child (top-down parents, sorted children). Each
	// added field carries its own `order`, so no `index` is needed.
	for (const parentUuid of nextParentsTopDown(next)) {
		for (const uuid of orderedFieldUuids(next, parentUuid)) {
			if (!addedFieldSet.has(uuid)) continue;
			const field = cloneEntity(next.fields[uuid]) as Field;
			const optionsSource =
				"optionsSource" in field ? field.optionsSource : undefined;
			if ("optionsSource" in field) {
				delete (field as unknown as Record<string, unknown>).optionsSource;
			}
			adds.push({
				kind: "addField",
				parentUuid,
				field,
				...(optionsSource !== undefined && { optionsSource }),
			} as Mutation);
		}
	}

	// Cross-parent moves + same-parent reorders over the common fields.
	for (const uuid of fieldDelta.common) {
		const nextParent = nextParentMap.get(uuid);
		if (nextParent === undefined) continue; // unreachable in next (shouldn't happen)
		const prevParent = prevParentMap.get(uuid);
		const nextOrder = next.fields[uuid].order;
		if (prevParent !== nextParent) {
			const move: Mutation = {
				kind: "moveField",
				uuid,
				toParentUuid: nextParent,
				...(nextOrder !== undefined && { order: nextOrder }),
			};
			crossParentMoved.add(uuid);
			if (isDoomed(prevParent)) evacuations.push(move);
			else moves.push(move);
		} else if (
			nextOrder !== undefined &&
			prev.fields[uuid].order !== nextOrder
		) {
			moves.push({
				kind: "moveField",
				uuid,
				toParentUuid: nextParent,
				order: nextOrder,
			});
		}
	}

	// An evacuation's DESTINATION may itself be a container ADDED in this diff
	// (create group G, drag X out of doomed H into G, delete H — one batch).
	// Field adds otherwise emit AFTER the removes, so the batch would reference
	// a not-yet-existing container mid-replay: `batchTargetsMissing` runs in
	// batch order and rejects the whole save as a phantom conflict (409 → the
	// reload drops the user's create+move+delete), and an unguarded replay
	// would silently no-op the move and cascade-delete the survivor. Hoist the
	// destination's ADDED-ancestor chain ahead of the evacuations (keeping the
	// adds' parent-before-child order) so every referenced container exists by
	// the time its evacuation applies.
	if (evacuations.length > 0) {
		const hoistedUuids = new Set<Uuid>();
		for (const ev of evacuations) {
			if (ev.kind !== "moveField") continue;
			let cursor: Uuid | undefined = ev.toParentUuid;
			while (cursor !== undefined && addedFieldSet.has(cursor)) {
				hoistedUuids.add(cursor);
				cursor = nextParentMap.get(cursor);
			}
		}
		if (hoistedUuids.size > 0) {
			const hoisted: Mutation[] = [];
			for (let i = adds.length - 1; i >= 0; i--) {
				const m = adds[i];
				if (m.kind === "addField" && hoistedUuids.has(m.field.uuid)) {
					hoisted.unshift(m);
					adds.splice(i, 1);
				}
			}
			evacuations.unshift(...hoisted);
		}
	}

	return { evacuations, rest: [...adds, ...moves], crossParentMoved };
}

/**
 * Every field parent in `next` (forms then container fields), top-down and in
 * DISPLAY order (`sort-by-(order, uuid)`): forms in module → form order, then
 * container fields in pre-order. A top-down order means a parent is always
 * visited before any parent nested inside it.
 */
function nextParentsTopDown(next: BlueprintDoc): Uuid[] {
	const parents: Uuid[] = [];
	for (const moduleUuid of orderedModuleUuids(next)) {
		for (const formUuid of orderedFormUuids(next, moduleUuid)) {
			parents.push(formUuid);
			for (const { uuid } of walkFieldTree(next, formUuid)) {
				const field = next.fields[uuid];
				if (field && (field.kind === "group" || field.kind === "repeat")) {
					parents.push(uuid);
				}
			}
		}
	}
	return parents;
}

// ── Granular collection + catalog diffs ──────────────────────────────

/** Deep-equal two values ignoring generic + surface order keys. */
function contentEqualIgnoringOrder(a: unknown, b: unknown): boolean {
	return deepEqual(stripOrder(a), stripOrder(b));
}

function stripOrder(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}
	const {
		order: _order,
		listOrder: _listOrder,
		detailOrder: _detailOrder,
		...rest
	} = value as Record<string, unknown>;
	return rest;
}

/**
 * Diff a module's `caseListConfig`. Birth is an idempotent semantic extension
 * on `updateModule`, followed by the same granular column / search-input /
 * `setCaseListMeta` kinds used for ordinary content edits. Reapplying that
 * batch over a peer-populated config therefore merges by item uuid instead of
 * replacing the peer's work with the empty rolling-deploy fallback snapshot.
 *
 * A case-type flip has no special config behavior: `updateModule{caseType}`
 * changes the module context, while any simultaneous config changes remain
 * granular. Only an explicit present -> absent transition is a deliberate
 * whole-config removal and carries `updateModule{caseListConfig:null}`.
 */
function diffCaseListConfig(
	prevMod: Module,
	nextMod: Module,
	moduleUuid: Uuid,
): Mutation[] {
	const prevConfig = prevMod.caseListConfig;
	const nextConfig = nextMod.caseListConfig;
	if (nextConfig === undefined) {
		if (prevConfig === undefined) return [];
		// A deliberate whole-config removal travels as `null` (the patch schema
		// admits it on the optional slot, and null survives the JSON wire).
		return [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListConfig: null } as unknown as Partial<Module>,
			},
		];
	}
	const birth: Mutation[] =
		prevConfig === undefined
			? [
					{
						kind: "updateModule",
						uuid: moduleUuid,
						patch: { caseListConfig: { columns: [], searchInputs: [] } },
						ensureCaseListConfig: true,
					},
				]
			: [];
	const prevC = prevConfig ?? { columns: [], searchInputs: [] };
	return [
		...birth,
		...diffColumns(prevC.columns, nextConfig.columns, moduleUuid),
		...diffSearchInputs(
			prevC.searchInputs,
			nextConfig.searchInputs,
			moduleUuid,
		),
		...diffCaseListMeta(prevC, nextConfig, moduleUuid),
	];
}

function diffColumns(
	prev: readonly Column[],
	next: readonly Column[],
	moduleUuid: Uuid,
): Mutation[] {
	const out: Mutation[] = [];
	const prevByUuid = new Map(prev.map((c) => [c.uuid, c]));
	const nextUuids = new Set(next.map((c) => c.uuid));
	for (const col of next) {
		const p = prevByUuid.get(col.uuid);
		if (!p) {
			out.push(columnAddMutation(moduleUuid, cloneEntity(col)));
			continue;
		}
		out.push(...columnSnapshotMutations(moduleUuid, p, cloneEntity(col)));
		if (col.order !== undefined && p.order !== col.order) {
			out.push({
				kind: "moveColumn",
				moduleUuid,
				uuid: col.uuid,
				order: col.order,
			});
		}
	}
	for (const col of prev) {
		if (!nextUuids.has(col.uuid)) {
			out.push({ kind: "removeColumn", moduleUuid, uuid: col.uuid });
		}
	}
	return out;
}

function diffSearchInputs(
	prev: readonly SearchInputDef[],
	next: readonly SearchInputDef[],
	moduleUuid: Uuid,
): Mutation[] {
	const out: Mutation[] = [];
	const prevByUuid = new Map(prev.map((s) => [s.uuid, s]));
	const nextUuids = new Set(next.map((s) => s.uuid));
	for (const input of next) {
		const p = prevByUuid.get(input.uuid);
		if (!p) {
			out.push({
				kind: "addSearchInput",
				moduleUuid,
				searchInput: cloneEntity(input),
			});
			continue;
		}
		if (!contentEqualIgnoringOrder(p, input)) {
			out.push(searchInputUpdateMutation(moduleUuid, p, cloneEntity(input)));
		}
		if (input.order !== undefined && p.order !== input.order) {
			out.push({
				kind: "moveSearchInput",
				moduleUuid,
				uuid: input.uuid,
				order: input.order,
			});
		}
	}
	for (const input of prev) {
		if (!nextUuids.has(input.uuid)) {
			out.push({ kind: "removeSearchInput", moduleUuid, uuid: input.uuid });
		}
	}
	return out;
}

/** The case-list's non-array metadata — always-on `filter` + case-list-link
 *  `icon` / `audioLabel`. A clear travels as `null`. */
function diffCaseListMeta(
	prev: CaseListConfig,
	next: CaseListConfig,
	moduleUuid: Uuid,
): Mutation[] {
	const patch: {
		filter?: CaseListConfig["filter"] | null;
		icon?: string | null;
		audioLabel?: string | null;
	} = {};
	if (!deepEqual(prev.filter, next.filter)) {
		patch.filter = next.filter === undefined ? null : cloneEntity(next.filter);
	}
	if (prev.icon !== next.icon) patch.icon = next.icon ?? null;
	if (prev.audioLabel !== next.audioLabel) {
		patch.audioLabel = next.audioLabel ?? null;
	}
	if (Object.keys(patch).length === 0) return [];
	return [{ kind: "setCaseListMeta", uuid: moduleUuid, patch }];
}

/**
 * Diff the search-settings bag without turning its synthetic empty marker into
 * a destructive whole-slot write. Empty absent→present is an idempotent
 * enable; empty present→absent after the final searchable surface disappears
 * is a fresh-state-conditional disable. Authored settings remain a deliberate
 * wholesale bag edit (the settings UI has one owner), while marker intent and
 * final-input cleanup remain semantic so stale batches cannot erase a peer's
 * newer settings. Config-to-absent is likewise a per-setting clear while the
 * case-list surface survives; raw whole-bag removal is reserved for structural
 * case-list teardown, where the Search bag has no remaining owner.
 */
function diffCaseSearchConfig(
	prevMod: Module,
	nextMod: Module,
	moduleUuid: Uuid,
): Mutation[] {
	const prev = prevMod.caseSearchConfig;
	const next = nextMod.caseSearchConfig;

	// Removing the final input owns screen-only copy and Search/owner provenance,
	// but those decisions must be made against the state present at replay time.
	// Emit the conditional cleanup even when the local config did not change: a
	// peer may have added screen copy, an action setting, an owner rule, or a new
	// input while this diff was in flight.
	const removedFinalInput =
		(prevMod.caseListConfig?.searchInputs.length ?? 0) > 0 &&
		(nextMod.caseListConfig?.searchInputs.length ?? 0) === 0;
	if (
		prev !== undefined &&
		removedFinalInput &&
		deepEqual(
			next,
			caseSearchConfigAfterFinalInputRemoval(
				prev,
				effectiveFilterForEmission(nextMod.caseListConfig?.filter) !==
					undefined,
			),
		)
	) {
		return [
			cleanupCaseSearchAfterFinalInputMutation({
				uuid: moduleUuid,
				config: prev,
				hasCasesAvailableCondition:
					effectiveFilterForEmission(nextMod.caseListConfig?.filter) !==
					undefined,
			}),
		];
	}

	if (deepEqual(prev, next)) return [];

	// Owner-only storage and an enabled Search action differ only by Nova's
	// internal false provenance bit. Preserve the owner expression (including a
	// peer's newer value) by replaying semantic enable rather than a bag snapshot.
	if (prev?.searchActionEnabled === false && next !== undefined) {
		const { searchActionEnabled: _disabled, ...enabled } = prev;
		if (deepEqual(enabled, next)) {
			return [enableCaseSearchMutation(moduleUuid, next)];
		}
	}

	const prevIsMarker =
		prev !== undefined &&
		prev.searchActionEnabled !== false &&
		!caseSearchConfigHasAuthoredSettings(prev);
	const nextIsMarker =
		next !== undefined &&
		next.searchActionEnabled !== false &&
		!caseSearchConfigHasAuthoredSettings(next);
	if (prev === undefined && nextIsMarker) {
		return [enableCaseSearchMutation(moduleUuid, next)];
	}
	if (
		prevIsMarker &&
		next === undefined &&
		nextMod.caseListConfig?.searchInputs.length === 0 &&
		effectiveFilterForEmission(nextMod.caseListConfig?.filter) === undefined
	) {
		return [disableUnusedCaseSearchMutation(moduleUuid)];
	}
	if (next?.searchActionEnabled === false) {
		return [setOwnerOnlyCaseSearchMutation(moduleUuid, next)];
	}
	if (next !== undefined) {
		return caseSearchConfigPatchMutations(moduleUuid, prev, next);
	}
	if (nextMod.caseListConfig !== undefined) {
		return clearCaseSearchConfigSettingsMutations(moduleUuid, prev);
	}

	// Structural case-list removal makes the entire Search bag meaningless. This
	// is the one deliberate whole-slot clear: there is no surviving Search/list
	// surface whose peer settings could remain actionable.
	return [
		{
			kind: "updateModule",
			uuid: moduleUuid,
			patch: {
				caseSearchConfig: null,
			},
		},
	];
}

/** Diff a select field's options by uuid into the granular option kinds. A
 *  field added this batch carries its options inline, so this runs for common
 *  fields only. */
function diffOptions(
	prevField: Field,
	nextField: Field,
	fieldUuid: Uuid,
): Mutation[] {
	const prevOpts = optionsOf(prevField);
	const nextOpts = optionsOf(nextField);
	if (prevOpts.length === 0 && nextOpts.length === 0) return [];
	const out: Mutation[] = [];
	const prevByUuid = new Map<string, SelectOption>();
	for (const o of prevOpts) if (o.uuid) prevByUuid.set(o.uuid, o);
	const nextUuids = new Set<string>();
	for (const opt of nextOpts) {
		if (!opt.uuid) continue; // unbackfilled (shouldn't happen post-hydration)
		nextUuids.add(opt.uuid);
		const p = prevByUuid.get(opt.uuid);
		if (!p) {
			out.push({ kind: "addOption", fieldUuid, option: cloneEntity(opt) });
			continue;
		}
		if (!contentEqualIgnoringOrder(p, opt)) {
			out.push({
				kind: "updateOption",
				fieldUuid,
				uuid: opt.uuid,
				option: cloneEntity(opt),
			});
		}
		if (opt.order !== undefined && p.order !== opt.order) {
			out.push({
				kind: "moveOption",
				fieldUuid,
				uuid: opt.uuid,
				order: opt.order,
			});
		}
	}
	for (const o of prevOpts) {
		if (o.uuid && !nextUuids.has(o.uuid)) {
			out.push({ kind: "removeOption", fieldUuid, uuid: o.uuid });
		}
	}
	return out;
}

function optionsOf(field: Field): readonly SelectOption[] {
	return "options" in field && Array.isArray(field.options)
		? (field.options as SelectOption[])
		: [];
}

/**
 * Diff the case-type catalog from → to into granular catalog mutations,
 * keyed by `(type, property)` name. Order: declare new types FIRST (so an
 * `addCaseProperty` targeting one has its type), then per-type meta + property
 * edits, then retire gone types last. Replaying these on `from` reproduces
 * `to`. No `setCaseTypes` is emitted.
 */
function diffCatalog(
	from: readonly CaseType[] | null,
	to: readonly CaseType[] | null,
): Mutation[] {
	const out: Mutation[] = [];
	const fromArr = from ?? [];
	const toArr = to ?? [];
	const fromByName = new Map(fromArr.map((ct) => [ct.name, ct]));
	const toByName = new Map(toArr.map((ct) => [ct.name, ct]));

	for (const ct of toArr) {
		if (!fromByName.has(ct.name)) {
			out.push({ kind: "declareCaseType", caseType: ct.name });
		}
	}
	for (const toCt of toArr) {
		const fromCt = fromByName.get(toCt.name);
		// Emit ONLY the ancestry slot(s) that actually changed — an omitted slot
		// means "unchanged" (the reducer leaves it alone). Setting both whenever
		// either differs would re-write the untouched slot to this emitter's
		// snapshot value, so a concurrent peer editing the OTHER slot would be
		// clobbered on the guarded re-apply. A changed slot travels as its new
		// value or an explicit `null` (a clear — JSON drops `undefined`).
		const meta: {
			kind: "setCaseTypeMeta";
			caseType: string;
			parent_type?: string | null;
			relationship?: "child" | "extension" | null;
		} = { kind: "setCaseTypeMeta", caseType: toCt.name };
		let metaChanged = false;
		if (
			(fromCt?.parent_type ?? undefined) !== (toCt.parent_type ?? undefined)
		) {
			meta.parent_type = toCt.parent_type ?? null;
			metaChanged = true;
		}
		if (
			(fromCt?.relationship ?? undefined) !== (toCt.relationship ?? undefined)
		) {
			meta.relationship = toCt.relationship ?? null;
			metaChanged = true;
		}
		if (metaChanged) out.push(meta);
		const fromProps = new Map(
			(fromCt?.properties ?? []).map((p) => [p.name, p]),
		);
		const toPropNames = new Set(toCt.properties.map((p) => p.name));
		for (const prop of toCt.properties) {
			const fp = fromProps.get(prop.name);
			if (!fp) {
				out.push({
					kind: "addCaseProperty",
					caseType: toCt.name,
					property: cloneEntity(prop),
				});
			} else if (!deepEqual(fp, prop)) {
				out.push({
					kind: "setCaseProperty",
					caseType: toCt.name,
					property: cloneEntity(prop),
				});
			}
		}
		for (const prop of fromCt?.properties ?? []) {
			if (!toPropNames.has(prop.name)) {
				out.push({
					kind: "removeCaseProperty",
					caseType: toCt.name,
					property: prop.name,
				});
			}
		}
	}
	for (const ct of fromArr) {
		if (!toByName.has(ct.name)) {
			out.push({ kind: "retireCaseType", caseType: ct.name });
		}
	}
	return out;
}
