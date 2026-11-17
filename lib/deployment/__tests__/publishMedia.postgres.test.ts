/**
 * A publish over a file a person replaced in CommCare HQ: the record of which
 * CommCare HQ file stands at each path the app publishes, the stop it gives,
 * the discard, a path with no record settled by the file's content, and the
 * record each upload writes, over real Postgres and a peer standing in for
 * CommCare HQ.
 *
 * Every source read is HQ's own answer, retained by the proof lane
 * (`proof/hq-reads/publish/`), with one edit written here: its
 * `multimedia_map`, whose entries take the shape HQ serves
 * (`proof/hq-reads/case-list-inline/app-source-after-media.json`). The media
 * upload's answers are written in the shape the status view serves
 * (`app_import_api.py::_handle_multimedia_status`), and a media file is its
 * bytes.
 *
 * It would catch: a publish that writes Nova's file over a person's with no
 * word; a stop that a save changing no file still gives; a discard that does
 * not let the upload through, or one that lets through a file replaced again
 * after the person was shown the stop; a path with no record read as
 * unchanged, or settled again on every publish; a failed file read read as
 * nothing changed, or worded as the account's when CommCare HQ's file view
 * checks no account; a record that takes an id CommCare HQ never reported,
 * or loses the one it knew to a failed upload; a file replaced while the
 * Project's data went, written over; and Nova's own earlier upload, mapping
 * its file while the data went, stopping the publish.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedPublishRead,
	replyRetained,
	retainedBodyJson,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { decrypt } from "@/lib/commcare/encryption";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { BlueprintDoc, MediaAssetId } from "@/lib/domain";
import { createLookupTable, replaceLookupRows } from "@/lib/lookup/service";
import { PLAN_FEATURE_IDS } from "@/lib/publish/planFeatures";
import { downloadAssetBytes } from "@/lib/storage/media";
import { HQ_CHANGED_DURING_PUSH_MESSAGE } from "../remoteChanges";
import { type PublishOutcome, publishAppToHq } from "../service";
import { endDeployment, recordDeploymentMediaFiles } from "../store";
import type { DeploymentConfirmationKey, RemoteChangeDiscard } from "../types";
import { clinicVisitsDocument, reloadHeadFor } from "./publishFixtures";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@/lib/storage/media", () => ({ downloadAssetBytes: vi.fn() }));
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
	vi.mocked(downloadAssetBytes).mockReset();
});
afterEach(() => vi.useRealTimers());

const h = setupAppStateTestDb("publish_media_", { authSchema: "migrated" });
const APP = "media-app",
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
const SOURCE = `/a/clinic/apps/source/${HQ_APP}/`;
const MEDIA = `/a/clinic/apps/api/${HQ_APP}/multimedia/`;
const STATUS = `${MEDIA}status/media-job/`;
const TABLES = "/a/clinic/api/lookup_table/v1/?limit=100";
const WORKBOOK = "/a/clinic/fixtures/fixapi/";
const ROWS = "/a/clinic/api/fixture/v1/?fixture_type_id=hq-table";
const PROJECT_SPACES = "/api/user_domains/v1/?limit=100";

const IMAGE = testMediaAssetId("publish-media-image");
const PNG = readFileSync("public/nova-icons/household.png");
const HASH = createHash("sha256").update(PNG).digest("hex");
/** The path the publish sends the image under: its content hash. */
const WIRE = `commcare/${HASH}.png`;
/** Another file, as a person's upload in CommCare HQ gives the path. */
const PERSONS_FILE = Buffer.from("a picture a person uploaded in CommCare HQ");

const ONE_FILE_PART = "A picture or sound this app publishes";
const READ_REFUSED = `Nova couldn't read a picture or sound this app publishes on “clinic”, so it left that app unchanged. Nova checks each one before it sends this app's own over it. You can publish again in a moment.`;

const CONFIRM_ALL: readonly DeploymentConfirmationKey[] = [
	...PLAN_FEATURE_IDS.map((subject) => ({
		kind: "plan-feature" as const,
		subject,
	})),
	{ kind: "flat-location-fixture" },
	{ kind: "connect-forwarder" },
	{ kind: "form-entry-sync-off" },
];

