// The flat `locations` fixture, against CommCare HQ's own serializer output.
//
// These bytes are load-bearing rather than decorative: every location owner
// term already lowers to `instance('locations')/locations/location[…]/@id`, so
// a wrong element name or a missing lineage attribute makes the rule resolve to
// NOTHING on a device — silently, because a missing fixture and an empty one
// are the same thing at evaluation time.
//
// The oracle is `corehq/apps/locations/tests/data/expand_from_root_flat.xml`,
// which is byte-exact output of the current serializer. Naming it honestly:
// HQ files no LIVE flat-fixture byte assertion — `FixtureHasLocationsMixin
// ::_assert_fixture_matches_file` is only ever called with the hierarchical
// generator, and both flat data files are orphaned. HQ's live flat assertions
// are structural (`LocationFixturesDataTest`). So this file is a STRUCTURAL
// oracle, used the way the suite fixtures are: parsed on both sides so escaping
// and attribute order cannot produce a false difference.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Parser } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { LocationProperty, OrganizationLevel, Uuid } from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import { buildFlatLocationsFixture } from "../fixture";

const CCHQ_FLAT_FIXTURE = join(
	homedir(),
	"code/commcare-hq/corehq/apps/locations/tests/data/expand_from_root_flat.xml",
);
const CCHQ_INDEXED_FIXTURE = join(
	homedir(),
	"code/commcare-hq/corehq/apps/locations/tests/data/index_location_fixtures.xml",
);

interface Node {
	readonly name: string;
	readonly attribs: Readonly<Record<string, string>>;
	readonly text: string;
	readonly children: readonly Node[];
}

function parse(xml: string): Node[] {
	const roots: Node[] = [];
	const stack: Array<{
		name: string;
		attribs: Record<string, string>;
		text: string;
		children: Node[];
	}> = [];
	const parser = new Parser(
		{
			onopentag(name, attribs) {
				stack.push({ name, attribs: { ...attribs }, text: "", children: [] });
			},
			ontext(chunk) {
				const top = stack[stack.length - 1];
				if (top !== undefined) top.text += chunk;
			},
			onclosetag() {
				const frame = stack.pop();
				if (frame === undefined) return;
				const node: Node = {
					name: frame.name,
					attribs: frame.attribs,
					text: frame.text.trim(),
					children: frame.children,
				};
				const parent = stack[stack.length - 1];
				if (parent === undefined) roots.push(node);
				else parent.children.push(node);
			},
		},
		{ xmlMode: true },
	);
	parser.end(xml);
	return roots;
}

const STATE = testUuid("level-state");
const COUNTY = testUuid("level-county");
const CITY = testUuid("level-city");

const LEVELS: OrganizationLevel[] = [
	{
		uuid: STATE,
		code: "state",
		name: "State",
		caseFlow: { workers: "none", ownsCases: false },
		addressBook: { reach: "own-branch" },
	},
	{
		uuid: COUNTY,
		code: "county",
		name: "County",
		parentLevelUuid: STATE,
		caseFlow: { workers: "none", ownsCases: true },
		addressBook: { reach: "own-branch" },
	},
	{
		uuid: CITY,
		code: "city",
		name: "City",
		parentLevelUuid: COUNTY,
		caseFlow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "none" },
		},
		addressBook: { reach: "own-branch" },
	},
];

function place(args: {
	id: string;
	name: string;
	siteCode: string;
	levelUuid: string;
	parentId?: string;
	values?: Record<string, string>;
}): StoredLocation {
	return {
		id: args.id as Uuid,
		levelUuid: args.levelUuid,
		parentId: (args.parentId ?? null) as Uuid | null,
		siteCode: args.siteCode,
		name: args.name,
		externalId: null,
		latitude: null,
		longitude: null,
		values: args.values ?? {},
		archivedAt: null,
		orderKey: "a",
	};
}

const MASSACHUSETTS = testUuid("place-massachusetts");
const SUFFOLK = testUuid("place-suffolk");
const BOSTON = testUuid("place-boston");

function threeGenerations(): StoredLocation[] {
	return [
		place({
			id: MASSACHUSETTS,
			name: "Massachusetts",
			siteCode: "massachusetts",
			levelUuid: STATE,
		}),
		place({
			id: SUFFOLK,
			name: "Suffolk",
			siteCode: "suffolk",
			levelUuid: COUNTY,
			parentId: MASSACHUSETTS,
		}),
		place({
			id: BOSTON,
			name: "Boston",
			siteCode: "boston",
			levelUuid: CITY,
			parentId: SUFFOLK,
		}),
	];
}

function build(places: StoredLocation[], properties: LocationProperty[] = []) {
	return buildFlatLocationsFixture({
		userId: "worker-1",
		places,
		levels: LEVELS,
		locationProperties: properties,
	});
}

