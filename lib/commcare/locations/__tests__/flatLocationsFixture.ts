/**
 * The flat `locations` fixture — a TEST ASSET, and deliberately not a module
 * the product imports.
 *
 * Nova never delivers this fixture and cannot: HQ builds one per worker at
 * RESTORE time from the domain's own `SQLLocation` rows
 * (`locations/fixtures.py::FlatLocationSerializer`), and nothing Nova exports
 * could carry it anyway — a `.ccz` is an app, and this is per worker. So it
 * lives here rather than under `lib/commcare/`, beside the only thing that
 * reads it.
 *
 * What it is for: `instance('locations')` is what every location owner term
 * lowers against (`predicate/termEmitter.ts::emitTerm`), and that lowering has
 * to be provable against the exact bytes a device reads. A wire shape nobody
 * can execute is a wire shape nobody can check, and the failure it hides is
 * silent — a missing fixture and an empty one are indistinguishable at
 * evaluation (`commcare-core .../CommCareInstanceInitializer::loadFixtureRoot`),
 * so a wrong element name resolves to nothing with no build-time error.
 * `ownerHopParity.harness.test.ts` is what makes that concrete: this emitter's
 * output and `compileTerm.ts`'s SQL must name the same place.
 *
 * Two nodes, matching `locations/fixtures.py::FlatLocationSerializer
 * ::get_xml_nodes`: the index schema and the fixture itself.
 *
 * It is also not a SUITE fixture, and `instanceDeclaration.test.ts` pins that:
 * `suiteOracle.ts::checkFixtures` rejects `user_id` on an embedded fixture and
 * requires an embedded `<fixture>` for every suite-scoped `jr://fixture/X`
 * instance — rightly, because a suite fixture is global while this one is per
 * worker by construction.
 *
 * Byte facts, each read out of the serializer rather than a doc:
 *
 *   - index attrs are `@{code}_id` for EVERY level in the domain, plus `@id`,
 *     `@type`, and `name`. Sorted, and custom fields are never indexed.
 *   - `<fixture id="locations" user_id="…" indexed="true">` wrapping one
 *     `<locations>` body.
 *   - places are ordered by `site_code` (`order_by('site_code')`).
 *   - each `<location type="{levelCode}" id="{placeId}" …>` carries one
 *     `{code}_id` attribute per level — empty except for itself and each
 *     ancestor.
 *   - children in exactly this order: `name`, `site_code`, `external_id`,
 *     `latitude`, `longitude`, `location_type`, `supply_point_id`, then one
 *     `<location_data>` holding every DEFINED custom field, empty when unset.
 *     `location_type` carries the level CODE.
 *
 * `supply_point_id` is always empty: it is a commtrack identity, and Nova has
 * no commtrack. Emitting the element anyway is deliberate — HQ emits it
 * unconditionally, and an author's expression comparing it to `''` must answer
 * the same here as in the field.
 */

import render from "dom-serializer";
import type { Element } from "domhandler";
import { el, RENDER_OPTS, text } from "@/lib/commcare/elementBuilders";
import type { LocationProperty, OrganizationLevel, Uuid } from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";

/** The fixture id, its instance id, and the `jr://fixture/` suffix — all one
 *  string, because `loadFixtureRoot` resolves the instance by the substring
 *  after the last `/` and a mismatched pair silently resolves to nothing. */
export const LOCATIONS_FIXTURE_ID = "locations";

export interface CompiledLocationsFixture {
	/** `<schema id="locations">`, the index declaration. */
	readonly schema: Element;
	/** `<fixture id="locations" user_id …>`, the data. */
	readonly fixture: Element;
	/** Both nodes serialized under the shared render options. */
	readonly xml: string;
	/** Exact UTF-8 bytes of `xml`. */
	readonly bytes: number;
	readonly placeCount: number;
}

/** One level-code attribute name, `{code}_id`. */
function levelAttribute(code: string): string {
	return `${code}_id`;
}

/**
 * The index schema node.
 *
 * Every level in the app, not only the levels the worker's own places stand
 * at: HQ builds this from `LocationType.objects.filter(domain=domain)`, so the
 * index shape is a property of the app rather than of the restore. Two workers
 * therefore get the same schema and a different fixture, which is what lets one
 * compiled expression work for both.
 */
function buildSchemaNode(levels: readonly OrganizationLevel[]): Element {
	const attributes = [
		...levels.map((level) => `@${levelAttribute(level.code)}`),
		"@id",
		"@type",
		"name",
	].sort();
	return el("schema", { id: LOCATIONS_FIXTURE_ID }, [
		el(
			"indices",
			{},
			attributes.map((attribute) => el("index", {}, [text(attribute)])),
		),
	]);
}

