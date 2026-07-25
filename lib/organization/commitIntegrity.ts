import type { Transaction } from "kysely";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import type { AppDatabase } from "@/lib/db/pg";
import {
	assignedLocationUuids,
	type BlueprintDoc,
	organizationLevelsOf,
	personasOf,
} from "@/lib/domain";

/**
 * The organization's half of a blueprint commit's integrity, run inside the
 * commit transaction because neither question can be answered from the
 * document alone and neither answer stays true outside a lock.
 *
 * Two directions of reference cross the two stores:
 *
 *   - **document -> rows.** A persona's assignment names location rows. Those
 *     become exact edges in `app_location_references`, whose composite
 *     `ON DELETE RESTRICT` foreign key is what makes a place a persona stands
 *     on undeletable. The edges are replaced as a COMPLETE set on every
 *     authoritative commit, so they are derived state that any unrelated
 *     commit reconverges — the same contract lookup edges have.
 *   - **rows -> document.** A location row names a level. Removing a level
 *     while places still stand at it is refused here rather than enforced by
 *     a foreign key, because the commit rewrites `blueprint_entities` from
 *     its own diff and a `RESTRICT` edge would fire on ordinary unrelated
 *     edits.
 *
 * Both run after the verdict and before the entity write, so a rejection
 * leaves nothing behind.
 */

/**
 * Every location row the document references, deduplicated and sorted.
 *
 * Sorted because the insert order of an edge set is the only thing standing
 * between two concurrent app commits and a deadlock on the same rows.
 *
 * Today the only carrier is a persona's assignment. When authored location
 * TERMS land, they extend this one extractor rather than adding a second
 * table — a term and an assignment are the same kind of edge.
 */
export function extractLocationReferenceTargets(
	doc: BlueprintDoc,
): readonly string[] {
	const targets = new Set<string>();
	for (const persona of Object.values(personasOf(doc))) {
		for (const uuid of assignedLocationUuids(persona.locations)) {
			targets.add(uuid);
		}
	}
	return [...targets].sort();
}

/**
 * Replace the app's complete location edge set, proving every target is a
 * live place in THIS app first.
 *
 * The existence check is explicit rather than left to the foreign key so a
 * reference the author can actually fix produces a sentence they can read.
 * The key still earns its place: it is what stops a concurrent delete from
 * stranding an edge, which no application-level check can promise.
 *
 * An ARCHIVED place is deliberately a legal target. Archiving is reversible
 * and does not delete the row, so a reference to one is stale rather than
 * broken — and the archive cascade has already removed the assignments that
 * pointed into the archived subtree, so this only arises from a race the next
 * commit reconverges.
 */
export async function replaceLocationReferenceEdges(
	tx: Transaction<AppDatabase>,
	args: { readonly appId: string; readonly targets: readonly string[] },
): Promise<void> {
	const { appId, targets } = args;

	await tx
		.deleteFrom("app_location_references")
		.where("app_id", "=", appId)
		.execute();
	if (targets.length === 0) return;

	const live = await tx
		.selectFrom("app_locations")
		.select("id")
		.where("app_id", "=", appId)
		.where("id", "in", targets)
		// FOR KEY SHARE, not FOR SHARE: it blocks a concurrent delete of the
		// row without blocking an ordinary edit to it, which is exactly the
		// guarantee an edge needs.
		.forKeyShare()
		.execute();
	const found = new Set(live.map((row) => row.id));
	const missing = targets.filter((target) => !found.has(target));
	if (missing.length > 0) {
		throw new BlueprintCommitRejectedError(
			"A persona is assigned to a place that no longer exists in this app's organization. Reload to get the latest places, then choose where that persona works.",
		);
	}

	await tx
		.insertInto("app_location_references")
		.values(
			targets.map((locationId) => ({ app_id: appId, location_id: locationId })),
		)
		.execute();
}

/**
 * Refuse a commit that removes a level while places still stand at it.
 *
 * This is HQ's own rule, and its scope is worth stating exactly:
 * `views.py::LocationTypesView.remove_old_location_types` blocks deletion
 * when `SQLLocation.objects.filter(location_type=pk).exists()` — using
 * `objects` rather than `active_objects`, so **archived places count**. Nova
 * counts them too. An archived place is recoverable, and unarchiving one
 * whose level had been deleted underneath it would resurrect a row pointing
 * at nothing.
 */
export async function assertRemovedLevelsUnused(
	tx: Transaction<AppDatabase>,
	args: {
		readonly appId: string;
		readonly previousDoc: BlueprintDoc;
		readonly candidateDoc: BlueprintDoc;
	},
): Promise<void> {
	const { appId, previousDoc, candidateDoc } = args;
	const surviving = organizationLevelsOf(candidateDoc);
	const removed = Object.values(organizationLevelsOf(previousDoc)).filter(
		(level) => surviving[level.uuid] === undefined,
	);
	if (removed.length === 0) return;

	const occupied = await tx
		.selectFrom("app_locations")
		.select("level_uuid")
		.distinct()
		.where("app_id", "=", appId)
		.where(
			"level_uuid",
			"in",
			removed.map((level) => level.uuid),
		)
		.execute();
	if (occupied.length === 0) return;

	const blocked = new Set(occupied.map((row) => row.level_uuid));
	const names = removed
		.filter((level) => blocked.has(level.uuid))
		.map((level) => `"${level.name}"`);
	throw new BlueprintCommitRejectedError(
		names.length === 1
			? `${names[0]} still has places in it, so the level can't be removed. Move or archive those places first.`
			: `${names.join(" and ")} still have places in them, so those levels can't be removed. Move or archive those places first.`,
	);
}
