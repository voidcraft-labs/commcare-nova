import {
	assignedLocationUuids,
	type OrganizationCollections,
	type Persona,
} from "@/lib/domain";
import {
	assignmentFootprintIncludes,
	type OwnerVerdictLocation,
} from "./ownerTargetVerdicts";
import type { StoredLocation } from "./types";

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
 *
 * The pure tests specify exact destinations for each address-book mode,
 * including ancestor retention, sibling branches, depth limits and multiple
 * assignments, and check both the enumerator and membership predicate against
 * those independent expectations.
 */
export function personaFootprint<Row extends OwnerVerdictLocation>(
	doc: OrganizationCollections,
	persona: Persona,
	rows: readonly Row[],
): readonly Row[] {
	const byId = new Map<string, OwnerVerdictLocation>(
		rows.map((row) => [row.id, row]),
	);
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

/** One place of a worker's flat `locations` fixture, as plain JSON. */
export interface LocationFixtureRow {
	readonly id: string;
	readonly levelUuid: string;
	readonly siteCode: string;
	readonly name: string;
	readonly externalId: string | null;
	readonly latitude: string | null;
	readonly longitude: string | null;
	/** Place information keyed by location-property UUID. */
	readonly values: Readonly<Record<string, string>>;
	/** Level UUID → the id of this place's ancestor at that level. */
	readonly lineage: Readonly<Record<string, string>>;
}

/**
 * The places of a persona's `locations` fixture with what the fixture prints
 * of each: its footprint ({@link personaFootprint}), each place carrying the
 * id of every ancestor by level, read from the whole tree as HQ walks a
 * place's parents (`corehq/apps/locations/fixtures.py::FlatLocationSerializer._get_fixture_node`).
 */
export function locationFixtureRows(
	doc: OrganizationCollections,
	persona: Persona,
	places: readonly StoredLocation[],
): readonly LocationFixtureRow[] {
	const byId = new Map<string, StoredLocation>(
		places.map((place) => [place.id, place]),
	);
	return personaFootprint(doc, persona, places).map((place) => {
		const lineage: Record<string, string> = {};
		const seen = new Set<string>([place.id]);
		let parent = place.parentId === null ? undefined : byId.get(place.parentId);
		while (parent !== undefined && !seen.has(parent.id)) {
			seen.add(parent.id);
			lineage[parent.levelUuid] = parent.id;
			parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
		}
		return {
			id: place.id,
			levelUuid: place.levelUuid,
			siteCode: place.siteCode,
			name: place.name,
			externalId: place.externalId,
			latitude: place.latitude,
			longitude: place.longitude,
			values: place.values,
			lineage,
		};
	});
}
