/**
 * Diff two `BlueprintDoc`s into the minimal-enough `Mutation[]` whose
 * replay on the FIRST doc reproduces the SECOND. It supports endpoint-only
 * transforms such as synthetic repair and non-semantic inverse construction.
 * Interactive persistence does not use this function: it preserves and sends
 * the exact admitted command batches. In particular, this function never
 * invents an app-wide case-property rename from two snapshots because only
 * the recorded command can authorize moving saved rows.
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
 * `mutationTargetsInvalid` rejects it as a 409 rather than letting it silently
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
 *      moves, and same-parent reorders, plus cross-module form moves +
 *      same-module reorders. A move preserves the field's id.
 *   6. Module + form renames, then field converts (`convertField`).
 *   7. Updates — `updateModule` / `updateForm` / `updateField` patches of
 *      ONLY the changed keys (excluding `order`, `caseListConfig`,
 *      `caseSearchConfig`, `options`, and media, each diffed separately).
 *      Field-id and `caseWrite` patches are both UUID-local.
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
 *      concurrent add). The post-horizon dialect has no wholesale catalog
 *      mutation.
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
import { caseOperationChangesForUpdate } from "@/lib/doc/caseOperationMutations";
import {
	isCasePropertyRenameShapedEndpointDelta,
	type RenameCasePropertiesMutation,
} from "@/lib/doc/casePropertyRenames";
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
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	orderedFieldUuids,
	orderedFormUuids,
	orderedModuleUuids,
} from "@/lib/doc/fieldWalk";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
} from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { sequenceMovesTo, spliceAfter } from "@/lib/doc/mutations/sequence";
import { searchInputUpdateMutation } from "@/lib/doc/searchInputMutations";
import {
	asUuid,
	type BlueprintDoc,
	FIELD_MEDIA_SLOTS,
	type Mutation,
	mutationSchema,
	type Uuid,
} from "@/lib/doc/types";
import {
	updatePersonaMutations,
	updateUserTypeMutations,
} from "@/lib/doc/userMutations";
import type {
	Automation,
	CaseListConfig,
	CaseType,
	Field,
	Form,
	Media,
	Module,
	SearchInputDef,
	SelectOption,
} from "@/lib/domain";
import {
	caseOperationSchema,
	caseSearchConfigAfterFinalInputRemoval,
	caseSearchConfigHasAuthoredSettings,
	convertNeedsOptionSeed,
	effectiveAppLocalization,
	emptyCaseListConfig,
	fieldKindDeclaresKey,
	hasOwnRecordKey,
	isOwnerOnlyCaseSearchConfig,
	ownRecordValue,
	parseLanguageTag,
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

export class CasePropertySemanticProvenanceRequiredError extends Error {
	constructor() {
		super(
			"Case-property carrier names changed without the exact recorded rename command. Endpoint snapshots cannot decide whether saved rows should move.",
		);
		this.name = "CasePropertySemanticProvenanceRequiredError";
	}
}

export interface CasePropertyRenameProvenance {
	readonly casePropertyRename: AdmittedMutationBatch;
	readonly recordedNonRenameForward?: never;
}

export interface RecordedNonRenameProvenance {
	readonly recordedNonRenameForward: AdmittedMutationBatch;
	readonly casePropertyRename?: never;
}

export type DiffSemanticProvenance =
	| CasePropertyRenameProvenance
	| RecordedNonRenameProvenance;

function isRecordedNonRenameProvenance(
	provenance: DiffSemanticProvenance,
): provenance is RecordedNonRenameProvenance {
	return provenance.recordedNonRenameForward !== undefined;
}

function renameFromProvenance(
	prev: BlueprintDoc,
	next: BlueprintDoc,
	provenance: CasePropertyRenameProvenance,
): Mutation[] {
	const batch = provenance.casePropertyRename;
	const command =
		batch.length === 1 && batch[0]?.kind === "renameCaseProperties"
			? batch[0]
			: undefined;
	if (command === undefined) {
		throw new CasePropertySemanticProvenanceRequiredError();
	}
	const replayed = produce(prev, (draft) => {
		applyMutations(draft, batch);
	});
	if (!deepEqual(toPersistableDoc(replayed), toPersistableDoc(next))) {
		throw new CasePropertySemanticProvenanceRequiredError();
	}
	return [structuredClone(command satisfies RenameCasePropertiesMutation)];
}

/**
 * Prove the exact ordinary command batch that produced `prev` from `next`.
 *
 * This branch exists for command-history inverse construction only. An
 * ordinary remove+add can have the same endpoint shape as a rename, but its
 * recorded admitted commands prove that no saved-row move was authored.
 * Replay equality is mandatory, and an explicit rename is categorically
 * excluded, so this cannot become a generic endpoint bypass.
 */