/** `doc` with the image on its first field's label. */
function withImage(
	doc: BlueprintDoc,
	image: MediaAssetId = IMAGE,
): BlueprintDoc {
	const field = Object.values(doc.fields)[0];
	if (field === undefined || !("label" in field))
		throw new Error("Expected a field that shows a label");
	(field as { label_media?: unknown }).label_media = { image };
	return doc;
}

async function seed(doc: BlueprintDoc) {
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
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id: IMAGE,
			project_id: PROJECT,
			owner: "creator",
			kind: "image",
			content_hash: HASH,
			mime_type: "image/png",
			extension: ".png",
			size_bytes: PNG.length,
			gcs_object_key: `projects/${PROJECT}/${HASH}.png`,
			original_filename: "household.png",
			display_name: "Household",
			status: "ready",
			media_format: "png",
		})
		.execute();
	vi.mocked(downloadAssetBytes).mockResolvedValue(PNG);
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
function serve(peer: MockAgent, name: RetainedPublishRead) {
	replyRetained(request(peer, SOURCE), retainedPublishRead(name));
}
/**
 * A retained read whose `multimedia_map` holds one entry per path, each as
 * HQ serves an `HQMediaMapItem`, or no map at all for `null`.
 */
function serveWithMap(
	peer: MockAgent,
	name: RetainedPublishRead,
	map: Readonly<Record<string, string>> | null,
) {
	const answer = retainedPublishRead(name);
	const source = retainedBodyJson(answer);
	if (map === null) delete source.multimedia_map;
	else
		source.multimedia_map = Object.fromEntries(
			Object.entries(map).map(([wirePath, id]) => [
				`jr://file/${wirePath}`,
				{
					multimedia_id: id,
					media_type: "CommCareImage",
					version: null,
					unique_id: createHash("md5").update(`${wirePath}${id}`).digest("hex"),
					upstream_media_id: null,
					doc_type: "HQMediaMapItem",
				},
			]),
		);
	replyRetained(request(peer, SOURCE), {
		...answer,
		body: JSON.stringify(source),
	});
}
/** An accepted import: 201 for a create, 200 for an update. */
function accepted(peer: MockAgent, status: 200 | 201) {
	request(peer, IMPORT, "POST").reply(status, {
		success: true,
		app_id: HQ_APP,
		version: status === 201 ? 1 : 2,
	});
}
/** The file CommCare HQ serves for `id`. */
function file(peer: MockAgent, id: string, bytes: Buffer) {
	request(peer, `/hq/multimedia/file/CommCareImage/${id}/`).reply(200, bytes, {
		headers: { "content-type": "image/png" },
	});
}
/**
 * The media upload accepted and processed. `reported` is the id the report
 * names for the image's path, or null for a report with no `matched_files`.
 */
function mediaTaken(
	peer: MockAgent,
	reported: string | null,
	options: { readonly errors?: readonly string[] } = {},
) {
	request(peer, MEDIA, "POST").reply(200, {
		success: true,
		processing_id: "media-job",
	});
	request(peer, STATUS).reply(
		200,
		statusAnswer(reported, options.errors ?? []),
	);
}
function statusAnswer(reported: string | null, errors: readonly string[]) {
	const matched =
		reported === null
			? []
			: [
					{
						path: `jr://file/${WIRE}`,
						uid: createHash("md5").update(PNG).digest("hex"),
						m_id: reported,
						url: `/hq/multimedia/file/CommCareImage/${reported}/`,
						updated: false,
						original_path: WIRE,
						icon_class: "fa-regular fa-image",
						media_type: "Image",
						humanized_content_length: "1.2 KB",
						image_size: "64 x 64 px",
					},
				];
	return {
		type: "zip",
		in_celery: true,
		is_ready: true,
		complete: true,
		progress: { percent: 100, current: 1, total: 1 },
		errors,
		processing_id: "media-job",
		unmatched_files: [],
		unmatched_count: 0,
		...(reported !== null && {
			matched_files: {
				CommCareAudio: [],
				CommCareImage: matched,
				CommCareVideo: [],
			},
		}),
		matched_count: matched.length,
		total_files: 1,
		processed_files: 1,
		skipped_files: [],
		image_count: matched.length,
		audio_count: 0,
		video_count: 0,
		success: true,
	};
}

