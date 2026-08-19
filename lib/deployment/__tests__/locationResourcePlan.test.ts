/**
 * Which places Nova may put on a project space, in what order.
 *
 * Two rules are proved here, and they are separate on purpose. One is the
 * same one every resource kind follows: a shared NAME is never evidence
 * of ownership, and a site code is domain-unique
 * (`locations/util.py::validate_site_code`), so a code Nova did not
 * create belongs to somebody until a person says otherwise. The other is
 * peculiar to places: CommCare HQ refuses shapes Nova admits, and because
 * `v0_6.py::LocationResource.patch_list` is atomic per batch of a
 * hundred, a tree that fails on its fourth level has already left three
 * levels of places on somebody's project space. Everything knowable is
 * therefore decided before the first batch is sent.
 */

import { describe, expect, it } from "vitest";
import {
	ambiguousReverseHopsOnTarget,
	type PlannedPlace,
	planLocationResourcePush,
	plannedPlacesFor,
	type RemoteLevel,
	type RemotePlace,
} from "../locationResourcePlan";
import type { DeploymentResource } from "../types";

const STATE = "018f0000-0000-7000-8000-0000000000a1";
const CITY = "018f0000-0000-7000-8000-0000000000a2";
const COLORADO = "018f0000-0000-7000-8000-000000000001";
const DENVER = "018f0000-0000-7000-8000-000000000002";
const BOULDER = "018f0000-0000-7000-8000-000000000003";

const LEVELS: readonly RemoteLevel[] = [
	{ code: "state", parentCode: null },
	{ code: "city", parentCode: "state" },
];

function place(over: Partial<PlannedPlace> = {}): PlannedPlace {
	return {
		locationUuid: COLORADO,
		siteCode: "colorado",
		name: "Colorado",
		levelCode: "state",
		parentLocationUuid: null,
		latitude: null,
		longitude: null,
		values: {},
		...over,
	};
}

const CHILD = place({
	locationUuid: DENVER,
	siteCode: "denver",
	name: "Denver",
	levelCode: "city",
	parentLocationUuid: COLORADO,
});

function remote(over: Partial<RemotePlace> = {}): RemotePlace {
	return {
		locationId: "hq-colorado",
		name: "Colorado",
		siteCode: "colorado",
		parentLocationId: null,
		values: {},
		...over,
	};
}

function mapping(over: Partial<DeploymentResource> = {}): DeploymentResource {
	return {
		deploymentId: "dep-1",
		kind: "location",
		novaResourceId: COLORADO,
		remoteId: "hq-colorado",
		ownership: "nova-created",
		pushedIdentity: "colorado",
		adoptedAt: null,
		adoptedBy: null,
		pushedRevision: null,
		pushedAt: "2026-08-19T00:00:00.000Z",
		remoteRevision: null,
		remoteObservedAt: null,
		supersededAt: null,
		...over,
	};
}

function plan(over: Partial<Parameters<typeof planLocationResourcePush>[0]>) {
	return planLocationResourcePush({
		places: [],
		mappings: [],
		hqLevels: LEVELS,
		hqPlaces: [],
		appModelsPlaceInformation: false,
		adoptLocationUuids: [],
		...over,
	});
}

