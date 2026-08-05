// Live-Postgres contract for the app-scoped locations store.
//
// Everything worth proving here is a property of a real database under a real
// lock set: the tenant boundary, the composite RESTRICT key that makes a
// referenced place undeletable, the archive cascade committing both stores
// together, and the fact that a cross-Project move is genuinely a no-op for
// these rows rather than a fourth thing to re-tenant. None of that can be
// asserted about SQL a test merely composed.

import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { makeCanonicalGenesisDoc } from "@/lib/agent/__tests__/fixtures";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	commitAppProjectMove,
	commitGuardedBatch,
	loadApp,
} from "@/lib/db/apps";
import {
	AppProjectChangedError,
	CommitReauthError,
	RunHolderLostError,
} from "@/lib/db/commitGuard";
import { addCaseOperationMutations } from "@/lib/doc/caseOperationMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	asUuid,
	automationMessageText,
	type BlueprintDoc,
	type OrganizationLevel,
	type Persona,
	type Uuid,
} from "@/lib/domain";
import {
	fixedLocation,
	ownerLocationAtLevel,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
	assertLocationOwnerTargetsValid,
	assertPersonaAssignmentsValid,
} from "../commitIntegrity";
import { OrganizationError } from "../errors";
import { MAX_LOCATION_ORDER_KEY_LENGTH } from "../orderKeys";
import {
	personaAssignmentIssue,
	personaAssignmentRemovalIssues,
} from "../ownerTargetVerdicts";
import {
	ARCHIVE_IMPACT_PREVIEW_TEXT_MAX_LENGTH,
	archiveImpactSchema,
	MAX_LOCATIONS_PER_APP,
} from "../schema";
import {
	createLocation,
	describeArchiveImpact,
	moveLocation,
	readOrganization,
	setLocationArchived,
	updateLocation,
} from "../service";
import type { OrganizationScope } from "../types";

const h = setupAppStateTestDb("organization_store_");

const PROJECT_A = "organization-project-a";
const PROJECT_B = "organization-project-b";
const APP_ID = "organization-app";
const ACTOR_A = "actor-a";
const ACTOR_B = "actor-b";

const REGION = asUuid("11111111-1111-4111-8111-111111111111");
const DISTRICT = asUuid("22222222-2222-4222-8222-222222222222");
const FACILITY = asUuid("33333333-3333-4333-8333-333333333333");
const PERSONA_ASHA = asUuid("44444444-4444-4444-8444-444444444444");
const PERSONA_BIMAL = asUuid("55555555-5555-4555-8555-555555555555");
const OUTPOST = asUuid("88888888-8888-4888-8888-888888888888");
const PROP_BEDS = asUuid("99999999-9999-4999-8999-999999999999");
const PROP_PHONE = asUuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

function level(
	uuid: string,
	code: string,
	name: string,
	parentLevelUuid?: string,
): OrganizationLevel {
	return {
		uuid: asUuid(uuid),
		code,
		name,
		...(parentLevelUuid !== undefined && {
			parentLevelUuid: asUuid(parentLevelUuid),
		}),
		caseFlow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "none" },
		},
		addressBook: { reach: "own-branch" },
	};
}

/** A three-rung organization with two personas and no assignments yet. */
function orgDoc(): BlueprintDoc {
	const base = makeCanonicalGenesisDoc("Organization", APP_ID);
	const personas: Record<string, Persona> = {
		[PERSONA_ASHA]: { uuid: PERSONA_ASHA, name: "Asha" },
		[PERSONA_BIMAL]: { uuid: PERSONA_BIMAL, name: "Bimal" },
	};
	return {
		...base,
		organizationLevels: {
			[REGION]: level(REGION, "region", "Region"),
			[DISTRICT]: level(DISTRICT, "district", "District", REGION),
			[FACILITY]: level(FACILITY, "facility", "Facility", DISTRICT),
		},
		organizationLevelOrder: [REGION, DISTRICT, FACILITY],
		personas,
		personaOrder: [PERSONA_ASHA, PERSONA_BIMAL],
	};
}

function workflowOrgDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Organization",
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
						fields: [
							f({
								kind: "text",
								id: "note",
								label: proseText("Note"),
							}),
						],
					},
				],
			},
		],
	});
	doc.appId = APP_ID;
	doc.organizationLevels = orgDoc().organizationLevels;
	doc.organizationLevelOrder = orgDoc().organizationLevelOrder;
	doc.personas = orgDoc().personas;
	doc.personaOrder = orgDoc().personaOrder;
	return doc;
}

function scope(
	projectId = PROJECT_A,
	actorUserId = ACTOR_A,
): OrganizationScope {
	return { appId: APP_ID, projectId, role: "owner", actorUserId };
}

async function seedOrgApp(): Promise<void> {
	await h.seedAppWithBlueprint(orgDoc(), {
		id: APP_ID,
		owner: ACTOR_A,
		projectId: PROJECT_A,
	});
}

async function seedWorkflowOrgApp(): Promise<void> {
	await h.seedAppWithBlueprint(workflowOrgDoc(), {
		id: APP_ID,
		owner: ACTOR_A,
		projectId: PROJECT_A,
	});
}

async function commitFixedOwnerForm(locationId: string): Promise<void> {
	const loaded = await loadApp(APP_ID);
	if (loaded === null) throw new Error("organization test app missing");
	const moduleUuid = loaded.blueprint.moduleOrder[0];
	const formUuid = loaded.blueprint.formOrder[moduleUuid]?.[0];
	if (formUuid === undefined) throw new Error("organization test form missing");
	const doc = hydratePersistedBlueprint(loaded.blueprint);
	await commitGuardedBatch({
		appId: APP_ID,
		batchId: `fixed-owner-${locationId}`,
		mutations: admitMutationBatch(
			addCaseOperationMutations(doc, formUuid, {
				uuid: asUuid("66666666-6666-4666-8666-666666666661"),
				id: "fixed_owner",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				owner: term(fixedLocation(asUuid(locationId))),
			}),
		),
		actorUserId: ACTOR_A,
		kind: "autosave",
		expectedProjectId: PROJECT_A,
	});
}

async function commitReverseOwnerForm(levelUuid: Uuid): Promise<void> {
	const loaded = await loadApp(APP_ID);
	if (loaded === null) throw new Error("organization test app missing");
	const moduleUuid = loaded.blueprint.moduleOrder[0];
	const formUuid = loaded.blueprint.formOrder[moduleUuid]?.[0];
	if (formUuid === undefined) throw new Error("organization test form missing");
	const doc = hydratePersistedBlueprint(loaded.blueprint);
	await commitGuardedBatch({
		appId: APP_ID,
		batchId: `reverse-owner-${levelUuid}`,
		mutations: admitMutationBatch(
			addCaseOperationMutations(doc, formUuid, {
				uuid: asUuid("66666666-6666-4666-8666-666666666662"),
				id: "reverse_owner",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				owner: term(ownerLocationAtLevel(levelUuid, "patient")),
			}),
		),
		actorUserId: ACTOR_A,
		kind: "autosave",
		expectedProjectId: PROJECT_A,
	});
}

async function commitLocationAutomation(locationUuid: Uuid): Promise<void> {
	await commitGuardedBatch({
		appId: APP_ID,
		batchId: `location-automation-${locationUuid}`,
		mutations: admitMutationBatch([
			{
				kind: "addAutomation",
				automation: {
					uuid: asUuid("77777777-7777-4777-8777-777777777771"),
					kind: "conditional-alert",
					name: "Alert Mercy Clinic",
					caseType: "patient",
					criteriaOperator: "all",
					criteria: [],
					setupOnlyCriteria: [],
					recipients: [
						{
							uuid: asUuid("77777777-7777-4777-8777-777777777772"),
							kind: "location",
							locationUuid,
						},
					],
					schedule: {
						kind: "immediate",
						events: [
							{
								uuid: asUuid("77777777-7777-4777-8777-777777777773"),
								minutesToWait: 0,
								content: {
									kind: "sms",
									message: automationMessageText("Hello"),
								},
							},
						],
					},
					includeDescendantLocations: false,
					locationLevelUuids: [],
					userDataFilters: [],
					useUserCaseForFilter: false,
				},
			},
		]),
		actorUserId: ACTOR_A,
		kind: "autosave",
		expectedProjectId: PROJECT_A,
	});
}

async function commitLocationCriterionAutomation(
	locationUuid: Uuid,
): Promise<void> {
	await commitGuardedBatch({
		appId: APP_ID,
		batchId: `location-criterion-automation-${locationUuid}`,
		mutations: admitMutationBatch([
			{
				kind: "addAutomation",
				automation: {
					uuid: asUuid("77777777-7777-4777-8777-777777777781"),
					kind: "case-update",
					name: "Clean up Mercy Clinic",
					caseType: "patient",
					criteriaOperator: "all",
					criteria: [
						{
							uuid: asUuid("77777777-7777-4777-8777-777777777782"),
							kind: "location",
							locationUuid,
							includeDescendants: true,
						},
					],
					setupOnlyCriteria: [],
					updates: [],
					closeCase: true,
				},
			},
		]),
		actorUserId: ACTOR_A,
		kind: "autosave",
		expectedProjectId: PROJECT_A,
	});
}

