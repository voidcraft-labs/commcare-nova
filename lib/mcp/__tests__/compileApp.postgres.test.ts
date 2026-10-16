/** Persisted apps through the actual MCP SDK, export gate and wire compilers. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/client";
import AdmZip from "adm-zip";
import { getElementsByTagName, textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { beforeEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { nestedMenuWireFixture } from "@/lib/commcare/__tests__/nestedMenuWireFixture";
import type { HqApplication } from "@/lib/commcare/types";
import { derivedFormXmlns } from "@/lib/commcare/wireIdentity";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { commitGuardedBatch } from "@/lib/db/apps";
import { activeRemoteApp } from "@/lib/deployment/resources";
import {
	applyDeploymentObservation,
	type DeploymentScope,
	foldDeploymentAttempt,
	recordCreatedRemoteApp,
	recordRemoteResource,
} from "@/lib/deployment/store";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc } from "@/lib/domain";
import { ASSET_SIZE_CAPS_BYTES } from "@/lib/domain/multimedia";
import { proseText } from "@/lib/domain/prose";
import { createLookupTable, replaceLookupRows } from "@/lib/lookup/service";
import { downloadAssetBytes } from "@/lib/storage/media";
import { registerCompileApp } from "../tools/compileApp";
import { withMcpClient } from "./client";

// Only the external object store is replaced. Metadata, authorization, bytes
// selection, validation, lookup snapshots and all emitters execute normally.
vi.mock("@/lib/storage/media", () => ({ downloadAssetBytes: vi.fn() }));
beforeEach(() => {
	vi.mocked(downloadAssetBytes).mockReset();
});
const h = setupAppStateTestDb("mcp_compile_", { authSchema: "migrated" });
const APP = "export-app",
	PROJECT = "clinic",
	ACTOR = "co-member";
const FIELD = testUuid("name-field"),
	MODULE = testUuid("survey-module");
const IMAGE = testMediaAssetId("export-image");
const PNG = readFileSync("public/nova-icons/household.png");
const HASH = createHash("sha256").update(PNG).digest("hex");
const KEY = `projects/${PROJECT}/${HASH}.png`;
const WIRE = `commcare/${HASH}.png`;

function asUser<T>(run: (client: Client) => Promise<T>, userId = ACTOR) {
	return withMcpClient(
		(server) =>
			registerCompileApp(server, {
				userId,
				scopes: ["nova.read"],
				authKind: "oauth",
			}),
		run,
	);
}
function call(
	client: Client,
	format: "json" | "ccz",
	extra: Record<string, unknown> = {},
) {
	return client.callTool({
		name: "compile_app",
		arguments: { app_id: APP, format, ...extra },
	});
}
const OWNER: DeploymentScope = {
	appId: APP,
	projectId: PROJECT,
	actorUserId: "creator",
	role: "owner",
};
const AT = "2026-09-01T00:00:00.000Z";
const hqAppId = (server: string, domain: string) =>
	createHash("md5").update(`${server}/${domain}`).digest("hex");
/** A deployment whose content is on the project space: a CCZ can be made for it. */
async function publish(server: "india" | "production", domain: string) {
	const target = { server, domain };
	await foldDeploymentAttempt(
		OWNER,
		target,
		"preflight",
		{ status: "succeeded", at: AT },
		{ ensure: true },
	);
	return recordRemoteResource(OWNER, target, {
		kind: "app",
		novaResourceId: APP,
		remoteId: hqAppId(server, domain),
		ownership: "nova-created",
		pushedRevision: 0,
		remoteRevision: 1,
		uploadedAt: AT,
		targetWebAppsEnabled: true,
		baseline: {
			origin: "unread",
			remoteAppId: hqAppId(server, domain),
			sourceGzip: null,
			sourceBytes: null,
			sourceDigest: null,
			ownership: null,
			observedAt: AT,
			discard: null,
		},
	});
}
/** A first publish that stopped after making the empty app. */
async function shellOnly(server: "india" | "production", domain: string) {
	const target = { server, domain };
	await foldDeploymentAttempt(
		OWNER,
		target,
		"preflight",
		{ status: "succeeded", at: AT },
		{ ensure: true },
	);
	await recordCreatedRemoteApp(OWNER, target, {
		remoteId: hqAppId(server, domain),
		baseline: {
			origin: "unread",
			remoteAppId: hqAppId(server, domain),
			sourceGzip: null,
			sourceBytes: null,
			sourceDigest: null,
			ownership: null,
			observedAt: AT,
			discard: null,
		},
	});
}
/** A published app CommCare HQ has since reported gone. */
async function gone(server: "india" | "production", domain: string) {
	const published = await publish(server, domain);
	const mapping = activeRemoteApp(published);
	if (mapping === null) throw new Error("Expected an app mapping");
	await applyDeploymentObservation(
		OWNER,
		{ server, domain },
		{
			observedRemoteId: mapping.remoteId,
			observedPushToken: mapping.pushToken,
			outcomes: [
				[
					"upload",
					{
						status: "failed",
						at: AT,
						failure: {
							code: "remote_app_missing",
							message: "The app Nova published isn't there any more.",
							details: [],
						},
					},
				],
			],
			remoteRevision: null,
		},
	);
}
type Result = Awaited<ReturnType<typeof call>>;
function blocks(result: Result): Record<string, unknown>[] {
	expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
	return result.content.map((part) => {
		if (part.type !== "text") throw new Error("Expected MCP text artifact");
		return JSON.parse(part.text);
	});
}
/** The import file's ZIP and the guide block that leads it. */
function importFile(result: Result) {
	const parts = blocks(result);
	const guide = parts.at(-2);
	expect(guide).toMatchObject({
		kind: "nova_manual_import_guide",
		manual_import_guide: expect.any(Array),
	});
	const zip = archive(result, "zip");
	return { zip, guide: guide?.manual_import_guide as { kind: string }[] };
}
function importedApp(result: Result): HqApplication {
	const { zip } = importFile(result);
	const name = zip
		.getEntries()
		.map((entry) => entry.entryName)
		.find((entry) => entry.endsWith(".json"));
	if (!name) throw new Error("The import file holds no app JSON");
	return JSON.parse(zip.readAsText(name));
}
function archive(result: Result, format: "zip" | "ccz") {
	const body = blocks(result).at(-1);
	expect(body).toEqual({
		format,
		encoding: "base64",
		data: expect.any(String),
	});
	if (typeof body?.data !== "string") throw new Error("Missing archive bytes");
	const bytes = Buffer.from(body.data, "base64");
	expect(bytes.toString("base64")).toBe(body.data);
	const zip = new AdmZip(bytes);
	expect(zip.test()).toBe(true);
	return zip;
}
function requiredFile(zip: AdmZip, name: string) {
	const bytes = zip.readFile(name);
	if (!bytes) throw new Error(`Missing archive member: ${name}`);
	return bytes;
}
function errorBody(result: Result) {
	expect(result.isError).toBe(true);
	expect(result.content).toEqual([{ type: "text", text: expect.any(String) }]);
	const part = result.content[0];
	if (part.type !== "text") throw new Error("Expected error text");
	return JSON.parse(part.text);
}
function elements(xml: string, name: string) {
	return getElementsByTagName(
		name,
		parseDocument(xml, { xmlMode: true }).children,
		true,
	);
}
function document(
	field = f({
		uuid: FIELD,
		id: "patient_name",
		kind: "text",
		label: proseText("Patient name"),
	}),
) {
	return buildDoc({
		appName: "Clinic intake",
		modules: [
			{
				uuid: MODULE,
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [field],
					},
				],
			},
		],
	});
}
async function seed(doc: BlueprintDoc = document()) {
	await h.seedAppWithBlueprint(doc, {
		id: APP,
		projectId: PROJECT,
		owner: "creator",
	});
	await h.seedProjectMember(ACTOR, PROJECT, "viewer");
}
async function seedImage(projectId = PROJECT, status = "ready") {
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id: IMAGE,
			project_id: projectId,
			owner: "different-uploader",
			kind: "image",
			content_hash: HASH,
			mime_type: "image/png",
			extension: ".png",
			size_bytes: PNG.length,
			gcs_object_key: KEY,
			original_filename: "household.png",
			display_name: "Household",
			status,
		})
		.execute();
	vi.mocked(downloadAssetBytes).mockImplementation(async (key) => {
		if (key !== KEY) throw new Error(`Unexpected object key: ${key}`);
		return PNG;
	});
}
async function snapshot() {
	return {
		app: await h.readAppRow(APP),
		changes: await h.db().selectFrom("app_changes").selectAll().execute(),
		assets: await h.db().selectFrom("media_assets").selectAll().execute(),
		rows: await h
			.db()
			.selectFrom("lookup_rows")
			.selectAll()
			.orderBy("order_key")
			.execute(),
	};
}

