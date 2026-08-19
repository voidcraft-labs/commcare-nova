import {
	assignedLocationUuids,
	levelOwnsCases,
	type OrganizationCollections,
	organizationLevelsOf,
	type Persona,
} from "@/lib/domain";
import {
	assignmentReceivesCasesFrom,
	type OwnerVerdictLocation,
} from "./ownerTargetVerdicts";

/**
 * The owner ids a persona's device would hold.
 *
 * This is `CouchUser.get_owner_ids`: the worker's own id, plus one id per
 * case-sharing group. Nova has no classic groups, so every other member is a
 * place — HQ turns each case-owning location a user reaches into a group whose
 * `_id` IS the `location_id`
 * (`corehq/apps/locations/models.py::SQLLocation.case_sharing_group_object`),
 * which is why place ids drop straight into this list rather than being mapped
 * through anything.
 *
 * Which places a worker reaches is `CouchUser._get_case_owning_locations`:
 * assigned places whose level owns cases, plus descendants of assigned places
 * whose level views descendants, bounded by that level's descendant scope, and
 * always excluding archived places. That rule already exists as
 * {@link assignmentReceivesCasesFrom}, asked one target at a time by the
 * commit gate; this walks the same predicate over every row instead of
 * restating it.
 *
 * `rows` is the app's complete place tree — the same shape and the same
 * reason `lockTree` takes the whole tree rather than a recursive query: it is
 * bounded, and a walk over a map cannot be subtly wrong about cycles.
 */
export function personaOwnerIds(
	doc: OrganizationCollections,
	persona: Persona,
	rows: readonly OwnerVerdictLocation[],
): readonly string[] {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const levels = organizationLevelsOf(doc);
	const assigned = assignedLocationUuids(persona.locations)
		.map((uuid) => byId.get(uuid))
		.filter(
			(row): row is OwnerVerdictLocation =>
				row !== undefined && row.archivedAt === null,
		);

	const places: string[] = [];
	if (assigned.length > 0) {
		for (const row of rows) {
			if (row.archivedAt !== null) continue;
			const level = levels[row.levelUuid];
			if (level === undefined || !levelOwnsCases(level)) continue;
			if (
				assigned.some((from) =>
					assignmentReceivesCasesFrom(row, from, byId, doc),
				)
			) {
				places.push(row.id);
			}
		}
	}

	// The worker's own id first, then places in a stable order. HQ builds the
	// same list unordered; pinning the order here is what lets a test assert it.
	return [persona.uuid, ...places.sort()];
}

/**
 * The owner ids for a preview that is running as the signed-in member rather
 * than a persona.
 *
 * A member is a worker assigned nowhere: no assignment means no case-sharing
 * group, so the set is exactly their own id. This is a real answer, not a
 * degraded one — it is what a worker with no location assignment receives.
 */
export function memberOwnerIds(userId: string): readonly string[] {
	return [userId];
}
