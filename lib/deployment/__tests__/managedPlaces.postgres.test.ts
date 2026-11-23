import { publishFromSession as publishAppToHq } from "@/lib/deployment/__tests__/publishWithGrant";
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

import AdmZip from "adm-zip";
import { sql } from "kysely";
import type { MockAgent } from "undici";
import { beforeEach, expect, it, vi } from "vitest";
import { readHttpRequestBody } from "@/__tests__/helpers/httpPeer";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { decrypt } from "@/lib/commcare/encryption";
import { HQ_LOCATION_INVENTORY_MAX_ROWS } from "@/lib/commcare/hq/bounds";
import type { HqLocation } from "@/lib/commcare/hq/locations";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { commitGuardedBatch } from "@/lib/db/apps";
import { preparePlaceWorkbook } from "@/lib/deployment/placeWorkbook";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc } from "@/lib/domain";
import { eq, term } from "@/lib/domain/expression";
import type { Expression } from "@/lib/domain/expression/types";
import { exportRange } from "@/lib/export/artifacts/store";
import { writeManagedPlacesInTransaction } from "@/lib/organization/managed";
import { readOrganization } from "@/lib/organization/service";
import {
	managedPlacesPassed,
	managedPlacesPastInventory,
} from "@/lib/publish/managedData";
import { PLAN_FEATURE_IDS } from "@/lib/publish/planFeatures";
import { fetchExportPart, storeExportPart } from "@/lib/storage/media";
import { refreshManagedPlaces } from "../managedData";
import { publishConfirmationNeeds } from "../preflight";
import { planManagedPlaces } from "../reading/projectData/places";
import type { PublishOutcome } from "../service";
import { withdrawDeploymentConfirmation } from "../store";
import type { DeploymentConfirmationKey } from "../types";
import { provisionWorkers } from "../workers";
import {
	acceptImport,
	connect,
	HOST,
	hqSaves,
	publishRequests,
	serveSource,
	withManagedPeer,
} from "./managedFixtures";
import { regionLevel, servePlaceInventory } from "./placeInventoryPeer";
import { reloadHeadFor } from "./publishFixtures";