it("exports a shared viewer's actual committed version as HQ JSON and an installable CCZ", async () => {
	await seed();
	await h.seedProjectMember("creator", PROJECT, "owner");
	await commitGuardedBatch({
		appId: APP,
		actorUserId: "creator",
		expectedProjectId: PROJECT,
		mutations: admitMutationBatch([
			{ kind: "setAppName", name: "Clinic follow-up" },
		]),
		batchId: "rename",
		kind: "mcp",
	});
	await publish("india", "clinic");
	const before = await snapshot();
	await asUser(async (client) => {
		const json = await call(client, "json");
		expect(json._meta).toMatchObject({
			"nova/compiledAtSeq": 1,
			"nova/projectSpaceCompatibility": { status: "not_needed" },
		});
		expect(blocks(json)).toHaveLength(2);
		const { zip: importZip, guide } = importFile(json);
		expect(
			importZip
				.getEntries()
				.map((entry) => entry.entryName)
				.sort(),
		).toEqual(["Clinic follow-up.json", "README.txt"]);
		expect(guide.map((step) => step.kind)).toEqual([
			"import-app",
			"commcare-version",
		]);
		const hq = importedApp(json);
		expect(hq.name).toBe("Clinic follow-up");
		expect(hq.modules).toHaveLength(1);
		expect(hq.modules[0].forms).toHaveLength(1);
		const source = hq._attachments[`${hq.modules[0].forms[0].unique_id}.xml`];
		expect(typeof source).toBe("string");
		const xform = source;
		expect(elements(xform, "input").map((node) => node.attribs.ref)).toEqual([
			"/data/patient_name",
		]);
		expect(
			elements(xform, "value").some(
				(node) => textContent(node) === "Patient name",
			),
		).toBe(true);
		expect(hq).not.toHaveProperty("multimedia_map");
		const ccz = await call(client, "ccz");
		expect(ccz._meta).toMatchObject({
			"nova/target": {
				server: "india",
				domain: "clinic",
				hq_app_id: hqAppId("india", "clinic"),
			},
		});
		const zip = archive(ccz, "ccz");
		expect(
			elements(zip.readAsText("modules-0/forms-0.xml"), "input").map(
				(node) => node.attribs.ref,
			),
		).toEqual(["/data/patient_name"]);
		expect(
			elements(zip.readAsText("modules-0/forms-0.xml"), "orx:meta"),
		).toHaveLength(1);
		expect(elements(xform, "orx:meta")).toHaveLength(0);
		expect(
			elements(zip.readAsText("profile.ccpr"), "property").map(
				(node) => node.attribs,
			),
		).toContainEqual({ key: "cc-content-version", value: "1" });
		const resources = elements(zip.readAsText("suite.xml"), "xform");
		expect(resources).toHaveLength(1);
		expect(textContent(resources[0])).toContain("./modules-0/forms-0.xml");
	});
	expect(downloadAssetBytes).not.toHaveBeenCalled();
	expect(await snapshot()).toEqual(before);
});

