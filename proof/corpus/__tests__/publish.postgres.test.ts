/**
 * The harness publishes as Nova publishes, and downloads as Nova downloads.
 *
 * Contract: for the same app and the same project space, the requests the
 * harness's capture (`proof/corpus/publish.ts::capturePublish`) records are
 * the requests `publishAppToHq` sends, in the same order, and the capture's
 * local archive (`localCcz`) is the one Nova's compile route
 * (`app/api/compile/route.ts`) returns once the app's deployment record
 * names that project space. The capture stands in for Nova's database with
 * the Project state preflight would read and for HQ with a peer answering
 * from a configuration, so the plausible failures are there: a lookup
 * snapshot, media manifest, attachment target or compatibility report that
 * differs from what preflight hands the send, a first publish whose shell,
 * source reads, workbook and content arrive in another order than Nova's, an
 * update built over a different source, a verdict naming flags other than
 * the ones Nova's check asks about, or an archive assembled with options the
 * route does not use. And a publish sends the ids the publish before it
 * sent: three publishes of one document carry one set of menu ids, form ids
 * and `xmlns`.
 *
 * Each app is published through the real `publishAppToHq` (migrated
 * Postgres, the real preflight and HQ client; only KMS, object storage and
 * the HQ peer are controlled) and captured through `capturePublish`. The
 * test's peer answers each source read as the capture's peer does, from
 * what Nova last sent: after the shell's create its source
 * (`proof/corpus/targetPeer.ts::shellSource`), after the content import
 * that body with HQ's CommCare version. The bodies are compared decoded:
 * field order, `app_name`, `app_id` presence, the app file's name and type,
 * the workbook bytes, the app JSON with the app id each side names put in
 * place, and the media upload Nova sends after the content import
 * (`uploadMediaBytes`): its fields, the ZIP's name and type, and each file
 * the ZIP holds, by name and bytes, in order (each ZIP stamps its files with
 * the time it was built). The order is compared over the requests that
 * write or read the app and its data (imports, source reads, workbooks and
 * media uploads). The archives are compared entry by entry with the
 * profile's `uniqueid` and the app id named in place; the route runs with
 * only the session and object storage controlled.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { NextRequest } from "next/server";
import type { MockAgent } from "undici";
import { beforeEach, expect, it, vi } from "vitest";
import {
	readMultipartRequest,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { POST as compileCcz } from "@/app/api/compile/route";
import { requireSession } from "@/lib/auth-utils";
import { decrypt } from "@/lib/commcare/encryption";
import { parseXml } from "@/lib/commcare/xmlParse";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	clinicVisitsDocument,
	searchLookupMediaDocument,
	TARGET_OWNED_PROFILE,
	TARGET_PROFILE_WITH_DERIVED_KEY,
} from "@/lib/deployment/__tests__/publishFixtures";
import { publishAppToHq } from "@/lib/deployment/service";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import {
	createLookupTable,
	getLookupFixtureData,
	replaceLookupRows,
} from "@/lib/lookup/service";
import { loadAppBlueprint } from "@/lib/mcp/loadApp";
import { downloadAssetBytes } from "@/lib/storage/media";
import { CORPUS_COMMCARE_VERSION } from "../configurations";
import {
	type CapturedRequest,
	capturePublish,
	localCcz,
	novaPublishVerdict,
	PLACEHOLDER_APP_ID,
	type PublishCapture,
	type PublishConfiguration,
	type PublishDocument,
} from "../publish";
import { shellSource } from "../targetPeer";

vi.mock("@/lib/auth-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth-utils")>()),
	requireSession: vi.fn(),
}));
vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@/lib/storage/media", () => ({
	downloadAssetBytes: vi.fn(),
	readTextObject: () => {
		throw new Error("Publishing must not read document requirements extracts.");
	},
}));
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
	vi.mocked(downloadAssetBytes).mockReset();
});
const h = setupAppStateTestDb("proof_publish_", { authSchema: "migrated" });

const APP = "published-app",
	PROJECT = "program",
	ACTOR = "editor",
	DOMAIN = "clinic",
	REMOTE_APP = "working-app";
/** The capture's server (`PROOF_SERVER`), so both sides build the same attachment links. */
const HOST = "https://www.commcarehq.org";
const IMPORT = `/a/${DOMAIN}/apps/api/import_app/`;
const SOURCE = `/a/${DOMAIN}/apps/source/${REMOTE_APP}/`;
const TABLES = `/a/${DOMAIN}/api/lookup_table/v1/?limit=100`;
const WORKBOOK = `/a/${DOMAIN}/fixtures/fixapi/`;
const MEDIA = `/a/${DOMAIN}/apps/api/${REMOTE_APP}/multimedia/`;
const SCOPE = {
	appId: APP,
	projectId: PROJECT,
	actorUserId: ACTOR,
	role: "editor",
};

