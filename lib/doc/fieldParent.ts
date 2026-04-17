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
	doc.fieldParent = {} as Record<Uuid, Uuid | null>;

	// Every field uuid that appears as a child of some parent gets that
	// parent recorded.
	for (const [parentUuid, fieldUuids] of Object.entries(doc.fieldOrder)) {
		for (const fieldUuid of fieldUuids) {
			doc.fieldParent[fieldUuid as Uuid] = parentUuid as Uuid;
		}
	}

	// Orphan guard: fields in doc.fields not referenced by any fieldOrder entry.
	for (const uuid of Object.keys(doc.fields)) {
		if (!(uuid in doc.fieldParent)) doc.fieldParent[uuid as Uuid] = null;
	}
}
