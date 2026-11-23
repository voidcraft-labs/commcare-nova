/**
 * The publish sequence: the requests `publishAppToHq` sends, what it
 * records, and what it refuses, over real Postgres and a peer standing in
 * for CommCare HQ.
 *
 * Every source read, every refused update and every 429 the peer serves is
 * HQ's own answer, retained by the proof lane (`proof/hq-reads/publish/`).
 * Two kinds of answer are written here, and each case says which: an
 * accepted import (`{ success, app_id, version }`, all Nova reads of one),
 * and the lookup table, row and place endpoints' answers, in the shapes
 * `lib/commcare/hq/lookupTables.ts` and `lib/commcare/hq/locations.ts`
 * read. Each landed import is read back, and a republish compares what it
 * reads with that read, so a case that republishes serves the same read
 * for both. A timeout is the peer never answering inside the deadline, and a
 * 500 is a bare status.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import AdmZip from "adm-zip";
import { sql } from "kysely";
import type { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HqSaveCounter,
	isSaveCounterPath,
	withHqPeer,
} from "@/__tests__/helpers/hqSaveCounter";
import { readMultipartRequest } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedPublishRead,
	replyRetained,
	retainedBodyJson,
	retainedBodyText,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { caseOperationFixture } from "@/lib/commcare/__tests__/caseOperationFixture";
import { readXmlEvidence } from "@/lib/commcare/__tests__/xmlEvidence";
import { compileCcz } from "@/lib/commcare/compiler";
import { decrypt } from "@/lib/commcare/encryption";
import { APP_SHELL_KEYS, expandDoc } from "@/lib/commcare/expander";
import { readHqAppSource } from "@/lib/commcare/hq/appSource";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import {
	derivedFormXmlns,
	derivedUniqueId,
	targetWireIdentity,
} from "@/lib/commcare/wireIdentity";
import { commitGuardedBatchProposal } from "@/lib/db/__tests__/admittedWriterTestHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	addKid,
	heldPlacementApp,
	holdOperation,
	holdPlacements,
	operationHold,
	removeKid,
} from "@/lib/db/__tests__/heldPlacementApp";
import { openRemoteWrite } from "@/lib/db/openRemoteWrite";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	type CasePlacement,
	type OrganizationLevel,
} from "@/lib/domain";
import { authoredCaseIdPrefix } from "@/lib/domain/caseOperationIdentity";
import { createLookupTable, replaceLookupRows } from "@/lib/lookup/service";
import { createLocation } from "@/lib/organization/service";
import { PLAN_FEATURE_IDS } from "@/lib/publish/planFeatures";
import { downloadAssetBytes } from "@/lib/storage/media";
import { adoptedAppBaselineWrite } from "../adoption";
import { attachmentUrlTarget } from "../attachmentTarget";
import { resolveDownloadTarget } from "../downloadTarget";
import { getEntryPointLink } from "../entryPointLinks";
import { ABSENT_RESOURCE_DIGEST } from "../hqResourceBaseline";
import {
	previewProjectSpaceFor,
	readPreviewDeploymentAnswer,
} from "../previewSpace";
import {
	APP_CHANGED_DURING_PUBLISH_WARNING,
	APP_PREVIEW_NOTE,
	APP_READ_BACK_FAILED_WARNING,
	BASELINE_UNKNOWN_SENTENCE,
	HQ_CHANGED_DURING_PUSH_MESSAGE,
	HQ_CHANGED_MESSAGE,
	HQ_CHANGES_CONFIRMED_DETAIL,
	HQ_CHANGES_NONE_DETAIL,
	HQ_CHANGES_NOTHING_TO_COMPARE_DETAIL,
} from "../remoteChanges";
import {
	activeRemoteApp,
	deploymentEnding,
	leftBehindResources,
	nextPublishAction,
} from "../resources";
import {
	type PublishInput,
	type PublishOutcome,
	projectSpaceConfirmations,
	publishAppToHq,
	setupArtifactFor,
} from "../service";
import {
	applyDeploymentObservation,
	readAppBaseline,
	readDeployment,
	readDeploymentNovaRevisions,
	readTargetFacts,
	readTargetIdentity,
} from "../store";
import type { DeploymentConfirmationKey, RemoteChangeDiscard } from "../types";
import { clinicVisitsDocument, reloadHeadFor } from "./publishFixtures";
import { stopHere } from "./stopHere";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@/lib/storage/media", () => ({ downloadAssetBytes: vi.fn() }));
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
	vi.mocked(downloadAssetBytes).mockReset();
});
afterEach(() => vi.useRealTimers());

const h = setupAppStateTestDb("publish_sequence_", { authSchema: "migrated" });

/** HQ's save counter for the apps the peer stands for, which each accepted import moves. */
const saves = new HqSaveCounter();
beforeEach(() => saves.reset());
function withPeer<T>(run: (peer: MockAgent) => Promise<T>): Promise<T> {
	return withHqPeer(saves, HOST, run);
}
const APP = "sequence-app",
	PROJECT = "program",
	ACTOR = "editor";
const TARGET = { server: "india" as const, domain: "clinic" };
const SCOPE = {
	appId: APP,
	projectId: PROJECT,
	actorUserId: ACTOR,
	role: "editor",
};
const HOST = "https://india.commcarehq.org";
const IMPORT = "/a/clinic/apps/api/import_app/";
const HQ_APP = "working-app";
const sourcePath = (appId = HQ_APP) => `/a/clinic/apps/source/${appId}/`;
const SOURCE = sourcePath();
const TABLES = "/a/clinic/api/lookup_table/v1/?limit=1000";
const WORKBOOK = "/a/clinic/fixtures/fixapi/";
const LEVELS = "/a/clinic/api/location_type/v1/?limit=1000";
const PLACES = "/a/clinic/api/location/v2/?limit=5000";
const PLACE_PUSH = "/a/clinic/api/location/v2/";
const ROWS = "/a/clinic/api/fixture/v1/?fixture_type_id=hq-table";
const CREATED = "Nova created the app there, and it is empty for now.";

async function seed(doc: BlueprintDoc = clinicVisitsDocument()) {
	await h.seedAppWithBlueprint(doc, {
		id: APP,
		owner: "creator",
		projectId: PROJECT,
	});
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await h
		.db()
		.insertInto("user_settings")
		.values({
			user_id: ACTOR,
			commcare_username: "account",
			commcare_api_key: "ciphertext",
			commcare_server: "india",
			approved_domains: JSON.stringify([
				{ name: "clinic", displayName: "Clinic" },
			]),
			updated_at: new Date(),
		})
		.execute();
	return doc;
}

/**
 * Every confirmation a publish can ask for. The sequence's cases are about
 * what a publish sends, so each says yes to all of them; preflight keeps
 * only what the app needs. `publishGates.postgres.test.ts` holds the asking.
 */
const CONFIRM_ALL: readonly DeploymentConfirmationKey[] = [
	...PLAN_FEATURE_IDS.map((subject) => ({
		kind: "plan-feature" as const,
		subject,
	})),
	{ kind: "flat-location-fixture" },
	{ kind: "connect-forwarder" },
	{ kind: "form-entry-sync-off" },
];

function publish(
	doc: BlueprintDoc,
	discardRemoteChanges?: readonly RemoteChangeDiscard[],
): Promise<PublishOutcome> {
	return publishAppToHq({
		requireHqImport: null,
		scope: SCOPE,
		...TARGET,
		doc,
		compiledAtSeq: 0,
		reloadHead: reloadHeadFor(APP, ACTOR),
		appName: doc.appName,
		confirm: CONFIRM_ALL,
		...(discardRemoteChanges && { discardRemoteChanges }),
	});
}

function request(peer: MockAgent, path: string, method = "GET") {
	return peer.get(HOST).intercept({
		path,
		method,
		headers: { authorization: "ApiKey account:fixture-key" },
	});
}
function serve(peer: MockAgent, path: string, name: RetainedPublishRead) {
	replyRetained(request(peer, path), retainedPublishRead(name));
}
/** An accepted import, written here: 201 for a create, 200 for an update. */
function accepted(
	peer: MockAgent,
	status: 200 | 201,
	appId = HQ_APP,
	bodies?: unknown[],
) {
	request(peer, IMPORT, "POST").reply(async (opts) => {
		if (bodies !== undefined) {
			const form = await readMultipartRequest(opts);
			const file = form.get("app_file");
			if (!(file instanceof Blob)) throw new Error("Expected app JSON");
			bodies.push({
				appId: form.get("app_id"),
				app: JSON.parse(await file.text()),
			});
		}
		if (status === 201) saves.create(appId);
		return {
			statusCode: status,
			data: JSON.stringify({
				success: true,
				app_id: appId,
				...(status === 200 && { version: saves.save(appId) }),
			}),
		};
	});
}
/** The project-space list every preflight reads for the empty-list text flag. */
const PROJECT_SPACES = "/api/user_domains/v1/?limit=100";
const EMPTY_LIST_FLAG = `${PROJECT_SPACES}&feature_flag=empty_case_list_text`;

/**
 * Every request the publish sent to the app's own endpoints, in order. The
 * project-space list reads preflight makes for the empty-list text flag are
 * left out: they change no step of the sequence, and the flag's own cases
 * below hold them. So are the save counter's reads, which the cases of the
 * counter binding hold (`publishBinding.postgres.test.ts`).
 */
function requests(peer: MockAgent): string[] {
	return allRequests(peer).filter(
		(line) =>
			!line.startsWith(`GET ${PROJECT_SPACES}`) &&
			!isSaveCounterPath(line.slice("GET ".length)),
	);
}
function allRequests(peer: MockAgent): string[] {
	return (
		peer
			.getCallHistory()
			?.calls()
			.map(({ method, fullUrl }) => `${method} ${fullUrl.replace(HOST, "")}`) ??
		[]
	);
}
async function state() {
	return readDeployment(SCOPE, TARGET);
}
async function snapshot() {
	return {
		deployments: await h
			.db()
			.selectFrom("app_deployments")
			.selectAll()
			.orderBy("id")
			.execute(),
		resources: await h
			.db()
			.selectFrom("app_deployment_resources")
			.selectAll()
			.orderBy("id")
			.execute(),
	};
}
function refusal(outcome: PublishOutcome) {
	if (outcome.landed) throw new Error("Expected the publish to stop");
	return outcome.refusal;
}

// ── Documents with Project data ─────────────────────────────────────────

const REGION = asUuid("11111111-1111-4111-8111-111111111111");
const remoteLevels = [
	{
		id: 1,
		name: "Region",
		code: "region",
		parent: null,
		administrative: false,
		shares_cases: true,
		view_descendants: false,
	},
];
const remoteTable = {
	id: "hq-table",
	tag: "facilities",
	is_global: true,
	fields: [{ field_name: "code" }, { field_name: "name" }],
};

async function lookupDocument(withPlace = false): Promise<BlueprintDoc> {
	const scope = { projectId: PROJECT, actorId: ACTOR, role: "editor" };
	/* A lookup writer reads its member's role on its own transaction. */
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const table = await createLookupTable(scope, {
		name: "Facilities",
		tag: "facilities",
		columns: [
			{ wireName: "code", label: "Code", dataType: "text" },
			{ wireName: "name", label: "Name", dataType: "text" },
		],
	});
	const [code, name] = table.columns;
	await replaceLookupRows(scope, {
		tableId: table.id,
		expectedTableRevision: table.tableRevision,
		rows: [{ [code.id]: "001", [name.id]: "Clinic" }],
	});
	const doc = buildDoc({
		appName: "Facility visits",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							{
								id: "facility",
								kind: "single_select",
								optionsSource: {
									kind: "lookup",
									tableId: table.id,
									valueColumnId: code.id,
									labelColumnId: name.id,
								},
							},
						],
					},
				],
			},
		],
	});
	return withPlace ? withOrganization(doc) : doc;
}

function withOrganization(doc: BlueprintDoc): BlueprintDoc {
	const level: OrganizationLevel = {
		uuid: REGION,
		code: "region",
		name: "Region",
		caseFlow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "none" },
		},
		addressBook: { reach: "own-branch" },
	};
	return {
		...doc,
		organizationLevels: { [REGION]: level },
		organizationLevelOrder: [REGION],
	};
}

async function seedPlace() {
	await createLocation(SCOPE, {
		levelUuid: REGION,
		name: "North",
		siteCode: "north",
		parentId: null,
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
	});
}

const remotePlace = {
	location_id: "hq-north",
	name: "North",
	site_code: "north",
	location_type_code: "region",
	parent_location_id: "",
	latitude: null,
	longitude: null,
	location_data: {},
};

/** The pushed table's one row, as `FixtureResource` answers a filtered read. */
function tableRows(peer: MockAgent) {
	request(peer, ROWS).reply(200, {
		meta: { next: null, total_count: 1 },
		objects: [
			{
				id: "hq-row",
				fixture_type: "facilities",
				fields: { code: "001", name: "Clinic" },
			},
		],
	});
}
/** The levels, and the places the project space holds. */
function inventory(peer: MockAgent, withNorth: boolean) {
	request(peer, LEVELS).reply(200, {
		meta: { next: null },
		objects: remoteLevels,
	});
	request(peer, PLACES).reply(200, {
		meta: { next: null },
		objects: withNorth ? [remotePlace] : [],
	});
}
/** The inventory read after the last batch, which reads the pushed place back. */
function placesReadBack(peer: MockAgent) {
	request(peer, PLACES).reply(200, {
		meta: { next: null },
		objects: [remotePlace],
	});
}

function emptyTables(peer: MockAgent) {
	request(peer, TABLES).reply(200, { objects: [], meta: { next: null } });
}
function tablesAfterPush(peer: MockAgent) {
	request(peer, TABLES).reply(200, {
		objects: [remoteTable],
		meta: { next: null },
	});
}
function emptyInventory(peer: MockAgent) {
	request(peer, LEVELS).reply(200, {
		meta: { next: null },
		objects: remoteLevels,
	});
	request(peer, PLACES).reply(200, { meta: { next: null }, objects: [] });
}
function workbookTaken(peer: MockAgent) {
	request(peer, WORKBOOK, "POST").reply(200, { code: 200, message: "Done" });
}
function placesTaken(peer: MockAgent) {
	request(peer, PLACE_PUSH, "PATCH").reply(202, JSON.stringify(["hq-north"]));
}