async function seed(doc: BlueprintDoc): Promise<void> {
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
			commcare_server: "production",
			approved_domains: JSON.stringify([
				{ name: DOMAIN, displayName: "Clinic" },
			]),
			updated_at: new Date(),
		})
		.execute();
}

function request(peer: MockAgent, path: string, method = "GET") {
	return peer.get(HOST).intercept({
		path,
		method,
		headers: { authorization: "ApiKey account:fixture-key" },
	});
}

/** Publish the stored app through the real lifecycle, as the MCP tool calls it. */
async function publish(appName?: string) {
	const loaded = await loadAppBlueprint(APP, ACTOR, "edit");
	const outcome = await publishAppToHq({
		scope: SCOPE,
		doc: loaded.doc,
		compiledAtSeq: loaded.app.mutation_seq,
		appName: appName ?? loaded.app.app_name,
		server: "production",
		domain: DOMAIN,
	});
	if (!outcome.landed) {
		throw new Error(
			`Nova's publish was refused: ${JSON.stringify(outcome.refusal)}`,
		);
	}
	return outcome;
}

/** The stored app as the capture reads it: the same document Nova's publish loads. */
async function storedDocument(
	extra: Pick<PublishDocument, "lookup" | "media"> = {},
): Promise<PublishDocument> {
	const loaded = await loadAppBlueprint(APP, ACTOR, "view");
	return {
		id: APP,
		doc: toPersistableDoc(loaded.doc),
		compiledAtSeq: loaded.app.mutation_seq,
		...extra,
	};
}

interface HqApp {
	readonly modules: readonly {
		readonly unique_id: string;
		readonly forms: readonly {
			readonly unique_id: string;
			readonly xmlns: string;
		}[];
	}[];
	readonly profile?: unknown;
	readonly [key: string]: unknown;
}

/** The app JSON with the app id each side names (Nova's mapped app, the capture's placeholder) put in place. */
function appNamedInPlace(app: HqApp): unknown {
	return JSON.parse(
		JSON.stringify(app)
			.split(REMOTE_APP)
			.join("<app id>")
			.split(PLACEHOLDER_APP_ID)
			.join("<app id>"),
	);
}

/** Every module id, form id and `xmlns` an import carries, in order. */
function sentIds(app: HqApp): string[] {
	return app.modules.flatMap((module) => [
		module.unique_id,
		...module.forms.flatMap((form) => [form.unique_id, form.xmlns]),
	]);
}

/** The app JSON a multipart import carries. */
async function appFile(form: FormData | undefined): Promise<HqApp> {
	const file = form?.get("app_file");
	if (!(file instanceof Blob))
		throw new Error("The import carries no app file.");
	return JSON.parse(await file.text());
}

/**
 * The source HQ serves after Nova's imports so far, as the capture's peer
 * answers it: the shell's after a create alone, and after the content
 * import that body with HQ's CommCare version and `profile`.
 */
async function sourceAfter(
	imports: readonly FormData[],
	profile?: unknown,
): Promise<Record<string, unknown>> {
	if (imports.length === 1) {
		return shellSource(await appFile(imports[0]), CORPUS_COMMCARE_VERSION);
	}
	const content = await appFile(imports[1]);
	return {
		...content,
		doc_type: "Application",
		build_spec: {
			...(content.build_spec as Record<string, unknown>),
			version: CORPUS_COMMCARE_VERSION,
		},
		profile: profile ?? content.profile ?? {},
	};
}

/** What a request does to the app or its data, for holding the order of two publishes alike. */
function ordered(sequence: readonly string[]): string[] {
	return sequence.flatMap((entry) => {
		const [method, path = ""] = entry.split(" ");
		const pathname = new URL(path, HOST).pathname;
		if (method === "POST" && pathname.endsWith("/apps/api/import_app/")) {
			return ["import"];
		}
		if (method === "GET" && pathname.includes("/apps/source/")) {
			return ["source read"];
		}
		if (method === "POST" && pathname.endsWith("/fixtures/fixapi/")) {
			return ["workbook"];
		}
		if (method === "POST" && pathname.endsWith("/multimedia/")) {
			return ["media"];
		}
		return [];
	});
}

