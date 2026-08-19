import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	type BlueprintDoc,
	type LevelAddressBook,
	type OrganizationLevel,
	type Persona,
	personasOf,
} from "@/lib/domain";
import { personaFootprint } from "../footprint";
import { memberOwnerIds, personaOwnerIds } from "../ownerSets";
import {
	assignmentFootprintIncludes,
	type OwnerVerdictLocation,
} from "../ownerTargetVerdicts";

// A three-rung org: Region > District > Facility, with a Store level hanging
// off District that owns cases but holds nobody — HQ's "bucket" shape.
const REGION = testUuid("os-level-region");
const DISTRICT = testUuid("os-level-district");
const FACILITY = testUuid("os-level-facility");
const STORE = testUuid("os-level-store");

const REGION_PLACE = testUuid("os-place-region");
const DISTRICT_A = testUuid("os-place-district-a");
const DISTRICT_B = testUuid("os-place-district-b");
const FACILITY_A1 = testUuid("os-place-facility-a1");
const FACILITY_A2 = testUuid("os-place-facility-a2");
const FACILITY_B1 = testUuid("os-place-facility-b1");
const STORE_A = testUuid("os-place-store-a");
const PERSONA = testUuid("os-persona");

function level(
	uuid: string,
	name: string,
	parentLevelUuid: string | undefined,
	caseFlow: OrganizationLevel["caseFlow"],
	addressBook: LevelAddressBook = { reach: "own-branch" },
): OrganizationLevel {
	return {
		uuid: asUuid(uuid),
		code: name.toLowerCase(),
		name,
		...(parentLevelUuid === undefined
			? {}
			: { parentLevelUuid: asUuid(parentLevelUuid) }),
		caseFlow,
		addressBook,
	};
}

function place(
	id: string,
	levelUuid: string,
	parentId: string | null,
	name: string,
	archived = false,
): OwnerVerdictLocation {
	return {
		id,
		name,
		levelUuid,
		parentId,
		archivedAt: archived ? new Date("2026-01-01T00:00:00Z") : null,
	};
}

const ROWS: readonly OwnerVerdictLocation[] = [
	place(REGION_PLACE, REGION, null, "North"),
	place(DISTRICT_A, DISTRICT, REGION_PLACE, "District A"),
	place(DISTRICT_B, DISTRICT, REGION_PLACE, "District B"),
	place(FACILITY_A1, FACILITY, DISTRICT_A, "Clinic A1"),
	place(FACILITY_A2, FACILITY, DISTRICT_A, "Clinic A2"),
	place(FACILITY_B1, FACILITY, DISTRICT_B, "Clinic B1"),
	place(STORE_A, STORE, DISTRICT_A, "Store A"),
];

interface DocOptions {
	readonly assignedLevel?: string;
	readonly assignedPlaces?: readonly string[];
	readonly caseFlow?: Partial<Record<string, OrganizationLevel["caseFlow"]>>;
	readonly addressBook?: Partial<Record<string, LevelAddressBook>>;
}

function orgDoc(options: DocOptions = {}): BlueprintDoc {
	const doc = buildDoc() as BlueprintDoc;
	const flow = (uuid: string, fallback: OrganizationLevel["caseFlow"]) =>
		options.caseFlow?.[uuid] ?? fallback;
	const book = (uuid: string): LevelAddressBook =>
		options.addressBook?.[uuid] ?? { reach: "own-branch" };

	doc.organizationLevels = {
		[REGION]: level(
			REGION,
			"Region",
			undefined,
			flow(REGION, { workers: "none", ownsCases: false }),
			book(REGION),
		),
		[DISTRICT]: level(
			DISTRICT,
			"District",
			REGION,
			flow(DISTRICT, {
				workers: "assigned",
				ownsCases: true,
				descendantCases: { kind: "none" },
			}),
			book(DISTRICT),
		),
		[FACILITY]: level(
			FACILITY,
			"Facility",
			DISTRICT,
			flow(FACILITY, {
				workers: "assigned",
				ownsCases: true,
				descendantCases: { kind: "none" },
			}),
			book(FACILITY),
		),
		[STORE]: level(
			STORE,
			"Store",
			DISTRICT,
			flow(STORE, { workers: "none", ownsCases: true }),
			book(STORE),
		),
	};
	doc.organizationLevelOrder = [REGION, DISTRICT, FACILITY, STORE].map(asUuid);

	const assigned = options.assignedPlaces ?? [FACILITY_A1];
	doc.personas = {
		[PERSONA]: {
			uuid: asUuid(PERSONA),
			name: "Asha",
			...(assigned.length === 0
				? {}
				: {
						locations: {
							primaryUuid: asUuid(assigned[0] as string),
							...(assigned.length > 1
								? {
										additionalUuids: assigned.slice(1).map((id) => asUuid(id)),
									}
								: {}),
						},
					}),
		},
	};
	doc.personaOrder = [asUuid(PERSONA)];
	return doc;
}

function persona(doc: BlueprintDoc): Persona {
	const found = personasOf(doc)[PERSONA];
	if (found === undefined) throw new Error("persona missing from fixture");
	return found;
}