// ── The order of a first publish ────────────────────────────────────────

describe("a first publish", () => {
	it("creates the empty app, reads it, fills it with derived ids, then sends the media", async () => {
		const image = testMediaAssetId("sequence-image");
		const png = readFileSync("public/nova-icons/household.png");
		const hash = createHash("sha256").update(png).digest("hex");
		const doc = clinicVisitsDocument();
		const field = Object.values(doc.fields)[0];
		if (field.kind !== "text") throw new Error("Expected a text field");
		field.label_media = { image };
		await seed(doc);
		await h
			.db()
			.insertInto("media_assets")
			.values({
				id: image,
				project_id: PROJECT,
				owner: "creator",
				kind: "image",
				content_hash: hash,
				mime_type: "image/png",
				extension: ".png",
				size_bytes: png.length,
				gcs_object_key: `projects/${PROJECT}/${hash}.png`,
				original_filename: "household.png",
				display_name: "Household",
				status: "ready",
				media_format: "png",
			})
			.execute();
		vi.mocked(downloadAssetBytes).mockResolvedValue(png);
		const bodies: { appId: unknown; app: Record<string, unknown> }[] = [];
		await withPeer(async (peer) => {
			accepted(peer, 201, HQ_APP, bodies);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200, HQ_APP, bodies);
			serve(peer, SOURCE, "source-after-create-then-update");
			const media = `/a/clinic/apps/api/${HQ_APP}/multimedia/`;
			request(peer, media, "POST").reply(200, {
				success: true,
				processing_id: "media-job",
			});
			request(peer, `${media}status/media-job/`).reply(200, {
				success: true,
				processing_id: "media-job",
				complete: true,
				matched_count: 1,
				unmatched_count: 0,
				unmatched_files: [],
				errors: [],
			});

			const outcome = await publish(doc);
			expect(outcome).toMatchObject({
				landed: true,
				hqAppAction: "created",
				appPreviewNote: null,
			});
			expect(requests(peer)).toEqual([
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
				`POST ${media}`,
				`GET ${media}status/media-job/`,
			]);
		});

		const [shell, update] = bodies;
		expect(shell.appId).toBeNull();
		// Seven keys: `auto_gps_capture` is written only for a Connect app, and
		// `add_ons` and `profile` arrive with the update over the shell's read.
		// HQ keeps its own `build_spec`, so no body names one.
		expect(Object.keys(shell.app)).toEqual(
			APP_SHELL_KEYS.filter((key) => key !== "auto_gps_capture"),
		);
		expect(shell.app).toMatchObject({ modules: [], _attachments: {} });
		for (const key of [
			"add_ons",
			"auto_gps_capture",
			"multimedia_map",
			"logo_refs",
			"profile",
			"location_fixture_restore",
			"build_spec",
		])
			expect(shell.app).not.toHaveProperty(key);

		expect(update.appId).toBe(HQ_APP);
		const module = doc.modules[doc.moduleOrder[0]];
		const form = doc.forms[doc.formOrder[module.uuid][0]];
		expect(update.app.modules).toMatchObject([
			{
				unique_id: derivedUniqueId(module.uuid),
				forms: [
					{
						unique_id: derivedUniqueId(form.uuid),
						xmlns: derivedFormXmlns(form.uuid),
					},
				],
			},
		]);
		expect(activeRemoteApp((await state()) ?? fail())).toMatchObject({
			remoteId: HQ_APP,
			pushedRevision: 0,
			remoteMissingAt: null,
		});
	});

	it("names the ids HQ recorded for a deployment in a republish, and derives the rest", async () => {
		const doc = await seed();
		const module = doc.modules[doc.moduleOrder[0]];
		const form = doc.forms[doc.formOrder[module.uuid][0]];
		const bodies: { appId: unknown; app: Record<string, unknown> }[] = [];
		await withPeer(async (peer) => {
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect((await publish(doc)).landed).toBe(true);

			// The rows the cutover wrote from HQ's own reads of a deployment
			// the pre-step emitter made: the menu's id, and the form's xmlns
			// with no id of its own recorded.
			const deployment = (await state()) ?? fail();
			await h
				.db()
				.insertInto("app_deployment_identities")
				.values([
					{
						deployment_id: deployment.deployment.id,
						entity_kind: "module",
						nova_entity_uuid: module.uuid,
						unique_id: "hq-recorded-menu",
						xmlns: null,
					},
					{
						deployment_id: deployment.deployment.id,
						entity_kind: "form",
						nova_entity_uuid: form.uuid,
						unique_id: null,
						xmlns: "http://openrosa.org/formdesigner/hq-recorded-form",
					},
				])
				.execute();

			serve(peer, SOURCE, "source-live");
			accepted(peer, 200, HQ_APP, bodies);
			serve(peer, SOURCE, "source-live");
			expect(await publish(doc)).toMatchObject({
				landed: true,
				hqAppAction: "updated",
			});
		});

		const [republish] = bodies;
		expect(republish.appId).toBe(HQ_APP);
		expect(republish.app.modules).toMatchObject([
			{
				unique_id: "hq-recorded-menu",
				forms: [
					{
						unique_id: derivedUniqueId(form.uuid),
						xmlns: "http://openrosa.org/formdesigner/hq-recorded-form",
					},
				],
			},
		]);
	});

	it("pushes a lookup table and a place after the shell's read, and reads the app again before the update", async () => {
		const doc = await seed(await lookupDocument(true));
		await seedPlace();
		await withPeer(async (peer) => {
			emptyTables(peer);
			emptyInventory(peer);
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			workbookTaken(peer);
			tablesAfterPush(peer);
			tableRows(peer);
			placesTaken(peer);
			placesReadBack(peer);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-after-create-then-update");
			expect((await publish(doc)).landed).toBe(true);
			expect(requests(peer)).toEqual([
				`GET ${TABLES}`,
				`GET ${LEVELS}`,
				`GET ${PLACES}`,
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
				`POST ${WORKBOOK}`,
				`GET ${TABLES}`,
				`GET ${ROWS}`,
				`PATCH ${PLACE_PUSH}`,
				`GET ${PLACES}`,
				`GET ${SOURCE}`,
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
			]);
		});
	});

	it("keeps the mapped shell when the read after the create fails, and fills that same app once a person publishes over it", async () => {
		const doc = await seed(await lookupDocument());
		await withPeer(async (peer) => {
			emptyTables(peer);
			accepted(peer, 201);
			request(peer, SOURCE).reply(403, "");
			const outcome = await publish(doc);
			expect(refusal(outcome)).toMatchObject({
				phase: "resources",
				failure: {
					code: "hq_app_state_unknown",
					message: `Nova couldn't read the app on “clinic”, so Nova stopped before sending the app's content. ${CREATED} Reading it needs permission to edit apps in CommCare HQ. Check the connected account, then publish again.`,
				},
			});
			expect(requests(peer)).toEqual([
				`GET ${TABLES}`,
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
			]);
			const stopped = await state();
			expect(stopped?.deployment).toMatchObject({
				state: "incomplete",
				resumePhase: "resources",
			});
			expect(stopped?.active).toEqual([
				expect.objectContaining({
					kind: "app",
					remoteId: HQ_APP,
					pushedRevision: null,
				}),
			]);

			/* Nova holds no read of the empty app, so the retry cannot tell
			 * whether anything changed there and asks before writing. */
			emptyTables(peer);
			serve(peer, SOURCE, "source-shell");
			const asked = refusal(await publish(doc));
			expect(asked).toMatchObject({
				phase: "preflight",
				failure: { code: "hq_changed" },
				remoteChanges: [
					{
						kind: "app",
						novaResourceId: APP,
						name: doc.appName,
						identity: HQ_APP,
						parts: [],
						note: null,
						baselineKnown: false,
					},
				],
			});
			expect(requests(peer).slice(3)).toEqual([
				`GET ${TABLES}`,
				`GET ${SOURCE}`,
			]);
			const [shown] = asked.remoteChanges;

			emptyTables(peer);
			serve(peer, SOURCE, "source-shell");
			workbookTaken(peer);
			tablesAfterPush(peer);
			tableRows(peer);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-after-create-then-update");
			expect(
				await publish(doc, [
					{
						kind: "app",
						novaResourceId: APP,
						observedDigest: shown?.observedDigest ?? fail(),
					},
				]),
			).toMatchObject({
				landed: true,
				hqAppAction: "created",
				appPreviewNote: APP_PREVIEW_NOTE,
			});
			expect(requests(peer).slice(5)).toEqual([
				`GET ${TABLES}`,
				`GET ${SOURCE}`,
				`POST ${WORKBOOK}`,
				`GET ${TABLES}`,
				`GET ${ROWS}`,
				`GET ${SOURCE}`,
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
			]);
		});
		const baseline = await h
			.db()
			.selectFrom("app_deployment_baselines")
			.select(["origin", "discarded_by", "discarded_digest"])
			.executeTakeFirstOrThrow();
		expect(baseline).toMatchObject({ origin: "push", discarded_by: ACTOR });
		expect(baseline.discarded_digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("says the app it made is empty when the read after the create answers a bare 500", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			accepted(peer, 201);
			request(peer, SOURCE).reply(500, "");
			expect(refusal(await publish(doc)).failure.message).toBe(
				`Nova couldn't safely read the app on “clinic”, so Nova stopped before sending the app's content. ${CREATED} Check that the app opens in CommCare HQ, then publish again.`,
			);
		});
	});

	it("records no rung past preflight when the shell's workbook is refused, and the retry pushes the table and fills that app", async () => {
		const doc = await seed(await lookupDocument());
		await withPeer(async (peer) => {
			emptyTables(peer);
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			request(peer, WORKBOOK, "POST").reply(200, {
				code: 405,
				message: "Column code has an invalid row.",
			});
			expect(refusal(await publish(doc)).phase).toBe("resources");
			const stopped = await state();
			expect(stopped?.deployment.phases.resources?.status).toBe("failed");
			expect(stopped?.deployment.phases.upload).toBeNull();
			expect(stopped?.active).toEqual([
				expect.objectContaining({ kind: "app", pushedRevision: null }),
			]);
			expect(
				requests(peer).filter((line) => line === `POST ${IMPORT}`),
			).toHaveLength(1);

			emptyTables(peer);
			serve(peer, SOURCE, "source-shell");
			workbookTaken(peer);
			tablesAfterPush(peer);
			tableRows(peer);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-after-create-then-update");
			expect(await publish(doc)).toMatchObject({
				landed: true,
				hqAppAction: "created",
			});
			expect(
				requests(peer).filter((line) => line === `POST ${IMPORT}`),
			).toHaveLength(2);
			expect(activeRemoteApp((await state()) ?? fail())).toMatchObject({
				remoteId: HQ_APP,
				pushedRevision: 0,
			});
		});
	});
});

// ── The nine stops at a table or place push, in two forms ───────────────

type Stop = {
	readonly name: string;
	readonly places: boolean;
	/** The stop leaves the table mapped, so the next publish compares it. */
	readonly mapsTable?: boolean;
	/** The push's answers, after the preflight reads and before any source read. */
	readonly stop: (peer: MockAgent) => void;
	readonly sentence: (createdApp: boolean) => string;
};

const before = (createdApp: boolean, apostrophe = "'") =>
	`so Nova stopped before sending the app${apostrophe}s content.${createdApp ? ` ${CREATED}` : ""}`;

const STOPS: readonly Stop[] = [
	{
		name: "a workbook refused with nothing landed",
		places: false,
		stop: (peer) =>
			request(peer, WORKBOOK, "POST").reply(200, {
				code: 405,
				message: "Column code has an invalid row.",
			}),
		sentence: (c) =>
			`CommCare HQ would not take this app's lookup tables for “clinic”, ${before(c)} ${c ? "Nothing else on the project space changed." : "Nothing on the project space changed."}`,
	},
	{
		name: "a workbook taken in part",
		places: false,
		mapsTable: true,
		stop: (peer) => {
			request(peer, WORKBOOK, "POST").reply(200, {
				code: 402,
				message: "One row could not be read.",
			});
			tablesAfterPush(peer);
			tableRows(peer);
		},
		sentence: (c) =>
			`CommCare HQ took only part of this app's lookup tables for “clinic”, ${before(c)} The tables it did take now hold what Nova sent. Fix what it names below, then publish again to put the rest there.`,
	},
	{
		name: "a workbook answered 403",
		places: false,
		stop: (peer) => request(peer, WORKBOOK, "POST").reply(403, ""),
		sentence: (c) =>
			`CommCare HQ wouldn't let Nova put this app's lookup tables on “clinic”, ${before(c)} Uploading them needs the Edit Data permission on your CommCare HQ account.`,
	},
	{
		name: "a workbook whose answer was lost",
		places: false,
		mapsTable: true,
		stop: (peer) => {
			request(peer, WORKBOOK, "POST").replyWithError(new Error("lost"));
			tablesAfterPush(peer);
			tableRows(peer);
		},
		sentence: (c) =>
			`Nova couldn’t confirm how much of this app’s lookup data CommCare HQ saved for “clinic”, ${before(c, "’")} Some tables may now hold what Nova sent. Publishing again checks what is there before updating it.`,
	},
	{
		name: "a workbook taken and then a failed table list",
		places: false,
		stop: (peer) => {
			workbookTaken(peer);
			request(peer, TABLES).reply(500, "");
		},
		sentence: (c) =>
			`CommCare HQ took this app's lookup tables for “clinic” but then would not confirm them, ${before(c)} The tables are on the project space, so publishing again may ask you to confirm they are yours before it carries on.`,
	},
	{
		name: "a workbook taken with a pushed table missing from the list",
		places: false,
		stop: (peer) => {
			workbookTaken(peer);
			emptyTables(peer);
		},
		sentence: (c) =>
			`CommCare HQ reported this app's lookup tables as uploaded but does not list them all, ${before(c)} Check the lookup tables on “clinic”, then publish again.`,
	},
	{
		name: "a place batch answered 403",
		places: true,
		stop: (peer) => request(peer, PLACE_PUSH, "PATCH").reply(403, ""),
		sentence: (c) =>
			`CommCare HQ wouldn't take this app's places for “clinic”, ${before(c)} Creating places needs the Edit Locations permission on your CommCare HQ account.`,
	},
	{
		name: "a place batch refused with HQ's sentence",
		places: true,
		stop: (peer) =>
			request(peer, PLACE_PUSH, "PATCH").reply(400, {
				error: "A place already has this name. Location site code: north.",
			}),
		sentence: (c) =>
			`CommCare HQ wouldn't take some of this app's places for “clinic”, ${before(c)} Nothing in the group that stopped was created, and any places sent before it are on the project space. Publishing again carries on from there.`,
	},
	{
		name: "a place batch whose answer was lost",
		places: true,
		stop: (peer) =>
			request(peer, PLACE_PUSH, "PATCH").replyWithError(new Error("lost")),
		sentence: (c) =>
			`Nova couldn’t confirm whether CommCare HQ saved the last group of places for “clinic”, ${before(c, "’")} Earlier confirmed groups are recorded. Publishing again checks what is there and may ask you to confirm which existing places Nova can update.`,
	},
];

