import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	LEVEL_CODE_MAX_LENGTH,
	type LocationProperty,
	type OrganizationLevel,
} from "@/lib/domain";
import { organizationLevelSchema } from "@/lib/domain/organization";
import type { StoredLocation } from "@/lib/organization/types";
import {
	MANAGED_PLACES_ALREADY_MATCH,
	MANAGED_PLACES_REFRESHED_SINCE,
	managedOrganizationCommitRefusal,
	managedPlacesKeptInUse,
	managedPlacesKeptLeftOut,
	managedPlacesOutcomeLines,
	managedPlacesRefreshed,
} from "@/lib/publish/managedData";
import {
	flattenRequiredReverseHopDescendants,
	levelOccupancy,
	levelRemovalRefusal,
	managedPlacesContext,
	managedPlacesRefreshControl,
	personaLocationPage,
	placeInformationChangeRefusal,
	placeValueRefusal,
	propertiesForLevel,
	requiredReverseHopDescendants,
	requiredValuesPresent,
	uniqueLevelCode,
	valuesForLevel,
} from "../organizationUi";

const region = testUuid("plan-region"),
	facility = testUuid("plan-facility"),
	queue = testUuid("plan-queue"),
	room = testUuid("plan-room"),
	bay = testUuid("plan-bay");
const phone = testUuid("plan-phone"),
	kind = testUuid("plan-kind");
function level(
	uuid: OrganizationLevel["uuid"],
	code: string,
	parentLevelUuid?: OrganizationLevel["uuid"],
): OrganizationLevel {
	return {
		uuid,
		code,
		name: code,
		...(parentLevelUuid === undefined ? {} : { parentLevelUuid }),
		caseFlow: { workers: "none", ownsCases: true },
		addressBook: { reach: "own-branch" },
	};
}
const properties: readonly LocationProperty[] = [
	{ uuid: phone, slug: "phone", label: "Phone", required: true },
	{
		uuid: kind,
		slug: "kind",
		label: "Facility kind",
		required: true,
		levelUuids: [facility],
		choices: ["Clinic", "Hospital"],
	},
];

