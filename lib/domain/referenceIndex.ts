// lib/domain/referenceIndex.ts
//
// The data shape of the blueprint's reference index — the derived,
// never-persisted lookup structure that answers "who references X?" and
// "who declares X?" without walking the document. The index rides on
// `BlueprintDoc` beside `fieldParent` (see `lib/domain/blueprint.ts`),
// is maintained per-mutation by the apply pipeline, and is rebuilt from
// the doc alone at every hydration boundary. The builder, maintenance,
// extraction, and query logic live in `lib/doc/referenceIndex.ts`; this
// file owns only the shape and the key vocabulary, because the shape is
// part of `BlueprintDoc`'s type and `lib/domain` cannot import `lib/doc`.
//
// ## Identity-keyed edges
//
// An edge keys on the IDENTITY of what is referenced, never on text:
//
//   - `u:<uuid>` — an entity reference by stable uuid. An expression
//     slot's form-local leaf (`#form/grp/age`, `/data/age` at the
//     commit that parsed it) and a `capture-link` carry the target uuid
//     directly; form-link targets store uuids outright; prose reference
//     atoms carry the uuid directly. Renames never re-key these edges —
//     the uuid is stable.
//   - `l:<uuid>` — an app-scoped location-row reference. Location UUIDs are
//     intentionally outside the Blueprint entity namespace even when the raw
//     UUID text happens to match an authored entity.
//   - `p:<uuid>` — a custom worker-information property reference by stable
//     uuid. Renaming its saved slug never re-keys the edge.
//   - `c:<caseType>/<property>` — a case-property reference. Typed XPath/prose
//     `case-ref` atoms, predicate-AST `PropertyRef` leaves (keyed under the
//     walk's DESTINATION type, mirroring the rename rewriter's matching rule),
//     and module config's contextual property slots all land here. A property
//     rename re-keys exactly these edges.
//   - `t:<caseType>` — a reference that NAMES a case type: a case
//     operation's stored `caseType`, a module's own `caseType` (slot id
//     `case_type` — consumers that treat ownership separately filter on the
//     slot), a typed `case-ref` atom's namespace, a predicate-AST term's origin
//     type, and relation-walk type hints. Contextual module property slots do
//     not produce a `t:` edge because they follow the module's current type.
//
// ## Carrier-keyed, no stored spans
//
// Each edge records WHERE the reference lives — the carrying entity's
// uuid plus the slot id from the reference-slot registry
// (`lib/domain/referenceSlots.ts`). Edges never store character
// offsets: a consumer that needs structure walks the named typed slot on
// demand, so positional data can never go stale across mutations.
//
// Everything is plain JSON records (no Map/Set): the index is part of
// the doc store's state, and the undo history records the batch that produced it.

import { ownRecordValue } from "./records";
import type { Uuid } from "./uuid";

/**
 * One carrier's mirror entry — everything the maintenance layer needs
 * to un-index the carrier in O(its own edges) when it changes or
 * disappears, plus the membership keys for the side buckets.
 */
export interface ReferenceCarrierEntry {
	/** targetKey → slot ids on this carrier referencing it. */
	edges: Record<string, Record<string, true>>;
	/** Forms only: every `(caseType, property)` pair the form's case
	 *  operations write, mirrored into `decl` with the form as the
	 *  declaration carrier. A write through `via` declares on the case
	 *  type `via` reaches, and the own case's writes on the module's. */
	decls?: string[];
	/** Set when extraction consumed the owning module's `caseType` context —
	 *  the module uuid whose `ctx` bucket lists it. Carriers in that bucket
	 *  re-extract when the module's case type changes or the form moves. */
	ctx?: string;
}

/**
 * The reference + declarations index. Derived state: deterministic
 * function of the doc, identical on every apply surface, rebuildable
 * from the doc alone, and never serialized (persistence, the event log,
 * and every wire format see `PersistableDoc`, which omits it).
 */
export interface ReferenceIndex {
	/** targetKey → carrier uuid → slot ids. The "who references X?"
	 *  lookup. */
	in: Record<string, Record<string, Record<string, true>>>;
	/** carrier uuid → its mirror entry (reverse map for un-indexing +
	 *  the "edges of owner" lookup). */
	out: Record<string, ReferenceCarrierEntry>;
	/** `<caseType>/<property>` → declaring carrier uuids (forms whose
	 *  case operations write the pair). The case-property peer lookup. */
	decl: Record<string, Record<string, true>>;
	/** module uuid → carriers whose extraction read the module's
	 *  case-type context. */
	ctx: Record<string, Record<string, true>>;
}

/** Target key for an entity reference by stable uuid. */
export function entityTargetKey(uuid: Uuid | string): string {
	return `u:${uuid}`;
}

/** Target key for an app-scoped organization location row. */
export function locationTargetKey(uuid: Uuid | string): string {
	return `l:${uuid}`;
}

export const USER_PROPERTY_TARGET_PREFIX = "p:";

/** Target key for a custom worker-information property identity. */
export function userPropertyTargetKey(uuid: Uuid | string): string {
	return `${USER_PROPERTY_TARGET_PREFIX}${uuid}`;
}

/**
 * Target key for a case-property reference. The `/` join is unambiguous
 * in practice: both halves are identifier-shaped (hashtag segments and
 * case-property names exclude `/`), and every consumer constructs the
 * key from a `(caseType, property)` pair through this function — never
 * by parsing a key back apart.
 */
export function casePropertyTargetKey(
	caseType: string,
	property: string,
): string {
	return `c:${caseType}/${property}`;
}

/** Target key for a reference that names a case type. */
export function caseTypeTargetKey(caseType: string): string {
	return `t:${caseType}`;
}

/** Declarations-index key for a `(caseType, property)` pair. */
export function casePropertyDeclKey(
	caseType: string,
	property: string,
): string {
	return `${caseType}/${property}`;
}

/**
 * The carriers holding an edge to `targetKey`, each with the slot ids its
 * edges live on, read from an index the document already carries; undefined
 * when it carries none. `lib/doc/referenceIndex.ts::referencingSlotsOf`
 * builds a missing index first, which `lib/domain` cannot: a domain reader
 * that gets undefined reads the document itself.
 */
export function indexedReferencingSlots(
	index: ReferenceIndex | undefined,
	targetKey: string,
): ReadonlyMap<string, readonly string[]> | undefined {
	if (index === undefined) return undefined;
	const byCarrier = ownRecordValue(index.in, targetKey);
	const result = new Map<string, readonly string[]>();
	for (const [carrier, slots] of Object.entries(byCarrier ?? {}))
		result.set(carrier, Object.keys(slots));
	return result;
}