type FormField =
	| { readonly name: string; readonly value: string }
	| {
			readonly name: string;
			readonly filename: string;
			readonly type: string;
			readonly bytes: Buffer;
	  };

async function fieldsOf(form: FormData): Promise<FormField[]> {
	return Promise.all(
		[...form.entries()].map(async ([name, value]) =>
			typeof value === "string"
				? { name, value }
				: {
						name,
						filename: value.name,
						type: value.type,
						bytes: Buffer.from(await value.arrayBuffer()),
					},
		),
	);
}

async function decoded(captured: CapturedRequest) {
	return fieldsOf(
		await new Response(new Uint8Array(captured.body), {
			headers: { "content-type": captured.contentType },
		}).formData(),
	);
}

/**
 * The import the capture recorded, compared with the one Nova sent: the
 * same fields in the same order and values, except that an update names
 * the placeholder where Nova names the mapped app, and the app JSON is
 * compared with each side's app id put in place. Returns Nova's app JSON.
 */
async function expectSameImport(
	captured: CapturedRequest,
	sent: FormData | undefined,
): Promise<HqApp> {
	if (sent === undefined) throw new Error("Nova sent no such import.");
	const [capturedFields, sentFields] = [
		await decoded(captured),
		await fieldsOf(sent),
	];
	expect(capturedFields.map((field) => field.name)).toEqual(
		sentFields.map((field) => field.name),
	);
	expect(captured.fields).toEqual(sentFields.map((field) => field.name));
	let apps: [HqApp, HqApp] | undefined;
	for (const [index, field] of sentFields.entries()) {
		const mine = capturedFields[index];
		if (field.name === "app_id") {
			expect(field).toEqual({ name: "app_id", value: REMOTE_APP });
			expect(mine).toEqual({ name: "app_id", value: PLACEHOLDER_APP_ID });
		} else if (
			field.name === "app_file" &&
			"bytes" in field &&
			mine &&
			"bytes" in mine
		) {
			expect({ ...mine, bytes: undefined }).toEqual({
				...field,
				bytes: undefined,
			});
			expect(field).toMatchObject({
				filename: "app.json",
				type: "application/json",
			});
			apps = [
				JSON.parse(mine.bytes.toString()),
				JSON.parse(field.bytes.toString()),
			];
		} else {
			expect(mine).toEqual(field);
		}
	}
	if (apps === undefined)
		throw new Error("Neither import carried an app file.");
	const [capturedApp, sentApp] = apps;
	expect(appNamedInPlace(capturedApp)).toEqual(appNamedInPlace(sentApp));
	return sentApp;
}

async function expectSameWorkbook(captured: CapturedRequest, sent: FormData) {
	expect(await decoded(captured)).toEqual(await fieldsOf(sent));
}

/** Each field of a media upload, its ZIP read as the files it holds (name and bytes, in order). */
function mediaUpload(fields: FormField[]) {
	return fields.map((field) =>
		"bytes" in field
			? {
					...field,
					bytes: new AdmZip(field.bytes)
						.getEntries()
						.filter((entry) => !entry.isDirectory)
						.map((entry) => [entry.entryName, entry.getData()]),
				}
			: field,
	);
}

async function expectSameMedia(captured: CapturedRequest, sent: FormData) {
	const [mine, nova] = [
		mediaUpload(await decoded(captured)),
		mediaUpload(await fieldsOf(sent)),
	];
	expect(mine).toEqual(nova);
	expect(nova.map((field) => field.name)).toEqual([
		"waf_padding",
		"bulk_upload_file",
	]);
}

/**
 * A `.ccz`'s entries by name. The profile's `uniqueid`, a fresh UUID on
 * every build, and the app id its runtime URLs name are named in place
 * wherever they occur; binary entries are compared byte for byte through
 * latin1.
 */
function cczEntries(archive: Uint8Array, appId: string): Map<string, string> {
	const entries = new AdmZip(Buffer.from(archive))
		.getEntries()
		.filter((entry) => !entry.isDirectory);
	const profile = entries.find((entry) => entry.entryName === "profile.ccpr");
	if (profile === undefined) throw new Error("The archive has no profile.");
	const uniqueid = parseXml(profile.getData().toString("utf8")).children.find(
		isTag,
	)?.attribs.uniqueid;
	if (!uniqueid) throw new Error("The archive's profile has no uniqueid.");
	return new Map(
		entries.map((entry) => [
			entry.entryName,
			entry
				.getData()
				.toString("latin1")
				.split(uniqueid)
				.join("<uniqueid>")
				.split(appId)
				.join("<app id>"),
		]),
	);
}