it.each([false, true])(
	"carries referenced lookup rows in both formats, with uploaded media: %s",
	async (withMedia) => {
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
		const filled = await replaceLookupRows(scope, {
			tableId: table.id,
			expectedTableRevision: table.tableRevision,
			rows: [
				{ [code.id]: "001", [name.id]: "École & Clinic" },
				{ [code.id]: "002", [name.id]: "Central <North>" },
			],
		});
		await createLookupTable(scope, {
			name: "Unreferenced",
			tag: "unreferenced",
			columns: [{ wireName: "secret", label: "Secret", dataType: "text" }],
		});
		const doc = document(
			f({
				uuid: FIELD,
				id: "facility",
				kind: "single_select",
				label: proseText("Facility"),
				optionsSource: {
					kind: "lookup",
					tableId: table.id,
					valueColumnId: code.id,
					labelColumnId: name.id,
				},
				...(withMedia ? { label_media: { image: IMAGE } } : {}),
			}),
		);
		if (withMedia) await seedImage();
		await seed(doc);
		await publish("india", "clinic");
		const before = await snapshot();
		await asUser(async (client) => {
			const result = await call(client, "json");
			const zip = archive(result, "zip");
			expect(
				zip
					.getEntries()
					.map((entry) => entry.entryName)
					.sort(),
			).toEqual([
				"Clinic intake.json",
				"README.txt",
				"lookup-tables.xlsx",
				...(withMedia ? ["multimedia.zip"] : []),
			]);
			const hq = JSON.parse(zip.readAsText("Clinic intake.json"));
			expect(hq).not.toHaveProperty("multimedia_map");
			if (withMedia) {
				const media = new AdmZip(requiredFile(zip, "multimedia.zip"));
				expect(media.getEntries().map((entry) => entry.entryName)).toEqual([
					WIRE,
				]);
				expect(media.readFile(WIRE)).toEqual(PNG);
			}
			const book = XLSX.read(requiredFile(zip, "lookup-tables.xlsx"), {
				type: "buffer",
			});
			expect(book.SheetNames).toEqual(["types", "facilities"]);
			expect(
				XLSX.utils.sheet_to_json(book.Sheets.types, { header: 1, defval: "" }),
			).toEqual([
				["Delete(Y/N)", "table_id", "is_global?", "field 1", "field 2"],
				["N", "facilities", "yes", "code", "name"],
			]);
			expect(
				XLSX.utils.sheet_to_json(book.Sheets.facilities, {
					header: 1,
					raw: false,
					defval: "",
				}),
			).toEqual([
				["UID", "Delete(Y/N)", "field: code", "field: name"],
				["", "N", "001", "École & Clinic"],
				["", "N", "002", "Central <North>"],
			]);
			const ccz = archive(await call(client, "ccz"), "ccz");
			expect(ccz.readFile(WIRE)).toEqual(withMedia ? PNG : null);
			const fixture = elements(ccz.readAsText("suite.xml"), "fixture").filter(
				(node) => node.attribs.id === "item-list:facilities",
			);
			expect(fixture).toHaveLength(1);
			expect(
				getElementsByTagName("facilities", fixture[0].children, true).map(
					(node) => [
						textContent(getElementsByTagName("code", node.children, true)[0]),
						textContent(getElementsByTagName("name", node.children, true)[0]),
					],
				),
			).toEqual([
				["001", "École & Clinic"],
				["002", "Central <North>"],
			]);
			const xform = ccz.readAsText("modules-0/forms-0.xml");
			expect(
				elements(xform, "instance")
					.map((node) => node.attribs.src)
					.filter(Boolean),
			).toContain("jr://fixture/item-list:facilities");
			expect(
				elements(xform, "value")
					.filter((node) => node.attribs.form === "image")
					.map(textContent),
			).toEqual(withMedia ? [`jr://file/${WIRE}`] : []);
		});
		expect(downloadAssetBytes).toHaveBeenCalledTimes(withMedia ? 2 : 0);
		if (withMedia) {
			expect(downloadAssetBytes).toHaveBeenNthCalledWith(
				1,
				KEY,
				ASSET_SIZE_CAPS_BYTES.image,
			);
			expect(downloadAssetBytes).toHaveBeenNthCalledWith(
				2,
				KEY,
				ASSET_SIZE_CAPS_BYTES.image,
			);
		}
		expect(await snapshot()).toEqual(before);
		await replaceLookupRows(scope, {
			tableId: table.id,
			expectedTableRevision: filled.tableRevision,
			rows: [
				{ [code.id]: "duplicate", [name.id]: "One" },
				{ [code.id]: "duplicate", [name.id]: "Two" },
			],
		});
		await asUser(async (client) => {
			for (const format of ["json", "ccz"] as const) {
				expect(errorBody(await call(client, format))).toMatchObject({
					error_type: "invalid_input",
					message: expect.stringContaining("duplicate"),
				});
			}
		});
		expect(downloadAssetBytes).toHaveBeenCalledTimes(withMedia ? 2 : 0);
	},
);

