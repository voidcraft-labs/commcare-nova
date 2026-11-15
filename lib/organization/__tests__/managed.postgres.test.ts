// Live-Postgres contract for places CommCare HQ manages: the copy's two
// writers, the refusal every author write meets, and the commit refusals that
// name CommCare HQ where moving a place in Nova is no longer the way forward.
// Each is a property of real rows under the real lock set, so each is proved
// through the production entry points against a real database.

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	commitGuardedBatch,
	loadApp,
	loadAppInTransaction,
} from "@/lib/db/apps";
import { withAppTx } from "@/lib/db/pg";
import { addCaseOperationMutations } from "@/lib/doc/caseOperationMutations";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	type OrganizationLevel,
	type Persona,
	type Uuid,
} from "@/lib/domain";
import { ownerLocationAtLevel, term } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import {
	managedOrganizationCommitRefusal,
	organizationManagedRefusal,
} from "@/lib/publish/managedData";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { applyOrganizationCommitIntegrity } from "../commitIntegrity";
import { OrganizationError } from "../errors";
import {
	type ManagedPlacePlan,
	type ManagedPlaceWrite,
	refreshManagedPlacesInTransaction,
	writeManagedPlacesInTransaction,
} from "../managed";
import {
	createLocation,
	describeArchiveImpact,
	moveLocation,
	readOrganization,
	setLocationArchived,
	updateLocation,
} from "../service";
import type { OrganizationScope, StoredLocation } from "../types";

const h = setupAppStateTestDb("organization_managed_", {
	authSchema: "migrated",
	poolMax: 2,
});

const PROJECT = "managed-places-project";
const APP_ID = "managed-places-app";
const ACTOR = "managed-places-actor";
const DOMAIN = "district-health";
const ORIGIN = { server: "production", domain: DOMAIN } as const;

const REGION = asUuid("11111111-1111-4111-8111-111111111111");
const DISTRICT = asUuid("22222222-2222-4222-8222-222222222222");
const FACILITY = asUuid("33333333-3333-4333-8333-333333333333");
const PERSONA_ASHA = asUuid("44444444-4444-4444-8444-444444444444");
const PROP_BEDS = asUuid("99999999-9999-4999-8999-999999999999");

function level(
	uuid: Uuid,
	code: string,
	name: string,
	parentLevelUuid?: Uuid,
): OrganizationLevel {
	return {
		uuid,
		code,
		name,
		...(parentLevelUuid !== undefined && { parentLevelUuid }),
		caseFlow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "none" },
		},
		addressBook: { reach: "own-branch" },
	};
}

/** Three levels, one optional place property, one persona and a followup
 * form an owner rule can be added to. */
function managedDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Managed places",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
	});
	const personas: Record<string, Persona> = {
		[PERSONA_ASHA]: { uuid: PERSONA_ASHA, name: "Asha" },
	};
	return {
		...doc,
		appId: APP_ID,
		organizationLevels: {
			[REGION]: level(REGION, "region", "Region"),
			[DISTRICT]: level(DISTRICT, "district", "District", REGION),
			[FACILITY]: level(FACILITY, "facility", "Facility", DISTRICT),
		},
		organizationLevelOrder: [REGION, DISTRICT, FACILITY],
		locationProperties: {
			[PROP_BEDS]: { uuid: PROP_BEDS, slug: "beds", label: "Beds" },
		},
		locationPropertyOrder: [PROP_BEDS],
		personas,
		personaOrder: [PERSONA_ASHA],
	};
}

function scope(): OrganizationScope {
	return {
		appId: APP_ID,
		projectId: PROJECT,
		role: "owner",
		actorUserId: ACTOR,
	};
}

async function seedApp(): Promise<void> {
	await h.seedAppWithBlueprint(managedDoc(), {
		id: APP_ID,
		owner: ACTOR,
		projectId: PROJECT,
	});
}

