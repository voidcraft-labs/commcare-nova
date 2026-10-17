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
 * test's peer answers every request Nova's client sends as the capture's
 * peer does, by handing it to the capture's own model of the project space
 * (`proof/corpus/targetPeer.ts::TargetPeer`): each source read from what Nova
 * last sent (the shell's source after its create, an update's body with
 * HQ's CommCare version after it), each table list and rows read from the
 * workbooks pushed so far, and what a person saves in HQ as `applyHqSide`
 * applies it. The bodies are compared decoded:
 * field order, `app_name`, `app_id` presence, the app file's name and type,
 * the workbook bytes, the app JSON with the app id each side names put in
 * place, and the media upload Nova sends after the content import
 * (`uploadMediaBytes`): its fields, the ZIP's name and type, and each file
 * the ZIP holds, by name and bytes, in order (each ZIP stamps its files with
 * the time it was built). The order is compared over the requests that
 * write or read the app and its data (imports, source reads, workbooks and
 * media uploads, and since step 2's drift check, the table list and rows
 * reads that compare and baseline the tables). The archives are compared
 * entry by entry with the app id named in place: the profile's `uniqueid` is
 * derived from the app's id and the project space, on the route's archive and
 * on the capture's alike, so it is compared as built; the route runs with only
 * the session and object storage controlled.
 *
 * A document a person saved in HQ over (`hq-side.json`) is captured as the
 * document states the republish goes (`PublishInput.hqSide`): through, or
 * through the stop Nova's preflight makes and the confirmation a person sends
 * back. The capture computes that stop with the production comparison
 * (`hqSourceBaseline.ts`, `hqResourceBaseline.ts`,
 * `remoteChanges.ts::decideRemoteChanges`), and the plausible failure is a
 * capture whose stop is not Nova's: other parts, another digest, or a resend
 * Nova would refuse. So the same saves are applied to Nova's peer, and Nova's
 * refusal must list what the capture's stop lists, and Nova's publish with
 * the capture's discards must send the capture's bytes.
 *
 * The overlays (`lib/commcare/targetOverlay.ts`) carry the target's own part
 * of `translations`, `add_ons` and `profile` from the publish's last read of
 * the app's source before its import. Each case below is a republish after an
 * edit that changes one value Nova owns in each key (a language added, a form
 * given a display condition, saved forms turned on), so the body carries all
 * three: with no table to push, the body is the overlay of the read before
 * the import, and a person's saves of values the target owns ride back in it
 * with no stop; with a table to push, values of the target's own a person
 * saved while the table was pushed are carried from the second read; and a
 * discard changes no overlay, its resend holding Nova's values for Nova's
 * part and the target's values beside them. The plausible failures: an
 * overlay on the first read, which a push makes stale; a discard that writes
 * Nova's whole map over the target's; and a target value read as Nova's, which
 * would stop the publish over a save Nova does not own.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { NextRequest } from "next/server";
import type { MockAgent } from "undici";
import { beforeEach, expect, it, vi } from "vitest";
import {
	readHttpRequestBody,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { POST as compileCcz } from "@/app/api/compile/route";
import { requireSession } from "@/lib/auth-utils";
import { appProfileProperties } from "@/lib/commcare/appProfileSettings";
import { decrypt } from "@/lib/commcare/encryption";
import { profileUniqueId } from "@/lib/commcare/runtimeTarget";
import { parseXml } from "@/lib/commcare/xmlParse";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { commitGuardedBatch } from "@/lib/db/apps";
import {
	clinicVisitsDocument,
	searchLookupMediaDocument,
	TARGET_OWNED_PROFILE,
	TARGET_PROFILE_WITH_DERIVED_KEY,
} from "@/lib/deployment/__tests__/publishFixtures";
import { publishAppToHq } from "@/lib/deployment/service";
import type { RemoteChangeDiscard } from "@/lib/deployment/types";
import { setFormDisplayConditionMutation } from "@/lib/doc/displayConditionMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	addLanguageMutation,
	heldLanguageWireCodes,
} from "@/lib/doc/languageMutations";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { eq, literal, sessionContext } from "@/lib/domain/predicate";
import {
	createLookupTable,
	getLookupFixtureData,
	replaceLookupRows,
} from "@/lib/lookup/service";
import { loadAppBlueprint } from "@/lib/mcp/loadApp";
import { downloadAssetBytes } from "@/lib/storage/media";
import { CORPUS_COMMCARE_VERSION } from "../configurations";
import type { HqSideSaves } from "../documents";
import {
	type CapturedRequest,
	capturePublish,
	localCcz,
	novaPublishVerdict,
	PLACEHOLDER_APP_ID,
	PROOF_SERVER,
	type PublishCapture,
	type PublishConfiguration,
	type PublishDocument,
} from "../publish";
import { type PeerRequest, TargetPeer } from "../targetPeer";

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
const AUTHORIZATION = "ApiKey account:fixture-key";
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

/**
 * The capture's own model of the project space (`TargetPeer`), serving
 * Nova's real client: every request to HQ's host is handed to `model` and
 * recorded in `log`, with its body as sent, and `answered` called with each
 * once the model has answered it.
 */
function servedBy(
	peer: MockAgent,
	model: TargetPeer,
	log: PeerRequest[],
	answered?: (request: PeerRequest) => void,
) {
	peer
		.get(HOST)
		.intercept({ path: () => true, method: () => true })
		.reply(async (opts) => {
			const headers = new Headers(opts.headers as Record<string, string>);
			expect(headers.get("authorization")).toBe(AUTHORIZATION);
			const request: PeerRequest = {
				method: opts.method,
				path: opts.path,
				contentType: headers.get("content-type") ?? undefined,
				body: await readHttpRequestBody(opts),
			};
			model.requests.push(request);
			log.push(request);
			const answer = await model.answer(request);
			answered?.(request);
			return {
				statusCode: answer.status,
				data: answer.body,
				responseOptions: { headers: { "content-type": answer.contentType } },
			};
		})
		.persist();
}

/** A model of the project space `DOMAIN` as the capture's peer holds one, with the app id HQ mints there. */
function projectSpace(
	options: {
		readonly flags?: readonly string[];
		readonly caseSearchEnabled?: boolean;
		readonly appId?: string;
		readonly sourceChanges?: Readonly<Record<string, unknown>>;
	} = {},
): TargetPeer {
	return new TargetPeer({
		credentials: {
			username: "account",
			apiKey: "fixture-key",
			server: "production",
		},
		domain: DOMAIN,
		flags: new Set(options.flags ?? []),
		caseSearchEnabled: options.caseSearchEnabled ?? false,
		appId: options.appId ?? REMOTE_APP,
		commcareVersion: CORPUS_COMMCARE_VERSION,
		...(options.sourceChanges !== undefined && {
			sourceChanges: options.sourceChanges,
		}),
	});
}

/** The multipart form each logged request to `suffix` carried, in order. */
async function formsTo(
	log: readonly PeerRequest[],
	suffix: string,
): Promise<FormData[]> {
	return Promise.all(
		log
			.filter(
				(request) =>
					request.method === "POST" &&
					new URL(request.path, HOST).pathname.endsWith(suffix),
			)
			.map((request) =>
				new Response(new Uint8Array(request.body), {
					headers: { "content-type": request.contentType ?? "" },
				}).formData(),
			),
	);
}

/** Each logged request, `<method> <path>`. */
function lines(log: readonly PeerRequest[]): string[] {
	return log.map((request) => `${request.method} ${request.path}`);
}

/** Publish the stored app through the real lifecycle, as the MCP tool calls it, with what a person confirmed. */
async function attempt(
	confirmed: {
		readonly appName?: string;
		readonly discardRemoteChanges?: readonly RemoteChangeDiscard[];
		readonly adoptResourceIds?: readonly string[];
	} = {},
) {
	const loaded = await loadAppBlueprint(APP, ACTOR, "edit");
	return publishAppToHq({
		scope: SCOPE,
		doc: loaded.doc,
		compiledAtSeq: loaded.app.mutation_seq,
		appName: confirmed.appName ?? loaded.app.app_name,
		server: "production",
		domain: DOMAIN,
		...(confirmed.discardRemoteChanges !== undefined && {
			discardRemoteChanges: confirmed.discardRemoteChanges,
		}),
		...(confirmed.adoptResourceIds !== undefined && {
			adoptResourceIds: confirmed.adoptResourceIds,
		}),
	});
}

/** A publish that must land. */
async function publish(appName?: string) {
	const outcome = await attempt(appName === undefined ? {} : { appName });
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
		if (method === "GET" && pathname.endsWith("/api/lookup_table/v1/")) {
			return ["table list"];
		}
		if (method === "GET" && pathname.endsWith("/api/fixture/v1/")) {
			return ["rows read"];
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
 * the placeholder where Nova names the mapped app (`novaAppId`), and the app JSON is
 * compared with each side's app id put in place. Returns Nova's app JSON.
 */
async function expectSameImport(
	captured: CapturedRequest,
	sent: FormData | undefined,
	novaAppId: string = REMOTE_APP,
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
			expect(field).toEqual({ name: "app_id", value: novaAppId });
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
 * A `.ccz`'s entries by name, the app id its runtime URLs name put in place
 * wherever it occurs; binary entries are compared byte for byte through
 * latin1.
 */
function cczEntries(archive: Uint8Array, appId: string): Map<string, string> {
	const entries = new AdmZip(Buffer.from(archive))
		.getEntries()
		.filter((entry) => !entry.isDirectory);
	return new Map(
		entries.map((entry) => [
			entry.entryName,
			entry.getData().toString("latin1").split(appId).join("<app id>"),
		]),
	);
}

/** The profile `uniqueid` a `.ccz` carries, read from its parsed profile. */
function cczUniqueId(archive: Uint8Array): string | undefined {
	const profile = new AdmZip(Buffer.from(archive)).readAsText("profile.ccpr");
	return parseXml(profile).children.find(isTag)?.attribs.uniqueid;
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

/** A project space with every flag the Search, lookup and media app's check asks about. HQ's slugs for these
 * symbols: corehq/toggles/__init__.py. */
const EVERYTHING: PublishConfiguration = {
	id: "everything",
	flags: [
		"SYNC_SEARCH_CASE_CLAIM",
		"VIEW_FORM_ATTACHMENT",
		"CUSTOM_PROPERTIES",
	],
	caseSearchEnabled: true,
	domain: DOMAIN,
};

/**
 * The Search, lookup and media app stored with its Project's table and
 * uploaded image, and its document as the capture reads it.
 */
async function seedSearchLookupMedia(): Promise<PublishDocument> {
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

	return storedDocument({
		lookup: await getLookupFixtureData(scope, [table.id]),
		media: new Map([
			[
				image,
				{ kind: "image", mimeType: "image/png", extension: ".png", bytes: png },
			],
		]),
	});
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

	const log: PeerRequest[] = [];
	const starts: number[] = [];
	await withHttpPeer(async (peer) => {
		servedBy(
			peer,
			projectSpace({
				sourceChanges: { profile: TARGET_PROFILE_WITH_DERIVED_KEY },
			}),
			log,
		);
		starts.push(log.length);
		expect((await publish()).hqAppAction).toBe("created");
		starts.push(log.length);
		expect((await publish("Visiting program")).hqAppAction).toBe("updated");
		starts.push(log.length);
		expect((await publish("Visiting program")).hqAppAction).toBe("updated");
	});
	const imports = await formsTo(log, "/apps/api/import_app/");

	// The capture sends its requests in the order Nova's publish does, the
	// read back after each import among them.
	const [firstOrder, updateOrder, againOrder] = perPublish(lines(log), starts);
	expect(ordered(capture.first.sequence)).toEqual([
		"import",
		"source read",
		"import",
		"source read",
	]);
	expect(ordered(firstOrder ?? [])).toEqual(ordered(capture.first.sequence));
	expect(ordered(capture.update.sequence)).toEqual([
		"source read",
		"import",
		"source read",
	]);
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
	// beside the settings every Nova app states, so the comparison covers the
	// profile projection.
	expect(sentUpdate.profile).toEqual({
		...TARGET_OWNED_PROFILE,
		properties: {
			...TARGET_OWNED_PROFILE.properties,
			...Object.fromEntries(
				appProfileProperties(document.doc).map(({ key, value }) => [
					key,
					value,
				]),
			),
		},
	});
	expect(capture.first.content.lookup).toBeUndefined();
	// Three publishes of one document send one set of ids.
	const ids = sentIds(sentContent);
	expect(ids.length).toBeGreaterThan(1);
	expect(sentIds(sentUpdate)).toEqual(ids);
	expect(sentIds(await appFile(again))).toEqual(ids);
});

it("captures what Nova sends and downloads for Search, lookup data, media and an attachment link, with the verdict naming the flags Nova's check asks about", async () => {
	const document = await seedSearchLookupMedia();
	const verdict = novaPublishVerdict(
		(await loadAppBlueprint(APP, ACTOR, "view")).doc,
	);
	const everything = EVERYTHING;
	const capture = sentSteps(
		await capturePublish({
			create: document,
			updates: [{ name: "update", document }],
			configuration: everything,
		}),
	);

	const log: PeerRequest[] = [];
	const starts: number[] = [];
	await withHttpPeer(async (peer) => {
		servedBy(
			peer,
			projectSpace({
				flags: everything.flags,
				caseSearchEnabled: everything.caseSearchEnabled,
			}),
			log,
		);
		starts.push(log.length);
		expect((await publish()).hqAppAction).toBe("created");
		starts.push(log.length);
		expect((await publish()).hqAppAction).toBe("updated");
	});
	const imports = await formsTo(log, "/apps/api/import_app/");
	const workbooks = await formsTo(log, "/fixtures/fixapi/");
	const uploads = await formsTo(log, "/multimedia/");
	const flagQueries = log.flatMap((request) => {
		const url = new URL(request.path, HOST);
		const flag = url.searchParams.get("feature_flag");
		return url.pathname === "/api/user_domains/v1/" && flag !== null
			? [flag]
			: [];
	});

	// The capture sends its requests in the order Nova's publish does: the
	// table list preflight reads, the shell and its source read before the
	// workbook, the re-list and the rows read the push records as the table's
	// baseline, the content after it and its read back; and over the app it
	// made, the table's rows compared before anything is sent.
	const [firstOrder, updateOrder] = perPublish(lines(log), starts);
	expect(ordered(capture.first.sequence)).toEqual([
		"table list",
		"import",
		"source read",
		"workbook",
		"table list",
		"rows read",
		"source read",
		"import",
		"source read",
		"media",
	]);
	expect(ordered(firstOrder ?? [])).toEqual(ordered(capture.first.sequence));
	expect(ordered(capture.update.sequence)).toEqual([
		"table list",
		"rows read",
		"source read",
		"workbook",
		"table list",
		"rows read",
		"source read",
		"import",
		"source read",
		"media",
	]);
	expect(ordered(updateOrder ?? [])).toEqual(ordered(capture.update.sequence));
	// The capture assumed the table list and rows its peer answered, which
	// the HQ side holds to HQ's own before it applies the update.
	expect(capture.first.content.assumedResources).toEqual({
		lookupTables: [{ tag: "facilities", table: null }],
	});
	expect(capture.update.assumedResources?.lookupTables).toEqual([
		expect.objectContaining({
			tag: "facilities",
			table: {
				is_global: true,
				fields: [
					{ field_name: "code", properties: [] },
					{ field_name: "name", properties: [] },
				],
				item_attributes: [],
			},
			rows: [
				{ fields: { code: "002", name: "Hospital" } },
				{ fields: { code: "001", name: "École & Clinic" } },
			],
		}),
	]);

	// The verdict names exactly the flags Nova's own check asked HQ about,
	// beside the empty-list text every publish reads for the archive it
	// stores with the deployment.
	expect(flagQueries.sort()).toEqual(
		[...verdict.capabilities, ...verdict.advisories]
			.flatMap((item) => item.flags.map((flag) => flag.slug))
			.concat("empty_case_list_text")
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
	// The content was built over the shell's source, HQ's empty profile and
	// add-ons and the shell's language name, and the advisory was available,
	// so it carried Nova's derived key; the update was built over the profile
	// the content left.
	expect(captured.assumedSource).toEqual({
		doc_type: "Application",
		"build_spec.version": CORPUS_COMMCARE_VERSION,
		profile: {},
		translations: { en: { en: "English" } },
		add_ons: {},
		langs: ["en"],
		auto_gps_capture: false,
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
	// The profile's uniqueid is derived from the app's id and the project
	// space alone, so the two archives carry one though they name other HQ
	// apps.
	expect([cczUniqueId(routed), cczUniqueId(local)]).toEqual([
		profileUniqueId(document.doc.appId, {
			server: PROOF_SERVER,
			domain: DOMAIN,
			appId: REMOTE_APP,
		}),
		profileUniqueId(document.doc.appId, {
			server: PROOF_SERVER,
			domain: DOMAIN,
			appId: PLACEHOLDER_APP_ID,
		}),
	]);
	expect(cczUniqueId(routed)).toBe(cczUniqueId(local));
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

/** The update the capture sent through a person's confirmation, and the stops it met on the way. */
function confirmedUpdate(capture: PublishCapture) {
	const { update } = sentSteps(capture);
	if (update.confirmed === undefined) {
		throw new Error("The capture sent the update without meeting a stop.");
	}
	return { update, confirmed: update.confirmed };
}

/** The project space every app without Search, lookup data or media is published to. */
const CLINIC: PublishConfiguration = {
	id: "clinic",
	flags: [],
	caseSearchEnabled: false,
	domain: DOMAIN,
};

/**
 * Commit, as a person's edit in the builder does, one change to a value
 * Nova owns in each key the overlays carry: saved forms turned on
 * (`profile`), Spanish added (`translations`), and the first form given a
 * display condition, which needs the `display_conditions` add-on
 * (`add_ons`).
 */
async function editInEachKey(): Promise<void> {
	const { doc } = await loadAppBlueprint(APP, ACTOR, "edit");
	const [module] = doc.moduleOrder;
	const form: Uuid | undefined =
		module === undefined ? undefined : doc.formOrder[module]?.[0];
	if (form === undefined) {
		throw new Error("The app has no form to give a display condition.");
	}
	const mutations: Mutation[] = [
		{ kind: "setAppSettings", settings: { showSavedForms: true } },
		addLanguageMutation(heldLanguageWireCodes(doc), { language: "spa" }),
		setFormDisplayConditionMutation(
			form,
			eq(sessionContext("username"), literal("lead")),
		),
	];
	await commitGuardedBatch({
		appId: APP,
		batchId: "edit-in-each-key",
		mutations: admitMutationBatch(mutations),
		actorUserId: ACTOR,
		kind: "autosave",
		expectedProjectId: PROJECT,
	});
}

/**
 * A person's saves in HQ of values the target owns, one in each key the
 * overlays carry and one beside them: a UI translation, an add-on the app
 * does not need, a setting Nova seeds only where the target holds none, and
 * "Auto Capture Location", which an app that is not a Connect app leaves to
 * the target.
 */
const TARGETS_OWN = {
	uiTranslations: { en: { "home.start": "Begin a visit" } },
	addOns: { menu_mode: true },
	profileProperties: { "cc-autoup-freq": "freq-daily" },
	appAttributes: { auto_gps_capture: true },
} as const;

/** The first import of `log` (`<what>` names it in the failure). */
async function firstImport(
	log: readonly PeerRequest[],
	what: string,
): Promise<FormData> {
	const [sent] = await formsTo(log, "/apps/api/import_app/");
	if (sent === undefined) throw new Error(`Nova sent no import ${what}.`);
	return sent;
}

it("captures a republish after an edit in each key, over a person's saves of the target's own values, which goes through with no stop and carries both", async () => {
	await seed(clinicVisitsDocument());
	const original = await storedDocument();
	const saves: HqSideSaves = { republish: "proceeds", ...TARGETS_OWN };

	// Nova's own publish over a project space where HQ mints the app id the
	// capture names, the saves made over it, and the edit committed before
	// the republish.
	const model = projectSpace({ appId: PLACEHOLDER_APP_ID });
	const log: PeerRequest[] = [];
	const republished = await withHttpPeer(async (peer) => {
		servedBy(peer, model, log);
		expect((await publish()).hqAppAction).toBe("created");
		model.applyHqSide(saves);
		await editInEachKey();
		const before = log.length;
		expect((await publish()).hqAppAction).toBe("updated");
		return log.slice(before);
	});
	const { update } = sentSteps(
		await capturePublish({
			create: original,
			updates: [{ name: "update", document: await storedDocument() }],
			configuration: CLINIC,
			hqSide: saves,
		}),
	);

	// The capture met no stop, and sent what Nova sent in Nova's order.
	expect(update.confirmed).toBeUndefined();
	expect(ordered(lines(republished))).toEqual(ordered(update.sequence));
	const sent = await expectSameImport(
		update.importApp,
		await firstImport(republished, "for the republish"),
		PLACEHOLDER_APP_ID,
	);
	// The body carries Nova's edit in each key beside the person's saves,
	// and leaves the setting the target owns out, so HQ keeps it.
	expect(sent.langs).toEqual(["en", "es"]);
	expect(sent.translations).toMatchObject({
		en: { "home.start": "Begin a visit" },
	});
	expect(sent.add_ons).toEqual({ menu_mode: true, display_conditions: true });
	expect(sent.profile).toMatchObject({
		properties: { "cc-autoup-freq": "freq-daily", "cc-show-saved": "yes" },
	});
	expect(sent).not.toHaveProperty("auto_gps_capture");
	expect(update.assumedSource).toMatchObject({
		add_ons: TARGETS_OWN.addOns,
		auto_gps_capture: true,
	});
});

it("captures the stop Nova makes over a person's save of a value Nova owns, and a resend that holds Nova's value beside the target's", async () => {
	await seed(clinicVisitsDocument());
	const original = await storedDocument();
	const saves: HqSideSaves = {
		republish: "discards",
		uiTranslations: TARGETS_OWN.uiTranslations,
		profileProperties: { "cc-show-incomplete": "yes" },
	};

	const model = projectSpace({ appId: PLACEHOLDER_APP_ID });
	const log: PeerRequest[] = [];
	const { refused, landed } = await withHttpPeer(async (peer) => {
		servedBy(peer, model, log);
		expect((await publish()).hqAppAction).toBe("created");
		model.applyHqSide(saves);
		await editInEachKey();
		const refused = await attempt();
		if (refused.landed)
			throw new Error("Nova published over the save without asking.");
		const before = log.length;
		const landed = await attempt({
			discardRemoteChanges: refused.refusal.remoteChanges.map((change) => ({
				kind: change.kind,
				novaResourceId: change.novaResourceId,
				observedDigest: change.observedDigest,
			})),
		});
		return { refused, landed: { outcome: landed, log: log.slice(before) } };
	});
	const { update, confirmed } = confirmedUpdate(
		await capturePublish({
			create: original,
			updates: [{ name: "update", document: await storedDocument() }],
			configuration: CLINIC,
			hqSide: saves,
		}),
	);

	// The capture met the stop Nova makes: the same code, the same change with
	// the same parts and the digest Nova binds a discard to. The translation
	// the target owns is no part of it.
	expect(confirmed.stops).toEqual([
		{
			code: "hq_changed",
			remoteChanges: refused.refusal.remoteChanges,
			conflicts: [],
		},
	]);
	expect(refused.refusal.remoteChanges.map((change) => change.parts)).toEqual([
		["A setting this app writes"],
	]);
	expect(confirmed.discards).toEqual(
		refused.refusal.remoteChanges.map((change) => ({
			kind: change.kind,
			novaResourceId: change.novaResourceId,
			observedDigest: change.observedDigest,
		})),
	);
	// Nova's publish with that confirmation lands and sends the capture's
	// bytes: Nova's value for the setting it owns, the person's translation
	// kept beside Nova's own.
	expect(landed.outcome.landed).toBe(true);
	expect(ordered(lines(landed.log))).toEqual(ordered(update.sequence));
	const sent = await expectSameImport(
		update.importApp,
		await firstImport(landed.log, "after the confirmation"),
		PLACEHOLDER_APP_ID,
	);
	expect(sent.profile).toMatchObject({
		properties: { "cc-show-incomplete": "no", "cc-show-saved": "yes" },
	});
	expect(sent.translations).toMatchObject({
		en: { "home.start": "Begin a visit" },
	});
});

it("carries the target's own values a person saved while the table was pushed, from the read after the push", async () => {
	const original = await seedSearchLookupMedia();
	const saves: HqSideSaves = {
		republish: "proceeds",
		uiTranslations: TARGETS_OWN.uiTranslations,
		addOns: TARGETS_OWN.addOns,
		appAttributes: TARGETS_OWN.appAttributes,
	};

	// The saves land in HQ as soon as the republish's workbook is answered,
	// after every read the publish compares and before the read its import
	// is built on.
	const model = projectSpace({
		appId: PLACEHOLDER_APP_ID,
		flags: EVERYTHING.flags,
		caseSearchEnabled: EVERYTHING.caseSearchEnabled,
	});
	const log: PeerRequest[] = [];
	let saving = false;
	const republished = await withHttpPeer(async (peer) => {
		servedBy(peer, model, log, (request) => {
			const pushed =
				request.method === "POST" &&
				new URL(request.path, HOST).pathname.endsWith("/fixtures/fixapi/");
			if (saving && pushed) {
				saving = false;
				model.applyHqSide(saves);
			}
		});
		expect((await publish()).hqAppAction).toBe("created");
		await editInEachKey();
		saving = true;
		const before = log.length;
		expect((await publish()).hqAppAction).toBe("updated");
		return log.slice(before);
	});
	expect(saving).toBe(false);
	// The capture makes the saves before the update, which therefore sends the
	// same body only when Nova's is built on the read after the push.
	const { update } = sentSteps(
		await capturePublish({
			create: original,
			updates: [
				{
					name: "update",
					document: {
						...(await storedDocument()),
						lookup: original.lookup,
						media: original.media,
					},
				},
			],
			configuration: EVERYTHING,
			hqSide: saves,
		}),
	);
	expect(update.confirmed).toBeUndefined();
	expect(ordered(lines(republished))).toEqual(ordered(update.sequence));
	const sent = await expectSameImport(
		update.importApp,
		await firstImport(republished, "for the republish"),
		PLACEHOLDER_APP_ID,
	);
	expect(sent.translations).toMatchObject({
		en: { "home.start": "Begin a visit" },
	});
	expect(sent.add_ons).toMatchObject({
		menu_mode: true,
		display_conditions: true,
	});
});

it("captures the table a person kept in HQ as the name clash Nova refuses, and sends what Nova sends once it is taken over", async () => {
	const document = await seedSearchLookupMedia();
	const saves = {
		republish: "discards",
		lookupTable: {
			tag: "facilities",
			fieldProperty: { field: "name", property: "lang", value: "en" },
			rowAttribute: { name: "zone", values: ["upland", "coastal"] },
			owners: {
				user: "facility.lead",
				group: "Facility leads",
				location: { name: "North office", siteCode: "north_office" },
			},
			description: "The facilities the team visits",
		},
	} satisfies HqSideSaves;
	const { update, confirmed } = confirmedUpdate(
		await capturePublish({
			create: document,
			updates: [{ name: "update", document }],
			configuration: EVERYTHING,
			hqSide: saves,
		}),
	);

	const model = projectSpace({
		appId: PLACEHOLDER_APP_ID,
		flags: EVERYTHING.flags,
		caseSearchEnabled: EVERYTHING.caseSearchEnabled,
	});
	const log: PeerRequest[] = [];
	const { refused, landed } = await withHttpPeer(async (peer) => {
		servedBy(peer, model, log);
		expect((await publish()).hqAppAction).toBe("created");
		model.applyHqSide(saves);
		const refused = await attempt();
		if (refused.landed)
			throw new Error("Nova pushed over the kept table without asking.");
		const before = log.length;
		const landed = await attempt({
			adoptResourceIds: refused.refusal.resourceConflicts.map(
				(conflict) => conflict.novaResourceId,
			),
		});
		return { refused, landed: { outcome: landed, log: log.slice(before) } };
	});

	// HQ's upload of the kept table made it again under a new id, so Nova
	// reads a table it cannot account for: a name clash, never a drift change.
	expect(refused.refusal.failure.code).toBe("hq_resource_conflict");
	expect(confirmed.stops).toEqual([
		{
			code: "hq_resource_conflict",
			remoteChanges: [],
			conflicts: refused.refusal.resourceConflicts.map((conflict) => ({
				tableId: conflict.novaResourceId,
				tag: conflict.identity,
				remoteId: conflict.remoteId,
			})),
		},
	]);
	expect(confirmed.adopted).toEqual(
		refused.refusal.resourceConflicts.map(
			(conflict) => conflict.novaResourceId,
		),
	);
	expect(landed.outcome.landed).toBe(true);
	// The capture assumed the table as the person kept it, which the HQ side
	// holds to HQ's own before it applies the update.
	expect(update.assumedResources?.lookupTables).toEqual([
		{
			tag: "facilities",
			table: {
				is_global: true,
				fields: [
					{ field_name: "code", properties: [] },
					{ field_name: "name", properties: ["lang"] },
				],
				item_attributes: ["zone"],
			},
		},
	]);
	const [workbook] = await formsTo(landed.log, "/fixtures/fixapi/");
	if (workbook === undefined || update.lookup === undefined) {
		throw new Error("Neither publish pushed the table after taking it over.");
	}
	await expectSameWorkbook(update.lookup, workbook);
	expect(ordered(lines(landed.log))).toEqual(ordered(update.sequence));
});