it("refuses missing, foreign and pending media before fetching any bytes in either format", async () => {
	const doc = document(
		f({
			uuid: FIELD,
			id: "patient_name",
			kind: "text",
			label_media: { image: IMAGE },
		}),
	);
	await seed(doc);
	await publish("india", "clinic");
	await asUser(async (client) => {
		for (const format of ["json", "ccz"] as const) {
			const missing = errorBody(await call(client, format));
			expect(missing).toMatchObject({
				error_type: "invalid_input",
				app_id: APP,
			});
			await seedImage("foreign");
			expect(errorBody(await call(client, format))).toEqual(missing);
			await h.db().deleteFrom("media_assets").execute();
		}
		await seedImage(PROJECT, "pending");
		for (const format of ["json", "ccz"] as const) {
			expect(errorBody(await call(client, format))).toMatchObject({
				error_type: "invalid_input",
				message: expect.stringContaining("hasn't finished uploading yet"),
			});
		}
	});
	expect(downloadAssetBytes).not.toHaveBeenCalled();
});

it("returns no artifact on object-store failure and succeeds on a later request", async () => {
	const doc = document(
		f({
			uuid: FIELD,
			id: "patient_name",
			kind: "text",
			label_media: { image: IMAGE },
		}),
	);
	await seedImage();
	await seed(doc);
	const before = await snapshot();
	await asUser(async (client) => {
		vi.mocked(downloadAssetBytes).mockRejectedValueOnce(
			new Error("private storage credential diagnostic"),
		);
		expect(errorBody(await call(client, "json"))).toEqual({
			error_type: "internal",
			message: "Something went wrong during generation.",
			app_id: APP,
		});
		expect(
			archive(await call(client, "json"), "zip").getEntry("multimedia.zip"),
		).not.toBeNull();
	});
	expect(await snapshot()).toEqual(before);
});