/** Every request to the app's own endpoints, in order, past the first `from`. */
function requests(peer: MockAgent, from = 0): string[] {
	return (
		peer
			.getCallHistory()
			?.calls()
			.map(({ method, fullUrl }) => `${method} ${fullUrl.replace(HOST, "")}`)
			.filter((line) => !line.startsWith(`GET ${PROJECT_SPACES}`)) ?? []
	).slice(from);
}
function sentCount(peer: MockAgent): number {
	return requests(peer).length;
}
async function record() {
	const row = await h
		.db()
		.selectFrom("app_deployment_baselines")
		.select("media_files")
		.executeTakeFirstOrThrow();
	return row.media_files;
}
function refusal(outcome: PublishOutcome) {
	if (outcome.landed) throw new Error("Expected the publish to stop");
	return outcome.refusal;
}

/** The first publish: shell, read, fill, read back, then the image, which CommCare HQ maps under `reported`. */
async function publishFirst(
	peer: MockAgent,
	doc: BlueprintDoc,
	reported: string | null = "doc-nova",
) {
	accepted(peer, 201);
	serve(peer, "source-shell");
	accepted(peer, 200);
	serve(peer, "source-live");
	mediaTaken(peer, reported);
	expect((await publish(doc)).landed).toBe(true);
}

/** A republish over an app whose map holds `map`, which lands. */
function republishLands(
	peer: MockAgent,
	map: Readonly<Record<string, string>>,
	reported: string | null,
) {
	serveWithMap(peer, "source-live", map);
	accepted(peer, 200);
	serve(peer, "source-live");
	mediaTaken(peer, reported);
}

describe("a file replaced in CommCare HQ", () => {
	it("stops the publish with one media part before anything is sent, and keeps the record", async () => {
		const doc = await seed(withImage(clinicVisitsDocument()));
		await withHttpPeer(async (peer) => {
			await publishFirst(peer, doc);
			expect(await record()).toEqual({ [WIRE]: "doc-nova" });
			const sent = sentCount(peer);

			serveWithMap(peer, "source-live", { [WIRE]: "doc-person" });
			file(peer, "doc-person", PERSONS_FILE);
			const stopped = refusal(await publish(doc));
			expect(stopped).toMatchObject({
				phase: "preflight",
				failure: { code: "hq_changed" },
				remoteChanges: [
					{
						kind: "app",
						parts: [ONE_FILE_PART],
						baselineKnown: true,
					},
				],
			});
			expect(requests(peer, sent)).toEqual([
				`GET ${SOURCE}`,
				"GET /hq/multimedia/file/CommCareImage/doc-person/",
			]);
			expect(await record()).toEqual({ [WIRE]: "doc-nova" });
		});
	});

	it("uploads over it where the person chose to publish over, and records the id CommCare HQ reported", async () => {
		const doc = await seed(withImage(clinicVisitsDocument()));
		await withHttpPeer(async (peer) => {
			await publishFirst(peer, doc);
			serveWithMap(peer, "source-live", { [WIRE]: "doc-person" });
			file(peer, "doc-person", PERSONS_FILE);
			const [shown] = refusal(await publish(doc)).remoteChanges;
			const sent = sentCount(peer);

			serveWithMap(peer, "source-live", { [WIRE]: "doc-person" });
			file(peer, "doc-person", PERSONS_FILE);
			accepted(peer, 200);
			serve(peer, "source-live");
			mediaTaken(peer, "doc-nova-again");
			const landed = await publish(doc, [
				{
					kind: "app",
					novaResourceId: APP,
					observedDigest: shown?.observedDigest ?? fail(),
				},
			]);
			expect(landed.landed).toBe(true);
			expect(requests(peer, sent)).toEqual([
				`GET ${SOURCE}`,
				"GET /hq/multimedia/file/CommCareImage/doc-person/",
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
				`POST ${MEDIA}`,
				`GET ${STATUS}`,
			]);
			expect(await record()).toEqual({ [WIRE]: "doc-nova-again" });
		});
	});

	it("asks again about a file replaced again after the person was shown the stop", async () => {
		const doc = await seed(withImage(clinicVisitsDocument()));
		await withHttpPeer(async (peer) => {
			await publishFirst(peer, doc);
			serveWithMap(peer, "source-live", { [WIRE]: "doc-person" });
			file(peer, "doc-person", PERSONS_FILE);
			const [shown] = refusal(await publish(doc)).remoteChanges;
			const sent = sentCount(peer);

			serveWithMap(peer, "source-live", { [WIRE]: "doc-person-again" });
			file(peer, "doc-person-again", Buffer.from("another upload"));
			const [again] = refusal(
				await publish(doc, [
					{
						kind: "app",
						novaResourceId: APP,
						observedDigest: shown?.observedDigest ?? fail(),
					},
				]),
			).remoteChanges;
			expect(again).toMatchObject({ parts: [ONE_FILE_PART] });
			expect(again?.observedDigest).not.toBe(shown?.observedDigest);
			expect(requests(peer, sent)).not.toContain(`POST ${MEDIA}`);
			expect(requests(peer, sent)).not.toContain(`POST ${IMPORT}`);
		});
	});
});

