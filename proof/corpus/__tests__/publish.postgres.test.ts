import { publishFromSession as publishAppToHq } from "@/lib/deployment/__tests__/publishWithGrant";
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
 *
 * A table the app reads that CommCare HQ manages in the project space is read
 * before anything else, as the `managed-data` edge reads it, and never sent:
 * the capture's peer holds CommCare HQ's table (`PublishInput.hqTables`) and
 * answers both sides' reads from it. The plausible failures: a capture that
 * pushes the table Nova leaves out, reads it in another order than Nova, or
 * passes over a table Nova's publish would refresh or stop on.
 *
 * Over an app CommCare HQ's own pages made (`PublishInput.hqAuthoredA`), the
 * capture publishes as Nova publishes over an app it brought in. Contract:
 * Nova's real publish, over a deployment written by
 * `recordAdoptedDeploymentInTransaction` from the reading's own identity
 * rows and production's `adoptedAppBaselineWrite`, and over a peer holding
 * HQ's retained source of that app, sends the republish the capture
 * recorded, in the same order, under A's own menu and form ids and `xmlns`.
 * The plausible failures: a capture whose ledger is not a bring-in's (it
 * stops where Nova goes on, or the reverse), a body carrying a derived id
 * where the deployment holds HQ's, and a body carrying Nova's language names
 * or seeds where a bring-in leaves the project space's.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { NextRequest } from "next/server";
import type { MockAgent } from "undici";
import { beforeEach, expect, it, vi } from "vitest";
import {
	readHttpRequestBody,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import { servePublishImages } from "@/__tests__/helpers/publishImageStorage";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { POST as compileCcz } from "@/app/api/compile/route";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { requireSession } from "@/lib/auth-utils";
import { appProfileProperties } from "@/lib/commcare/appProfileSettings";
import { decrypt } from "@/lib/commcare/encryption";
import * as hqReading from "@/lib/commcare/hq/appReading";
import { parseHqAppSource } from "@/lib/commcare/hq/appSource";
import {
	jrFileRef,
	wirePathFor,
} from "@/lib/commcare/multimedia/assetWirePath";
import { profileUniqueId } from "@/lib/commcare/runtimeTarget";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import { parseXml } from "@/lib/commcare/xmlParse";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	prepareGenesisCandidate,
	writePreparedGenesisInTransaction,
} from "@/lib/db/appGenesis";
import { commitGuardedBatch } from "@/lib/db/apps";
import { claimHqAppInTransaction } from "@/lib/db/hqAppClaims";
import { withAppTx } from "@/lib/db/pg";
import {
	makeManagedCopy,
	readerOf,
	type ServedTable,
} from "@/lib/deployment/__tests__/managedFixtures";
import {
	clinicVisitsDocument,
	searchLookupMediaDocument,
	TARGET_OWNED_PROFILE,
	TARGET_PROFILE_WITH_DERIVED_KEY,
} from "@/lib/deployment/__tests__/publishFixtures";
import { adoptedAppBaselineWrite } from "@/lib/deployment/adoption";
import { bringInHqChanges } from "@/lib/deployment/hqChanges/bringIn";
import { reviewHqChanges } from "@/lib/deployment/hqChanges/review";
import { summarizeServedHqApp } from "@/lib/deployment/reading/__tests__/servedHqApp";
import { adoptionExportBoundary } from "@/lib/deployment/reading/adoptionBoundary";
import * as deploymentStore from "@/lib/deployment/store";
import { recordAdoptedDeploymentInTransaction } from "@/lib/deployment/store";
import { canonicalTargetIdentity } from "@/lib/deployment/targetIdentity";
import type {
	DeploymentConfirmationKey,
	DeploymentRemoteChange,
	RemoteChangeDiscard,
} from "@/lib/deployment/types";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { setFormDisplayConditionMutation } from "@/lib/doc/displayConditionMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import {
	addLanguageMutation,
	heldLanguageWireCodes,
} from "@/lib/doc/languageMutations";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, blueprintDocSchema, type Uuid } from "@/lib/domain";
import { eq, literal, sessionContext } from "@/lib/domain/expression";
import {
	createLookupTable,
	getLookupFixtureData,
	replaceLookupRows,
} from "@/lib/lookup/service";
import { loadAppBlueprint } from "@/lib/mcp/loadApp";
import type { FirstPublishChangeId } from "@/lib/publish/firstPublishChangeIds";
import { USE_HQ_TABLE_OFFERED } from "@/lib/publish/managedData";
import { PLAN_FEATURE_IDS } from "@/lib/publish/planFeatures";
import { CORPUS_COMMCARE_VERSION } from "../configurations";
import type { HqSideSaves } from "../documents";
import { hqAuthoredDocuments } from "../hqAuthored";
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
import {
	type PeerRequest,
	type PeerTable,
	shellSource,
	TargetPeer,
} from "../targetPeer";
import { writeControlledBase } from "./controlledBase";