it("enforces actual Project access and SDK formats", async () => {
	await seed();
	await asUser(async (client) => {
		for (const extra of [
			{ format: "xml" },
			{ format: undefined },
			{ server: "https://example.invalid" },
			{ domain: "" },
			{ domain: 42 },
		]) {
			const result = await call(client, "json", extra);
			expect(result.isError).toBe(true);
			expect(result.content).toEqual([
				{
					type: "text",
					text: expect.stringContaining("Input validation error"),
				},
			]);
		}
	});
	await asUser(async (client) => {
		const foreign = errorBody(await call(client, "json"));
		expect(foreign).toMatchObject({ error_type: "not_found", app_id: APP });
		expect(errorBody(await call(client, "ccz"))).toEqual(foreign);
	}, "outsider");
	expect(downloadAssetBytes).not.toHaveBeenCalled();
});

const NEEDS_PUBLISHED =
	"A CCZ signs workers in to one project space and sends their forms there, so it is made for a project space this app is published to. Once the app is published, you can download the CCZ for that space.";

function searchingDoc() {
	return buildDoc({
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
	});
}

it.each([false, true])(
	"refuses a CCZ of an app published nowhere, searching: %s, and still makes its import file",
	async (searching) => {
		await seed(searching ? searchingDoc() : document());
		await asUser(async (client) => {
			for (const extra of [{}, { domain: "clinic" }, { server: "india" }]) {
				expect(errorBody(await call(client, "ccz", extra))).toEqual({
					error_type: "invalid_input",
					message: NEEDS_PUBLISHED,
					app_id: APP,
				});
			}
			expect(importedApp(await call(client, "json")).doc_type).toBe(
				"Application",
			);
		});
	},
);