function sentSteps(capture: PublishCapture) {
	if (capture.status !== "sent") throw new Error("The capture was refused.");
	const update = capture.updates.update;
	if (update?.status !== "sent") throw new Error("The update was refused.");
	return { first: capture.create, update };
}

/** The requests of each publish, cut from one ordered log at each publish's start. */
function perPublish(log: readonly string[], starts: readonly number[]) {
	return starts.map((start, index) =>
		log.slice(start, starts[index + 1] ?? log.length),
	);
}

it("captures the shell, the content and the profile-preserving update Nova sends for the shared survey app, in Nova's order, and every publish sends the same ids", async () => {
	await seed(clinicVisitsDocument());
	const document = await storedDocument();
	const capture = sentSteps(
		await capturePublish({
			create: document,
			updates: [{ name: "update", document, appName: "Visiting program" }],
			configuration: {
				id: "clinic",
				flags: [],
				caseSearchEnabled: false,
				domain: DOMAIN,
			},
			source: { profile: TARGET_PROFILE_WITH_DERIVED_KEY },
		}),
	);

	const imports: FormData[] = [];
	const log: string[] = [];
	const starts: number[] = [];
	await withHttpPeer(async (peer) => {
		request(peer, IMPORT, "POST")
			.reply(async (opts) => {
				log.push(`POST ${opts.path}`);
				imports.push(await readMultipartRequest(opts));
				return imports.length === 1
					? {
							statusCode: 201,
							data: JSON.stringify({ success: true, app_id: REMOTE_APP }),
						}
					: {
							statusCode: 200,
							data: JSON.stringify({
								success: true,
								app_id: REMOTE_APP,
								version: imports.length,
							}),
						};
			})
			.times(4);
		request(peer, SOURCE)
			.reply(async (opts) => {
				log.push(`GET ${opts.path}`);
				return {
					statusCode: 200,
					data: JSON.stringify(
						await sourceAfter(imports, TARGET_PROFILE_WITH_DERIVED_KEY),
					),
				};
			})
			.times(3);
		starts.push(log.length);
		expect((await publish()).hqAppAction).toBe("created");
		starts.push(log.length);
		expect((await publish("Visiting program")).hqAppAction).toBe("updated");
		starts.push(log.length);
		expect((await publish("Visiting program")).hqAppAction).toBe("updated");
	});

	// The capture sends its requests in the order Nova's publish does.
	const [firstOrder, updateOrder, againOrder] = perPublish(log, starts);
	expect(ordered(capture.first.sequence)).toEqual([
		"import",
		"source read",
		"import",
	]);
	expect(ordered(firstOrder ?? [])).toEqual(ordered(capture.first.sequence));
	expect(ordered(capture.update.sequence)).toEqual(["source read", "import"]);
	expect(ordered(updateOrder ?? [])).toEqual(ordered(capture.update.sequence));
	expect(ordered(againOrder ?? [])).toEqual(ordered(capture.update.sequence));

	const [shell, content, updated, again] = imports;
	const sentShell = await expectSameImport(
		capture.first.create.importApp,
		shell,
	);
	expect(sentShell.modules).toEqual([]);
	const sentContent = await expectSameImport(
		capture.first.content.importApp,
		content,
	);
	const sentUpdate = await expectSameImport(capture.update.importApp, updated);
	// The update carries HQ's own profile settings without Nova's derived key,
	// so the comparison covers the profile projection.
	expect(sentUpdate.profile).toEqual(TARGET_OWNED_PROFILE);
	expect(capture.first.content.lookup).toBeUndefined();
	// Three publishes of one document send one set of ids.
	const ids = sentIds(sentContent);
	expect(ids.length).toBeGreaterThan(1);
	expect(sentIds(sentUpdate)).toEqual(ids);
	expect(sentIds(await appFile(again))).toEqual(ids);
});