describe("a stop at a table or place push", () => {
	it.each(STOPS)(
		"says what the project space holds after $name",
		async ({ places, mapsTable = false, stop, sentence }) => {
			const doc = places
				? await seed(withOrganization(clinicVisitsDocument()))
				: await seed(await lookupDocument());
			if (places) await seedPlace();
			/* Once Nova holds the table or the place there, preflight reads
			 * it again and compares it with what the push read back. */
			const preflight = (peer: MockAgent, mapped: boolean) => {
				if (places) inventory(peer, mapped);
				else if (mapped) {
					tablesAfterPush(peer);
					tableRows(peer);
				} else emptyTables(peer);
			};
			const landedPush = (peer: MockAgent) => {
				if (places) {
					placesTaken(peer);
					placesReadBack(peer);
				} else {
					workbookTaken(peer);
					tablesAfterPush(peer);
					tableRows(peer);
				}
			};
			await withPeer(async (peer) => {
				// The first publish: the shell, then the stop.
				preflight(peer, false);
				accepted(peer, 201);
				serve(peer, SOURCE, "source-shell");
				stop(peer);
				const first = refusal(await publish(doc));
				expect(first.failure.message).toBe(sentence(true));

				// Its retry sends no create: the empty app is an earlier try's.
				preflight(peer, mapsTable);
				serve(peer, SOURCE, "source-shell");
				stop(peer);
				const retry = refusal(await publish(doc));
				expect(retry.failure.message).toBe(sentence(false));

				// Filled, then a republish to an app that holds content.
				preflight(peer, mapsTable);
				serve(peer, SOURCE, "source-shell");
				landedPush(peer);
				serve(peer, SOURCE, "source-shell");
				accepted(peer, 200);
				serve(peer, SOURCE, "source-live");
				expect((await publish(doc)).landed).toBe(true);
				preflight(peer, true);
				serve(peer, SOURCE, "source-live");
				stop(peer);
				const republish = refusal(await publish(doc));
				expect(republish.failure.message).toBe(sentence(false));

				for (const message of [first, retry, republish].map(
					(r) => r.failure.message,
				))
					for (const old of ["was not sent", "wasn't sent", "wasn’t sent"])
						expect(message).not.toContain(old);
				expect(
					requests(peer).filter((line) => line === `POST ${IMPORT}`),
				).toHaveLength(2);
			});
		},
	);
});

// ── After the mapping is recorded, never a second app ───────────────────

describe("a failure after the shell is mapped", () => {
	it("leaves no mapping when the process stops between the create and its record, so the next publish creates", async () => {
		const doc = await seed();
		await sql`CREATE FUNCTION refuse_app_mapping() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'process stopped'; END $$`.execute(
			h.db(),
		);
		await sql`CREATE TRIGGER refuse_app_mapping BEFORE INSERT ON app_deployment_resources FOR EACH ROW EXECUTE FUNCTION refuse_app_mapping()`.execute(
			h.db(),
		);
		await withPeer(async (peer) => {
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			await expect(publish(doc)).rejects.toThrow();
			expect((await state())?.active).toEqual([]);
			await sql`DROP TRIGGER refuse_app_mapping ON app_deployment_resources`.execute(
				h.db(),
			);
			accepted(peer, 201, "second-app");
			serve(peer, sourcePath("second-app"), "source-shell");
			accepted(peer, 200, "second-app");
			serve(peer, sourcePath("second-app"), "source-after-create-then-update");
			expect(await publish(doc)).toMatchObject({
				landed: true,
				hqAppAction: "created",
			});
			expect(
				requests(peer).filter((line) => line === `POST ${IMPORT}`),
			).toHaveLength(3);
		});
	});

	it.each(["the retained 404", "a bare 500"] as const)(
		"keeps the shell when the update is answered with %s, and the next publish updates that app and reports it created",
		async (answer) => {
			const doc = await seed();
			await withPeer(async (peer) => {
				accepted(peer, 201);
				serve(peer, SOURCE, "source-shell");
				if (answer === "the retained 404")
					replyRetained(
						request(peer, IMPORT, "POST"),
						retainedPublishRead("update-missing"),
					);
				else request(peer, IMPORT, "POST").reply(500, "");
				expect(refusal(await publish(doc))).toMatchObject({
					phase: "upload",
					failure: { code: "hq_rejected_upload" },
				});
				await expectShellKept();

				serve(peer, SOURCE, "source-shell");
				accepted(peer, 200);
				serve(peer, SOURCE, "source-after-create-then-update");
				expect(await publish(doc)).toMatchObject({
					landed: true,
					hqAppAction: "created",
				});
				expect(requests(peer).slice(3)).toEqual([
					`GET ${SOURCE}`,
					`POST ${IMPORT}`,
					`GET ${SOURCE}`,
				]);
			});
		},
	);

	it("keeps the shell when the update never answers inside its deadline", async () => {
		const doc = await seed();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withPeer(async (peer) => {
			const sent = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			request(peer, IMPORT, "POST").reply(async () => {
				sent.resolve();
				await release.promise;
				return { statusCode: 200, data: "{}" };
			});
			const pending = publish(doc);
			try {
				await sent.promise;
				await vi.advanceTimersByTimeAsync(60_000);
				expect(refusal(await pending)).toMatchObject({
					phase: "upload",
					failure: { code: "hq_rejected_upload" },
				});
			} finally {
				release.resolve();
				await pending.catch(() => undefined);
			}
			vi.useRealTimers();
			await expectShellKept();
			expect(
				requests(peer).filter((line) => line === `POST ${IMPORT}`),
			).toHaveLength(2);
		});
	});

	it.each(["source-deleted", "source-missing"] as const)(
		"keeps the shell when the second read answers HQ's %s, and the next publish reads that app rather than creating one",
		async (answer) => {
			const doc = await seed(await lookupDocument());
			await withPeer(async (peer) => {
				emptyTables(peer);
				accepted(peer, 201);
				serve(peer, SOURCE, "source-shell");
				workbookTaken(peer);
				tablesAfterPush(peer);
				serve(peer, SOURCE, answer);
				expect(refusal(await publish(doc))).toMatchObject({
					phase: "upload",
					failure: {
						code: "hq_app_state_unknown",
						message: `Nova couldn't safely read the app on “clinic”, so Nova stopped before sending the app's content. ${CREATED} Check that the app opens in CommCare HQ, then publish again.`,
					},
				});
				expect(activeRemoteApp((await state()) ?? fail())).toMatchObject({
					remoteId: HQ_APP,
					pushedRevision: null,
					remoteMissingAt: null,
				});

				const first = requests(peer).length;
				emptyTables(peer);
				serve(peer, SOURCE, answer);
				expect(refusal(await publish(doc))).toMatchObject({
					failure: { code: "remote_app_missing" },
				});
				expect(requests(peer).slice(first)).toEqual([
					`GET ${TABLES}`,
					`GET ${SOURCE}`,
				]);
			});
		},
	);

	async function expectShellKept() {
		const stopped = await state();
		expect(stopped?.deployment).toMatchObject({
			state: "incomplete",
			resumePhase: "upload",
		});
		expect(stopped?.active).toEqual([
			expect.objectContaining({
				kind: "app",
				remoteId: HQ_APP,
				pushedRevision: null,
			}),
		]);
	}
});

// ── HQ's rate limit between the two imports ─────────────────────────────

describe("a 429 on the update", () => {
	it("waits out HQ's short Retry-After once and lands", async () => {
		const doc = await seed();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withPeer(async (peer) => {
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			replyRetained(
				request(peer, IMPORT, "POST"),
				retainedPublishRead("import-429-second"),
			);
			accepted(peer, 200);
			serve(peer, SOURCE, "source-after-create-then-update");
			const pending = publish(doc);
			await vi.waitFor(() => expect(requests(peer)).toHaveLength(3));
			await vi.advanceTimersByTimeAsync(2_000);
			expect((await pending).landed).toBe(true);
			expect(requests(peer)).toEqual([
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
				`POST ${IMPORT}`,
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
			]);
		});
	});

	it.each(["three times", "with a Retry-After it cannot wait out"] as const)(
		"refuses when answered %s, sending nothing more and keeping the shell",
		async (mode) => {
			const doc = await seed();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			await withPeer(async (peer) => {
				accepted(peer, 201);
				serve(peer, SOURCE, "source-shell");
				const answers =
					mode === "three times"
						? Array(3).fill(retainedPublishRead("import-429-second"))
						: [retainedPublishRead("import-429-minute")];
				for (const answer of answers)
					replyRetained(request(peer, IMPORT, "POST"), answer);
				const pending = publish(doc);
				for (let wait = 1; wait < answers.length; wait++) {
					await vi.waitFor(() => expect(requests(peer)).toHaveLength(2 + wait));
					await vi.advanceTimersByTimeAsync(2_000);
				}
				expect(refusal(await pending)).toMatchObject({
					phase: "upload",
					failure: {
						code: "hq_rejected_upload",
						message:
							"CommCare HQ is rate limiting requests right now. Wait a moment and publish again.",
					},
				});
				expect(requests(peer)).toHaveLength(2 + answers.length);
				expect((await state())?.active).toEqual([
					expect.objectContaining({ remoteId: HQ_APP, pushedRevision: null }),
				]);
			});
		},
	);
});

// ── HQ reporting the app gone, and an app Nova did not make ─────────────

describe("the app on HQ at the target-app edge", () => {
	/** A first publish that lands, in four requests. */
	async function landed(doc: BlueprintDoc, peer: MockAgent) {
		accepted(peer, 201);
		serve(peer, SOURCE, "source-shell");
		accepted(peer, 200);
		serve(peer, SOURCE, "source-live");
		expect((await publish(doc)).landed).toBe(true);
	}

	it.each(["source-deleted", "source-missing"] as const)(
		"records the app gone on HQ's %s answer, and the next publish creates a new app in its place",
		async (answer) => {
			const doc = await seed();
			await withPeer(async (peer) => {
				await landed(doc, peer);
				serve(peer, SOURCE, answer);
				expect(refusal(await publish(doc))).toMatchObject({
					phase: "upload",
					failure: { code: "remote_app_missing" },
				});
				const gone = await state();
				expect(gone?.deployment).toMatchObject({
					state: "incomplete",
					resumePhase: "upload",
				});
				expect(activeRemoteApp(gone ?? fail())?.remoteMissingAt).not.toBeNull();
				expect(requests(peer).slice(4)).toEqual([`GET ${SOURCE}`]);

				accepted(peer, 201, "replacement-app");
				serve(peer, sourcePath("replacement-app"), "source-shell");
				accepted(peer, 200, "replacement-app");
				serve(peer, sourcePath("replacement-app"), "source-live");
				expect(await publish(doc)).toMatchObject({
					landed: true,
					hqAppAction: "created",
				});
				const replaced = await state();
				expect(replaced?.active.map((row) => row.remoteId)).toEqual([
					"replacement-app",
				]);
				expect(replaced?.superseded.map((row) => row.remoteId)).toEqual([
					HQ_APP,
				]);
			});
		},
	);

	it("refuses a linked app before writing anything, and says so", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			await landed(doc, peer);
			const unchanged = await snapshot();
			serve(peer, SOURCE, "source-linked");
			expect(refusal(await publish(doc))).toMatchObject({
				phase: "preflight",
				failure: {
					code: "hq_app_state_unknown",
					message:
						"The app on “clinic” is a linked app in CommCare HQ, and Nova can't update a linked app. Nova left it unchanged. You can publish to another project space, or remove the link in CommCare HQ and publish again.",
				},
			});
			expect(await snapshot()).toEqual(unchanged);
			expect(requests(peer).slice(4)).toEqual([`GET ${SOURCE}`]);
		});
	});

	it.each([
		["translations", ["not a language's strings"]],
		["add_ons", "every add-on"],
	] as const)(
		"refuses at the target-app read when the app's %s is not the shape HQ writes, and sends nothing",
		async (key, value) => {
			const doc = await seed();
			await withPeer(async (peer) => {
				await landed(doc, peer);
				const unchanged = await snapshot();
				serveEdited(peer, SOURCE, "source-live", (source) => {
					source[key] = value;
				});
				const outcome = await publish(doc);
				expect(refusal(outcome)).toMatchObject({
					phase: "preflight",
					failure: { code: "hq_app_state_unknown" },
				});
				expect(
					outcome.checks.find((check) => check.id === "target-app"),
				).toMatchObject({ status: "blocked" });
				expect(await snapshot()).toEqual(unchanged);
				expect(requests(peer).slice(4)).toEqual([`GET ${SOURCE}`]);
			});
		},
	);

	it.each([
		[
			403,
			"Nova couldn't read the current app on “clinic”, so it left that app unchanged. Reading it needs permission to edit apps in CommCare HQ. Check the connected account, then publish again.",
		],
		[
			500,
			"Nova couldn't safely read the current app on “clinic”, so it left that app unchanged. Check that the app still opens in CommCare HQ, then publish again.",
		],
	] as const)(
		"refuses at preflight with today's sentence when the read of an app that was there answers %i",
		async (status, message) => {
			const doc = await seed();
			await withPeer(async (peer) => {
				await landed(doc, peer);
				request(peer, SOURCE).reply(status, "");
				expect(refusal(await publish(doc))).toMatchObject({
					phase: "preflight",
					failure: { code: "hq_app_state_unknown", message },
				});
			});
		},
	);
});

// ── What reads the mapping offers nothing into an empty or gone app ─────