describe("a path Nova holds no record for", () => {
	it("is settled by its content with one file request and recorded, and the next publish asks for no file", async () => {
		const doc = await seed(withImage(clinicVisitsDocument()));
		await withHttpPeer(async (peer) => {
			/* An upload whose report names no ids leaves the path unrecorded. */
			await publishFirst(peer, doc, null);
			expect(await record()).toEqual({});

			let sent = sentCount(peer);
			republishLands(peer, { [WIRE]: "doc-nova" }, null);
			file(peer, "doc-nova", PNG);
			expect((await publish(doc)).landed).toBe(true);
			expect(
				requests(peer, sent).filter((line) =>
					line.includes("/multimedia/file/"),
				),
			).toEqual(["GET /hq/multimedia/file/CommCareImage/doc-nova/"]);
			expect(await record()).toEqual({ [WIRE]: "doc-nova" });

			sent = sentCount(peer);
			republishLands(peer, { [WIRE]: "doc-nova" }, null);
			expect((await publish(doc)).landed).toBe(true);
			expect(
				requests(peer, sent).filter((line) =>
					line.includes("/multimedia/file/"),
				),
			).toEqual([]);
			expect(await record()).toEqual({ [WIRE]: "doc-nova" });
		});
	});

	it("is settled the same way on a deployment that holds no record at all", async () => {
		const doc = await seed(withImage(clinicVisitsDocument()));
		await withHttpPeer(async (peer) => {
			await publishFirst(peer, doc);
			await h
				.db()
				.updateTable("app_deployment_baselines")
				.set({ media_files: null })
				.execute();
			republishLands(peer, { [WIRE]: "doc-nova" }, null);
			file(peer, "doc-nova", PNG);
			expect((await publish(doc)).landed).toBe(true);
			expect(await record()).toEqual({ [WIRE]: "doc-nova" });
		});
	});
});

describe("a file Nova cannot read", () => {
	it("blocks with nothing sent, in one sentence for an outage and a refusal alike", async () => {
		const doc = await seed(withImage(clinicVisitsDocument()));
		await withHttpPeer(async (peer) => {
			await publishFirst(peer, doc);
			for (const [status, message] of [
				[500, READ_REFUSED],
				[401, READ_REFUSED],
				[403, READ_REFUSED],
			] as const) {
				const sent = sentCount(peer);
				serveWithMap(peer, "source-live", { [WIRE]: "doc-other" });
				request(peer, "/hq/multimedia/file/CommCareImage/doc-other/").reply(
					status,
					"",
				);
				expect(refusal(await publish(doc))).toMatchObject({
					phase: "preflight",
					failure: { code: "hq_app_state_unknown", message },
				});
				expect(requests(peer, sent)).toEqual([
					`GET ${SOURCE}`,
					"GET /hq/multimedia/file/CommCareImage/doc-other/",
				]);
			}
			expect(await record()).toEqual({ [WIRE]: "doc-nova" });
		});
	});
});

