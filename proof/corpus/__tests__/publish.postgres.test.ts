/**
 * The harness publishes as Nova publishes, and downloads as Nova downloads.
 *
 * Contract: for the same app and the same project space, the requests the
 * harness's capture (`proof/corpus/publish.ts::capturePublish`) records are
 * the requests `publishAppToHq` sends, and the capture's local archive
 * (`localCcz`) is the one Nova's compile route (`app/api/compile/route.ts`)
 * returns once the app's deployment record names that project space. The
 * capture stands in for Nova's database with the Project state preflight
 * would read and for HQ with a peer answering from a configuration, so the
 * plausible failures are there: a lookup snapshot, media manifest,
 * attachment target or compatibility report that differs from what
 * preflight hands the send, an update that reads a different source
 * profile, a verdict naming flags other than the ones Nova's check asks
 * about, or an archive assembled with options the route does not use.
 *
 * Each app is published twice through the real `publishAppToHq` (migrated
 * Postgres, the real preflight and HQ client; only KMS, object storage and
 * the HQ peer are controlled) and captured twice through `capturePublish`.
 * The bodies are compared decoded: field order, `app_name`, `app_id`
 * presence, the app file's name and type, the workbook bytes, the app
 * JSON once each side's module and form `unique_id`s and form `xmlns`,
 * minted afresh on every export, are replaced by their positions, and the
 * media upload Nova sends after the import (`uploadMediaBytes`): its fields,
 * the ZIP's name and type, and each file the ZIP holds, by name and bytes,
 * in order (each ZIP stamps its files with the time it was built). The
 * archives are compared entry by entry with Nova's id minting fixed for
 * both builds and the profile's `uniqueid` named in place; the route runs
 * with only the session and object storage controlled.
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

/** Nova's id minting, fixed while `minting.fixed` is set, for two builds to compare. */
const minting = vi.hoisted(() => ({ fixed: false, next: 0 }));

vi.mock("@/lib/commcare/ids", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/commcare/ids")>();
	const fixed = (length: number) => {
		minting.next += 1;
		return minting.next.toString(16).padStart(length, "0");
	};
	return {
		...original,
		genHexId: () => (minting.fixed ? fixed(40) : original.genHexId()),
		genShortId: () => (minting.fixed ? fixed(16) : original.genShortId()),
	};
});
vi.mock("@/lib/auth-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth-utils")>()),
	requireSession: vi.fn(),
}));
vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@/lib/storage/media", () => ({ downloadAssetBytes: vi.fn() }));
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

/**
 * The app JSON with every module and form `unique_id` and form `xmlns`
 * replaced by its position, wherever it occurs (as a value, in an
 * attachment's name, inside a form's source).
 */
function positional(app: HqApp): unknown {
	let text = JSON.stringify(app);
	app.modules.forEach((module, m) => {
		text = text.split(module.unique_id).join(`<module ${m}>`);
		module.forms.forEach((form, f) => {
			text = text.split(form.xmlns).join(`<xmlns ${m}.${f}>`);
			text = text.split(form.unique_id).join(`<form ${m}.${f}>`);
		});
	});
	return JSON.parse(text);
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
 * compared by position. Returns Nova's app JSON.
 */
async function expectSameImport(
	captured: CapturedRequest,
	sent: FormData,
): Promise<HqApp> {
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
	expect(positional(capturedApp)).toEqual(positional(sentApp));
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
 * every build, is named in place wherever it occurs; binary entries are
 * compared byte for byte through latin1.
 */
function cczEntries(archive: Uint8Array): Map<string, string> {
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
			entry.getData().toString("latin1").split(uniqueid).join("<uniqueid>"),
		]),
	);
}

/** Build with Nova's id minting fixed and restarted, so two builds mint alike. */
async function withFixedMinting<T>(build: () => Promise<T>): Promise<T> {
	minting.fixed = true;
	minting.next = 0;
	try {
		return await build();
	} finally {
		minting.fixed = false;
	}
}

function sentSteps(capture: PublishCapture) {
	if (capture.status !== "sent") throw new Error("The capture was refused.");
	const update = capture.updates.update;
	if (update?.status !== "sent") throw new Error("The update was refused.");
	return {
		create: capture.create,
		update,
		assumed: capture.assumedSourceProfile,
	};
}

