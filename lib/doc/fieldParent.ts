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
import type { PersistableDoc } from "@/lib/domain";
import { backfillOptionUuids, backfillOrderKeys } from "./order/backfill";

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
 * here, so the hydration steps run identically everywhere. That structurally
 * kills the asymmetric-hydration class: a boundary that backfilled and one
 * that didn't produced docs that disagreed on an entity's `order` / option
 * `uuid`, so a client's edit against a backfilled key replayed onto an
 * un-backfilled server doc as a silent `findIndex` no-op.
 *
 * Deep-clones its input so hydration never mutates the caller's stored
 * snapshot. Backfill runs BEFORE the parent rebuild (and before any reference
 * index a caller adds after): it is deterministic + position-seeded, so a
 * client and the server hydrating the SAME legacy doc produce byte-identical
 * keys/uuids, and it is idempotent on an already-keyed doc.
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
	doc.fieldParent = {} as Record<Uuid, Uuid | null>;
	backfillOrderKeys(doc);
	backfillOptionUuids(doc);
	rebuildFieldParent(doc);
	return doc;
}
