/**
 * Whether an app brought in from CommCare HQ reads places, the plan of Nova's
 * copy of the project space's places, and the owner rules that copy would
 * refuse.
 *
 * It would catch: places never read for an app whose case list filter or form
 * names the locations instance in a spelling the test misses; a refresh that
 * advances on a list CommCare HQ only reordered; a plan that hands the
 * organization's writer a place its integrity step refuses, or leaves a
 * problem unfound until the birth; a place left out at a level the app lacks
 * counted under a level the app has; a level Nova cannot hold left unfound in
 * an app that reads places, or found in one that reads none; and a birth the
 * organization's integrity step refuses for an owner rule with no single place
 * to land on.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { HqFailure } from "@/lib/commcare/hq/failure";
import type { HqLocation, HqLocationType } from "@/lib/commcare/hq/locations";
import { locationOwnerFixture } from "@/lib/commcare/locations/__tests__/locationOwnerFixture";
import { readHqApp } from "@/lib/commcare/reader";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import type { ReadOutcome } from "@/lib/commcare/reader/types";
import type {
	BlueprintDoc,
	LocationProperty,
	OrganizationLevel,
	Uuid,
} from "@/lib/domain";
import type { LookupRevision } from "@/lib/lookup/types";
import { circumstanceFinding } from "@/lib/publish/hqFindings";
import { readBackInput, servedExport } from "../../__tests__/novaReading";
import { manifestFinding } from "../findings";
import {
	assembleReadingProjectData,
	readingProjectDataFindingsFor,
	unreadPlacesFailure,
} from "../index";
import {
	documentReadsPlaces,
	planManagedPlaces,
	sourceMayReadPlaces,
} from "../places";

const ORGANIZATION = { kind: "organization" } as const;
const notHoldable = (name: string) =>
	circumstanceFinding("place-field-unusable", ORGANIZATION, { name });

const STATE = testUuid("places-level-state");
const DISTRICT = testUuid("places-level-district");
const CLINIC = testUuid("places-level-clinic");

function level(
	uuid: Uuid,
	code: string,
	parentLevelUuid?: Uuid,
): OrganizationLevel {
	return {
		uuid,
		code,
		name: code.toUpperCase(),
		...(parentLevelUuid === undefined ? {} : { parentLevelUuid }),
		caseFlow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "none" },
		},
		addressBook: { reach: "own-branch" },
	};
}

const LEVELS = [
	level(STATE, "state"),
	level(DISTRICT, "district", STATE),
	level(CLINIC, "clinic", DISTRICT),
];

const BEDS = testUuid("places-property-beds");
const CATCHMENT = testUuid("places-property-catchment");
const PROPERTIES: LocationProperty[] = [
	{ uuid: BEDS, slug: "beds", label: "beds" },
	// Applies only at clinics.
	{
		uuid: CATCHMENT,
		slug: "catchment",
		label: "catchment",
		levelUuids: [CLINIC],
	},
];

function place(
	siteCode: string,
	locationTypeCode: string,
	parentLocationId: string | null,
	more: Partial<HqLocation> = {},
): HqLocation {
	return {
		locationId: `hq-${siteCode}`,
		name: siteCode.toUpperCase(),
		siteCode,
		locationTypeCode,
		parentLocationId,
		latitude: null,
		longitude: null,
		values: {},
		...more,
	};
}

const TREE: HqLocation[] = [
	place("north", "state", null, {
		latitude: "12.5000000000",
		longitude: "-0.0000000000",
		values: { beds: "4", catchment: "wide", foreign: 7 },
	}),
	place("lakes", "district", "hq-north"),
	place("lakeside", "clinic", "hq-lakes", {
		values: { beds: "12", catchment: "shore" },
	}),
	place("hilltop", "clinic", "hq-lakes"),
];

const MODES = ["birth", "refresh"] as const;

function plan(hqPlaces: readonly HqLocation[], mode: "birth" | "refresh") {
	return planManagedPlaces({
		hqPlaces,
		levels: LEVELS,
		properties: PROPERTIES,
		mode,
	});
}

describe("sourceMayReadPlaces", () => {
	it.each([
		["instance('locations')/locations/location[@id = 'x']/@name"],
		['instance("locations")/locations/location'],
		["instance( 'locations' )/locations/location"],
		// A suite expression in the JSON body: a double quote is `\"`.
		['{"filter": "instance(\\"locations\\")/locations/location"}'],
		// A form's attribute, with its quote mark written as an entity.
		['<bind calculate="instance(&apos;locations&apos;)/locations"/>'],
		['<bind calculate="instance(&quot;locations&quot;)/locations"/>'],
		// A form that reads places through an instance of another id.
		['<instance id="places" src="jr://fixture/locations"/>'],
		// The hierarchical fixture, whose read the reader counts as a read of
		// places: a miss would have the reading read project data twice.
		[
			'<instance id="commtrack:locations" src="jr://fixture/commtrack:locations"/>',
		],
	])("is true of %s", (text) => {
		expect(sourceMayReadPlaces(text)).toBe(true);
	});

	it("is false of a source that reads no place", () => {
		const text = `{"name": "Visits", "note": "visits at their locations",
			"filter": "instance('casedb')/casedb/case[@case_type = 'visit']"}`;
		expect(sourceMayReadPlaces(text)).toBe(false);
	});

	it.each([
		// The form builder's text id for a question named locations_visited.
		[`<label ref="jr:itext('locations_visited-label')"/>`],
		['<text id="locations_visited-label"><value>Places</value></text>'],
		// A case property whose name begins with the word, in the JSON body.
		['{"case_properties": ["locations_count"]}'],
		['{"filter": "instance(\\"casedb\\")/casedb/case[@locations_seen = 1]"}'],
	])("is false of a name that only begins with the word: %s", (text) => {
		expect(sourceMayReadPlaces(text)).toBe(false);
	});
});

describe("unreadPlacesFailure", () => {
	const failure: HqFailure = {
		kind: "permission",
		request: "location-types",
		status: 403,
		permission: "locations",
	};
	const unread = (placesUnread: HqFailure | null) =>
		assembleReadingProjectData({
			origin: { server: "india", domain: "clinic" },
			appId: "0b4f6a52-7c55-4a35-9d1e-3c2f8a1b4e6d",
			readingId: "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b",
			tablesReadAt: new Date("2026-11-10T09:00:00.000Z"),
			tables: [],
			hqTags: [],
			project: {
				projectId: "project-1",
				projectRevision: "0" as LookupRevision,
				definitions: [],
				rowsByTable: {},
				apps: {},
				siblings: [],
				mayAdminister: true,
			},
			measured: new Map(),
			places: null,
			placesUnread,
		});
	const work = {
		nodes: 0,
		syntaxReads: 0,
		rebuilds: 0,
		units: 0,
		byKind: { parse: 0, propose: 0, print: 0, compare: 0, visit: 0 },
		limit: 0,
	};
	const claims = {
		counts: {},
		handOffs: [],
		records(): never {
			throw new Error("counts alone");
		},
	};
	// A reading run without CommCare HQ's levels refuses a read of a place at
	// a level as an expression it cannot evaluate, and no bound tree then
	// reads places: an account whose source still reads them.
	const account: ReadOutcome = {
		kind: "account",
		findings: [
			manifestFinding(
				"expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant",
				{ kind: "app" },
				"district",
			),
		],
		work,
		claims,
		defects: [],
		unreadTables: [],
		readsLocations: true,
	};
	const readOf = (doc: BlueprintDoc): ReadOutcome => ({
		kind: "read",
		draft: {
			doc,
			identities: {
				modules: [],
				forms: [],
				keyedCreates: [],
				columnFieldWords: [],
				entries: [],
			},
			declaration: { kind: "none", blocking: [] },
			facts: {
				webAppsOnInHq: false,
				mediaReferences: [],
				unheldMedia: [],
				pendingMedia: [],
				unreadTables: [],
				foldedTranslationKeys: [],
				forms: [],
				sameStateRewrites: [],
				detailColumnOwners: [],
				formLinkOwners: [],
				entryFactsRefused: [],
				childCasesUnread: [],
				rewrites: [],
				expressionRounds: 0,
			},
		},
		work,
		claims,
		defects: [],
	});

	it("ends a reading the reader refused where its source reads places, so a permission is never shown as a broken app", () => {
		expect(unreadPlacesFailure(unread(failure), account)).toEqual(failure);
	});

	it("drops the failure for a reading the reader refused whose source reads no place", () => {
		expect(
			unreadPlacesFailure(unread(failure), {
				...account,
				readsLocations: false,
			}),
		).toBeNull();
	});

	/** A whole reading of `doc`'s export, told no level as a reading that could not read CommCare
	 *  HQ's places is, with the app body changed by `edit`. */
	async function readWithoutPlaces(
		doc: BlueprintDoc,
		edit: (body: Record<string, unknown>) => void = () => {},
	): Promise<ReadOutcome> {
		const served = servedExport(doc);
		edit(served.body);
		return readHqApp({
			...(await readBackInput(doc, served)),
			organization: { levelCodes: [], levels: [] },
		});
	}

	it("ends a reading whose only read of a place the reader refused", async () => {
		const outcome = await readWithoutPlaces(locationOwnerFixture("direct"));
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "account")
			throw new Error("A read of a level no level names was held.");
		expect(outcome.readsLocations).toBe(true);
		expect(unreadPlacesFailure(unread(failure), outcome)).toEqual(failure);
	});

	it("drops the failure for a reading the reader refused for something else, whose app reads no place", async () => {
		const outcome = await readWithoutPlaces(
			locationOwnerFixture("plain"),
			(body) => {
				body.use_custom_suite = true;
			},
		);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "account") throw new Error("A custom suite was read.");
		expect(outcome.readsLocations).toBe(false);
		expect(unreadPlacesFailure(unread(failure), outcome)).toBeNull();
	});

	it("ends a reading whose document reads places", () => {
		const doc = locationOwnerFixture("plain", { placeRead: true });
		expect(unreadPlacesFailure(unread(failure), readOf(doc))).toEqual(failure);
	});

	it("drops the failure where the reader read the whole document and it reads no place", () => {
		const doc = locationOwnerFixture("plain");
		expect(unreadPlacesFailure(unread(failure), readOf(doc))).toBeNull();
	});

	it("ends nothing where no read of the places failed", () => {
		expect(unreadPlacesFailure(unread(null), account)).toBeNull();
	});
});