function proveRecordedNonRenameForward(
	prev: BlueprintDoc,
	next: BlueprintDoc,
	provenance: RecordedNonRenameProvenance,
): void {
	const forward = provenance.recordedNonRenameForward;
	if (forward.some((mutation) => mutation.kind === "renameCaseProperties")) {
		throw new CasePropertySemanticProvenanceRequiredError();
	}
	const replayed = produce(next, (draft) => {
		applyMutations(draft, forward);
	});
	if (!deepEqual(toPersistableDoc(replayed), toPersistableDoc(prev))) {
		throw new CasePropertySemanticProvenanceRequiredError();
	}
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
// sort key (a `moveField` carries it), and `optionsSource` (either replaced as
// one arm or diffed per option when both sides are inline).
const FIELD_PATCH_SKIP = new Set<string>([
	...FIELD_MEDIA_KEYS,
	"order",
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
		if (nextSet.has(k)) common.push(asUuid(k));
		else removed.push(asUuid(k));
	}
	for (const k of nextKeys) {
		if (!prevSet.has(k)) added.push(asUuid(k));
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
			parentByChild.set(childUuid, asUuid(parentUuid));
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
	provenance?: DiffSemanticProvenance,
): Mutation[] {
	const renameShapedDelta = isCasePropertyRenameShapedEndpointDelta(prev, next);
	if (provenance !== undefined) {
		if (isRecordedNonRenameProvenance(provenance)) {
			proveRecordedNonRenameForward(prev, next, provenance);
		} else {
			return renameFromProvenance(prev, next, provenance);
		}
	}
	if (provenance === undefined && renameShapedDelta) {
		throw new CasePropertySemanticProvenanceRequiredError();
	}

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
	collections.push(...diffUserCollections(prev, next));
	collections.push(...diffOrganizationCollections(prev, next));
	collections.push(...diffAutomationCollections(prev, next));

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

	// Field structural reconciliation (adds + moves) is computed up front and
	// emitted later in the phase order.
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

	for (const [at, uuid] of next.moduleOrder.entries()) {
		if (!addedModuleSet.has(uuid)) continue;
		adds.push(
			addModuleMutation(
				cloneEntity(ownRecordValue(next.modules, uuid) as Module),
				at === 0 ? null : next.moduleOrder[at - 1],
			),
		);
	}

	// Forms: in each module's sequence order, each naming the form it follows.
	for (const moduleUuid of next.moduleOrder) {
		const sequence = ownRecordValue(next.formOrder, moduleUuid) ?? [];
		for (const [at, formUuid] of sequence.entries()) {
			if (!addedFormSet.has(formUuid)) continue;
			adds.push({
				kind: "addForm",
				moduleUuid,
				form: cloneEntity(ownRecordValue(next.forms, formUuid) as Form),
				after: at === 0 ? null : sequence[at - 1],
			});
		}
	}

	// Field adds + cross-parent moves + reorders were reconciled together in
	// `reconcileFieldTree` above (its mutations are emitted later in the
	// phase order).

	// ── Common entities: renames, converts, updates, media ────────────

	// Modules.
	for (const uuid of moduleDelta.common) {
		const prevModule = ownRecordValue(prev.modules, uuid) as Module;
		const nextModule = ownRecordValue(next.modules, uuid) as Module;
		const p = prevModule as unknown as Record<string, unknown>;
		const n = nextModule as unknown as Record<string, unknown>;
		if (p.name !== n.name) {
			renames.push({ kind: "renameModule", uuid, newId: n.name as string });
		}
		const patch = propertyPatch(p, n, MODULE_PATCH_SKIP);
		if (Object.keys(patch).length > 0) {
			updates.push({
				kind: "updateModule",
				uuid,
				patch: patch as Extract<Mutation, { kind: "updateModule" }>["patch"],
			});
		}
		if (menuMediaChanged(p, n)) {
			media.push({
				kind: "setModuleMedia",
				uuid,
				icon: nextModule.icon ?? null,
				audioLabel: nextModule.audioLabel ?? null,
			});
		}
		// `caseListConfig` is excluded from the generic patch — its content is
		// diffed into an idempotent birth plus granular column / search-input /
		// `setCaseListMeta` kinds. A case-type flip never snapshots the config;
		// only an explicit config removal uses `updateModule{caseListConfig:null}`.
		collections.push(
			...diffCaseListConfig(prevModule, nextModule, uuid),
			...diffCaseSearchConfig(prevModule, nextModule, uuid),
		);
	}

	// Forms.
	for (const uuid of formDelta.common) {
		const prevForm = ownRecordValue(prev.forms, uuid) as Form;
		const nextForm = ownRecordValue(next.forms, uuid) as Form;
		const p = prevForm as unknown as Record<string, unknown>;
		const n = nextForm as unknown as Record<string, unknown>;
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
		updates.push(...diffCaseOperations(prevForm, nextForm, uuid));
		if (menuMediaChanged(p, n)) {
			media.push({
				kind: "setFormMedia",
				uuid,
				icon: nextForm.icon ?? null,
				audioLabel: nextForm.audioLabel ?? null,
			});
		}
	}

	// Fields.
	//
	// Field ids and `caseWrite` bindings ride their per-kind UUID-local
	// `updateField` patches. An app-wide property rename was proved and returned
	// above as the batch-exclusive semantic command; this ordinary path never
	// guesses migration intent from one field.
	for (const uuid of fieldDelta.common) {
		const pField = ownRecordValue(prev.fields, uuid) as Field;
		const nField = ownRecordValue(next.fields, uuid) as Field;
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
				...(convertNeedsOptionSeed(pField, nField.kind) &&
					"optionsSource" in nField && {
						optionsSource: cloneEntity(nField.optionsSource),
					}),
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
			? fieldPatchForConvertedField(p, n, nField.kind, skip)
			: propertyPatch(p, n, skip);
		const previousOptionsSource =
			"optionsSource" in pField ? pField.optionsSource : undefined;
		const nextOptionsSource =
			"optionsSource" in nField ? nField.optionsSource : undefined;
		const optionsSourceChanged =
			(nField.kind === "single_select" || nField.kind === "multi_select") &&
			!deepEqual(previousOptionsSource, nextOptionsSource);
		const bothInline =
			previousOptionsSource?.kind === "inline" &&
			nextOptionsSource?.kind === "inline";
		const sourceNeedsAtomicReplacement =
			optionsSourceChanged &&
			!bothInline &&
			!convertNeedsOptionSeed(pField, nField.kind);
		if (sourceNeedsAtomicReplacement) {
			patch.optionsSource = cloneEntity(nextOptionsSource);
		}
		if (Object.keys(patch).length > 0) {
			updates.push({
				kind: "updateField",
				uuid,
				targetKind: nField.kind,
				patch,
			} as Mutation);
		}

		// Field message media — one `setFieldMedia` per changed slot.
		media.push(...diffFieldMedia(p, n, uuid));

		// Select options — diffed per-uuid into the granular option kinds (a
		// content change excludes `order`/`uuid`; an `order` shift emits a
		// `moveOption`). A field added this batch carries its options inline on
		// `addField`, so the option diff runs for COMMON fields only.
		if (bothInline) {
			collections.push(...diffOptions(pField, nField, uuid));
		}
	}

	// (5) Module order — `moduleOrder` IS the sequence, so the reorder is
	// whatever moves turn the previous array into the next one, measured against
	// the sequence the `addModule`s have already landed in.
	for (const move of sequenceMovesTo(
		arrivalsProjected(prev.moduleOrder, next.moduleOrder),
		next.moduleOrder,
	)) {
		orders.push({ kind: "moveModule", uuid: move.uuid, after: move.after });
	}

	// Form structural — cross-module moves (including forms evacuated out of
	// removed modules) plus same-module sequence changes.
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
	// `(type, property)` name so a co-member's concurrent catalog add survives
	// the re-apply.
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
		? produce(prev, (draft) => {
				applyMutations(draft, admitMutationBatch(structural));
			}).caseTypes
		: prev.caseTypes;
	structural.push(...diffCatalog(fromCatalog, next.caseTypes));
	const localizationBase =
		structural.length === 0
			? prev
			: produce(prev, (draft) => {
					applyMutations(draft, admitMutationBatch(structural));
				});
	structural.push(...diffLocalization(localizationBase, next));

	return structural;
}

export class LocalizationEndpointNotRepresentableError extends Error {
	readonly name = "LocalizationEndpointNotRepresentableError";

	constructor() {
		super(
			"The localization endpoint changes source identity or language order in a way the product mutation dialect cannot represent.",
		);
	}
}

/** Diff app-language metadata and per-unit overlays after structural edits. */
function diffLocalization(prev: BlueprintDoc, next: BlueprintDoc): Mutation[] {
	if (deepEqual(prev.localization, next.localization)) return [];
	const out: Mutation[] = [];
	const before = effectiveAppLocalization(prev.localization);
	const after = effectiveAppLocalization(next.localization);

	if (before.sourceLanguage !== after.sourceLanguage) {
		if (before.languageOrder.length !== 1 || after.languageOrder.length !== 1) {
			throw new LocalizationEndpointNotRepresentableError();
		}
		out.push({
			kind: "relabelSourceLanguage",
			language: parseLanguageTag(after.sourceLanguage),
		});
	}

	let working = produce(prev, (draft) => {
		applyMutations(draft, out);
	});
	let current = effectiveAppLocalization(working.localization);
	for (const tag of after.languageOrder) {
		if (!current.languageOrder.includes(tag)) {
			out.push({ kind: "addLanguage", language: parseLanguageTag(tag) });
		}
	}
	working = produce(prev, (draft) => {
		applyMutations(draft, out);
	});
	current = effectiveAppLocalization(working.localization);
	if (current.defaultLanguage !== after.defaultLanguage) {
		out.push({ kind: "setDefaultLanguage", code: after.defaultLanguage });
	}
	for (const tag of current.languageOrder) {
		if (!after.languageOrder.includes(tag)) {
			out.push({ kind: "removeLanguage", code: tag });
		}
	}

	working = produce(prev, (draft) => {
		applyMutations(draft, out);
	});
	current = effectiveAppLocalization(working.localization);
	if (
		!deepEqual(current.languageOrder, after.languageOrder) ||
		current.sourceLanguage !== after.sourceLanguage
	) {
		throw new LocalizationEndpointNotRepresentableError();
	}
	for (const code of after.languageOrder) {
		if (code === after.sourceLanguage) continue;
		const currentEntries = current.translations[code] ?? {};
		const nextEntries = after.translations[code] ?? {};
		for (const [unitId, entry] of Object.entries(nextEntries)) {
			if (!deepEqual(currentEntries[unitId], entry)) {
				out.push({
					kind: "setTranslation",
					language: code,
					unitId,
					entry: cloneEntity(entry),
				});
			}
		}
		for (const unitId of Object.keys(currentEntries)) {
			if (nextEntries[unitId] === undefined) {
				out.push({
					kind: "setTranslation",
					language: code,
					unitId,
					entry: null,
				});
			}
		}
	}

	const replayed = produce(prev, (draft) => {
		applyMutations(draft, out);
	});
	if (!deepEqual(replayed.localization, next.localization)) {
		throw new LocalizationEndpointNotRepresentableError();
	}
	return out;
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
	// Births precede edits so every rank-bearing move is evaluated against the
	// batch's complete final membership by the authoritative conflict guard.
	for (const [uuid, operation] of after) {
		if (before.has(uuid)) continue;
		mutations.push({
			kind: "updateForm",
			uuid: formUuid,
			patch: {},
			caseOperationChange: {
				operation: "add",
				value: caseOperationSchema.parse(cloneEntity(operation)),
			},
		});
	}
	for (const [uuid, operation] of after) {
		const prior = before.get(uuid);
		if (prior === undefined) continue;
		mutations.push(
			...caseOperationChangesForUpdate(formUuid, prior, cloneEntity(operation)),
		);
	}
	// Reorders last, against the PROJECTED sequence: removes have taken their
	// operations out and adds have appended theirs, so a move computed against
	// `prev` would name a position that never exists. Two docs cannot say which
	// operation the author dragged, so this derives the moves that reach the
	// target rather than reproducing a gesture.
	const projected = [
		...(prev.caseOperations ?? [])
			.map((operation) => operation.uuid)
			.filter((uuid) => after.has(uuid)),
		...(next.caseOperations ?? [])
			.map((operation) => operation.uuid)
			.filter((uuid) => !before.has(uuid)),
	];
	for (const move of sequenceMovesTo(
		projected,
		(next.caseOperations ?? []).map((operation) => operation.uuid),
	)) {
		mutations.push({
			kind: "updateForm",
			uuid: formUuid,
			patch: {},
			caseOperationPatch: {
				operation: "move",
				uuid: move.uuid,
				after: move.after,
			},
		});
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
 * clear any non-skipped DESTINATION key that could have survived the
 * carry-over but is absent in `next`. Source-only keys are already dropped
 * by `convertField`; emitting them as `null` would put a key the destination
 * schema does not own into its strict patch.
 */
function fieldPatchForConvertedField(
	prev: Record<string, unknown>,
	next: Record<string, unknown>,
	targetKind: Field["kind"],
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
		if (fieldKindDeclaresKey(targetKind, key) && !Object.hasOwn(next, key)) {
			patch[key] = null;
		}
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
		if (order.includes(formUuid)) return asUuid(moduleUuid);
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
	return (
		ownRecordValue(next.forms, parent) === undefined &&
		ownRecordValue(next.fields, parent) === undefined
	);
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

	// A form that CHANGED MODULE is a relocation: it needs a move naming its
	// placement in the destination, and it may need to travel before the
	// removes if the module it is leaving is itself being removed.
	const relocated = new Set<Uuid>();
	for (const formUuid of formDelta.common) {
		const nextModule = nextModuleOf.get(formUuid);
		if (nextModule === undefined) continue; // unreachable in next (shouldn't happen)
		const prevModule = prevModuleOf.get(formUuid);
		if (prevModule === nextModule) continue;
		relocated.add(formUuid);
		const destination = next.formOrder[nextModule] ?? [];
		const at = destination.indexOf(formUuid);
		const move: Mutation = {
			kind: "moveForm",
			uuid: formUuid,
			toModuleUuid: nextModule,
			after: at > 0 ? (destination[at - 1] ?? null) : null,
		};
		// A form leaving a REMOVED module evacuates before the cascade.
		if (
			prevModule !== undefined &&
			ownRecordValue(next.modules, prevModule) === undefined
		) {
			evacuations.push(move);
		} else {
			rest.push(move);
		}
	}

	// Everything else is a same-module reorder, which is whatever moves are still
	// needed once the adds and the relocations above have landed — so it is
	// measured against that projected sequence, not against `prev`. A form that
	// relocated already carries its placement, so it is never moved twice.
	for (const [moduleUuid, nextOrder] of Object.entries(next.formOrder)) {
		const before = (prev.formOrder[moduleUuid] ?? []).filter(
			(uuid) => !relocated.has(uuid),
		);
		for (const move of sequenceMovesTo(
			arrivalsProjected(before, nextOrder),
			nextOrder,
		)) {
			if (relocated.has(move.uuid)) continue;
			rest.push({
				kind: "moveForm",
				uuid: move.uuid,
				toModuleUuid: asUuid(moduleUuid),
				after: move.after,
			});
		}
	}

	return { evacuations, rest };
}

/** Child form uuid → owning module uuid, from `formOrder`. */
function buildFormModuleMap(doc: BlueprintDoc): Map<Uuid, Uuid> {
	const out = new Map<Uuid, Uuid>();
	for (const [moduleUuid, order] of Object.entries(doc.formOrder)) {
		for (const formUuid of order) out.set(formUuid, asUuid(moduleUuid));
	}
	return out;
}
/**
 * Reconcile the field tree to `next` — field ADDS, cross-parent MOVES, and
 * same-parent reorders.
 *
 * Membership (adds / cross-parent moves) is detected by parent-set comparison;
 * a REORDER is a changed position in a common parent's membership array, which
 * IS the sequence. Adds are emitted parent-before-child (top-down parents, in
 * sequence order) so a container lands before the fields it holds; each names
 * the sibling it follows. A cross-parent move names its anchor in the
 * destination and preserves the field's id.
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
} {
	const evacuations: Mutation[] = [];
	const adds: Mutation[] = [];
	const moves: Mutation[] = [];
	const addedFieldSet = new Set(fieldDelta.added);

	// A prev parent is "doomed" when it won't exist after the removes — a
	// removed form or container field (covers parents under a removed module).
	const isDoomed = (parentUuid: Uuid | undefined): boolean =>
		parentUuid !== undefined &&
		ownRecordValue(next.forms, parentUuid) === undefined &&
		ownRecordValue(next.fields, parentUuid) === undefined;

	// Adds — parent-before-child (top-down parents, in sequence order). Each
	// append is deliberately anchor-free. A predecessor in `next` may itself
	// be a cross-parent arrival that has not landed yet; naming that absent
	// anchor makes the total reducer leave the membership array unchanged while
	// still inserting the field record, producing an orphan that no later move
	// can recover (its containing form is then unknowable). Appending guarantees
	// every birth is structurally valid. The projected-sequence pass below sees
	// the actual append, folds the later arrivals, and emits whatever final
	// placement moves are still required.
	for (const parentUuid of nextParentsTopDown(next)) {
		const sequence = orderedFieldUuids(next, parentUuid);
		for (const uuid of sequence) {
			if (!addedFieldSet.has(uuid)) continue;
			const field = cloneEntity(
				ownRecordValue(next.fields, uuid) as Field,
			) as Field;
			adds.push({
				kind: "addField",
				parentUuid,
				field,
			});
		}
	}

	// Cross-parent moves first: a field that changed parent carries its
	// placement in the DESTINATION, and evacuates ahead of the removes when the
	// parent it is leaving is itself doomed.
	for (const uuid of fieldDelta.common) {
		const nextParent = nextParentMap.get(uuid);
		if (nextParent === undefined) continue; // unreachable in next (shouldn't happen)
		const prevParent = prevParentMap.get(uuid);
		if (prevParent === nextParent) continue;
		const destination = next.fieldOrder[nextParent] ?? [];
		const at = destination.indexOf(uuid);
		const move: Mutation = {
			kind: "moveField",
			uuid,
			toParentUuid: nextParent,
			after: at > 0 ? (destination[at - 1] ?? null) : null,
		};
		if (isDoomed(prevParent)) evacuations.push(move);
		else moves.push(move);
	}

	// Same-parent reorders are whatever moves are still needed once everything
	// emitted ABOVE has landed — so they diff against the PROJECTED sequence,
	// not `prev`. An add and an arrival each carry an anchor read off `next`,
	// but they apply against a document whose surrounding entities have not
	// moved yet, so they can land somewhere `next` doesn't have them. Folding
	// them through the same `spliceAfter` the reducer runs is what lets this
	// pass finish the job instead of computing a move from a state that never
	// exists.
	const projected = new Map<string, Uuid[]>();
	for (const [parentUuid, nextOrder] of Object.entries(next.fieldOrder)) {
		const survives = new Set(nextOrder);
		projected.set(
			parentUuid,
			(prev.fieldOrder[parentUuid] ?? []).filter((uuid) => survives.has(uuid)),
		);
	}
	for (const mutation of [...evacuations, ...adds, ...moves]) {
		if (mutation.kind === "addField") {
			const parentUuid = mutation.parentUuid;
			projected.set(
				parentUuid,
				spliceAfter(
					projected.get(parentUuid) ?? [],
					mutation.field.uuid,
					mutation.after,
				),
			);
		} else if (mutation.kind === "moveField") {
			const parentUuid = mutation.toParentUuid;
			projected.set(
				parentUuid,
				spliceAfter(
					projected.get(parentUuid) ?? [],
					mutation.uuid,
					mutation.after,
				),
			);
		}
	}
	for (const [parentUuid, nextOrder] of Object.entries(next.fieldOrder)) {
		for (const move of sequenceMovesTo(
			projected.get(parentUuid) ?? [],
			nextOrder,
		)) {
			moves.push({
				kind: "moveField",
				uuid: move.uuid,
				toParentUuid: asUuid(parentUuid),
				after: move.after,
			});
		}
	}

	// An evacuation's DESTINATION may itself be a container ADDED in this diff
	// (create group G, drag X out of doomed H into G, delete H — one batch).
	// Field adds otherwise emit AFTER the removes, so the batch would reference
	// a not-yet-existing container mid-replay: `mutationTargetsInvalid` runs in
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

	return { evacuations, rest: [...adds, ...moves] };
}

/**
 * Every field parent in `next` (forms then container fields), top-down in
 * membership-array order: forms in module → form order, then container fields
 * in pre-order. A top-down order means a parent is always
 * visited before any parent nested inside it.
 */
function nextParentsTopDown(next: BlueprintDoc): Uuid[] {
	const parents: Uuid[] = [];
	for (const moduleUuid of orderedModuleUuids(next)) {
		for (const formUuid of orderedFormUuids(next, moduleUuid)) {
			parents.push(formUuid);
			for (const { uuid } of walkFieldTree(next, formUuid)) {
				const field = ownRecordValue(next.fields, uuid);
				if (field && (field.kind === "group" || field.kind === "repeat")) {
					parents.push(uuid);
				}
			}
		}
	}
	return parents;
}

// ── Granular collection + catalog diffs ──────────────────────────────

/** Deep-equal two values ignoring a collection item's sequence key. */
function contentEqualIgnoringOrder(a: unknown, b: unknown): boolean {
	return deepEqual(stripOrder(a), stripOrder(b));
}

function stripOrder(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}
	const { order: _order, ...rest } = value as Record<string, unknown>;
	return rest;
}

/**
 * Diff a module's `caseListConfig`. Birth is an idempotent semantic edit,
 * followed by the same granular column / search-input / `setCaseListMeta`
 * kinds used for ordinary content edits. Reapplying that batch over a
 * peer-populated config therefore merges by item uuid.
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
				patch: { caseListConfig: null },
			},
		];
	}
	const birth: Mutation[] =
		prevConfig === undefined
			? [
					{
						kind: "updateModule",
						uuid: moduleUuid,
						patch: {},
						ensureCaseListConfig: true,
					},
				]
			: [];
	const prevC = prevConfig ?? emptyCaseListConfig();
	return [
		...birth,
		...diffColumns(prevC, nextConfig, moduleUuid),
		...diffSearchInputs(
			prevC.searchInputs,
			nextConfig.searchInputs,
			moduleUuid,
		),
		...diffCaseListMeta(prevC, nextConfig, moduleUuid),
	];
}

/**
 * Columns are the one collection with TWO sequences, so their diff derives both
 * independently — a Results reorder and a Details reorder are separate moves,
 * and an author who changed only one must not emit a move for the other.
 */
function diffColumns(
	prev: CaseListConfig,
	next: CaseListConfig,
	moduleUuid: Uuid,
): Mutation[] {
	const out: Mutation[] = [];
	const prevByUuid = new Map(prev.columns.map((c) => [c.uuid, c]));
	const nextUuids = new Set(next.columns.map((c) => c.uuid));
	for (const col of next.columns) {
		const p = prevByUuid.get(col.uuid);
		if (!p) {
			out.push(
				columnAddMutation(moduleUuid, cloneEntity(col), {
					afterInList: predecessorIn(next.listColumnOrder, col.uuid),
					afterInDetail: predecessorIn(next.detailColumnOrder, col.uuid),
				}),
			);
			continue;
		}
		out.push(...columnSnapshotMutations(moduleUuid, p, cloneEntity(col)));
	}
	for (const [surface, before, after] of [
		["list", prev.listColumnOrder, next.listColumnOrder],
		["detail", prev.detailColumnOrder, next.detailColumnOrder],
	] as const) {
		// Against the sequence the adds above have already landed in — a column
		// added at the top of Results is in place before these moves run.
		for (const move of sequenceMovesTo(
			arrivalsProjected(before, after),
			after,
		)) {
			out.push({
				kind: "moveColumn",
				moduleUuid,
				uuid: move.uuid,
				surface,
				after: move.after,
			});
		}
	}
	for (const col of prev.columns) {
		if (!nextUuids.has(col.uuid)) {
			out.push({ kind: "removeColumn", moduleUuid, uuid: col.uuid });
		}
	}
	return out;
}

/** The uuid an entry follows in a sequence, or `null` when it leads it. */
function predecessorIn<Id extends string>(
	sequence: readonly Id[],
	uuid: Id,
): Id | null {
	const at = sequence.indexOf(uuid);
	return at > 0 ? (sequence[at - 1] as Id) : null;
}

/**
 * `prev` with the removals dropped and the newcomers spliced in where their
 * adds put them — the sequence that actually exists by the time the moves pass
 * runs.
 *
 * Every add in this file carries an anchor read off `next`, but it applies to a
 * document whose surviving entities have not moved yet, so it can land
 * somewhere `next` doesn't have it. Diffing the moves against `prev` would then
 * compute them from a state that never exists, and the reorder lands wrong.
 * Folding the arrivals through the same `spliceAfter` the reducer runs is what
 * lets the moves pass finish the job.
 */
function arrivalsProjected<Id extends string>(
	before: readonly Id[],
	after: readonly Id[],
): Id[] {
	const survives = new Set(after);
	const held = new Set(before);
	let projected = before.filter((uuid) => survives.has(uuid));
	for (const uuid of after) {
		if (held.has(uuid)) continue;
		projected = spliceAfter(projected, uuid, predecessorIn(after, uuid));
	}
	return projected;
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
				after: predecessorIn(
					next.map((i) => i.uuid),
					input.uuid,
				),
			});
			continue;
		}
		if (!contentEqualIgnoringOrder(p, input)) {
			out.push(searchInputUpdateMutation(moduleUuid, p, cloneEntity(input)));
		}
	}
	// `searchInputs` IS the sequence, so a reorder is whatever moves turn the
	// previous array into the next one — measured against the sequence the adds
	// above have already landed in, not against `prev`.
	for (const move of sequenceMovesTo(
		arrivalsProjected(
			prev.map((i) => i.uuid),
			next.map((i) => i.uuid),
		),
		next.map((i) => i.uuid),
	)) {
		out.push({
			kind: "moveSearchInput",
			moduleUuid,
			uuid: move.uuid,
			after: move.after,
		});
	}
	for (const input of prev) {
		if (!nextUuids.has(input.uuid)) {
			out.push({ kind: "removeSearchInput", moduleUuid, uuid: input.uuid });
		}
	}
	return out;
}