describe("a read with no media map", () => {
	it("blocks an app that publishes a file", async () => {
		const doc = await seed(withImage(clinicVisitsDocument()));
		await withHttpPeer(async (peer) => {
			await publishFirst(peer, doc);
			const sent = sentCount(peer);
			serveWithMap(peer, "source-live", null);
			expect(refusal(await publish(doc))).toMatchObject({
				phase: "preflight",
				failure: { code: "hq_app_state_unknown" },
			});
			expect(requests(peer, sent)).toEqual([`GET ${SOURCE}`]);
		});
	});

	it("passes an app that publishes none, and records no file", async () => {
		const doc = await seed(clinicVisitsDocument());
		await withHttpPeer(async (peer) => {
			accepted(peer, 201);
			serve(peer, "source-shell");
			accepted(peer, 200);
			serve(peer, "source-live");
			expect((await publish(doc)).landed).toBe(true);
			expect(await record()).toEqual({});

			serveWithMap(peer, "source-live", null);
			accepted(peer, 200);
			serve(peer, "source-live");
			expect((await publish(doc)).landed).toBe(true);
			expect(await record()).toEqual({});
		});
	});
});

describe("the record after an upload", () => {
	it("keeps the previous record where the upload failed or reported errors", async () => {
		const doc = await seed(withImage(clinicVisitsDocument()));
		await withHttpPeer(async (peer) => {
			await publishFirst(peer, doc);

			serveWithMap(peer, "source-live", { [WIRE]: "doc-nova" });
			accepted(peer, 200);
			serve(peer, "source-live");
			request(peer, MEDIA, "POST").reply(500, "");
			expect((await publish(doc)).landed).toBe(true);
			expect(await record()).toEqual({ [WIRE]: "doc-nova" });

			serveWithMap(peer, "source-live", { [WIRE]: "doc-nova" });
			accepted(peer, 200);
			serve(peer, "source-live");
			mediaTaken(peer, "doc-unsaved", {
				errors: ["Error while processing zip: the app could not be saved"],
			});
			expect((await publish(doc)).landed).toBe(true);
			expect(await record()).toEqual({ [WIRE]: "doc-nova" });
		});
	});

	it("keeps the previous record where the upload's processing was not confirmed in time", async () => {
		const doc = await seed(withImage(clinicVisitsDocument()));
		await withHttpPeer(async (peer) => {
			await publishFirst(peer, doc);

			serveWithMap(peer, "source-live", { [WIRE]: "doc-nova" });
			accepted(peer, 200);
			serve(peer, "source-live");
			/* The status poll's clock is faked from the moment CommCare HQ takes
			 * the upload, and its one status answer never comes inside it. */
			request(peer, MEDIA, "POST").reply(() => {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				return {
					statusCode: 200,
					data: JSON.stringify({ success: true, processing_id: "media-job" }),
				};
			});
			const reached = Promise.withResolvers<void>(),
				release = Promise.withResolvers<void>();
			request(peer, STATUS).reply(async () => {
				reached.resolve();
				await release.promise;
				return {
					statusCode: 200,
					data: JSON.stringify(statusAnswer("doc-late", [])),
				};
			});
			const pending = publish(doc);
			try {
				await reached.promise;
				await vi.advanceTimersByTimeAsync(45_000);
				vi.useRealTimers();
				const outcome = await pending;
				expect(outcome.landed).toBe(true);
				expect(outcome.warnings).toContain(
					"The app was published and CommCare HQ accepted its media. Nova could not confirm whether processing finished. Check the app’s media in CommCare HQ, or publish again to retry.",
				);
			} finally {
				vi.useRealTimers();
				release.resolve();
				await pending.catch(() => undefined);
			}
			expect(await record()).toEqual({ [WIRE]: "doc-nova" });
		});
	});

	it("lands and writes no record where someone stopped publishing there during the upload", async () => {
		const doc = await seed(withImage(clinicVisitsDocument()));
		await h.seedProjectMember("admin", PROJECT, "admin");
		await withHttpPeer(async (peer) => {
			await publishFirst(peer, doc);
			serveWithMap(peer, "source-live", { [WIRE]: "doc-nova" });
			accepted(peer, 200);
			serve(peer, "source-live");
			request(peer, MEDIA, "POST").reply(async () => {
				await endDeployment(
					{ ...SCOPE, actorUserId: "admin", role: "admin" },
					TARGET,
				);
				return {
					statusCode: 200,
					data: JSON.stringify({ success: true, processing_id: "media-job" }),
				};
			});
			request(peer, STATUS).reply(200, statusAnswer("doc-after-stop", []));
			expect((await publish(doc)).landed).toBe(true);
		});
		expect(await record()).toEqual({ [WIRE]: "doc-nova" });
	});

	it("writes only over the baseline its publish wrote, and leaves a later one as it was", async () => {
		const doc = await seed(withImage(clinicVisitsDocument()));
		await withHttpPeer(async (peer) => {
			await publishFirst(peer, doc);
		});
		const row = await h
			.db()
			.selectFrom("app_deployment_baselines")
			.select("source_digest")
			.executeTakeFirstOrThrow();
		const digest = row.source_digest ?? fail();
		const write = (input: {
			remoteAppId?: string;
			sourceDigest: string | null;
			files: Readonly<Record<string, string>>;
		}) =>
			recordDeploymentMediaFiles(SCOPE, TARGET, {
				expectedEndings: 0,
				remoteAppId: input.remoteAppId ?? HQ_APP,
				sourceDigest: input.sourceDigest,
				files: input.files,
			});

		/* Another publish's baseline followed: its digest is not this one's. */
		await write({
			sourceDigest: "a later publish's read",
			files: { [WIRE]: "x" },
		});
		await write({ sourceDigest: null, files: { [WIRE]: "x" } });
		await write({
			remoteAppId: "another-app",
			sourceDigest: digest,
			files: { [WIRE]: "x" },
		});
		expect(await record()).toEqual({ [WIRE]: "doc-nova" });

		await write({ sourceDigest: digest, files: { [WIRE]: "doc-written" } });
		expect(await record()).toEqual({ [WIRE]: "doc-written" });

		/* A publish whose read-back failed wrote an unread baseline, which has
		 * no digest, and records what its upload reported against that. */
		await withHttpPeer(async (peer) => {
			serveWithMap(peer, "source-live", { [WIRE]: "doc-written" });
			accepted(peer, 200);
			request(peer, SOURCE).reply(500, "");
			mediaTaken(peer, "doc-unread");
			expect((await publish(doc)).landed).toBe(true);
		});
		expect(
			await h
				.db()
				.selectFrom("app_deployment_baselines")
				.select(["origin", "source_digest", "media_files"])
				.executeTakeFirstOrThrow(),
		).toEqual({
			origin: "unread",
			source_digest: null,
			media_files: { [WIRE]: "doc-unread" },
		});
		await write({ sourceDigest: digest, files: { [WIRE]: "x" } });
		expect(await record()).toEqual({ [WIRE]: "doc-unread" });
	});
});