describe("organization authoring projections", () => {
	it("derives schema-accepted level codes and searches collisions within the length limit", () => {
		for (const [name, expected] of [
			["North Coast", "north_coast"],
			["12 wards", "l_12_wards"],
			["!!!", "level"],
			[" RÉGION / North ", "r_gion_north"],
		]) {
			const code = uniqueLevelCode(name, []);
			expect(code).toBe(expected);
			expect(
				organizationLevelSchema.safeParse(level(region, code)).success,
			).toBe(true);
		}
		const long = "a".repeat(LEVEL_CODE_MAX_LENGTH);
		const peers = [
			level(region, long),
			level(facility, `${long.slice(0, -2)}_2`),
			level(queue, `${long.slice(0, -2)}_3`),
		];
		expect(uniqueLevelCode(`${long} plus`, peers)).toBe(
			`${long.slice(0, -2)}_4`,
		);
		expect(peers.map((peer) => peer.code)).toEqual([
			long,
			`${long.slice(0, -2)}_2`,
			`${long.slice(0, -2)}_3`,
		]);
	});

	it("returns bounded assignment slices and clamps a removed last page", () => {
		const ids = Array.from(
			{ length: 10_000 },
			(_, index) => `assignment-${index}`,
		);
		expect(personaLocationPage(ids, 199)).toEqual({
			ids: ids.slice(9950),
			page: 199,
			pageCount: 200,
			start: 9950,
		});
		expect(personaLocationPage(ids.slice(0, 50), 199)).toEqual({
			ids: ids.slice(0, 50),
			page: 0,
			pageCount: 1,
			start: 0,
		});
		expect(personaLocationPage(ids, -1)).toEqual({
			ids: ids.slice(0, 50),
			page: 0,
			pageCount: 200,
			start: 0,
		});
		expect(personaLocationPage([], 3)).toEqual({
			ids: [],
			page: 0,
			pageCount: 1,
			start: 0,
		});
	});

	it("projects the ordered applicable catalog and values without mutating either", () => {
		const values = {
			[phone]: "555-0100",
			[kind]: "Clinic",
			[testUuid("removed-property")]: "old value",
		};
		const before = structuredClone({ properties, values });
		expect(propertiesForLevel(properties, region)).toEqual([properties[0]]);
		expect(propertiesForLevel(properties, facility)).toEqual(properties);
		expect(valuesForLevel(properties, region, values)).toEqual({
			[phone]: "555-0100",
		});
		expect(valuesForLevel(properties, facility, values)).toEqual({
			[phone]: "555-0100",
			[kind]: "Clinic",
		});
		expect({ properties, values }).toEqual(before);
	});

	it("requires every applicable mandatory value while leaving accepted-value admission to the writer", () => {
		expect(requiredValuesPresent(properties, region, {})).toBe(false);
		expect(requiredValuesPresent(properties, region, { [phone]: "" })).toBe(
			false,
		);
		expect(
			requiredValuesPresent(properties, region, { [phone]: "555-0100" }),
		).toBe(true);
		expect(
			requiredValuesPresent(properties, facility, { [phone]: "555-0100" }),
		).toBe(false);
		expect(
			requiredValuesPresent(properties, facility, {
				[phone]: "555-0100",
				[kind]: "Clinic",
			}),
		).toBe(true);
		expect(
			requiredValuesPresent(
				properties.map((property) => ({ ...property, required: false })),
				region,
				{},
			),
		).toBe(true);
	});

	it("plans branched and chained reverse-owner destinations in authored order without duplicate requests", () => {
		const formUuid = testUuid("plan-form");
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: formUuid,
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
		doc.organizationLevels = {
			[region]: level(region, "region"),
			[facility]: level(facility, "facility", region),
			[queue]: level(queue, "queue", facility),
			[room]: level(room, "room", queue),
			[bay]: level(bay, "bay", facility),
		};
		doc.organizationLevelOrder = [region, facility, bay, queue, room];
		doc.forms[formUuid].caseOperations = [queue, room, bay, queue].map(
			(uuid, index) => ({
				uuid: testUuid(`plan-owner-${index}`),
				id: `route_${index}`,
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				owner: {
					kind: "term",
					term: {
						kind: "owner-location-at-level",
						levelUuid: uuid,
						ownerCaseType: "patient",
					},
				},
			}),
		);
		const before = structuredClone(doc);
		const branch = requiredReverseHopDescendants(doc, facility);
		expect(branch).toEqual([
			{
				uiPath: "0",
				level: doc.organizationLevels[bay],
				depth: 0,
				descendants: [],
			},
			{
				uiPath: "1",
				level: doc.organizationLevels[queue],
				depth: 0,
				descendants: [
					{
						uiPath: "1.0",
						level: doc.organizationLevels[room],
						depth: 1,
						descendants: [],
					},
				],
			},
		]);
		expect(
			flattenRequiredReverseHopDescendants(branch).map(
				({ level, depth, uiPath }) => ({ level: level.uuid, depth, uiPath }),
			),
		).toEqual([
			{ level: bay, depth: 0, uiPath: "0" },
			{ level: queue, depth: 0, uiPath: "1" },
			{ level: room, depth: 1, uiPath: "1.0" },
		]);
		expect(requiredReverseHopDescendants(doc, region)).toEqual([]);
		expect(requiredReverseHopDescendants(doc, room)).toEqual([]);
		expect(doc).toEqual(before);
	});
});