describe("personaOwnerIds", () => {
	it("is the worker's own id plus every case-owning place they reach", () => {
		const doc = orgDoc();
		expect(personaOwnerIds(doc, persona(doc), ROWS)).toEqual([
			PERSONA,
			FACILITY_A1,
		]);
	});

	it("leads with the worker's own id even when no place is reached", () => {
		// The assigned level owns nothing, so it contributes no sharing group —
		// HQ's `shares_cases` filter on the direct arm.
		const doc = orgDoc({
			caseFlow: {
				[FACILITY]: {
					workers: "assigned",
					ownsCases: false,
					descendantCases: { kind: "none" },
				},
			},
		});
		expect(personaOwnerIds(doc, persona(doc), ROWS)).toEqual([PERSONA]);
	});

	it("adds every additional assignment, not just the primary", () => {
		const doc = orgDoc({ assignedPlaces: [FACILITY_A1, FACILITY_B1] });
		expect(personaOwnerIds(doc, persona(doc), ROWS)).toEqual([
			PERSONA,
			...[FACILITY_A1, FACILITY_B1].sort(),
		]);
	});

	it("pulls in descendant-owned places when the level views descendants", () => {
		const doc = orgDoc({
			assignedPlaces: [DISTRICT_A],
			caseFlow: {
				[DISTRICT]: {
					workers: "assigned",
					ownsCases: true,
					descendantCases: { kind: "all" },
				},
			},
		});
		// District A itself, both of its facilities, and its store bucket —
		// every descendant whose level owns cases. Not District B.
		expect(personaOwnerIds(doc, persona(doc), ROWS)).toEqual([
			PERSONA,
			...[DISTRICT_A, FACILITY_A1, FACILITY_A2, STORE_A].sort(),
		]);
	});

	it("stops at the level a bounded descendant scope names", () => {
		const doc = orgDoc({
			assignedPlaces: [REGION_PLACE],
			caseFlow: {
				[REGION]: {
					workers: "assigned",
					ownsCases: true,
					descendantCases: { kind: "down-to", levelUuid: asUuid(DISTRICT) },
				},
			},
		});
		// Region owns cases and both districts are within the bound; the
		// facilities and the store sit below it.
		expect(personaOwnerIds(doc, persona(doc), ROWS)).toEqual([
			PERSONA,
			...[REGION_PLACE, DISTRICT_A, DISTRICT_B].sort(),
		]);
	});

	it("never contributes an archived place", () => {
		const archivedRows = ROWS.map((row) =>
			row.id === FACILITY_A2
				? { ...row, archivedAt: new Date("2026-01-01T00:00:00Z") }
				: row,
		);
		const doc = orgDoc({
			assignedPlaces: [DISTRICT_A],
			caseFlow: {
				[DISTRICT]: {
					workers: "assigned",
					ownsCases: true,
					descendantCases: { kind: "all" },
				},
			},
		});
		const owners = personaOwnerIds(doc, persona(doc), archivedRows);
		expect(owners).not.toContain(FACILITY_A2);
		expect(owners).toContain(FACILITY_A1);
	});

	it("is the worker's own id alone when the persona is unassigned", () => {
		const doc = orgDoc({ assignedPlaces: [] });
		expect(personaOwnerIds(doc, persona(doc), ROWS)).toEqual([PERSONA]);
	});
});

describe("memberOwnerIds", () => {
	it("is exactly the member's own id", () => {
		// A member is a worker assigned nowhere, so there is no sharing group
		// to add — the same answer the unassigned persona above gets.
		expect(memberOwnerIds("member-1")).toEqual(["member-1"]);
	});
});

describe("personaFootprint", () => {
	it("enumerates exactly what assignmentFootprintIncludes admits", () => {
		// The enumerator and the commit gate's membership test must not drift:
		// one decides what a fixture carries, the other decides what an owner
		// rule may name, and a destination outside the fixture is a silent
		// orphan on the device.
		const books: LevelAddressBook[] = [
			{ reach: "own-branch" },
			{ reach: "own-branch", downToLevelUuid: asUuid(FACILITY) },
			{
				reach: "own-branch",
				alsoIncludeTopDownToLevelUuid: asUuid(REGION),
			},
			{ reach: "own-branch-limited", levelUuids: [asUuid(FACILITY)] },
			{ reach: "shared-branch", fromLevelUuid: asUuid(DISTRICT) },
			{
				reach: "shared-branch",
				fromLevelUuid: asUuid(REGION),
				downToLevelUuid: asUuid(DISTRICT),
			},
			{ reach: "whole-organization" },
			{ reach: "whole-organization", downToLevelUuid: asUuid(DISTRICT) },
		];

		for (const addressBook of books) {
			for (const assignedPlaces of [
				[FACILITY_A1],
				[DISTRICT_A],
				[FACILITY_A1, FACILITY_B1],
			]) {
				const doc = orgDoc({
					assignedPlaces,
					addressBook: { [FACILITY]: addressBook, [DISTRICT]: addressBook },
				});
				const byId = new Map(ROWS.map((row) => [row.id, row]));
				const assigned = assignedPlaces.map((id) => {
					const row = byId.get(id);
					if (row === undefined) throw new Error("fixture place missing");
					return row;
				});
				const expected = ROWS.filter((row) =>
					assigned.some((from) =>
						assignmentFootprintIncludes(row, from, byId, doc),
					),
				).map((row) => row.id);

				expect(
					personaFootprint(doc, persona(doc), ROWS).map((row) => row.id),
				).toEqual(expected);
			}
		}
	});

	it("is empty for an unassigned persona", () => {
		// HQ ships an empty fixture to a user with no locations
		// (`test_location_fixtures.py::LocationFixturesTest.test_no_user_locations_returns_empty`),
		// not the whole tree.
		const doc = orgDoc({ assignedPlaces: [] });
		expect(personaFootprint(doc, persona(doc), ROWS)).toEqual([]);
	});

	it("never carries an archived place", () => {
		const archivedRows = ROWS.map((row) =>
			row.id === FACILITY_A2
				? { ...row, archivedAt: new Date("2026-01-01T00:00:00Z") }
				: row,
		);
		const doc = orgDoc({ assignedPlaces: [DISTRICT_A] });
		expect(
			personaFootprint(doc, persona(doc), archivedRows).map((row) => row.id),
		).not.toContain(FACILITY_A2);
	});
});
