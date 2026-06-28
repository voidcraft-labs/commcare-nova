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
 * advanced): entity edits are IDENTITY-keyed (module/form/field by uuid), so
 * a co-member's edit to a DIFFERENT entity survives the replay untouched —
 * the non-destructive merge. Two slices are NOT identity-keyed and stay
 * last-writer-wins under genuinely concurrent edits to the SAME slice:
 * `setCaseTypes` carries the WHOLE catalog (so a co-member's concurrent
 * case-type/property add is overwritten), and `moveModule`/`moveForm`/
 * `moveField` carry a positional `toIndex` (so a concurrent reorder can land
 * a move at a stale position). Both are rare (concurrent edits to one app's
 * catalog/order) and bounded to those slices; granular catalog mutations +
 * identity-anchored moves are the multiplayer-GA upgrade. A concurrent
 * DELETE of an entity this diff targets is caught separately — the guarded
 * commit's `batchTargetsMissing` rejects it as a 409 rather than letting it
 * silently no-op.
 *
 * The emission order is dictated by the reducer's semantics, not by the
 * mutation union's declaration order:
 *
 *   1. App-level scalars (`setAppName` / `setConnectType` / `setAppLogo`).
 *      No entity side effects, so they can lead.
 *   2. Module + form ADDS — parent before child. Modules in `next` order,
 *      then each module's added forms. Added entities are landed before the
 *      removes so an evacuation (next step) can move a survivor into a
 *      freshly-added module/form.
 *   3. EVACUATIONS — moves of surviving forms/fields OUT of a parent that
 *      is about to be removed. `removeModule` / `removeForm` / `removeField`
 *      cascade their subtrees, so a survivor still inside a doomed parent
 *      would be deleted by the cascade; it must move out first. (Fields
 *      can only ever leave a doomed CONTAINER within the same form — a form
 *      removal deletes all its fields, since `moveField` is same-form.)
 *   4. Removes — TOP survivors only. A child whose parent is also removed
 *      gets no explicit remove; the parent's cascade took it.
 *   5. Field structural REST — cross-parent moves, reorders, and field adds,
 *      target-ordered + top-down in one pass, plus the cross-module form
 *      moves + same-module reorders. A `moveField`'s sibling-id dedup may
 *      transiently suffix a moved field; step 7's `updateField` patch pins
 *      the id back, so the dedup is harmless and needs no ordering around.
 *   6. Module + form renames (`renameModule` / `renameForm` — cascade-free,
 *      they only set `name`), then field converts (`convertField`).
 *   7. Updates — `updateModule` / `updateForm` / `updateField` patches of
 *      ONLY the changed keys. A field's `id` rides its `updateField` patch,
 *      NOT `renameField`: `renameField` runs a case-property cascade (peer
 *      renames, prose/module-config rewrites, catalog rename) whose side
 *      effects collide with the rest of a multi-entity diff; `updateField`
 *      sets `id` in place with none of it, and every OTHER entity's slots +
 *      the catalog are pinned directly elsewhere in this batch.
 *   8. Media — the dedicated clear-safe kinds (`setFieldMedia` /
 *      `setModuleMedia` / `setFormMedia`), excluded from every generic
 *      update patch.
 *   9. Module order reconciliation (`moveModule`).
 *  10. `setCaseTypes` LAST, and ONLY when the catalog actually changed. The
 *      field reducers mutate `doc.caseTypes` as a catalog side effect
 *      (`ensureCatalogProperty`), so a pin must follow them when it's emitted;
 *      but it is emitted only on a real `caseTypes` difference, so a structural
 *      edit that left the catalog alone never re-pins it (which would clobber a
 *      co-member's concurrent catalog add on the guarded re-apply).
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
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	FIELD_MEDIA_SLOTS,
	type Mutation,
	type Uuid,
} from "@/lib/doc/types";
import type { AssetId, Form, Media, Module } from "@/lib/domain";

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