describe("readers of a shell or a gone app", () => {
	it.each(["shell", "gone"] as const)(
		"offers no HQ app link and no entry point link for a %s deployment",
		async (shape) => {
			const doc = await seed(await lookupDocument());
			await withPeer(async (peer) => {
				emptyTables(peer);
				accepted(peer, 201);
				serve(peer, SOURCE, "source-shell");
				request(peer, WORKBOOK, "POST").reply(403, "");
				if (shape === "gone") {
					await publish(doc);
					const shell = activeRemoteApp((await state()) ?? fail()) ?? fail();
					await applyDeploymentObservation(SCOPE, TARGET, {
						observedRemoteId: shell.remoteId,
						observedPushToken: shell.pushToken,
						outcomes: [
							[
								"upload",
								{
									status: "failed",
									at: new Date().toISOString(),
									failure: {
										code: "remote_app_missing",
										message: "The app Nova published isn't there any more.",
										details: [],
									},
								},
							],
						],
						remoteRevision: null,
					});
				} else await publish(doc);
			});
			const deployment = (await state()) ?? fail();
			expect(activeRemoteApp(deployment)).not.toBeNull();
			expect(
				(await setupArtifactFor(SCOPE, deployment, doc)).hqAppId,
			).toBeNull();
			await expect(
				getEntryPointLink({
					scope: SCOPE,
					target: TARGET,
					doc,
					sourceSequence: 0,
					entryPointUuid: "01992000-0000-7000-8000-0000000000e1",
					selections: [],
				}),
			).rejects.toThrow("Publish this app again before creating a link.");
		},
	);
});

// ── What changed in CommCare HQ since Nova last published there ─────────

/**
 * A retained read with the one edit a case names, as a save in CommCare HQ
 * would leave it.
 */
function serveEdited(
	peer: MockAgent,
	path: string,
	name: RetainedPublishRead,
	edit: (source: Record<string, unknown>) => void,
) {
	const answer = retainedPublishRead(name);
	const source = retainedBodyJson(answer);
	edit(source);
	replyRetained(request(peer, path), {
		...answer,
		body: JSON.stringify(source),
	});
}
const renamedInHq = (source: Record<string, unknown>) => {
	source.name = "Renamed in CommCare HQ";
};
const renamedAgainInHq = (source: Record<string, unknown>) => {
	source.name = "Renamed again in CommCare HQ";
};
const savedInHq = (source: Record<string, unknown>) => {
	source.last_modified = "2030-01-01T00:00:00.000000Z";
};
function hqChangesCheck(outcome: PublishOutcome) {
	return outcome.checks.find((check) => check.id === "hq-changes");
}

describe("changes made in CommCare HQ", () => {
	it.each([true, false])(
		"lists a grid CommCare HQ held before Nova wrote menu layouts, and accounts for it once published over (usable reference: %s)",
		async (paired) => {
			const doc = await seed();
			const heldGrid = (source: Record<string, unknown>) => {
				source.use_grid_menus = true;
			};
			await withPeer(async (peer) => {
				accepted(peer, 201);
				serve(peer, SOURCE, "source-shell");
				accepted(peer, 200);
				serveEdited(peer, SOURCE, "source-live", heldGrid);
				expect((await publish(doc)).landed).toBe(true);
				const db = h.db();
				const deployment = await db
					.selectFrom("app_deployments")
					.select("id")
					.where("app_id", "=", APP)
					.executeTakeFirstOrThrow();
				/* A baseline recorded before Nova wrote menu layouts, over an HQ app
				 * whose first menu someone made a grid there before it: both reads
				 * agree, so no comparison of the two can show the grid. */
				await db
					.updateTable("app_deployment_baselines")
					.set({
						ownership: sql`ownership - 'menuLayouts'`,
						...(!paired && { nova_revision: null }),
					})
					.where("deployment_id", "=", deployment.id)
					.executeTakeFirstOrThrow();
				const before = requests(peer).length;
				serveEdited(peer, SOURCE, "source-live", heldGrid);
				const stopped = refusal(await publish(doc));
				expect(stopped).toMatchObject({
					phase: "preflight",
					failure: {
						code: "hq_changed",
						message: expect.stringContaining("menu layouts"),
					},
					remoteChanges: [
						{
							kind: "app",
							replacesMenuLayouts: true,
							baselineKnown: true,
						},
					],
				});
				const [shown] = stopped.remoteChanges;
				/* The settings the baseline held agree with HQ's: the grid is the one part. */
				expect(shown?.parts).toEqual([
					"The first menu would change from a grid to a list.",
				]);
				expect(requests(peer).slice(before)).toEqual([`GET ${SOURCE}`]);
				const confirm = [
					{
						kind: "app" as const,
						novaResourceId: APP,
						observedDigest: shown?.observedDigest ?? fail(),
					},
				];
				/* HQ moved after the person was shown the list: they confirm again. */
				serveEdited(peer, SOURCE, "source-live", (source) => {
					heldGrid(source);
					source.grid_form_menus = "all";
				});
				const changed = refusal(await publish(doc, confirm));
				expect(changed.remoteChanges[0]?.observedDigest).not.toBe(
					confirm[0].observedDigest,
				);
				expect(changed.remoteChanges[0]?.parts).toContain(
					"The layout for the other menus would change from a grid to a list.",
				);
				serveEdited(peer, SOURCE, "source-live", heldGrid);
				accepted(peer, 200);
				serve(peer, SOURCE, "source-live");
				expect((await publish(doc, confirm)).landed).toBe(true);
				const after = await readAppBaseline(SCOPE, TARGET);
				expect(
					after !== null &&
						after.origin !== "unread" &&
						after.ownership.menuLayouts,
				).toBe(true);
				/* Accounted for: the next publish over the same app lists nothing. */
				serve(peer, SOURCE, "source-live");
				accepted(peer, 200);
				serve(peer, SOURCE, "source-live");
				expect((await publish(doc)).landed).toBe(true);
			});
		},
	);

	it("lands three publishes of an unchanged app in a row, saying what it compared", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			const first = await publish(doc);
			expect(hqChangesCheck(first)).toMatchObject({
				status: "passed",
				detail: HQ_CHANGES_NOTHING_TO_COMPARE_DETAIL,
			});
			for (let again = 0; again < 2; again++) {
				serve(peer, SOURCE, "source-live");
				accepted(peer, 200);
				serve(peer, SOURCE, "source-live");
				const republish = await publish(doc);
				expect(republish).toMatchObject({ landed: true, appPreviewNote: null });
				expect(hqChangesCheck(republish)).toMatchObject({
					status: "passed",
					detail: HQ_CHANGES_NONE_DETAIL,
				});
			}
		});
	});

	it("stops before any write over a changed app, refuses an older digest, and lands over the state a person was shown", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect((await publish(doc)).landed).toBe(true);
			const sent = requests(peer).length;

			serveEdited(peer, SOURCE, "source-live", renamedInHq);
			const stopped = await publish(doc);
			const first = refusal(stopped);
			expect(first).toMatchObject({
				phase: "preflight",
				failure: { code: "hq_changed", message: HQ_CHANGED_MESSAGE },
				remoteChanges: [
					{
						kind: "app",
						novaResourceId: APP,
						name: doc.appName,
						identity: HQ_APP,
						parts: ["The app's name"],
						baselineKnown: true,
					},
				],
			});
			expect(hqChangesCheck(stopped)).toMatchObject({
				status: "blocked",
				items: [doc.appName],
			});
			expect(requests(peer).slice(sent)).toEqual([`GET ${SOURCE}`]);
			const [shown] = first.remoteChanges;
			const digest = shown?.observedDigest ?? fail();

			/* A digest of a state HQ has since left is no confirmation: the
			 * refusal names the state HQ holds now. */
			serveEdited(peer, SOURCE, "source-live", renamedAgainInHq);
			const renamedAgain = refusal(
				await publish(doc, [
					{ kind: "app", novaResourceId: APP, observedDigest: digest },
				]),
			);
			const [again] = renamedAgain.remoteChanges;
			expect(again?.parts).toEqual(["The app's name"]);
			expect(again?.observedDigest).not.toBe(digest);

			/* A save of a key Nova ignores is a new state with the same parts. */
			serveEdited(peer, SOURCE, "source-live", (source) => {
				renamedInHq(source);
				savedInHq(source);
			});
			const resaved = refusal(
				await publish(doc, [
					{ kind: "app", novaResourceId: APP, observedDigest: digest },
				]),
			);
			const [moved] = resaved.remoteChanges;
			expect(moved?.parts).toEqual(["The app's name"]);
			expect(moved?.observedDigest).not.toBe(digest);

			serveEdited(peer, SOURCE, "source-live", (source) => {
				renamedInHq(source);
				savedInHq(source);
			});
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			const landed = await publish(doc, [
				{
					kind: "app",
					novaResourceId: APP,
					observedDigest: moved?.observedDigest ?? fail(),
				},
			]);
			expect(landed).toMatchObject({
				landed: true,
				appPreviewNote: APP_PREVIEW_NOTE,
			});
			expect(hqChangesCheck(landed)).toMatchObject({
				status: "passed",
				detail: HQ_CHANGES_CONFIRMED_DETAIL,
				items: [doc.appName],
			});
		});
		expect(
			await h
				.db()
				.selectFrom("app_deployment_baselines")
				.select(["origin", "discarded_by"])
				.executeTakeFirstOrThrow(),
		).toEqual({ origin: "push", discarded_by: ACTOR });
	});

	it("lands an app whose read back failed, and the next publish asks before writing over it", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			request(peer, SOURCE).reply(500, "");
			const landed = await publish(doc);
			expect(landed).toMatchObject({ landed: true });
			expect(landed.warnings).toContain(APP_READ_BACK_FAILED_WARNING);

			serve(peer, SOURCE, "source-live");
			expect(refusal(await publish(doc)).remoteChanges).toEqual([
				expect.objectContaining({
					kind: "app",
					parts: [],
					baselineKnown: false,
				}),
			]);
		});
		expect(BASELINE_UNKNOWN_SENTENCE).toBe(
			"Nova couldn't confirm what its last publish left here, so it can't tell whether anything changed.",
		);
	});

	it("fills a shell whose CommCare version was raised in HQ, and stops on one given a menu", async () => {
		const doc = await seed();
		const raised = (source: Record<string, unknown>) => {
			source.build_spec = {
				...(source.build_spec as Record<string, unknown>),
				version: "2.60.0",
			};
		};
		await withPeer(async (peer) => {
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			request(peer, IMPORT, "POST").reply(500, "");
			expect(refusal(await publish(doc)).phase).toBe("upload");

			const live = retainedBodyJson(retainedPublishRead("source-live"));
			serveEdited(peer, SOURCE, "source-shell", (source) => {
				source.modules = live.modules;
				source._attachments = live._attachments;
			});
			expect(refusal(await publish(doc)).remoteChanges).toEqual([
				expect.objectContaining({
					kind: "app",
					parts: ["The list of menus"],
					baselineKnown: true,
				}),
			]);

			serveEdited(peer, SOURCE, "source-shell", raised);
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect(await publish(doc)).toMatchObject({
				landed: true,
				hqAppAction: "created",
				appPreviewNote: null,
			});
		});
	});

	it("carries the App Preview statement on the first publish over a baseline the cutover recorded", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect((await publish(doc)).landed).toBe(true);
			await h
				.db()
				.updateTable("app_deployment_baselines")
				.set({ origin: "cutover" })
				.execute();
			serve(peer, SOURCE, "source-live");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect(await publish(doc)).toMatchObject({
				landed: true,
				appPreviewNote: APP_PREVIEW_NOTE,
			});
		});
	});

	it("stops at the upload when the app's compared keys moved during the push, and not when only an ignored key did", async () => {
		const doc = await seed(await lookupDocument());
		await withPeer(async (peer) => {
			emptyTables(peer);
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			workbookTaken(peer);
			tablesAfterPush(peer);
			tableRows(peer);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect((await publish(doc)).landed).toBe(true);

			const republish = (
				secondRead: (source: Record<string, unknown>) => void,
			) => {
				tablesAfterPush(peer);
				tableRows(peer);
				serve(peer, SOURCE, "source-live");
				workbookTaken(peer);
				tablesAfterPush(peer);
				tableRows(peer);
				serveEdited(peer, SOURCE, "source-live", secondRead);
			};
			republish(savedInHq);
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect((await publish(doc)).landed).toBe(true);

			republish(renamedInHq);
			const stopped = refusal(await publish(doc));
			expect(stopped).toEqual(
				expect.objectContaining({
					phase: "upload",
					failure: {
						code: "hq_changed",
						message: HQ_CHANGED_DURING_PUSH_MESSAGE,
						details: [],
					},
					remoteChanges: [],
				}),
			);
		});
	});

	it("stops at the upload when the shell this publish made is given a menu during the push", async () => {
		const doc = await seed(await lookupDocument());
		const live = retainedBodyJson(retainedPublishRead("source-live"));
		await withPeer(async (peer) => {
			emptyTables(peer);
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			workbookTaken(peer);
			tablesAfterPush(peer);
			tableRows(peer);
			serveEdited(peer, SOURCE, "source-shell", (source) => {
				source.modules = live.modules;
				source._attachments = live._attachments;
			});
			const stopped = refusal(await publish(doc));
			expect(stopped).toEqual(
				expect.objectContaining({
					phase: "upload",
					failure: {
						code: "hq_changed",
						message: HQ_CHANGED_DURING_PUSH_MESSAGE,
						details: [],
					},
					remoteChanges: [],
				}),
			);
			/* The create is the one import; the content is never sent. */
			expect(
				requests(peer).filter((sent) => sent === `POST ${IMPORT}`),
			).toHaveLength(1);
		});
	});

	it("stops on a table CommCare HQ no longer has, and makes it again once a person publishes over that", async () => {
		const doc = await seed(await lookupDocument());
		await withPeer(async (peer) => {
			emptyTables(peer);
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			workbookTaken(peer);
			tablesAfterPush(peer);
			tableRows(peer);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect((await publish(doc)).landed).toBe(true);

			emptyTables(peer);
			serve(peer, SOURCE, "source-live");
			const stopped = refusal(await publish(doc));
			expect(stopped.remoteChanges).toEqual([
				{
					kind: "lookup-table",
					novaResourceId: expect.any(String),
					name: "Facilities",
					identity: "facilities",
					parts: [
						"CommCare HQ no longer has this table. Publishing makes it again.",
					],
					note: null,
					observedDigest: ABSENT_RESOURCE_DIGEST,
					baselineKnown: true,
					since: { kind: "published" },
					canBringIn: false,
				},
			]);
			const [table] = stopped.remoteChanges;

			emptyTables(peer);
			serve(peer, SOURCE, "source-live");
			workbookTaken(peer);
			tablesAfterPush(peer);
			tableRows(peer);
			serve(peer, SOURCE, "source-live");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect(
				await publish(doc, [
					{
						kind: "lookup-table",
						novaResourceId: table?.novaResourceId ?? fail(),
						observedDigest: ABSENT_RESOURCE_DIGEST,
					},
				]),
			).toMatchObject({ landed: true, appPreviewNote: null });
		});
		expect(
			await h
				.db()
				.selectFrom("project_space_resource_baselines")
				.select(["origin", "discarded_digest", "discarded_by"])
				.executeTakeFirstOrThrow(),
		).toEqual({
			origin: "push",
			discarded_digest: ABSENT_RESOURCE_DIGEST,
			discarded_by: ACTOR,
		});
	});

	it("refuses with the table's own sentence when its rows cannot be read", async () => {
		const doc = await seed(await lookupDocument());
		await withPeer(async (peer) => {
			emptyTables(peer);
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			workbookTaken(peer);
			tablesAfterPush(peer);
			tableRows(peer);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect((await publish(doc)).landed).toBe(true);

			tablesAfterPush(peer);
			request(peer, ROWS).reply(500, "");
			expect(refusal(await publish(doc))).toMatchObject({
				phase: "preflight",
				failure: {
					code: "hq_resource_state_unknown",
					message:
						"Nova couldn't read the rows of the lookup table “Facilities” on “clinic”, so it can't tell whether they changed in CommCare HQ since its last publish, and it stopped before sending anything. A row there with an empty value can cause this; filling that value in CommCare HQ, or trying again in a moment, lets the next publish read it.",
				},
				remoteChanges: [],
			});
		});
	});
});