vi.mock("@/lib/storage/media", async (original) => ({
	...(await original<typeof import("@/lib/storage/media")>()),
	fetchExportPart: vi.fn(),
	storeExportPart: vi.fn(),
}));
vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
beforeEach(() => {
	hqSaves.reset();
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
	observation: { externalId: null, nameIsNull: false, wire: {}, worker: {} },
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
async function seed(source: HqLocation = north): Promise<BlueprintDoc> {
	const doc = document();
	await h.seedAppWithBlueprint(doc, {
		id: APP,
		owner: ACTOR,
		projectId: PROJECT,
	});
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await connect(h, ACTOR, "india", [MANAGING.domain, OTHER.domain, "coast"]);
	const plan = planManagedPlaces({
		hqPlaces: [source],
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
	requireHqImport: (() => void) | null = null,
): Promise<PublishOutcome> {
	return publishAppToHq({
		requireHqImport,
		scope: SCOPE,
		...target,
		doc,
		compiledAtSeq: 0,
		reloadHead: reloadHeadFor(APP, ACTOR),
		appName: doc.appName,
		confirm: CONFIRM_ALL,
	});
}

function serveManagedPlace(peer: MockAgent, name = north.name) {
	servePlaceInventory(peer, MANAGING.domain, [
		{
			location_id: north.locationId,
			name,
			site_code: north.siteCode,
			location_type_code: "region",
			parent_location_id: "",
			latitude: null,
			longitude: null,
			location_data: {},
		},
	]);
}

function request(peer: MockAgent, path: string, method = "GET") {
	return peer.get(HOST).intercept({
		path,
		method,
		headers: { authorization: "ApiKey account:fixture-key" },
	});
}

it("requires permission before publishing refreshes managed places", async () => {
	const doc = await seed();
	await withManagedPeer(async () => {
		await expect(
			publish(doc, MANAGING, () => {
				throw new Error("HQ Import required");
			}),
		).rejects.toThrow("HQ Import required");
	});
});

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

	const places = "/a/clinic/api/location/v2/?limit=5000";
	await withManagedPeer(async (peer) => {
		serveManagedPlace(peer, "North (renamed in HQ)");
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
			"GET /a/clinic/api/location_type/v1/?limit=1000",
			`GET ${places}`,
			"GET /a/clinic/api/location/v1/?limit=1000",
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

it("keeps the copy and says why where the managing project space lists more places than Nova reads", async () => {
	await seed();
	await withManagedPeer(async (peer) => {
		request(peer, "/a/clinic/api/location_type/v1/?limit=1000").reply(200, {
			meta: { next: null, total_count: 1 },
			objects: [regionLevel],
		});
		request(peer, "/a/clinic/api/location/v2/?limit=5000").reply(200, {
			meta: {
				next: `${HOST}/a/clinic/api/location/v2/?limit=5000&offset=5000`,
				offset: 0,
				total_count: HQ_LOCATION_INVENTORY_MAX_ROWS + 1,
			},
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
					domain: "clinic",
					last_modified: "2026-11-01T09:00:00",
				},
			],
		});
		expect(await refreshManagedPlaces(SCOPE)).toEqual({
			ok: false,
			reason: "over-limit",
			message: managedPlacesPastInventory(
				"clinic",
				HQ_LOCATION_INVENTORY_MAX_ROWS,
			),
		});
	});
	const organization = await readOrganization(SCOPE);
	expect(organization.locations.map((place) => place.name)).toEqual(["North"]);
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

it("asks before it stands a persona at a level of places CommCare HQ manages, then stands them in that place, by its id there, until the answer is withdrawn", async () => {
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
	await withManagedPeer(async (peer) => {
		serveManagedPlace(peer);
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
	const provision = (
		confirmWorkerLevels?: readonly string[],
		username = "amina",
	) =>
		provisionWorkers({
			scope: SCOPE,
			doc: assigned,
			...MANAGING,
			locations: [place],
			workers: [{ personaUuid: AMINA, username }],
			...(confirmWorkerLevels && { confirmWorkerLevels }),
		});
	const workerLevelRows = () =>
		h
			.db()
			.selectFrom("app_deployment_confirmations")
			.select(["kind", "subject", "withdrawn_at"])
			.where("kind", "=", "worker-level")
			.execute();

	// CommCare HQ's level API doesn't say whether Region takes workers: Nova
	// asks before CommCare HQ is asked anything, and records nothing.
	const asked = await withManagedPeer(async (peer) => {
		const result = await provision();
		expect(publishRequests(peer)).toEqual([]);
		return result;
	});
	expect(asked.refusal).toMatchObject({
		code: "worker_levels_unconfirmed",
		levels: [{ code: "region", name: "Region", personaNames: ["Amina"] }],
		details: ["Region (region): Amina"],
	});
	expect(asked.refusal?.message).toBe(
		"CommCare HQ doesn't tell Nova which levels take workers in “clinic”. Amina would stand at a place at the level Region. You can check Organization Levels in CommCare HQ, then confirm that level takes workers and provision again.",
	);
	expect(await workerLevelRows()).toEqual([]);
	// A confirmation of a level no worker here stands at answers nothing.
	const elsewhere = await withManagedPeer(async (peer) => {
		const result = await provision(["district"]);
		expect(publishRequests(peer)).toEqual([]);
		return result;
	});
	expect(elsewhere.refusal?.code).toBe("worker_levels_unconfirmed");
	expect(await workerLevelRows()).toEqual([]);

	// An unrelated problem refuses the whole call. Even a level the caller
	// sent must remain in the list to send again, since no answer was stored.
	const badUsername = await withManagedPeer(async (peer) => {
		const result = await provision(["region"], "bad username");
		expect(publishRequests(peer)).toEqual([]);
		return result;
	});
	expect(badUsername.refusal).toMatchObject({
		code: "workers_not_provisionable",
		levels: asked.refusal?.levels,
	});
	expect(await workerLevelRows()).toEqual([]);

	const sent: unknown[] = [];
	const outcome = await withManagedPeer(async (peer) => {
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
		return provision(["region"]);
	});
	expect(outcome.refusal, JSON.stringify(outcome.refusal)).toBeNull();
	expect(sent).toEqual([
		{ locations: ["hq-north"], primary_location: "hq-north" },
	]);
	expect(await workerLevelRows()).toEqual([
		{ kind: "worker-level", subject: "region", withdrawn_at: null },
	]);
	expect(
		outcome.deployment?.confirmations.find(
			(confirmation) => confirmation.kind === "worker-level",
		),
	).toMatchObject({ subject: "region" });

	// Withdrawn, the next call asks again before CommCare HQ is asked anything.
	await withdrawDeploymentConfirmation(SCOPE, MANAGING, {
		kind: "worker-level",
		subject: "region",
	});
	const again = await withManagedPeer(async (peer) => {
		const result = await provision();
		expect(publishRequests(peer)).toEqual([]);
		return result;
	});
	expect(again.refusal?.code).toBe("worker_levels_unconfirmed");
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
	await withManagedPeer(async (peer) => {
		serveManagedPlace(peer);
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
	const outcome = await withManagedPeer(async (peer) => {
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

it("stages the external ID against each new destination's own durable ID before sending app content", async () => {
	const source: HqLocation = {
		...north,
		values: { visits: 12 },
		observation: {
			nameIsNull: false,
			externalId: "N-45",
			wire: { visits: "12" },
			worker: { visits: "12" },
		},
	};
	const doc = await seed(source);
	const actor = {
		userId: ACTOR,
		grant: { kind: "session", sessionId: "place-export-session" },
	} as const;
	await sql`INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES
		(${actor.grant.sessionId},'synthetic-place-export',${ACTOR},now()+interval '1 hour',now(),now())`.execute(
		h.db(),
	);
	const stored = new Map<string, Buffer>();
	vi.mocked(storeExportPart).mockImplementation(async (key, bytes) => {
		stored.set(key, Buffer.from(bytes));
		return "1";
	});
	vi.mocked(fetchExportPart).mockImplementation(
		async (key, generation, length) => {
			const bytes = stored.get(key);
			if (generation !== "1" || bytes?.length !== length)
				throw Error("Unknown synthetic export part");
			return bytes;
		},
	);
	for (const domain of ["district", "coast"]) {
		const target = { ...OTHER, domain };
		const remoteId = domain + "-north";
		const arrived = {
			location_id: remoteId,
			site_code: "north",
			name: "North",
			location_type_code: "region",
			parent_location_id: "",
			latitude: null,
			longitude: null,
			location_data: {},
			external_id: null,
		};
		await withManagedPeer(async (peer) => {
			servePlaceInventory(peer, domain, []);
			acceptImport(peer, domain, 201, { appId: domain + "-app" });
			serveSource(peer, domain, "source-shell", domain + "-app");
			request(peer, "/a/" + domain + "/api/location/v2/", "PATCH").reply(
				async (req) => {
					const body = JSON.parse((await readHttpRequestBody(req)).toString());
					expect(body.objects).toEqual([
						{ name: "North", site_code: "north", location_type_code: "region" },
					]);
					return { statusCode: 202, data: JSON.stringify([remoteId]) };
				},
			);
			servePlaceInventory(peer, domain, [arrived]);
			request(
				peer,
				"/a/" + domain + "/api/location/v1/" + remoteId + "/",
			).reply(200, { ...arrived, domain });
			const result = await publish(doc, target);
			expect(result, JSON.stringify(result)).toMatchObject({
				landed: false,
				refusal: {
					phase: "resources",
					failure: { code: "hq_place_ids_need_setup", details: ["north"] },
				},
			});
		});
		const baseline = await h
			.db()
			.selectFrom("project_space_resource_baselines")
			.select(["remote_id", "origin", "canonical"])
			.where("project_id", "=", PROJECT)
			.where("server", "=", "india")
			.where("domain", "=", domain)
			.where("kind", "=", "location")
			.executeTakeFirstOrThrow();
		expect(baseline).toMatchObject({
			remote_id: remoteId,
			origin: "push",
			canonical: { pendingExternalId: "N-45", observed: { externalId: null } },
		});
		const mapping = await h
			.db()
			.selectFrom("app_deployment_resources as r")
			.innerJoin("app_deployments as d", "d.id", "r.deployment_id")
			.select(["r.remote_id"])
			.where("d.app_id", "=", APP)
			.where("d.domain", "=", domain)
			.where("r.kind", "=", "location")
			.where("r.superseded_at", "is", null)
			.execute();
		expect(mapping).toEqual([{ remote_id: remoteId }]);
		const artifact = await withManagedPeer(async (peer) => {
			servePlaceInventory(peer, domain, [arrived], undefined, true);
			request(peer, "/a/" + domain + "/api/location/v1/" + remoteId + "/")
				.reply(200, { ...arrived, domain })
				.persist();
			const file = await preparePlaceWorkbook(actor, APP, target);
			const bytes: Buffer[] = [];
			for await (const part of exportRange(actor, file.id, {
				start: 0,
				end: file.byteLength - 1,
			}))
				bytes.push(Buffer.from(part));
			const zip = new AdmZip(Buffer.concat(bytes));
			const nested = new AdmZip(zip.readFile("place-ids-1.xlsx") as Buffer);
			const sheet = nested.readAsText("xl/worksheets/sheet2.xml");
			expect(sheet).toContain(remoteId);
			expect(sheet).toContain("N-45");
			expect(sheet).not.toContain(north.locationId);
			return file;
		});

		const corrected = { ...arrived, external_id: "N-45" };
		await withManagedPeer(async (peer) => {
			// As soon as someone changes the external ID, a retained file
			// for the previous destination state cannot serve another range.
			servePlaceInventory(peer, domain, [corrected]);
			await expect(
				exportRange(actor, artifact.id, { start: 0, end: 0 }).next(),
			).rejects.toThrow();
		});
		await withManagedPeer(async (peer) => {
			servePlaceInventory(peer, domain, [corrected]);
			request(
				peer,
				"/a/" + domain + "/api/location/v1/" + remoteId + "/",
			).reply(200, { ...corrected, domain });
			serveSource(peer, domain, "source-shell", domain + "-app");
			request(peer, "/a/" + domain + "/api/location/v2/", "PATCH").reply(
				async (req) => {
					const body = JSON.parse((await readHttpRequestBody(req)).toString());
					expect(body.objects).toEqual([
						{ location_id: remoteId, location_data: { visits: 12 } },
					]);
					return { statusCode: 202, data: JSON.stringify([remoteId]) };
				},
			);
			const complete = { ...corrected, location_data: { visits: 12 } };
			servePlaceInventory(peer, domain, [complete]);
			request(
				peer,
				"/a/" + domain + "/api/location/v1/" + remoteId + "/",
			).reply(200, { ...complete, domain });
			serveSource(peer, domain, "source-shell", domain + "-app");
			acceptImport(peer, domain, 200, { appId: domain + "-app" });
			serveSource(
				peer,
				domain,
				"source-after-create-then-update",
				domain + "-app",
			);
			const result = await publish(doc, target);
			expect(result, JSON.stringify(result)).toMatchObject({ landed: true });
		});
	}
});
