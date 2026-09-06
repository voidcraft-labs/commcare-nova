/** Publish persisted apps through the actual SDK, compiler, ledger and HTTP. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/client";
import AdmZip from "adm-zip";
import { sql } from "kysely";
import type { MockAgent } from "undici";
import { beforeEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import {
	readMultipartRequest,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { decrypt } from "@/lib/commcare/encryption";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { readDeployment } from "@/lib/deployment/store";
import type { BlueprintDoc } from "@/lib/domain";
import { createLookupTable, replaceLookupRows } from "@/lib/lookup/service";
import { downloadAssetBytes } from "@/lib/storage/media";
import { registerUploadAppToHq } from "../tools/uploadAppToHq";
import { withMcpClient } from "./client";
import { resultText } from "./promptClient";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@/lib/storage/media", () => ({ downloadAssetBytes: vi.fn() }));
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
	vi.mocked(downloadAssetBytes).mockReset();
});
const h = setupAppStateTestDb("mcp_publish_", { authSchema: "migrated" });
const APP = "publish-app",
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
const SOURCE = "/a/clinic/apps/source/working-app/";
function asUser<T>(
	run: (client: Client) => Promise<T>,
	userId = ACTOR,
	scopes = ["nova.read", "nova.hq.write"],
) {
	return withMcpClient(
		(server) =>
			registerUploadAppToHq(server, { userId, scopes, authKind: "oauth" }),
		run,
	);
}
function call(client: Client, extra: Record<string, unknown> = {}) {
	return client.callTool({
		name: "upload_app_to_hq",
		arguments: { app_id: APP, ...extra },
	});
}
function body(result: Awaited<ReturnType<typeof call>>, error = false) {
	if (error) expect(result.isError, JSON.stringify(result)).toBe(true);
	else expect(result.isError, JSON.stringify(result)).not.toBe(true);
	return JSON.parse(resultText({ ...result, isError: undefined }));
}
function document() {
	return buildDoc({
		appName: "Clinic visits",
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
	});
}
async function seed(doc: BlueprintDoc = document()) {
	await h.seedAppWithBlueprint(doc, {
		id: APP,
		owner: "creator",
		projectId: PROJECT,
	});
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await h.seedProjectMember("viewer", PROJECT, "viewer");
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
}
function request(peer: MockAgent, path: string, method = "GET") {
	return peer.get(HOST).intercept({
		path,
		method,
		headers: { authorization: "ApiKey account:fixture-key" },
	});
}
function source(peer: MockAgent, profile: object = {}) {
	request(peer, SOURCE).reply(200, { profile });
}
function imported(peer: MockAgent, appId = "working-app", version = 1) {
	request(peer, IMPORT, "POST").reply(201, {
		success: true,
		app_id: appId,
		version,
	});
}
function requests(peer: MockAgent) {
	return (
		peer
			.getCallHistory()
			?.calls()
			.map(({ method, fullUrl }) => `${method} ${fullUrl}`) ?? []
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

it("publishes a co-member's actual compiled app, then updates the same remote app while preserving its complete profile", async () => {
	await seed();
	const uploads: FormData[] = [];
	await withHttpPeer(async (peer) => {
		const accept = (version: number) =>
			request(peer, IMPORT, "POST").reply(async (opts) => {
				uploads.push(await readMultipartRequest(opts));
				return {
					statusCode: version === 1 ? 201 : 200,
					data: JSON.stringify({
						success: true,
						app_id: "working-app",
						version,
					}),
				};
			});
		accept(1);
		const profile = {
			features: { custom: true },
			properties: { restore: "daily" },
			custom_properties: { unrelated: { keep: [1, "two"] } },
		};
		source(peer, {
			...profile,
			custom_properties: {
				...profile.custom_properties,
				"cc-index-case-search-results": "yes",
			},
		});
		accept(2);
		await asUser(async (client) => {
			const created = body(await call(client));
			expect(created).toMatchObject({
				stage: "upload_complete",
				app_id: APP,
				hq_app_id: "working-app",
				hq_app_action: "created",
				deployment_state: "uploaded",
				url: `${HOST}/a/clinic/apps/view/working-app/`,
				warnings: [],
				project_space_compatibility: { status: "not_needed" },
			});
			const initial = await state();
			expect(initial?.active).toHaveLength(1);
			expect(initial?.active[0]).toMatchObject({
				kind: "app",
				novaResourceId: APP,
				remoteId: "working-app",
				ownership: "nova-created",
				pushedRevision: 0,
				remoteRevision: 1,
			});
			expect(
				body(await call(client, { app_name: "  Visiting program  " })),
			).toMatchObject({
				hq_app_action: "updated",
				hq_app_id: "working-app",
				deployment_state: "uploaded",
			});
			const updated = await state();
			expect(updated?.active).toHaveLength(1);
			expect(updated?.superseded).toEqual([]);
			expect(updated?.active[0]).toMatchObject({
				remoteId: "working-app",
				remoteRevision: 2,
			});
		});
		expect(requests(peer)).toEqual([
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${IMPORT}`,
		]);
		expect(uploads).toHaveLength(2);
		expect([...uploads[0].keys()]).toEqual([
			"waf_padding",
			"app_name",
			"app_file",
		]);
		expect(uploads[0].get("app_name")).toBe("Clinic visits");
		expect([...uploads[1].keys()]).toEqual([
			"waf_padding",
			"app_name",
			"app_id",
			"app_file",
		]);
		expect(uploads[1].get("app_name")).toBe("Visiting program");
		expect(uploads[1].get("app_id")).toBe("working-app");
		const applications = await Promise.all(
			uploads.map(async (data) => {
				const file = data.get("app_file");
				if (!(file instanceof Blob))
					throw new Error("Expected actual app JSON file");
				expect(file.type).toBe("application/json");
				return JSON.parse(await file.text());
			}),
		);
		expect(applications[0]).toMatchObject({
			doc_type: "Application",
			name: "Clinic visits",
			langs: ["en"],
			modules: [{ name: { en: "Visits" }, forms: [{ name: { en: "Visit" } }] }],
		});
		expect(Object.values(applications[0]._attachments)).toEqual([
			expect.stringContaining("<note/>"),
		]);
		expect(applications[1].profile).toEqual(profile);
		expect(vi.mocked(decrypt).mock.calls).toEqual([
			["ciphertext"],
			["ciphertext"],
		]);
	});
});

it("refuses an unreadable update source without replacing the last published app, then resumes with a fresh source read", async () => {
	await seed();
	await withHttpPeer(async (peer) => {
		imported(peer);
		request(peer, SOURCE).reply(200, { profile: null });
		source(peer);
		imported(peer, "working-app", 2);
		await asUser(async (client) => {
			body(await call(client));
			const initial = await state();
			expect(body(await call(client), true)).toMatchObject({
				error_type: "hq_app_state_unknown",
				app_id: APP,
			});
			const refused = await state();
			expect(refused?.deployment.state).toBe("uploaded");
			expect(refused?.active).toEqual(initial?.active);
			expect(body(await call(client))).toMatchObject({
				hq_app_action: "updated",
			});
		});
		expect(requests(peer)).toEqual([
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${IMPORT}`,
		]);
	});
});

it.each(["source", "import"])(
	"records an authoritative %s 404 and creates a replacement only on the next publish",
	async (missingAt) => {
		await seed();
		await withHttpPeer(async (peer) => {
			imported(peer);
			if (missingAt === "source")
				request(peer, SOURCE).reply(404, { error: "gone" });
			else {
				source(peer);
				request(peer, IMPORT, "POST").reply(404, { error: "gone" });
			}
			imported(peer, "replacement-app");
			await asUser(async (client) => {
				body(await call(client));
				expect(body(await call(client), true).error_type).toBe(
					"remote_app_missing",
				);
				expect((await state())?.deployment).toMatchObject({
					state: "incomplete",
					resumePhase: "upload",
				});
				expect(body(await call(client))).toMatchObject({
					hq_app_action: "created",
					hq_app_id: "replacement-app",
				});
				const final = await state();
				expect(final?.active.map((row) => row.remoteId)).toEqual([
					"replacement-app",
				]);
				expect(final?.superseded.map((row) => row.remoteId)).toEqual([
					"working-app",
				]);
			});
			expect(requests(peer)).toEqual([
				`POST ${HOST}${IMPORT}`,
				`GET ${HOST}${SOURCE}`,
				...(missingAt === "import" ? [`POST ${HOST}${IMPORT}`] : []),
				`POST ${HOST}${IMPORT}`,
			]);
		});
	},
);

it("retains a failed first import as resumable, then records the retry as one uploaded app", async () => {
	await seed();
	await withHttpPeer(async (peer) => {
		request(peer, IMPORT, "POST").reply(503, "unavailable");
		imported(peer);
		await asUser(async (client) => {
			expect(body(await call(client), true)).toMatchObject({
				error_type: "hq_upload_failed",
				app_id: APP,
			});
			expect((await state())?.deployment).toMatchObject({
				state: "incomplete",
				resumePhase: "upload",
			});
			expect((await state())?.active).toEqual([]);
			expect(body(await call(client))).toMatchObject({
				hq_app_action: "created",
				deployment_state: "uploaded",
			});
			expect((await state())?.active).toHaveLength(1);
		});
		expect(requests(peer)).toEqual([
			`POST ${HOST}${IMPORT}`,
			`POST ${HOST}${IMPORT}`,
		]);
	});
});

it("checks the actual SDK, scope, Project membership and target settings before creating deployment state or decrypting credentials", async () => {
	await seed();
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			expect(
				(
					await client.callTool({
						name: "upload_app_to_hq",
						arguments: { app_id: 4 },
					})
				).isError,
			).toBe(true);
			expect(
				body(await call(client, { domain: "outside" }), true).error_type,
			).toBe("domain_not_authorized");
			await h
				.db()
				.updateTable("user_settings")
				.set({
					approved_domains: JSON.stringify([
						{ name: "clinic", displayName: "Clinic" },
						{ name: "training", displayName: "Training" },
					]),
				})
				.where("user_id", "=", ACTOR)
				.execute();
			expect(body(await call(client), true)).toMatchObject({
				error_type: "domain_ambiguous",
				message: expect.stringContaining("training"),
			});
			await h
				.db()
				.deleteFrom("user_settings")
				.where("user_id", "=", ACTOR)
				.execute();
			expect(body(await call(client), true).error_type).toBe(
				"hq_not_configured",
			);
		});
		for (const actor of ["viewer", "outsider"])
			await asUser(async (client) => {
				const before = await call(client);
				expect(body(before, true).error_type).toBe("not_found");
				await sql`UPDATE apps SET deleted_at = now() WHERE id = ${APP}`.execute(
					h.db(),
				);
				expect(await call(client)).toEqual(before);
				await sql`UPDATE apps SET deleted_at = NULL WHERE id = ${APP}`.execute(
					h.db(),
				);
			}, actor);
		await asUser(
			async (client) => {
				expect(
					body(await call(client, { app_id: "missing" }), true),
				).toMatchObject({
					error_type: "scope_missing",
					required_scope: "nova.hq.write",
				});
			},
			ACTOR,
			["nova.read"],
		);
		expect(await snapshot()).toEqual({ deployments: [], resources: [] });
		expect(vi.mocked(decrypt)).not.toHaveBeenCalled();
		expect(requests(peer)).toEqual([]);
	});
});

async function seedLookup() {
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
		rows: [{ [code.id]: "001", [name.id]: "École & Clinic" }],
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
	await seed(doc);
	return table;
}
const TABLES = "/a/clinic/api/lookup_table/v1/?limit=100";
const WORKBOOK = "/a/clinic/fixtures/fixapi/";
const remoteTable = {
	id: "hq-table",
	tag: "facilities",
	is_global: true,
	fields: [{ field_name: "code" }, { field_name: "name" }],
};
function tables(peer: MockAgent, objects: object[] = []) {
	request(peer, TABLES).reply(200, { objects, meta: { next: null } });
}

it("requires explicit adoption of the named table, then ships its real workbook before the app and records the adopted dependency", async () => {
	const table = await seedLookup();
	const uploads: FormData[] = [];
	await withHttpPeer(async (peer) => {
		tables(peer, [remoteTable]);
		tables(peer, [remoteTable]);
		request(peer, WORKBOOK, "POST").reply(async (opts) => {
			uploads.push(await readMultipartRequest(opts));
			return {
				statusCode: 200,
				data: JSON.stringify({ code: 200, message: "Uploaded" }),
			};
		});
		tables(peer, [remoteTable]);
		request(peer, IMPORT, "POST").reply(async (opts) => {
			const saved = await state();
			expect(saved?.active).toEqual([
				expect.objectContaining({
					kind: "lookup-table",
					novaResourceId: table.id,
					remoteId: "hq-table",
					ownership: "adopted",
					adoptedBy: ACTOR,
				}),
			]);
			uploads.push(await readMultipartRequest(opts));
			return {
				statusCode: 201,
				data: JSON.stringify({ success: true, app_id: "working-app" }),
			};
		});
		await asUser(async (client) => {
			const refusal = body(await call(client), true);
			expect(refusal).toMatchObject({
				error_type: "hq_resource_conflict",
				resource_conflicts: [
					{
						kind: "lookup-table",
						nova_resource_id: table.id,
						name: "Facilities",
						hq_name: "facilities",
						hq_id: "hq-table",
					},
				],
			});
			expect(await snapshot()).toEqual({ deployments: [], resources: [] });
			const updates: { progress: number; message?: string }[] = [];
			const result = body(
				await client.callTool(
					{
						name: "upload_app_to_hq",
						arguments: { app_id: APP, adopt_resources: [table.id] },
					},
					{ onprogress: (update) => updates.push(update) },
				),
			);
			expect(result).toMatchObject({
				deployment_state: "uploaded",
				hq_app_id: "working-app",
				hq_app_action: "created",
			});
			expect(updates).toEqual([
				{
					progress: 1,
					message: `[upload_started] Uploading to clinic | app_id=${APP}`,
				},
				{
					progress: 2,
					message: `[resources_pushed] Put 1 lookup table on clinic | app_id=${APP} tables=1 places=0`,
				},
				{
					progress: 3,
					message: `[upload_complete] Uploaded. HQ app id working-app | app_id=${APP} hq_app_id=working-app`,
				},
			]);
		});
		expect(requests(peer)).toEqual([
			`GET ${HOST}${TABLES}`,
			`GET ${HOST}${TABLES}`,
			`POST ${HOST}${WORKBOOK}`,
			`GET ${HOST}${TABLES}`,
			`POST ${HOST}${IMPORT}`,
		]);
		expect(uploads).toHaveLength(2);
		expect([...uploads[0].keys()]).toEqual([
			"waf_padding",
			"file-to-upload",
			"replace",
		]);
		expect(uploads[0].get("replace")).toBe("true");
		const file = uploads[0].get("file-to-upload");
		if (!(file instanceof Blob)) throw new Error("Expected workbook bytes");
		const book = XLSX.read(await file.arrayBuffer(), { type: "array" });
		expect(book.SheetNames).toEqual(["types", "facilities"]);
		expect(
			XLSX.utils.sheet_to_json(book.Sheets.facilities, {
				header: 1,
				raw: false,
				defval: "",
			}),
		).toEqual([
			["UID", "Delete(Y/N)", "field: code", "field: name"],
			["", "N", "001", "École & Clinic"],
		]);
		const appFile = uploads[1].get("app_file");
		if (!(appFile instanceof Blob)) throw new Error("Expected app bytes");
		const app = JSON.parse(await appFile.text());
		expect(Object.values(app._attachments)).toEqual([
			expect.stringContaining('src="jr://fixture/item-list:facilities"'),
		]);
		const stored = await h
			.db()
			.selectFrom("app_deployments")
			.select(["content_generation", "entry_point_manifest"])
			.executeTakeFirstOrThrow();
		expect(stored.content_generation).toBe(
			stored.entry_point_manifest?.generation,
		);
		expect(stored.entry_point_manifest).toMatchObject({
			remoteAppId: "working-app",
			sourceSequence: 0,
			dependencies: [
				{
					kind: "lookup-table",
					novaResourceId: table.id,
					remoteId: "hq-table",
					pushedIdentity: "facilities",
				},
			],
		});
	});
});

it("records lookup data that survived a partial upload, refuses the app, and retries its own table without asking for adoption", async () => {
	const table = await seedLookup();
	await withHttpPeer(async (peer) => {
		tables(peer);
		request(peer, WORKBOOK, "POST").reply(200, {
			code: 402,
			message: "One row could not be read",
		});
		tables(peer, [remoteTable]);
		tables(peer, [remoteTable]);
		request(peer, WORKBOOK, "POST").reply(200, {
			code: 200,
			message: "Uploaded",
		});
		tables(peer, [remoteTable]);
		imported(peer);
		await asUser(async (client) => {
			const refused = body(await call(client), true);
			expect(refused).toMatchObject({
				error_type: "hq_upload_failed",
				message: expect.stringContaining("took only part"),
			});
			expect((await state())?.deployment).toMatchObject({
				state: "incomplete",
				resumePhase: "resources",
			});
			expect((await state())?.active).toEqual([
				expect.objectContaining({
					kind: "lookup-table",
					novaResourceId: table.id,
					remoteId: "hq-table",
					ownership: "nova-created",
				}),
			]);
			expect(requests(peer)).toEqual([
				`GET ${HOST}${TABLES}`,
				`POST ${HOST}${WORKBOOK}`,
				`GET ${HOST}${TABLES}`,
			]);
			expect(body(await call(client))).toMatchObject({
				hq_app_action: "created",
				deployment_state: "uploaded",
			});
			expect((await state())?.active).toHaveLength(2);
		});
		expect(requests(peer)).toEqual([
			`GET ${HOST}${TABLES}`,
			`POST ${HOST}${WORKBOOK}`,
			`GET ${HOST}${TABLES}`,
			`GET ${HOST}${TABLES}`,
			`POST ${HOST}${WORKBOOK}`,
			`GET ${HOST}${TABLES}`,
			`POST ${HOST}${IMPORT}`,
		]);
	});
});

it("keeps the MCP response pending until the actual upload conversation event is stored", async () => {
	await seed();
	await withHttpPeer(async (peer) => {
		imported(peer);
		await asUser(async (client) => {
			const response = await whileBlocked(
				h,
				(pg) => pg.query("LOCK TABLE events IN ACCESS EXCLUSIVE MODE"),
				() => call(client),
				async (settled, controller) => {
					expect(settled).toBe(false);
					expect(
						(
							await controller.query(
								"SELECT state, entry_point_manifest IS NOT NULL AS finalized FROM app_deployments",
							)
						).rows,
					).toEqual([{ state: "uploaded", finalized: true }]);
				},
			);
			expect(body(response)).toMatchObject({
				hq_app_id: "working-app",
				stage: "upload_complete",
			});
			expect(await h.db().selectFrom("events").selectAll().execute()).toEqual([
				expect.objectContaining({ app_id: APP }),
			]);
		});
	});
});

it.each(
	[
		{},
		null,
		[],
		{ objects: [{ id: null, tag: "facilities" }], meta: { next: null } },
	].map((inventory) => ({ inventory })),
)(
	"refuses malformed lookup inventory before sending a workbook: %j",
	async ({ inventory }) => {
		await seedLookup();
		await withHttpPeer(async (peer) => {
			request(peer, TABLES).reply(200, JSON.stringify(inventory));

			await asUser(async (client) => {
				expect(body(await call(client), true).error_type).toBe(
					"hq_upload_failed",
				);
			});
			expect(requests(peer)).toEqual([`GET ${HOST}${TABLES}`]);
			expect(await snapshot()).toEqual({ deployments: [], resources: [] });
		});
	},
);

it.each(["complete", "logo", "upload-disconnect", "status-disconnect"])(
	"keeps the imported app and reports actual media attachment outcome: %s",
	async (outcome) => {
		const image = testMediaAssetId("publish-image");
		const png = readFileSync("public/nova-icons/household.png");
		const hash = createHash("sha256").update(png).digest("hex");
		const key = `projects/${PROJECT}/${hash}.png`;
		const wire = `commcare/${hash}.png`;
		const doc = document();
		const field = Object.values(doc.fields)[0];
		if (field.kind !== "text") throw new Error("Expected text field");
		if (outcome === "logo") doc.logo = image;
		else field.label_media = { image };
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
				gcs_object_key: key,
				original_filename: "household.png",
				display_name: "Household",
				status: "ready",
			})
			.execute();
		vi.mocked(downloadAssetBytes).mockImplementation(async (requested) => {
			expect(requested).toBe(key);
			return png;
		});
		await withHttpPeer(async (peer) => {
			imported(peer);
			const media = "/a/clinic/apps/api/working-app/multimedia/";
			const status = `${media}status/media-job/`;
			if (outcome === "upload-disconnect")
				request(peer, media, "POST").replyWithError(new Error("socket closed"));
			else {
				request(peer, media, "POST").reply(async (opts) => {
					expect((await state())?.active[0].remoteId).toBe("working-app");
					const parts = await readMultipartRequest(opts);
					const file = parts.get("bulk_upload_file");
					if (!(file instanceof Blob))
						throw new Error("Expected multimedia ZIP");
					const zip = new AdmZip(Buffer.from(await file.arrayBuffer()));
					expect(zip.test()).toBe(true);
					expect(zip.getEntries().map((entry) => entry.entryName)).toEqual([
						wire,
					]);
					expect(zip.readFile(wire)).toEqual(png);
					return {
						statusCode: 200,
						data: JSON.stringify({ success: true, processing_id: "media-job" }),
					};
				});
				if (outcome === "status-disconnect")
					request(peer, status).replyWithError(new Error("socket closed"));
				else
					request(peer, status).reply(200, {
						success: true,
						complete: true,
						matched_count: outcome === "logo" ? 0 : 1,
						unmatched_count: outcome === "logo" ? 1 : 0,
						unmatched_files:
							outcome === "logo"
								? [{ path: wire, reason: "Did not match any Image paths." }]
								: [],
						errors: [],
					});
			}
			await asUser(async (client) => {
				const result = body(await call(client));
				expect(result).toMatchObject({
					stage: "upload_complete",
					hq_app_id: "working-app",
					deployment_state: "uploaded",
				});
				expect(result.warnings).toEqual(
					outcome === "complete"
						? []
						: outcome === "logo"
							? [expect.stringContaining("logo")]
							: [expect.stringContaining("app was published")],
				);
				expect((await state())?.active).toHaveLength(1);
			});
			expect(requests(peer)).toEqual([
				`POST ${HOST}${IMPORT}`,
				`POST ${HOST}${media}`,
				...(outcome === "upload-disconnect" ? [] : [`GET ${HOST}${status}`]),
			]);
		});
	},
);

it.each([200, 403])(
	"performs the real publish-time search check, with a missing advisory and runtime status %s",
	async (status) => {
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
			const visible = {
				meta: { total_count: 1 },
				objects: [{ domain_name: "clinic", project_name: "Clinic" }],
			};
			const paths = [
				"/api/user_domains/v1/?limit=100",
				"/api/user_domains/v1/?limit=100&feature_flag=search_claim",
				"/api/user_domains/v1/?limit=100&feature_flag=custom_properties",
				"/a/clinic/phone/search/?case_type=__nova_compatibility_probe__",
			];
			request(peer, paths[0]).reply(200, visible);
			request(peer, paths[1]).reply(200, visible);
			request(peer, paths[2]).reply(200, {
				meta: { total_count: 0 },
				objects: [],
			});
			request(peer, paths[3]).reply(status, "");
			const uploads: FormData[] = [];
			if (status === 200)
				request(peer, IMPORT, "POST").reply(async (opts) => {
					uploads.push(await readMultipartRequest(opts));
					return {
						statusCode: 201,
						data: JSON.stringify({ success: true, app_id: "working-app" }),
					};
				});
			await asUser(async (client) => {
				const result = body(await call(client), status !== 200);
				expect(result.project_space_compatibility).toMatchObject({
					status: status === 200 ? "ready" : "blocked",
					required_capabilities: [
						{
							id: "case-search",
							state: status === 200 ? "available" : "unverified",
						},
					],
					advisories: [{ id: "large-search-performance", state: "missing" }],
				});
				if (status !== 200) {
					expect(result.error_type).toBe("project_space_incompatible");
					expect(await snapshot()).toEqual({ deployments: [], resources: [] });
					expect(
						await h.db().selectFrom("events").selectAll().execute(),
					).toEqual([]);
				} else {
					expect(result).toMatchObject({
						stage: "upload_complete",
						deployment_state: "uploaded",
					});
					const file = uploads[0].get("app_file");
					if (!(file instanceof Blob)) throw new Error("Expected app JSON");
					const application = JSON.parse(await file.text());
					expect(application.profile).toBeUndefined();
					expect(application.modules[0].search_config).toMatchObject({
						properties: [],
						auto_launch: false,
						default_search: false,
						inline_search: false,
					});
				}
			});
			expect(requests(peer)).toEqual([
				...paths.map((path) => `GET ${HOST}${path}`),
				...(status === 200 ? [`POST ${HOST}${IMPORT}`] : []),
			]);
		});
	},
);

it("refuses a missing media reference before creating a deployment or recording an upload", async () => {
	const doc = document();
	doc.logo = testMediaAssetId("deleted-image");
	await seed(doc);
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			expect(body(await call(client), true)).toMatchObject({
				error_type: "invalid_input",
				app_id: APP,
				message: expect.stringContaining("media file is missing"),
			});
		});
		expect(await snapshot()).toEqual({ deployments: [], resources: [] });
		expect(await h.db().selectFrom("events").selectAll().execute()).toEqual([]);
		expect(requests(peer)).toEqual([]);
		expect(downloadAssetBytes).not.toHaveBeenCalled();
	});
});