/**
 * Walk a place's ancestor chain, stamping one `{code}_id` per generation.
 *
 * Bounded by the places in scope: HQ falls back to a database read for an
 * ancestor the queryset missed and soft-asserts about it, which is a symptom
 * of its queryset being assembled separately from the walk. Nova's footprint
 * enumerator includes every qualifying ancestor by construction
 * (`lib/organization/footprint.ts`), so a chain that leaves the scope simply
 * stops — the same bytes HQ would emit after its fallback, minus the fallback.
 */
function lineageAttributes(
	place: StoredLocation,
	byId: ReadonlyMap<string, StoredLocation>,
	levelCodes: ReadonlyMap<string, string>,
): Record<string, string> {
	const attributes: Record<string, string> = {};
	let cursor: StoredLocation | undefined = place;
	const seen = new Set<string>();
	while (cursor !== undefined && !seen.has(cursor.id)) {
		seen.add(cursor.id);
		const code = levelCodes.get(cursor.levelUuid);
		if (code !== undefined) attributes[levelAttribute(code)] = cursor.id;
		cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
	}
	return attributes;
}

/**
 * Build the two nodes for one worker's footprint.
 *
 * `places` is that worker's footprint, already scoped — this emitter never
 * decides WHO sees what. It does drop an ARCHIVED place, which is a different
 * question: HQ's own queryset prunes those in every arm, so shipping one would
 * be a divergence rather than a wider scope. `levels` is the whole app's level
 * catalog, because the index and the per-place attribute set are app-wide.
 */
export function buildFlatLocationsFixture(args: {
	readonly userId: string;
	readonly places: readonly StoredLocation[];
	readonly levels: readonly OrganizationLevel[];
	/** Every custom field the app defines, in authored order. */
	readonly locationProperties: readonly LocationProperty[];
}): CompiledLocationsFixture {
	const { userId, levels, locationProperties } = args;
	const levelCodes = new Map<string, string>(
		levels.map((level) => [level.uuid as string, level.code]),
	);
	// An archived place never reaches a device.
	// `get_location_fixture_ids.sql` filters `is_archived = FALSE` in EVERY arm
	// and recurses from `parent_id IS NULL`, so an archived place is absent and
	// so is everything under it. This emitter enforces it rather than trusting
	// the caller, because the failure is silent in the direction that matters:
	// a place shipped after archiving is a destination a worker can still be
	// handed cases at, and nothing downstream would notice. Nova's archive
	// cascades to descendants, so filtering here is enough to reproduce HQ's
	// pruning without walking for it.
	const live = args.places.filter((place) => place.archivedAt === null);
	const byId = new Map(live.map((place) => [place.id as string, place]));
	// `order_by('site_code')`. Byte-for-byte with HQ, and stable for a diff.
	const places = [...live].sort((a, b) =>
		a.siteCode < b.siteCode ? -1 : a.siteCode > b.siteCode ? 1 : 0,
	);
	// Every level's attribute, empty, then the place's own lineage over the
	// top. HQ seeds them all before the walk for the same reason: an absent
	// attribute and an empty one answer a comparison differently, and a device
	// evaluating `@district_id = ''` must get the same answer for a place with
	// no district as it would in the field.
	const emptyLineage: Record<string, string> = {};
	for (const level of levels) emptyLineage[levelAttribute(level.code)] = "";

	const fixture = el(
		"fixture",
		{ id: LOCATIONS_FIXTURE_ID, user_id: userId, indexed: "true" },
		[
			el(
				"locations",
				{},
				places.map((place) => {
					const code = levelCodes.get(place.levelUuid) ?? "";
					return el(
						"location",
						{
							type: code,
							id: place.id as string,
							...emptyLineage,
							...lineageAttributes(place, byId, levelCodes),
						},
						[
							el("name", {}, [text(place.name)]),
							el("site_code", {}, [text(place.siteCode)]),
							el("external_id", {}, [text(place.externalId ?? "")]),
							el("latitude", {}, [text(place.latitude ?? "")]),
							el("longitude", {}, [text(place.longitude ?? "")]),
							el("location_type", {}, [text(code)]),
							// Always empty: a commtrack identity, and Nova has no
							// commtrack. Present because HQ emits it unconditionally.
							el("supply_point_id", {}, []),
							el(
								"location_data",
								{},
								locationProperties.map((property) =>
									el(property.slug, {}, [
										text(place.values[property.uuid as Uuid] ?? ""),
									]),
								),
							),
						],
					);
				}),
			),
		],
	);
	const schema = buildSchemaNode(levels);
	const xml = `${render(schema, RENDER_OPTS)}${render(fixture, RENDER_OPTS)}`;
	return {
		schema,
		fixture,
		xml,
		bytes: Buffer.byteLength(xml, "utf8"),
		placeCount: places.length,
	};
}