function place(
	siteCode: string,
	name: string,
	levelUuid: Uuid,
	parentSiteCode: string | null,
	extra: Partial<ManagedPlaceWrite> = {},
): ManagedPlaceWrite {
	return {
		hqLocationId: `hq-${siteCode}`,
		siteCode,
		name,
		levelUuid,
		parentSiteCode,
		latitude: null,
		longitude: null,
		values: {},
		...extra,
	};
}

/** A plan as the planner hands it: parent before child, digested in site
 * code order. */
function plan(
	places: readonly ManagedPlaceWrite[],
	leftOut: Readonly<Record<string, number>> = {},
): ManagedPlacePlan {
	return {
		places,
		digest: canonicalJsonDigest(
			[...places].sort((left, right) =>
				left.siteCode < right.siteCode ? -1 : 1,
			),
		),
		leftOut,
		findings: [],
	};
}

const BIRTH_PLACES = [
	place("north", "North", REGION, null),
	place("riverside", "Riverside", DISTRICT, "north", {
		latitude: "12.5",
		longitude: "-3.25",
	}),
	place("mercy", "Mercy Clinic", FACILITY, "riverside", {
		values: { [PROP_BEDS]: "40" },
	}),
];

async function bringIn(places = BIRTH_PLACES): Promise<string> {
	return withAppTx(async (tx) => {
		const revision = await writeManagedPlacesInTransaction(tx, {
			appId: APP_ID,
			actorUserId: ACTOR,
			origin: ORIGIN,
			plan: plan(places),
			at: new Date("2026-11-01T10:00:00.000Z"),
		});
		const loaded = await loadAppInTransaction(tx, APP_ID);
		if (loaded === null) throw new Error("managed test app missing");
		const doc = hydratePersistedBlueprint(loaded.blueprint);
		await applyOrganizationCommitIntegrity(tx, {
			appId: APP_ID,
			previousDoc: doc,
			candidateDoc: doc,
		});
		return revision;
	});
}

async function refresh(
	places: readonly ManagedPlaceWrite[],
	leftOut: Readonly<Record<string, number>> = {},
	at = new Date("2026-11-02T10:00:00.000Z"),
) {
	return withAppTx((tx) =>
		refreshManagedPlacesInTransaction(tx, scope(), {
			plan: plan(places, leftOut),
			at,
		}),
	);
}

async function commit(batchId: string, mutations: Mutation[]): Promise<void> {
	await commitGuardedBatch({
		appId: APP_ID,
		batchId,
		mutations: admitMutationBatch(mutations),
		actorUserId: ACTOR,
		kind: "autosave",
		expectedProjectId: PROJECT,
	});
}

async function commitReverseOwnerRule(levelUuid: Uuid): Promise<void> {
	const loaded = await loadApp(APP_ID);
	if (loaded === null) throw new Error("managed test app missing");
	const moduleUuid = loaded.blueprint.moduleOrder[0];
	const formUuid = loaded.blueprint.formOrder[moduleUuid]?.[0];
	if (formUuid === undefined) throw new Error("managed test form missing");
	await commit(
		"reverse-owner",
		addCaseOperationMutations(
			hydratePersistedBlueprint(loaded.blueprint),
			formUuid,
			{
				uuid: asUuid("66666666-6666-4666-8666-666666666662"),
				id: "reverse_owner",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				owner: term(ownerLocationAtLevel(levelUuid, "patient")),
			},
		),
	);
}

function bySiteCode(
	locations: readonly StoredLocation[],
): Map<string, StoredLocation> {
	return new Map(locations.map((location) => [location.siteCode, location]));
}

async function hqLocationIds(): Promise<Record<string, string | null>> {
	const rows = await h
		.db()
		.selectFrom("app_locations")
		.select(["site_code", "hq_location_id"])
		.where("app_id", "=", APP_ID)
		.execute();
	return Object.fromEntries(
		rows.map((row) => [row.site_code, row.hq_location_id]),
	);
}

async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("The call was expected to be refused.");
}

