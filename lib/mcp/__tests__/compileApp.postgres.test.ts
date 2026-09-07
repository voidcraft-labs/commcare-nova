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
import type { HqApplication } from "@/lib/commcare/types";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { commitGuardedBatch } from "@/lib/db/apps";
import {
	foldDeploymentAttempt,
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
		arguments: { app_id: APP, format, server: "india", ...extra },
	});
}
type Result = Awaited<ReturnType<typeof call>>;
function blocks(result: Result): Record<string, unknown>[] {
	expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
	return result.content.map((part) => {
		if (part.type !== "text") throw new Error("Expected MCP text artifact");
		return JSON.parse(part.text);
	});
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
	const before = await snapshot();
	await asUser(async (client) => {
		const json = await call(client, "json");
		expect(json._meta).toMatchObject({
			"nova/compiledAtSeq": 1,
			"nova/projectSpaceCompatibility": { status: "not_needed" },
		});
		const hq = blocks(json)[0] as unknown as HqApplication;
		expect(blocks(json)).toHaveLength(1);
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
		expect(hq.multimedia_map).toEqual({});
		const ccz = await call(client, "ccz");
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
			expect(Object.keys(hq.multimedia_map)).toEqual(
				withMedia ? [`jr://file/${WIRE}`] : [],
			);
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

it("requires an explicit server without a deployment and enforces actual Project access and SDK formats", async () => {
	await seed();
	await asUser(async (client) => {
		const unspecified = await client.callTool({
			name: "compile_app",
			arguments: { app_id: APP, format: "json" },
		});
		expect(errorBody(unspecified)).toMatchObject({
			error_type: "invalid_input",
			message: "Choose a CommCare server for this download, then try again.",
		});
		for (const extra of [
			{ format: "xml" },
			{ format: undefined },
			{ server: "https://example.invalid" },
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
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			for (const format of ["json", "ccz"] as const) {
				const result = await call(client, format);
				const content = blocks(result);
				expect(content).toHaveLength(2);
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
					expect(content[1]).toMatchObject({
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
	async function deploy(server: "india" | "production", domain: string) {
		const scope = {
			appId: APP,
			projectId: PROJECT,
			actorUserId: "creator",
			role: "owner",
		};
		const target = { server, domain };
		await foldDeploymentAttempt(
			scope,
			target,
			"preflight",
			{ status: "succeeded", at: "2026-09-01T00:00:00.000Z" },
			{ ensure: true },
		);
		await recordRemoteResource(scope, target, {
			kind: "app",
			novaResourceId: APP,
			remoteId: `${server}-${domain}-app`,
			ownership: "nova-created",
			pushedRevision: 0,
			remoteRevision: 1,
			uploadedAt: "2026-09-01T00:00:00.000Z",
		});
	}
	await asUser(async (client) => {
		async function check(
			server: "india" | "production" | undefined,
			domain: string | null,
			reason?: string,
		) {
			for (const format of ["json", "ccz"] as const) {
				const result = await call(client, format, { server });
				const parts = blocks(result);
				let xform: string;
				if (format === "ccz")
					xform = archive(result, "ccz").readAsText("modules-0/forms-0.xml");
				else {
					const hq = parts.at(-1) as unknown as HqApplication;
					xform = hq._attachments[`${hq.modules[0].forms[0].unique_id}.xml`];
					const update = hq.modules[0].forms[0].actions.update_case;
					if (domain)
						expect(update.update).toMatchObject({
							photo_url: {
								question_path: "/data/__nova_url_photo",
								update_mode: "always",
							},
						});
					else expect(update.update).not.toHaveProperty("photo_url");
				}
				const urlBinds = elements(xform, "bind").filter(
					(node) => node.attribs.nodeset === "/data/__nova_url_photo",
				);
				if (domain) {
					expect(urlBinds.map((node) => node.attribs.calculate)).toEqual([
						`if(/data/photo = '', '', concat('https://${server === "production" ? "www" : "india"}.commcarehq.org/a/${domain}/api/form_attachment/v1/', /data/meta/instanceID, '/', /data/photo))`,
					]);
					expect(result._meta).not.toHaveProperty("nova/exportAdvisories");
				} else {
					expect(urlBinds).toEqual([]);
					expect(parts[0]).toMatchObject({
						kind: "nova_project_space_compatibility",
					});
					expect(parts[1]).toEqual({
						kind: "nova_export_advisories",
						export_advisories: result._meta?.["nova/exportAdvisories"],
					});
					expect(parts[1].export_advisories).toEqual([
						{
							id: "attachment_links_without_target",
							title: "Attachment links are empty in this file",
							message: expect.stringContaining(reason ?? ""),
						},
					]);
				}
			}
		}
		await check("india", null, "has not reached a CommCare project space yet");
		await deploy("india", "clinic");
		await check(undefined, "clinic");
		await check(
			"production",
			null,
			"has not reached a CommCare project space yet",
		);
		await deploy("production", "clinic");
		await check("india", "clinic");
		await check("production", "clinic");
		await deploy("india", "training");
		await check("india", null, "More than one CommCare project space");
		await check("production", "clinic");
	});
});

it("emits no artifact when the real lookup snapshot query fails, including on an app with no lookup references", async () => {
	await seed();
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
		expect(blocks(await call(client, "json"))).toHaveLength(1),
	);
	expect(await snapshot()).toEqual(before);
});