/** The case-list's non-array metadata. A clear travels as `null`. */
function diffCaseListMeta(
	prev: CaseListConfig,
	next: CaseListConfig,
	moduleUuid: Uuid,
): Mutation[] {
	const patch: {
		filter?: CaseListConfig["filter"] | null;
		icon?: CaseListConfig["icon"] | null;
		audioLabel?: CaseListConfig["audioLabel"] | null;
		tile?: CaseListConfig["tile"] | null;
	} = {};
	if (!deepEqual(prev.filter, next.filter)) {
		patch.filter = next.filter === undefined ? null : cloneEntity(next.filter);
	}
	if (prev.icon !== next.icon) patch.icon = next.icon ?? null;
	if (prev.audioLabel !== next.audioLabel) {
		patch.audioLabel = next.audioLabel ?? null;
	}
	const tileChanged = !deepEqual(prev.tile, next.tile);
	if (tileChanged) {
		patch.tile = next.tile === undefined ? null : cloneEntity(next.tile);
	}
	if (Object.keys(patch).length === 0 && !tileChanged) return [];
	return [
		{
			kind: "setCaseListMeta",
			uuid: moduleUuid,
			patch,
		},
	];
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
	if (
		isOwnerOnlyCaseSearchConfig(prev) &&
		next !== undefined &&
		!isOwnerOnlyCaseSearchConfig(next)
	) {
		const enabled = { excludedOwnerIds: prev.excludedOwnerIds };
		if (deepEqual(enabled, next)) {
			return [enableCaseSearchMutation(moduleUuid, next)];
		}
	}

	const prevIsMarker =
		prev !== undefined &&
		!isOwnerOnlyCaseSearchConfig(prev) &&
		!caseSearchConfigHasAuthoredSettings(prev);
	const nextIsMarker =
		next !== undefined &&
		!isOwnerOnlyCaseSearchConfig(next) &&
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
	if (isOwnerOnlyCaseSearchConfig(next)) {
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

/** Lower one module's authored config snapshot change to the final granular
 * mutation dialect. No whole present-config snapshot crosses this boundary. */
export function diffModuleConfigMutations(
	prevMod: Module,
	nextMod: Module,
): Mutation[] {
	return [
		...diffCaseListConfig(prevMod, nextMod, prevMod.uuid),
		...diffCaseSearchConfig(prevMod, nextMod, prevMod.uuid),
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
	for (const o of prevOpts) prevByUuid.set(o.uuid, o);
	const nextUuids = new Set<string>();
	for (const opt of nextOpts) {
		nextUuids.add(opt.uuid);
		const p = prevByUuid.get(opt.uuid);
		if (!p) {
			out.push({
				kind: "addOption",
				fieldUuid,
				option: cloneEntity(opt),
				after: predecessorIn(
					nextOpts.map((o) => o.uuid),
					opt.uuid,
				),
			});
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
	}
	// The inline `options` array IS the sequence. Every option has stable
	// identity; moves run against the sequence the adds above landed in.
	for (const move of sequenceMovesTo(
		arrivalsProjected(
			prevOpts.map((o) => o.uuid),
			nextOpts.map((o) => o.uuid),
		),
		nextOpts.map((o) => o.uuid),
	)) {
		out.push({
			kind: "moveOption",
			fieldUuid,
			uuid: move.uuid,
			after: move.after,
		});
	}
	for (const o of prevOpts) {
		if (!nextUuids.has(o.uuid)) {
			out.push({ kind: "removeOption", fieldUuid, uuid: o.uuid });
		}
	}
	return out;
}

function optionsOf(field: Field): readonly SelectOption[] {
	return "optionsSource" in field && field.optionsSource.kind === "inline"
		? field.optionsSource.options
		: [];
}

/**
 * Diff the case-type catalog from → to into granular catalog mutations,
 * keyed by `(type, property)` name. Order: declare new types FIRST (so an
 * `addCaseProperty` targeting one has its type), then per-type meta + property
 * edits, then retire gone types last. Replaying these on `from` reproduces
 * `to`.
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
		for (const [propertyIndex, prop] of toCt.properties.entries()) {
			const fp = fromProps.get(prop.name);
			if (!fp) {
				const after =
					propertyIndex === toCt.properties.length - 1
						? undefined
						: propertyIndex === 0
							? null
							: toCt.properties[propertyIndex - 1]?.name;
				out.push({
					kind: "addCaseProperty",
					caseType: toCt.name,
					property: cloneEntity(prop),
					...(after !== undefined ? { after } : {}),
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

/**
 * The three flat user collections — the property catalog, the roles, and
 * the personas.
 *
 * Each is a UUID-keyed record whose entities carry no nested collections,
 * so one add / update / remove shape covers all three: an entity present
 * only in `next` is an add, one whose content changed is a whole-entity
 * update patch (concrete objects survive JSON, so a rebuilt `values` bag
 * clears a key by omitting it), and one present only in `prev` is a
 * remove. Removal CASCADES are not derived here — the planners in
 * `userMutations.ts` emit the rewritten value bags alongside the removal,
 * and the diff sees those as ordinary updates.
 */
function diffUserCollections(
	prev: BlueprintDoc,
	next: BlueprintDoc,
): Mutation[] {
	const out: Mutation[] = [];
	const prevProps = prev.userProperties ?? {};
	const nextProps = next.userProperties ?? {};
	// Walk the SEQUENCE, not the record's key order, and carry each add's
	// placement — the uuid it follows in the target, `null` for first. A record
	// has no order to read, so an add derived from key iteration would land
	// wherever the object happened to enumerate.
	for (const [index, uuid] of (next.userPropertyOrder ?? []).entries()) {
		const property = ownRecordValue(nextProps, uuid);
		if (property === undefined) continue;
		const before = ownRecordValue(prevProps, uuid);
		if (!before) {
			out.push({
				kind: "addUserProperty",
				property: cloneEntity(property),
				after:
					index === 0
						? null
						: asUuid(next.userPropertyOrder?.[index - 1] ?? ""),
			});
		} else if (!deepEqual(before, property)) {
			out.push({
				kind: "updateUserProperty",
				uuid: asUuid(uuid),
				patch: userPatch(before, property),
			});
		}
	}
	for (const uuid of Object.keys(prevProps)) {
		if (!hasOwnRecordKey(nextProps, uuid)) {
			out.push({ kind: "removeUserProperty", uuid: asUuid(uuid) });
		}
	}

	const prevTypes = prev.userTypes ?? {};
	const nextTypes = next.userTypes ?? {};
	for (const [index, uuid] of (next.userTypeOrder ?? []).entries()) {
		const userType = ownRecordValue(nextTypes, uuid);
		if (userType === undefined) continue;
		const before = ownRecordValue(prevTypes, uuid);
		if (!before) {
			out.push({
				kind: "addUserType",
				userType: cloneEntity(userType),
				after:
					index === 0 ? null : asUuid(next.userTypeOrder?.[index - 1] ?? ""),
			});
		} else if (!deepEqual(before, userType)) {
			out.push(
				...updateUserTypeMutations(
					prev,
					asUuid(uuid),
					userPatch(before, userType),
				),
			);
		}
	}
	for (const uuid of Object.keys(prevTypes)) {
		if (!hasOwnRecordKey(nextTypes, uuid)) {
			out.push({ kind: "removeUserType", uuid: asUuid(uuid) });
		}
	}

	const prevPersonas = prev.personas ?? {};
	const nextPersonas = next.personas ?? {};
	for (const [index, uuid] of (next.personaOrder ?? []).entries()) {
		const persona = ownRecordValue(nextPersonas, uuid);
		if (persona === undefined) continue;
		const before = ownRecordValue(prevPersonas, uuid);
		if (!before) {
			out.push({
				kind: "addPersona",
				persona: cloneEntity(persona),
				after:
					index === 0 ? null : asUuid(next.personaOrder?.[index - 1] ?? ""),
			});
		} else if (!deepEqual(before, persona)) {
			out.push(
				...updatePersonaMutations(
					prev,
					asUuid(uuid),
					userPatch(before, persona),
				),
			);
		}
	}
	for (const uuid of Object.keys(prevPersonas)) {
		if (!hasOwnRecordKey(nextPersonas, uuid)) {
			out.push({ kind: "removePersona", uuid: asUuid(uuid) });
		}
	}
	return out;
}

type AutomationItem = { readonly uuid: Uuid };
type AutomationItemCollection =
	| "criterion"
	| "setup-only-criterion"
	| "update"
	| "recipient"
	| "immediate-event"
	| "timed-event"
	| "user-data-filter";

function automationItemMutation(value: unknown): Mutation {
	return mutationSchema.parse(value);
}

function diffAutomationItems(
	automationUuid: Uuid,
	targetKind: Automation["kind"],
	collection: AutomationItemCollection,
	before: readonly AutomationItem[],
	after: readonly AutomationItem[],
): Mutation[] {
	const out: Mutation[] = [];
	const beforeByUuid = new Map(before.map((item) => [item.uuid, item]));
	const afterByUuid = new Map(after.map((item) => [item.uuid, item]));
	for (const [index, item] of after.entries()) {
		const previous = beforeByUuid.get(item.uuid);
		if (previous === undefined) {
			out.push(
				automationItemMutation({
					kind: "editAutomationItem",
					automationUuid,
					targetKind,
					edit: {
						collection,
						operation: "add",
						value: cloneEntity(item),
						after: index === 0 ? null : after[index - 1]?.uuid,
					},
				}),
			);
		} else if (!deepEqual(previous, item)) {
			out.push(
				automationItemMutation({
					kind: "editAutomationItem",
					automationUuid,
					targetKind,
					edit: {
						collection,
						operation: "update",
						value: cloneEntity(item),
					},
				}),
			);
		}
	}
	for (const item of before) {
		if (afterByUuid.has(item.uuid)) continue;
		out.push(
			automationItemMutation({
				kind: "editAutomationItem",
				automationUuid,
				targetKind,
				edit: { collection, operation: "remove", uuid: item.uuid },
			}),
		);
	}
	for (const move of sequenceMovesTo(
		arrivalsProjected(
			before.map((item) => item.uuid),
			after.map((item) => item.uuid),
		),
		after.map((item) => item.uuid),
	)) {
		out.push(
			automationItemMutation({
				kind: "editAutomationItem",
				automationUuid,
				targetKind,
				edit: {
					collection,
					operation: "move",
					uuid: move.uuid,
					after: move.after,
				},
			}),
		);
	}
	return out;
}

export function automationChangesForUpdate(
	before: Automation,
	after: Automation,
): Mutation[] {
	if (before.kind !== after.kind) {
		throw new Error("An automation's kind is create-once.");
	}
	const out: Mutation[] = [];
	const patch = userPatch(before, after) as Record<string, unknown>;
	for (const key of [
		"kind",
		"criteria",
		"setupOnlyCriteria",
		"updates",
		"recipients",
		"schedule",
		"userDataFilters",
	]) {
		delete patch[key];
	}
	if (Object.keys(patch).length > 0) {
		out.push(
			mutationSchema.parse({
				kind: "updateAutomation",
				uuid: after.uuid,
				targetKind: after.kind,
				patch,
			}),
		);
	}
	out.push(
		...diffAutomationItems(
			after.uuid,
			after.kind,
			"criterion",
			before.criteria,
			after.criteria,
		),
		...diffAutomationItems(
			after.uuid,
			after.kind,
			"setup-only-criterion",
			before.setupOnlyCriteria,
			after.setupOnlyCriteria,
		),
	);
	if (before.kind === "case-update" && after.kind === "case-update") {
		out.push(
			...diffAutomationItems(
				after.uuid,
				after.kind,
				"update",
				before.updates,
				after.updates,
			),
		);
		return out;
	}
	if (
		before.kind !== "conditional-alert" ||
		after.kind !== "conditional-alert"
	) {
		return out;
	}
	out.push(
		...diffAutomationItems(
			after.uuid,
			after.kind,
			"recipient",
			before.recipients,
			after.recipients,
		),
		...diffAutomationItems(
			after.uuid,
			after.kind,
			"user-data-filter",
			before.userDataFilters,
			after.userDataFilters,
		),
	);
	if (before.schedule.kind !== after.schedule.kind) {
		out.push({
			kind: "setAutomationSchedule",
			uuid: after.uuid,
			schedule: cloneEntity(after.schedule),
		});
		return out;
	}
	if (
		before.schedule.kind === "immediate" &&
		after.schedule.kind === "immediate"
	) {
		out.push(
			...diffAutomationItems(
				after.uuid,
				after.kind,
				"immediate-event",
				before.schedule.events,
				after.schedule.events,
			),
		);
		return out;
	}
	if (before.schedule.kind === "timed" && after.schedule.kind === "timed") {
		const schedulePatch: Record<string, unknown> = {};
		for (const key of [
			"repeatEvery",
			"totalIterations",
			"startOffsetDays",
			"startDayOfWeek",
			"start",
		] as const) {
			if (!deepEqual(before.schedule[key], after.schedule[key])) {
				schedulePatch[key] = cloneEntity(after.schedule[key]);
			}
		}
		if (Object.keys(schedulePatch).length > 0) {
			out.push(
				mutationSchema.parse({
					kind: "updateAutomationSchedule",
					uuid: after.uuid,
					patch: schedulePatch,
				}),
			);
		}
		out.push(
			...diffAutomationItems(
				after.uuid,
				after.kind,
				"timed-event",
				before.schedule.events,
				after.schedule.events,
			),
		);
	}
	return out;
}

function diffAutomationCollections(
	prev: BlueprintDoc,
	next: BlueprintDoc,
): Mutation[] {
	const out: Mutation[] = [];
	const prevRecord = prev.automations ?? {};
	const nextRecord = next.automations ?? {};
	for (const [index, uuid] of (next.automationOrder ?? []).entries()) {
		const automation = ownRecordValue(nextRecord, uuid);
		if (automation === undefined) continue;
		const before = ownRecordValue(prevRecord, uuid);
		if (before === undefined) {
			out.push({
				kind: "addAutomation",
				automation: cloneEntity(automation),
				after: index === 0 ? null : next.automationOrder?.[index - 1],
			});
		} else {
			out.push(...automationChangesForUpdate(before, automation));
		}
	}
	for (const uuid of Object.keys(prevRecord)) {
		if (!hasOwnRecordKey(nextRecord, uuid)) {
			const automation = ownRecordValue(prevRecord, uuid);
			if (automation !== undefined) {
				out.push({
					kind: "removeAutomation",
					uuid: asUuid(uuid),
					targetKind: automation.kind,
				});
			}
		}
	}
	for (const move of sequenceMovesTo(
		arrivalsProjected(prev.automationOrder ?? [], next.automationOrder ?? []),
		next.automationOrder ?? [],
	)) {
		const automation = ownRecordValue(nextRecord, move.uuid);
		if (automation !== undefined) {
			out.push({
				kind: "moveAutomation",
				uuid: move.uuid,
				targetKind: automation.kind,
				after: move.after,
			});
		}
	}
	return out;
}

/** The Blueprint-owned organization shape, using its exact membership arrays. */
function diffOrganizationCollections(
	prev: BlueprintDoc,
	next: BlueprintDoc,
): Mutation[] {
	const out: Mutation[] = [];
	const prevLevels = prev.organizationLevels ?? {};
	const nextLevels = next.organizationLevels ?? {};
	assertExistingRelativeOrderPreserved(
		prev.organizationLevelOrder ?? [],
		next.organizationLevelOrder ?? [],
		"organization levels",
	);
	const nextLevelOrder = next.organizationLevelOrder ?? [];
	const availableLevels = new Set(prev.organizationLevelOrder ?? []);
	const pendingLevelAdds = nextLevelOrder.filter(
		(uuid) => ownRecordValue(prevLevels, uuid) === undefined,
	);
	while (pendingLevelAdds.length > 0) {
		const readyIndex = pendingLevelAdds.findIndex((uuid) => {
			const parent = ownRecordValue(nextLevels, uuid)?.parentLevelUuid;
			return parent === undefined || availableLevels.has(parent);
		});
		if (readyIndex === -1) {
			throw new Error(
				"New organization levels cannot be ordered after their parent dependencies.",
			);
		}
		const [uuid] = pendingLevelAdds.splice(readyIndex, 1);
		if (uuid === undefined) continue;
		const level = ownRecordValue(nextLevels, uuid);
		if (level === undefined) continue;
		const displayIndex = nextLevelOrder.indexOf(uuid);
		let after: Uuid | null = null;
		for (let index = displayIndex - 1; index >= 0; index--) {
			const predecessor = nextLevelOrder[index];
			if (predecessor !== undefined && availableLevels.has(predecessor)) {
				after = predecessor;
				break;
			}
		}
		out.push({
			kind: "addOrganizationLevel",
			level: cloneEntity(level),
			after,
		});
		availableLevels.add(uuid);
	}
	// Existing rows may now safely reparent to any level added above. Emitting
	// updates in display order before additions made a valid whole-document
	// target impossible whenever its new parent appeared later in the sequence.
	for (const uuid of nextLevelOrder) {
		const level = ownRecordValue(nextLevels, uuid);
		const before = ownRecordValue(prevLevels, uuid);
		if (level === undefined || before === undefined) continue;
		if (!deepEqual(before, level)) {
			if (before.code !== level.code) {
				throw new Error("An organization level's code is create-once.");
			}
			const { code: _code, ...patch } = userPatch(before, level);
			out.push({
				kind: "updateOrganizationLevel",
				uuid: asUuid(uuid),
				patch,
			});
		}
	}
	for (const uuid of Object.keys(prevLevels)) {
		if (!hasOwnRecordKey(nextLevels, uuid)) {
			out.push({ kind: "removeOrganizationLevel", uuid: asUuid(uuid) });
		}
	}

	const prevProperties = prev.locationProperties ?? {};
	const nextProperties = next.locationProperties ?? {};
	assertExistingRelativeOrderPreserved(
		prev.locationPropertyOrder ?? [],
		next.locationPropertyOrder ?? [],
		"place-information fields",
	);
	for (const [index, uuid] of (next.locationPropertyOrder ?? []).entries()) {
		const property = ownRecordValue(nextProperties, uuid);
		if (property === undefined) continue;
		const before = ownRecordValue(prevProperties, uuid);
		if (before === undefined) {
			out.push({
				kind: "addLocationProperty",
				property: cloneEntity(property),
				after:
					index === 0
						? null
						: asUuid(next.locationPropertyOrder?.[index - 1] ?? ""),
			});
		} else if (!deepEqual(before, property)) {
			out.push({
				kind: "updateLocationProperty",
				uuid: asUuid(uuid),
				patch: userPatch(before, property),
			});
		}
	}
	for (const uuid of Object.keys(prevProperties)) {
		if (!hasOwnRecordKey(nextProperties, uuid)) {
			out.push({ kind: "removeLocationProperty", uuid: asUuid(uuid) });
		}
	}
	return out;
}

/**
 * Organization collections currently have add-position but no standalone move
 * mutation. Refuse a reorder endpoint explicitly instead of returning a batch
 * that silently replays to a different document.
 */
function assertExistingRelativeOrderPreserved(
	previous: readonly Uuid[],
	next: readonly Uuid[],
	label: string,
): void {
	const previousSet = new Set(previous);
	const nextSet = new Set(next);
	const oldShared = previous.filter((uuid) => nextSet.has(uuid));
	const nextShared = next.filter((uuid) => previousSet.has(uuid));
	if (!deepEqual(oldShared, nextShared)) {
		throw new Error(
			`Reordering existing ${label} is not representable by the current mutation dialect.`,
		);
	}
}

/**
 * The changed slots between two versions of one user entity, with a slot
 * that went away spelled `null` — the wire's only surviving clear, since
 * `JSON.stringify` drops an `undefined`-valued key on both the SSE stream
 * and the persisted jsonb. `uuid` never appears: it is the patch's key,
 * not part of it.
 */
function userPatch<T extends Record<string, unknown>>(
	before: Record<string, unknown>,
	after: T,
): {
	[K in Exclude<keyof T, "uuid" | "order">]?: T[K] | null;
} {
	const patch: Record<string, unknown> = {};
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (key === "uuid") continue;
		const value = after[key];
		if (deepEqual(before[key], value)) continue;
		patch[key] = value === undefined ? null : cloneEntity(value);
	}
	return patch as {
		[K in Exclude<keyof T, "uuid" | "order">]?: T[K] | null;
	};
}