// ── What a download made for a published project space reads ───────────

describe("the deployment facts a download reads", () => {
	const visible = {
		meta: { total_count: 1 },
		objects: [{ domain_name: "clinic", project_name: "Clinic" }],
	};
	const none = { meta: { total_count: 0 }, objects: [] };
	/** HQ's two project-space lists: every space, then those holding the flag. */
	function projectSpaces(peer: MockAgent, flag: "on" | "off" | "refused") {
		request(peer, PROJECT_SPACES).reply(200, visible);
		const filtered = request(peer, EMPTY_LIST_FLAG);
		if (flag === "refused") filtered.reply(500, "");
		else filtered.reply(200, flag === "on" ? visible : none);
	}
	async function republish(doc: BlueprintDoc, peer: MockAgent) {
		serve(peer, SOURCE, "source-live");
		accepted(peer, 200);
		serve(peer, SOURCE, "source-live");
		return publish(doc);
	}
	async function download(doc: BlueprintDoc) {
		const chosen = await resolveDownloadTarget(SCOPE, { format: "ccz", doc });
		if (!("format" in chosen) || chosen.format !== "ccz")
			throw new Error(`Expected a CCZ target, got ${JSON.stringify(chosen)}`);
		return chosen;
	}

	it("records the empty-list text flag each publish reads, keeps it over a refused read, and hands it to the download", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			projectSpaces(peer, "on");
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect((await publish(doc)).landed).toBe(true);
			expect(allRequests(peer)).toContain(`GET ${EMPTY_LIST_FLAG}`);
			expect((await state())?.deployment.targetEmptyCaseListText).toBe(true);
			expect((await download(doc)).target.emptyCaseListText).toBe(true);

			// A refused read never blocks, and never erases an earlier answer.
			projectSpaces(peer, "refused");
			expect((await republish(doc, peer)).landed).toBe(true);
			expect((await state())?.deployment.targetEmptyCaseListText).toBe(true);

			projectSpaces(peer, "off");
			expect((await republish(doc, peer)).landed).toBe(true);
			expect((await state())?.deployment.targetEmptyCaseListText).toBe(false);
			expect((await download(doc)).target.emptyCaseListText).toBe(false);
		});
	});

	it("makes the file for a project space whose HQ app was made afresh newer at an unchanged sequence", async () => {
		const doc = await seed();
		const archive = async () => {
			const chosen = await download(doc);
			const profile = readXmlEvidence(
				new AdmZip(
					compileCcz(
						expandDoc(doc, {
							runtimeTarget: chosen.runtimeTarget,
							identity: chosen.identity,
						}),
						doc.appName,
						doc,
						{
							runtimeTarget: chosen.runtimeTarget,
							compiledAtSeq: 5,
							earlierHqApps: chosen.target.earlierHqApps,
						},
					),
				).readAsText("profile.ccpr"),
			);
			const property = (key: string) =>
				profile.children.find(
					(node) => node.name === "property" && node.attributes.key === key,
				)?.attributes.value;
			return {
				chosen,
				version: profile.attributes.version,
				suite: profile.children
					.filter((node) => node.name === "suite")
					.map((node) => node.children[0]?.attributes.version),
				postUrl: property("PostURL"),
				restoreUrl: property("ota-restore-url"),
				uniqueId: profile.attributes.uniqueid,
			};
		};
		await withPeer(async (peer) => {
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect((await publish(doc)).landed).toBe(true);
			const before = await archive();
			expect(before.chosen.target).toMatchObject({
				hqAppId: HQ_APP,
				earlierHqApps: 0,
			});
			expect([before.version, ...before.suite]).toEqual(["5", "5", "5"]);

			serve(peer, SOURCE, "source-deleted");
			expect((await publish(doc)).landed).toBe(false);
			accepted(peer, 201, "replacement-app");
			serve(peer, sourcePath("replacement-app"), "source-shell");
			accepted(peer, 200, "replacement-app");
			serve(peer, sourcePath("replacement-app"), "source-live");
			expect((await publish(doc)).landed).toBe(true);

			const after = await archive();
			expect(after.chosen.target).toMatchObject({
				hqAppId: "replacement-app",
				earlierHqApps: 1,
			});
			expect([after.version, ...after.suite]).toEqual(["6", "6", "6"]);
			expect(after.postUrl).toContain("/receiver/replacement-app/");
			expect(after.restoreUrl).toContain("/phone/restore/replacement-app/");
			expect(after.uniqueId).toBe(before.uniqueId);
		});
	});
});

// ── Where CommCare HQ keeps each case change ─────────────────────────────

describe("the placements a publish records", () => {
	const reloadHead = reloadHeadFor(APP, ACTOR);
	/** Every confirmation but Save to Case, which a move offer can answer. */
	const CONFIRM_BUT_SAVE_TO_CASE = CONFIRM_ALL.filter(
		(key) =>
			!(key.kind === "plan-feature" && key.subject === "advanced-case-actions"),
	);

	/** A publish of the app's head as it stands, as the routes read it. */
	async function publishHead(
		extra: Partial<
			Pick<
				PublishInput,
				"acceptPlacementMoves" | "confirm" | "reloadHead" | "onUploadStarted"
			>
		> & { readonly head?: { doc: BlueprintDoc; seq: number } } = {},
	): Promise<PublishOutcome> {
		const { head = await reloadHead(), ...rest } = extra;
		return publishAppToHq({
			requireHqImport: null,
			scope: SCOPE,
			...TARGET,
			doc: head.doc,
			compiledAtSeq: head.seq,
			reloadHead,
			appName: head.doc.appName,
			confirm: CONFIRM_ALL,
			...rest,
		});
	}

	function edit(mutations: readonly Mutation[]) {
		return commitGuardedBatchProposal({
			appId: APP,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations,
			actorUserId: ACTOR,
			kind: "autosave",
		});
	}

	async function changeKinds(): Promise<{ seq: number; kind: string }[]> {
		const rows = await h
			.db()
			.selectFrom("app_changes")
			.select(["seq", "kind"])
			.where("app_id", "=", APP)
			.orderBy("seq")
			.execute();
		return rows.map((row) => ({ seq: Number(row.seq), kind: row.kind }));
	}

	async function holdsNow() {
		const { doc } = await reloadHead();
		return [...readPlacementHolds(doc).values()];
	}

	/** The shell read, set below CommCare 2.57. */
	function shellBelowFloor(peer: MockAgent) {
		const answer = retainedPublishRead("source-shell");
		const source = retainedBodyJson(answer);
		source.build_spec = {
			...(source.build_spec as Record<string, unknown>),
			version: "2.53.0",
		};
		replyRetained(request(peer, SOURCE), {
			...answer,
			body: JSON.stringify(source),
		});
	}

	/** A first publish's requests: the shell, its read, the fill, its read. */
	function firstPublishAnswers(peer: MockAgent) {
		accepted(peer, 201);
		serve(peer, SOURCE, "source-shell");
		accepted(peer, 200);
		serve(peer, SOURCE, "source-after-create-then-update");
	}
	const FIRST_PUBLISH = [
		`POST ${IMPORT}`,
		`GET ${SOURCE}`,
		`POST ${IMPORT}`,
		`GET ${SOURCE}`,
	];

	it("a first publish records its placements before the shell create, with nothing sent at the record", async () => {
		const app = heldPlacementApp();
		await seed(app.doc);
		await withPeer(async (peer) => {
			let sentAtUploadStart: string[] | null = null;
			let changesAtCreate: { seq: number; kind: string }[] | null = null;
			request(peer, IMPORT, "POST").reply(async () => {
				changesAtCreate = await changeKinds();
				saves.create(HQ_APP);
				return {
					statusCode: 201,
					data: JSON.stringify({ success: true, app_id: HQ_APP }),
				};
			});
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-after-create-then-update");

			const outcome = await publishHead({
				onUploadStarted: () => {
					sentAtUploadStart = requests(peer);
				},
			});
			expect(outcome).toMatchObject({
				landed: true,
				placements: { recorded: 2, moved: 0 },
			});
			expect(requests(peer)).toEqual(FIRST_PUBLISH);
			// The record had landed when the shell was made, and nothing had
			// been sent once it had.
			expect(changesAtCreate).toEqual([{ seq: 1, kind: "publish-placement" }]);
			expect(sentAtUploadStart).toEqual([]);
		});
		expect(await holdsNow()).toEqual([
			operationHold(app, app.own.uuid, app.ownBasic),
			operationHold(app, app.kid.uuid, {
				kind: "basic",
				slot: "subcase",
				index: 0,
			}),
		]);
	});

	it("pushed_revision and the manifest's sequence are the record's", async () => {
		await seed(heldPlacementApp().doc);
		await withPeer(async (peer) => {
			firstPublishAnswers(peer);
			expect((await publishHead()).landed).toBe(true);
		});
		expect(activeRemoteApp((await state()) ?? fail())).toMatchObject({
			pushedRevision: 1,
		});
		const row = await h
			.db()
			.selectFrom("app_deployments")
			.select("entry_point_manifest")
			.executeTakeFirstOrThrow();
		expect(row.entry_point_manifest).toMatchObject({ sourceSequence: 1 });
	});

	it("an autosave restoring the hold the publish recorded is admitted after the publish", async () => {
		const app = heldPlacementApp();
		await seed(app.doc);
		await withPeer(async (peer) => {
			firstPublishAnswers(peer);
			expect((await publishHead()).landed).toBe(true);
		});
		const recorded: CasePlacement = {
			kind: "basic",
			slot: "subcase",
			index: 0,
		};
		await edit([removeKid(app)]);
		await edit([
			addKid(app),
			holdPlacements(operationHold(app, app.kid.uuid, recorded)),
		]);
		expect(await holdsNow()).toContainEqual(
			operationHold(app, app.kid.uuid, recorded),
		);
		expect((await changeKinds()).map((change) => change.kind)).toEqual([
			"publish-placement",
			"autosave",
			"autosave",
		]);
	});

	it("a head moved once reads the head again, preflights and sends", async () => {
		const app = heldPlacementApp();
		await seed(app.doc);
		const emitted = await reloadHead();
		await edit([{ kind: "setAppName", name: "Renamed" }]);
		let reloads = 0;
		await withPeer(async (peer) => {
			firstPublishAnswers(peer);
			const outcome = await publishHead({
				head: emitted,
				reloadHead: async () => {
					reloads += 1;
					return reloadHead();
				},
			});
			expect(outcome).toMatchObject({
				landed: true,
				placements: { recorded: 2, moved: 0 },
			});
			expect(requests(peer)).toEqual(FIRST_PUBLISH);
		});
		expect(reloads).toBe(1);
		expect(await changeKinds()).toEqual([
			{ seq: 1, kind: "autosave" },
			{ seq: 2, kind: "publish-placement" },
		]);
		expect(activeRemoteApp((await state()) ?? fail())).toMatchObject({
			pushedRevision: 2,
		});
	});

	it("a head moved three times refuses app_changed_while_publishing with nothing sent", async () => {
		const app = heldPlacementApp();
		await seed(app.doc);
		const emitted = await reloadHead();
		await edit([{ kind: "setAppName", name: "Renamed once" }]);
		let reloads = 0;
		await withPeer(async (peer) => {
			const outcome = await publishHead({
				head: emitted,
				/* Someone saves again each time the publish reads the head. */
				reloadHead: async () => {
					reloads += 1;
					const head = await reloadHead();
					await edit([{ kind: "setAppName", name: `Renamed ${reloads}` }]);
					return head;
				},
			});
			expect(refusal(outcome)).toEqual({
				phase: "preflight",
				failure: {
					code: "app_changed_while_publishing",
					message:
						"This app kept changing while Nova got it ready to publish, so nothing was sent. Publish again once the edits settle.",
					details: [],
				},
				resourceConflicts: [],
				remoteChanges: [],
				confirmationsNeeded: [],
				webAppsChange: null,
				placementMoves: null,
			});
			expect(outcome).toMatchObject({
				deployment: null,
				placements: { recorded: 0, moved: 0 },
			});
			expect(requests(peer)).toEqual([]);
		});
		expect(reloads).toBe(2);
		expect((await changeKinds()).map((change) => change.kind)).toEqual([
			"autosave",
			"autosave",
			"autosave",
		]);
		expect(await holdsNow()).toEqual([]);
		expect(await state()).toBeNull();
	});

	it("a version-floor stop keeps the holds", async () => {
		const app = heldPlacementApp();
		await seed(app.doc);
		await withPeer(async (peer) => {
			accepted(peer, 201);
			shellBelowFloor(peer);
			const outcome = await publishHead();
			expect(refusal(outcome)).toMatchObject({
				phase: "resources",
				failure: { code: "hq_app_version_below_floor" },
			});
			expect(outcome.placements).toEqual({ recorded: 2, moved: 0 });
		});
		expect(await changeKinds()).toEqual([
			{ seq: 1, kind: "publish-placement" },
		]);
		expect(await holdsNow()).toHaveLength(2);
	});

	/** The app with its own case and its kid both held in Save to Case blocks. */
	function savedToCase() {
		return heldPlacementApp((a) => {
			holdOperation(a, a.own.uuid, a.ownSaveToCase);
			holdOperation(a, a.kid.uuid, a.kidSaveToCase);
		});
	}

	it("an accepted Save to Case offer records, drops the need and lands in one request", async () => {
		const app = savedToCase();
		await seed(app.doc);
		await withPeer(async (peer) => {
			const asked = refusal(
				await publishHead({ confirm: CONFIRM_BUT_SAVE_TO_CASE }),
			);
			expect(asked.failure.code).toBe("hq_confirmation_needed");
			expect(asked.confirmationsNeeded).toEqual([
				expect.objectContaining({
					kind: "plan-feature",
					subject: "advanced-case-actions",
					whereMissing:
						"Where the plan doesn't include it, Nova can move these case changes to CommCare HQ's Case Management settings, which every plan keeps. Choose that when you publish.",
				}),
			]);
			const offer = asked.placementMoves ?? fail();
			expect(offer).toMatchObject({
				reason: "save-to-case",
				asksChildCases: true,
				moves: [
					{
						form: "Visit",
						change: "saves to this form's patient case",
						sentence:
							"In Visit, the change that saves to this form's patient case moves from a Save to Case block to Case Management.",
					},
					{
						form: "Visit",
						change: "makes a new kid case",
						sentence:
							"In Visit, the change that makes a new kid case moves from a Save to Case block to Case Management.",
					},
				],
			});
			const { doc } = await reloadHead();
			expect(
				(await projectSpaceConfirmations(SCOPE, doc, TARGET)).placement_moves,
			).toEqual(offer);
			expect(requests(peer)).toEqual([]);

			firstPublishAnswers(peer);
			const outcome = await publishHead({
				confirm: CONFIRM_BUT_SAVE_TO_CASE,
				acceptPlacementMoves: { reason: offer.reason, digest: offer.digest },
			});
			expect(outcome).toMatchObject({
				landed: true,
				placements: { recorded: 2, moved: 2 },
			});
			expect(requests(peer)).toEqual(FIRST_PUBLISH);
		});
		expect(await holdsNow()).toEqual([
			operationHold(app, app.own.uuid, app.ownBasic),
			operationHold(app, app.kid.uuid, {
				kind: "basic",
				slot: "subcase",
				index: 0,
			}),
		]);
		expect((await state())?.confirmations ?? fail()).not.toContainEqual(
			expect.objectContaining({ subject: "advanced-case-actions" }),
		);
	});

	it("a stale digest refuses hq_placement_moves_changed with the current offer", async () => {
		const app = savedToCase();
		await seed(app.doc);
		await withPeer(async (peer) => {
			const shown =
				refusal(await publishHead({ confirm: CONFIRM_BUT_SAVE_TO_CASE }))
					.placementMoves ?? fail();
			await edit([removeKid(app)]);

			const outcome = await publishHead({
				confirm: CONFIRM_BUT_SAVE_TO_CASE,
				acceptPlacementMoves: { reason: shown.reason, digest: shown.digest },
			});
			const sentence =
				"In Visit, the change that saves to this form's patient case moves from a Save to Case block to Case Management.";
			expect(refusal(outcome)).toMatchObject({
				phase: "preflight",
				failure: {
					code: "hq_placement_moves_changed",
					message:
						"The case changes Nova offered to move have changed since you agreed, so nothing was moved or sent. Here's what would move now.",
					details: [sentence],
				},
				placementMoves: {
					reason: "save-to-case",
					moves: [{ sentence }],
					asksChildCases: false,
				},
			});
			expect(refusal(outcome).placementMoves?.digest).not.toBe(shown.digest);
			expect(outcome.placements).toEqual({ recorded: 0, moved: 0 });
			expect(requests(peer)).toEqual([]);
		});
		expect((await changeKinds()).map((change) => change.kind)).toEqual([
			"autosave",
		]);
		expect(await holdsNow()).toEqual([
			operationHold(app, app.own.uuid, app.ownSaveToCase),
		]);
	});

	it("a retry naming an offer already recorded goes on", async () => {
		const app = savedToCase();
		await seed(app.doc);
		await withPeer(async (peer) => {
			const offer =
				refusal(await publishHead({ confirm: CONFIRM_BUT_SAVE_TO_CASE }))
					.placementMoves ?? fail();
			const accept = { reason: offer.reason, digest: offer.digest };

			accepted(peer, 201);
			shellBelowFloor(peer);
			const stopped = await publishHead({
				confirm: CONFIRM_BUT_SAVE_TO_CASE,
				acceptPlacementMoves: accept,
			});
			expect(refusal(stopped).failure.code).toBe("hq_app_version_below_floor");
			expect(stopped.placements).toEqual({ recorded: 2, moved: 2 });

			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-after-create-then-update");
			const retried = await publishHead({
				confirm: CONFIRM_BUT_SAVE_TO_CASE,
				acceptPlacementMoves: accept,
			});
			expect(retried).toMatchObject({
				landed: true,
				placements: { recorded: 0, moved: 0 },
			});
		});
		expect(await changeKinds()).toEqual([
			{ seq: 1, kind: "publish-placement" },
		]);
	});
});