it("captures what Nova sends and downloads for Search, lookup data, media and an attachment link, with the verdict naming the flags Nova's check asks about", async () => {
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
	if (code === undefined || name === undefined)
		throw new Error("The table lost its columns.");
	await replaceLookupRows(scope, {
		tableId: table.id,
		expectedTableRevision: table.tableRevision,
		rows: [
			{ [code.id]: "002", [name.id]: "Hospital" },
			{ [code.id]: "001", [name.id]: "École & Clinic" },
		],
	});
	const image = testMediaAssetId("proof-publish-image");
	const png = readFileSync("public/nova-icons/household.png");
	const hash = createHash("sha256").update(png).digest("hex");
	const objectKey = `projects/${PROJECT}/${hash}.png`;
	await seed(searchLookupMediaDocument(table, image));
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
			gcs_object_key: objectKey,
			original_filename: "household.png",
			display_name: "Household",
			status: "ready",
		})
		.execute();
	vi.mocked(downloadAssetBytes).mockImplementation(async (requested) => {
		expect(requested).toBe(objectKey);
		return png;
	});

	const document = await storedDocument({
		lookup: await getLookupFixtureData(scope, [table.id]),
		media: new Map([
			[
				image,
				{ kind: "image", mimeType: "image/png", extension: ".png", bytes: png },
			],
		]),
	});
	const verdict = novaPublishVerdict(
		(await loadAppBlueprint(APP, ACTOR, "view")).doc,
	);
	// HQ's slugs for these symbols: corehq/toggles/__init__.py.
	const everything: PublishConfiguration = {
		id: "everything",
		flags: [
			"SYNC_SEARCH_CASE_CLAIM",
			"VIEW_FORM_ATTACHMENT",
			"CUSTOM_PROPERTIES",
		],
		caseSearchEnabled: true,
		domain: DOMAIN,
	};
	const capture = sentSteps(
		await capturePublish({
			create: document,
			updates: [{ name: "update", document }],
			configuration: everything,
		}),
	);

	const imports: FormData[] = [];
	const workbooks: FormData[] = [];
	const uploads: FormData[] = [];
	const flagQueries: string[] = [];
	const log: string[] = [];
	const starts: number[] = [];
	await withHttpPeer(async (peer) => {
		const listed = { domain_name: DOMAIN, project_name: "Clinic" };
		peer
			.get(HOST)
			.intercept({
				path: (path) => path.startsWith("/api/user_domains/v1/?"),
				method: "GET",
			})
			.reply((opts) => {
				const flag = new URL(opts.path, HOST).searchParams.get("feature_flag");
				if (flag !== null) flagQueries.push(flag);
				return {
					statusCode: 200,
					data: JSON.stringify({ objects: [listed], meta: { total_count: 1 } }),
				};
			})
			.persist();
		request(
			peer,
			`/a/${DOMAIN}/phone/search/?case_type=__nova_compatibility_probe__`,
		)
			.reply(200, "<results/>", {
				headers: { "content-type": "text/xml; charset=utf-8" },
			})
			.times(2);
		const remoteTable = {
			id: "hq-table",
			tag: "facilities",
			is_global: true,
			fields: [{ field_name: "code" }, { field_name: "name" }],
		};
		request(peer, TABLES).reply(200, { objects: [], meta: { next: null } });
		request(peer, TABLES)
			.reply(200, { objects: [remoteTable], meta: { next: null } })
			.times(3);
		request(peer, WORKBOOK, "POST")
			.reply(async (opts) => {
				log.push(`POST ${opts.path}`);
				workbooks.push(await readMultipartRequest(opts));
				return {
					statusCode: 200,
					data: JSON.stringify({ code: 200, message: "Uploaded" }),
				};
			})
			.times(2);
		request(peer, IMPORT, "POST")
			.reply(async (opts) => {
				log.push(`POST ${opts.path}`);
				imports.push(await readMultipartRequest(opts));
				return imports.length === 1
					? {
							statusCode: 201,
							data: JSON.stringify({ success: true, app_id: REMOTE_APP }),
						}
					: {
							statusCode: 200,
							data: JSON.stringify({
								success: true,
								app_id: REMOTE_APP,
								version: imports.length,
							}),
						};
			})
			.times(3);
		// What HQ holds: the shell's source after the create, then the content's.
		request(peer, SOURCE)
			.reply(async (opts) => {
				log.push(`GET ${opts.path}`);
				return {
					statusCode: 200,
					data: JSON.stringify(await sourceAfter(imports)),
				};
			})
			.times(4);
		request(peer, MEDIA, "POST")
			.reply(async (opts) => {
				log.push(`POST ${opts.path}`);
				uploads.push(await readMultipartRequest(opts));
				return {
					statusCode: 200,
					data: JSON.stringify({ success: true, processing_id: "media-job" }),
				};
			})
			.times(2);
		request(peer, `${MEDIA}status/media-job/`)
			.reply(200, {
				success: true,
				processing_id: "media-job",
				complete: true,
				matched_count: 1,
				unmatched_count: 0,
				unmatched_files: [],
				errors: [],
			})
			.times(2);
		starts.push(log.length);
		expect((await publish()).hqAppAction).toBe("created");
		starts.push(log.length);
		expect((await publish()).hqAppAction).toBe("updated");
	});

	// The capture sends its requests in the order Nova's publish does: the
	// shell and its source read before the workbook, and the content after it.
	const [firstOrder, updateOrder] = perPublish(log, starts);
	expect(ordered(capture.first.sequence)).toEqual([
		"import",
		"source read",
		"workbook",
		"source read",
		"import",
		"media",
	]);
	expect(ordered(firstOrder ?? [])).toEqual(ordered(capture.first.sequence));
	expect(ordered(capture.update.sequence)).toEqual([
		"source read",
		"workbook",
		"source read",
		"import",
		"media",
	]);
	expect(ordered(updateOrder ?? [])).toEqual(ordered(capture.update.sequence));

	// The verdict names exactly the flags Nova's own check asked HQ about.
	expect(flagQueries.sort()).toEqual(
		[...verdict.capabilities, ...verdict.advisories]
			.flatMap((item) => item.flags.map((flag) => flag.slug))
			.flatMap((slug) => [slug, slug])
			.sort(),
	);
	const [shell, content, updated] = imports;
	const [contentWorkbook, updatedWorkbook] = workbooks;
	if (!contentWorkbook || !updatedWorkbook) {
		throw new Error("Nova sent fewer than two workbooks.");
	}
	const { content: captured } = capture.first;
	if (!captured.lookup || !capture.update.lookup) {
		throw new Error("The capture sent no workbook.");
	}
	await expectSameWorkbook(captured.lookup, contentWorkbook);
	await expectSameWorkbook(capture.update.lookup, updatedWorkbook);
	// Nova uploads the media after each content import, to the app the
	// first publish made, and none after the shell.
	const [contentMedia, updatedMedia] = uploads;
	if (!contentMedia || !updatedMedia || uploads.length !== 2) {
		throw new Error(
			`Nova sent ${uploads.length} media uploads, not one per publish.`,
		);
	}
	if (!captured.media || !capture.update.media) {
		throw new Error("The capture sent no media upload.");
	}
	await expectSameMedia(captured.media, contentMedia);
	await expectSameMedia(capture.update.media, updatedMedia);
	// The capture names its peer's app, which the HQ side replaces with A's.
	expect(captured.media.path).toBe(
		`/a/${DOMAIN}/apps/api/${PLACEHOLDER_APP_ID}/multimedia/`,
	);
	const sentShell = await expectSameImport(
		capture.first.create.importApp,
		shell,
	);
	expect(sentShell.modules).toEqual([]);
	expect(sentShell).not.toHaveProperty("profile");
	const sentContent = await expectSameImport(captured.importApp, content);
	await expectSameImport(capture.update.importApp, updated);
	// The content was built over the shell's source, HQ's empty profile, and
	// the advisory was available, so it carried Nova's derived key; the
	// update was built over the profile the content left.
	expect(captured.assumedSource).toEqual({
		doc_type: "Application",
		"build_spec.version": CORPUS_COMMCARE_VERSION,
		profile: {},
	});
	expect(sentContent.profile).toBeDefined();
	expect(capture.update.assumedSource.profile).toEqual(sentContent.profile);

	// Once the deployment record names the project space, the compile route
	// builds the download for it, and the capture's archive is that one.
	vi.mocked(requireSession).mockResolvedValue({ user: { id: ACTOR } } as never);
	const response = await compileCcz(
		new NextRequest("http://localhost/api/compile", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ appId: APP }),
		}),
	);
	expect(response.status).toBe(200);
	const routed = new Uint8Array(await response.arrayBuffer());
	const local = await localCcz(document, DOMAIN);
	const [routedEntries, localEntries] = [
		cczEntries(routed, REMOTE_APP),
		cczEntries(local, PLACEHOLDER_APP_ID),
	];
	expect([...localEntries.keys()].sort()).toEqual(
		[...routedEntries.keys()].sort(),
	);
	for (const [entry, content] of routedEntries) {
		expect(localEntries.get(entry), entry).toBe(content);
	}
});
