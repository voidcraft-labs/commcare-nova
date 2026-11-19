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
	managedPlacesLeftOut,
	managedPlacesRefreshRefusal,
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
import { MAX_LOCATIONS_PER_APP } from "../schema";
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
	leftOutHqLocationIds: readonly string[] = [],
): ManagedPlacePlan {
	return {
		places,
		digest: canonicalJsonDigest(
			[...places].sort((left, right) =>
				left.siteCode < right.siteCode ? -1 : 1,
			),
		),
		leftOut,
		leftOutHqLocationIds,
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
	leftOutHqLocationIds: readonly string[] = [],
) {
	return withAppTx((tx) =>
		refreshManagedPlacesInTransaction(tx, scope(), {
			plan: plan(places, leftOut, leftOutHqLocationIds),
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

/** The places a refresh kept as gone from CommCare HQ, by site code. */
async function goneSiteCodes(): Promise<string[]> {
	const rows = await h
		.db()
		.selectFrom("app_locations")
		.select("site_code")
		.where("app_id", "=", APP_ID)
		.where("hq_gone_at", "is not", null)
		.orderBy("site_code")
		.execute();
	return rows.map((row) => row.site_code);
}

async function locationCount(): Promise<number> {
	const state = await h
		.db()
		.selectFrom("app_organization_state")
		.select("location_count")
		.where("app_id", "=", APP_ID)
		.executeTakeFirstOrThrow();
	return state.location_count;
}

async function standAsha(batchId: string, locationId: string): Promise<void> {
	await commit(batchId, [
		{
			kind: "updatePersona",
			uuid: PERSONA_ASHA,
			patch: { locations: { primaryUuid: asUuid(locationId) } },
		},
	]);
}

/** Everything a refused refresh must leave as it was. */
async function copyState() {
	const snapshot = await readOrganization(scope());
	const state = await h
		.db()
		.selectFrom("app_organization_state")
		.select(["hq_places_digest", "hq_left_out", "location_count"])
		.where("app_id", "=", APP_ID)
		.executeTakeFirstOrThrow();
	return {
		revision: snapshot.revision,
		locations: snapshot.locations,
		state,
		hqLocationIds: await hqLocationIds(),
		gone: await goneSiteCodes(),
	};
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
			goneIds: [],
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

	it("passes over places CommCare HQ no longer lists, which no one in Nova can bring back or move", async () => {
		await seedApp();
		await bringIn(
			BIRTH_PLACES.map((birthPlace) => ({ ...birthPlace, values: {} })),
		);
		// CommCare HQ deletes Mercy Clinic, the one facility: the refresh
		// archives Nova's row of it.
		expect(
			await refresh([
				place("north", "North", REGION, null),
				place("riverside", "Riverside", DISTRICT, "north", {
					latitude: "12.5",
					longitude: "-3.25",
				}),
			]),
		).toMatchObject({ archived: 1 });

		// Required at Facility, where only the archived Mercy Clinic stands
		// without a value, then Facility removed with only it inside.
		await commit("beds-required-at-facility", [
			{
				kind: "updateLocationProperty",
				uuid: PROP_BEDS,
				patch: { required: true, levelUuids: [FACILITY] },
			},
		]);
		await commit("beds-at-district", [
			{
				kind: "updateLocationProperty",
				uuid: PROP_BEDS,
				patch: { required: false, levelUuids: [DISTRICT] },
			},
		]);
		await commit("remove-facility", removeFacility);
		const loaded = await loadApp(APP_ID);
		expect(loaded?.blueprint.organizationLevels?.[FACILITY]).toBeUndefined();
		// A live place still holds its level back.
		await expect(commit("district-as-root", districtAsRoot)).rejects.toThrow(
			managedOrganizationCommitRefusal(
				{ kind: "placement", place: '"Riverside"' },
				DOMAIN,
			),
		);
	});

	it("sends the author to what uses a place CommCare HQ no longer has", async () => {
		await seedApp();
		await bringIn();
		const born = bySiteCode((await readOrganization(scope())).locations);
		await standAsha("asha-at-mercy", born.get("mercy")?.id ?? "");
		// CommCare HQ deletes Mercy Clinic, which Asha keeps live.
		expect(
			await refresh([
				place("north", "North", REGION, null),
				place("riverside", "Riverside", DISTRICT, "north", {
					latitude: "12.5",
					longitude: "-3.25",
				}),
			]),
		).toMatchObject({ keptInUse: ["Mercy Clinic"] });

		// Beds narrowed to Region: Mercy Clinic's value no longer applies.
		await expect(
			commit("beds-at-region", [
				{
					kind: "updateLocationProperty",
					uuid: PROP_BEDS,
					patch: { levelUuids: [REGION] },
				},
			]),
		).rejects.toThrow(
			/^"Mercy Clinic" blocks this change\. .* CommCare HQ \(district-health\) no longer has it, and Nova keeps it only while something in this app uses it or a place below it\. You can move or change what uses it and refresh, then try the change again\.$/,
		);
		await expect(commit("remove-facility", removeFacility)).rejects.toThrow(
			managedOrganizationCommitRefusal(
				{ kind: "level-in-use", levels: ['"Facility"'], kept: true },
				DOMAIN,
			),
		);
	});

	it("words an owner rule the places can't satisfy with a step CommCare HQ takes", async () => {
		await seedApp();
		await bringIn([
			...BIRTH_PLACES,
			place("lake", "Lake District", DISTRICT, "north"),
		]);
		await expect(commitReverseOwnerRule(FACILITY)).rejects.toThrow(
			managedOrganizationCommitRefusal(
				{
					kind: "owner-none-below",
					level: "Facility",
					source: "Lake District",
					sourceKept: false,
				},
				DOMAIN,
			),
		);
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
			remade: [],
			keptLeftOut: [],
			leftOut: {},
		});
		const after = await readOrganization(scope());
		expect(after.revision).toBe(before.revision);
		expect(after.locations).toEqual(before.locations);
		expect(after.hq?.refreshedAt).toBe("2026-11-02T10:00:00.000Z");
	});

	it("adds, updates, archives and restores, takes a code CommCare HQ re-made under a new id as a new place, and keeps a place a persona stands in until nothing names it", async () => {
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
		// number), Mercy Clinic deleted and made again under its code (a new
		// CommCare HQ id), Lakeside new, Hilltop and Old Post gone from
		// CommCare HQ.
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
			added: 2,
			changed: 1,
			archived: 2,
			keptInUse: ["Old Post"],
			remade: [],
			keptLeftOut: [],
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
		// The new Mercy Clinic is a new row; the old one keeps its own CommCare
		// HQ id under a numbered code, archived, since nothing names it.
		expect(places.get("mercy")?.id).not.toBe(born.get("mercy")?.id);
		expect(places.get("mercy2")?.id).toBe(born.get("mercy")?.id);
		expect(places.get("mercy2")?.archivedAt).not.toBeNull();
		expect((await hqLocationIds()).mercy).toBe("hq-mercy-2");
		expect((await hqLocationIds()).mercy2).toBe("hq-mercy");
		expect((await hqLocationIds()).lakeside).toBe("hq-lakeside");
		// Old Post keeps CommCare HQ's id, marked gone for worker provisioning.
		expect((await hqLocationIds())["old-post"]).toBe("hq-old-post");
		expect(await goneSiteCodes()).toEqual(["old-post"]);
		expect(afterFirst.hq?.goneIds).toEqual([born.get("old-post")?.id]);

		// Nothing changed in CommCare HQ, and Old Post is still named: the
		// rows are compared again, nothing is written and the clock stays.
		expect(await refresh(first, { ward: 2 })).toEqual({
			added: 0,
			changed: 0,
			archived: 0,
			keptInUse: ["Old Post"],
			remade: [],
			keptLeftOut: [],
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
			remade: [],
			keptLeftOut: [],
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

	it("follows a place CommCare HQ gives a new site code by CommCare HQ's id, keeping its Nova id, and swaps two codes", async () => {
		await seedApp();
		await commitReverseOwnerRule(FACILITY);
		await bringIn([
			...BIRTH_PLACES,
			place("lake", "Lake District", DISTRICT, "north"),
			place("lake_clinic", "Lake Clinic", FACILITY, "lake"),
		]);
		const born = bySiteCode((await readOrganization(scope())).locations);
		const mercyId = born.get("mercy")?.id ?? "";
		await standAsha("asha-at-mercy", mercyId);

		// In CommCare HQ Mercy Clinic's code became mercy_clinic, and the two
		// districts swapped codes; every place keeps CommCare HQ's id.
		const recoded = [
			place("north", "North", REGION, null),
			place("lake", "Riverside", DISTRICT, "north", {
				hqLocationId: "hq-riverside",
				latitude: "12.5",
				longitude: "-3.25",
			}),
			place("mercy_clinic", "Mercy Clinic", FACILITY, "lake", {
				hqLocationId: "hq-mercy",
				values: { [PROP_BEDS]: "40" },
			}),
			place("riverside", "Lake District", DISTRICT, "north", {
				hqLocationId: "hq-lake",
			}),
			place("lake_clinic", "Lake Clinic", FACILITY, "riverside"),
		];
		expect(await refresh(recoded)).toEqual({
			added: 0,
			changed: 3,
			archived: 0,
			keptInUse: [],
			remade: [],
			keptLeftOut: [],
			leftOut: {},
		});
		const after = await readOrganization(scope());
		const places = bySiteCode(after.locations);
		expect(places.get("mercy_clinic")?.id).toBe(mercyId);
		expect(places.get("lake")?.id).toBe(born.get("riverside")?.id);
		expect(places.get("riverside")?.id).toBe(born.get("lake")?.id);
		expect(places.get("lake_clinic")?.parentId).toBe(born.get("lake")?.id);
		expect(places.has("mercy")).toBe(false);
		expect(after.locations.every((row) => row.archivedAt === null)).toBe(true);
		expect(after.locations).toHaveLength(5);
		// The copy now matches CommCare HQ: the next equal list changes nothing.
		expect(await refresh(recoded)).toMatchObject({
			added: 0,
			changed: 0,
			archived: 0,
		});
		expect((await readOrganization(scope())).revision).toBe(after.revision);
	});

	it("gives a deleted place a numbered code where CommCare HQ passes its code on, and moves and adds places under new parents", async () => {
		await seedApp();
		await bringIn([
			...BIRTH_PLACES,
			place("hilltop", "Hilltop", FACILITY, "riverside"),
		]);
		const born = bySiteCode((await readOrganization(scope())).locations);

		// CommCare HQ deleted Hilltop and gave its code to Mercy Clinic, which
		// moved under a new district with a new clinic beside it.
		const listed = [
			place("north", "North", REGION, null),
			place("riverside", "Riverside", DISTRICT, "north", {
				latitude: "12.5",
				longitude: "-3.25",
			}),
			place("east", "East", DISTRICT, "north"),
			place("hilltop", "Mercy Clinic", FACILITY, "east", {
				hqLocationId: "hq-mercy",
				values: { [PROP_BEDS]: "40" },
			}),
			place("east_clinic", "East Clinic", FACILITY, "east"),
		];
		expect(await refresh(listed)).toEqual({
			added: 2,
			changed: 1,
			archived: 1,
			keptInUse: [],
			remade: [],
			keptLeftOut: [],
			leftOut: {},
		});
		const after = bySiteCode((await readOrganization(scope())).locations);
		expect(after.get("hilltop")?.id).toBe(born.get("mercy")?.id);
		expect(after.get("hilltop")?.parentId).toBe(after.get("east")?.id);
		expect(after.get("east_clinic")?.parentId).toBe(after.get("east")?.id);
		expect(after.get("hilltop2")?.id).toBe(born.get("hilltop")?.id);
		expect(after.get("hilltop2")?.archivedAt).not.toBeNull();
		expect(await hqLocationIds()).toMatchObject({
			hilltop: "hq-mercy",
			hilltop2: "hq-hilltop",
		});
	});

	it("is not held back by an archived place under a place CommCare HQ re-made at another level", async () => {
		await seedApp();
		await bringIn([
			...BIRTH_PLACES,
			place("lake", "Lake District", DISTRICT, "north"),
		]);
		const north = place("north", "North", REGION, null);
		const lake = place("lake", "Lake District", DISTRICT, "north");
		// CommCare HQ deletes Mercy Clinic.
		expect(
			await refresh([
				north,
				place("riverside", "Riverside", DISTRICT, "north", {
					latitude: "12.5",
					longitude: "-3.25",
				}),
				lake,
			]),
		).toMatchObject({ archived: 1 });

		// Then deletes Riverside and makes a facility under Lake District with
		// the code it freed: a new place. Nova's archived Mercy Clinic still
		// stands under the old Riverside, which is archived under a numbered
		// code.
		expect(
			await refresh([
				north,
				lake,
				place("riverside", "Riverside Clinic", FACILITY, "lake", {
					hqLocationId: "hq-riverside-clinic",
				}),
			]),
		).toEqual({
			added: 1,
			changed: 0,
			archived: 1,
			keptInUse: [],
			remade: [],
			keptLeftOut: [],
			leftOut: {},
		});
		const places = bySiteCode((await readOrganization(scope())).locations);
		expect(places.get("riverside")?.levelUuid).toBe(FACILITY);
		expect(places.get("riverside2")?.archivedAt).not.toBeNull();
		expect(places.get("mercy")?.parentId).toBe(places.get("riverside2")?.id);
		expect(places.get("mercy")?.archivedAt).not.toBeNull();
	});

	it("never moves a place a persona stands in to a new CommCare HQ place made under its code: the old one is kept, marked gone, numbered and named as made again", async () => {
		await seedApp();
		await bringIn();
		const born = bySiteCode((await readOrganization(scope())).locations);
		const mercyId = born.get("mercy")?.id ?? "";
		await standAsha("asha-at-mercy", mercyId);

		// CommCare HQ deletes Mercy Clinic and makes another place under its
		// code: another CommCare HQ id.
		const remadeMercy = place("mercy", "Mercy Clinic", FACILITY, "riverside", {
			hqLocationId: "hq-mercy-remade",
			values: { [PROP_BEDS]: "40" },
		});
		expect(
			await refresh([
				place("north", "North", REGION, null),
				place("riverside", "Riverside", DISTRICT, "north", {
					latitude: "12.5",
					longitude: "-3.25",
				}),
				remadeMercy,
			]),
		).toEqual({
			added: 1,
			changed: 0,
			archived: 0,
			keptInUse: [],
			remade: ["Mercy Clinic"],
			keptLeftOut: [],
			leftOut: {},
		});
		const after = await readOrganization(scope());
		const places = bySiteCode(after.locations);
		// Asha's place keeps its Nova id and its own CommCare HQ id, gone.
		expect(places.get("mercy2")?.id).toBe(mercyId);
		expect(places.get("mercy2")?.archivedAt).toBeNull();
		expect(places.get("mercy")?.id).not.toBe(mercyId);
		expect(await hqLocationIds()).toMatchObject({
			mercy: "hq-mercy-remade",
			mercy2: "hq-mercy",
		});
		expect(await goneSiteCodes()).toEqual(["mercy2"]);
		expect(after.hq?.goneIds).toEqual([mercyId]);
		const asha = (await loadApp(APP_ID))?.blueprint.personas?.[PERSONA_ASHA]
			?.locations?.primaryUuid;
		expect(asha).toBe(mercyId);
	});

	it("never revives an archived place for a new CommCare HQ place made under its code", async () => {
		await seedApp();
		await bringIn([
			...BIRTH_PLACES,
			place("hilltop", "Hilltop", FACILITY, "riverside"),
		]);
		const born = bySiteCode((await readOrganization(scope())).locations);
		const hilltopId = born.get("hilltop")?.id ?? "";
		// CommCare HQ deletes Hilltop: archived.
		expect(await refresh(BIRTH_PLACES)).toMatchObject({ archived: 1 });

		// Then makes a new place under Hilltop's code.
		expect(
			await refresh([
				...BIRTH_PLACES,
				place("hilltop", "Hilltop", FACILITY, "riverside", {
					hqLocationId: "hq-hilltop-new",
				}),
			]),
		).toEqual({
			added: 1,
			changed: 0,
			archived: 0,
			keptInUse: [],
			remade: [],
			keptLeftOut: [],
			leftOut: {},
		});
		const places = bySiteCode((await readOrganization(scope())).locations);
		expect(places.get("hilltop")?.id).not.toBe(hilltopId);
		expect(places.get("hilltop")?.archivedAt).toBeNull();
		expect(places.get("hilltop2")?.id).toBe(hilltopId);
		expect(places.get("hilltop2")?.archivedAt).not.toBeNull();
		expect(await hqLocationIds()).toMatchObject({
			hilltop: "hq-hilltop-new",
			hilltop2: "hq-hilltop",
		});
	});

	it("never moves a kept place CommCare HQ still holds at a level the app lacks to a new place made under its code", async () => {
		await seedApp();
		await bringIn();
		const born = bySiteCode((await readOrganization(scope())).locations);
		const mercyId = born.get("mercy")?.id ?? "";
		await standAsha("asha-at-mercy", mercyId);
		const north = place("north", "North", REGION, null);
		const riverside = place("riverside", "Riverside", DISTRICT, "north", {
			latitude: "12.5",
			longitude: "-3.25",
		});

		// CommCare HQ moves Mercy Clinic to a level the app lacks (still there,
		// left out), and a new facility takes its code.
		expect(
			await refresh(
				[
					north,
					riverside,
					place("mercy", "New Mercy", FACILITY, "riverside", {
						hqLocationId: "hq-new-mercy",
					}),
				],
				{ ward: 1 },
				undefined,
				["hq-mercy"],
			),
		).toEqual({
			added: 1,
			changed: 0,
			archived: 0,
			keptInUse: [],
			remade: [],
			keptLeftOut: ["Mercy Clinic"],
			leftOut: { ward: 1 },
		});
		const places = bySiteCode((await readOrganization(scope())).locations);
		expect(places.get("mercy2")?.id).toBe(mercyId);
		expect(places.get("mercy")?.name).toBe("New Mercy");
		expect(await hqLocationIds()).toMatchObject({
			mercy: "hq-new-mercy",
			mercy2: "hq-mercy",
		});
		// CommCare HQ still has it, so it is not marked gone.
		expect(await goneSiteCodes()).toEqual([]);
	});

	it("keeps a gone place a persona stands in with its gone parent, naming only the place", async () => {
		await seedApp();
		await bringIn();
		const born = bySiteCode((await readOrganization(scope())).locations);
		await standAsha("asha-at-mercy", born.get("mercy")?.id ?? "");

		// CommCare HQ deletes Riverside and Mercy Clinic below it.
		expect(await refresh([place("north", "North", REGION, null)])).toEqual({
			added: 0,
			changed: 0,
			archived: 0,
			keptInUse: ["Mercy Clinic"],
			remade: [],
			keptLeftOut: [],
			leftOut: {},
		});
		const after = await readOrganization(scope());
		const places = bySiteCode(after.locations);
		expect(places.get("mercy")?.archivedAt).toBeNull();
		expect(places.get("riverside")?.archivedAt).toBeNull();
		// Both are marked gone and keep CommCare HQ's ids.
		expect(await goneSiteCodes()).toEqual(["mercy", "riverside"]);
		expect(await hqLocationIds()).toEqual({
			north: "hq-north",
			riverside: "hq-riverside",
			mercy: "hq-mercy",
		});
		const byId = new Map(after.locations.map((row) => [row.id, row]));
		for (const row of after.locations) {
			if (row.archivedAt !== null || row.parentId === null) continue;
			expect(byId.get(row.parentId)?.archivedAt, row.name).toBeNull();
		}
	});

	it("finds a kept place CommCare HQ lists again under another code by CommCare HQ's id, keeping its Nova id", async () => {
		await seedApp();
		await commitReverseOwnerRule(FACILITY);
		await bringIn();
		const born = bySiteCode((await readOrganization(scope())).locations);
		const mercyId = born.get("mercy")?.id ?? "";
		await standAsha("asha-at-mercy", mercyId);
		const riverside = place("riverside", "Riverside", DISTRICT, "north", {
			latitude: "12.5",
			longitude: "-3.25",
		});
		const north = place("north", "North", REGION, null);

		// CommCare HQ archives Mercy Clinic: kept, as a gone place.
		expect(await refresh([north, riverside], {}, undefined)).toMatchObject({
			archived: 0,
			keptInUse: ["Mercy Clinic"],
			remade: [],
			keptLeftOut: [],
		});
		expect(await goneSiteCodes()).toEqual(["mercy"]);

		// Then brings it back renamed through the API without its code, which
		// makes a new one under the same CommCare HQ id.
		const back = [
			north,
			riverside,
			place("mercy_clinic_2", "Mercy Clinic", FACILITY, "riverside", {
				hqLocationId: "hq-mercy",
				values: { [PROP_BEDS]: "40" },
			}),
		];
		expect(await refresh(back)).toEqual({
			added: 0,
			changed: 1,
			archived: 0,
			keptInUse: [],
			remade: [],
			keptLeftOut: [],
			leftOut: {},
		});
		const after = await readOrganization(scope());
		expect(after.locations).toHaveLength(3);
		expect(bySiteCode(after.locations).get("mercy_clinic_2")?.id).toBe(mercyId);
		expect(await goneSiteCodes()).toEqual([]);
		expect(after.hq?.goneIds).toEqual([]);
		// The copy matches CommCare HQ now: the next equal list is the shortcut.
		await refresh(back, {}, new Date("2026-11-03T10:00:00.000Z"));
		expect((await readOrganization(scope())).revision).toBe(after.revision);
	});

	it("keeps a place in use that CommCare HQ holds at a level the app lacks as it stood, naming it, without calling it gone, and leaves out one nothing uses", async () => {
		await seedApp();
		await bringIn([
			...BIRTH_PLACES,
			place("hilltop", "Hilltop", FACILITY, "riverside"),
		]);
		const born = bySiteCode((await readOrganization(scope())).locations);
		await standAsha("asha-at-mercy", born.get("mercy")?.id ?? "");

		// CommCare HQ retypes Mercy Clinic and Hilltop to a level the app
		// doesn't have, so the plan leaves both out and counts them.
		const result = await refresh(
			[
				place("north", "North", REGION, null),
				place("riverside", "Riverside", DISTRICT, "north", {
					latitude: "12.5",
					longitude: "-3.25",
				}),
			],
			{ post: 2 },
			undefined,
			["hq-mercy", "hq-hilltop"],
		);
		expect(result).toEqual({
			added: 0,
			changed: 0,
			archived: 1,
			keptInUse: [],
			remade: [],
			keptLeftOut: ["Mercy Clinic"],
			leftOut: { post: 2 },
		});
		const snapshot = await readOrganization(scope());
		const after = bySiteCode(snapshot.locations);
		// Mercy Clinic stands as the copy held it, at the level CommCare HQ
		// moved it from; Hilltop, which nothing uses, is left out.
		expect(after.get("mercy")).toMatchObject({
			archivedAt: null,
			levelUuid: FACILITY,
			name: "Mercy Clinic",
			values: { [PROP_BEDS]: "40" },
		});
		expect(after.get("hilltop")?.archivedAt).not.toBeNull();
		expect(await goneSiteCodes()).toEqual([]);
		expect((await hqLocationIds()).mercy).toBe("hq-mercy");
		// The standing line over the stored count says a place in use stays.
		expect(managedPlacesLeftOut(snapshot.hq?.leftOut ?? {})).toContain(
			"Where this app uses one of them, Nova keeps that place as it stood before.",
		);
	});

	it("refuses a place CommCare HQ lists where the app's levels or place information don't allow it, leaving the copy as it was", async () => {
		await seedApp();
		// Beds only on North, so it can be made required at Region alone.
		const withBeds = BIRTH_PLACES.map((birthPlace) => ({
			...birthPlace,
			values:
				birthPlace.siteCode === "north"
					? { [PROP_BEDS]: "5" }
					: ({} as Record<string, string>),
		}));
		await bringIn(withBeds);
		await commit("beds-required-at-region", [
			{
				kind: "updateLocationProperty",
				uuid: PROP_BEDS,
				patch: { required: true, levelUuids: [REGION] },
			},
		]);
		const before = await copyState();

		const atRoot = await refusalOf(
			refresh([...withBeds, place("orphan", "Orphan Clinic", FACILITY, null)]),
		);
		expect(atRoot).toBeInstanceOf(OrganizationError);
		expect((atRoot as OrganizationError).code).toBe("rejected");
		expect((atRoot as OrganizationError).message).toBe(
			managedPlacesRefreshRefusal(
				{ kind: "placement", place: "Orphan Clinic" },
				DOMAIN,
			),
		);
		expect((atRoot as OrganizationError).message).toMatch(
			/Nova kept its copy as it was\.$/,
		);
		expect(await copyState()).toEqual(before);

		// North loses its value in CommCare HQ.
		const noValue = await refusalOf(
			refresh(withBeds.map((birthPlace) => ({ ...birthPlace, values: {} }))),
		);
		expect((noValue as OrganizationError).code).toBe("rejected");
		expect((noValue as OrganizationError).message).toBe(
			managedPlacesRefreshRefusal(
				{
					kind: "value",
					place: "North",
					issue: '"Beds" is required for places at this level.',
				},
				DOMAIN,
			),
		);
		expect(await copyState()).toEqual(before);
	});

	it("lets go of the longest archived places nothing names to stay within the places Nova holds, each after the places under it", async () => {
		await seedApp();
		await bringIn([
			...BIRTH_PLACES,
			place("hilltop", "Hilltop", FACILITY, "north"),
			place("lake", "Lake District", DISTRICT, "north"),
		]);
		const north = place("north", "North", REGION, null);
		const lake = place("lake", "Lake District", DISTRICT, "north");
		const riverside = place("riverside", "Riverside", DISTRICT, "north", {
			latitude: "12.5",
			longitude: "-3.25",
		});
		const mercy = BIRTH_PLACES[2];
		// CommCare HQ deletes Hilltop, then Riverside with Mercy Clinic below
		// it: three archived rows, Hilltop the longest archived.
		await refresh([north, riverside, mercy, lake]);
		await refresh([north, lake], {}, new Date("2026-11-03T10:00:00.000Z"));
		// The count the store keeps, archived places included, at the limit.
		await h
			.db()
			.updateTable("app_organization_state")
			.set({ location_count: MAX_LOCATIONS_PER_APP })
			.where("app_id", "=", APP_ID)
			.execute();

		// Three new places: three rows go, Hilltop and Mercy Clinic first,
		// then Riverside once nothing stands under it.
		expect(
			await refresh(
				[
					north,
					lake,
					place("east", "East", DISTRICT, "north"),
					place("east_clinic", "East Clinic", FACILITY, "east"),
					place("lake_clinic", "Lake Clinic", FACILITY, "lake"),
				],
				{},
				new Date("2026-11-04T10:00:00.000Z"),
			),
		).toEqual({
			added: 3,
			changed: 0,
			archived: 0,
			keptInUse: [],
			remade: [],
			keptLeftOut: [],
			leftOut: {},
		});
		const after = bySiteCode((await readOrganization(scope())).locations);
		expect([...after.keys()].sort()).toEqual([
			"east",
			"east_clinic",
			"lake",
			"lake_clinic",
			"north",
		]);
		expect(await locationCount()).toBe(MAX_LOCATIONS_PER_APP);
	});

	it("keeps an archived place nothing names where a saved case is owned by it, letting go of others in its place", async () => {
		await seedApp();
		await bringIn([
			...BIRTH_PLACES,
			place("hilltop", "Hilltop", FACILITY, "north"),
			place("lake", "Lake District", DISTRICT, "north"),
		]);
		const north = place("north", "North", REGION, null);
		const lake = place("lake", "Lake District", DISTRICT, "north");
		const riverside = place("riverside", "Riverside", DISTRICT, "north", {
			latitude: "12.5",
			longitude: "-3.25",
		});
		// Hilltop is archived first, so it is the first a refresh past the
		// limit would let go of; then Riverside with Mercy Clinic below it.
		await refresh([north, riverside, BIRTH_PLACES[2], lake]);
		await refresh([north, lake], {}, new Date("2026-11-03T10:00:00.000Z"));
		const hilltopId = bySiteCode(
			(await readOrganization(scope())).locations,
		).get("hilltop")?.id;
		if (hilltopId === undefined) throw new Error("Hilltop is in the copy.");
		// A case a worker closed while Hilltop owned it: nothing in the app
		// names Hilltop, and the case still does.
		await h.pool().query(
			`INSERT INTO cases (case_id, app_id, project_id, case_type, case_name, owner_id, status, closed_on, properties)
			VALUES ('hilltop-visit', $1, $2, 'patient', 'Hilltop visit', $3, 'closed', now(), '{}')`,
			[APP_ID, PROJECT, hilltopId],
		);
		await h
			.db()
			.updateTable("app_organization_state")
			.set({ location_count: MAX_LOCATIONS_PER_APP })
			.where("app_id", "=", APP_ID)
			.execute();

		// Two new places: Riverside and Mercy Clinic go, Hilltop stays.
		expect(
			await refresh(
				[
					north,
					lake,
					place("east", "East", DISTRICT, "north"),
					place("lake_clinic", "Lake Clinic", FACILITY, "lake"),
				],
				{},
				new Date("2026-11-04T10:00:00.000Z"),
			),
		).toMatchObject({ added: 2, archived: 0 });
		const after = bySiteCode((await readOrganization(scope())).locations);
		expect([...after.keys()].sort()).toEqual([
			"east",
			"hilltop",
			"lake",
			"lake_clinic",
			"north",
		]);
		expect(after.get("hilltop")?.id).toBe(hilltopId);
		expect(after.get("hilltop")?.archivedAt).not.toBeNull();
		expect(await locationCount()).toBe(MAX_LOCATIONS_PER_APP);

		// With only the case's place left to let go of, the refresh refuses
		// rather than leave the case owned by no place.
		const before = await copyState();
		const error = await refusalOf(
			refresh(
				[
					north,
					lake,
					place("east", "East", DISTRICT, "north"),
					place("lake_clinic", "Lake Clinic", FACILITY, "lake"),
					place("west", "West", DISTRICT, "north"),
				],
				{},
				new Date("2026-11-05T10:00:00.000Z"),
			),
		);
		expect((error as OrganizationError).code).toBe("limit");
		expect(await copyState()).toEqual(before);
	});

	it("refuses a refresh past the places Nova holds where only places in use stand beyond it, leaving the copy as it was", async () => {
		await seedApp();
		await bringIn();
		const born = bySiteCode((await readOrganization(scope())).locations);
		await standAsha("asha-at-mercy", born.get("mercy")?.id ?? "");
		// CommCare HQ deletes Mercy Clinic, which Asha keeps live.
		await refresh([
			place("north", "North", REGION, null),
			place("riverside", "Riverside", DISTRICT, "north", {
				latitude: "12.5",
				longitude: "-3.25",
			}),
		]);
		await h
			.db()
			.updateTable("app_organization_state")
			.set({ location_count: MAX_LOCATIONS_PER_APP })
			.where("app_id", "=", APP_ID)
			.execute();
		const before = await copyState();

		const error = await refusalOf(
			refresh(
				[
					place("north", "North", REGION, null),
					place("riverside", "Riverside", DISTRICT, "north", {
						latitude: "12.5",
						longitude: "-3.25",
					}),
					place("east", "East", DISTRICT, "north"),
				],
				{},
				new Date("2026-11-03T10:00:00.000Z"),
			),
		);
		expect(error).toBeInstanceOf(OrganizationError);
		expect((error as OrganizationError).code).toBe("limit");
		expect((error as OrganizationError).message).toBe(
			"Refreshing would take this app past 10,000 places, which is as many as Nova stores for one app: CommCare HQ's places, the ones Nova keeps because this app still uses them and the ones saved cases belong to come to more than that. You can move or change what uses the places CommCare HQ no longer has, then refresh again. Nova kept its copy as it was.",
		);
		expect(await copyState()).toEqual(before);
	});

	it("refuses an owner rule CommCare HQ's places would break with a step that works there", async () => {
		await seedApp();
		await commitReverseOwnerRule(FACILITY);
		await bringIn();
		const before = await copyState();

		// A new district with no facility below it yet.
		const noneBelow = await refusalOf(
			refresh([
				...BIRTH_PLACES,
				place("lake", "Lake District", DISTRICT, "north"),
			]),
		);
		expect((noneBelow as OrganizationError).code).toBe("rejected");
		expect((noneBelow as OrganizationError).message).toBe(
			'The owner rule for Facility needs exactly one live facility below "Lake District", and CommCare HQ (district-health) now has none there. You can add one there or change the rule in Nova, then refresh. Nova kept its copy as it was.',
		);
		expect(await copyState()).toEqual(before);

		// A second facility under Riverside.
		const two = await refusalOf(
			refresh([
				...BIRTH_PLACES,
				place("annex", "Mercy Annex", FACILITY, "riverside"),
			]),
		);
		expect((two as OrganizationError).message).toBe(
			managedPlacesRefreshRefusal(
				{
					kind: "owner-ambiguous",
					level: "Facility",
					source: "Riverside",
					places: ["Mercy Annex", "Mercy Clinic"],
					kept: null,
				},
				DOMAIN,
			),
		);
		expect(await copyState()).toEqual(before);

		// Asha stands in Mercy Clinic, which CommCare HQ replaces with Mercy
		// Annex: Nova keeps Mercy Clinic, so the rule would find two, and the
		// way forward is to move Asha.
		const mercyId = bySiteCode(before.locations).get("mercy")?.id ?? "";
		await standAsha("asha-at-mercy", mercyId);
		const beforeKept = await copyState();
		const kept = await refusalOf(
			refresh([
				place("north", "North", REGION, null),
				place("riverside", "Riverside", DISTRICT, "north", {
					latitude: "12.5",
					longitude: "-3.25",
				}),
				place("annex", "Mercy Annex", FACILITY, "riverside"),
			]),
		);
		expect((kept as OrganizationError).message).toBe(
			managedPlacesRefreshRefusal(
				{
					kind: "owner-ambiguous",
					level: "Facility",
					source: "Riverside",
					places: ["Mercy Annex", "Mercy Clinic"],
					kept: "Mercy Clinic",
				},
				DOMAIN,
			),
		);
		expect(await copyState()).toEqual(beforeKept);
	});

	it("is refused where the app's places are not managed in CommCare HQ", async () => {
		await seedApp();
		const error = await refusalOf(refresh(BIRTH_PLACES));
		expect(error).toBeInstanceOf(OrganizationError);
		expect((error as OrganizationError).code).toBe("not_found");
		expect((await readOrganization(scope())).locations).toEqual([]);
	});
});

describe("a refresh whose read of CommCare HQ began before the copy's last refresh", () => {
	it("writes nothing over the newer read and keeps its date", async () => {
		await seedApp();
		await bringIn();
		// Refresh B read CommCare HQ at T2, after CommCare HQ added a place,
		// and committed first.
		const t2 = new Date("2026-11-03T10:00:00.000Z");
		await refresh(
			[...BIRTH_PLACES, place("lake", "Lake", DISTRICT, "north")],
			{},
			t2,
		);
		const before = await copyState();

		// Refresh A read CommCare HQ at T1, before the place was added.
		const t1 = new Date("2026-11-02T10:00:00.000Z");
		expect(await refresh(BIRTH_PLACES, {}, t1)).toEqual({
			added: 0,
			changed: 0,
			archived: 0,
			keptInUse: [],
			remade: [],
			keptLeftOut: [],
			leftOut: {},
			superseded: true,
		});
		expect(await copyState()).toEqual(before);
		const state = await h
			.db()
			.selectFrom("app_organization_state")
			.select("hq_refreshed_at")
			.where("app_id", "=", APP_ID)
			.executeTakeFirstOrThrow();
		expect(state.hq_refreshed_at).toEqual(t2);
	});
});