// ── An app Nova brought in from CommCare HQ ─────────────────────────────

/** When the app was brought in: the evening of the 10th in UTC, the 11th in Auckland. */
const ADOPTED_AT = "2026-11-10T23:30:00.000Z";
const ADOPTED_IDS = {
	menu: "a".repeat(32),
	form: "b".repeat(32),
	xmlns:
		"http://openrosa.org/formdesigner/5A2C1F0E-0000-4000-8000-0000000000AB",
};
/** The file CommCare HQ held at a published path when the app was brought in. */
const HELD_MEDIA_FILES = { "commcare/image/logo.png": "hq-file-1" };
const CREDENTIALS = {
	username: "account",
	apiKey: "fixture-key",
	server: "india" as const,
};
/** A member who may stop publishing, beside the editor who publishes. */
const ADMIN = "admin";
const ADMIN_SCOPE = { ...SCOPE, actorUserId: ADMIN, role: "admin" };
const SEED_KEY = "cc-autoup-freq";
const withoutSeed = (source: Record<string, unknown>) => {
	const profile = source.profile as { properties: Record<string, unknown> };
	delete profile.properties[SEED_KEY];
};
const renamedLanguage = (source: Record<string, unknown>) => {
	source.translations = { en: { en: "Inglés" } };
};

/**
 * Leave the deployment the first publish made as a bring-in of that HQ app
 * leaves one: the mapping `adopted` by the editor at `ADOPTED_AT`, one
 * identity row for the menu and one for the form holding the ids CommCare
 * HQ's app holds, and a `read` baseline of the source as `adoption.ts`
 * builds it over the source the peer answers now (`edit` applied), with the
 * file CommCare HQ held at a published path and the reviewed list. The
 * document's media resolve through `assets`, at the paths HQ keeps them under.
 */
async function bringIn(
	peer: MockAgent,
	doc: BlueprintDoc,
	edit: (source: Record<string, unknown>) => void = () => {},
	assets: AssetManifest = new Map(),
) {
	const deployment = (await state()) ?? fail();
	const id = deployment.deployment.id;
	const module = doc.modules[doc.moduleOrder[0]];
	const form = doc.forms[doc.formOrder[module.uuid][0]];
	await h
		.db()
		.insertInto("app_deployment_identities")
		.values([
			{
				deployment_id: id,
				entity_kind: "module",
				nova_entity_uuid: module.uuid,
				unique_id: ADOPTED_IDS.menu,
				xmlns: null,
			},
			{
				deployment_id: id,
				entity_kind: "form",
				nova_entity_uuid: form.uuid,
				unique_id: ADOPTED_IDS.form,
				xmlns: ADOPTED_IDS.xmlns,
			},
		])
		.execute();
	await h
		.db()
		.updateTable("app_deployment_resources")
		.set({ ownership: "adopted", adopted_at: ADOPTED_AT, adopted_by: ACTOR })
		.where("deployment_id", "=", id)
		.where("kind", "=", "app")
		.where("superseded_at", "is", null)
		.execute();
	serveEdited(peer, SOURCE, "source-live", edit);
	const read = await readHqAppSource(CREDENTIALS, TARGET.domain, HQ_APP);
	if ("success" in read || read.kind !== "source") {
		throw new Error("The peer answered no source to bring in.");
	}
	const write = adoptedAppBaselineWrite({
		remoteAppId: HQ_APP,
		source: read.source,
		prepared: {
			doc,
			assets,
			attachmentTarget: attachmentUrlTarget(TARGET),
		},
		target: TARGET,
		identity: targetWireIdentity(
			(await readTargetIdentity(SCOPE, TARGET)).entities,
		),
		novaRevision: 0,
		mediaFiles: HELD_MEDIA_FILES,
		observedAt: ADOPTED_AT,
		firstPublish: {
			ids: ["forms-and-settings-rewritten"],
			touchesWorkers: false,
			of: "first-publish",
		},
	});
	const list =
		write.firstPublish.kind === "set" ? write.firstPublish.list : null;
	await h
		.db()
		.updateTable("app_deployment_baselines")
		.set({
			origin: "read",
			source_gzip: write.sourceGzip,
			source_bytes: write.sourceBytes,
			source_digest: write.sourceDigest,
			ownership: JSON.stringify(write.ownership),
			observed_at: ADOPTED_AT,
			nova_revision: write.novaRevision,
			media_files: JSON.stringify(HELD_MEDIA_FILES),
			first_publish_changes: JSON.stringify(list),
		})
		.where("deployment_id", "=", id)
		.execute();
	return write;
}

/** The first publish of a survey, Nova-created, over the peer: shell, read, fill, read back. */
async function publishFresh(
	peer: MockAgent,
	doc: BlueprintDoc,
	readBack: (source: Record<string, unknown>) => void = () => {},
) {
	accepted(peer, 201);
	serve(peer, SOURCE, "source-shell");
	accepted(peer, 200);
	serveEdited(peer, SOURCE, "source-live", readBack);
	expect((await publish(doc)).landed).toBe(true);
}

async function baselineRow() {
	return h
		.db()
		.selectFrom("app_deployment_baselines")
		.select([
			"origin",
			"ownership",
			"nova_revision",
			"media_files",
			"first_publish_changes",
		])
		.executeTakeFirstOrThrow();
}