/** Get the array at `key`, creating an empty one if absent. */
function ensureArray(map: Record<string, Uuid[]>, key: Uuid): Uuid[] {
	let arr = map[key];
	if (arr === undefined) {
		arr = [];
		map[key] = arr;
	}
	return arr;
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
const FIELD_MEDIA_KEY_SET = new Set<string>(FIELD_MEDIA_KEYS);
const MENU_MEDIA_KEY_SET = new Set<string>(["icon", "audioLabel"]);

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

const MODULE_PATCH_SKIP = new Set<string>(["icon", "audioLabel", "name"]);
const FORM_PATCH_SKIP = new Set<string>(["icon", "audioLabel", "name"]);

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

// ── Order reconciliation ─────────────────────────────────────────────
//
// Turn a `working` order into `target` via index-addressed moves against
// a SIMULATED copy of `working` (the reducer's remove-then-insert
// semantics). Left-to-right: at each position `i`, if the simulated array
// already holds the wanted uuid, advance; otherwise splice it out of its
// current spot and reinsert at `i`, emitting one move. Both arrays hold
// the same uuid multiset by the time this runs (adds/removes already
// applied), so every wanted uuid is found. `emitMove(uuid, toIndex)`
// produces the kind-specific mutation.

function reconcileOrder(
	working: Uuid[],
	target: readonly Uuid[],
	emitMove: (uuid: Uuid, toIndex: number) => Mutation,
): Mutation[] {
	const out: Mutation[] = [];
	const sim = [...working];
	for (let i = 0; i < target.length; i++) {
		const wanted = target[i];
		if (sim[i] === wanted) continue;
		const from = sim.indexOf(wanted);
		if (from === -1) continue; // Defensive: multisets match by contract.
		sim.splice(from, 1);
		sim.splice(i, 0, wanted);
		out.push(emitMove(wanted, i));
	}
	return out;
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
	const order = doc.fieldOrder[parentUuid] ?? [];
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
	const removedFormSet = new Set(formDelta.removed);

	// Child → parent reverse indexes, built once and threaded to the
	// ancestor / evacuation helpers (the inputs are persistable snapshots
	// with no derived `fieldParent`).
	const prevParentMap = buildParentMap(prev);
	const nextParentMap = buildParentMap(next);

	// Field structural reconciliation (adds + moves) — computed up front so
	// the field-update loop can force-pin the `id` of every cross-parent-
	// moved field (undoing any `moveField` sibling-id dedup). Its mutations
	// are emitted later, in the phase order.
	const fieldTree = reconcileFieldTree(prev, next, fieldDelta, nextParentMap);

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
		adds.push({
			kind: "addModule",
			module: cloneEntity(next.modules[uuid]),
			index,
		});
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

		// Generic property patch — every non-media, non-uuid, non-kind key,
		// INCLUDING `id`. On a kind change the patch must cover EVERY differing
		// key the new kind declares (the convert carried the old field's
		// values, not next's), so build it against `next`'s value for every
		// key present there plus a clear for any key the convert may have
		// carried that `next` doesn't have.
		const skip = FIELD_MEDIA_KEY_SET;
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
	}

	// (5) Module order reconciliation. Build the working order by simulating
	// the actual emission sequence — `addModule`s land FIRST (before removes,
	// so evacuated forms have their destination module), each at its `next`
	// index into the full prev order; THEN removed modules drop out. The
	// result is the replay state the `moveModule` reconcile starts from.
	const workingModuleOrder = [...prev.moduleOrder];
	for (let index = 0; index < next.moduleOrder.length; index++) {
		const uuid = next.moduleOrder[index];
		if (!addedModuleSet.has(uuid)) continue;
		workingModuleOrder.splice(
			Math.min(index, workingModuleOrder.length),
			0,
			uuid,
		);
	}
	const postRemoveModuleOrder = workingModuleOrder.filter(
		(u) => !removedModuleSet.has(u),
	);
	orders.push(
		...reconcileOrder(
			postRemoveModuleOrder,
			next.moduleOrder,
			(uuid, toIndex) => ({ kind: "moveModule", uuid, toIndex }),
		),
	);

	// Form structural — cross-module moves (incl. forms evacuated out of
	// removed modules) + same-module reorders.
	const formStructure = reconcileFormOrders(
		prev,
		next,
		removedFormSet,
		addedFormSet,
	);

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
	//   (incl. id) → media → module order reconcile.
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
		...orders,
	];

	// (6) Case-type catalog LAST — a wholesale `setCaseTypes` OVERWRITES the
	// catalog, so on the guarded re-apply it would clobber a co-member's
	// concurrent catalog add. It is emitted only when the catalog genuinely
	// can't be reached otherwise:
	//
	//   - ONLY the FIELD reducers mutate the catalog as a side effect
	//     (`ensureCatalogProperty`); module/form/order/app edits never do. So
	//     when a field add/convert/update is present, SIMULATE the structural
	//     replay and pin only if its catalog diverges from `next.caseTypes` —
	//     a change the side effects reproduce on the FRESH doc needs no pin
	//     (they re-derive it, merging a concurrent add); one they can't (a
	//     direct declaration/retirement, or an add-then-clear net) gets the
	//     pin. Replaying on `prev` is the same simulation the round-trip oracle
	//     checks.
	//   - With NO field edit, a catalog difference is a direct
	//     declaration/retirement (pin it) and no difference means no pin —
	//     both decided cheaply, skipping the O(doc) replay.
	//
	// (A genuinely concurrent edit to the SAME catalog stays last-writer-wins —
	// the documented multiplayer-GA limit.)
	const fieldCatalogTouched =
		fieldStructure.length > 0 || converts.length > 0 || updates.length > 0;
	let pinCatalog: boolean;
	if (fieldCatalogTouched) {
		// `structuredClone` the batch for the simulation: `applyMutations` aliases
		// payload objects into the immer draft, and immer's auto-freeze would
		// otherwise deep-freeze the very objects this function RETURNS.
		const replayedCaseTypes = produce(prev, (draft) => {
			applyMutations(draft, structuredClone(structural));
		}).caseTypes;
		pinCatalog = !deepEqual(replayedCaseTypes, next.caseTypes);
	} else {
		pinCatalog = !deepEqual(prev.caseTypes, next.caseTypes);
	}
	if (pinCatalog) {
		structural.push({
			kind: "setCaseTypes",
			caseTypes: next.caseTypes === null ? null : cloneEntity(next.caseTypes),
		});
	}

	return structural;
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
 * Reconcile each module's `formOrder` to `next` — cross-module form moves +
 * same-module reorders. Mirrors `reconcileFieldTree`'s evacuation handling:
 * a form leaving a REMOVED module must move out before the `removeModule`
 * cascade, so it's emitted in `evacuations` (pre-removes), at the END of its
 * destination (a valid index amid not-yet-removed siblings); the post-removes
 * reconcile then lands its final position. Every other cross-module move +
 * all reorders are `rest` (post-removes), at `next` indices.
 */