describe("documentReadsPlaces", () => {
	it("is true of a form's calculate that reads places", () => {
		const doc = locationOwnerFixture("plain", { placeRead: true });
		expect(documentReadsPlaces(doc)).toBe(true);
	});

	it("is true of an owner rule at a level", () => {
		expect(documentReadsPlaces(locationOwnerFixture("multirung"))).toBe(true);
	});

	it("is false of an app whose logic reads no place", () => {
		expect(documentReadsPlaces(locationOwnerFixture("plain"))).toBe(false);
	});
});

describe.each(MODES)("planManagedPlaces at a %s", (mode) => {
	it("plans every place parent before child, as the store holds it", () => {
		const result = plan(TREE, mode);
		expect(result.findings).toEqual([]);
		expect(result.leftOut).toEqual({});
		expect(result.places).toEqual([
			{
				hqLocationId: "hq-north",
				siteCode: "north",
				name: "NORTH",
				levelUuid: STATE,
				parentSiteCode: null,
				latitude: "12.5",
				longitude: "0",
				// A key no property reads is not copied, nor a value of a
				// property that does not apply at the place's level.
				values: { [BEDS]: "4" },
			},
			{
				hqLocationId: "hq-lakes",
				siteCode: "lakes",
				name: "LAKES",
				levelUuid: DISTRICT,
				parentSiteCode: "north",
				latitude: null,
				longitude: null,
				values: {},
			},
			{
				hqLocationId: "hq-lakeside",
				siteCode: "lakeside",
				name: "LAKESIDE",
				levelUuid: CLINIC,
				parentSiteCode: "lakes",
				latitude: null,
				longitude: null,
				values: { [BEDS]: "12", [CATCHMENT]: "shore" },
			},
			{
				hqLocationId: "hq-hilltop",
				siteCode: "hilltop",
				name: "HILLTOP",
				levelUuid: CLINIC,
				parentSiteCode: "lakes",
				latitude: null,
				longitude: null,
				values: {},
			},
		]);
	});

	it("digests a reordered list alike, and a changed place otherwise", () => {
		const first = plan(TREE, mode);
		const reordered = plan([...TREE].reverse(), mode);
		expect(reordered.digest).toBe(first.digest);
		const seen = new Set<string>();
		for (const one of reordered.places) {
			if (one.parentSiteCode !== null)
				expect(seen.has(one.parentSiteCode)).toBe(true);
			seen.add(one.siteCode);
		}
		const renamed = TREE.map((one) =>
			one.siteCode === "hilltop" ? { ...one, name: "Hill top" } : one,
		);
		expect(plan(renamed, mode).digest).not.toBe(first.digest);
	});

	it("holds 10,001 source places and keeps case-sensitive and Unicode codes", () => {
		const many = Array.from({ length: 10_001 }, (_, index) =>
			place(`site_${index}`, "state", null),
		);
		many[0] = place("École", "state", null);
		many[1] = place("école", "state", null);
		const result = plan(many, mode);
		expect(result.findings).toEqual([]);
		expect(result.places).toHaveLength(10_001);
		expect(result.places.slice(0, 2).map((row) => row.siteCode)).toEqual([
			"École",
			"école",
		]);
	});

	it("holds a zero or tiny coordinate CommCare HQ spells in exponent form", () => {
		const result = plan(
			[
				place("equator", "state", null, {
					name: "Equator",
					latitude: "0E-10",
					longitude: "-0E-10",
				}),
				place("near", "state", null, {
					name: "Near",
					latitude: "1.000E-7",
					longitude: "-5E-7",
				}),
			],
			mode,
		);
		expect(result.findings).toEqual([]);
		expect(
			result.places.map(({ siteCode, latitude, longitude }) => ({
				siteCode,
				latitude,
				longitude,
			})),
		).toEqual([
			{ siteCode: "equator", latitude: "0", longitude: "0" },
			{ siteCode: "near", latitude: "0.0000001", longitude: "-0.0000005" },
		]);
	});

	it("finds a name too long and a coordinate the store refuses", () => {
		const long = "n".repeat(256);
		const result = plan(
			[
				place("long", "state", null, { name: long }),
				place("far", "state", null, { name: "Far", latitude: "12345678901.5" }),
				place("fine", "state", null, {
					name: "Fine",
					longitude: "12.12345678901",
				}),
			],
			mode,
		);
		expect(result.findings).toEqual([
			notHoldable(long),
			notHoldable("Far"),
			notHoldable("Fine"),
		]);
		expect(result.places).toEqual([]);
	});

	it("finds a parent not listed, a level out of place and a circle", () => {
		const result = plan(
			[
				place("north", "state", null),
				place("orphan", "clinic", "hq-gone"),
				// A district at the top, though districts stand under states.
				place("loose", "district", null),
				// A clinic under a state: a skipped level is allowed.
				place("lakeside", "clinic", "hq-north"),
				// A district under a clinic.
				place("upside", "district", "hq-lakeside"),
				// Under a place with a problem: held back, with no finding.
				place("under", "clinic", "hq-loose"),
				place("ring-a", "district", "hq-ring-b"),
				place("ring-b", "district", "hq-ring-a"),
			],
			mode,
		);
		expect(result.findings).toEqual([
			notHoldable("UPSIDE"),
			circumstanceFinding("place-hierarchy-inconsistent", ORGANIZATION, {}),
			notHoldable("LOOSE"),
		]);
		expect(result.places.map((one) => one.siteCode)).toEqual([
			"north",
			"lakeside",
		]);
	});

	it("projects numeric values to worker text and carries long values without truncation", () => {
		const result = plan(
			[
				place("north", "state", null, { values: { beds: 4 } }),
				place("south", "state", null, {
					values: { beds: "x".repeat(4097), catchment: 9 },
				}),
			],
			mode,
		);
		// `catchment` applies only at clinics, so a state's is not read.
		expect(result.findings).toEqual([]);
		expect(result.places.map((row) => row.values)).toEqual([
			{ [BEDS]: "4" },
			{ [BEDS]: "x".repeat(4097) },
		]);
	});

	it("finds a value whose worker text depends on an order CommCare HQ's answer sorted away", () => {
		/* A dictionary of two entries reaches a worker in the order it was
		 * saved, which HQ's JSON answer does not keep. One entry has one order. */
		const result = plan(
			[
				place("north", "state", null, { values: { beds: { a: 1, b: 2 } } }),
				place("south", "state", null, { values: { beds: { a: 1 } } }),
			],
			mode,
		);
		expect(result.findings).toEqual([
			circumstanceFinding("place-value-order-unknown", ORGANIZATION, {
				name: "NORTH: beds",
			}),
		]);
	});
});