describe("the flat locations fixture", () => {
	it("wraps the places the way a restore delivers them", () => {
		const [, fixture] = parse(build(threeGenerations()).xml);
		expect(fixture.name).toBe("fixture");
		expect(fixture.attribs.id).toBe("locations");
		expect(fixture.attribs.indexed).toBe("true");
		// `user_id` is what makes it PER-WORKER, and what makes it impossible
		// to embed in the suite: `suiteOracle::checkFixtures` rejects a
		// user-scoped fixture there, because a suite fixture is global.
		expect(fixture.attribs.user_id).toBe("worker-1");
		expect(fixture.children[0]?.name).toBe("locations");
	});

	it("indexes every level in the app, plus id, type, and name", () => {
		// App-wide, not restore-wide: HQ builds this from the domain's whole
		// `LocationType` set, which is why one compiled expression works for
		// two workers whose footprints stand at different levels.
		const [schema] = parse(build([threeGenerations()[0]]).xml);
		expect(schema.name).toBe("schema");
		expect(schema.attribs.id).toBe("locations");
		expect(schema.children[0]?.children.map((index) => index.text)).toEqual([
			"@city_id",
			"@county_id",
			"@id",
			"@state_id",
			"@type",
			"name",
		]);
	});

	it("stamps one attribute per level, empty except self and each ancestor", () => {
		// The whole point of the flat shape: a reverse hop reads `@state_id`
		// off a city and gets the state, with no tree walk.
		const [, fixture] = parse(build(threeGenerations()).xml);
		const boston = fixture.children[0].children.find(
			(node) => node.attribs.id === BOSTON,
		);
		expect(boston?.attribs.type).toBe("city");
		expect(boston?.attribs.city_id).toBe(BOSTON);
		expect(boston?.attribs.county_id).toBe(SUFFOLK);
		expect(boston?.attribs.state_id).toBe(MASSACHUSETTS);

		const state = fixture.children[0].children.find(
			(node) => node.attribs.id === MASSACHUSETTS,
		);
		// Present and EMPTY, never absent: `@county_id = ''` has to answer the
		// same here as on a device, and an absent attribute answers differently.
		expect(state?.attribs.county_id).toBe("");
		expect(state?.attribs.city_id).toBe("");
		expect(state?.attribs.state_id).toBe(MASSACHUSETTS);
	});

	it("orders places by site code", () => {
		const [, fixture] = parse(build(threeGenerations()).xml);
		expect(
			fixture.children[0].children.map(
				(node) =>
					node.children.find((child) => child.name === "site_code")?.text,
			),
		).toEqual(["boston", "massachusetts", "suffolk"]);
	});

	it("emits the seven children in HQ's order, then location_data", () => {
		const [, fixture] = parse(build(threeGenerations()).xml);
		const boston = fixture.children[0].children.find(
			(node) => node.attribs.id === BOSTON,
		);
		expect(boston?.children.map((child) => child.name)).toEqual([
			"name",
			"site_code",
			"external_id",
			"latitude",
			"longitude",
			"location_type",
			"supply_point_id",
			"location_data",
		]);
		// The level CODE, not its name and not the uuid.
		expect(
			boston?.children.find((child) => child.name === "location_type")?.text,
		).toBe("city");
		// Always empty. A commtrack identity, and Nova has no commtrack — but
		// present, because HQ emits it and a `= ''` comparison must agree.
		expect(
			boston?.children.find((child) => child.name === "supply_point_id")?.text,
		).toBe("");
	});

	it("carries every defined custom field, empty when a place has none", () => {
		// `_get_metadata_node` seeds every DEFINED field before applying values,
		// the same declared-but-empty vs absent split worker data has.
		const properties: LocationProperty[] = [
			{
				uuid: testUuid("loc-prop-catchment"),
				slug: "catchment",
				label: "Catchment",
			},
			{ uuid: testUuid("loc-prop-ward"), slug: "ward", label: "Ward" },
		];
		const places = threeGenerations();
		const withValue = {
			...places[2],
			values: { [properties[0].uuid]: "north" },
		} as StoredLocation;

		const [, fixture] = parse(build([withValue], properties).xml);
		const data = fixture.children[0].children[0].children.find(
			(child) => child.name === "location_data",
		);
		expect(data?.children.map((child) => [child.name, child.text])).toEqual([
			["catchment", "north"],
			["ward", ""],
		]);
	});

	it("is empty for a worker whose footprint is empty", () => {
		// Not a whole-tree fallback. HQ ships an empty fixture to a user with no
		// locations, so an expression naming a place finds nothing rather than
		// finding everyone's.
		const built = build([]);
		expect(built.placeCount).toBe(0);
		const [, fixture] = parse(built.xml);
		expect(fixture.children[0].children).toEqual([]);
	});

	it.skipIf(!existsSync(CCHQ_FLAT_FIXTURE))(
		"matches the shape of CommCare HQ's own serializer output",
		() => {
			const hq = parse(readFileSync(CCHQ_FLAT_FIXTURE, "utf8"))[0];
			const [, mine] = parse(build(threeGenerations()).xml);

			expect(Object.keys(hq.attribs).sort()).toEqual(
				Object.keys(mine.attribs).sort(),
			);
			expect(hq.children[0].name).toBe(mine.children[0].name);

			const hqCity = hq.children[0].children.find(
				(node) => node.attribs.type === "city",
			);
			const myCity = mine.children[0].children.find(
				(node) => node.attribs.type === "city",
			);
			// Same attribute NAMES and same child order. The values differ (HQ's
			// tree is Boston-in-Suffolk-in-Massachusetts with placeholder ids),
			// and the shape is the contract.
			expect(Object.keys(hqCity?.attribs ?? {}).sort()).toEqual(
				Object.keys(myCity?.attribs ?? {}).sort(),
			);
			expect(hqCity?.children.map((child) => child.name)).toEqual(
				myCity?.children.map((child) => child.name),
			);
		},
	);

	it.skipIf(!existsSync(CCHQ_INDEXED_FIXTURE))(
		"never emits the removed data_<slug> shape",
		() => {
			// `index_location_fixtures.xml` is the other orphaned data file, and
			// it shows a `data_<slug>` attribute/child pair from the removed
			// `index_in_fixture` feature. Building to it would emit attributes no
			// current serializer produces.
			const removed = readFileSync(CCHQ_INDEXED_FIXTURE, "utf8");
			expect(removed).toContain("data_");

			const properties: LocationProperty[] = [
				{ uuid: testUuid("loc-prop-ward"), slug: "ward", label: "Ward" },
			];
			expect(build(threeGenerations(), properties).xml).not.toContain("data_");
		},
	);
});