vi.mock("@/lib/auth-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth-utils")>()),
	requireSession: vi.fn(),
}));
vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@/lib/storage/media", () => ({
	downloadAssetBytes: vi.fn(),
	getStoredObjectMetadata: vi.fn(),
	streamAsset: vi.fn(),
	readTextObject: () => {
		throw new Error("Publishing must not read document requirements extracts.");
	},
}));
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
	servePublishImages(PROJECT);
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
	await connect();
}

/**
 * `doc` born as Nova births an app (`lib/db/appGenesis.ts`), with its
 * sequence-one fold baseline: the baseline a deployment's revision pairs
 * with, so a publish's stop offers to bring changes made in CommCare HQ in
 * (`hqChanges/reference.ts::usablePair`), as it does for the capture's app.
 * Project data referenced by this document must be present before its birth.
 */
async function seedBorn(doc: BlueprintDoc): Promise<void> {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const candidate = prepareGenesisCandidate({
		appId: APP,
		projectId: PROJECT,
		mutations: diffDocsToMutations(emptyBlueprintDoc(APP), {
			...doc,
			appId: APP,
		}),
	});
	await h.withTransaction((tx) =>
		writePreparedGenesisInTransaction(tx, {
			candidate,
			actorUserId: ACTOR,
			runId: crypto.randomUUID(),
			status: "complete",
		}),
	);
	await connect();
}

/** The actor's CommCare HQ connection to the project space. */
async function connect(): Promise<void> {
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
		readonly cloudcareGranted?: boolean;
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
		/* Every app these publish declares Web Apps, so the space grants it,
		 * as the lane's configuration does (`_needs_cloudcare`). */
		cloudcareGranted: options.cloudcareGranted ?? true,
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

/**
 * Every confirmation a publish can ask for. The capture publishes to the
 * project space its configuration makes, which has each one, so the person
 * here says yes to all of them; preflight keeps only what the app needs.
 * `lib/deployment/__tests__/publishGates.postgres.test.ts` holds the asking.
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
		requireHqImport: null,
		scope: SCOPE,
		doc: loaded.doc,
		compiledAtSeq: loaded.app.mutation_seq,
		appName: confirmed.appName ?? loaded.app.app_name,
		server: "production",
		domain: DOMAIN,
		confirm: CONFIRM_ALL,
		reloadHead: async () => {
			const fresh = await loadAppBlueprint(APP, ACTOR, "edit");
			return { doc: fresh.doc, seq: fresh.app.mutation_seq };
		},
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
		if (method === "GET" && pathname.startsWith("/hq/multimedia/file/"))
			return ["file read"];
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
	expect(await decoded(captured)).toEqual(await fieldsOf(sent));
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
	const { id, file } = await seedProjectImage();
	await seed(searchLookupMediaDocument(table, id));
	return storedDocument({
		lookup: await getLookupFixtureData(scope, [table.id]),
		media: new Map([[id, file]]),
	});
}

/** One uploaded image with Project metadata and the same bytes in object storage. */
async function seedProjectImage() {
	const image = testMediaAssetId("proof-publish-image");
	const png = readFileSync("public/nova-icons/household.png");
	const hash = createHash("sha256").update(png).digest("hex");
	const objectKey = `projects/${PROJECT}/${hash}.png`;
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
			media_format: "png",
		})
		.execute();
	servePublishImages(PROJECT, png);

	return {
		id: image,
		file: {
			kind: "image" as const,
			mimeType: "image/png",
			extension: ".png" as const,
			bytes: png,
		},
	};
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