function reconcileFormOrders(
	prev: BlueprintDoc,
	next: BlueprintDoc,
	removedFormSet: ReadonlySet<Uuid>,
	addedFormSet: ReadonlySet<Uuid>,
): { evacuations: Mutation[]; rest: Mutation[] } {
	const evacuations: Mutation[] = [];
	const rest: Mutation[] = [];

	// Working model — FULL prev formOrder per module (removed forms INCLUDED)
	// plus added forms spliced at their next index, because the evacuation
	// phase runs before the removes.
	const working: Record<string, Uuid[]> = {};
	for (const [moduleUuid, order] of Object.entries(prev.formOrder)) {
		working[moduleUuid] = [...order];
	}
	for (const moduleUuid of next.moduleOrder) {
		if (working[moduleUuid] === undefined) working[moduleUuid] = [];
	}
	for (const moduleUuid of next.moduleOrder) {
		const order = next.formOrder[moduleUuid] ?? [];
		for (let index = 0; index < order.length; index++) {
			const formUuid = order[index];
			if (!addedFormSet.has(formUuid)) continue;
			const arr = ensureArray(working, moduleUuid);
			arr.splice(Math.min(index, arr.length), 0, formUuid);
		}
	}

	// Phase E — evacuate surviving forms out of REMOVED modules, to the END
	// of their next module (a valid pre-removes index). Final position fixed
	// by the post-removes reorder below.
	for (const [moduleUuid, order] of Object.entries(prev.formOrder)) {
		if (next.modules[moduleUuid] !== undefined) continue; // module survives
		for (const formUuid of [...order]) {
			if (next.forms[formUuid] === undefined) continue; // form removed too
			const dest = ownerModuleOfForm(next, formUuid);
			if (dest === undefined) continue;
			const destArr = ensureArray(working, dest);
			evacuations.push({
				kind: "moveForm",
				uuid: formUuid,
				toModuleUuid: dest,
				toIndex: destArr.length,
			});
			const src = working[moduleUuid];
			const at = src.indexOf(formUuid);
			if (at !== -1) src.splice(at, 1);
			destArr.push(formUuid);
		}
	}

	// Phase R (simulated) — drop removed forms (and forms gone from `next`).
	for (const moduleUuid of Object.keys(working)) {
		working[moduleUuid] = working[moduleUuid].filter(
			(u) => !removedFormSet.has(u) && next.forms[u] !== undefined,
		);
	}

	// Pass 1 (rest) — remaining cross-module moves (surviving source module),
	// at next index. Across all modules before reorders so a form leaving
	// module A is evacuated from A's working order first.
	for (const moduleUuid of next.moduleOrder) {
		const target = next.formOrder[moduleUuid] ?? [];
		for (let index = 0; index < target.length; index++) {
			const formUuid = target[index];
			const fromModule = findFormModuleInWorking(working, formUuid);
			if (fromModule !== undefined && fromModule !== moduleUuid) {
				rest.push({
					kind: "moveForm",
					uuid: formUuid,
					toModuleUuid: moduleUuid,
					toIndex: index,
				});
				const src = working[fromModule];
				if (src) {
					const at = src.indexOf(formUuid);
					if (at !== -1) src.splice(at, 1);
				}
				const dst = ensureArray(working, moduleUuid);
				dst.splice(Math.min(index, dst.length), 0, formUuid);
			}
		}
	}

	// Pass 2 (rest) — same-module reorder. Every form is now in its target
	// module, so each module's working order holds its target multiset.
	for (const moduleUuid of next.moduleOrder) {
		const target = next.formOrder[moduleUuid] ?? [];
		rest.push(
			...reconcileOrder(working[moduleUuid] ?? [], target, (uuid, toIndex) => ({
				kind: "moveForm",
				uuid,
				toModuleUuid: moduleUuid,
				toIndex,
			})),
		);
		working[moduleUuid] = [...target];
	}
	return { evacuations, rest };
}

