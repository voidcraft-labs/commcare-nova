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
import { sql } from "kysely";
import type { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	readMultipartRequest,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import {
	type RetainedPublishRead,
	replyRetained,
	retainedBodyJson,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { decrypt } from "@/lib/commcare/encryption";
import { APP_SHELL_KEYS } from "@/lib/commcare/expander";
import { derivedFormXmlns, derivedUniqueId } from "@/lib/commcare/wireIdentity";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	asUuid,
	type BlueprintDoc,
	type OrganizationLevel,
} from "@/lib/domain";
import { createLookupTable, replaceLookupRows } from "@/lib/lookup/service";
import { createLocation } from "@/lib/organization/service";
import { downloadAssetBytes } from "@/lib/storage/media";
import { getEntryPointLink } from "../entryPointLinks";
import { ABSENT_RESOURCE_DIGEST } from "../hqResourceBaseline";
import {
	APP_PREVIEW_NOTE,
	APP_READ_BACK_FAILED_WARNING,
	BASELINE_UNKNOWN_SENTENCE,
	HQ_CHANGED_DURING_PUSH_MESSAGE,
	HQ_CHANGED_MESSAGE,
	HQ_CHANGES_CONFIRMED_DETAIL,
	HQ_CHANGES_NONE_DETAIL,
	HQ_CHANGES_NOTHING_TO_COMPARE_DETAIL,
} from "../remoteChanges";
import { activeRemoteApp } from "../resources";
import {
	type PublishOutcome,
	publishAppToHq,
	setupArtifactFor,
} from "../service";
import { applyDeploymentObservation, readDeployment } from "../store";
import type { RemoteChangeDiscard } from "../types";
import { clinicVisitsDocument } from "./publishFixtures";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@/lib/storage/media", () => ({ downloadAssetBytes: vi.fn() }));
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
	vi.mocked(downloadAssetBytes).mockReset();
});
afterEach(() => vi.useRealTimers());

const h = setupAppStateTestDb("publish_sequence_", { authSchema: "migrated" });
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
const TABLES = "/a/clinic/api/lookup_table/v1/?limit=100";
const WORKBOOK = "/a/clinic/fixtures/fixapi/";
const LEVELS = "/a/clinic/api/location_type/v1/?limit=1000";
const PLACES = "/a/clinic/api/location/v2/?limit=1000";
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

function publish(
	doc: BlueprintDoc,
	discardRemoteChanges?: readonly RemoteChangeDiscard[],
): Promise<PublishOutcome> {
	return publishAppToHq({
		scope: SCOPE,
		...TARGET,
		doc,
		compiledAtSeq: 0,
		appName: doc.appName,
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
		return {
			statusCode: status,
			data: JSON.stringify({
				success: true,
				app_id: appId,
				version: status === 201 ? 1 : 2,
			}),
		};
	});
}
function requests(peer: MockAgent): string[] {
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
			})
			.execute();
		vi.mocked(downloadAssetBytes).mockResolvedValue(png);
		const bodies: { appId: unknown; app: Record<string, unknown> }[] = [];
		await withHttpPeer(async (peer) => {
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
		expect(Object.keys(shell.app)).toEqual([...APP_SHELL_KEYS]);
		expect(shell.app).toMatchObject({ modules: [], _attachments: {} });
		for (const key of [
			"multimedia_map",
			"logo_refs",
			"profile",
			"location_fixture_restore",
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
		await withHttpPeer(async (peer) => {
			accepted(peer, 201);
			serve(peer, SOURCE, "source-shell");
			accepted(peer, 200);
			serve(peer, SOURCE, "source-live");
			expect((await publish(doc)).landed).toBe(true);

			// The rows a cutover writes from HQ's own reads of a deployment
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
		await withHttpPeer(async (peer) => {
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
		await withHttpPeer(async (peer) => {
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
		await withHttpPeer(async (peer) => {
			accepted(peer, 201);
			request(peer, SOURCE).reply(500, "");
			expect(refusal(await publish(doc)).failure.message).toBe(
				`Nova couldn't safely read the app on “clinic”, so Nova stopped before sending the app's content. ${CREATED} Check that the app opens in CommCare HQ, then publish again.`,
			);
		});
	});

	it("records no rung past preflight when the shell's workbook is refused, and the retry pushes the table and fills that app", async () => {
		const doc = await seed(await lookupDocument());
		await withHttpPeer(async (peer) => {
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
			await withHttpPeer(async (peer) => {
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
		await withHttpPeer(async (peer) => {
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
			await withHttpPeer(async (peer) => {
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
		await withHttpPeer(async (peer) => {
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
			await withHttpPeer(async (peer) => {
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

				emptyTables(peer);
				serve(peer, SOURCE, answer);
				expect(refusal(await publish(doc))).toMatchObject({
					failure: { code: "remote_app_missing" },
				});
				expect(requests(peer).slice(7)).toEqual([
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
		await withHttpPeer(async (peer) => {
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
			await withHttpPeer(async (peer) => {
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
			await withHttpPeer(async (peer) => {
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
		await withHttpPeer(async (peer) => {
			await landed(doc, peer);
			const unchanged = await snapshot();
			serve(peer, SOURCE, "source-linked");
			expect(refusal(await publish(doc))).toMatchObject({
				phase: "preflight",
				failure: {
					code: "hq_app_state_unknown",
					message:
						"The app on “clinic” is a linked app in CommCare HQ, and Nova only updates apps it made. Nova left it unchanged. You can publish to another project space, or remove the link in CommCare HQ and publish again.",
				},
			});
			expect(await snapshot()).toEqual(unchanged);
			expect(requests(peer).slice(4)).toEqual([`GET ${SOURCE}`]);
		});
	});

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
			await withHttpPeer(async (peer) => {
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
			await withHttpPeer(async (peer) => {
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
	it("lands three publishes of an unchanged app in a row, saying what it compared", async () => {
		const doc = await seed();
		await withHttpPeer(async (peer) => {
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
		await withHttpPeer(async (peer) => {
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
		await withHttpPeer(async (peer) => {
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
		await withHttpPeer(async (peer) => {
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
		await withHttpPeer(async (peer) => {
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
		await withHttpPeer(async (peer) => {
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
		await withHttpPeer(async (peer) => {
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
		await withHttpPeer(async (peer) => {
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
		await withHttpPeer(async (peer) => {
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

function fail(): never {
	throw new Error("Expected a value");
}