describe("a refresh of places CommCare HQ manages", () => {
	it("is offered to a connected editor, invites one with no connection to connect, and names who can for a viewer", () => {
		expect(managedPlacesRefreshControl(true, true)).toBe("offered");
		expect(managedPlacesRefreshControl(false, true)).toBe("connect");
		expect(managedPlacesRefreshControl(true, false)).toBe("needs-editor");
		expect(managedPlacesRefreshControl(false, false)).toBe("needs-editor");
	});

	const landed = (
		counts: { added: number; changed: number; archived: number },
		keptInUse: readonly string[] = [],
		keptLeftOut: readonly string[] = [],
	) =>
		({
			ok: true,
			refreshedAt: "2026-11-03T09:00:00.000Z",
			refresh: { ...counts, keptInUse, keptLeftOut, leftOut: { ward: 2 } },
		}) as const;

	it("says the copy already matched where nothing was added, changed or archived", () => {
		expect(
			managedPlacesOutcomeLines(landed({ added: 0, changed: 0, archived: 0 })),
		).toEqual({ tone: "status", lines: [MANAGED_PLACES_ALREADY_MATCH] });
	});

	it("says a newer refresh overtook this one, rather than that the copy matched", () => {
		const overtaken = landed({ added: 0, changed: 0, archived: 0 });
		expect(
			managedPlacesOutcomeLines({
				...overtaken,
				refresh: { ...overtaken.refresh, superseded: true },
			}),
		).toEqual({ tone: "status", lines: [MANAGED_PLACES_REFRESHED_SINCE] });
	});

	it("counts what changed, then names the places Nova kept for a persona, an owner rule or an automation, those gone from CommCare HQ, then those at a level the app lacks", () => {
		expect(
			managedPlacesOutcomeLines(
				landed({ added: 2, changed: 0, archived: 1 }, ["North clinic"]),
			),
		).toEqual({
			tone: "status",
			lines: [
				managedPlacesRefreshed(2, 0, 1),
				managedPlacesKeptInUse(["North clinic"]),
			],
		});
		expect(
			managedPlacesOutcomeLines(
				landed(
					{ added: 0, changed: 0, archived: 0 },
					["North clinic"],
					["Mercy Clinic"],
				),
			),
		).toEqual({
			tone: "status",
			lines: [
				MANAGED_PLACES_ALREADY_MATCH,
				managedPlacesKeptInUse(["North clinic"]),
				managedPlacesKeptLeftOut(["Mercy Clinic"]),
			],
		});
	});

	it("says a refusal's own sentence", () => {
		expect(
			managedPlacesOutcomeLines({
				ok: false,
				message: "CommCare HQ didn't answer just now.",
			}),
		).toEqual({
			tone: "alert",
			lines: ["CommCare HQ didn't answer just now."],
		});
	});
});