describe("planManagedPlaces at a level the app lacks", () => {
	const hqPlaces = [
		place("north", "state", null),
		place("ward-1", "ward", "hq-north"),
		place("ward-1-clinic", "clinic", "hq-ward-1"),
		place("ward-1-clinic-annex", "annex", "hq-ward-1-clinic"),
		place("ward-2", "ward", "hq-north"),
	];

	it("leaves the place out at a birth with all under it, finding nothing", () => {
		const result = plan(hqPlaces, "birth");
		expect(result.findings).toEqual([]);
		expect(result.leftOut).toEqual({});
		expect(result.leftOutHqLocationIds).toEqual([]);
		expect(result.places.map((one) => one.siteCode)).toEqual(["north"]);
	});

	it("counts at a refresh each place left out under the code that did it, and names each by CommCare HQ's id", () => {
		const result = plan(hqPlaces, "refresh");
		expect(result.findings).toEqual([]);
		expect(result.leftOut).toEqual({ ward: 3, annex: 1 });
		expect([...result.leftOutHqLocationIds].sort()).toEqual([
			"hq-ward-1",
			"hq-ward-1-clinic",
			"hq-ward-1-clinic-annex",
			"hq-ward-2",
		]);
		expect(result.places.map((one) => one.siteCode)).toEqual(["north"]);
	});
});

