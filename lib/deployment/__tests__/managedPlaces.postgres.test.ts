/**
 * Places CommCare HQ manages for an app, through a publish and through
 * provisioning a worker, over real Postgres and a peer standing in for
 * CommCare HQ: never pushed to the project space that manages them, planned
 * from Nova's copy for any other, and a persona standing in one stands in
 * CommCare HQ's own place.
 *
 * The place answers are written here in the shapes
 * `lib/commcare/hq/locations.ts` reads; every app source is CommCare HQ's
 * own answer, retained by the proof lane.
 */

import type { MockAgent } from "undici";
import { beforeEach, expect, it, vi } from "vitest";
import {
	readHttpRequestBody,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { decrypt } from "@/lib/commcare/encryption";
import type { HqLocation } from "@/lib/commcare/hq/locations";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { commitGuardedBatch } from "@/lib/db/apps";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc } from "@/lib/domain";
import { eq, term } from "@/lib/domain/expression";
import type { Expression } from "@/lib/domain/expression/types";
import { writeManagedPlacesInTransaction } from "@/lib/organization/managed";
import { readOrganization } from "@/lib/organization/service";
import { managedPlacesPassed } from "@/lib/publish/managedData";
import { PLAN_FEATURE_IDS } from "@/lib/publish/planFeatures";
import { publishConfirmationNeeds } from "../preflight";
import { planManagedPlaces } from "../reading/projectData/places";
import { type PublishOutcome, publishAppToHq } from "../service";
import type { DeploymentConfirmationKey } from "../types";
import { provisionWorkers } from "../workers";
import {
	acceptImport,
	connect,
	HOST,
	publishRequests,
	serveSource,
} from "./managedFixtures";
import { reloadHeadFor } from "./publishFixtures";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
});

const h = setupAppStateTestDb("managed_places_", { authSchema: "migrated" });
const APP = "places-app";
const PROJECT = "program";
const ACTOR = "editor";
const REGION = testUuid("managed-region");
const AMINA = testUuid("managed-amina");
const MANAGING = { server: "india", domain: "clinic" } as const;
const OTHER = { server: "india", domain: "district" } as const;
const SCOPE = {
	appId: APP,
	projectId: PROJECT,
	actorUserId: ACTOR,
	role: "editor",
};

/** CommCare HQ's one place in the project space that manages it. */
const north: HqLocation = {
	locationId: "hq-north",
	name: "North",
	siteCode: "north",
	locationTypeCode: "region",
	parentLocationId: null,
	latitude: null,
	longitude: null,
	values: {},
};

const CONFIRM_ALL: readonly DeploymentConfirmationKey[] = [
	...PLAN_FEATURE_IDS.map((subject) => ({
		kind: "plan-feature" as const,
		subject,
	})),
	{ kind: "flat-location-fixture" },
	{ kind: "connect-forwarder" },
	{ kind: "form-entry-sync-off" },
];

function document(): BlueprintDoc {
	return {
		...buildDoc({
			appName: "Places",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [{ id: "note", kind: "text" }],
						},
					],
				},
			],
		}),
		organizationLevels: {
			[REGION]: {
				uuid: REGION,
				code: "region",
				name: "Region",
				caseFlow: {
					workers: "assigned",
					ownsCases: true,
					descendantCases: { kind: "none" },
				},
				addressBook: { reach: "own-branch" },
			},
		},
		organizationLevelOrder: [REGION],
		personas: { [AMINA]: { uuid: AMINA, name: "Amina" } },
		personaOrder: [AMINA],
	};
}

/** The app, with Nova's copy of CommCare HQ's places, as a bring-in writes it. */
async function seed(): Promise<BlueprintDoc> {
	const doc = document();
	await h.seedAppWithBlueprint(doc, {
		id: APP,
		owner: ACTOR,
		projectId: PROJECT,
	});
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await connect(h, ACTOR, "india", [MANAGING.domain, OTHER.domain]);
	const plan = planManagedPlaces({
		hqPlaces: [north],
		levels: [doc.organizationLevels?.[REGION] ?? fail()],
		properties: [],
		mode: "birth",
	});
	await h.withTransaction((tx) =>
		writeManagedPlacesInTransaction(tx, {
			appId: APP,
			actorUserId: ACTOR,
			origin: MANAGING,
			plan,
			at: new Date("2026-11-01T09:00:00.000Z"),
		}),
	);
	return doc;
}

function fail(): never {
	throw new Error("The document holds no Region level.");
}

function publish(
	doc: BlueprintDoc,
	target: { readonly server: "india"; readonly domain: string },
): Promise<PublishOutcome> {
	return publishAppToHq({
		scope: SCOPE,
		...target,
		doc,
		compiledAtSeq: 0,
		reloadHead: reloadHeadFor(APP, ACTOR),
		appName: doc.appName,
		confirm: CONFIRM_ALL,
	});
}