it("makes a CCZ for one deployment with its addresses, its HQ app and its recorded ids, the same each time", async () => {
	const doc = searchingDoc();
	await seed(doc);
	await h.seedProjectMember("creator", PROJECT, "owner");
	const view = await publish("india", "clinic");
	const [formUuid] = doc.formOrder[doc.moduleOrder[0]];
	const recorded = "http://openrosa.org/formdesigner/hq-own-xmlns";
	await h
		.db()
		.insertInto("app_deployment_identities")
		.values({
			deployment_id: view.deployment.id,
			entity_kind: "form",
			nova_entity_uuid: formUuid,
			unique_id: null,
			xmlns: recorded,
		})
		.execute();
	await asUser(async (client) => {
		const zips = [
			archive(await call(client, "ccz"), "ccz"),
			archive(await call(client, "ccz", { domain: "clinic" }), "ccz"),
		];
		const [suite, again] = zips.map((zip) => zip.readAsText("suite.xml"));
		expect(again).toBe(suite);
		const [form, formAgain] = zips.map((zip) =>
			zip.readAsText("modules-0/forms-0.xml"),
		);
		expect(formAgain).toBe(form);
		const data = elements(form, "data")[0];
		expect(data.attribs.xmlns).toBe(recorded);
		expect(form).not.toContain(derivedFormXmlns(formUuid));
		const id = hqAppId("india", "clinic");
		const properties = Object.fromEntries(
			elements(zips[0].readAsText("profile.ccpr"), "property").map((node) => [
				node.attribs.key,
				node.attribs.value,
			]),
		);
		expect(properties).toMatchObject({
			"ota-restore-url": `https://india.commcarehq.org/a/clinic/phone/restore/${id}/`,
			PostURL: `https://india.commcarehq.org/a/clinic/receiver/${id}/`,
			key_server: "https://india.commcarehq.org/a/clinic/phone/keys/",
			cc_user_domain: "clinic.commcarehq.org",
		});
		expect(
			elements(suite, "query").map((query) => query.attribs.url),
		).toContain(`https://india.commcarehq.org/a/clinic/phone/search/${id}/`);
	});
});

it("asks for a pick among several published project spaces and refuses one the app isn't on", async () => {
	await seed();
	await h.seedProjectMember("creator", PROJECT, "owner");
	await publish("india", "clinic");
	await publish("production", "clinic");
	await shellOnly("india", "shell");
	await gone("production", "gone");
	await asUser(async (client) => {
		const listed = (message: string) => message.split("\n").slice(1).sort();
		const pick = errorBody(await call(client, "ccz"));
		expect(pick.error_type).toBe("invalid_input");
		expect(pick.message.split("\n")[0]).toBe(
			"A CCZ signs workers in to one project space and sends their forms there. This app is published to several, so you can pick the one this CCZ is for.",
		);
		expect(listed(pick.message)).toEqual([
			"- clinic on India",
			"- clinic on US",
		]);
		expect(
			errorBody(await call(client, "ccz", { domain: "clinic" })).message,
		).toContain("you can pick the one this CCZ is for");
		for (const [extra, named] of [
			[{ domain: "shell" }, '"shell"'],
			[{ domain: "gone", server: "production" }, '"gone" on US'],
			[{ domain: "never" }, '"never"'],
		] as const) {
			const refused = errorBody(await call(client, "ccz", extra));
			expect(refused.message.split("\n")[0]).toBe(
				`This app isn't published to ${named}, so there's no CCZ for it there. You can pick one of the project spaces it's published to.`,
			);
			expect(listed(refused.message)).toEqual([
				"- clinic on India",
				"- clinic on US",
			]);
		}
		const india = await call(client, "ccz", {
			domain: "clinic",
			server: "india",
		});
		expect(india._meta?.["nova/target"]).toEqual({
			server: "india",
			domain: "clinic",
			hq_app_id: hqAppId("india", "clinic"),
		});
		expect(
			await call(client, "ccz", { server: "production" }).then(
				(result) => result._meta?.["nova/target"],
			),
		).toEqual({
			server: "production",
			domain: "clinic",
			hq_app_id: hqAppId("production", "clinic"),
		});
	});
});