describe("a publish over an app Nova brought in", () => {
	it("updates the app it came from under the ids HQ holds, keeps the mapping adopted, records the files it publishes, and says so", async () => {
		const doc = await seed();
		const bodies: { appId: unknown; app: Record<string, unknown> }[] = [];
		const read = await withPeer(async (peer) => {
			await publishFresh(peer, doc);
			const write = await bringIn(peer, doc);
			const sent = requests(peer).length;

			serve(peer, SOURCE, "source-live");
			accepted(peer, 200, HQ_APP, bodies);
			serve(peer, SOURCE, "source-live");
			const outcome = await publish(doc);
			expect(outcome).toMatchObject({
				landed: true,
				hqAppAction: "updated",
				appPreviewNote: APP_PREVIEW_NOTE,
			});
			expect(hqChangesCheck(outcome)).toMatchObject({
				status: "passed",
				detail:
					"Nothing in this app has changed in CommCare HQ since Nova brought it in on 10 November 2026.",
			});
			// No shell: the target-app read, the update, the read back.
			expect(requests(peer).slice(sent)).toEqual([
				`GET ${SOURCE}`,
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
			]);
			return write;
		});

		const [update] = bodies;
		expect(update.appId).toBe(HQ_APP);
		expect(update.app.modules).toMatchObject([
			{
				unique_id: ADOPTED_IDS.menu,
				forms: [{ unique_id: ADOPTED_IDS.form, xmlns: ADOPTED_IDS.xmlns }],
			},
		]);
		const mapping = activeRemoteApp((await state()) ?? fail()) ?? fail();
		expect(mapping).toMatchObject({
			remoteId: HQ_APP,
			ownership: "adopted",
			adoptedBy: ACTOR,
		});
		expect(new Date(mapping.adoptedAt ?? fail()).toISOString()).toBe(
			ADOPTED_AT,
		);
		const baseline = await baselineRow();
		expect(baseline).toMatchObject({
			origin: "push",
			/* The app publishes no file, so the record its upload earns holds
			 * none of the paths the bring-in recorded. */
			media_files: {},
			first_publish_changes: null,
		});
		expect(Number(baseline.nova_revision)).toBe(mapping.pushedRevision);
		/* An app with no Search: the body the publish sent owns what the
		 * bring-in's descriptor owns. */
		expect(baseline.ownership).toEqual(read.ownership);
	});

	it("says App Preview may keep refusing the app after a publish over changes brought in from CommCare HQ", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			await publishFresh(peer, doc);
			await bringIn(peer, doc);
			/* The baseline a bring-in of changes made in CommCare HQ leaves: the
			 * forms CommCare HQ's builder saved there are its own. */
			await h
				.db()
				.updateTable("app_deployment_baselines")
				.set({ origin: "changes" })
				.execute();
			serve(peer, SOURCE, "source-live");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect(await publish(doc)).toMatchObject({
				landed: true,
				appPreviewNote: APP_PREVIEW_NOTE,
			});
		});
	});

	it("sends each media file at the path CommCare HQ keeps it under, and a kept keyed create under the prefix the project space's cases stand under", async () => {
		const doc = caseOperationFixture("key");
		const [{ formUuid, create }] = Object.entries(doc.forms).flatMap(
			([uuid, form]) =>
				(form.caseOperations ?? []).flatMap((operation) =>
					operation.action === "create" &&
					operation.target.kind === "new" &&
					operation.target.idFrom !== undefined
						? [{ formUuid: asUuid(uuid), create: operation }]
						: [],
				),
		);
		if (create.action !== "create") throw new Error("Expected a create");
		/* The prefix HQ's source app derived for that create, which the
		 * reading's own UUIDs cannot derive again. */
		const heldPrefix = authoredCaseIdPrefix({
			appId: "hq-source-app",
			formUuid,
			operationUuid: create.uuid,
			caseType: create.caseType,
		});
		const derivedPrefix = authoredCaseIdPrefix({
			appId: doc.appId,
			formUuid,
			operationUuid: create.uuid,
			caseType: create.caseType,
		});
		const heldPath = Object.keys(HELD_MEDIA_FILES)[0];
		const image = testMediaAssetId("held-image");
		const png = readFileSync("public/nova-icons/household.png");
		const hash = createHash("sha256").update(png).digest("hex");
		const field = Object.values(doc.fields).find(
			(candidate) => candidate.kind === "text",
		);
		if (field === undefined || field.kind !== "text")
			throw new Error("Expected a text field");
		field.label_media = { image };
		await seed(doc);
		await h
			.db()
			.insertInto("media_assets")
			.values({
				id: image,
				project_id: PROJECT,
				owner: "creator",
				kind: "image",
				content_hash: hash,
				mime_type: "image/png",
				extension: ".png",
				size_bytes: png.length,
				gcs_object_key: `projects/${PROJECT}/${hash}.png`,
				original_filename: "logo.png",
				display_name: "Logo",
				status: "ready",
				media_format: "png",
			})
			.execute();
		vi.mocked(downloadAssetBytes).mockResolvedValue(png);
		const media = `/a/clinic/apps/api/${HQ_APP}/multimedia/`;
		const zips: AdmZip[] = [];
		const mediaTaken = (peer: MockAgent) => {
			request(peer, media, "POST").reply(async (opts) => {
				const form = await readMultipartRequest(opts);
				const file = form.get("bulk_upload_file");
				if (!(file instanceof Blob)) throw new Error("Expected a ZIP");
				zips.push(new AdmZip(Buffer.from(await file.arrayBuffer())));
				return {
					statusCode: 200,
					data: JSON.stringify({ success: true, processing_id: "media-job" }),
				};
			});
			request(peer, `${media}status/media-job/`).reply(200, {
				success: true,
				processing_id: "media-job",
				complete: true,
				matched_count: 1,
				unmatched_count: 0,
				unmatched_files: [],
				errors: [],
			});
		};
		const bodies: { appId: unknown; app: Record<string, unknown> }[] = [];
		await withPeer(async (peer) => {
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			mediaTaken(peer);
			expect((await publish(doc)).landed).toBe(true);
			await bringIn(
				peer,
				doc,
				undefined,
				new Map([
					[
						image,
						{
							assetId: image,
							wirePath: heldPath,
							kind: "image",
							mimeType: "image/png",
							contentHash: hash,
							extension: ".png",
						},
					],
				]),
			);
			const id = ((await state()) ?? fail()).deployment.id;
			await h
				.db()
				.insertInto("app_deployment_media_paths")
				.values({
					deployment_id: id,
					media_asset_id: image,
					wire_path: heldPath,
				})
				.execute();
			await h
				.db()
				.insertInto("app_deployment_keyed_case_ids")
				.values({
					deployment_id: id,
					nova_operation_uuid: create.uuid,
					case_type: create.caseType,
					case_id_prefix: heldPrefix,
				})
				.execute();

			serve(peer, SOURCE, "source-live");
			accepted(peer, 200, HQ_APP, bodies);
			serve(peer, SOURCE, "source-live");
			/* The caller's document predates the placements the first publish
			 * recorded, so preflight reads the app once more over the head. */
			serve(peer, SOURCE, "source-live");
			mediaTaken(peer);
			expect((await publish(doc)).landed).toBe(true);
		});

		const [update] = bodies;
		const forms = Object.values(
			update.app._attachments as Record<string, unknown>,
		)
			.filter((value): value is string => typeof value === "string")
			.join("\n");
		expect(forms).toContain(heldPrefix);
		expect(forms).not.toContain(derivedPrefix);
		expect(forms).toContain(`jr://file/${heldPath}`);
		const [first, republished] = zips.map((zip) =>
			zip.getEntries().map((entry) => entry.entryName),
		);
		expect(first).not.toContain(heldPath);
		expect(republished).toEqual([heldPath]);
	});

	it("records the publish's own descriptor, which differs from the bring-in's only in the Search key, where the advisory is available", async () => {
		const doc = await seed(
			buildDoc({
				appName: "Patient search",
				caseTypes: [{ name: "patient", properties: [] }],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseSearchConfig: {},
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								name: "Visit",
								type: "followup",
								fields: [{ id: "note", kind: "text" }],
							},
						],
					},
				],
			}),
		);
		const read = await withPeer(async (peer) => {
			/* The project space holds Search and the large-Search setting, on
			 * every preflight. */
			const visible = {
				meta: { total_count: 1 },
				objects: [{ domain_name: "clinic", project_name: "Clinic" }],
			};
			request(peer, PROJECT_SPACES).reply(200, visible).persist();
			request(peer, `${PROJECT_SPACES}&feature_flag=search_claim`)
				.reply(200, visible)
				.persist();
			request(peer, `${PROJECT_SPACES}&feature_flag=custom_properties`)
				.reply(200, visible)
				.persist();
			request(
				peer,
				"/a/clinic/phone/search/?case_type=__nova_compatibility_probe__",
			)
				.reply(200, "<fixture/>", {
					headers: { "content-type": "text/xml; charset=utf-8" },
				})
				.persist();
			await publishFresh(peer, doc);
			/* The first publish recorded where CommCare HQ keeps the form's
			 * case change, so the app's head is the document it sent. */
			const head = await reloadHeadFor(APP, ACTOR)();
			const write = await bringIn(peer, head.doc);

			serve(peer, SOURCE, "source-live");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			const outcome = await publishAppToHq({
				requireHqImport: null,
				scope: SCOPE,
				...TARGET,
				doc: head.doc,
				compiledAtSeq: head.seq,
				reloadHead: reloadHeadFor(APP, ACTOR),
				appName: head.doc.appName,
				confirm: CONFIRM_ALL,
			});
			expect(outcome).toMatchObject({ landed: true });
			expect(outcome.projectSpaceCompatibility?.advisories).toEqual([
				expect.objectContaining({
					id: "large-search-performance",
					state: "available",
				}),
			]);
			return write;
		});
		const pushed = (await baselineRow()).ownership as Record<string, unknown>;
		const { profileCustomProperties: readCustom, ...readRest } =
			read.ownership ?? fail();
		const { profileCustomProperties: pushedCustom, ...pushedRest } = pushed;
		expect(pushedRest).toEqual(readRest);
		expect(pushedCustom).not.toEqual(readCustom);
	});

	it("keeps a language's name and a setting HQ holds no value for as HQ has them", async () => {
		const doc = await seed();
		const bodies: { appId: unknown; app: Record<string, unknown> }[] = [];
		await withPeer(async (peer) => {
			await publishFresh(peer, doc);
			await bringIn(peer, doc, withoutSeed);

			serveEdited(peer, SOURCE, "source-live", (source) => {
				withoutSeed(source);
				renamedLanguage(source);
			});
			accepted(peer, 200, HQ_APP, bodies);
			serve(peer, SOURCE, "source-live");
			expect((await publish(doc)).landed).toBe(true);
		});
		/* The body leaves the language names out, so CommCare HQ keeps the one
		 * it holds. */
		const [update] = bodies;
		expect(update.app).not.toHaveProperty("translations");
		/* A profile the body leaves out is CommCare HQ's as it holds it. */
		const profile = update.app.profile as
			| { properties: Record<string, unknown> }
			| undefined;
		expect(profile?.properties ?? {}).not.toHaveProperty(SEED_KEY);
	});

	it("compares a language's name and seeds a setting HQ holds no value for on a deployment Nova created", async () => {
		const doc = await seed();
		const bodies: { appId: unknown; app: Record<string, unknown> }[] = [];
		await withPeer(async (peer) => {
			await publishFresh(peer, doc, withoutSeed);

			const edited = (source: Record<string, unknown>) => {
				withoutSeed(source);
				renamedLanguage(source);
			};
			serveEdited(peer, SOURCE, "source-live", edited);
			const [change] = refusal(await publish(doc)).remoteChanges;
			expect(change).toMatchObject({
				kind: "app",
				baselineKnown: true,
				since: { kind: "published" },
			});
			expect(change?.parts.length).toBeGreaterThan(0);

			serveEdited(peer, SOURCE, "source-live", edited);
			accepted(peer, 200, HQ_APP, bodies);
			serve(peer, SOURCE, "source-live");
			expect(
				(
					await publish(doc, [
						{
							kind: "app",
							novaResourceId: APP,
							observedDigest: change?.observedDigest ?? fail(),
						},
					])
				).landed,
			).toBe(true);
		});
		const [update] = bodies;
		expect(update.app.translations).toMatchObject({ en: { en: "English" } });
		const profile = update.app.profile as {
			properties: Record<string, unknown>;
		};
		expect(profile.properties[SEED_KEY]).toBe("freq-never");
	});

	it("names the day it was brought in, in the reader's zone, when HQ's copy changed since", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			await publishFresh(peer, doc);
			await bringIn(peer, doc);
			const sent = requests(peer).length;

			serveEdited(peer, SOURCE, "source-live", renamedInHq);
			const utc = refusal(await publish(doc));
			const since = { kind: "brought-in", at: ADOPTED_AT };
			expect(utc).toMatchObject({
				failure: {
					code: "hq_changed",
					message:
						"Something in this app isn't the same in CommCare HQ as when Nova brought it in on 10 November 2026, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version.",
				},
				remoteChanges: [
					{ kind: "app", parts: ["The app's name"], since, canBringIn: false },
				],
			});

			serveEdited(peer, SOURCE, "source-live", renamedInHq);
			const auckland = refusal(
				await publishAppToHq({
					requireHqImport: null,
					scope: SCOPE,
					...TARGET,
					doc,
					compiledAtSeq: 0,
					reloadHead: reloadHeadFor(APP, ACTOR),
					appName: doc.appName,
					confirm: CONFIRM_ALL,
					driftDate: { locale: "en-GB", timeZone: "Pacific/Auckland" },
				}),
			);
			expect(auckland.failure.message).toContain(
				"as when Nova brought it in on 11 November 2026,",
			);
			expect(requests(peer).slice(sent)).toEqual([
				`GET ${SOURCE}`,
				`GET ${SOURCE}`,
			]);
		});
	});
});

describe("a publish while someone stops publishing there", () => {
	async function seedAdmin() {
		await h.seedProjectMember(ADMIN, PROJECT, "admin");
	}

	it("refuses publishing_stopped when the ending lands before anything is sent, and records nothing more", async () => {
		const doc = await seed();
		await seedAdmin();
		await withPeer(async (peer) => {
			await publishFresh(peer, doc);
			await bringIn(peer, doc);
			const sent = requests(peer).length;

			request(peer, SOURCE).reply(async () => {
				await stopHere(ADMIN_SCOPE, TARGET);
				const answer = retainedPublishRead("source-live");
				return {
					statusCode: answer.status,
					data: retainedBodyText(answer),
					responseOptions: { headers: { ...answer.headers } },
				};
			});
			const outcome = await publish(doc);
			expect(refusal(outcome)).toMatchObject({
				phase: "preflight",
				failure: {
					code: "publishing_stopped",
					message:
						"Someone stopped publishing this app to “clinic” while Nova was getting this publish ready, so nothing was sent. Publishing again makes a new app there.",
				},
			});
			expect(requests(peer).slice(sent)).toEqual([`GET ${SOURCE}`]);
			expect(outcome.deployment?.deployment).toMatchObject({
				state: "ended",
				endings: 1,
			});
		});
		const after = (await state()) ?? fail();
		expect(activeRemoteApp(after)).toBeNull();
		expect(deploymentEnding(after)).toMatchObject({
			reason: "stopped",
			hqAppId: HQ_APP,
		});
	});

	it("says CommCare HQ may hold what was sent when the ending lands during the import", async () => {
		const doc = await seed();
		await seedAdmin();
		await withPeer(async (peer) => {
			await publishFresh(peer, doc);
			await bringIn(peer, doc);

			serve(peer, SOURCE, "source-live");
			request(peer, IMPORT, "POST").reply(async () => {
				await stopHere(ADMIN_SCOPE, TARGET);
				return {
					statusCode: 200,
					data: JSON.stringify({
						success: true,
						app_id: HQ_APP,
						version: saves.save(HQ_APP),
					}),
				};
			});
			serve(peer, SOURCE, "source-live");
			expect(refusal(await publish(doc))).toMatchObject({
				phase: "upload",
				failure: {
					code: "publishing_stopped",
					message:
						"Someone stopped publishing this app to “clinic” while this publish was running. CommCare HQ may hold part of what this publish had already sent there. Publishing again makes a new app there.",
				},
			});
		});
		expect(activeRemoteApp((await state()) ?? fail())).toBeNull();
	});

	it("makes a new app with derived ids on the next publish, and an attempt stopped before its create still stands at the ending", async () => {
		const doc = await seed();
		await seedAdmin();
		const module = doc.modules[doc.moduleOrder[0]];
		const form = doc.forms[doc.formOrder[module.uuid][0]];
		const bodies: { appId: unknown; app: Record<string, unknown> }[] = [];
		await withPeer(async (peer) => {
			await publishFresh(peer, doc);
			await bringIn(peer, doc);
			await stopHere(ADMIN_SCOPE, TARGET);

			/* HQ refuses the create: the attempt passed preflight, made no app,
			 * and the deployment still stands at its ending. */
			request(peer, IMPORT, "POST").reply(500, "");
			expect(refusal(await publish(doc)).phase).toBe("resources");
			const stopped = (await state()) ?? fail();
			expect(stopped.deployment.state).not.toBe("ended");
			expect(deploymentEnding(stopped)).toMatchObject({ hqAppId: HQ_APP });
			expect(nextPublishAction(stopped)).toBe("creates-beside");

			accepted(peer, 201, "fresh-app");
			serve(peer, sourcePath("fresh-app"), "source-shell");
			accepted(peer, 200, "fresh-app", bodies);
			serve(peer, sourcePath("fresh-app"), "source-live");
			expect(await publish(doc)).toMatchObject({
				landed: true,
				hqAppAction: "created",
			});
		});
		const [update] = bodies;
		expect(update.app.modules).toMatchObject([
			{
				unique_id: derivedUniqueId(module.uuid),
				forms: [
					{
						unique_id: derivedUniqueId(form.uuid),
						xmlns: derivedFormXmlns(form.uuid),
					},
				],
			},
		]);
		const after = (await state()) ?? fail();
		expect(after.deployment.state).toBe("uploaded");
		expect(activeRemoteApp(after)).toMatchObject({
			remoteId: "fresh-app",
			ownership: "nova-created",
		});
		expect(deploymentEnding(after)).toBeNull();
		expect(nextPublishAction(after)).toBe("updates");
	});
});

