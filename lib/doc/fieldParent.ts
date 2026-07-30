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

import { asUuid, type BlueprintDoc, type Uuid } from "@/lib/doc/types";
import {
	blueprintDocSchema,
	blueprintTopologyIssues,
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
 * Closed topology guarantees every field occurs exactly once under a form or
 * container. Rebuilding refuses an invalid document rather than manufacturing
 * an orphan sentinel that could survive into UI or persistence.
 */
export function rebuildFieldParent(doc: BlueprintDoc): void {
	const topologyIssues = blueprintTopologyIssues(doc);
	if (topologyIssues.length > 0) {
		throw new Error(
			`[rebuildFieldParent] invalid blueprint topology: ${topologyIssues
				.map((issue) => issue.message)
				.join(" ")}`,
		);
	}
	const fieldParent = recordFromEntries<Uuid>([]) as Record<Uuid, Uuid>;

	// Every field uuid that appears as a child of some parent gets that
	// parent recorded.
	for (const [parentUuid, fieldUuids] of Object.entries(doc.fieldOrder)) {
		for (const fieldUuid of fieldUuids) {
			fieldParent[fieldUuid] = asUuid(parentUuid);
		}
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
	const source = doc as unknown as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(blueprintDocSchema.shape).flatMap((key) =>
			Object.hasOwn(source, key) && source[key] !== undefined
				? [[key, source[key]] as const]
				: [],
		),
	) as PersistableDoc;
}

/**
 * The single stored-blueprint → in-memory hydration chokepoint.
 *
 * Turn a final-schema `PersistableDoc` (the on-disk shape without derived
 * `fieldParent`) into a working `BlueprintDoc`. EVERY boundary that reads a
 * stored blueprint into a doc it will display, diff, mutate, or emit routes
 * through here, so record normalization and derived indexes are identical
 * everywhere.
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
	doc.fieldParent = recordFromEntries([]) as Record<Uuid, Uuid>;
	normalizeBlueprintOwnRecords(doc);
	rebuildFieldParent(doc);
	return doc;
}