it.each(["parent-multiple", "same-smaller"] as const)(
	"holds a %s selection back from CommCare HQ and keeps it in a CCZ for a published app",
	async (scenario) => {
		await seed(nestedMenuWireFixture(scenario));
		await h.seedProjectMember("creator", PROJECT, "owner");
		await asUser(async (client) => {
			const held = errorBody(await call(client, "ccz"));
			expect(held.error_type).toBe("invalid_input");
			expect(held.message).toMatch(
				/^A CCZ signs workers in to one project space and sends their forms there, so it is made for a project space this app is published to\. This app can't be published to CommCare HQ as it is, so it has no CCZ yet\.\n- /,
			);
			expect(held.message).toContain('"Parents"');
			expect(held.message).toContain('"Child care"');
			const json = errorBody(await call(client, "json"));
			expect(json.message).toMatch(
				/^This app isn't ready to compile\. Fix these first: /,
			);
		});
		await publish("india", "clinic");
		await asUser(async (client) => {
			const result = await call(client, "ccz");
			expect(result._meta?.["nova/target"]).toMatchObject({
				server: "india",
				domain: "clinic",
			});
			const suite = archive(result, "ccz").readAsText("suite.xml");
			if (scenario === "parent-multiple")
				expect(suite).toContain("selected(join(");
			else
				expect(
					elements(suite, "instance-datum").map(
						(datum) => datum.attribs["max-select-value"],
					),
				).toEqual(expect.arrayContaining(["5", "4"]));
		});
	},
);

it("refuses a project space for the import file", async () => {
	await seed();
	await h.seedProjectMember("creator", PROJECT, "owner");
	await asUser(async (client) => {
		expect(errorBody(await call(client, "json", { domain: "clinic" }))).toEqual(
			{
				error_type: "invalid_input",
				message:
					"The CommCare HQ import file works in any project space, so it isn't made for one. You can download it again without a project space.",
				app_id: APP,
			},
		);
	});
});

it("keeps compatibility requirements before actual artifacts without contacting a destination", async () => {
	await seed(
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
	await publish("india", "clinic");
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			for (const format of ["json", "ccz"] as const) {
				const result = await call(client, format);
				const content = blocks(result);
				expect(content).toHaveLength(format === "json" ? 3 : 2);
				expect(content[0]).toEqual({
					kind: "nova_project_space_compatibility",
					project_space_compatibility:
						result._meta?.["nova/projectSpaceCompatibility"],
				});
				expect(content[0].project_space_compatibility).toMatchObject({
					status: "not_checked",
					blockers: [],
					required_capabilities: [{ id: "case-search", state: "not_checked" }],
					advisories: [
						{ id: "large-search-performance", state: "not_checked" },
					],
				});
				if (format === "ccz")
					expect(archive(result, "ccz").getEntry("suite.xml")).not.toBeNull();
				else
					expect(importedApp(result)).toMatchObject({
						doc_type: "Application",
						name: "Patient search",
					});
			}
		});
		expect(peer.getCallHistory()?.calls()).toEqual([]);
	});
});

