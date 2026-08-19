import {
	assignedLocationUuids,
	type BlueprintDoc,
	type Persona,
} from "@/lib/domain";
import {
	assignmentFootprintIncludes,
	type OwnerVerdictLocation,
} from "./ownerTargetVerdicts";

/**
 * Every place a persona's device can name — the contents of their `locations`
 * fixture.
 *
 * Scoped entirely separately from what they OWN: widening an address book lets
 * expressions name more places without moving a single case
 * (`corehq/apps/locations/sql_templates/get_location_fixture_ids.sql`, reached
 * from `corehq/apps/locations/fixtures.py::_location_queryset_helper`).
 *
 * The four address-book arms are already decided, one target at a time, by
 * {@link assignmentFootprintIncludes} — including the ragged-tree quirk where
 * HQ compares a location-tree depth against a level-tree depth. This
 * enumerates that predicate rather than re-encoding those arms, because a
 * second encoding is a second thing to keep true.
 *
 * An unassigned persona has an EMPTY footprint, not a whole-tree one: HQ ships
 * an empty fixture to a user with no locations
 * (`corehq/apps/locations/tests/test_location_fixtures.py::LocationFixturesTest.test_no_user_locations_returns_empty`).
 *
 * Rows come back in the caller's order; the fixture emitter is what imposes
 * the wire's `site_code` ordering.
 */
export function personaFootprint(
	doc: BlueprintDoc,
	persona: Persona,
	rows: readonly OwnerVerdictLocation[],
): readonly OwnerVerdictLocation[] {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const assigned = assignedLocationUuids(persona.locations)
		.map((uuid) => byId.get(uuid))
		.filter(
			(row): row is OwnerVerdictLocation =>
				row !== undefined && row.archivedAt === null,
		);
	if (assigned.length === 0) return [];

	return rows.filter(
		(row) =>
			row.archivedAt === null &&
			assigned.some((from) =>
				assignmentFootprintIncludes(row, from, byId, doc),
			),
	);
}
