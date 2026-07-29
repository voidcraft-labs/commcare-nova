/**
 * `rebuildFieldParent` utility — extracted from store.ts to avoid a
 * circular import between `lib/doc/store.ts` and
 * `lib/doc/mutations/fields.ts`.
 *
 * The store imports the mutation dispatcher, the dispatcher imports
 * `applyFieldMutation`, and `applyFieldMutation` needs `rebuildFieldParent`.
 * Putting it here breaks the cycle: mutations import from `fieldParent`,
 * store imports from both `mutations/` and `fieldParent`.
 */

import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import {
	hasOwnRecordKey,
	type PersistableDoc,
	recordFromEntries,
} from "@/lib/domain";
import { normalizeBlueprintOwnRecords } from "./ownRecords";

/**
 * Rebuild the fieldParent reverse index from fieldOrder.
 *
 * Called on load and after any structural change that touches ordering.
 * This is O(total fields) — acceptable on mutation because the number of
 * mutations per user interaction is small.
 *
 * Parents are either form uuids (for top-level fields) or container-field
 * uuids (for nested fields under group/repeat). Both are recorded in the
 * same `fieldOrder` map, keyed by parent uuid.
 *
 * Orphan guard: any field in `doc.fields` that doesn't appear in any
 * fieldOrder entry gets `null`. In a well-formed doc this never fires,
 * but it's cheap insurance against bugs that would otherwise leave
 * parent lookup undefined.
 */
export function rebuildFieldParent(doc: BlueprintDoc): void {
	const fieldParent = recordFromEntries<Uuid | null>([]) as Record<
		Uuid,
		Uuid | null
	>;

	// Every field uuid that appears as a child of some parent gets that
	// parent recorded.
	for (const [parentUuid, fieldUuids] of Object.entries(doc.fieldOrder)) {
		for (const fieldUuid of fieldUuids) {
			fieldParent[fieldUuid as Uuid] = parentUuid as Uuid;
		}
	}

	// Orphan guard: fields in doc.fields not referenced by any fieldOrder entry.
	for (const uuid of Object.keys(doc.fields)) {
		if (!hasOwnRecordKey(fieldParent, uuid)) fieldParent[uuid as Uuid] = null;
	}
	doc.fieldParent = fieldParent;
}

/**
 * Strip the derived state from a doc — the `fieldParent` reverse index
 * and the reference index — producing the persisted
 * `PersistableDoc` shape. Both are rebuilt from the doc alone on load
 * (`rebuildFieldParent` / `buildReferenceIndex`), so persisting either
 * would double-store the same information and create drift risk if the
 * copies ever diverged — and the reference index additionally must
 * never change a byte of anything persisted or emitted. Call at every
 * boundary that persists a doc or ships it over an SSE payload
 * consumed by clients that rebuild their own indexes.
 */
export function toPersistableDoc(doc: BlueprintDoc): PersistableDoc {
	const { fieldParent: _fp, refIndex: _ri, ...persistable } = doc;
	return persistable;
}

/**
 * The single stored-blueprint → in-memory hydration chokepoint.
 *
 * Turn a persisted `PersistableDoc` (the on-disk shape: no derived
 * `fieldParent`, and — on a LEGACY app — no `order` keys or select-option
 * `uuid`s) into a working `BlueprintDoc`. EVERY boundary that reads a stored
 * blueprint into a doc it will display, diff, mutate, or emit routes through
 * here, so record normalization and derived indexes are identical everywhere.
 *
 * Deep-clones its input so hydration never mutates the caller's stored
 * snapshot. Persisted authoring identities are already canonical; hydration
 * never invents, normalizes, or repairs identity.
 *
 * The reference index is deliberately NOT built here — it stays per-boundary:
 * the guarded-commit fresh doc omits it (the verdict's candidate apply seeds
 * one), while the chat / client / MCP paths call `ensureReferenceIndex` /
 * `buildReferenceIndex` after hydrating.
 */
export function hydratePersistedBlueprint(
	persisted: PersistableDoc,
): BlueprintDoc {
	const doc = structuredClone(persisted) as unknown as BlueprintDoc;
	doc.fieldParent = recordFromEntries([]) as Record<Uuid, Uuid | null>;
	normalizeBlueprintOwnRecords(doc);
	rebuildFieldParent(doc);
	return doc;
}