describe("a project space Nova has never pushed to", () => {
	it("creates every live place, parents before children", () => {
		const result = plan({ places: [CHILD, place()] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(
			result.batches.map((batch) => batch.map((push) => push.siteCode)),
		).toEqual([["colorado"], ["denver"]]);
		expect(result.batches[0]?.[0]).toMatchObject({
			remoteId: null,
			ownership: "nova-created",
			parentLocationUuid: null,
		});
		expect(result.batches[1]?.[0]?.parentLocationUuid).toBe(COLORADO);
	});

	it("refuses a site code that is already taken there", () => {
		const result = plan({
			places: [place()],
			hqPlaces: [remote({ locationId: "somebody-elses", name: "CO" })],
		});
		expect(result).toEqual({
			ok: false,
			reason: "conflict",
			conflicts: [
				{
					locationUuid: COLORADO,
					siteCode: "colorado",
					name: "Colorado",
					remoteName: "CO",
					remoteId: "somebody-elses",
				},
			],
		});
	});

	it("takes over exactly the places a person named", () => {
		const result = plan({
			places: [place()],
			hqPlaces: [remote({ locationId: "somebody-elses" })],
			adoptLocationUuids: [COLORADO],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.batches[0]?.[0]).toMatchObject({
			remoteId: "somebody-elses",
			ownership: "adopted",
		});
	});
});

describe("a project space Nova already owns places on", () => {
	it("updates in place under the claim already recorded", () => {
		const result = plan({
			places: [place()],
			mappings: [mapping()],
			hqPlaces: [remote()],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.batches[0]?.[0]).toMatchObject({
			remoteId: "hq-colorado",
			ownership: "nova-created",
		});
	});

	it("keeps an adoption's claim across a republish", () => {
		const result = plan({
			places: [place()],
			mappings: [mapping({ ownership: "adopted" })],
			hqPlaces: [remote()],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.batches[0]?.[0]?.ownership).toBe("adopted");
	});

	it("recreates a place that is gone from the target", () => {
		const result = plan({ places: [place()], mappings: [mapping()] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.batches[0]?.[0]).toMatchObject({
			remoteId: null,
			ownership: "nova-created",
		});
	});

	it("refuses a mapped code now held by a different place", () => {
		// The ledger cannot tell two places apart by name, which is the whole
		// reason this planner exists: deleted over there and made again by
		// somebody else is exactly a stranger's place.
		const result = plan({
			places: [place()],
			mappings: [mapping()],
			hqPlaces: [remote({ locationId: "a-different-one" })],
		});
		expect(result).toMatchObject({ ok: false, reason: "conflict" });
	});
});

describe("shapes CommCare HQ will not hold", () => {
	it("names a place whose level the target does not have", () => {
		const result = plan({
			places: [place({ levelCode: "province" })],
		});
		expect(result).toEqual({
			ok: false,
			reason: "unpushable",
			problems: [
				{
					kind: "level-missing",
					locationUuid: COLORADO,
					name: "Colorado",
					siteCode: "colorado",
					levelCode: "province",
				},
			],
		});
	});

	it("names a place that skips a rung", () => {
		// `util.py::get_location_type` admits only what
		// `forms.py::LocationForm.get_allowed_types` returns, filtered
		// `parent_type=parent.location_type`. Nova's own rule is strict
		// ancestry, so a skipped rung is authorable and unpushable.
		const result = plan({
			places: [
				place(),
				place({
					locationUuid: DENVER,
					siteCode: "denver",
					name: "Denver",
					levelCode: "block",
					parentLocationUuid: COLORADO,
				}),
			],
			hqLevels: [...LEVELS, { code: "block", parentCode: "city" }],
		});
		expect(result).toEqual({
			ok: false,
			reason: "unpushable",
			problems: [
				{
					kind: "level-not-under-parent",
					locationUuid: DENVER,
					name: "Denver",
					siteCode: "denver",
					levelCode: "block",
					parentName: "Colorado",
					parentLevelCode: "state",
				},
			],
		});
	});

	it("names BOTH halves of a duplicate sibling name", () => {
		// `util.py::has_siblings_with_name` matches on (domain, name,
		// parent). Naming one of them would leave somebody hunting the other.
		const result = plan({
			places: [
				place(),
				CHILD,
				place({
					locationUuid: BOULDER,
					siteCode: "boulder",
					name: "Denver",
					levelCode: "city",
					parentLocationUuid: COLORADO,
				}),
			],
		});
		expect(result.ok).toBe(false);
		if (result.ok || result.reason !== "unpushable") return;
		expect(result.problems.map((problem) => problem.siteCode).sort()).toEqual([
			"boulder",
			"denver",
		]);
		expect(result.problems[0]).toMatchObject({
			kind: "duplicate-sibling-name",
			parentName: "Colorado",
		});
	});

	it("names a place the target will not move back to the top", () => {
		// `_update` reads `parent_location_id` only to look one UP, so no
		// value clears a parent and retrying can never help.
		const result = plan({
			places: [place()],
			mappings: [mapping()],
			hqPlaces: [
				remote({ parentLocationId: "hq-country" }),
				remote({
					locationId: "hq-country",
					name: "United States",
					siteCode: "usa",
				}),
			],
		});
		expect(result).toEqual({
			ok: false,
			reason: "unpushable",
			problems: [
				{
					kind: "cannot-become-root",
					locationUuid: COLORADO,
					name: "Colorado",
					siteCode: "colorado",
					remoteParentName: "United States",
				},
			],
		});
	});

	it("reports every unpushable place before naming any ownership decision", () => {
		// A tree CommCare HQ cannot hold has to change whoever owns the
		// places over there, so asking about ownership first would ask
		// somebody to decide something that does not matter yet.
		const result = plan({
			places: [place({ levelCode: "province" })],
			hqPlaces: [remote({ locationId: "somebody-elses" })],
		});
		expect(result).toMatchObject({ ok: false, reason: "unpushable" });
	});
});

describe("batching", () => {
	it("keeps every batch within CommCare HQ's atomic limit", () => {
		const places = Array.from({ length: 250 }, (_, index) =>
			place({
				locationUuid: `018f0000-0000-7000-8000-${String(index).padStart(12, "0")}`,
				siteCode: `place_${index}`,
				name: `Place ${index}`,
			}),
		);
		const result = plan({ places });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
	});
});

describe("plannedPlacesFor", () => {
	const doc = {
		organizationLevels: {
			[STATE]: { uuid: STATE, code: "state", name: "State" },
			[CITY]: {
				uuid: CITY,
				code: "city",
				name: "City",
				parentLevelUuid: STATE,
			},
		},
		locationProperties: {
			"p-1": { uuid: "p-1", slug: "population", label: "Population" },
			"p-2": {
				uuid: "p-2",
				slug: "ward_count",
				label: "Wards",
				levelUuids: [CITY],
			},
		},
		locationPropertyOrder: ["p-1", "p-2"],
	} as unknown as Parameters<typeof plannedPlacesFor>[0];

	function stored(over: Record<string, unknown> = {}) {
		return {
			id: COLORADO,
			levelUuid: STATE,
			parentId: null,
			siteCode: "colorado",
			name: "Colorado",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
			archivedAt: null,
			orderKey: "a0",
			...over,
		} as unknown as Parameters<typeof plannedPlacesFor>[1][number];
	}

	it("resolves the level's current code and each property's current slug", () => {
		const [projected] = plannedPlacesFor(doc, [
			stored({ values: { "p-1": "5,758,736" } }),
		]);
		expect(projected).toMatchObject({
			levelCode: "state",
			// `ward_count` applies only to cities, so a state has nothing to
			// say about it; `population` applies everywhere.
			values: { population: "5,758,736" },
		});
		expect(projected && "ward_count" in projected.values).toBe(false);
	});

	it("sends an empty value for an applicable property with none set", () => {
		// `_update` replaces the whole bag, so an omitted key would leave a
		// stale value on the target that Nova could never clear.
		const [projected] = plannedPlacesFor(doc, [stored()]);
		expect(projected?.values).toEqual({ population: "" });
	});

	it("leaves archived places out entirely", () => {
		expect(
			plannedPlacesFor(doc, [stored({ archivedAt: new Date() })]),
		).toHaveLength(0);
	});
});

/**
 * A reverse owner hop the TARGET's tree makes ambiguous.
 *
 * Nova proves this invariant over its own places at commit time, but
 * CommCare HQ builds the fixture from ITS rows, which can hold places
 * Nova never created. The emitted XPath selects `@id` from every match,
 * so two of them make owner choice depend on fixture order — and no
 * runtime error says so. Publishing is the one moment Nova can look.
 */
describe("ambiguousReverseHopsOnTarget", () => {
	const HOP = [{ destinationCode: "clinic", sourceCode: "district" }] as const;
	const place = (
		locationId: string,
		locationTypeCode: string,
		parentLocationId: string | null,
		name = locationId,
	) => ({ locationId, name, locationTypeCode, parentLocationId });

	it("says nothing when each owner holds one destination", () => {
		expect(
			ambiguousReverseHopsOnTarget(HOP, [
				place("d1", "district", null, "North"),
				place("c1", "clinic", "d1", "North Clinic"),
				place("d2", "district", null, "South"),
				place("c2", "clinic", "d2", "South Clinic"),
			]),
		).toEqual([]);
	});

	it("names the owner and every place it would choose between", () => {
		expect(
			ambiguousReverseHopsOnTarget(HOP, [
				place("d1", "district", null, "North"),
				place("c1", "clinic", "d1", "Riverside"),
				place("c2", "clinic", "d1", "Hilltop"),
			]),
		).toEqual([
			{
				destinationCode: "clinic",
				sourceCode: "district",
				ownerName: "North",
				destinationNames: ["Hilltop", "Riverside"],
			},
		]);
	});

	it("finds the owner through a level the hop skips", () => {
		/* The emitted attribute is `@district_id` on the clinic itself, and
		 * `FlatLocationSerializer` writes one per ANCESTOR level, so a ward
		 * in between does not break the match. */
		expect(
			ambiguousReverseHopsOnTarget(HOP, [
				place("d1", "district", null, "North"),
				place("w1", "ward", "d1"),
				place("c1", "clinic", "w1", "Riverside"),
				place("c2", "clinic", "w1", "Hilltop"),
			]),
		).toHaveLength(1);
	});

	it("ignores a destination with no owning ancestor over there", () => {
		// Nothing matches it, so the rule selects nothing rather than
		// choosing wrongly — a different problem, and not this one.
		expect(
			ambiguousReverseHopsOnTarget(HOP, [
				place("c1", "clinic", null),
				place("c2", "clinic", null),
			]),
		).toEqual([]);
	});

	it("asks nothing of a project space when the app authors no hop", () => {
		expect(
			ambiguousReverseHopsOnTarget([], [place("c1", "clinic", null)]),
		).toEqual([]);
	});
});