describe("a publish over an app another Nova app took while this one was in recently deleted", () => {
	it("settles the released mapping before asking CommCare HQ anything, and Preview names the project space only after", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			await publishFresh(peer, doc);
			await h
				.db()
				.updateTable("app_deployment_resources")
				.set({ released_at: new Date() })
				.where("kind", "=", "app")
				.where("superseded_at", "is", null)
				.execute();
			expect(await previewProjectSpaceFor(SCOPE)).toBeNull();

			const releasedAtFirstRead: (string | null)[] = [];
			request(peer, SOURCE).reply(async () => {
				const mapping = activeRemoteApp((await state()) ?? fail());
				releasedAtFirstRead.push(mapping?.releasedAt ?? null);
				const answer = retainedPublishRead("source-live");
				return {
					statusCode: answer.status,
					data: retainedBodyText(answer),
					responseOptions: { headers: { ...answer.headers } },
				};
			});
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect(await publish(doc)).toMatchObject({
				landed: true,
				hqAppAction: "updated",
			});
			expect(releasedAtFirstRead).toEqual([null]);
		});
		expect(await previewProjectSpaceFor(SCOPE)).toBe(TARGET.domain);
	});
});

// ── CommCare HQ's save counter binds what a publish records ─────────────

describe("the save counter a publish's reads are bound to", () => {
	/** A retained read, answered after `before` stands for something HQ did first. */
	function serveAfter(
		peer: MockAgent,
		name: RetainedPublishRead,
		before: () => void,
	) {
		request(peer, SOURCE).reply(() => {
			before();
			const answer = retainedPublishRead(name);
			return {
				statusCode: answer.status,
				data: retainedBodyText(answer),
				responseOptions: { headers: { ...answer.headers } },
			};
		});
	}
	async function mapping() {
		return h
			.db()
			.selectFrom("app_deployment_resources")
			.select(["pushed_revision", "pushed_remote_revision"])
			.where("kind", "=", "app")
			.where("superseded_at", "is", null)
			.executeTakeFirstOrThrow();
	}
	async function openWrites() {
		return h
			.db()
			.selectFrom("hq_remote_writes")
			.select(["write_kind", "resource_id"])
			.where(openRemoteWrite)
			.execute();
	}

	it("records a push baseline only for a read the counter proves is what the import left, and the counter HQ acknowledged", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			await publishFresh(peer, doc);
			expect((await baselineRow()).origin).toBe("push");
			expect(await mapping()).toEqual({
				pushed_revision: "0",
				pushed_remote_revision: "2",
			});

			serve(peer, SOURCE, "source-live");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			const landed = await publish(doc);
			expect(landed).toMatchObject({ landed: true });
			expect(landed.warnings).not.toContain(APP_CHANGED_DURING_PUBLISH_WARNING);
			expect((await baselineRow()).origin).toBe("push");
			expect((await mapping()).pushed_remote_revision).toBe("3");
			expect([...(await readDeploymentNovaRevisions(SCOPE)).values()]).toEqual([
				0,
			]);
			// The pre-migration writer updates pushed_revision while the new
			// nova_revision column on the prior row retains the backfilled value.
			await h
				.db()
				.updateTable("app_deployment_resources")
				.set({ pushed_revision: 1 })
				.where("kind", "=", "app")
				.execute();
			expect((await readDeploymentNovaRevisions(SCOPE)).size).toBe(0);
		});
		/* Every write HQ answered settled when it did. */
		expect(await openWrites()).toEqual([]);
	});

	it("records no push baseline where HQ saved the app between the import and the read back, says so, and the next publish asks", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			await publishFresh(peer, doc);
			serve(peer, SOURCE, "source-live");
			accepted(peer, 200);
			/* A person saves in HQ's editor before Nova's read back reaches it. */
			serveAfter(peer, "source-live", () => saves.save(HQ_APP));
			const landed = await publish(doc);
			expect(landed).toMatchObject({ landed: true });
			expect(landed.warnings).toContain(APP_CHANGED_DURING_PUBLISH_WARNING);
			expect((await baselineRow()).origin).toBe("unread");
			expect(await readTargetFacts(SCOPE, TARGET)).toBeNull();

			serve(peer, SOURCE, "source-live");
			expect(refusal(await publish(doc)).remoteChanges).toEqual([
				expect.objectContaining({ kind: "app", baselineKnown: false }),
			]);
		});
	});

	/* Nova's earlier publish uploaded a file the app no longer uses: HQ's
	 * import saves the app, then prunes that map key and saves it again in
	 * the same request (`hqmedia/models.py::remove_unused_mappings`). */
	const OLD_FILE = "jr://file/commcare/image/old.png";
	async function heldOldFile(peer: MockAgent, doc: BlueprintDoc) {
		await publishFresh(peer, doc);
		await h
			.db()
			.updateTable("app_deployment_baselines")
			.set({
				media_files: JSON.stringify({ "commcare/image/old.png": "old-file" }),
			})
			.execute();
		serveEdited(peer, SOURCE, "source-live", (source) => {
			source.multimedia_map = {
				[OLD_FILE]: { media_type: "CommCareImage", multimedia_id: "old-file" },
			};
		});
	}
	/** An accepted update HQ saved twice before it answered. */
	function acceptedTwice(peer: MockAgent) {
		request(peer, IMPORT, "POST").reply(() => {
			saves.save(HQ_APP);
			return {
				statusCode: 200,
				data: JSON.stringify({
					success: true,
					app_id: HQ_APP,
					version: saves.save(HQ_APP),
				}),
			};
		});
	}

	it("records a push baseline where the second save is HQ pruning the map key the app stopped using", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			await heldOldFile(peer, doc);
			acceptedTwice(peer);
			serve(peer, SOURCE, "source-live");
			const landed = await publish(doc);
			expect(landed).toMatchObject({ landed: true });
			expect(landed.warnings).not.toContain(APP_CHANGED_DURING_PUBLISH_WARNING);
			expect((await baselineRow()).origin).toBe("push");
			expect((await mapping()).pushed_remote_revision).toBe("4");
		});
	});

	it.each([
		["kept the map key", () => {}],
		[
			"pruned the map key and changed what the import leaves alone",
			(source: Record<string, unknown>) => {
				source.multimedia_map = {};
				source.comment = "Saved in CommCare HQ";
			},
		],
	] as const)(
		"records no push baseline where the second save %s, and says so",
		async (_, readBack) => {
			const doc = await seed();
			await withPeer(async (peer) => {
				await heldOldFile(peer, doc);
				acceptedTwice(peer);
				serveEdited(peer, SOURCE, "source-live", (source) => {
					source.multimedia_map = {
						[OLD_FILE]: {
							media_type: "CommCareImage",
							multimedia_id: "old-file",
						},
					};
					readBack(source);
				});
				const landed = await publish(doc);
				expect(landed).toMatchObject({ landed: true });
				expect(landed.warnings).toContain(APP_CHANGED_DURING_PUBLISH_WARNING);
				expect((await baselineRow()).origin).toBe("unread");
			});
		},
	);

	it("stops before the import where HQ saved the app after its counter was read", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			await publishFresh(peer, doc);
			const sent = allRequests(peer).length;
			/* The save lands after the counter was read and before the import:
			 * the counter read right before the POST no longer stands there. */
			serveAfter(peer, "source-live", () => saves.save(HQ_APP));
			const stopped = refusal(await publish(doc));
			expect(stopped?.failure.code).toBe("hq_changed");
			expect(allRequests(peer).slice(sent)).not.toContain(`POST ${IMPORT}`);
			expect((await baselineRow()).origin).toBe("push");
		});
	});

	it("keeps the target settings at the acknowledged version after an extra save and asks before publishing over it", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			await publishFresh(peer, doc);
			/* Another save lands while HQ takes the import, after the counter
			 * read right before the POST, and prunes nothing. */
			serve(peer, SOURCE, "source-live");
			acceptedTwice(peer);
			const heldSettings = (source: Record<string, unknown>) => {
				source.secure_submissions = true;
				const profile = source.profile as {
					properties: Record<string, unknown>;
				};
				profile.properties["cc-fuzzy-search-enabled"] = "yes";
			};
			serveEdited(peer, SOURCE, "source-live", heldSettings);
			const landed = await publish(doc);
			expect(landed).toMatchObject({ landed: true });
			expect(landed.warnings).toContain(APP_CHANGED_DURING_PUBLISH_WARNING);
			expect(await baselineRow()).toMatchObject({
				origin: "unread",
				nova_revision: null,
			});
			const baseline = await readAppBaseline(SCOPE, TARGET);
			expect(baseline).toMatchObject({ origin: "unread", novaRevision: null });
			expect(baseline).not.toHaveProperty("source");
			expect((await readDeploymentNovaRevisions(SCOPE)).size).toBe(0);
			expect(
				await resolveDownloadTarget(SCOPE, { format: "ccz", doc }),
			).toMatchObject({
				format: "ccz",
				targetFacts: {
					secureSubmissions: true,
					profileProperties: { "cc-fuzzy-search-enabled": "yes" },
				},
			});
			expect(await readPreviewDeploymentAnswer(SCOPE)).toMatchObject({
				targetFacts: { fuzzyListSearch: true },
			});
			serveEdited(peer, SOURCE, "source-live", heldSettings);
			expect(refusal(await publish(doc)).remoteChanges).toEqual([
				expect.objectContaining({ kind: "app", baselineKnown: false }),
			]);
		});
	});

	it.each(["no counter", "an unchanged counter"] as const)(
		"records no push baseline or target settings for an update HQ acknowledged with %s",
		async (acknowledgement) => {
			const doc = await seed();
			await withPeer(async (peer) => {
				await publishFresh(peer, doc);
				serve(peer, SOURCE, "source-live");
				request(peer, IMPORT, "POST").reply(() => {
					const version =
						acknowledgement === "an unchanged counter"
							? saves.at(HQ_APP)
							: undefined;
					return {
						statusCode: 200,
						data: JSON.stringify({ success: true, app_id: HQ_APP, version }),
					};
				});
				if (acknowledgement === "an unchanged counter")
					serve(peer, SOURCE, "source-live");
				const landed = await publish(doc);
				expect(landed).toMatchObject({ landed: true });
				expect(landed.warnings).toContain(APP_READ_BACK_FAILED_WARNING);
				expect((await baselineRow()).origin).toBe("unread");
				expect(await readTargetFacts(SCOPE, TARGET)).toBeNull();
			});
		},
	);

	it.each(["before the first read", "during the source read"] as const)(
		"keeps the empty app mapped and stops before sending content when HQ saved it %s",
		async (when) => {
			const doc = await seed();
			await withPeer(async (peer) => {
				if (when === "before the first read") {
					request(peer, IMPORT, "POST").reply(() => {
						saves.create(HQ_APP);
						saves.save(HQ_APP);
						return { statusCode: 201, data: { success: true, app_id: HQ_APP } };
					});
					serve(peer, SOURCE, "source-shell");
				} else {
					accepted(peer, 201);
					serveAfter(peer, "source-shell", () => saves.save(HQ_APP));
				}
				expect(refusal(await publish(doc))).toMatchObject({
					phase: "resources",
					failure: {
						code: "hq_app_state_unknown",
						message: `The new app on “clinic” changed in CommCare HQ while Nova was reading it, so Nova stopped before sending the app's content. ${CREATED} You can publish again, and Nova asks before it writes over that change.`,
					},
				});
				expect(activeRemoteApp((await state()) ?? fail())?.remoteId).toBe(
					HQ_APP,
				);
				expect((await baselineRow()).origin).toBe("unread");
			});
		},
	);

	it("keeps an import HQ never answered open for its grace, and settles every write HQ answered", async () => {
		const doc = await seed();
		await withPeer(async (peer) => {
			await publishFresh(peer, doc);
			serve(peer, SOURCE, "source-live");
			request(peer, IMPORT, "POST").replyWithError(new Error("socket hang up"));
			expect(refusal(await publish(doc))).toMatchObject({
				phase: "upload",
				failure: { code: "hq_rejected_upload" },
			});
		});
		expect(await openWrites()).toEqual([
			{ write_kind: "import", resource_id: HQ_APP },
		]);
	});

	it("names the empty app a create made as the deployment was ended, beside the ending", async () => {
		const doc = await seed();
		await h.seedProjectMember(ADMIN, PROJECT, "admin");
		await withPeer(async (peer) => {
			await publishFresh(peer, doc);
			/* HQ reports the app gone, so the next publish makes a new one. */
			serve(peer, SOURCE, "source-missing");
			expect(refusal(await publish(doc)).failure.code).toBe(
				"remote_app_missing",
			);
			const shell = "new-shell";
			request(peer, IMPORT, "POST").reply(async () => {
				/* An admin stops publishing here while HQ makes the new app. */
				await stopHere(ADMIN_SCOPE, TARGET);
				saves.create(shell);
				return {
					statusCode: 201,
					data: JSON.stringify({ success: true, app_id: shell }),
				};
			});
			expect(refusal(await publish(doc))).toMatchObject({
				failure: { code: "publishing_stopped" },
			});
			const view = (await state()) ?? fail();
			expect(deploymentEnding(view)).toMatchObject({ hqAppId: HQ_APP });
			expect(leftBehindResources(view, new Map())).toEqual([
				expect.objectContaining({ kind: "app", remoteId: shell }),
			]);
		});
	});
});

function fail(): never {
	throw new Error("Expected a value");
}