describe("an organization edit the places block, where CommCare HQ manages them", () => {
	const managed = {
		domain: "district-health",
		goneIds: new Set<string>([testUuid("place-kept")]),
	};
	function place(
		name: string,
		levelUuid: string,
		options: {
			archived?: boolean;
			id?: string;
			values?: Record<string, string>;
		} = {},
	): StoredLocation {
		return {
			id: asUuid(options.id ?? testUuid(`place-${name}`)),
			levelUuid,
			parentId: null,
			siteCode: name.toLowerCase(),
			name,
			externalId: null,
			latitude: null,
			longitude: null,
			values: options.values ?? {},
			archivedAt: options.archived === true ? new Date(0) : null,
			orderKey: "a0",
		};
	}
	const occupiedPlan = {
		ok: false,
		userMessage:
			'"District" still has places in it. Bring back any archived places, move every place to another level, then remove the level.',
	} as const;

	it("reads the managed copy from the snapshot's origin, and none where Nova manages the places", () => {
		expect(managedPlacesContext(undefined)).toBeUndefined();
		expect(
			managedPlacesContext({
				server: "production",
				domain: "district-health",
				refreshedAt: new Date(0).toISOString(),
				leftOut: {},
				goneIds: [asUuid(testUuid("place-kept"))],
			}),
		).toEqual(managed);
	});

	it("counts an archived place at a level only where Nova manages the places, as the commit does", () => {
		const archived = [place("Clinic", facility, { archived: true })];
		expect(levelOccupancy(archived, undefined)).toEqual(
			new Map([[facility, { kept: false }]]),
		);
		// A place CommCare HQ no longer lists: nothing there to move, so the
		// level is removable once a refresh archived its last place.
		expect(levelOccupancy(archived, managed).size).toBe(0);
		expect(
			levelRemovalRefusal(
				{ ok: true },
				"Facility",
				levelOccupancy(archived, managed).get(facility),
				managed,
			),
		).toBeUndefined();
	});

	it("marks a level kept only while every live place at it is one CommCare HQ no longer has", () => {
		const kept = place("Kept", facility, { id: testUuid("place-kept") });
		expect(levelOccupancy([kept], managed).get(facility)).toEqual({
			kept: true,
		});
		expect(
			levelOccupancy([kept, place("Listed", facility)], managed).get(facility),
		).toEqual({ kept: false });
		expect(levelOccupancy([kept], undefined).get(facility)).toEqual({
			kept: false,
		});
	});

	it("says a level holding managed places is emptied in CommCare HQ, since Nova moves none of them", () => {
		expect(
			levelRemovalRefusal(occupiedPlan, "District", { kept: false }, managed),
		).toBe(
			'"District" still has places in it, and this app\'s places are managed in CommCare HQ (district-health). You can move those places to another level there and refresh, then remove the level.',
		);
		expect(
			levelRemovalRefusal(occupiedPlan, "District", { kept: true }, managed),
		).toBe(
			managedOrganizationCommitRefusal(
				{ kind: "level-in-use", levels: ['"District"'], kept: true },
				"district-health",
			),
		);
	});

	it("keeps today's sentence without a managed copy, and the plan's own for every other refusal", () => {
		expect(
			levelRemovalRefusal(occupiedPlan, "District", { kept: false }, undefined),
		).toBe(occupiedPlan.userMessage);
		const childPlan = {
			ok: false,
			userMessage:
				'Ward sits under "District". Move it somewhere else first, then remove the level.',
		} as const;
		expect(levelRemovalRefusal(childPlan, "District", undefined, managed)).toBe(
			childPlan.userMessage,
		);
		expect(
			levelRemovalRefusal({ ok: true }, "District", { kept: false }, managed),
		).toBeUndefined();
	});

	it("sends a place's blocking value to CommCare HQ only where it manages the places", () => {
		const issue = '"Phone" is required at this level.';
		const ward = place("Ward 4", facility);
		expect(placeValueRefusal(ward, issue, managed)).toBe(
			`“Ward 4” blocks this change. ${issue} This app's places are managed in CommCare HQ (district-health), so you can change that value there and refresh, then try the change again.`,
		);
		expect(placeValueRefusal(ward, issue, undefined)).toBe(
			`“Ward 4” blocks this change. ${issue}`,
		);
		expect(
			placeValueRefusal(
				place("Kept", facility, { id: testUuid("place-kept") }),
				issue,
				managed,
			),
		).toBe(
			managedOrganizationCommitRefusal(
				{ kind: "value", place: "“Kept”", issue, kept: true },
				"district-health",
			),
		);
	});

	it("passes over an archived place's values in a managed copy, and refuses on them where Nova manages the places", () => {
		// Making Phone required at every level, where the facility has no phone.
		const required: readonly LocationProperty[] = [
			{ uuid: phone, slug: "phone", label: "Phone", required: true },
		];
		const archived = [place("Clinic", facility, { archived: true })];
		expect(
			placeInformationChangeRefusal(required, archived, managed),
		).toBeUndefined();
		expect(
			placeInformationChangeRefusal(required, archived, undefined),
		).toMatch(/^“Clinic” blocks this change\. /);
		expect(
			placeInformationChangeRefusal(
				required,
				[place("Clinic", facility)],
				managed,
			),
		).toMatch(/managed in CommCare HQ \(district-health\)/);
		expect(
			placeInformationChangeRefusal(
				required,
				[place("Clinic", facility, { values: { [phone]: "555" } })],
				undefined,
			),
		).toBeUndefined();
	});
});