/** Which working module currently lists `formUuid`. */
function findFormModuleInWorking(
	working: Record<string, Uuid[]>,
	formUuid: Uuid,
): Uuid | undefined {
	for (const [moduleUuid, order] of Object.entries(working)) {
		if (order.includes(formUuid)) return moduleUuid as Uuid;
	}
	return undefined;
}
/**
 * Reconcile the field tree to `next` in ONE target-ordered, top-down pass —
 * field ADDS, cross-parent MOVES, and reorders interleaved.
 *
 * The working model starts as `prev`'s field tree minus removed fields and
 * is mutated as each placement is emitted, so each decision sees current
 * state. Parents are visited top-down (forms in module order, then nested
 * containers in pre-order) so a container is placed before its children;
 * within a parent, target slots are filled left-to-right.
 *
 * Per target slot `(P, i, wanted)`:
 *   - `working[P][i]` already `wanted` → nothing to do.
 *   - `wanted` is NEW (nowhere in working) → `addField` at `i`.
 *   - else `wanted` lives elsewhere (or here at a wrong index) → `moveField`
 *     to `(P, i)`.
 *
 * Sibling-id dedup is NOT defended against here: a cross-parent `moveField`
 * whose destination already holds the moved field's CURRENT id gets
 * auto-suffixed by the reducer, but the field's `id` is pinned to its exact
 * `next` value by an `updateField` patch emitted AFTER this pass (see the
 * field-update loop in `diffDocsToMutations`), which overrides any suffix.
 *
 * A cross-parent move is same-form by the reducer's guard; a surviving
 * field's containing form is identical in `prev` and `next` (only
 * `moveField` changes a field's form, and that path rejects cross-form), so
 * every emitted move stays within one form.
 *
 * Returns moves split into two phases against ONE simulated working model,
 * so every emitted index is computed against the exact state it executes on:
 *   - `evacuations` — moves of surviving fields OUT of a doomed parent (one
 *     about to be removed), executed PRE-removes while the doomed parent and
 *     other removed siblings still exist. Each evacuates to the END of its
 *     next parent (a valid index amid not-yet-removed siblings); the `rest`
 *     reorder then lands the final position.
 *   - `rest` — the post-removes target-order reconcile (cross-parent moves,
 *     reorders, field adds), against the working model after removes have
 *     dropped the removed fields. Indices here are `next` indices, valid
 *     because removed fields are gone.
 */