describe("a file whose id moved while the Project's data went", () => {
	/** An app with the image and a select over one lookup table, so each
	 *  publish pushes the table and reads the app's source a second time. */
	async function seedWithTable() {
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
		return seed(
			withImage(
				buildDoc({
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
				}),
			),
		);
	}
	const remoteTable = {
		id: "hq-table",
		tag: "facilities",
		is_global: true,
		fields: [{ field_name: "code" }, { field_name: "name" }],
	};
	const tablesAfterPush = (peer: MockAgent) =>
		request(peer, TABLES).reply(200, {
			objects: [remoteTable],
			meta: { next: null },
		});
	const tableRows = (peer: MockAgent) =>
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
	const workbookTaken = (peer: MockAgent) =>
		request(peer, WORKBOOK, "POST").reply(200, {
			code: 200,
			message: "Done",
		});
	/** The first publish, whose upload CommCare HQ maps under `doc-nova`. */
	async function publishFirstWithTable(peer: MockAgent, doc: BlueprintDoc) {
		request(peer, TABLES).reply(200, { objects: [], meta: { next: null } });
		accepted(peer, 201);
		serve(peer, "source-shell");
		workbookTaken(peer);
		tablesAfterPush(peer);
		tableRows(peer);
		serve(peer, "source-shell");
		accepted(peer, 200);
		serve(peer, "source-live");
		mediaTaken(peer, "doc-nova");
		expect((await publish(doc)).landed).toBe(true);
		expect(await record()).toEqual({ [WIRE]: "doc-nova" });
	}
	/** A republish up to its second read: `first` and `second` are the maps
	 *  the two reads of the app's source hold. */
	function republishReads(
		peer: MockAgent,
		first: Readonly<Record<string, string>>,
		second: Readonly<Record<string, string>>,
	) {
		tablesAfterPush(peer);
		tableRows(peer);
		serveWithMap(peer, "source-live", first);
		workbookTaken(peer);
		tablesAfterPush(peer);
		tableRows(peer);
		serveWithMap(peer, "source-live", second);
	}

	it("stops at the upload where the file there is not this app's, with neither the content nor the file sent", async () => {
		const doc = await seedWithTable();
		await withHttpPeer(async (peer) => {
			await publishFirstWithTable(peer, doc);
			const sent = sentCount(peer);

			republishReads(peer, { [WIRE]: "doc-nova" }, { [WIRE]: "doc-person" });
			file(peer, "doc-person", PERSONS_FILE);
			expect(refusal(await publish(doc))).toMatchObject({
				phase: "upload",
				failure: {
					code: "hq_changed",
					message: HQ_CHANGED_DURING_PUSH_MESSAGE,
					details: [],
				},
				remoteChanges: [],
			});
			const after = requests(peer, sent);
			expect(after).not.toContain(`POST ${IMPORT}`);
			expect(after).not.toContain(`POST ${MEDIA}`);
			expect(after.slice(-2)).toEqual([
				`GET ${SOURCE}`,
				"GET /hq/multimedia/file/CommCareImage/doc-person/",
			]);
		});
		expect(await record()).toEqual({ [WIRE]: "doc-nova" });
	});

	it("lands where Nova's own earlier upload mapped its file between the two reads, and records that file's id", async () => {
		const doc = await seedWithTable();
		await withHttpPeer(async (peer) => {
			await publishFirstWithTable(peer, doc);

			/* The earlier upload's processing outlived its poll: the first read
			 * holds no entry at the path, and by the second its task has mapped
			 * Nova's own bytes there. */
			republishReads(peer, {}, { [WIRE]: "doc-late" });
			file(peer, "doc-late", PNG);
			accepted(peer, 200);
			serve(peer, "source-live");
			mediaTaken(peer, null);
			expect((await publish(doc)).landed).toBe(true);
		});
		expect(await record()).toEqual({ [WIRE]: "doc-late" });
	});

	it("stops at the upload where the file there could not be read, in the media read's own sentence", async () => {
		const doc = await seedWithTable();
		await withHttpPeer(async (peer) => {
			await publishFirstWithTable(peer, doc);
			const sent = sentCount(peer);

			republishReads(peer, { [WIRE]: "doc-nova" }, { [WIRE]: "doc-other" });
			request(peer, "/hq/multimedia/file/CommCareImage/doc-other/").reply(
				403,
				"",
			);
			expect(refusal(await publish(doc))).toMatchObject({
				phase: "upload",
				failure: { code: "hq_app_state_unknown", message: READ_REFUSED },
			});
			expect(requests(peer, sent)).not.toContain(`POST ${IMPORT}`);
		});
		expect(await record()).toEqual({ [WIRE]: "doc-nova" });
	});
});

function fail(): never {
	throw new Error("Expected a value");
}