it("resolves attachment writes from persisted deployments on the selected server and explains ambiguous or absent targets", async () => {
	await seed(
		buildDoc({
			appName: "Patient photos",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "photo_url", label: proseText("Photo") }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									id: "patient_name",
									kind: "text",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									id: "photo",
									kind: "image",
									caseWrite: {
										caseType: "patient",
										property: "photo_url",
										mode: "url",
									},
								}),
							],
						},
					],
				},
			],
		}),
	);
	await h.seedProjectMember("creator", PROJECT, "owner");
	const photoBinds = (xform: string) =>
		elements(xform, "bind")
			.filter((node) => node.attribs.nodeset === "/data/nova_url_photo")
			.map((node) => node.attribs.calculate);
	const linkTo = (server: "india" | "production", domain: string) =>
		`if(/data/photo = '', '', concat('https://${server === "production" ? "www" : "india"}.commcarehq.org/a/${domain}/api/form_attachment/v1/', /data/meta/instanceID, '/', /data/photo))`;
	await asUser(async (client) => {
		async function importFileLinks(
			server: "india" | "production" | undefined,
			linked: readonly ["india" | "production", string] | null,
			reason?: string,
		) {
			const result = await call(client, "json", { server });
			const parts = blocks(result);
			const hq = importedApp(result);
			const xform = hq._attachments[`${hq.modules[0].forms[0].unique_id}.xml`];
			const update = hq.modules[0].forms[0].actions.update_case;
			if (linked) {
				expect(update.update).toMatchObject({
					photo_url: {
						question_path: "/data/nova_url_photo",
						update_mode: "always",
					},
				});
				expect(photoBinds(xform)).toEqual([linkTo(...linked)]);
				expect(result._meta).not.toHaveProperty("nova/exportAdvisories");
			} else {
				expect(update.update).not.toHaveProperty("photo_url");
				expect(photoBinds(xform)).toEqual([]);
				/* A link no case list shows asks the project space for nothing,
				 * so the advisories are the file's only notes. */
				expect(parts[0]).toEqual({
					kind: "nova_export_advisories",
					export_advisories: result._meta?.["nova/exportAdvisories"],
				});
				expect(parts[0].export_advisories).toEqual([
					{
						id: "attachment_links_without_target",
						title: "Attachment links are empty in this file",
						message: expect.stringContaining(reason ?? ""),
					},
				]);
			}
		}
		async function cczLinks(server: "india" | "production", domain: string) {
			const result = await call(client, "ccz", { server, domain });
			expect(result._meta).not.toHaveProperty("nova/exportAdvisories");
			expect(
				photoBinds(archive(result, "ccz").readAsText("modules-0/forms-0.xml")),
			).toEqual([linkTo(server, domain)]);
		}
		await importFileLinks(
			"india",
			null,
			"has not reached a CommCare project space yet",
		);
		await publish("india", "clinic");
		await importFileLinks(undefined, ["india", "clinic"]);
		await cczLinks("india", "clinic");
		await importFileLinks(
			"production",
			null,
			"has not reached a CommCare project space yet",
		);
		await publish("production", "clinic");
		await importFileLinks("india", ["india", "clinic"]);
		await importFileLinks("production", ["production", "clinic"]);
		await importFileLinks(
			undefined,
			null,
			"More than one CommCare project space",
		);
		await cczLinks("production", "clinic");
		await publish("india", "training");
		await importFileLinks(
			"india",
			null,
			"More than one CommCare project space",
		);
		await importFileLinks("production", ["production", "clinic"]);
		await cczLinks("india", "training");
		await cczLinks("india", "clinic");
	});
});

it("emits no artifact when the real lookup snapshot query fails, including on an app with no lookup references", async () => {
	await seed();
	await publish("india", "clinic");
	const before = await snapshot();
	await h
		.pool()
		.query(
			"ALTER TABLE lookup_project_state RENAME TO unavailable_lookup_project_state",
		);
	try {
		await asUser(async (client) => {
			for (const format of ["json", "ccz"] as const) {
				expect(errorBody(await call(client, format))).toEqual({
					error_type: "internal",
					message: "Something went wrong during generation.",
					app_id: APP,
				});
			}
		});
	} finally {
		await h
			.pool()
			.query(
				"ALTER TABLE unavailable_lookup_project_state RENAME TO lookup_project_state",
			);
	}
	await asUser(async (client) =>
		expect(blocks(await call(client, "json"))).toHaveLength(2),
	);
	expect(await snapshot()).toEqual(before);
});