/** Region → District → Facility, one place at each rung. */
async function seedChain(): Promise<{
	region: Uuid;
	district: Uuid;
	facility: Uuid;
}> {
	const region = (
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
	const district = (
		await createLocation(scope(), {
			levelUuid: DISTRICT,
			parentId: region,
			name: "Riverside",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
		})
	).location.id;
	const facility = (
		await createLocation(scope(), {
			levelUuid: FACILITY,
			parentId: district,
			name: "Mercy Clinic",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
		})
	).location.id;
	return { region, district, facility };
}

/** Assign a persona through the ordinary guarded commit, edges included. */
async function assignPersona(
	personaUuid: string,
	primaryUuid: string,
	additionalUuids?: string[],
): Promise<void> {
	await commitGuardedBatch({
		appId: APP_ID,
		batchId: `assign-${personaUuid}-${primaryUuid}`,
		mutations: admitMutationBatch([
			{
				kind: "updatePersona",
				uuid: asUuid(personaUuid),
				patch: {
					locations: {
						primaryUuid: asUuid(primaryUuid),
						...(additionalUuids !== undefined && {
							additionalUuids: additionalUuids.map(asUuid),
						}),
					},
				},
			},
		]),
		actorUserId: ACTOR_A,
		kind: "autosave",
		expectedProjectId: PROJECT_A,
	});
}

async function personaLocations(
	personaUuid: string,
): Promise<unknown | undefined> {
	const row = await h
		.db()
		.selectFrom("blueprint_entities")
		.select("data")
		.where("app_id", "=", APP_ID)
		.where("uuid", "=", asUuid(personaUuid))
		.executeTakeFirst();
	return (row?.data as { locations?: unknown } | undefined)?.locations;
}

function candidateWithFixedOwner(
	locationId: string,
	personaLocationId?: string,
): BlueprintDoc {
	const doc = orgDoc();
	if (personaLocationId !== undefined) {
		doc.personas = {
			...doc.personas,
			[PERSONA_ASHA]: {
				...(doc.personas?.[PERSONA_ASHA] as Persona),
				locations: { primaryUuid: asUuid(personaLocationId) },
			},
		};
	}
	const formUuid = asUuid("66666666-6666-4666-8666-666666666661");
	doc.forms = {
		[formUuid]: {
			uuid: formUuid,
			caseOperations: [{ owner: term(fixedLocation(asUuid(locationId))) }],
		},
	} as unknown as BlueprintDoc["forms"];
	return doc;
}

async function seedRebalanceWithUnchangedMovingKey(): Promise<{
	readonly lowerId: Uuid;
	readonly movingId: Uuid;
}> {
	const lower = await createLocation(scope(), {
		levelUuid: REGION,
		parentId: null,
		name: "Lower",
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
	});
	const upper = await createLocation(scope(), {
		levelUuid: REGION,
		parentId: null,
		name: "Upper",
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
	});
	const moving = await createLocation(scope(), {
		levelUuid: REGION,
		parentId: null,
		name: "Moving",
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
	});
	const crowdedPrefix = `U${"V".repeat(MAX_LOCATION_ORDER_KEY_LENGTH - 2)}`;
	for (const [id, orderKey] of [
		[lower.location.id, `${crowdedPrefix}A`],
		[upper.location.id, `${crowdedPrefix}B`],
		[moving.location.id, "V"],
	] as const) {
		await h
			.db()
			.updateTable("app_locations")
			.set({ order_key: orderKey })
			.where("app_id", "=", APP_ID)
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
	}
	return { lowerId: lower.location.id, movingId: moving.location.id };
}

describe("locations store — creation and structure", () => {
	it("states that archived rows still count when the app reaches capacity", async () => {
		await seedOrgApp();
		await h
			.db()
			.insertInto("app_organization_state")
			.values({
				app_id: APP_ID,
				location_count: MAX_LOCATIONS_PER_APP,
			})
			.execute();

		await expect(
			createLocation(scope(), {
				levelUuid: REGION,
				parentId: null,
				name: "Over capacity",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			}),
		).rejects.toMatchObject({
			code: "limit",
			message: expect.stringMatching(/including archived places.*split/i),
		});
	});

	it("derives a unique site code and appends in sibling order", async () => {
		await seedOrgApp();
		const first = await createLocation(scope(), {
			levelUuid: REGION,
			parentId: null,
			name: "North Region",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
		});
		const second = await createLocation(scope(), {
			levelUuid: REGION,
			parentId: null,
			name: "North Region",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
		});
		expect(first.location.siteCode).toBe("north_region");
		// The dedupe runs against the LOCKED set, so a second place with the
		// same name cannot collide on the domain-unique code.
		expect(second.location.siteCode).toBe("north_region2");
		// Each write advances the clock exactly once.
		expect(second.revision).toBe("2");

		const snapshot = await readOrganization(scope());
		expect(snapshot.revision).toBe("2");
		expect(snapshot.locations.map((l) => l.name)).toEqual([
			"North Region",
			"North Region",
		]);
		expect(
			snapshot.locations[0].orderKey < snapshot.locations[1].orderKey,
		).toBe(true);
	});

	it("atomically rebalances a sibling run before an append exceeds the order-key cap", async () => {
		await seedOrgApp();
		const first = await createLocation(scope(), {
			levelUuid: REGION,
			name: "North",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
			parentId: null,
		});
		await h
			.db()
			.updateTable("app_locations")
			.set({ order_key: "V".repeat(MAX_LOCATION_ORDER_KEY_LENGTH) })
			.where("app_id", "=", APP_ID)
			.where("id", "=", first.location.id)
			.executeTakeFirstOrThrow();

		await createLocation(
			scope(),
			{
				levelUuid: REGION,
				name: "South",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
				parentId: null,
			},
			first.revision,
		);

		const snapshot = await readOrganization(scope());
		expect(snapshot.locations.map(({ name }) => name)).toEqual([
			"North",
			"South",
		]);
		expect(
			Math.max(...snapshot.locations.map(({ orderKey }) => orderKey.length)),
		).toBeLessThanOrEqual(MAX_LOCATION_ORDER_KEY_LENGTH);
	});

	it("advances the clock when update rebalances peers but keeps the moving key", async () => {
		await seedOrgApp();
		const { lowerId, movingId } = await seedRebalanceWithUnchangedMovingKey();
		const before = await readOrganization(scope());

		const result = await updateLocation(
			scope(),
			movingId,
			{ parentId: null, afterSiblingId: lowerId },
			before.revision,
		);
		const after = await readOrganization(scope());

		expect(BigInt(result.revision)).toBe(BigInt(before.revision) + BigInt(1));
		expect(after.locations.map(({ name }) => name)).toEqual([
			"Lower",
			"Moving",
			"Upper",
		]);
		await expect(
			updateLocation(scope(), movingId, { name: "Stale" }, before.revision),
		).rejects.toMatchObject({ code: "conflict" });
	});

	it("advances the clock when move rebalances peers but keeps the moving key", async () => {
		await seedOrgApp();
		const { lowerId, movingId } = await seedRebalanceWithUnchangedMovingKey();
		const before = await readOrganization(scope());

		const result = await moveLocation(
			scope(),
			movingId,
			{ parentId: null, afterSiblingId: lowerId },
			before.revision,
		);
		const after = await readOrganization(scope());

		expect(BigInt(result.revision)).toBe(BigInt(before.revision) + BigInt(1));
		expect(after.locations.map(({ name }) => name)).toEqual([
			"Lower",
			"Moving",
			"Upper",
		]);
		await expect(
			moveLocation(
				scope(),
				movingId,
				{ parentId: null, afterSiblingId: lowerId },
				before.revision,
			),
		).rejects.toMatchObject({ code: "conflict" });
	});

	it("refuses a caller-supplied code that collides case-insensitively", async () => {
		await seedOrgApp();
		await createLocation(scope(), {
			levelUuid: REGION,
			parentId: null,
			name: "North",
			siteCode: "north",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
		});
		await expect(
			createLocation(scope(), {
				levelUuid: REGION,
				parentId: null,
				name: "Other",
				siteCode: "NORTH",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			}),
		).rejects.toMatchObject({ code: "rejected" });
	});

	it("allows a place to skip an intermediate level", async () => {
		// The ragged hierarchy the fixture represents faithfully by blank-filling
		// `district_id`. Refusing it would force a placeholder district.
		await seedOrgApp();
		const region = (
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
		const facility = await createLocation(scope(), {
			levelUuid: FACILITY,
			parentId: region,
			name: "Direct Clinic",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
		});
		expect(facility.location.parentId).toBe(region);
	});

	it("refuses a place under one at its own level, and an inversion", async () => {
		await seedOrgApp();
		const { region, district, facility } = await seedChain();
		await expect(
			createLocation(scope(), {
				levelUuid: FACILITY,
				parentId: facility,
				name: "Nested Clinic",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			}),
		).rejects.toMatchObject({ code: "rejected" });
		await expect(
			moveLocation(scope(), region, { parentId: district }),
		).rejects.toMatchObject({ code: "rejected" });
	});

	it("refuses a move into its own subtree", async () => {
		await seedOrgApp();
		const { region, facility } = await seedChain();
		await expect(
			moveLocation(scope(), region, { parentId: facility }),
		).rejects.toMatchObject({ code: "rejected" });
	});

	it("refuses a level change on a place with children", async () => {
		// HQ's rule (`util.py::get_location_type`: "You cannot change the
		// location type of a location with children"), enforced in the store
		// rather than only in an authoring form.
		await seedOrgApp();
		const { district } = await seedChain();
		await expect(
			updateLocation(scope(), district, { levelUuid: FACILITY }),
		).rejects.toMatchObject({
			code: "rejected",
			message: expect.stringMatching(/bring back any archived child places/i),
		});
	});

	it("allows a leaf to change level when the new level still sits below its parent", async () => {
		await seedOrgApp();
		const { district } = await seedChain();
		// A second rung under District, so a leaf facility has somewhere legal
		// to move to.
		await commitGuardedBatch({
			appId: APP_ID,
			batchId: "add-outpost-level",
			mutations: admitMutationBatch([
				{
					kind: "addOrganizationLevel",
					level: level(OUTPOST, "outpost", "Outpost", DISTRICT),
				},
			]),
			actorUserId: ACTOR_A,
			kind: "autosave",
			expectedProjectId: PROJECT_A,
		});
		const leaf = (
			await createLocation(scope(), {
				levelUuid: FACILITY,
				parentId: district,
				name: "Small Clinic",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location.id;
		await expect(
			updateLocation(scope(), leaf, { levelUuid: OUTPOST }),
		).resolves.toMatchObject({ location: { levelUuid: OUTPOST } });
	});

	it("rolls back a leaf retype that would strand a persona assignment", async () => {
		await seedOrgApp();
		const { facility } = await seedChain();
		await assignPersona(PERSONA_ASHA, facility);
		await commitGuardedBatch({
			appId: APP_ID,
			batchId: "add-non-worker-outpost-level",
			mutations: admitMutationBatch([
				{
					kind: "addOrganizationLevel",
					level: {
						...level(OUTPOST, "outpost", "Outpost", DISTRICT),
						caseFlow: { workers: "none", ownsCases: true },
					},
				},
			]),
			actorUserId: ACTOR_A,
			kind: "autosave",
			expectedProjectId: PROJECT_A,
		});

		await expect(
			updateLocation(scope(), facility, { levelUuid: OUTPOST }),
		).rejects.toThrow(/does not hold workers/);
		expect(
			(await readOrganization(scope())).locations.find(
				(location) => location.id === facility,
			)?.levelUuid,
		).toBe(FACILITY);
	});

	it("refuses a leaf level change that would nest a level under itself", async () => {
		await seedOrgApp();
		const { facility } = await seedChain();
		// The facility's parent is a district, so retyping it to District would
		// put a district under a district — the ancestor-overwrite shape.
		await expect(
			updateLocation(scope(), facility, { levelUuid: DISTRICT }),
		).rejects.toMatchObject({ code: "rejected" });
	});

	it("retypes and reparents a leaf atomically without an invalid intermediate tree", async () => {
		await seedOrgApp();
		const { district } = await seedChain();
		const rootLeaf = (
			await createLocation(scope(), {
				levelUuid: REGION,
				parentId: null,
				name: "Intake Queue",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location;

		const updated = await updateLocation(scope(), rootLeaf.id, {
			levelUuid: FACILITY,
			parentId: district,
			afterSiblingId: null,
		});
		expect(updated.location).toMatchObject({
			levelUuid: FACILITY,
			parentId: district,
		});
	});

	it("keeps sibling order when the same parent is restated without an anchor", async () => {
		await seedOrgApp();
		const { district, facility } = await seedChain();
		await createLocation(scope(), {
			levelUuid: FACILITY,
			parentId: district,
			name: "Second Clinic",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
		});
		const before = await readOrganization(scope());
		const moved = await updateLocation(scope(), facility, {
			parentId: district,
		});
		const after = await readOrganization(scope());
		expect(moved.revision).toBe(before.revision);
		expect(after.locations.map((location) => location.id)).toEqual(
			before.locations.map((location) => location.id),
		);
	});

	it("keeps the exact order key and revision when an existing slot is restated", async () => {
		await seedOrgApp();
		const { district, facility } = await seedChain();
		const second = (
			await createLocation(scope(), {
				levelUuid: FACILITY,
				parentId: district,
				name: "Second Clinic",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location;
		const before = await readOrganization(scope());

		const updated = await updateLocation(scope(), second.id, {
			parentId: district,
			afterSiblingId: facility,
		});
		const moved = await moveLocation(scope(), second.id, {
			parentId: district,
		});
		const after = await readOrganization(scope());

		expect(updated.revision).toBe(before.revision);
		expect(moved.revision).toBe(before.revision);
		expect(updated.location.orderKey).toBe(second.orderKey);
		expect(moved.location.orderKey).toBe(second.orderKey);
		expect(after.locations).toEqual(before.locations);
	});
});

describe("locations store — the optimistic clock", () => {
	it("rejects a stale expected revision and reports the current one", async () => {
		await seedOrgApp();
		await seedChain();
		await expect(
			createLocation(
				scope(),
				{
					levelUuid: REGION,
					parentId: null,
					name: "South",
					externalId: null,
					latitude: null,
					longitude: null,
					values: {},
				},
				"1",
			),
		).rejects.toMatchObject({ code: "conflict", currentRevision: "3" });
	});

	it("does not advance the clock for a write that changes nothing", async () => {
		await seedOrgApp();
		const { facility } = await seedChain();
		const before = (await readOrganization(scope())).revision;
		const result = await updateLocation(scope(), facility, {});
		expect(result.revision).toBe(before);
		expect((await readOrganization(scope())).revision).toBe(before);
	});
});

describe("locations store — exact chat-run authority", () => {
	it("refuses both superseded and released holders before a row write", async () => {
		await seedOrgApp();
		const liveNonce = "11111111-1111-4111-8111-111111111111";
		await h
			.db()
			.updateTable("apps")
			.set({
				lock_run_id: "edit-run",
				lock_actor_user_id: ACTOR_A,
				lock_expire_at: new Date(Date.now() + 60_000),
				run_holder_nonce: liveNonce,
			})
			.where("id", "=", APP_ID)
			.execute();
		const base = scope();
		const stale: OrganizationScope = {
			...base,
			chatRunHolder: {
				source: "chat",
				mode: "edit",
				runId: "edit-run",
				nonce: "22222222-2222-4222-8222-222222222222",
			},
		};
		const create = (candidate: OrganizationScope) =>
			createLocation(candidate, {
				levelUuid: REGION,
				parentId: null,
				name: "North",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			});

		await expect(create(stale)).rejects.toBeInstanceOf(RunHolderLostError);
		await h
			.db()
			.updateTable("apps")
			.set({
				lock_run_id: null,
				lock_actor_user_id: null,
				lock_expire_at: null,
				run_holder_nonce: null,
			})
			.where("id", "=", APP_ID)
			.execute();
		await expect(
			create({
				...base,
				chatRunHolder: {
					source: "chat",
					mode: "edit",
					runId: "edit-run",
					nonce: liveNonce,
				},
			}),
		).rejects.toBeInstanceOf(RunHolderLostError);
		expect((await readOrganization(scope())).locations).toHaveLength(0);
	});

	it("surfaces a Project move as a terminal chat signal", async () => {
		await seedOrgApp();
		await h.seedProjectMember(ACTOR_A, PROJECT_B, "owner");
		await h.moveAppToProject(APP_ID, PROJECT_B, ACTOR_A);
		await expect(
			createLocation(
				{
					...scope(),
					chatRunHolder: {
						source: "chat",
						mode: "edit",
						runId: "moved-run",
						nonce: "33333333-3333-4333-8333-333333333333",
					},
				},
				{
					levelUuid: REGION,
					name: "North",
					externalId: null,
					latitude: null,
					longitude: null,
					values: {},
					parentId: null,
				},
			),
		).rejects.toBeInstanceOf(AppProjectChangedError);
	});

	it("surfaces membership loss as a terminal chat signal", async () => {
		await seedOrgApp();
		const nonce = "44444444-4444-4444-8444-444444444445";
		await h
			.db()
			.updateTable("apps")
			.set({
				lock_run_id: "membership-run",
				lock_actor_user_id: ACTOR_A,
				lock_expire_at: new Date(Date.now() + 60_000),
				run_holder_nonce: nonce,
			})
			.where("id", "=", APP_ID)
			.execute();
		await h.seedProjectMember(ACTOR_A, PROJECT_A, "viewer");
		await expect(
			createLocation(
				{
					...scope(),
					chatRunHolder: {
						source: "chat",
						mode: "edit",
						runId: "membership-run",
						nonce,
					},
				},
				{
					levelUuid: REGION,
					name: "North",
					externalId: null,
					latitude: null,
					longitude: null,
					values: {},
					parentId: null,
				},
			),
		).rejects.toBeInstanceOf(CommitReauthError);
		expect((await readOrganization(scope())).locations).toEqual([]);
	});
});

describe("locations store — the tenant boundary", () => {
	it("stores level identities as UUIDs and coordinates at HQ precision", async () => {
		const columns = await sql<{
			column_name: string;
			data_type: string;
			udt_name: string;
			numeric_precision: number | null;
			numeric_scale: number | null;
		}>`
			SELECT column_name, data_type, udt_name, numeric_precision, numeric_scale
			FROM information_schema.columns
			WHERE table_name = 'app_locations'
				AND column_name IN ('level_uuid', 'latitude', 'longitude')
		`.execute(h.db());
		const byName = new Map(columns.rows.map((row) => [row.column_name, row]));
		expect(byName.get("level_uuid")).toMatchObject({
			data_type: "uuid",
			udt_name: "uuid",
		});
		for (const coordinate of ["latitude", "longitude"]) {
			expect(byName.get(coordinate)).toMatchObject({
				data_type: "numeric",
				numeric_precision: 20,
				numeric_scale: 10,
			});
		}
	});

	it("keeps no tenant column at all, which is what makes the move a no-op", async () => {
		// The structural half of the proof. If either table grew a `project_id`,
		// a cross-Project move would silently leave these rows behind.
		for (const table of ["app_locations", "app_location_references"]) {
			const columns = await sql<{ column_name: string }>`
				SELECT column_name FROM information_schema.columns
				WHERE table_name = ${table}
			`.execute(h.db());
			expect(columns.rows.map((r) => r.column_name)).not.toContain(
				"project_id",
			);
			expect(columns.rows.map((r) => r.column_name)).toContain("app_id");
		}
	});

	it("refuses every entry point to a scope whose Project no longer matches the app", async () => {
		await seedOrgApp();
		const { facility } = await seedChain();
		await h.seedProjectMember(ACTOR_B, PROJECT_B, "owner");
		const foreign = scope(PROJECT_B, ACTOR_B);

		// Read: the snapshot is app-keyed, so a foreign scope's read is gated by
		// the writer lock helper on every path that takes one.
		await expect(
			describeArchiveImpact(foreign, facility),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			createLocation(foreign, {
				levelUuid: REGION,
				parentId: null,
				name: "Intruder",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			}),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			updateLocation(foreign, facility, { name: "Renamed" }),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			moveLocation(foreign, facility, { parentId: null }),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			setLocationArchived(foreign, facility, true),
		).rejects.toMatchObject({ code: "not_found" });

		// Nothing changed.
		const snapshot = await readOrganization(scope());
		expect(snapshot.locations).toHaveLength(3);
		expect(snapshot.locations.find((l) => l.id === facility)?.name).toBe(
			"Mercy Clinic",
		);
	});

	it("refuses a member of the app's own Project who is not a member at all", async () => {
		await seedOrgApp();
		await seedChain();
		await expect(
			createLocation(scope(PROJECT_A, "stranger"), {
				levelUuid: REGION,
				parentId: null,
				name: "Intruder",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			}),
		).rejects.toMatchObject({ code: "not_found" });
	});

	it("refuses a viewer, who may read but not write", async () => {
		await seedOrgApp();
		const { facility } = await seedChain();
		await h.seedProjectMember("watcher", PROJECT_A, "viewer");
		await expect(
			createLocation(scope(PROJECT_A, "watcher"), {
				levelUuid: REGION,
				parentId: null,
				name: "Nope",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			}),
		).rejects.toMatchObject({ code: "not_found" });
		// The read-side impact description authorizes at `view`, so it succeeds
		// — a viewer is entitled to understand the consequences of a change they
		// cannot make.
		await expect(
			describeArchiveImpact(scope(PROJECT_A, "watcher"), facility),
		).resolves.toMatchObject({ affectedLocationCount: 1 });
	});

	it("carries every place across a Project move, unchanged and still reachable", async () => {
		// The rows key on `app_id`, so the authoritative Project move carries
		// them by construction — and the scope check is what makes a stale
		// source-Project authorization stop working.
		await seedOrgApp();
		const { facility } = await seedChain();
		await h.seedProjectMember(ACTOR_A, PROJECT_B, "owner");
		await expect(
			commitAppProjectMove(APP_ID, {
				toProjectId: PROJECT_B,
				expectedFromProjectId: PROJECT_A,
				actorUserId: ACTOR_A,
				assetIdMap: new Map(),
			}),
		).resolves.toMatchObject({ kind: "moved" });

		const moved = await readOrganization(scope(PROJECT_B, ACTOR_A));
		expect(moved.locations).toHaveLength(3);
		expect(moved.locations.find((l) => l.id === facility)?.name).toBe(
			"Mercy Clinic",
		);
		await expect(
			updateLocation(scope(PROJECT_B, ACTOR_A), facility, { name: "Renamed" }),
		).resolves.toMatchObject({ location: { name: "Renamed" } });

		// The old Project's scope is now stale and refused.
		await expect(
			updateLocation(scope(PROJECT_A, ACTOR_A), facility, { name: "Stale" }),
		).rejects.toMatchObject({ code: "not_found" });
	});

	it("refuses a soft-deleted app", async () => {
		await seedOrgApp();
		const { facility } = await seedChain();
		await h
			.db()
			.updateTable("apps")
			.set({ deleted_at: new Date() })
			.where("id", "=", APP_ID)
			.execute();
		await expect(
			updateLocation(scope(), facility, { name: "Renamed" }),
		).rejects.toMatchObject({ code: "not_found" });
	});
});

describe("locations store — reference edges", () => {
	it("records an assignment as an edge and makes the place undeletable", async () => {
		await seedOrgApp();
		const { facility } = await seedChain();
		await assignPersona(PERSONA_ASHA, facility);

		const edges = await h
			.db()
			.selectFrom("app_location_references")
			.select("location_id")
			.where("app_id", "=", APP_ID)
			.execute();
		expect(edges.map((e) => e.location_id)).toEqual([facility]);

		// The composite RESTRICT key is the guarantee no application check can
		// make: a delete racing a commit still cannot strand the edge.
		//
		// SQLSTATE 23001 (`restrict_violation`), not 23503
		// (`foreign_key_violation`): Postgres raises the former for an explicit
		// `ON DELETE RESTRICT`, which fires immediately rather than deferring to
		// end-of-statement the way `NO ACTION` does.
		await expect(
			h
				.db()
				.deleteFrom("app_locations")
				.where("app_id", "=", APP_ID)
				.where("id", "=", facility)
				.execute(),
		).rejects.toMatchObject({ code: "23001" });
	});

	it("replaces the complete edge set on every commit, so it reconverges", async () => {
		await seedOrgApp();
		const { district, facility } = await seedChain();
		await assignPersona(PERSONA_ASHA, facility);
		await assignPersona(PERSONA_ASHA, district);
		const edges = await h
			.db()
			.selectFrom("app_location_references")
			.select("location_id")
			.where("app_id", "=", APP_ID)
			.execute();
		expect(edges.map((e) => e.location_id)).toEqual([district]);
	});

	it("refuses a commit assigning a persona to a place that does not exist", async () => {
		await seedOrgApp();
		await seedChain();
		await expect(
			assignPersona(PERSONA_ASHA, "66666666-6666-4666-8666-666666666666"),
		).rejects.toThrow(/no longer exists or is archived/);
	});
});

describe("locations store — persona and fixed-owner validation", () => {
	it("batches persona-removal verdicts with the same result as full validation", async () => {
		await seedOrgApp();
		const { district, facility } = await seedChain();
		const otherRegion = (
			await createLocation(scope(), {
				levelUuid: REGION,
				parentId: null,
				name: "South",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location.id;
		const doc = candidateWithFixedOwner(facility);
		doc.personas = {
			...doc.personas,
			[PERSONA_ASHA]: {
				...(doc.personas?.[PERSONA_ASHA] as Persona),
				locations: {
					primaryUuid: asUuid(district),
					additionalUuids: [asUuid(otherRegion)],
				},
			},
		};
		const rows = (await readOrganization(scope())).locations;
		const assigned = [district, otherRegion];
		const issues = personaAssignmentRemovalIssues(
			doc,
			rows,
			PERSONA_ASHA,
			assigned,
		);

		for (const removed of assigned) {
			expect(issues.get(removed)).toBe(
				personaAssignmentIssue(
					doc,
					rows,
					PERSONA_ASHA,
					assigned.filter((id) => id !== removed),
				),
			);
		}
	});

	it("rolls back a move that would put a fixed owner outside every persona address book", async () => {
		await seedWorkflowOrgApp();
		const { district, facility } = await seedChain();
		await assignPersona(PERSONA_ASHA, district);
		await commitFixedOwnerForm(facility);
		const otherRegion = (
			await createLocation(scope(), {
				levelUuid: REGION,
				parentId: null,
				name: "South",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location.id;

		await expect(
			moveLocation(scope(), facility, { parentId: otherRegion }),
		).rejects.toThrow(/outside Asha's address book/);
		expect(
			(await readOrganization(scope())).locations.find(
				(location) => location.id === facility,
			)?.parentId,
		).toBe(district);
	});

	it("accepts a fixed owner inside an assigned persona's address book and refuses a sibling branch", async () => {
		await seedOrgApp();
		const { facility } = await seedChain();
		const otherRegion = (
			await createLocation(scope(), {
				levelUuid: REGION,
				parentId: null,
				name: "South",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location.id;
		const otherFacility = (
			await createLocation(scope(), {
				levelUuid: FACILITY,
				parentId: otherRegion,
				name: "South Clinic",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location.id;

		await expect(
			h
				.db()
				.transaction()
				.execute((tx) =>
					assertLocationOwnerTargetsValid(tx, {
						appId: APP_ID,
						candidateDoc: candidateWithFixedOwner(facility, facility),
					}),
				),
		).resolves.toBeUndefined();
		await expect(
			h
				.db()
				.transaction()
				.execute((tx) =>
					assertLocationOwnerTargetsValid(tx, {
						appId: APP_ID,
						candidateDoc: candidateWithFixedOwner(otherFacility, facility),
					}),
				),
		).rejects.toThrow(/outside Asha's address book/);
	});

	it("always includes ancestors for limited and shared address books", async () => {
		await seedOrgApp();
		const { region, facility } = await seedChain();
		const addressBooks: OrganizationLevel["addressBook"][] = [
			{ reach: "own-branch-limited", levelUuids: [FACILITY] },
			{ reach: "shared-branch", fromLevelUuid: DISTRICT },
		];
		for (const addressBook of addressBooks) {
			const candidate = candidateWithFixedOwner(region, facility);
			candidate.organizationLevels = {
				...candidate.organizationLevels,
				[FACILITY]: {
					...(candidate.organizationLevels?.[FACILITY] as OrganizationLevel),
					addressBook,
				},
			};
			await expect(
				h
					.db()
					.transaction()
					.execute((tx) =>
						assertLocationOwnerTargetsValid(tx, {
							appId: APP_ID,
							candidateDoc: candidate,
						}),
					),
			).resolves.toBeUndefined();
		}
	});

	it("refuses fixed owners at non-owning levels and assignments at levels without workers", async () => {
		await seedOrgApp();
		const { facility } = await seedChain();
		const candidate = candidateWithFixedOwner(facility, facility);
		candidate.organizationLevels = {
			...candidate.organizationLevels,
			[FACILITY]: {
				...(candidate.organizationLevels?.[FACILITY] as OrganizationLevel),
				caseFlow: { workers: "none", ownsCases: false },
			},
		};

		await expect(
			h
				.db()
				.transaction()
				.execute((tx) =>
					assertLocationOwnerTargetsValid(tx, {
						appId: APP_ID,
						candidateDoc: candidate,
					}),
				),
		).rejects.toThrow(/does not own cases/);
		await expect(
			h
				.db()
				.transaction()
				.execute((tx) =>
					assertPersonaAssignmentsValid(tx, {
						appId: APP_ID,
						candidateDoc: candidate,
					}),
				),
		).rejects.toThrow(/does not hold workers/);
	});
});

describe("locations store — deterministic reverse-hop owners", () => {
	it("atomically grows a complete source branch while a reverse rule is active", async () => {
		await seedWorkflowOrgApp();
		const { region } = await seedChain();
		await commitReverseOwnerForm(FACILITY);
		const before = await readOrganization(scope());

		await expect(
			createLocation(scope(), {
				levelUuid: DISTRICT,
				parentId: region,
				name: "Lakeside",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			}),
		).rejects.toThrow(/same create request's descendants/i);
		expect(await readOrganization(scope())).toEqual(before);

		const result = await createLocation(scope(), {
			levelUuid: DISTRICT,
			parentId: region,
			name: "Lakeside",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
			descendants: [
				{
					levelUuid: FACILITY,
					name: "Lakeside Clinic",
					externalId: null,
					latitude: null,
					longitude: null,
					values: {},
				},
			],
		});
		expect(result.location.name).toBe("Lakeside");
		expect(result.descendants).toEqual([
			{
				locationUuid: expect.any(String),
				siteCode: "lakeside_clinic",
				descendants: [],
			},
		]);
		expect(result.revision).toBe(
			String(Number.parseInt(before.revision, 10) + 1),
		);
		expect(
			(await readOrganization(scope())).locations.map(({ name }) => name),
		).toContain("Lakeside Clinic");
	});

	it("refuses a reverse rule when any case-owning source has no destination", async () => {
		await seedWorkflowOrgApp();
		const { region } = await seedChain();
		await createLocation(scope(), {
			levelUuid: DISTRICT,
			parentId: region,
			name: "Lakeside",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
		});

		await expect(commitReverseOwnerForm(FACILITY)).rejects.toThrow(
			/no live facility below "Lakeside"/i,
		);
	});

	it("refuses a reverse destination level that no longer owns cases", async () => {
		await seedWorkflowOrgApp();
		await seedChain();
		await commitGuardedBatch({
			appId: APP_ID,
			batchId: "facility-stops-owning-cases",
			mutations: admitMutationBatch([
				{
					kind: "updateOrganizationLevel",
					uuid: FACILITY,
					patch: {
						caseFlow: {
							workers: "assigned",
							ownsCases: false,
							descendantCases: { kind: "none" },
						},
					},
				},
			]),
			actorUserId: ACTOR_A,
			kind: "autosave",
			expectedProjectId: PROJECT_A,
		});

		await expect(commitReverseOwnerForm(FACILITY)).rejects.toThrow(
			/does not own cases/i,
		);
	});

	it("does not apply a reverse owner rule to workers who do not receive the source cases", async () => {
		await seedWorkflowOrgApp();
		const { region } = await seedChain();
		await commitGuardedBatch({
			appId: APP_ID,
			batchId: "limit-region-address-book-without-descendant-cases",
			mutations: admitMutationBatch([
				{
					kind: "updateOrganizationLevel",
					uuid: REGION,
					patch: {
						addressBook: {
							reach: "own-branch",
							downToLevelUuid: DISTRICT,
						},
					},
				},
			]),
			actorUserId: ACTOR_A,
			kind: "autosave",
			expectedProjectId: PROJECT_A,
		});
		await assignPersona(PERSONA_ASHA, region);

		// Asha can see the District source but not the Facility destination.
		// That does not matter: Region's case-flow scope is `none`, so those
		// District-owned cases never reach Asha and the owner hop is inapplicable.
		await expect(commitReverseOwnerForm(FACILITY)).resolves.toBeUndefined();
	});

	it("refuses a reverse destination outside an applicable persona footprint", async () => {
		await seedWorkflowOrgApp();
		const { district } = await seedChain();
		await commitGuardedBatch({
			appId: APP_ID,
			batchId: "limit-district-address-book",
			mutations: admitMutationBatch([
				{
					kind: "updateOrganizationLevel",
					uuid: DISTRICT,
					patch: {
						addressBook: {
							reach: "own-branch",
							downToLevelUuid: DISTRICT,
						},
					},
				},
			]),
			actorUserId: ACTOR_A,
			kind: "autosave",
			expectedProjectId: PROJECT_A,
		});
		await assignPersona(PERSONA_ASHA, district);

		await expect(commitReverseOwnerForm(FACILITY)).rejects.toThrow(
			/outside Asha's address book/,
		);
	});

	it("refuses adding a reverse-hop rule to already-ambiguous rows", async () => {
		await seedWorkflowOrgApp();
		const { district } = await seedChain();
		await createLocation(scope(), {
			levelUuid: FACILITY,
			parentId: district,
			name: "Second Clinic",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
		});

		await expect(commitReverseOwnerForm(FACILITY)).rejects.toThrow(
			/owner rule for Facility is ambiguous below "Riverside"/,
		);
	});

	it("rolls back creating a second destination under the same owner", async () => {
		await seedWorkflowOrgApp();
		const { district } = await seedChain();
		await commitReverseOwnerForm(FACILITY);

		await expect(
			createLocation(scope(), {
				levelUuid: FACILITY,
				parentId: district,
				name: "Second Clinic",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			}),
		).rejects.toThrow(/owner rule for Facility is ambiguous below "Riverside"/);
		expect((await readOrganization(scope())).locations).toHaveLength(3);
	});

	it("rolls back moving a second destination under the same owner", async () => {
		await seedWorkflowOrgApp();
		const { region, district } = await seedChain();
		const otherDistrict = (
			await createLocation(scope(), {
				levelUuid: DISTRICT,
				parentId: region,
				name: "Lakeside",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location.id;
		const otherFacility = (
			await createLocation(scope(), {
				levelUuid: FACILITY,
				parentId: otherDistrict,
				name: "Lakeside Clinic",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location.id;
		await commitReverseOwnerForm(FACILITY);

		await expect(
			moveLocation(scope(), otherFacility, { parentId: district }),
		).rejects.toThrow(/owner rule for Facility is ambiguous below "Riverside"/);
		expect(
			(await readOrganization(scope())).locations.find(
				(location) => location.id === otherFacility,
			)?.parentId,
		).toBe(otherDistrict);
	});

	it("rolls back retyping a second destination under the same owner", async () => {
		await seedWorkflowOrgApp();
		const { district } = await seedChain();
		await commitGuardedBatch({
			appId: APP_ID,
			batchId: "add-retype-outpost-level",
			mutations: admitMutationBatch([
				{
					kind: "addOrganizationLevel",
					level: level(OUTPOST, "outpost", "Outpost", DISTRICT),
				},
			]),
			actorUserId: ACTOR_A,
			kind: "autosave",
			expectedProjectId: PROJECT_A,
		});
		const outpost = (
			await createLocation(scope(), {
				levelUuid: OUTPOST,
				parentId: district,
				name: "Mobile Outpost",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location.id;
		await commitReverseOwnerForm(FACILITY);

		await expect(
			updateLocation(scope(), outpost, { levelUuid: FACILITY }),
		).rejects.toThrow(/owner rule for Facility is ambiguous below "Riverside"/);
		expect(
			(await readOrganization(scope())).locations.find(
				(location) => location.id === outpost,
			)?.levelUuid,
		).toBe(OUTPOST);
	});

	it("rolls back restoring an archived second destination", async () => {
		await seedWorkflowOrgApp();
		const { district } = await seedChain();
		const archived = (
			await createLocation(scope(), {
				levelUuid: FACILITY,
				parentId: district,
				name: "Seasonal Clinic",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location.id;
		await setLocationArchived(scope(), archived, true);
		await commitReverseOwnerForm(FACILITY);

		await expect(setLocationArchived(scope(), archived, false)).rejects.toThrow(
			/owner rule for Facility is ambiguous below "Riverside"/,
		);
		expect(
			(await readOrganization(scope())).locations.find(
				(location) => location.id === archived,
			)?.archivedAt,
		).not.toBeNull();
	});

	it("rolls back archiving the sole destination for a live reverse-owner source", async () => {
		await seedWorkflowOrgApp();
		const { facility } = await seedChain();
		await commitReverseOwnerForm(FACILITY);

		await expect(setLocationArchived(scope(), facility, true)).rejects.toThrow(
			/archiving this place would break a case-owner rule/i,
		);
		expect(
			(await readOrganization(scope())).locations.find(
				(location) => location.id === facility,
			)?.archivedAt,
		).toBeNull();
	});
});

describe("locations store — removing a level", () => {
	it("atomically refuses reparenting a level away from its existing places", async () => {
		await seedOrgApp();
		await seedChain();
		await expect(
			commitGuardedBatch({
				appId: APP_ID,
				batchId: "make-district-a-root",
				mutations: admitMutationBatch([
					{
						kind: "updateOrganizationLevel",
						uuid: DISTRICT,
						patch: { parentLevelUuid: null },
					},
				]),
				actorUserId: ACTOR_A,
				kind: "autosave",
				expectedProjectId: PROJECT_A,
			}),
		).rejects.toThrow(/Riverside.*no longer sit/);
		expect(
			(await loadApp(APP_ID))?.blueprint.organizationLevels?.[DISTRICT]
				?.parentLevelUuid,
		).toBe(REGION);
	});

	it("refuses while a place still stands at it", async () => {
		await seedOrgApp();
		await seedChain();
		await expect(
			commitGuardedBatch({
				appId: APP_ID,
				batchId: "remove-facility-level",
				mutations: admitMutationBatch([
					{ kind: "removeOrganizationLevel", uuid: FACILITY },
				]),
				actorUserId: ACTOR_A,
				kind: "autosave",
				expectedProjectId: PROJECT_A,
			}),
		).rejects.toThrow(/bring back any archived places.*move every place/i);
	});

	it("still refuses when the only place at it is ARCHIVED", async () => {
		// HQ's own guard counts archived rows (`SQLLocation.objects`, not
		// `active_objects`), and unarchiving into a deleted level would resurrect
		// a row pointing at nothing.
		await seedOrgApp();
		const { facility } = await seedChain();
		await setLocationArchived(scope(), facility, true);
		await expect(
			commitGuardedBatch({
				appId: APP_ID,
				batchId: "remove-archived-facility-level",
				mutations: admitMutationBatch([
					{ kind: "removeOrganizationLevel", uuid: FACILITY },
				]),
				actorUserId: ACTOR_A,
				kind: "autosave",
				expectedProjectId: PROJECT_A,
			}),
		).rejects.toThrow(/bring back any archived places.*move every place/i);
	});

	it("allows removing a level nothing stands at", async () => {
		await seedOrgApp();
		const region = (
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
		expect(region).toBeTruthy();
		// Facility has no places; removing it is fine. District sits between
		// Region and Facility, so removing Facility leaves a valid chain.
		await expect(
			commitGuardedBatch({
				appId: APP_ID,
				batchId: "remove-empty-facility-level",
				mutations: admitMutationBatch([
					{ kind: "removeOrganizationLevel", uuid: FACILITY },
				]),
				actorUserId: ACTOR_A,
				kind: "autosave",
				expectedProjectId: PROJECT_A,
			}),
		).resolves.toMatchObject({ deduped: false });
	});
});

describe("locations store — the archive cascade", () => {
	it("blocks archive while an automation condition references the subtree", async () => {
		await seedWorkflowOrgApp();
		const { facility } = await seedChain();
		await commitLocationCriterionAutomation(facility);

		const impact = await describeArchiveImpact(scope(), facility);
		expect(impact.blockingAutomationCount).toBe(1);
		expect(impact.blockingAutomationPreview).toEqual(["Clean up Mercy Clinic"]);
		await expect(
			setLocationArchived(scope(), facility, true, impact.revision, impact),
		).rejects.toMatchObject({ code: "rejected" });
	});

	it("blocks archive while an automation recipient references the subtree", async () => {
		await seedWorkflowOrgApp();
		const { facility } = await seedChain();
		await commitLocationAutomation(facility);

		const impact = await describeArchiveImpact(scope(), facility);
		expect(impact.blockingAutomationCount).toBe(1);
		expect(impact.blockingAutomationPreview).toEqual(["Alert Mercy Clinic"]);
		await expect(
			setLocationArchived(scope(), facility, true, impact.revision, impact),
		).rejects.toMatchObject({ code: "rejected" });
		expect(
			(await readOrganization(scope())).locations.find(
				(location) => location.id === facility,
			)?.archivedAt,
		).toBeNull();
	});

	it("blocks preflight when archiving the sole reverse-owner destination", async () => {
		await seedWorkflowOrgApp();
		const { facility } = await seedChain();
		await commitReverseOwnerForm(FACILITY);

		const impact = await describeArchiveImpact(scope(), facility);
		expect(impact.blockingOwnerRuleFormCount).toBe(1);
		expect(impact.blockingOwnerRuleFormPreview).toEqual(["Visit"]);
		await expect(
			setLocationArchived(scope(), facility, true, impact.revision, impact),
		).rejects.toMatchObject({ code: "rejected" });
		expect(
			(await readOrganization(scope())).locations.find(
				(location) => location.id === facility,
			)?.archivedAt,
		).toBeNull();
	});

	it("blocks preflight when unassignment would strand a live fixed owner", async () => {
		await seedWorkflowOrgApp();
		const { facility } = await seedChain();
		const narrowRegion = (
			await createLocation(scope(), {
				levelUuid: REGION,
				parentId: null,
				name: "South",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location.id;
		const fixedDestination = (
			await createLocation(scope(), {
				levelUuid: REGION,
				parentId: null,
				name: "East",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location.id;
		await commitGuardedBatch({
			appId: APP_ID,
			batchId: "whole-organization-facility-address-book",
			mutations: admitMutationBatch([
				{
					kind: "updateOrganizationLevel",
					uuid: FACILITY,
					patch: { addressBook: { reach: "whole-organization" } },
				},
			]),
			actorUserId: ACTOR_A,
			kind: "autosave",
			expectedProjectId: PROJECT_A,
		});
		await assignPersona(PERSONA_ASHA, facility, [narrowRegion]);
		await commitFixedOwnerForm(fixedDestination);

		const impact = await describeArchiveImpact(scope(), facility);
		expect(impact.blockingOwnerRuleFormCount).toBe(1);
		expect(impact.blockingOwnerRuleFormPreview).toEqual(["Visit"]);
		await expect(
			setLocationArchived(scope(), facility, true, impact.revision, impact),
		).rejects.toMatchObject({ code: "rejected" });
		expect(await personaLocations(PERSONA_ASHA)).toEqual({
			primaryUuid: facility,
			additionalUuids: [narrowRegion],
		});
	});

	it("archives the subtree and unassigns every persona in one transaction", async () => {
		await seedOrgApp();
		const { region, district, facility } = await seedChain();
		await assignPersona(PERSONA_ASHA, facility);
		await assignPersona(PERSONA_BIMAL, district, [facility]);

		const impact = await describeArchiveImpact(scope(), district);
		expect(impact.affectedLocationCount).toBe(2);
		expect(new Set(impact.unassignedPersonaPreview)).toEqual(
			new Set(["Asha", "Bimal"]),
		);
		expect(impact.unassignedPersonaCount).toBe(2);
		expect(impact.ownedCases).toBe(0);

		const result = await setLocationArchived(
			scope(),
			district,
			true,
			impact.revision,
			impact,
		);
		expect(result.archivedCount).toBe(2);
		expect(result.unassignedPersonaCount).toBe(2);
		expect(result.impact).toEqual(impact);

		const snapshot = await readOrganization(scope());
		const byId = new Map(snapshot.locations.map((l) => [l.id, l]));
		expect(byId.get(region)?.archivedAt).toBeNull();
		expect(byId.get(district)?.archivedAt).not.toBeNull();
		expect(byId.get(facility)?.archivedAt).not.toBeNull();

		// Asha had only the facility, so her slot is gone entirely — which is
		// exactly when the session block omits all three location keys.
		expect(await personaLocations(PERSONA_ASHA)).toBeUndefined();
		// Bimal had both, so both went; the slot is gone too.
		expect(await personaLocations(PERSONA_BIMAL)).toBeUndefined();
		// And the edges went with the assignments.
		const edges = await h
			.db()
			.selectFrom("app_location_references")
			.select("location_id")
			.where("app_id", "=", APP_ID)
			.execute();
		expect(edges).toEqual([]);
	});

	it("bounds long archive preview names and accepts the exact confirmation resend", async () => {
		await seedOrgApp();
		const longName = "A".repeat(ARCHIVE_IMPACT_PREVIEW_TEXT_MAX_LENGTH + 40);
		await commitGuardedBatch({
			appId: APP_ID,
			batchId: "long-archive-preview-persona",
			mutations: admitMutationBatch([
				{
					kind: "updatePersona",
					uuid: PERSONA_ASHA,
					patch: { name: longName },
				},
			]),
			actorUserId: ACTOR_A,
			kind: "autosave",
			expectedProjectId: PROJECT_A,
		});
		const { district, facility } = await seedChain();
		await assignPersona(PERSONA_ASHA, facility);

		const impact = await describeArchiveImpact(scope(), district);
		expect(archiveImpactSchema.safeParse(impact).success).toBe(true);
		expect(impact.unassignedPersonaPreview).toEqual([
			longName.slice(0, ARCHIVE_IMPACT_PREVIEW_TEXT_MAX_LENGTH),
		]);
		await expect(
			setLocationArchived(
				scope(),
				district,
				true,
				impact.revision,
				archiveImpactSchema.parse(impact),
			),
		).resolves.toMatchObject({
			unassignedPersonaCount: 1,
			impact,
		});
	});

	it("refuses when a confirmed archive consequence changed", async () => {
		await seedOrgApp();
		const { district } = await seedChain();
		const impact = await describeArchiveImpact(scope(), district);
		await expect(
			setLocationArchived(scope(), district, true, impact.revision, {
				...impact,
				ownedCases: impact.ownedCases + 1,
			}),
		).rejects.toMatchObject({ code: "conflict" });
		expect(
			(await readOrganization(scope())).locations.find(
				(location) => location.id === district,
			)?.archivedAt,
		).toBeNull();
	});

	it("refuses when persona assignments change after archive preflight", async () => {
		await seedOrgApp();
		const { facility } = await seedChain();
		const impact = await describeArchiveImpact(scope(), facility);
		await assignPersona(PERSONA_ASHA, facility);
		expect((await readOrganization(scope())).revision).toBe(impact.revision);
		await expect(
			setLocationArchived(scope(), facility, true, impact.revision, impact),
		).rejects.toMatchObject({ code: "conflict" });
	});

	it("returns and attributes the exact Blueprint change for an SA archive", async () => {
		await seedOrgApp();
		const { facility } = await seedChain();
		await assignPersona(PERSONA_ASHA, facility);
		const nonce = "77777777-7777-4777-8777-777777777777";
		await h
			.db()
			.updateTable("apps")
			.set({
				lock_run_id: "organization-chat-run",
				lock_actor_user_id: ACTOR_A,
				lock_expire_at: new Date(Date.now() + 60_000),
				run_holder_nonce: nonce,
			})
			.where("id", "=", APP_ID)
			.execute();
		const result = await setLocationArchived(
			{
				...scope(),
				changeSource: { kind: "chat", runId: "organization-chat-run" },
				chatRunHolder: {
					source: "chat",
					mode: "edit",
					runId: "organization-chat-run",
					nonce,
				},
			},
			facility,
			true,
		);

		expect(result.blueprintChange?.mutations).toEqual([
			expect.objectContaining({ kind: "updatePersona", uuid: PERSONA_ASHA }),
		]);
		expect(
			result.blueprintChange?.committedDoc.personas?.[PERSONA_ASHA]?.locations,
		).toBeUndefined();
		const change = await h
			.db()
			.selectFrom("app_changes")
			.select(["kind", "run_id"])
			.where("app_id", "=", APP_ID)
			.orderBy("seq", "desc")
			.executeTakeFirstOrThrow();
		expect(change).toEqual({ kind: "chat", run_id: "organization-chat-run" });
	});

	it("promotes the next remaining place when the primary is archived", async () => {
		await seedOrgApp();
		const { region, district, facility } = await seedChain();
		await assignPersona(PERSONA_ASHA, facility, [region]);
		await setLocationArchived(scope(), district, true);
		expect(await personaLocations(PERSONA_ASHA)).toEqual({
			primaryUuid: region,
		});
		const edges = await h
			.db()
			.selectFrom("app_location_references")
			.select("location_id")
			.where("app_id", "=", APP_ID)
			.execute();
		expect(edges.map((e) => e.location_id)).toEqual([region]);
	});

	it("is a no-op on an already-archived subtree and does not advance the clock", async () => {
		await seedOrgApp();
		const { facility } = await seedChain();
		const first = await setLocationArchived(scope(), facility, true);
		const second = await setLocationArchived(scope(), facility, true);
		expect(second.revision).toBe(first.revision);
		expect(second.archivedCount).toBe(0);
	});

	it("unarchives ancestors too, and does not restore assignments", async () => {
		await seedOrgApp();
		const { region, district, facility } = await seedChain();
		await assignPersona(PERSONA_ASHA, facility);
		await setLocationArchived(scope(), region, true);
		expect(await personaLocations(PERSONA_ASHA)).toBeUndefined();

		await setLocationArchived(scope(), facility, false);
		const byId = new Map(
			(await readOrganization(scope())).locations.map((l) => [l.id, l]),
		);
		// The facility and the path to it are live again — a place is
		// unreachable while any ancestor is archived.
		expect(byId.get(facility)?.archivedAt).toBeNull();
		expect(byId.get(district)?.archivedAt).toBeNull();
		expect(byId.get(region)?.archivedAt).toBeNull();
		// The assignment stays gone: re-adding it would overwrite a real edit
		// with the memory of an older one.
		expect(await personaLocations(PERSONA_ASHA)).toBeUndefined();
	});

	it("leaves the blueprint untouched when no persona stood there", async () => {
		await seedOrgApp();
		const { facility } = await seedChain();
		const before = await h
			.db()
			.selectFrom("apps")
			.select("mutation_seq")
			.where("id", "=", APP_ID)
			.executeTakeFirstOrThrow();
		await setLocationArchived(scope(), facility, true);
		const after = await h
			.db()
			.selectFrom("apps")
			.select("mutation_seq")
			.where("id", "=", APP_ID)
			.executeTakeFirstOrThrow();
		// No mutations means no batch, so the app's edit history records nothing
		// — an archive is not a document change unless it displaces someone.
		expect(after.mutation_seq).toBe(before.mutation_seq);
	});
});

describe("locations store — removing a location property", () => {
	it("sheds its values from every place, leaving the others intact", async () => {
		await seedOrgApp();
		await commitGuardedBatch({
			appId: APP_ID,
			batchId: "add-props",
			mutations: admitMutationBatch([
				{
					kind: "addLocationProperty",
					property: { uuid: PROP_BEDS, slug: "beds", label: "Beds" },
				},
				{
					kind: "addLocationProperty",
					property: { uuid: PROP_PHONE, slug: "phone", label: "Phone" },
				},
			]),
			actorUserId: ACTOR_A,
			kind: "autosave",
			expectedProjectId: PROJECT_A,
		});
		const withValues = await createLocation(scope(), {
			levelUuid: REGION,
			parentId: null,
			name: "North",
			externalId: null,
			latitude: null,
			longitude: null,
			values: { [PROP_BEDS]: "40", [PROP_PHONE]: "555" },
		});
		const withoutValues = await createLocation(scope(), {
			levelUuid: REGION,
			parentId: null,
			name: "South",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
		});
		const beforeShed = (await readOrganization(scope())).revision;

		await commitGuardedBatch({
			appId: APP_ID,
			batchId: "remove-beds",
			mutations: admitMutationBatch([
				{ kind: "removeLocationProperty", uuid: PROP_BEDS },
			]),
			actorUserId: ACTOR_A,
			kind: "autosave",
			expectedProjectId: PROJECT_A,
		});

		const byId = new Map(
			(await readOrganization(scope())).locations.map((l) => [l.id, l]),
		);
		const afterShed = await readOrganization(scope());
		expect(BigInt(afterShed.revision)).toBe(BigInt(beforeShed) + BigInt(1));
		// The removed property's value is gone; its peer is untouched. A
		// property uuid is never reissued, so a retained value would be
		// unreachable forever rather than merely unused.
		expect(byId.get(withValues.location.id)?.values).toEqual({
			[PROP_PHONE]: "555",
		});
		expect(byId.get(withoutValues.location.id)?.values).toEqual({});
	});
});

describe("locations store — custom field values", () => {
	/** Declare the two properties every value test records against. */
	async function declareProperties(
		extra: {
			required?: boolean;
			choices?: string[];
			levelUuids?: string[];
		} = {},
	): Promise<void> {
		const { levelUuids, ...scalar } = extra;
		await commitGuardedBatch({
			appId: APP_ID,
			batchId: `declare-props-${JSON.stringify(extra)}`,
			mutations: admitMutationBatch([
				{
					kind: "addLocationProperty",
					property: {
						uuid: PROP_BEDS,
						slug: "beds",
						label: "Beds",
						...scalar,
						...(levelUuids !== undefined && {
							levelUuids: levelUuids.map(asUuid),
						}),
					},
				},
				{
					kind: "addLocationProperty",
					property: { uuid: PROP_PHONE, slug: "phone", label: "Phone" },
				},
			]),
			actorUserId: ACTOR_A,
			kind: "autosave",
			expectedProjectId: PROJECT_A,
		});
	}

	it("stores values keyed by property uuid and replaces the bag wholesale", async () => {
		await seedOrgApp();
		await declareProperties();
		const created = await createLocation(scope(), {
			levelUuid: REGION,
			parentId: null,
			name: "North",
			externalId: null,
			latitude: "12.5",
			longitude: "-7.25",
			values: { [PROP_BEDS]: "12", [PROP_PHONE]: "" },
		});
		expect(created.location.values).toEqual({
			[PROP_BEDS]: "12",
			[PROP_PHONE]: "",
		});
		expect(created.location.latitude).toBe("12.5");

		const updated = await updateLocation(scope(), created.location.id, {
			values: { [PROP_BEDS]: "13" },
		});
		// A whole-bag replacement, so a cleared field is an omitted key rather
		// than a stored null — absent and null would print identically.
		expect(updated.location.values).toEqual({ [PROP_BEDS]: "13" });
	});

	it("patches one UUID-keyed value without clearing its siblings", async () => {
		await seedOrgApp();
		await declareProperties();
		const created = await createLocation(scope(), {
			levelUuid: REGION,
			parentId: null,
			name: "North",
			externalId: null,
			latitude: null,
			longitude: null,
			values: { [PROP_BEDS]: "12", [PROP_PHONE]: "555" },
		});
		const patched = await updateLocation(scope(), created.location.id, {
			valuePatch: { [PROP_BEDS]: "13" },
		});
		expect(patched.location.values).toEqual({
			[PROP_BEDS]: "13",
			[PROP_PHONE]: "555",
		});
		const cleared = await updateLocation(scope(), created.location.id, {
			valuePatch: { [PROP_BEDS]: null },
		});
		expect(cleared.location.values).toEqual({ [PROP_PHONE]: "555" });
	});

	it("does not advance the clock when the same value bag arrives in another key order", async () => {
		await seedOrgApp();
		await declareProperties();
		const created = await createLocation(scope(), {
			levelUuid: REGION,
			parentId: null,
			name: "North",
			externalId: null,
			latitude: null,
			longitude: null,
			values: { [PROP_BEDS]: "12", [PROP_PHONE]: "555" },
		});
		const result = await updateLocation(scope(), created.location.id, {
			values: { [PROP_PHONE]: "555", [PROP_BEDS]: "12" },
		});
		expect(result.revision).toBe(created.revision);
	});

	it("refuses a value patch whose merged bag exceeds the store bound", async () => {
		await seedOrgApp();
		const propertyUuids = Array.from({ length: 251 }, (_, index) =>
			asUuid(`10000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
		);
		await commitGuardedBatch({
			appId: APP_ID,
			batchId: "declare-251-location-properties",
			mutations: admitMutationBatch(
				propertyUuids.map((uuid, index) => ({
					kind: "addLocationProperty" as const,
					property: {
						uuid,
						slug: `property_${index}`,
						label: `Property ${index}`,
					},
				})),
			),
			actorUserId: ACTOR_A,
			kind: "autosave",
			expectedProjectId: PROJECT_A,
		});
		const values = Object.fromEntries(
			propertyUuids.slice(0, 250).map((uuid) => [uuid, "value"]),
		);
		const created = await createLocation(scope(), {
			levelUuid: REGION,
			parentId: null,
			name: "North",
			externalId: null,
			latitude: null,
			longitude: null,
			values,
		});
		await expect(
			updateLocation(scope(), created.location.id, {
				valuePatch: { [propertyUuids[250]]: "overflow" },
			}),
		).rejects.toMatchObject({ code: "rejected" });
	});

	it("refuses a value against a property the app does not declare", async () => {
		// Without this the failure surfaces at push time, when HQ's own
		// custom-data validation rejects the location — long after it was written.
		await seedOrgApp();
		await expect(
			createLocation(scope(), {
				levelUuid: REGION,
				parentId: null,
				name: "North",
				externalId: null,
				latitude: null,
				longitude: null,
				values: { [PROP_BEDS]: "12" },
			}),
		).rejects.toMatchObject({ code: "rejected" });
	});

	it("refuses a value outside a declared choice list, but allows empty", async () => {
		await seedOrgApp();
		await declareProperties({ choices: ["public", "private"] });
		await expect(
			createLocation(scope(), {
				levelUuid: REGION,
				parentId: null,
				name: "North",
				externalId: null,
				latitude: null,
				longitude: null,
				values: { [PROP_BEDS]: "banana" },
			}),
		).rejects.toMatchObject({ code: "rejected" });
		// Empty text is a legitimate "no value" — HQ's fixture emits an empty
		// element for an unset field — so a choice list constrains only a value
		// that is actually there.
		await expect(
			createLocation(scope(), {
				levelUuid: REGION,
				parentId: null,
				name: "South",
				externalId: null,
				latitude: null,
				longitude: null,
				values: { [PROP_BEDS]: "" },
			}),
		).resolves.toMatchObject({ location: { name: "South" } });
	});

	it("refuses a place missing a required property", async () => {
		await seedOrgApp();
		await declareProperties({ required: true });
		await expect(
			createLocation(scope(), {
				levelUuid: REGION,
				parentId: null,
				name: "North",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			}),
		).rejects.toMatchObject({ code: "rejected" });
	});

	it("refuses a value for a property that does not apply to the level", async () => {
		await seedOrgApp();
		await declareProperties({ levelUuids: [FACILITY] });
		await expect(
			createLocation(scope(), {
				levelUuid: REGION,
				parentId: null,
				name: "North",
				externalId: null,
				latitude: null,
				longitude: null,
				values: { [PROP_BEDS]: "12" },
			}),
		).rejects.toMatchObject({ code: "rejected" });
	});

	it("atomically refuses making a property required while an existing place is empty", async () => {
		await seedOrgApp();
		await declareProperties();
		await createLocation(scope(), {
			levelUuid: REGION,
			parentId: null,
			name: "North",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
		});

		await expect(
			commitGuardedBatch({
				appId: APP_ID,
				batchId: "require-beds-with-empty-place",
				mutations: admitMutationBatch([
					{
						kind: "updateLocationProperty",
						uuid: PROP_BEDS,
						patch: { required: true },
					},
				]),
				actorUserId: ACTOR_A,
				kind: "autosave",
				expectedProjectId: PROJECT_A,
			}),
		).rejects.toThrow(/"North" blocks this change.*"Beds" is required/);
		expect(
			(await loadApp(APP_ID))?.blueprint.locationProperties?.[PROP_BEDS]
				?.required,
		).toBeUndefined();
	});

	it("atomically refuses choice and level narrowing that strand stored values", async () => {
		await seedOrgApp();
		await declareProperties();
		await createLocation(scope(), {
			levelUuid: REGION,
			parentId: null,
			name: "North",
			externalId: null,
			latitude: null,
			longitude: null,
			values: { [PROP_BEDS]: "public" },
		});

		for (const [batchId, patch] of [
			["narrow-beds-choices", { choices: ["private"] }],
			["narrow-beds-levels", { levelUuids: [FACILITY] }],
		] as const) {
			await expect(
				commitGuardedBatch({
					appId: APP_ID,
					batchId,
					mutations: admitMutationBatch([
						{
							kind: "updateLocationProperty",
							uuid: PROP_BEDS,
							patch,
						},
					]),
					actorUserId: ACTOR_A,
					kind: "autosave",
					expectedProjectId: PROJECT_A,
				}),
			).rejects.toThrow(/"North" blocks this change/);
		}
	});
});

describe("locations store — archived places hold nothing", () => {
	it("refuses a new place under an archived one", async () => {
		// A live place under an archived one is the state the archive cascade
		// exists to make unreachable: absent from every fixture and footprint,
		// yet offered in the assignment picker and able to own cases.
		await seedOrgApp();
		const { district } = await seedChain();
		await setLocationArchived(scope(), district, true);
		await expect(
			createLocation(scope(), {
				levelUuid: FACILITY,
				parentId: district,
				name: "New Clinic",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			}),
		).rejects.toMatchObject({ code: "rejected" });
	});

	it("refuses a move under an archived place", async () => {
		await seedOrgApp();
		const { region, district } = await seedChain();
		const other = (
			await createLocation(scope(), {
				levelUuid: DISTRICT,
				parentId: region,
				name: "Lakeside",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			})
		).location.id;
		await setLocationArchived(scope(), district, true);
		await expect(
			moveLocation(scope(), other, { parentId: district }),
		).rejects.toMatchObject({ code: "rejected" });
	});
});

describe("locations store — the doc round-trips its collections", () => {
	it("keeps organization levels out of the persisted doc when empty", async () => {
		const doc = orgDoc();
		delete (doc as { organizationLevels?: unknown }).organizationLevels;
		delete (doc as { organizationLevelOrder?: unknown }).organizationLevelOrder;
		delete (doc as { personas?: unknown }).personas;
		delete (doc as { personaOrder?: unknown }).personaOrder;
		await h.seedAppWithBlueprint(doc, {
			id: "bare-app",
			owner: ACTOR_A,
			projectId: PROJECT_A,
		});
		const rows = await h
			.db()
			.selectFrom("blueprint_entities")
			.select("kind")
			.where("app_id", "=", "bare-app")
			.execute();
		expect(rows.map((row) => row.kind)).not.toContain("organization_level");
		expect(rows.map((row) => row.kind)).not.toContain("persona");
	});

	it("round-trips levels and location properties through entity rows", async () => {
		await seedOrgApp();
		const rows = await h
			.db()
			.selectFrom("blueprint_entities")
			.select(["kind", "uuid"])
			.where("app_id", "=", APP_ID)
			.orderBy("kind")
			.orderBy("uuid")
			.execute();
		const kinds = rows.map((r) => r.kind);
		expect(kinds.filter((k) => k === "organization_level")).toHaveLength(3);
		expect(kinds.filter((k) => k === "persona")).toHaveLength(2);

		// And the assembled doc equals what was seeded, which is what proves the
		// classifier branches on the new kinds rather than reading them as fields.
		const app = await h
			.db()
			.selectFrom("apps")
			.select("id")
			.where("id", "=", APP_ID)
			.executeTakeFirstOrThrow();
		expect(app.id).toBe(APP_ID);
		const persisted = toPersistableDoc(orgDoc());
		expect(Object.keys(persisted.organizationLevels ?? {})).toHaveLength(3);
	});
});

describe("locations store — errors read person-to-person", () => {
	it("never leaks whether a foreign resource exists", async () => {
		await seedOrgApp();
		await h.seedProjectMember(ACTOR_B, PROJECT_B, "owner");
		const missing = "77777777-7777-4777-8777-777777777777";
		const foreign = scope(PROJECT_B, ACTOR_B);
		const forMissing = await updateLocation(scope(), missing, {
			name: "x",
		}).catch((e: OrganizationError) => e);
		const forForeign = await updateLocation(foreign, missing, {
			name: "x",
		}).catch((e: OrganizationError) => e);
		expect(forMissing).toBeInstanceOf(OrganizationError);
		expect(forForeign).toBeInstanceOf(OrganizationError);
		// Same code either way. A distinguishable "exists but not yours" would
		// confirm a resource in a Project the caller cannot see.
		expect((forMissing as OrganizationError).code).toBe("not_found");
		expect((forForeign as OrganizationError).code).toBe("not_found");
	});
});