it("keeps the file a member took between the app import and its media upload", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const { id, file: image } = await seedProjectImage();
	await seedBorn(
		buildDoc({
			appName: "Household visit",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								{
									id: "note",
									kind: "text",
									label: "Note",
									label_media: { image: id },
								},
							],
						},
					],
				},
			],
		}),
	);
	const path = wirePathFor(
		createHash("sha256").update(image.bytes).digest("hex"),
		image.extension,
	);
	const model = projectSpace();
	const target = { server: "production" as const, domain: DOMAIN };
	const log: PeerRequest[] = [];
	await withHttpPeer(async (peer) => {
		const trace: { method: string; path: string; status: number | string }[] =
			[];
		const reads: unknown[] = [];
		const report = () =>
			JSON.stringify({
				trace,
				unexpected: model.unexpected.map(({ method, path }) => ({
					method,
					path,
				})),
				readings: reads,
				transport: peer
					.getCallHistory()
					?.calls()
					.map(({ method, fullUrl }) => ({
						method,
						path: new URL(fullUrl).pathname,
					})),
			});
		const originalAnswer = model.answer.bind(model);
		const transport = vi
			.spyOn(model, "answer")
			.mockImplementation(async (request) => {
				try {
					let result: Awaited<ReturnType<typeof model.answer>>;
					if (
						request.method === "GET" &&
						request.path === `/a/${DOMAIN}/api/application/v1/${REMOTE_APP}/`
					) {
						// HQ's application API and source describe the same working app.
						const source = await originalAnswer({
							...request,
							path: `/a/${DOMAIN}/apps/source/${REMOTE_APP}/`,
						});
						const body = JSON.parse(Buffer.from(source.body).toString());
						const { resource } = summarizeServedHqApp(
							{ ...body, version: model.saveCounter() },
							REMOTE_APP,
						);
						result = {
							status: resource.status,
							contentType: "application/json",
							body:
								typeof resource.body === "string"
									? resource.body
									: JSON.stringify(resource.body),
						};
					} else result = await originalAnswer(request);
					trace.push({
						method: request.method,
						path: request.path,
						status: result.status,
					});
					return result;
				} catch (error) {
					trace.push({
						method: request.method,
						path: request.path,
						status: String(error),
					});
					throw error;
				}
			});
		const read = hqReading.readHqAppForReading;
		const reading = vi
			.spyOn(hqReading, "readHqAppForReading")
			.mockImplementation(async (...args) => {
				const value = await read(...args);
				reads.push(value.kind === "failed" ? value : value.kind);
				return value;
			});
		servedBy(peer, model, log);
		const admit = deploymentStore.admitAppWrite;
		let reviewedId: string | undefined;
		const hook = vi
			.spyOn(deploymentStore, "admitAppWrite")
			.mockImplementation(async (...args) => {
				if (args[2].writeKind === "media") {
					expect(
						(await deploymentStore.readAppBaseline(SCOPE, target))?.origin,
					).toBe("push");
					// HQ just accepted the app. Someone uploaded this Project image
					// through HQ before Nova sent its own bundle to that same path.
					const previousVersion = model.saveCounter();
					if (previousVersion === null)
						throw new Error("Expected the imported working app.");
					model.applyHqSide({
						republish: "proceeds",
						mediaReplaced: {
							path: jrFileRef(path),
							mimeType: image.mimeType,
							base64: Buffer.from(image.bytes).toString("base64"),
						},
					});
					expect(model.saveCounter()).toBe(previousVersion + 1);
					const remoteFile = model.mappedAt(jrFileRef(path));
					if (!remoteFile)
						throw new Error("Expected HQ to retain the member’s file.");
					const review = await reviewHqChanges(SCOPE, target, {
						onEvent: () => {},
					});
					if (
						review.kind !== "nothing" ||
						!review.readingId ||
						!review.reviewDigest
					)
						throw new Error(
							"Expected the verified matching file to be recordable: " +
								JSON.stringify(review),
						);
					const taken = await bringInHqChanges(
						SCOPE,
						target,
						{
							readingId: review.readingId,
							reviewDigest: review.reviewDigest,
							tableChoices: {},
						},
						{ onEvent: () => {} },
					);
					expect(taken.kind, JSON.stringify(taken)).toBe("recorded");
					reviewedId = (await deploymentStore.readAppBaseline(SCOPE, target))
						?.mediaFiles?.[path];
					expect(reviewedId).toBe(remoteFile.id);
				}
				return admit(...args);
			});
		try {
			expect((await publish()).hqAppAction).toBe("created");
		} catch (error) {
			throw new Error(report(), { cause: error });
		} finally {
			hook.mockRestore();
			transport.mockRestore();
			reading.mockRestore();
		}
		expect(reviewedId).toEqual(expect.any(String));
		expect(
			log.filter(
				(request) =>
					request.method === "POST" && request.path.endsWith("/multimedia/"),
			),
		).toHaveLength(0);
		expect(
			(await deploymentStore.readAppBaseline(SCOPE, target))?.mediaFiles?.[
				path
			],
		).toBe(reviewedId);
		expect(model.unexpected).toEqual([]);
	});
}, 30_000);