const FINDINGS_APP_ID = "0b4f6a52-7c55-5a35-9d1e-3c2f8a1b4e6d";

/** A level whose code Nova cannot hold: `place-field-unusable`, named "Region". */
const UNHOLDABLE: HqLocationType = {
	id: "1",
	name: "Region",
	code: "not a code!",
	parentCode: null,
	administrative: false,
	sharesCases: true,
	viewDescendants: false,
};

/**
 * `readingProjectDataFindingsFor` over a reading that holds no table, the
 * level Nova cannot hold, no place and the given list limit, for a reading
 * that reads places or reads none.
 */
function placeFindings(readsPlaces: boolean, inconsistent: boolean) {
	return readingProjectDataFindingsFor(
		assembleReadingProjectData({
			origin: { server: "india", domain: "clinic" },
			appId: FINDINGS_APP_ID,
			readingId: "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b",
			tablesReadAt: new Date("2026-11-10T09:00:00.000Z"),
			tables: [],
			hqTags: [],
			project: {
				projectId: "project-1",
				projectRevision: "0" as LookupRevision,
				definitions: [],
				rowsByTable: {},
				apps: {},
				siblings: [],
				mayAdminister: true,
			},
			measured: new Map(),
			places: {
				hqLevels: [UNHOLDABLE],
				hqPlaces: [],
				inconsistent,
			},
			placesUnread: null,
		}),
		{ lookupFields: {}, unreadTables: [], declaredTables: [], readsPlaces },
		null,
		mintingResolver(FINDINGS_APP_ID),
	);
}

describe("readingProjectDataFindingsFor, a level Nova cannot hold", () => {
	it("is a finding where the reading reads places", () => {
		expect(placeFindings(true, false)).toEqual([notHoldable("Region")]);
	});

	it("is no finding where the reading reads no place", () => {
		expect(placeFindings(false, false)).toEqual([]);
	});
});

it("reports an inconsistent source once after the whole hierarchy has been retried", () => {
	expect(placeFindings(true, true)).toEqual([
		circumstanceFinding("place-hierarchy-inconsistent", ORGANIZATION, {}),
	]);
	expect(placeFindings(false, true)).toEqual([]);
});