function request(peer: MockAgent, path: string, method = "GET") {
	return peer.get(HOST).intercept({
		path,
		method,
		headers: { authorization: "ApiKey account:fixture-key" },
	});
}

const PUSH_REASON = "This publish sends the places in your organization.";

it("never pushes places to the project space that manages them, and refreshes the copy instead", async () => {
	const doc = await seed();
	const needs = await publishConfirmationNeeds(
		SCOPE,
		doc,
		MANAGING,
		undefined,
		new Set(),
	);
	expect(needs.places).toEqual([]);
	expect(needs.placesManagedHere).toBe(true);
	expect(
		needs.needed.flatMap((need) => need.reasons).includes(PUSH_REASON),
	).toBe(false);

	const places = "/a/clinic/api/location/v2/?limit=1000";
	await withHttpPeer(async (peer) => {
		request(peer, places).reply(200, {
			meta: { next: null },
			objects: [
				{
					location_id: north.locationId,
					name: "North (renamed in HQ)",
					site_code: north.siteCode,
					location_type_code: "region",
					parent_location_id: "",
					latitude: null,
					longitude: null,
					location_data: {},
				},
			],
		});
		acceptImport(peer, "clinic", 201);
		serveSource(peer, "clinic", "source-shell");
		acceptImport(peer, "clinic", 200);
		serveSource(peer, "clinic", "source-after-create-then-update");
		const outcome = await publish(doc, MANAGING);
		expect(outcome.landed, JSON.stringify(outcome)).toBe(true);
		expect(
			outcome.checks.find((check) => check.id === "organization"),
		).toMatchObject({
			status: "passed",
			detail: managedPlacesPassed("clinic", true),
			items: [],
		});
		expect(publishRequests(peer)).toEqual([
			`GET ${places}`,
			"POST /a/clinic/apps/api/import_app/",
			"GET /a/clinic/apps/source/working-app/",
			"POST /a/clinic/apps/api/import_app/",
			"GET /a/clinic/apps/source/working-app/",
		]);
	});
	const organization = await readOrganization(SCOPE);
	expect(organization.locations.map((place) => place.name)).toEqual([
		"North (renamed in HQ)",
	]);
	const mappings = await h
		.db()
		.selectFrom("app_deployment_resources")
		.select("kind")
		.where("kind", "=", "location")
		.execute();
	expect(mappings).toEqual([]);
});

it("still asks the organization plan feature and the flat list where the app's own logic reads the places it does not push", async () => {
	await seed();
	const visit = document();
	/* `instance('locations')/locations/location[@type = 'region']/name` */
	const regionName: Expression = {
		kind: "project",
		of: {
			kind: "locations",
			where: [
				eq(
					term({ kind: "location-field", field: "type" }),
					term({ kind: "location-level", levelUuid: REGION }),
				),
			],
		},
		value: { kind: "location-field", field: "name" },
	};
	const reads: BlueprintDoc = {
		...buildDoc({
			appName: "Places",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								{ id: "note", kind: "text" },
								f({ kind: "hidden", id: "region", calculate: regionName }),
							],
						},
					],
				},
			],
		}),
		organizationLevels: visit.organizationLevels,
		organizationLevelOrder: visit.organizationLevelOrder,
		personas: visit.personas,
		personaOrder: visit.personaOrder,
	};
	const needs = await publishConfirmationNeeds(
		SCOPE,
		reads,
		MANAGING,
		undefined,
		new Set(),
	);
	expect(needs.places).toEqual([]);
	expect(needs.placesManagedHere).toBe(true);
	const organization = needs.needed.find(
		(need) => need.kind === "plan-feature" && need.subject === "organization",
	);
	expect(organization?.reasons).toEqual([
		"Visit reads places in your organization.",
	]);
	expect(
		needs.needed.find((need) => need.kind === "flat-location-fixture")?.reasons,
	).toEqual(["Visit reads places in your organization."]);
});

it("plans the copy for any other project space, as places Nova made there", async () => {
	const doc = await seed();
	const needs = await publishConfirmationNeeds(
		SCOPE,
		doc,
		OTHER,
		undefined,
		new Set(),
	);
	expect(needs.placesManagedHere).toBe(false);
	expect(needs.places.map((place) => place.siteCode)).toEqual(["north"]);
	expect(needs.needed.flatMap((need) => need.reasons)).toContain(PUSH_REASON);
});