it("captures the create and the profile-preserving update Nova sends for the shared survey app", async () => {
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
			sourceProfile: TARGET_PROFILE_WITH_DERIVED_KEY,
		}),
	);

	const imports: FormData[] = [];
	await withHttpPeer(async (peer) => {
		request(peer, IMPORT, "POST")
			.reply(async (opts) => {
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
								version: 2,
							}),
						};
			})
			.times(2);
		request(peer, SOURCE).reply(200, {
			profile: TARGET_PROFILE_WITH_DERIVED_KEY,
		});
		expect((await publish()).hqAppAction).toBe("created");
		expect((await publish("Visiting program")).hqAppAction).toBe("updated");
	});

	const [created, updated] = imports;
	if (created === undefined || updated === undefined)
		throw new Error("Nova sent fewer than two imports.");
	await expectSameImport(capture.create.importApp, created);
	const sentUpdate = await expectSameImport(capture.update.importApp, updated);
	// The update carries HQ's own profile settings without Nova's derived key,
	// so the comparison covers the profile projection.
	expect(sentUpdate.profile).toEqual(TARGET_OWNED_PROFILE);
	expect(capture.create.lookup).toBeUndefined();
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
				workbooks.push(await readMultipartRequest(opts));
				return {
					statusCode: 200,
					data: JSON.stringify({ code: 200, message: "Uploaded" }),
				};
			})
			.times(2);
		request(peer, IMPORT, "POST")
			.reply(async (opts) => {
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
								version: 2,
							}),
						};
			})
			.times(2);
		// What HQ holds after the create: the create's profile, or HQ's empty default.
		request(peer, SOURCE).reply(async () => {
			const file = imports[0]?.get("app_file");
			if (!(file instanceof Blob))
				throw new Error("The source was read before the create.");
			const created = JSON.parse(await file.text()) as HqApp;
			return {
				statusCode: 200,
				data: JSON.stringify({ profile: created.profile ?? {} }),
			};
		});
		request(peer, MEDIA, "POST")
			.reply(async (opts) => {
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
		expect((await publish()).hqAppAction).toBe("created");
		expect((await publish()).hqAppAction).toBe("updated");
	});

	// The verdict names exactly the flags Nova's own check asked HQ about.
	expect(flagQueries.sort()).toEqual(
		[...verdict.capabilities, ...verdict.advisories]
			.flatMap((item) => item.flags.map((flag) => flag.slug))
			.flatMap((slug) => [slug, slug])
			.sort(),
	);
	const [created, updated] = imports;
	const [createdWorkbook, updatedWorkbook] = workbooks;
	if (!created || !updated || !createdWorkbook || !updatedWorkbook) {
		throw new Error("Nova sent fewer than two imports and two workbooks.");
	}
	if (!capture.create.lookup || !capture.update.lookup) {
		throw new Error("The capture sent no workbook.");
	}
	await expectSameWorkbook(capture.create.lookup, createdWorkbook);
	await expectSameWorkbook(capture.update.lookup, updatedWorkbook);
	// Nova uploads the media after each import, to the app the import made.
	const [createdMedia, updatedMedia] = uploads;
	if (!createdMedia || !updatedMedia || uploads.length !== 2) {
		throw new Error(
			`Nova sent ${uploads.length} media uploads, not one per publish.`,
		);
	}
	if (!capture.create.media || !capture.update.media) {
		throw new Error("The capture sent no media upload.");
	}
	await expectSameMedia(capture.create.media, createdMedia);
	await expectSameMedia(capture.update.media, updatedMedia);
	// The capture names its peer's app, which the HQ side replaces with A's.
	expect(capture.create.media.path).toBe(
		`/a/${DOMAIN}/apps/api/${PLACEHOLDER_APP_ID}/multimedia/`,
	);
	const sentCreate = await expectSameImport(capture.create.importApp, created);
	await expectSameImport(capture.update.importApp, updated);
	// The advisory was available, so the create carried Nova's derived key,
	// and the capture assumed the profile HQ keeps from that create.
	expect(sentCreate.profile).toBeDefined();
	expect(capture.assumed).toEqual(sentCreate.profile);

	// Once the deployment record names the project space, the compile route
	// builds the download for it, and the capture's archive is that one.
	vi.mocked(requireSession).mockResolvedValue({ user: { id: ACTOR } } as never);
	const routed = await withFixedMinting(async () => {
		const response = await compileCcz(
			new NextRequest("http://localhost/api/compile", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ appId: APP }),
			}),
		);
		expect(response.status).toBe(200);
		return new Uint8Array(await response.arrayBuffer());
	});
	const local = await withFixedMinting(() => localCcz(document, DOMAIN));
	const [routedEntries, localEntries] = [cczEntries(routed), cczEntries(local)];
	expect([...localEntries.keys()].sort()).toEqual(
		[...routedEntries.keys()].sort(),
	);
	for (const [entry, content] of routedEntries) {
		expect(localEntries.get(entry), entry).toBe(content);
	}
});