it("captures what Nova sends and downloads for Search, lookup data, media and an attachment link, with the verdict naming the flags Nova's check asks about", async () => {
	const document = await seedSearchLookupMedia();
	const verdict = novaPublishVerdict(
		(await loadAppBlueprint(APP, ACTOR, "view")).doc,
		document,
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
		"source read",
		"file read",
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
	// The landed app and its authenticated file confirm the first POST.
	// An unchanged republish finds the id Nova recorded still at the path,
	// reuses that file without reading it, and sends no second POST.
	expect(uploads).toHaveLength(1);
	expect(captured.mediaUploads).toHaveLength(1);
	expect(capture.update.mediaUploads).toEqual([]);
	const [contentMedia] = uploads;
	const [physical] = captured.mediaUploads;
	if (!contentMedia || !physical) throw new Error("No first media upload.");
	await expectSameMedia(physical.request, contentMedia);
	expect(physical.request.path).toBe(
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
		/* The space grants Web Apps, so HQ's create made the app with it on. */
		cloudcare_enabled: true,
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
	// The first publish recorded the placements it sent, so the stored app
	// the route compiles is the held document, one revision on.
	const held = await storedDocument({
		...(document.lookup !== undefined && { lookup: document.lookup }),
		...(document.media !== undefined && { media: document.media }),
	});
	expect(held.compiledAtSeq).toBe(document.compiledAtSeq + 1);
	const local = await localCcz(held, DOMAIN);
	if (!Buffer.isBuffer(local))
		throw new Error("The app declares Android, and has no CCZ.");
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

/** CommCare HQ's table that Nova's copy is made from, as `managedFixtures.ts` serves one. */
const MANAGED_FACILITIES: ServedTable = {
	id: "hq-facilities",
	tag: "facilities",
	fields: ["code", "name"],
	rows: [
		{ code: "001", name: "North" },
		{ code: "002", name: "South" },
	],
};

/** `MANAGED_FACILITIES` as the capture's peer holds a table HQ's own upload made. */
const MANAGED_FACILITIES_HELD: PeerTable = {
	id: MANAGED_FACILITIES.id,
	tag: MANAGED_FACILITIES.tag,
	isGlobal: true,
	fields: MANAGED_FACILITIES.fields.map((name) => ({ name, properties: [] })),
	itemAttributes: [],
	description: "",
	rows: MANAGED_FACILITIES.rows.map((row, index) => ({
		id: `${MANAGED_FACILITIES.id}-row-${index}`,
		fields: Object.fromEntries(
			Object.entries(row).map(([name, value]) => [
				name,
				[{ value, properties: {} }],
			]),
		),
		itemAttributes: {},
	})),
};

it("captures the managed-data edge's reads of a table CommCare HQ manages in the project space, and sends no workbook for it", async () => {
	const scope = { projectId: PROJECT, actorId: ACTOR, role: "editor" };
	/* A lookup writer reads its member's role on its own transaction. */
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const copy = await makeManagedCopy(h, scope, MANAGED_FACILITIES, {
		server: PROOF_SERVER,
		domain: DOMAIN,
	});
	await seed(readerOf([copy]));
	const document = await storedDocument({
		lookup: await getLookupFixtureData(scope, [copy.tableId]),
	});
	const capture = sentSteps(
		await capturePublish({
			create: document,
			updates: [{ name: "update", document }],
			configuration: CLINIC,
			hqTables: [MANAGED_FACILITIES_HELD],
		}),
	);

	const log: PeerRequest[] = [];
	const starts: number[] = [];
	await withHttpPeer(async (peer) => {
		const model = projectSpace();
		model.holdTables([MANAGED_FACILITIES_HELD]);
		servedBy(peer, model, log);
		starts.push(log.length);
		expect((await publish()).hqAppAction).toBe("created");
		starts.push(log.length);
		expect((await publish()).hqAppAction).toBe("updated");
	});

	// Each publish reads the table list and the managed table's rows before
	// anything else, as the `managed-data` edge does, and pushes no workbook:
	// CommCare HQ manages the one table the app reads.
	const [firstOrder, updateOrder] = perPublish(lines(log), starts);
	expect(ordered(capture.first.sequence)).toEqual([
		"table list",
		"rows read",
		"import",
		"source read",
		"import",
		"source read",
	]);
	expect(ordered(firstOrder ?? [])).toEqual(ordered(capture.first.sequence));
	expect(ordered(capture.update.sequence)).toEqual([
		"table list",
		"rows read",
		"source read",
		"import",
		"source read",
	]);
	expect(ordered(updateOrder ?? [])).toEqual(ordered(capture.update.sequence));
	expect(await formsTo(log, "/fixtures/fixapi/")).toEqual([]);
	expect(capture.first.content.lookup).toBeUndefined();
	expect(capture.update.lookup).toBeUndefined();
	// The rows the edge read are recorded beside the body, for the HQ side to
	// hold to HQ's own table before it applies the capture.
	expect(capture.first.content.assumedResources).toEqual({
		lookupTables: [
			{
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
					{ fields: { code: "001", name: "North" } },
					{ fields: { code: "002", name: "South" } },
				],
			},
		],
	});
	const [shell, content, updated] = await formsTo(log, "/apps/api/import_app/");
	await expectSameImport(capture.first.create.importApp, shell);
	await expectSameImport(capture.first.content.importApp, content);
	await expectSameImport(capture.update.importApp, updated);
});

it("ends the capture by name where the peer holds a managed table otherwise than Nova's copy", async () => {
	const scope = { projectId: PROJECT, actorId: ACTOR, role: "editor" };
	/* A lookup writer reads its member's role on its own transaction. */
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const copy = await makeManagedCopy(h, scope, MANAGED_FACILITIES, {
		server: PROOF_SERVER,
		domain: DOMAIN,
	});
	await seed(readerOf([copy]));
	const document = await storedDocument({
		lookup: await getLookupFixtureData(scope, [copy.tableId]),
	});
	const [north, south] = MANAGED_FACILITIES_HELD.rows;
	if (north === undefined || south === undefined)
		throw new Error("The held table lost its rows.");
	await expect(
		capturePublish({
			create: document,
			updates: [{ name: "update", document }],
			configuration: CLINIC,
			hqTables: [
				{
					...MANAGED_FACILITIES_HELD,
					rows: [
						north,
						{
							...south,
							fields: {
								...south.fields,
								name: [{ value: "East", properties: {} }],
							},
						},
					],
				},
			],
		}),
	).rejects.toThrow(
		/would refresh its copy of facilities or stop before anything else, since row 2's name is "East" in CommCare HQ and "South" in the copy/,
	);
	// And a project space that holds no such table is the stop Nova's
	// publish makes over a table gone from CommCare HQ.
	await expect(
		capturePublish({
			create: document,
			updates: [{ name: "update", document }],
			configuration: CLINIC,
		}),
	).rejects.toThrow(/would stop with hq_managed_data_changed/);
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
 * secure submissions, an app setting Nova never writes. (Auto Capture Location
 * is Nova's own now: a save of it is a change the next publish asks about, which
 * `targeted-hq-side-owned` holds.)
 */
const TARGETS_OWN = {
	uiTranslations: { en: { "home.start": "Begin a visit" } },
	addOns: { menu_mode: true },
	profileProperties: { "cc-autoup-freq": "freq-daily" },
	appAttributes: { secure_submissions: true },
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
	expect(sent.auto_gps_capture).toBe(false);
	expect(sent).not.toHaveProperty("secure_submissions");
	expect(update.assumedSource).toMatchObject({
		add_ons: TARGETS_OWN.addOns,
		auto_gps_capture: false,
	});
});

it("captures the stop Nova makes over a person's save of a value Nova owns, and a resend that holds Nova's value beside the target's", async () => {
	await seedBorn(clinicVisitsDocument());
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

	// The capture met the stop Nova makes: the same code and the same change
	// with the same parts. The translation the target owns is no part of it.
	// A discard's digest binds its publisher's own deployment, claim and
	// member, so the capture's differs from Nova's, and each confirms its own.
	const unbound = (changes: readonly DeploymentRemoteChange[]) =>
		changes.map(({ observedDigest: _, ...change }) => change);
	expect(
		confirmed.stops.map((stop) => ({
			...stop,
			remoteChanges: unbound(stop.remoteChanges),
		})),
	).toEqual([
		{
			code: "hq_changed",
			remoteChanges: unbound(refused.refusal.remoteChanges),
			conflicts: [],
			webAppsChange: null,
		},
	]);
	expect(refused.refusal.remoteChanges.map((change) => change.parts)).toEqual([
		["A setting this app writes"],
	]);
	expect(confirmed.discards).toEqual(
		(confirmed.stops[0]?.remoteChanges ?? []).map((change) => ({
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

it("captures the table a person kept in HQ as the stop Nova makes before sending anything, which taking it over does not resolve", async () => {
	const document = await seedSearchLookupMedia();
	const saves = {
		republish: "stops",
		stopCode: "hq_table_content_unsupported",
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
	const capture = await capturePublish({
		create: document,
		updates: [{ name: "update", document }],
		configuration: EVERYTHING,
		hqSide: saves,
	});

	const model = projectSpace({
		appId: PLACEHOLDER_APP_ID,
		flags: EVERYTHING.flags,
		caseSearchEnabled: EVERYTHING.caseSearchEnabled,
	});
	const log: PeerRequest[] = [];
	const { refused, adopting, kept, after, sentAfter } = await withHttpPeer(
		async (peer) => {
			servedBy(peer, model, log);
			expect((await publish()).hqAppAction).toBe("created");
			model.applyHqSide(saves);
			const kept = model.snapshot().tables;
			const before = log.length;
			const refused = await attempt();
			if (refused.landed)
				throw new Error("Nova pushed over the kept table without asking.");
			const adopting = await attempt({
				adoptResourceIds: [document.lookup?.definitions[0]?.id ?? ""],
			});
			return {
				refused,
				adopting,
				kept,
				after: model.snapshot().tables,
				sentAfter: log.slice(before),
			};
		},
	);

	// The capture stops where Nova stops, with the same code, and sends no B.
	if (capture.status !== "sent") throw new Error("The capture was refused.");
	expect(capture.updates.update).toMatchObject({
		status: "stopped",
		code: "hq_table_content_unsupported",
	});
	// Nova reads the property and the attribute from HQ's definition list and
	// stops before any write, with no discard and no adoption offered.
	expect(refused.refusal.failure).toEqual({
		code: "hq_table_content_unsupported",
		message:
			"Nova can't keep everything CommCare HQ holds in this app's lookup tables yet, so it stopped before sending anything: publishing over them would remove it. You can give a table a new export tag in Project data, and Nova then publishes its own table and leaves CommCare HQ's as it is.",
		details: [
			"The table Facilities holds field properties and row attributes in CommCare HQ.",
		],
	});
	expect(refused.refusal.remoteChanges).toEqual([]);
	expect(refused.refusal.resourceConflicts).toEqual([]);
	// Taking the table over keeps none of it, so the same stop answers.
	if (adopting.landed) throw new Error("Taking the table over pushed it.");
	expect(adopting.refusal.failure).toEqual(refused.refusal.failure);
	expect(sentAfter.every((request) => request.method === "GET")).toBe(true);
	// HQ's table is what the person left: the same id, rows and content.
	expect(after).toEqual(kept);
});

it("warns that HQ made a table again when its push over an unchanged definition leaves the tag under a new id", async () => {
	await seedSearchLookupMedia();
	const model = projectSpace({
		appId: PLACEHOLDER_APP_ID,
		flags: EVERYTHING.flags,
		caseSearchEnabled: EVERYTHING.caseSearchEnabled,
	});
	const log: PeerRequest[] = [];
	const { landed, before, after } = await withHttpPeer(async (peer) => {
		servedBy(peer, model, log);
		expect((await publish()).hqAppAction).toBe("created");
		// A description given in HQ's table editor, which no API-key read shows
		// and which is part of HQ's table key, so the push makes it again.
		const held = model.snapshot();
		model.restore({
			...held,
			tables: held.tables.map((table) => ({
				...table,
				description: "Kept in HQ",
			})),
		});
		const before = model.snapshot().tables.map((table) => table.id);
		const landed = await publish();
		return {
			landed,
			before,
			after: model.snapshot().tables.map((table) => table.id),
		};
	});
	expect(after).not.toEqual(before);
	expect(landed.warnings).toContain(
		"CommCare HQ made the table Facilities again during this publish. If it had a description or indexed fields there, they are gone: Nova can't read or keep either yet.",
	);
});

it("puts the note on a discard that replaces a table HQ still holds, and none on a deleted or renamed one", async () => {
	await seedSearchLookupMedia();
	const model = projectSpace({
		appId: PLACEHOLDER_APP_ID,
		flags: EVERYTHING.flags,
		caseSearchEnabled: EVERYTHING.caseSearchEnabled,
	});
	const log: PeerRequest[] = [];
	const note =
		"If it has a description or indexed fields in CommCare HQ, publishing removes them: CommCare HQ doesn't show those to Nova, and a lookup upload can't carry a description.";
	const notes = await withHttpPeer(async (peer) => {
		servedBy(peer, model, log);
		expect((await publish()).hqAppAction).toBe("created");
		const published = model.snapshot();
		const stopWith = async (
			tables: (held: (typeof published.tables)[number]) => unknown,
		) => {
			model.restore({
				...published,
				tables: published.tables.flatMap(
					(table) => tables(table) as (typeof published.tables)[number][],
				),
			});
			const outcome = await attempt();
			if (outcome.landed) throw new Error("Nova published over the change.");
			expect(outcome.refusal.failure.code).toBe("hq_changed");
			return outcome.refusal.remoteChanges
				.filter((change) => change.kind === "lookup-table")
				.map((change) => ({
					parts: change.parts.length,
					baselineKnown: change.baselineKnown,
					note: change.note,
					/* A change to the table HQ still holds under the tag ends with
					 * the action that takes it: the table is Nova's own. */
					offer: change.parts.at(-1) === USE_HQ_TABLE_OFFERED,
				}));
		};
		const definition = await stopWith((table) => [
			{
				...table,
				fields: [...table.fields, { name: "added_in_hq", properties: [] }],
			},
		]);
		const deleted = await stopWith(() => []);
		const renamed = await stopWith((table) => [
			{ ...table, tag: "facilities_renamed_in_hq" },
		]);
		// A live mapping with no baseline row: Nova can't tell what changed.
		model.restore(published);
		await h.db().deleteFrom("project_space_resource_baselines").execute();
		const unknown = await stopWith((table) => [table]);
		return { definition, deleted, renamed, unknown };
	});
	expect(notes.definition).toEqual([
		{ parts: 2, baselineKnown: true, note, offer: true },
	]);
	expect(notes.unknown).toEqual([
		{ parts: 1, baselineKnown: false, note, offer: true },
	]);
	expect(notes.deleted).toEqual([
		{ parts: 1, baselineKnown: true, note: null, offer: false },
	]);
	expect(notes.renamed).toEqual([
		{ parts: 1, baselineKnown: true, note: null, offer: false },
	]);
});

/** HQ's "Upgrade Required" answer to the push, as the lane retained it from HQ's own upload view. */
const PLAN_PAGE = JSON.parse(
	readFileSync(
		"proof/views/retained/lookup-upload-without-privilege.json",
		"utf8",
	),
) as { status: number; contentType: string; holds: string };

/** The peer, with its workbook upload answered by HQ's plan page and nothing written. */
function withoutLookupTables(model: TargetPeer): void {
	const answer = model.answer.bind(model);
	model.answer = async (request) =>
		request.method === "POST" &&
		new URL(request.path, HOST).pathname.endsWith("/fixtures/fixapi/")
			? {
					status: PLAN_PAGE.status,
					contentType: PLAN_PAGE.contentType,
					body: `<html><title>${PLAN_PAGE.holds}</title></html>`,
				}
			: answer(request);
}

it("stops on HQ's plan page after the empty app on a first publish, keeping the app's mapping and recording no table", async () => {
	await seedSearchLookupMedia();
	const model = projectSpace({
		appId: PLACEHOLDER_APP_ID,
		flags: EVERYTHING.flags,
		caseSearchEnabled: EVERYTHING.caseSearchEnabled,
	});
	withoutLookupTables(model);
	const log: PeerRequest[] = [];
	const outcome = await withHttpPeer(async (peer) => {
		servedBy(peer, model, log);
		return attempt();
	});
	if (outcome.landed) throw new Error("The publish landed without the plan.");
	expect(outcome.refusal.failure).toEqual({
		code: "hq_rejected_resource_push",
		message: `The plan for “${DOMAIN}” doesn't include Lookup Tables, so CommCare HQ took none of this app's lookup tables and Nova stopped before sending the app's content. Nova created the app there, and it is empty for now. Nothing else on the project space changed. Once the plan includes Lookup Tables, publishing again sends the tables and fills the app in.`,
		details: [],
	});
	const active = outcome.deployment?.active ?? [];
	expect(active.map((resource) => resource.kind)).toEqual(["app"]);
	const pushed = log.findIndex((request) =>
		new URL(request.path, HOST).pathname.endsWith("/fixtures/fixapi/"),
	);
	expect(pushed).toBeGreaterThan(-1);
	expect(log.slice(pushed + 1)).toEqual([]);
});

it("stops on HQ's plan page over an app that was there, with nothing changed and no request after the push", async () => {
	await seedSearchLookupMedia();
	const model = projectSpace({
		appId: PLACEHOLDER_APP_ID,
		flags: EVERYTHING.flags,
		caseSearchEnabled: EVERYTHING.caseSearchEnabled,
	});
	const log: PeerRequest[] = [];
	const { outcome, held, after, sent } = await withHttpPeer(async (peer) => {
		servedBy(peer, model, log);
		expect((await publish()).hqAppAction).toBe("created");
		await editInEachKey();
		withoutLookupTables(model);
		const held = model.snapshot();
		const start = log.length;
		const outcome = await attempt();
		return {
			outcome,
			held,
			after: model.snapshot(),
			sent: log.slice(start),
		};
	});
	if (outcome.landed) throw new Error("The publish landed without the plan.");
	expect(outcome.refusal.failure).toEqual({
		code: "hq_rejected_resource_push",
		message: `The plan for “${DOMAIN}” doesn't include Lookup Tables, so CommCare HQ took none of this app's lookup tables and Nova stopped before sending the app's content. Nothing on the project space changed. Once the plan includes Lookup Tables, publishing again sends the tables and then the app's content.`,
		details: [],
	});
	const pushed = sent.findIndex((request) =>
		new URL(request.path, HOST).pathname.endsWith("/fixtures/fixapi/"),
	);
	expect(pushed).toBeGreaterThan(-1);
	expect(sent.slice(pushed + 1)).toEqual([]);
	expect(after).toEqual(held);
});

/** The stored survey app declared to run only on `platform`. */
function declaring(
	document: PublishDocument,
	platform: "web-apps" | "android",
): PublishDocument {
	return {
		...document,
		doc: {
			...document.doc,
			appSettings: { ...document.doc.appSettings, runsOnlyOn: platform },
		},
	};
}

it("answers the Web Apps question of an edit that narrows the app to Android only with the declaration, and records the answer beside the body", async () => {
	await seed(clinicVisitsDocument());
	const document = await storedDocument();
	const { update, confirmed } = confirmedUpdate(
		await capturePublish({
			create: document,
			updates: [{ name: "update", document: declaring(document, "android") }],
			configuration: CLINIC,
		}),
	);
	/* The question a publish asks of every declaration change, answered
	 * with the value the declaration writes. */
	expect(confirmed.webApps).toBe(false);
	expect(confirmed.stops).toEqual([
		{
			code: "hq_web_apps_change",
			remoteChanges: [],
			conflicts: [],
			/* The capture's app is one Nova's own publish made, so the
			 * question counts from that publish. */
			webAppsChange: {
				from: true,
				to: false,
				changedInHq: false,
				since: { kind: "published" },
			},
		},
	]);
	expect(confirmed.discards).toEqual([]);
	expect(update.application.cloudcare_enabled).toBe(false);
	/* It was built over the read the content left, with Web Apps on. */
	expect(update.assumedSource.cloudcare_enabled).toBe(true);
});

it("makes the shell's source carry Web Apps as the configuration grants it", () => {
	/* HQ's create takes the plan's answer whatever the body says
	 * (`_create_app_from_doc`), so the body's own value never reaches it. */
	for (const granted of [true, false]) {
		for (const body of [{}, { cloudcare_enabled: !granted }]) {
			const source = shellSource(
				{ doc_type: "Application", name: "Clinic visits", ...body },
				CORPUS_COMMCARE_VERSION,
				granted,
			);
			expect(source.cloudcare_enabled).toBe(granted);
		}
	}
});

it("makes no CCZ of a Web-Apps-only document", async () => {
	await seed(clinicVisitsDocument());
	const document = await storedDocument();
	expect(await localCcz(declaring(document, "web-apps"), DOMAIN)).toBeNull();
	expect(await localCcz(document, DOMAIN)).not.toBeNull();
});

it("publishes over an app brought in from CommCare HQ as the capture does, under A's own ids, through the ledger a bring-in leaves", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "nova-proof-adopted-"));
	try {
		const root = join(scratch, "hq-apps");
		const hand = join(scratch, "hand");
		await writeControlledBase(root, hand);
		const {
			documents: [base],
		} = await hqAuthoredDocuments(root, hand);
		const facts = base?.hqAuthored;
		if (base === undefined || facts === undefined)
			throw new Error("The controlled base read to no document.");
		await seedBorn(
			hydratePersistedBlueprint(blueprintDocSchema.parse(base.doc)),
		);
		const loaded = await loadAppBlueprint(APP, ACTOR, "edit");
		const source = facts.source as Readonly<Record<string, unknown>>;
		const parsed = parseHqAppSource(source, { admit: "any" });
		if (parsed.kind !== "source")
			throw new Error(`HQ's retained source does not parse: ${parsed.key}.`);

		// The deployment a bring-in of the app leaves, written by production.
		const target = { server: "production" as const, domain: DOMAIN };
		await withAppTx(async (tx) => {
			await claimHqAppInTransaction(tx, {
				server: target.server,
				domain: target.domain,
				remoteAppId: REMOTE_APP,
			});
			await recordAdoptedDeploymentInTransaction(tx, {
				appId: APP,
				projectId: PROJECT,
				actorUserId: ACTOR,
				target,
				remoteAppId: REMOTE_APP,
				remoteRevision: 1,
				pushedRevision: loaded.app.mutation_seq,
				baseline: adoptedAppBaselineWrite({
					remoteAppId: REMOTE_APP,
					source: parsed.source,
					prepared: adoptionExportBoundary(loaded.doc, [], [], {
						origin: COMMCARE_SERVERS.production.baseUrl,
						domain: DOMAIN,
					}),
					target,
					identity: targetWireIdentity(facts.identity, facts.columnWords),
					novaRevision: loaded.app.mutation_seq,
					mediaFiles: {},
					observedAt: "2026-11-10T09:29:00.000Z",
					firstPublish: {
						ids: facts.firstPublish as readonly FirstPublishChangeId[],
						touchesWorkers: false,
						of: "first-publish",
					},
				}),
				targetIdentity: canonicalTargetIdentity({
					entities: facts.identity,
					mediaPaths: [],
					keyedCaseIds: facts.keyedCaseIds,
					columnWords: facts.columnWords,
				}),
				confirmations: [],
				at: new Date("2026-11-10T09:30:00.000Z"),
			});
		});

		const document = await storedDocument();
		const { flags, caseSearchEnabled } = novaPublishVerdict(
			loaded.doc,
			document,
		).minimumConfiguration;
		const capture = await capturePublish({
			create: document,
			updates: [{ name: "republish", document }],
			configuration: {
				id: "clinic",
				flags,
				caseSearchEnabled,
				domain: DOMAIN,
			},
			hqAuthoredA: {
				source,
				identity: facts.identity,
				mediaPaths: facts.mediaPaths,
				keyedCaseIds: facts.keyedCaseIds,
				columnWords: facts.columnWords,
			},
		});
		expect(capture.status).toBe("republished");
		const republish = capture.updates.republish;
		if (republish?.status !== "sent")
			throw new Error(
				`The capture did not send its republish: ${JSON.stringify(republish)}`,
			);

		const model = projectSpace({ flags, caseSearchEnabled });
		model.holdSource(source);
		const log: PeerRequest[] = [];
		await withHttpPeer(async (peer) => {
			servedBy(peer, model, log);
			expect((await publish()).hqAppAction).toBe("updated");
		});
		expect(ordered(lines(log))).toEqual(ordered(republish.sequence));
		const [sent, ...more] = await formsTo(log, "/apps/api/import_app/");
		expect(more).toEqual([]);
		const app = await expectSameImport(republish.importApp, sent);
		const held = source as unknown as HqApp;
		expect(app.modules.map((module) => module.unique_id)).toEqual(
			held.modules.map((module) => module.unique_id),
		);
		expect(
			app.modules.map((module) => module.forms.map((form) => form.xmlns)),
		).toEqual(
			held.modules.map((module) => module.forms.map((form) => form.xmlns)),
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});