describe("a copy of CommCare HQ's places, written at a birth", () => {
	it("writes the tree with parents resolved and CommCare HQ's ids, and the integrity step that follows passes an owner rule with one place at its level", async () => {
		await seedApp();
		await commitReverseOwnerRule(FACILITY);

		const revision = await bringIn();

		expect(revision).toBe("1");
		const snapshot = await readOrganization(scope());
		expect(snapshot.revision).toBe("1");
		expect(snapshot.hq).toEqual({
			server: "production",
			domain: DOMAIN,
			refreshedAt: "2026-11-01T10:00:00.000Z",
			leftOut: {},
		});
		const places = bySiteCode(snapshot.locations);
		const north = places.get("north");
		const riverside = places.get("riverside");
		const mercy = places.get("mercy");
		expect(north?.parentId).toBeNull();
		expect(north?.levelUuid).toBe(REGION);
		expect(riverside?.parentId).toBe(north?.id);
		expect(riverside?.latitude).toBe("12.5");
		expect(riverside?.longitude).toBe("-3.25");
		expect(mercy?.parentId).toBe(riverside?.id);
		expect(mercy?.values).toEqual({ [PROP_BEDS]: "40" });
		expect(await hqLocationIds()).toEqual({
			north: "hq-north",
			riverside: "hq-riverside",
			mercy: "hq-mercy",
		});
		const state = await h
			.db()
			.selectFrom("app_organization_state")
			.select(["location_count", "hq_brought_in_by", "hq_refreshed_by"])
			.where("app_id", "=", APP_ID)
			.executeTakeFirstOrThrow();
		expect(state).toEqual({
			location_count: 3,
			hq_brought_in_by: ACTOR,
			hq_refreshed_by: ACTOR,
		});
	});
});

describe("an author write to managed places", () => {
	it("is refused for each of the four place writers with nothing changed, while the locked read before an archive still answers", async () => {
		await seedApp();
		await bringIn();
		const before = await readOrganization(scope());
		const places = bySiteCode(before.locations);
		const north = places.get("north")?.id ?? "";
		const riverside = places.get("riverside")?.id ?? "";
		const mercy = places.get("mercy")?.id ?? "";

		const attempts: Array<[string, () => Promise<unknown>]> = [
			[
				"createLocation",
				() =>
					createLocation(scope(), {
						levelUuid: FACILITY,
						parentId: asUuid(riverside),
						name: "Lakeside",
						externalId: null,
						latitude: null,
						longitude: null,
						values: {},
					}),
			],
			[
				"updateLocation",
				() => updateLocation(scope(), mercy, { name: "Mercy" }),
			],
			[
				"moveLocation",
				() => moveLocation(scope(), riverside, { parentId: north }),
			],
			["setLocationArchived", () => setLocationArchived(scope(), mercy, true)],
		];
		for (const [writer, attempt] of attempts) {
			const error = await refusalOf(attempt());
			expect(error, writer).toBeInstanceOf(OrganizationError);
			expect((error as OrganizationError).code, writer).toBe("managed-in-hq");
			expect((error as OrganizationError).message, writer).toBe(
				organizationManagedRefusal(DOMAIN),
			);
		}

		const after = await readOrganization(scope());
		expect(after.revision).toBe(before.revision);
		expect(after.locations).toEqual(before.locations);

		const impact = await describeArchiveImpact(scope(), riverside);
		expect(impact.revision).toBe(before.revision);
		expect(impact.affectedLocationCount).toBe(2);
		expect(impact.unassignedPersonaCount).toBe(0);
		expect(impact.ownedCases).toBe(0);
	});
});