function reconcileFieldTree(
	prev: BlueprintDoc,
	next: BlueprintDoc,
	fieldDelta: SetDelta,
	nextParentMap: ReadonlyMap<Uuid, Uuid>,
): {
	evacuations: Mutation[];
	rest: Mutation[];
	crossParentMoved: Set<Uuid>;
} {
	const evacuations: Mutation[] = [];
	const rest: Mutation[] = [];
	// Fields moved ACROSS a parent boundary — the only moves the reducer
	// runs sibling-id dedup on. The caller force-pins each one's `id` via an
	// `updateField` patch (even when the id is unchanged), undoing any dedup
	// suffix the move may have applied.
	const crossParentMoved = new Set<Uuid>();
	const removedFieldSet = new Set(fieldDelta.removed);
	const addedFieldSet = new Set(fieldDelta.added);

	// A parent is "doomed" if it won't exist after the removes — a removed
	// form or removed container field (also covers parents under a removed
	// module, which aren't in `next` either).
	const isDoomedParent = (parentUuid: string): boolean =>
		next.forms[parentUuid] === undefined &&
		next.fields[parentUuid] === undefined;

	// Working model — the FULL prev field tree (removed fields INCLUDED),
	// because the evacuation phase executes before the removes.
	const working: Record<string, Uuid[]> = {};
	for (const [parentUuid, order] of Object.entries(prev.fieldOrder)) {
		working[parentUuid] = [...order];
	}
	const parents = nextParentsTopDown(next);
	for (const parentUuid of parents) {
		if (working[parentUuid] === undefined) working[parentUuid] = [];
	}

	// ── Phase E — evacuate survivors out of doomed parents ────────────────
	// A surviving field in a doomed parent moves to the END of its `next`
	// parent (a valid pre-removes index). The final position is fixed by the
	// `rest` reorder below. Visited top-down so a field whose next parent is
	// itself being evacuated/added settles in the right container first.
	for (const [parentUuid, order] of Object.entries(prev.fieldOrder)) {
		if (!isDoomedParent(parentUuid)) continue;
		for (const fieldUuid of order) {
			if (removedFieldSet.has(fieldUuid)) continue; // genuinely removed
			const dest = nextParentMap.get(fieldUuid);
			if (dest === undefined) continue; // not reachable in next (shouldn't happen for a survivor)
			const destArr = ensureArray(working, dest);
			evacuations.push({
				kind: "moveField",
				uuid: fieldUuid,
				toParentUuid: dest,
				toIndex: destArr.length,
			});
			crossParentMoved.add(fieldUuid);
			const src = working[parentUuid];
			const at = src.indexOf(fieldUuid);
			if (at !== -1) src.splice(at, 1);
			destArr.push(fieldUuid);
		}
	}

	// ── Phase R (simulated) — drop removed fields from the working model ──
	for (const parentUuid of Object.keys(working)) {
		working[parentUuid] = working[parentUuid].filter(
			(u) => !removedFieldSet.has(u),
		);
	}

	// ── Phase rest — target-order reconcile of every `next` parent ────────
	for (const parentUuid of parents) {
		const target = next.fieldOrder[parentUuid] ?? [];
		for (let i = 0; i < target.length; i++) {
			const wanted = target[i];
			const cur = working[parentUuid] ?? [];
			if (cur[i] === wanted) continue;
			if (
				addedFieldSet.has(wanted) &&
				findFieldParentInWorking(working, wanted) === undefined
			) {
				rest.push({
					kind: "addField",
					parentUuid,
					field: cloneEntity(next.fields[wanted]),
					index: i,
				});
				const arr = ensureArray(working, parentUuid);
				arr.splice(Math.min(i, arr.length), 0, wanted);
				continue;
			}
			// Existing field — move into place (cross-parent or reorder).
			rest.push({
				kind: "moveField",
				uuid: wanted,
				toParentUuid: parentUuid,
				toIndex: i,
			});
			const from = findFieldParentInWorking(working, wanted);
			if (from !== undefined && from !== parentUuid) {
				crossParentMoved.add(wanted);
			}
			if (from !== undefined) {
				const src = working[from];
				const at = src.indexOf(wanted);
				if (at !== -1) src.splice(at, 1);
			}
			const arr = ensureArray(working, parentUuid);
			arr.splice(Math.min(i, arr.length), 0, wanted);
		}
	}
	return { evacuations, rest, crossParentMoved };
}

/** Which working parent currently lists `fieldUuid`. */
function findFieldParentInWorking(
	working: Record<string, Uuid[]>,
	fieldUuid: Uuid,
): Uuid | undefined {
	for (const [parentUuid, order] of Object.entries(working)) {
		if (order.includes(fieldUuid)) return parentUuid as Uuid;
	}
	return undefined;
}

/**
 * Every field parent in `next` (forms then container fields), top-down:
 * forms in module → form order, then container fields in pre-order. A
 * top-down order means a parent is always reconciled before any parent
 * nested inside it.
 */
function nextParentsTopDown(next: BlueprintDoc): Uuid[] {
	const parents: Uuid[] = [];
	for (const moduleUuid of next.moduleOrder) {
		for (const formUuid of next.formOrder[moduleUuid] ?? []) {
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