it("stands a persona in the place CommCare HQ manages, by that place's id there", async () => {
	const doc = await seed();
	const [place] = (await readOrganization(SCOPE)).locations;
	if (place === undefined) throw new Error("The copy holds no place.");
	await commitGuardedBatch({
		appId: APP,
		batchId: crypto.randomUUID(),
		actorUserId: ACTOR,
		expectedProjectId: PROJECT,
		kind: "autosave",
		mutations: admitMutationBatch([
			{
				kind: "updatePersona",
				uuid: AMINA,
				patch: { locations: { primaryUuid: place.id } },
			},
		]),
	});
	// The app is on the project space that manages the places.
	await withHttpPeer(async (peer) => {
		request(peer, "/a/clinic/api/location/v2/?limit=1000").reply(200, {
			meta: { next: null },
			objects: [
				{
					location_id: north.locationId,
					name: north.name,
					site_code: north.siteCode,
					location_type_code: "region",
					parent_location_id: "",
					latitude: null,
					longitude: null,
					location_data: {},
				},
			],
		});
		acceptImport(peer, "clinic", 201);
		serveSource(peer, "clinic", "source-shell");
		acceptImport(peer, "clinic", 200);
		serveSource(peer, "clinic", "source-after-create-then-update");
		expect((await publish(doc, MANAGING)).landed).toBe(true);
	});
	const assigned: BlueprintDoc = {
		...doc,
		personas: {
			[AMINA]: {
				uuid: AMINA,
				name: "Amina",
				locations: { primaryUuid: place.id },
			},
		},
	};
	const sent: unknown[] = [];
	const outcome = await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({
				path: (path) => path.startsWith("/a/clinic/api/bulk-user/v1/"),
				method: "GET",
				headers: { authorization: "ApiKey account:fixture-key" },
			})
			.reply(200, JSON.stringify({ objects: [] }));
		request(peer, "/a/clinic/api/user/v1/", "POST").reply(201, {
			id: "hq-amina",
		});
		request(peer, "/a/clinic/api/user/v1/hq-amina/", "PUT").reply(
			async (req) => {
				sent.push(JSON.parse((await readHttpRequestBody(req)).toString()));
				return { statusCode: 200, data: '{"id":"hq-amina"}' };
			},
		);
		return provisionWorkers({
			scope: SCOPE,
			doc: assigned,
			...MANAGING,
			locations: (await readOrganization(SCOPE)).locations,
			workers: [{ personaUuid: AMINA, username: "amina" }],
		});
	});
	expect(outcome.refusal, JSON.stringify(outcome.refusal)).toBeNull();
	expect(sent).toEqual([
		{ locations: ["hq-north"], primary_location: "hq-north" },
	]);
});

it("refuses, before any account exists, a persona standing in a managed place CommCare HQ no longer has", async () => {
	const doc = await seed();
	const [place] = (await readOrganization(SCOPE)).locations;
	if (place === undefined) throw new Error("The copy holds no place.");
	await commitGuardedBatch({
		appId: APP,
		batchId: crypto.randomUUID(),
		actorUserId: ACTOR,
		expectedProjectId: PROJECT,
		kind: "autosave",
		mutations: admitMutationBatch([
			{
				kind: "updatePersona",
				uuid: AMINA,
				patch: { locations: { primaryUuid: place.id } },
			},
		]),
	});
	await withHttpPeer(async (peer) => {
		request(peer, "/a/clinic/api/location/v2/?limit=1000").reply(200, {
			meta: { next: null },
			objects: [
				{
					location_id: north.locationId,
					name: north.name,
					site_code: north.siteCode,
					location_type_code: "region",
					parent_location_id: "",
					latitude: null,
					longitude: null,
					location_data: {},
				},
			],
		});
		acceptImport(peer, "clinic", 201);
		serveSource(peer, "clinic", "source-shell");
		acceptImport(peer, "clinic", 200);
		serveSource(peer, "clinic", "source-after-create-then-update");
		expect((await publish(doc, MANAGING)).landed).toBe(true);
	});
	/* A refresh that finds the place gone from CommCare HQ keeps it live
	 * while Amina stands in it, marked gone and still holding its CommCare HQ
	 * id. */
	await h
		.db()
		.updateTable("app_locations")
		.set({ hq_gone_at: new Date("2026-11-05T08:00:00.000Z") })
		.where("id", "=", place.id)
		.execute();
	const assigned: BlueprintDoc = {
		...doc,
		personas: {
			[AMINA]: {
				uuid: AMINA,
				name: "Amina",
				locations: { primaryUuid: place.id },
			},
		},
	};
	const outcome = await withHttpPeer(async (peer) => {
		const result = await provisionWorkers({
			scope: SCOPE,
			doc: assigned,
			...MANAGING,
			locations: (await readOrganization(SCOPE)).locations,
			workers: [{ personaUuid: AMINA, username: "amina" }],
		});
		expect(publishRequests(peer)).toEqual([]);
		return result;
	});
	expect(outcome.refusal).toMatchObject({
		code: "workers_not_provisionable",
		details: [
			"Amina: stands in “North”, which CommCare HQ no longer has in this project space. You can stand them in another place, then provision them again.",
		],
	});
});