describe("a level or property edit the places block", () => {
	const removeFacility: Mutation[] = [
		{ kind: "removeOrganizationLevel", uuid: FACILITY },
	];
	const districtAsRoot: Mutation[] = [
		{
			kind: "updateOrganizationLevel",
			uuid: DISTRICT,
			patch: { parentLevelUuid: null },
		},
	];
	// Required at the Region level alone, so North is the one place that
	// lacks a value the change asks for.
	const bedsRequired: Mutation[] = [
		{
			kind: "updateLocationProperty",
			uuid: PROP_BEDS,
			patch: { required: true, levelUuids: [REGION] },
		},
	];

	it("names CommCare HQ and a refresh where the places are managed there", async () => {
		await seedApp();
		await bringIn(
			BIRTH_PLACES.map((birthPlace) => ({ ...birthPlace, values: {} })),
		);

		await expect(commit("remove-facility", removeFacility)).rejects.toThrow(
			managedOrganizationCommitRefusal(
				{ kind: "level-in-use", levels: ['"Facility"'] },
				DOMAIN,
			),
		);
		await expect(commit("district-as-root", districtAsRoot)).rejects.toThrow(
			managedOrganizationCommitRefusal(
				{ kind: "placement", place: '"Riverside"' },
				DOMAIN,
			),
		);
		await expect(commit("beds-required", bedsRequired)).rejects.toThrow(
			managedOrganizationCommitRefusal(
				{
					kind: "value",
					place: '"North"',
					issue: '"Beds" is required for places at this level.',
				},
				DOMAIN,
			),
		);
		const loaded = await loadApp(APP_ID);
		expect(loaded?.blueprint.organizationLevels?.[FACILITY]).toBeDefined();
		expect(
			loaded?.blueprint.organizationLevels?.[DISTRICT]?.parentLevelUuid,
		).toBe(REGION);
		expect(
			loaded?.blueprint.locationProperties?.[PROP_BEDS]?.required,
		).not.toBe(true);
	});

	it("keeps today's sentences where the app has no managed copy", async () => {
		await seedApp();
		const north = (
			await createLocation(scope(), {
				levelUuid: REGION,
				parentId: null,
				name: "North",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location.id;
		const riverside = (
			await createLocation(scope(), {
				levelUuid: DISTRICT,
				parentId: north,
				name: "Riverside",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location.id;
		await createLocation(scope(), {
			levelUuid: FACILITY,
			parentId: riverside,
			name: "Mercy Clinic",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
		});

		await expect(commit("remove-facility", removeFacility)).rejects.toThrow(
			`"Facility" still has places in it, so the level can't be removed. Bring back any archived places, then move every place to another level.`,
		);
		await expect(commit("district-as-root", districtAsRoot)).rejects.toThrow(
			`"Riverside" would no longer sit under a place at a level above it after this level change. Bring it back first if it is archived, move it to a valid parent, then retry the level change.`,
		);
		await expect(commit("beds-required", bedsRequired)).rejects.toThrow(
			`"North" blocks this change. "Beds" is required for places at this level.`,
		);
	});
});

describe("a refresh of the copy", () => {
	it("on an equal digest moves only the refresh columns", async () => {
		await seedApp();
		await bringIn();
		const before = await readOrganization(scope());

		const result = await refresh(BIRTH_PLACES);

		expect(result).toEqual({
			added: 0,
			changed: 0,
			archived: 0,
			keptInUse: [],
			leftOut: {},
		});
		const after = await readOrganization(scope());
		expect(after.revision).toBe(before.revision);
		expect(after.locations).toEqual(before.locations);
		expect(after.hq?.refreshedAt).toBe("2026-11-02T10:00:00.000Z");
	});

	it("adds, updates, archives and restores by site code, and keeps a place a persona stands in until nothing names it", async () => {
		await seedApp();
		await bringIn([
			...BIRTH_PLACES,
			place("hilltop", "Hilltop", FACILITY, "riverside"),
			place("old-post", "Old Post", DISTRICT, "north"),
		]);
		const born = bySiteCode((await readOrganization(scope())).locations);
		await commit("asha-at-old-post", [
			{
				kind: "updatePersona",
				uuid: PERSONA_ASHA,
				patch: {
					locations: { primaryUuid: asUuid(born.get("old-post")?.id ?? "") },
				},
			},
		]);
		const beforeRefresh = await readOrganization(scope());

		// Riverside renamed (its latitude spelled differently, the same
		// number), Mercy's CommCare HQ id changed, Lakeside new, Hilltop and
		// Old Post gone from CommCare HQ.
		const first = [
			place("north", "North", REGION, null),
			place("riverside", "Riverside East", DISTRICT, "north", {
				latitude: "12.5000",
				longitude: "-3.25",
			}),
			place("mercy", "Mercy Clinic", FACILITY, "riverside", {
				hqLocationId: "hq-mercy-2",
				values: { [PROP_BEDS]: "40" },
			}),
			place("lakeside", "Lakeside", FACILITY, "riverside"),
		];
		expect(await refresh(first, { ward: 2 })).toEqual({
			added: 1,
			changed: 2,
			archived: 1,
			keptInUse: ["Old Post"],
			leftOut: { ward: 2 },
		});
		const afterFirst = await readOrganization(scope());
		expect(BigInt(afterFirst.revision)).toBe(
			BigInt(beforeRefresh.revision) + BigInt(1),
		);
		expect(afterFirst.hq?.leftOut).toEqual({ ward: 2 });
		const places = bySiteCode(afterFirst.locations);
		expect(places.get("riverside")?.name).toBe("Riverside East");
		expect(places.get("riverside")?.id).toBe(born.get("riverside")?.id);
		expect(places.get("lakeside")?.parentId).toBe(born.get("riverside")?.id);
		expect(places.get("hilltop")?.archivedAt).not.toBeNull();
		expect(places.get("old-post")?.archivedAt).toBeNull();
		expect((await hqLocationIds()).mercy).toBe("hq-mercy-2");
		expect((await hqLocationIds()).lakeside).toBe("hq-lakeside");

		// Nothing changed in CommCare HQ, and Old Post is still named: the
		// rows are compared again, nothing is written and the clock stays.
		expect(await refresh(first, { ward: 2 })).toEqual({
			added: 0,
			changed: 0,
			archived: 0,
			keptInUse: ["Old Post"],
			leftOut: { ward: 2 },
		});
		expect((await readOrganization(scope())).revision).toBe(
			afterFirst.revision,
		);

		// Hilltop is listed again: restored.
		const second = [
			...first,
			place("hilltop", "Hilltop", FACILITY, "riverside"),
		];
		expect(await refresh(second, { ward: 2 })).toMatchObject({
			added: 1,
			changed: 0,
			archived: 0,
		});
		expect(
			bySiteCode((await readOrganization(scope())).locations).get("hilltop")
				?.archivedAt,
		).toBeNull();

		// Asha moves off Old Post, and the same CommCare HQ list archives it.
		await commit("asha-unassigned", [
			{ kind: "updatePersona", uuid: PERSONA_ASHA, patch: { locations: null } },
		]);
		expect(await refresh(second, { ward: 2 })).toEqual({
			added: 0,
			changed: 0,
			archived: 1,
			keptInUse: [],
			leftOut: { ward: 2 },
		});
		expect(
			bySiteCode((await readOrganization(scope())).locations).get("old-post")
				?.archivedAt,
		).not.toBeNull();
		// The copy now matches CommCare HQ, so the next equal list is the
		// digest's shortcut.
		const settled = await readOrganization(scope());
		await refresh(second, { ward: 2 }, new Date("2026-11-03T10:00:00.000Z"));
		const last = await readOrganization(scope());
		expect(last.revision).toBe(settled.revision);
		expect(last.hq?.refreshedAt).toBe("2026-11-03T10:00:00.000Z");
	});

	it("is refused where the app's places are not managed in CommCare HQ", async () => {
		await seedApp();
		const error = await refusalOf(refresh(BIRTH_PLACES));
		expect(error).toBeInstanceOf(OrganizationError);
		expect((error as OrganizationError).code).toBe("not_found");
		expect((await readOrganization(scope())).locations).toEqual([]);
	});
});
