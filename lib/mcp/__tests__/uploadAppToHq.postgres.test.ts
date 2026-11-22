/** Publish persisted apps through the actual SDK, compiler, ledger and HTTP. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/client";
import AdmZip from "adm-zip";
import { sql } from "kysely";
import type { MockAgent } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { isSaveCounterPath } from "@/__tests__/helpers/hqSaveCounter";
import {
	readHttpRequestBody,
	readMultipartRequest,
} from "@/__tests__/helpers/httpPeer";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import {
	applicationAnswer,
	type RetainedHqAnswer,
	replyRetained,
	retainedBodyJson,
	retainedBodyText,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { nestedMenuWireFixture } from "@/lib/commcare/__tests__/nestedMenuWireFixture";
import { decrypt } from "@/lib/commcare/encryption";
import { commitGuardedBatchProposal } from "@/lib/db/__tests__/admittedWriterTestHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	heldPlacementApp,
	holdOperation,
} from "@/lib/db/__tests__/heldPlacementApp";
import { restoreApp, softDeleteApp } from "@/lib/db/apps";
import { openRemoteWrite } from "@/lib/db/openRemoteWrite";
import {
	acceptImport,
	hqSaves,
	makeManagedCopy,
	readerOf as managedReader,
	type ServedTable,
	serveRows,
	serveSource,
	serveTableList,
	withManagedPeer,
} from "@/lib/deployment/__tests__/managedFixtures";
import {
	clinicVisitsDocument as document,
	reloadHeadFor,
	TARGET_OWNED_PROFILE,
	TARGET_PROFILE_WITH_DERIVED_KEY,
} from "@/lib/deployment/__tests__/publishFixtures";
import {
	accessLostWhilePublishing,
	appDeletedWhilePublishing,
} from "@/lib/deployment/errors";
import { APP_PREVIEW_NOTE } from "@/lib/deployment/remoteChanges";
import { activeRemoteApp } from "@/lib/deployment/resources";
import { publishAppToHq, refreshDeployment } from "@/lib/deployment/service";
import {
	readDeployment,
	readDeploymentNovaRevisions,
	recordWorkerLevelConfirmations,
} from "@/lib/deployment/store";
import {
	asUuid,
	type BlueprintDoc,
	type OrganizationLevel,
	type Uuid,
} from "@/lib/domain";
import { log } from "@/lib/logger";
import { createLookupTable, replaceLookupRows } from "@/lib/lookup/service";
import {
	createLocation,
	describeArchiveImpact,
	setLocationArchived,
} from "@/lib/organization/service";
import {
	MANAGED_DATA_CHANGED,
	MANAGED_TABLE_HANDED_BACK_AFTER_CREATE,
	managedColumnGoneItem,
} from "@/lib/publish/managedData";
import {
	COMMTRACK_OFF,
	FORM_ENTRY_SYNC_OFF,
	formEntrySyncWhereMissing,
	LOGO_UPLOAD_STEP_TEXT,
	PLAN_FEATURE_IDS,
	PLAN_FEATURES,
	webAppsWhereMissing,
} from "@/lib/publish/planFeatures";
import {
	planLacksWebAppsMessage,
	webAppsChangeMessage,
} from "@/lib/publish/webApps";
import { downloadAssetBytes } from "@/lib/storage/media";
import { loadAppBlueprint } from "../loadApp";
import { registerUploadAppToHq } from "../tools/uploadAppToHq";
import { withMcpClient } from "./client";
import { resultText } from "./resultText";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@/lib/storage/media", () => ({ downloadAssetBytes: vi.fn() }));
/* Passed through, so a test can make the read after a landed app fault. */
vi.mock("@/lib/deployment/store", async (original) => {
	const store = await original<typeof import("@/lib/deployment/store")>();
	return {
		...store,
		readDeploymentNovaRevisions: vi.fn(store.readDeploymentNovaRevisions),
	};
});
beforeEach(() => {
	hqSaves.reset();
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
const sourcePath = (appId = "working-app") => `/a/clinic/apps/source/${appId}/`;
const SOURCE = sourcePath();
/* Every publish's preflight reads whether the project space holds
 * `USH_EMPTY_CASE_LIST_TEXT`, starting from the project spaces the key can
 * see. A peer that leaves the read unanswered gives no answer, which changes
 * no verdict. */
/**
 * The publish's read of the account's project spaces, which these tests leave
 * unanswered: a read no answer began for goes out twice (`hq/readJson.ts`).
 */
const PROJECT_SPACES_READ = `GET ${HOST}/api/user_domains/v1/?limit=100`;
const PROJECT_SPACES = [PROJECT_SPACES_READ, PROJECT_SPACES_READ];
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
/**
 * Every confirmation an upload can ask for. The cases are about what an
 * upload sends, so each says yes to all of them unless it is about the
 * asking; preflight keeps only what the app needs.
 */
const CONFIRM_ALL = {
	confirm_plan_features: [...PLAN_FEATURE_IDS],
	confirm_flat_location_fixture: true,
	confirm_connect_forwarder: true,
	confirm_form_entry_sync_off: true,
	confirm_commtrack_off: true,
};
function call(client: Client, extra: Record<string, unknown> = {}) {
	return client.callTool({
		name: "upload_app_to_hq",
		arguments: { app_id: APP, ...CONFIRM_ALL, ...extra },
	});
}
/** What a refusal that recorded nothing and offers no move says of placements. */
const NOTHING_RECORDED = {
	placement_moves: null,
	placements: { recorded: 0, moved: 0 },
};
function body(result: Awaited<ReturnType<typeof call>>, error = false) {
	if (error) expect(result.isError, JSON.stringify(result)).toBe(true);
	else expect(result.isError, JSON.stringify(result)).not.toBe(true);
	return JSON.parse(resultText({ ...result, isError: undefined }));
}

it.each(["parent-multiple", "same-smaller"] as const)(
	"refuses the admitted %s HQ selection loss through persisted SDK publishing before remote writes",
	async (scenario) => {
		await seed(nestedMenuWireFixture(scenario));
		await withManagedPeer(async (peer) => {
			await asUser(async (client) => {
				const refusal = body(await call(client), true);
				expect(refusal.error_type).toBe("invalid_input");
				expect(refusal.message).toContain(
					scenario === "parent-multiple"
						? 'from several cases selected in "Parents"'
						: 'the limit of 4 selected cases in "Child care"',
				);
				const target = await state();
				expect(target).toBeNull();
			});
			expect(requests(peer)).toEqual([]);
			expect(downloadAssetBytes).not.toHaveBeenCalled();
		});
	},
);
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
/** HQ's retained read of a live app, with the profile a case names in place of its own. */
function liveSource(profile?: object | null): RetainedHqAnswer {
	const live = retainedPublishRead("source-live");
	if (profile === undefined) return live;
	return { ...live, body: { ...retainedBodyJson(live), profile } };
}
function source(
	peer: MockAgent,
	profile?: object | null,
	appId = "working-app",
) {
	replyRetained(request(peer, sourcePath(appId)), liveSource(profile));
}
/** HQ's retained read of the empty app a first publish creates. */
function shellSource(peer: MockAgent, appId = "working-app") {
	replyRetained(
		request(peer, sourcePath(appId)),
		retainedPublishRead("source-shell"),
	);
}
/** A first publish's shell create, accepted, and HQ's read of that empty app. */
function shellCreated(peer: MockAgent, appId = "working-app") {
	request(peer, IMPORT, "POST").reply(() => {
		hqSaves.create(appId);
		return {
			statusCode: 201,
			data: JSON.stringify({ success: true, app_id: appId }),
		};
	});
	shellSource(peer, appId);
}
/**
 * An in-place update, accepted, and HQ's read of the app after it, which
 * the next publish compares its own read with.
 */
function imported(peer: MockAgent, appId = "working-app") {
	request(peer, IMPORT, "POST").reply(() => ({
		statusCode: 200,
		data: JSON.stringify({
			success: true,
			app_id: appId,
			version: hqSaves.save(appId),
		}),
	}));
	source(peer, undefined, appId);
}
/**
 * Every request the upload sent, in order, but the save counter's reads,
 * which `lib/deployment/__tests__/publishSequence.postgres.test.ts` holds.
 */
function requests(peer: MockAgent) {
	return (
		peer
			.getCallHistory()
			?.calls()
			.filter(({ path }) => !isSaveCounterPath(path))
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
	await withManagedPeer(async (peer) => {
		const accept = (version: number) =>
			request(peer, IMPORT, "POST").reply(async (opts) => {
				uploads.push(await readMultipartRequest(opts));
				if (version === 1) hqSaves.create("working-app");
				return {
					statusCode: version === 1 ? 201 : 200,
					data: JSON.stringify({
						success: true,
						app_id: "working-app",
						...(version > 1 && { version: hqSaves.save("working-app") }),
					}),
				};
			});
		accept(1);
		shellSource(peer);
		accept(2);
		const profile = TARGET_OWNED_PROFILE;
		/* HQ's read after the update and the next publish's own read hold
		 * the same app, so nothing changed in between. */
		source(peer, TARGET_PROFILE_WITH_DERIVED_KEY);
		source(peer, TARGET_PROFILE_WITH_DERIVED_KEY);
		accept(3);
		source(peer);
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
				app_preview_note: null,
			});
			const initial = await state();
			expect(initial?.active).toHaveLength(1);
			expect(initial?.active[0]).toMatchObject({
				kind: "app",
				novaResourceId: APP,
				remoteId: "working-app",
				ownership: "nova-created",
				pushedRevision: 0,
				remoteRevision: 2,
			});
			expect(
				body(await call(client, { app_name: "  Visiting program  " })),
			).toMatchObject({
				hq_app_action: "updated",
				hq_app_id: "working-app",
				deployment_state: "uploaded",
				app_preview_note: null,
			});
			const updated = await state();
			expect(updated?.active).toHaveLength(1);
			expect(updated?.superseded).toEqual([]);
			expect(updated?.active[0]).toMatchObject({
				remoteId: "working-app",
				remoteRevision: 3,
			});
		});
		expect(requests(peer)).toEqual([
			...PROJECT_SPACES,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
			...PROJECT_SPACES,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
		]);
		expect(uploads).toHaveLength(3);
		expect([...uploads[0].keys()]).toEqual([
			"waf_padding",
			"app_name",
			"app_file",
		]);
		expect(uploads[0].get("app_name")).toBe("Clinic visits");
		for (const [index, name] of [
			[1, "Clinic visits"],
			[2, "Visiting program"],
		] as const) {
			expect([...uploads[index].keys()]).toEqual([
				"waf_padding",
				"app_name",
				"app_id",
				"app_file",
			]);
			expect(uploads[index].get("app_name")).toBe(name);
			expect(uploads[index].get("app_id")).toBe("working-app");
		}
		const applications = await Promise.all(
			uploads.map(async (data) => {
				const file = data.get("app_file");
				if (!(file instanceof Blob))
					throw new Error("Expected actual app JSON file");
				expect(file.type).toBe("application/json");
				return JSON.parse(await file.text());
			}),
		);
		/* The empty app first, so HQ has no form id to re-mint; the update
		 * fills it with the ids Nova derives. */
		expect(applications[0]).toMatchObject({
			doc_type: "Application",
			name: "Clinic visits",
			langs: ["en"],
			modules: [],
			_attachments: {},
		});
		expect(applications[1]).toMatchObject({
			doc_type: "Application",
			name: "Clinic visits",
			langs: ["en"],
			modules: [{ name: { en: "Visits" }, forms: [{ name: { en: "Visit" } }] }],
		});
		expect(Object.values(applications[1]._attachments)).toEqual([
			expect.stringContaining("<note/>"),
		]);
		/* The target's own values stay, the derived key the advisory no
		 * longer justifies goes, and the settings every app states are
		 * written where the target holds none. */
		expect(applications[2].profile).toEqual({
			...profile,
			properties: {
				...profile.properties,
				"cc-fuzzy-search-enabled": "no",
				"cc-gps-auto-capture-accuracy": "10",
				"cc-content-valid": "no",
				"cc-autoup-freq": "freq-never",
				"cc-enable-tts": "no",
				"cc-autosync-freq": "freq-never",
				"cc-days-form-retain": "-1",
				"cc-inflation-target-density": "none",
				"cc-label-required-questions-with-asterisk": "no",
				"cc-login-duration-seconds": "86400",
				"cc-maps-default-layer": "normal",
				"cc-resize-images": "none",
				logenabled: "Enabled",
				"unsent-number-limit": "5",
				"unsent-time-limit": "5",
				"cc-show-saved": "no",
				"cc-show-incomplete": "no",
			},
		});
		expect(vi.mocked(decrypt).mock.calls).toEqual([
			["ciphertext"],
			["ciphertext"],
		]);
	});
});

it("refuses an unreadable update source without replacing the last published app, then resumes with a fresh source read", async () => {
	await seed();
	await withManagedPeer(async (peer) => {
		shellCreated(peer);
		imported(peer);
		replyRetained(request(peer, SOURCE), liveSource(null));
		source(peer);
		imported(peer, "working-app");
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
			...PROJECT_SPACES,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
			...PROJECT_SPACES,
			`GET ${HOST}${SOURCE}`,
			...PROJECT_SPACES,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
		]);
	});
});

it.each(["source-missing", "source-deleted", "update-missing"] as const)(
	"records HQ's %s answer as the app gone and creates a replacement only on the next publish",
	async (answer) => {
		await seed();
		await withManagedPeer(async (peer) => {
			shellCreated(peer);
			imported(peer);
			if (answer === "update-missing") {
				source(peer);
				replyRetained(
					request(peer, IMPORT, "POST"),
					retainedPublishRead(answer),
				);
			} else replyRetained(request(peer, SOURCE), retainedPublishRead(answer));
			shellCreated(peer, "replacement-app");
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
				expect((await state())?.active[0].remoteMissingAt).not.toBeNull();
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
				...PROJECT_SPACES,
				`POST ${HOST}${IMPORT}`,
				`GET ${HOST}${SOURCE}`,
				`POST ${HOST}${IMPORT}`,
				`GET ${HOST}${SOURCE}`,
				...PROJECT_SPACES,
				`GET ${HOST}${SOURCE}`,
				...(answer === "update-missing" ? [`POST ${HOST}${IMPORT}`] : []),
				...PROJECT_SPACES,
				`POST ${HOST}${IMPORT}`,
				`GET ${HOST}${sourcePath("replacement-app")}`,
				`POST ${HOST}${IMPORT}`,
				`GET ${HOST}${sourcePath("replacement-app")}`,
			]);
		});
	},
);

it("retains a refused shell create as resumable, then records the retry as one uploaded app", async () => {
	await seed();
	await withManagedPeer(async (peer) => {
		request(peer, IMPORT, "POST").reply(503, "unavailable");
		shellCreated(peer);
		imported(peer);
		await asUser(async (client) => {
			expect(body(await call(client), true)).toMatchObject({
				error_type: "hq_upload_failed",
				app_id: APP,
			});
			expect((await state())?.deployment).toMatchObject({
				state: "incomplete",
				resumePhase: "resources",
			});
			expect((await state())?.active).toEqual([]);
			expect(body(await call(client))).toMatchObject({
				hq_app_action: "created",
				deployment_state: "uploaded",
			});
			expect((await state())?.active).toHaveLength(1);
		});
		expect(requests(peer)).toEqual([
			...PROJECT_SPACES,
			`POST ${HOST}${IMPORT}`,
			...PROJECT_SPACES,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
		]);
	});
});

it("checks the actual SDK, scope, Project membership and target settings before creating deployment state or decrypting credentials", async () => {
	await seed();
	await withManagedPeer(async (peer) => {
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
	/* A lookup write is authorized against the writer's membership, in its own transaction. */
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
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
const TABLES = "/a/clinic/api/lookup_table/v1/?limit=1000";
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
const rowsPath = (tableId = "hq-table") =>
	`/a/clinic/api/fixture/v1/?fixture_type_id=${tableId}`;
/** The table's rows as HQ's filtered rows read lists them (`FixtureResource`, each row naming its table's tag). */
function rows(peer: MockAgent, tableId = "hq-table") {
	serveRows(peer, "clinic", {
		id: tableId,
		tag: remoteTable.tag,
		fields: ["code", "name"],
		rows: [{ code: "001", name: "École & Clinic" }],
	});
}

it("requires explicit adoption of the named table, then ships its real workbook before the app and records the adopted dependency", async () => {
	const table = await seedLookup();
	const uploads: FormData[] = [];
	await withManagedPeer(async (peer) => {
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
		rows(peer);
		shellCreated(peer);
		shellSource(peer);
		source(peer);
		request(peer, IMPORT, "POST").reply(async (opts) => {
			const saved = await state();
			expect(saved?.active.filter((row) => row.kind !== "app")).toEqual([
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
				statusCode: 200,
				data: JSON.stringify({
					success: true,
					app_id: "working-app",
					version: hqSaves.save("working-app"),
				}),
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
						arguments: {
							app_id: APP,
							...CONFIRM_ALL,
							adopt_resources: [table.id],
						},
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
			...PROJECT_SPACES,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${WORKBOOK}`,
			`GET ${HOST}${TABLES}`,
			`GET ${HOST}${rowsPath()}`,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
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
	await withManagedPeer(async (peer) => {
		tables(peer);
		shellCreated(peer);
		request(peer, WORKBOOK, "POST").reply(200, {
			code: 402,
			message: "One row could not be read",
		});
		tables(peer, [remoteTable]);
		rows(peer);
		tables(peer, [remoteTable]);
		rows(peer);
		shellSource(peer);
		request(peer, WORKBOOK, "POST").reply(200, {
			code: 200,
			message: "Uploaded",
		});
		tables(peer, [remoteTable]);
		rows(peer);
		shellSource(peer);
		imported(peer);
		await asUser(async (client) => {
			const refused = body(await call(client), true);
			expect(refused).toMatchObject({
				error_type: "hq_upload_failed",
				message: expect.stringContaining("took only part"),
			});
			expect(refused.message).toContain(
				"Nova created the app there, and it is empty for now.",
			);
			expect((await state())?.deployment).toMatchObject({
				state: "incomplete",
				resumePhase: "resources",
			});
			expect((await state())?.active).toEqual([
				expect.objectContaining({
					kind: "app",
					remoteId: "working-app",
					pushedRevision: null,
				}),
				expect.objectContaining({
					kind: "lookup-table",
					novaResourceId: table.id,
					remoteId: "hq-table",
					ownership: "nova-created",
				}),
			]);
			expect(requests(peer)).toEqual([
				`GET ${HOST}${TABLES}`,
				...PROJECT_SPACES,
				`POST ${HOST}${IMPORT}`,
				`GET ${HOST}${SOURCE}`,
				`POST ${HOST}${WORKBOOK}`,
				`GET ${HOST}${TABLES}`,
				`GET ${HOST}${rowsPath()}`,
			]);
			expect(body(await call(client))).toMatchObject({
				hq_app_action: "created",
				deployment_state: "uploaded",
			});
			expect((await state())?.active).toHaveLength(2);
		});
		expect(requests(peer)).toEqual([
			`GET ${HOST}${TABLES}`,
			...PROJECT_SPACES,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${WORKBOOK}`,
			`GET ${HOST}${TABLES}`,
			`GET ${HOST}${rowsPath()}`,
			`GET ${HOST}${TABLES}`,
			`GET ${HOST}${rowsPath()}`,
			...PROJECT_SPACES,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${WORKBOOK}`,
			`GET ${HOST}${TABLES}`,
			`GET ${HOST}${rowsPath()}`,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
		]);
	});
});

it("keeps the MCP response pending until the actual upload conversation event is stored", async () => {
	await seed();
	await withManagedPeer(async (peer) => {
		shellCreated(peer);
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
		await withManagedPeer(async (peer) => {
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

it.each([
	"complete",
	"upload-disconnect",
	"status-disconnect",
	"malformed-status",
])(
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
				gcs_object_key: key,
				original_filename: "household.png",
				display_name: "Household",
				status: "ready",
				media_format: "png",
			})
			.execute();
		vi.mocked(downloadAssetBytes).mockImplementation(async (requested) => {
			expect(requested).toBe(key);
			return png;
		});
		await withManagedPeer(async (peer) => {
			shellCreated(peer);
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
				/* A status read no answer began for is sent once more. */
				if (outcome === "status-disconnect")
					request(peer, status)
						.replyWithError(new Error("socket closed"))
						.times(2);
				else
					request(peer, status).reply(200, {
						success: true,
						processing_id: "media-job",
						complete: outcome === "malformed-status" ? "true" : true,
						matched_count: 1,
						unmatched_count: 0,
						unmatched_files: [],
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
						: [expect.stringContaining("app was published")],
				);
				expect((await state())?.active).toHaveLength(1);
			});
			expect(requests(peer)).toEqual([
				...PROJECT_SPACES,
				`POST ${HOST}${IMPORT}`,
				`GET ${HOST}${SOURCE}`,
				`POST ${HOST}${IMPORT}`,
				`GET ${HOST}${SOURCE}`,
				`POST ${HOST}${media}`,
				...(outcome === "upload-disconnect"
					? []
					: outcome === "status-disconnect"
						? [`GET ${HOST}${status}`, `GET ${HOST}${status}`]
						: [`GET ${HOST}${status}`]),
			]);
		});
	},
);

it("offers a logo only the logo uses for upload in CommCare HQ, and sends it in no media upload", async () => {
	const image = testMediaAssetId("publish-logo");
	const png = readFileSync("public/nova-icons/household.png");
	const hash = createHash("sha256").update(png).digest("hex");
	const doc = document();
	doc.logo = image;
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
	await withManagedPeer(async (peer) => {
		shellCreated(peer);
		imported(peer);
		await asUser(async (client) => {
			const result = body(await call(client));
			expect(result).toMatchObject({
				stage: "upload_complete",
				warnings: [],
				logo_step: {
					asset_id: image,
					file_name: "logo.png",
					changed: true,
					instructions: LOGO_UPLOAD_STEP_TEXT,
				},
			});
		});
		expect(requests(peer)).toEqual([
			...PROJECT_SPACES,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
		]);
	});
});

it("names what a person has to confirm structurally, and sends nothing until they do", async () => {
	await seedLookup();
	await withManagedPeer(async (peer) => {
		await asUser(async (client) => {
			const refused = body(
				await call(client, {
					confirm_plan_features: [],
					confirm_flat_location_fixture: false,
					confirm_connect_forwarder: false,
				}),
				true,
			);
			expect(refused).toEqual({
				error_type: "hq_confirmation_needed",
				message:
					"“clinic” needs a few things Nova can't check from here. Once you confirm that the project space has each one below, publishing can continue.",
				app_id: APP,
				confirmations_needed: [
					{
						kind: "plan-feature",
						subject: "web-apps",
						label: PLAN_FEATURES["web-apps"].label,
						plans: PLAN_FEATURES["web-apps"].plans,
						consequence: PLAN_FEATURES["web-apps"].consequence,
						reasons: ["This app runs in Web Apps."],
						/* Nothing in the app keeps it off Android. */
						where_missing: webAppsWhereMissing({ open: true, features: [] }),
					},
					{
						kind: "plan-feature",
						subject: "lookup-tables",
						label: PLAN_FEATURES["lookup-tables"].label,
						plans: PLAN_FEATURES["lookup-tables"].plans,
						consequence: PLAN_FEATURES["lookup-tables"].consequence,
						reasons: ["The app reads data from a lookup table."],
						where_missing: null,
					},
				],
				...NOTHING_RECORDED,
			});
		});
		expect(requests(peer)).toEqual([]);
	});
	expect(await snapshot()).toEqual({ deployments: [], resources: [] });
});

it("names sync on form entry structurally for an app with a menu with Search whose form works on a case, answered by confirm_form_entry_sync_off", async () => {
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
	await withManagedPeer(async (peer) => {
		await asUser(async (client) => {
			const refused = body(
				await call(client, {
					confirm_plan_features: [],
					confirm_form_entry_sync_off: false,
				}),
				true,
			);
			expect(refused.error_type).toBe("hq_confirmation_needed");
			expect(refused.confirmations_needed).toContainEqual({
				kind: "form-entry-sync-off",
				subject: "form-entry-sync-off",
				label: FORM_ENTRY_SYNC_OFF.label,
				plans: "",
				consequence: FORM_ENTRY_SYNC_OFF.consequence,
				reasons: [
					"Visit works on a case chosen in Patients, a menu with Search.",
				],
				/* Nothing in the app keeps it off Web Apps alone. */
				where_missing: formEntrySyncWhereMissing({ open: true, features: [] }),
			});
			/* Answered, it is no longer asked; the plan feature still is. */
			const answered = body(
				await call(client, {
					confirm_plan_features: [],
					confirm_form_entry_sync_off: true,
				}),
				true,
			);
			expect(
				answered.confirmations_needed.map(
					(need: { kind: string; subject: string }) => need.subject,
				),
			).toEqual(["web-apps"]);
		});
		expect(requests(peer)).toEqual([]);
	});
	expect(await snapshot()).toEqual({ deployments: [], resources: [] });
});

it("names CommCare Supply structurally for an advanced menu whose case list is its own menu item, and keeps confirm_commtrack_off once the upload goes ahead", async () => {
	await seed(
		buildDoc(
			{
				appName: "Supplies",
				caseTypes: [
					{
						name: "household",
						properties: [{ name: "case_name", label: "Name" }],
					},
				],
				modules: [
					{
						uuid: "supply-households",
						name: "Households",
						caseType: "household",
						caseListMenuItem: {},
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								name: "Household visit",
								type: "followup",
								fields: [{ id: "visit_note", kind: "text" }],
							},
						],
					},
				],
			},
			(doc) => {
				const households = testUuid("supply-households");
				doc.modules[households] = {
					...doc.modules[households],
					heldKind: "advanced",
				};
			},
		),
	);
	await withManagedPeer(async (peer) => {
		await asUser(async (client) => {
			const refused = body(
				await call(client, { confirm_commtrack_off: false }),
				true,
			);
			expect(refused.error_type).toBe("hq_confirmation_needed");
			expect(refused.confirmations_needed).toEqual([
				{
					kind: "commtrack-off",
					subject: "commtrack-off",
					label: COMMTRACK_OFF.label,
					plans: "",
					consequence: COMMTRACK_OFF.consequence,
					reasons: [
						"Households shows its case list as its own menu item, in a menu CommCare HQ builds as advanced.",
					],
					where_missing: COMMTRACK_OFF.whereMissing,
				},
			]);
		});
		expect(requests(peer)).toEqual([]);

		shellCreated(peer);
		imported(peer);
		await asUser(async (client) => {
			expect(body(await call(client))).toMatchObject({
				stage: "upload_complete",
			});
		});
	});
	const kept = await state();
	expect(
		kept?.confirmations.map(({ kind, subject }) => ({ kind, subject })),
	).toContainEqual({ kind: "commtrack-off", subject: "commtrack-off" });
});

/** HQ's retained read, with the app's Web App setting as a case names it. */
function webAppsSource(peer: MockAgent, enabled: boolean, shell = false) {
	const answer = retainedPublishRead(shell ? "source-shell" : "source-live");
	replyRetained(request(peer, SOURCE), {
		...answer,
		body: { ...retainedBodyJson(answer), cloudcare_enabled: enabled },
	});
}

it("answers hq_web_apps_change structurally and lands with confirm_web_apps", async () => {
	await seed();
	await withManagedPeer(async (peer) => {
		shellCreated(peer);
		imported(peer);
		await asUser(async (client) => {
			const first = body(await call(client));
			expect(Object.hasOwn(first, "web_apps_enabled")).toBe(false);

			/* Someone turned the setting off in CommCare HQ since. */
			webAppsSource(peer, false);
			const asked = body(await call(client), true);
			expect(asked).toEqual({
				error_type: "hq_web_apps_change",
				message: webAppsChangeMessage("clinic", {
					from: false,
					to: true,
					changedInHq: true,
					since: { kind: "published" },
				}),
				app_id: APP,
				web_apps_change: { from: false, to: true, changed_in_hq: true },
				...NOTHING_RECORDED,
			});

			webAppsSource(peer, false);
			imported(peer);
			const answered = body(await call(client, { confirm_web_apps: true }));
			expect(answered).toMatchObject({ stage: "upload_complete" });
			expect(Object.hasOwn(answered, "web_apps_enabled")).toBe(false);
		});
	});
});

/* The app lands before the answer reads the revision CommCare HQ's copy
 * matches. A fault reading it then must answer the publish that landed: an
 * agent told it failed would upload again. */
it("answers an upload whose app landed as landed when the revision read after it faults, leaving nova_revision out", async () => {
	await seed();
	await withManagedPeer(async (peer) => {
		shellCreated(peer);
		imported(peer);
		await asUser(async (client) => {
			vi.mocked(readDeploymentNovaRevisions).mockRejectedValueOnce(
				Object.assign(new Error("could not read “Clinic visits”"), {
					code: "57P01",
				}),
			);
			const landed = body(await call(client));
			expect(landed).toMatchObject({
				stage: "upload_complete",
				hq_app_action: "created",
				deployment: { domain: "clinic", state: "uploaded" },
			});
			expect(landed.deployment).not.toHaveProperty("nova_revision");
		});
	});
	expect(log.error).toHaveBeenCalledWith(
		"[deployment] matched revisions unavailable after a write landed",
		undefined,
		{
			appId: APP,
			domain: "clinic",
			after: "publish",
			errorName: "Error",
			errorCode: "57P01",
		},
	);
	expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain(
		"Clinic visits",
	);
	expect((await state())?.deployment.state).toBe("uploaded");
});

it("answers hq_plan_lacks_web_apps with its message and keeps the empty app", async () => {
	await seed();
	await withManagedPeer(async (peer) => {
		request(peer, IMPORT, "POST").reply(() => {
			hqSaves.create("working-app");
			return {
				statusCode: 201,
				data: JSON.stringify({ success: true, app_id: "working-app" }),
			};
		});
		webAppsSource(peer, false, true);
		await asUser(async (client) => {
			const refused = body(await call(client), true);
			expect(refused).toEqual({
				error_type: "hq_plan_lacks_web_apps",
				message: planLacksWebAppsMessage("clinic", {
					open: true,
					features: [],
				}),
				app_id: APP,
				...NOTHING_RECORDED,
			});
		});
		expect(requests(peer)).toEqual([
			...PROJECT_SPACES,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
		]);
	});
	const kept = await state();
	expect(kept?.active).toEqual([
		expect.objectContaining({ kind: "app", remoteId: "working-app" }),
	]);
	expect(kept?.confirmations.map((row) => row.subject)).not.toContain(
		"web-apps",
	);
});

it("refuses a target app below the CommCare version floor with its address", async () => {
	await seed();
	await withManagedPeer(async (peer) => {
		shellCreated(peer);
		imported(peer);
		await asUser(async (client) => {
			body(await call(client));
			const below = retainedBodyJson(retainedPublishRead("source-live"));
			below.build_spec = {
				...(below.build_spec as Record<string, unknown>),
				version: "2.53.0",
			};
			request(peer, SOURCE).reply(200, JSON.stringify(below));
			const refused = body(await call(client), true);
			expect(refused).toMatchObject({
				error_type: "hq_app_version_below_floor",
				app_id: APP,
				url: `${HOST}/a/clinic/apps/view/working-app/`,
			});
			expect(refused.message).toContain("CommCare 2.53.0");
		});
	});
});

it("refuses an app whose build profile names a language the app lacks, with each profile on a line and the app's address", async () => {
	await seed();
	await withManagedPeer(async (peer) => {
		shellCreated(peer);
		imported(peer);
		await asUser(async (client) => {
			body(await call(client));
			const before = requests(peer).length;
			const profiled = retainedBodyJson(retainedPublishRead("source-live"));
			profiled.build_profiles = {
				"profile-1": {
					name: "Field team",
					langs: ["en", "fra"],
					practice_mobile_worker_id: "",
					doc_type: "BuildProfile",
				},
			};
			request(peer, SOURCE).reply(200, JSON.stringify(profiled));
			const refused = body(await call(client), true);
			expect(refused).toMatchObject({
				error_type: "hq_build_profile_language_missing",
				app_id: APP,
				url: `${HOST}/a/clinic/apps/view/working-app/`,
			});
			expect(refused.message).toBe(
				"An application profile of the app on “clinic” includes a language this app no longer has, so Nova stopped before sending anything. Nova can't change application profiles in CommCare HQ. You can take that language out of the profile, or remove the profile, on the Application Profiles tab of the app's Releases page there, then publish again. That tab shows only where the project space's plan includes application profiles. Left as it is, CommCare HQ would build the profile with a language that has no text of its own, or couldn't build it at all.\n“Field team”: French (fra)",
			);
			expect(requests(peer).slice(before)).not.toContain(
				`POST ${HOST}${IMPORT}`,
			);
		});
	});
});

it.each([
	{
		name: "XML success",
		status: 200,
		contentType: "text/xml; charset=utf-8",
		responseBody: "<fixture/>",
		ready: true,
		permission: false,
	},
	{
		name: "HTML success page",
		status: 200,
		contentType: "text/html",
		responseBody: "<html>Sign in</html>",
		ready: false,
		permission: false,
	},
	{
		name: "HQ permission refusal",
		status: 403,
		contentType: "text/plain",
		responseBody: "Forbidden",
		ready: false,
		permission: true,
	},
	{
		name: "proxy refusal",
		status: 403,
		contentType: "text/html",
		responseBody: "<html><title>403 Forbidden</title>Proxy refusal</html>",
		ready: false,
		permission: false,
	},
])(
	"publishes only on qualified Search evidence: $name",
	async ({ status, contentType, responseBody, ready, permission }) => {
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
		await withManagedPeer(async (peer) => {
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
			request(peer, paths[3]).reply(status, responseBody, {
				headers: { "content-type": contentType },
			});
			const uploads: FormData[] = [];
			if (ready) {
				shellCreated(peer);
				request(peer, IMPORT, "POST").reply(async (opts) => {
					uploads.push(await readMultipartRequest(opts));
					return {
						statusCode: 200,
						data: JSON.stringify({
							success: true,
							app_id: "working-app",
							version: hqSaves.save("working-app"),
						}),
					};
				});
				source(peer);
			}
			await asUser(async (client) => {
				const result = body(await call(client), !ready);
				expect(JSON.stringify(result).includes("Mobile App Access")).toBe(
					permission,
				);
				expect(result.project_space_compatibility).toMatchObject({
					status: ready ? "ready" : "blocked",
					required_capabilities: [
						{
							id: "case-search",
							state: ready ? "available" : "unverified",
						},
					],
					advisories: [{ id: "large-search-performance", state: "missing" }],
				});
				if (!ready) {
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
					// The advisory is missing, so the profile carries the
					// settings every app states and no derived key.
					expect(application.profile.properties).not.toHaveProperty(
						"cc-index-case-search-results",
					);
					// A search with no workflow stored opens on Search first.
					expect(application.modules[0].search_config).toMatchObject({
						properties: [],
						auto_launch: true,
						default_search: false,
						inline_search: false,
					});
				}
			});
			expect(requests(peer)).toEqual([
				...paths.map((path) => `GET ${HOST}${path}`),
				/* Unanswered here, so sent twice (`hq/readJson.ts`). */
				`GET ${HOST}/api/user_domains/v1/?limit=100&feature_flag=empty_case_list_text`,
				`GET ${HOST}/api/user_domains/v1/?limit=100&feature_flag=empty_case_list_text`,
				...(ready
					? [
							`POST ${HOST}${IMPORT}`,
							`GET ${HOST}${SOURCE}`,
							`POST ${HOST}${IMPORT}`,
							`GET ${HOST}${SOURCE}`,
						]
					: []),
			]);
		});
	},
);

it("refuses a missing media reference before creating a deployment or recording an upload", async () => {
	const doc = document();
	doc.logo = testMediaAssetId("deleted-image");
	await seed(doc);
	await withManagedPeer(async (peer) => {
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

const REGION = asUuid("11111111-1111-4111-8111-111111111111");
const DISTRICT = asUuid("22222222-2222-4222-8222-222222222222");
const FACILITY = asUuid("33333333-3333-4333-8333-333333333333");
const PHONE = asUuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const CLEAR = asUuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const LEVELS = "/a/clinic/api/location_type/v1/?limit=1000";
const PLACES = "/a/clinic/api/location/v2/?limit=5000";
const PLACE_PUSH = "/a/clinic/api/location/v2/";
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
	{
		id: 2,
		name: "District",
		code: "district",
		parent: `${HOST}/a/clinic/api/v0.5/location_type/1/`,
		administrative: false,
		shares_cases: true,
		view_descendants: false,
	},
	{
		id: 3,
		name: "Facility",
		code: "facility",
		parent: `${HOST}/a/clinic/api/v0.5/location_type/2/`,
		administrative: false,
		shares_cases: true,
		view_descendants: false,
	},
];
function orgDocument(metadata = false) {
	const levels: OrganizationLevel[] = [
		{
			uuid: REGION,
			code: "region",
			name: "Region",
			caseFlow: {
				workers: "assigned",
				ownsCases: true,
				descendantCases: { kind: "none" },
			},
			addressBook: { reach: "own-branch" },
		},
		{
			uuid: DISTRICT,
			code: "district",
			name: "District",
			parentLevelUuid: REGION,
			caseFlow: {
				workers: "assigned",
				ownsCases: true,
				descendantCases: { kind: "none" },
			},
			addressBook: { reach: "own-branch" },
		},
		{
			uuid: FACILITY,
			code: "facility",
			name: "Facility",
			parentLevelUuid: DISTRICT,
			caseFlow: {
				workers: "assigned",
				ownsCases: true,
				descendantCases: { kind: "none" },
			},
			addressBook: { reach: "own-branch" },
		},
	];
	return {
		...document(),
		organizationLevels: Object.fromEntries(
			levels.map((level) => [level.uuid, level]),
		),
		organizationLevelOrder: levels.map((level) => level.uuid),
		...(metadata
			? {
					locationProperties: {
						[PHONE]: { uuid: PHONE, slug: "phone", label: "Phone" },
						[CLEAR]: { uuid: CLEAR, slug: "old_note", label: "Old note" },
					},
					locationPropertyOrder: [PHONE, CLEAR],
				}
			: {}),
	};
}
async function place(
	levelUuid: Uuid,
	name: string,
	siteCode: string,
	parentId: Uuid | null = null,
	values: Record<string, string> = {},
) {
	return (
		await createLocation(SCOPE, {
			levelUuid,
			name,
			siteCode,
			parentId,
			externalId: null,
			latitude: null,
			longitude: null,
			values,
		})
	).location;
}
function inventory(
	peer: MockAgent,
	objects: unknown[] = [],
	levels: unknown[] = remoteLevels,
) {
	request(peer, LEVELS).reply(200, { meta: { next: null }, objects: levels });
	request(peer, PLACES).reply(200, { meta: { next: null }, objects });
}
function remotePlace(
	site: string,
	level: string,
	parent = "",
	metadata: object = {},
	name = site,
) {
	return {
		location_id: `hq-${site}`,
		name,
		site_code: site,
		location_type_code: level,
		parent_location_id: parent,
		latitude: null,
		longitude: null,
		location_data: metadata,
	};
}
/** HQ's place inventory as a publish reads it back after its pushes. */
function placesReadBack(peer: MockAgent, objects: unknown[]) {
	request(peer, PLACES).reply(200, { meta: { next: null }, objects });
}
function acceptPlaces(peer: MockAgent, payloads: unknown[], ids: string[]) {
	request(peer, PLACE_PUSH, "PATCH").reply(async (opts) => {
		payloads.push(JSON.parse((await readHttpRequestBody(opts)).toString()));
		return { statusCode: 202, data: JSON.stringify(ids) };
	});
}

it("publishes a real three-level tree in bounded parent-first batches, then relinquishes archived mappings", async () => {
	await seed(orgDocument());
	const north = await place(REGION, "North", "north");
	const central = await place(DISTRICT, "Central", "central", north.id);
	const created = await createLocation(SCOPE, {
		levelUuid: REGION,
		name: "South",
		siteCode: "south",
		parentId: null,
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
		descendants: [
			{
				levelUuid: DISTRICT,
				name: "South district",
				siteCode: "south_district",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
				descendants: Array.from({ length: 101 }, (_, i) => ({
					levelUuid: FACILITY,
					name: `Clinic ${i}`,
					siteCode: `clinic_${i}`,
					externalId: null,
					latitude: null,
					longitude: null,
					values: {},
				})),
			},
		],
	});
	const payloads: {
		objects: {
			site_code: string;
			parent_location_id?: string;
			location_id?: string;
			location_data?: unknown;
		}[];
	}[] = [];
	await withManagedPeer(async (peer) => {
		inventory(peer);
		// The peer assigns ids from actual serialized site codes. Assertions
		// below independently prove grouping and parent ids, not call spies.
		for (let i = 0; i < 4; i++)
			request(peer, PLACE_PUSH, "PATCH").reply(async (opts) => {
				const payload = JSON.parse(
					(await readHttpRequestBody(opts)).toString(),
				);
				payloads.push(payload);
				return {
					statusCode: 202,
					data: JSON.stringify(
						payload.objects.map(
							(row: { site_code: string }) => `hq-${row.site_code}`,
						),
					),
				};
			});
		placesReadBack(peer, [
			remotePlace("north", "region"),
			remotePlace("south", "region"),
			remotePlace("central", "district", "hq-north"),
			remotePlace("south_district", "district", "hq-south"),
			...Array.from({ length: 101 }, (_, i) =>
				remotePlace(`clinic_${i}`, "facility", "hq-south_district"),
			),
		]);
		shellCreated(peer);
		shellSource(peer);
		source(peer);
		request(peer, IMPORT, "POST").reply(async () => {
			const saved = await state();
			expect(
				saved?.active.filter((row) => row.kind === "location"),
			).toHaveLength(105);
			expect(saved?.active.filter((row) => row.kind === "app")).toEqual([
				expect.objectContaining({ pushedRevision: null }),
			]);
			return {
				statusCode: 200,
				data: JSON.stringify({
					success: true,
					app_id: "working-app",
					version: hqSaves.save("working-app"),
				}),
			};
		});
		await asUser(async (client) => {
			expect(body(await call(client))).toMatchObject({
				deployment_state: "uploaded",
				warnings: [],
			});
			expect(payloads.map((payload) => payload.objects.length)).toEqual([
				2, 2, 100, 1,
			]);
			expect(payloads[0].objects.map((row) => row.site_code).sort()).toEqual([
				"north",
				"south",
			]);
			expect(
				payloads[0].objects.every(
					(row) =>
						row.parent_location_id === undefined &&
						row.location_data === undefined,
				),
			).toBe(true);
			expect(payloads[1].objects).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						site_code: "central",
						parent_location_id: "hq-north",
					}),
					expect.objectContaining({
						site_code: "south_district",
						parent_location_id: "hq-south",
					}),
				]),
			);
			const leaves = payloads.slice(2).flatMap((payload) => payload.objects);
			expect(new Set(leaves.map((row) => row.site_code)).size).toBe(101);
			expect(
				leaves.every((row) => row.parent_location_id === "hq-south_district"),
			).toBe(true);
			const initial = await state();
			expect(
				initial?.active.find((row) => row.novaResourceId === central.id),
			).toMatchObject({
				kind: "location",
				remoteId: "hq-central",
				pushedIdentity: "central",
				ownership: "nova-created",
			});
			const impact = await describeArchiveImpact(SCOPE, created.location.id);
			expect(
				(
					await setLocationArchived(
						SCOPE,
						created.location.id,
						true,
						impact.revision,
						impact,
					)
				).archivedCount,
			).toBe(103);
			const kept = [
				remotePlace("north", "region"),
				remotePlace("central", "district", "hq-north"),
			];
			inventory(peer, kept);
			acceptPlaces(peer, payloads, ["hq-north"]);
			acceptPlaces(peer, payloads, ["hq-central"]);
			placesReadBack(peer, kept);
			source(peer);
			source(peer);
			imported(peer, "working-app");
			expect(body(await call(client))).toMatchObject({
				deployment_state: "uploaded",
				warnings: [],
			});
			const final = await state();
			expect(final?.active.map((row) => row.remoteId).sort()).toEqual([
				"hq-central",
				"hq-north",
				"working-app",
			]);
			expect(final?.superseded).toHaveLength(103);
			expect(final?.superseded.every((row) => row.kind === "location")).toBe(
				true,
			);
		});
		expect(
			requests(peer).filter((value) => value.startsWith("PATCH")),
		).toHaveLength(6);
	});
});

it("requires exact adoption and preserves foreign JSON while applying and clearing Nova's modeled place values", async () => {
	await seed(orgDocument(true));
	const north = await place(REGION, "North", "north", null, { [PHONE]: "001" });
	const remote = remotePlace("north", "region", "", {
		phone: "old",
		old_note: "clear this",
		foreign_count: 3,
		foreign_policy: { flags: [true, null] },
	});
	const payloads: unknown[] = [];
	await withManagedPeer(async (peer) => {
		inventory(peer, [remote]);
		inventory(peer, [remote]);
		shellCreated(peer);
		acceptPlaces(peer, payloads, ["hq-north"]);
		placesReadBack(peer, [remote]);
		shellSource(peer);
		imported(peer);
		await asUser(async (client) => {
			expect(body(await call(client), true)).toMatchObject({
				error_type: "hq_resource_conflict",
				resource_conflicts: [
					{
						kind: "location",
						nova_resource_id: north.id,
						hq_name: "north",
						hq_id: "hq-north",
					},
				],
			});
			expect(await snapshot()).toEqual({ deployments: [], resources: [] });
			expect(
				body(await call(client, { adopt_resources: [north.id] }))
					.deployment_state,
			).toBe("uploaded");
			expect(
				(await state())?.active.find((row) => row.kind === "location"),
			).toMatchObject({
				novaResourceId: north.id,
				ownership: "adopted",
				adoptedBy: ACTOR,
				remoteId: "hq-north",
			});
		});
		expect(payloads).toEqual([
			{
				objects: [
					{
						location_id: "hq-north",
						name: "North",
						site_code: "north",
						location_type_code: "region",
						location_data: {
							phone: "001",
							old_note: "",
							foreign_count: 3,
							foreign_policy: { flags: [true, null] },
						},
					},
				],
			},
		]);
	});
});

it.each(["refused", "lost response"] as const)(
	"records only confirmed batches after a %s and safely resumes using real remote inventory",
	async (mode) => {
		await seed(orgDocument());
		const north = await place(REGION, "North", "north");
		const central = await place(DISTRICT, "Central", "central", north.id);
		const payloads: unknown[] = [];
		await withManagedPeer(async (peer) => {
			inventory(peer);
			shellCreated(peer);
			acceptPlaces(peer, payloads, ["hq-north"]);
			if (mode === "refused")
				request(peer, PLACE_PUSH, "PATCH").reply(400, {
					error: "A place already has this name. Location site code: central.",
				});
			else
				request(peer, PLACE_PUSH, "PATCH").replyWithError(
					new Error("acknowledgement lost"),
				);
			const remotes = [
				remotePlace("north", "region"),
				...(mode === "lost response"
					? [remotePlace("central", "district", "hq-north")]
					: []),
			];
			placesReadBack(peer, remotes);
			await asUser(async (client) => {
				const failure = body(await call(client), true);
				expect(failure.error_type).toBe("hq_upload_failed");
				if (mode === "lost response") {
					expect(failure.message).toContain("couldn’t confirm");
					expect(failure.message).not.toContain("Nothing in the group");
				} else expect(failure.message).toContain("Nothing in the group");
				expect(failure.message).toContain(
					"Nova created the app there, and it is empty for now.",
				);
				const partial = await state();
				expect(partial?.deployment).toMatchObject({
					state: "incomplete",
					resumePhase: "resources",
				});
				expect(partial?.active).toEqual([
					expect.objectContaining({ kind: "app", pushedRevision: null }),
					expect.objectContaining({
						novaResourceId: north.id,
						remoteId: "hq-north",
					}),
				]);
				if (mode === "lost response") {
					inventory(peer, remotes);
					expect(body(await call(client), true)).toMatchObject({
						error_type: "hq_resource_conflict",
						resource_conflicts: [
							{ nova_resource_id: central.id, hq_id: "hq-central" },
						],
					});
					expect((await state())?.active).toEqual(partial?.active);
				}
				inventory(peer, remotes);
				shellSource(peer);
				acceptPlaces(peer, payloads, ["hq-north"]);
				acceptPlaces(peer, payloads, ["hq-central"]);
				placesReadBack(peer, [
					remotePlace("north", "region"),
					remotePlace("central", "district", "hq-north"),
				]);
				shellSource(peer);
				imported(peer);
				expect(
					body(
						await call(
							client,
							mode === "lost response" ? { adopt_resources: [central.id] } : {},
						),
					).deployment_state,
				).toBe("uploaded");
				expect(
					(await state())?.active.find(
						(row) => row.novaResourceId === central.id,
					),
				).toMatchObject({
					remoteId: "hq-central",
					ownership: mode === "lost response" ? "adopted" : "nova-created",
				});
			});
			expect(
				requests(peer).filter((value) => value.startsWith("POST")),
			).toEqual([`POST ${HOST}${IMPORT}`, `POST ${HOST}${IMPORT}`]);
		});
	},
);

it.each([
	"unreadable",
	"missing level",
	"skipped level",
	"duplicate siblings",
] as const)(
	"refuses an organization with %s before any ledger or remote write",
	async (mode) => {
		await seed(orgDocument());
		const north = await place(REGION, "North", "north");
		if (mode === "skipped level")
			await place(FACILITY, "Clinic", "clinic", north.id);
		if (mode === "duplicate siblings")
			await place(REGION, "North", "another_north");
		await withManagedPeer(async (peer) => {
			if (mode === "unreadable") request(peer, LEVELS).reply(200, {});
			else inventory(peer, [], mode === "missing level" ? [] : remoteLevels);
			await asUser(async (client) => {
				expect(body(await call(client), true).error_type).toBe(
					mode === "unreadable"
						? "hq_upload_failed"
						: "hq_organization_mismatch",
				);
			});
			expect(await snapshot()).toEqual({ deployments: [], resources: [] });
			expect(requests(peer).every((value) => value.startsWith("GET"))).toBe(
				true,
			);
		});
	},
);

it.each([
	"format refusal",
	"partial then unreadable",
	"success then absent",
	"lost acknowledgement",
] as const)(
	"keeps lookup failure evidence and never sends the app's content after %s",
	async (mode) => {
		await seedLookup();
		await withManagedPeer(async (peer) => {
			tables(peer);
			shellCreated(peer);
			if (mode === "lost acknowledgement")
				request(peer, WORKBOOK, "POST").replyWithError(
					new Error("response lost"),
				);
			else
				request(peer, WORKBOOK, "POST").reply(200, {
					code:
						mode === "format refusal"
							? 405
							: mode === "partial then unreadable"
								? 402
								: 200,
					message: "Column code has an invalid row.",
				});
			if (mode === "partial then unreadable") request(peer, TABLES).reply(403);
			else if (mode !== "format refusal") tables(peer);
			await asUser(async (client) => {
				const result = body(await call(client), true);
				expect(result.error_type).toBe("hq_upload_failed");
				if (mode === "format refusal" || mode === "partial then unreadable")
					expect(result.message).toContain("Column code has an invalid row.");
				if (mode === "lost acknowledgement") {
					expect(result.message).toContain("couldn’t confirm");
					expect(result.message).not.toContain("took only part");
				}
				if (mode === "success then absent")
					expect(result.message).toContain("does not list them all");
				expect(result.message).toContain(
					"Nova created the app there, and it is empty for now.",
				);
				expect((await state())?.deployment).toMatchObject({
					state: "incomplete",
					resumePhase: "resources",
				});
				expect((await state())?.active).toEqual([
					expect.objectContaining({
						kind: "app",
						remoteId: "working-app",
						pushedRevision: null,
					}),
				]);
			});
			expect(
				requests(peer).filter((value) => value.startsWith("POST")),
			).toEqual([`POST ${HOST}${IMPORT}`, `POST ${HOST}${WORKBOOK}`]);
		});
	},
);

it("keeps an actually runnable deployment intact when a later publish has a missing key or a stale target server", async () => {
	await seed();
	await withManagedPeer(async (peer) => {
		shellCreated(peer);
		imported(peer);
		await asUser(async (client) => {
			body(await call(client));
		});
		const { doc, app } = await loadAppBlueprint(APP, ACTOR, "edit");
		/* A person builds and releases the app as Nova's publish left it. */
		const build = hqSaves.release("working-app");
		replyRetained(
			request(peer, "/a/clinic/api/application/v1/working-app/"),
			applicationAnswer("working-app", [
				{ id: "released-build", version: build, is_released: true },
			]),
		);
		request(peer, "/a/clinic/apps/download/released-build/profile.ccpr").reply(
			200,
			`<profile><suite><resource id="suite"><location authority="remote">${HOST}/a/clinic/apps/download/released-build/suite.xml</location></resource></suite></profile>`,
		);
		expect(
			(await refreshDeployment(SCOPE, TARGET, doc))?.deployment.deployment
				.state,
		).toBe("runnable");
		const before = await snapshot();
		await h
			.db()
			.updateTable("user_settings")
			.set({ commcare_server: "eu" })
			.where("user_id", "=", ACTOR)
			.execute();
		// A caller prepared India before the account changed to Europe.
		// The actual second credential read must refuse this stale input.
		const result = await publishAppToHq({
			requireHqImport: null,
			scope: SCOPE,
			...TARGET,
			doc,
			compiledAtSeq: app.mutation_seq,
			reloadHead: reloadHeadFor(APP, ACTOR),
			appName: app.app_name,
			adoptResourceIds: [],
		});
		expect(result.landed).toBe(false);
		expect(result.refusal).toMatchObject({
			phase: "preflight",
			failure: { code: "hq_not_connected" },
		});
		expect(await snapshot()).toEqual(before);
		await h
			.db()
			.deleteFrom("user_settings")
			.where("user_id", "=", ACTOR)
			.execute();
		await asUser(async (client) => {
			expect(body(await call(client), true).error_type).toBe(
				"hq_not_configured",
			);
		});
		expect(await snapshot()).toEqual(before);
		/* The first publish's unanswered project-space read goes out twice. */
		expect(requests(peer)).toHaveLength(8);
	});
});

it("asks before recreating a table deleted in CommCare HQ, then records it as Nova-created while preserving the previous adoption evidence", async () => {
	const table = await seedLookup();
	await withManagedPeer(async (peer) => {
		tables(peer, [remoteTable]);
		shellCreated(peer);
		request(peer, WORKBOOK, "POST").reply(200, {
			code: 200,
			message: "Uploaded",
		});
		tables(peer, [remoteTable]);
		rows(peer);
		shellSource(peer);
		imported(peer);
		await asUser(async (client) => {
			body(await call(client, { adopt_resources: [table.id] }));
			const adopted = (await state())?.active.find(
				(row) => row.kind === "lookup-table",
			);
			expect(adopted).toMatchObject({
				remoteId: "hq-table",
				ownership: "adopted",
				adoptedBy: ACTOR,
			});
			/* A complete inventory establishes absence, which is a change made
			 * in CommCare HQ: nothing is sent until the user says to publish
			 * over it, by the state the refusal showed. */
			tables(peer);
			source(peer);
			const before = await snapshot();
			const refusal = body(await call(client), true);
			expect(refusal).toEqual({
				error_type: "hq_changed",
				message:
					"Something this app publishes isn't the same in CommCare HQ as when Nova last published it, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version.",
				app_id: APP,
				remote_changes: [
					{
						kind: "lookup-table",
						nova_resource_id: table.id,
						name: "Facilities",
						hq_name: "facilities",
						parts: [
							"CommCare HQ no longer has this table. Publishing makes it again.",
						],
						note: null,
						observed_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
						baseline_known: true,
						/* Nova made this deployment, so a change is measured against its last publish. */
						since: { kind: "published" },
						/* A table's change is never brought in: it is published over or adopted. */
						can_bring_in: false,
					},
				],
				...NOTHING_RECORDED,
			});
			expect(await snapshot()).toEqual(before);
			const shown = refusal.remote_changes[0].observed_digest;
			// The upload creates a new object under the old tag; nobody
			// adopted that newly created object.
			tables(peer);
			source(peer);
			request(peer, WORKBOOK, "POST").reply(200, {
				code: 200,
				message: "Uploaded",
			});
			tables(peer, [{ ...remoteTable, id: "replacement-table" }]);
			rows(peer, "replacement-table");
			source(peer);
			imported(peer, "working-app");
			expect(
				body(
					await call(client, {
						discard_hq_changes: [
							{
								kind: "lookup-table",
								nova_resource_id: table.id,
								observed_digest: shown,
							},
						],
					}),
				),
			).toMatchObject({
				deployment_state: "uploaded",
				/* Only a write over the app can replace a form HQ checked. */
				app_preview_note: null,
			});
			expect(
				await h
					.db()
					.selectFrom("project_space_resource_baselines")
					.select(["remote_id", "origin", "discarded_digest", "discarded_by"])
					.where("remote_id", "=", "replacement-table")
					.execute(),
			).toEqual([
				{
					remote_id: "replacement-table",
					origin: "push",
					discarded_digest: shown,
					discarded_by: ACTOR,
				},
			]);
			const final = await state();
			expect(
				final?.active.find((row) => row.kind === "lookup-table"),
			).toMatchObject({
				novaResourceId: table.id,
				remoteId: "replacement-table",
				ownership: "nova-created",
				adoptedBy: null,
				adoptedAt: null,
			});
			expect(final?.superseded).toEqual([
				expect.objectContaining({
					...adopted,
					supersededAt: expect.any(String),
				}),
			]);
		});
	});
});

it.each([
	["plain", "x".repeat(110_000)],
	["quoted", '"'.repeat(22_500)],
])(
	"withholds the overwrite receipt when one %s physical HQ file exceeds the MCP response",
	async (_kind, fileName) => {
		await seed();
		await withManagedPeer(async (peer) => {
			shellCreated(peer);
			imported(peer);
			const live = liveSource();
			const path = "jr://file/commcare/image/" + fileName + ".png";
			replyRetained(request(peer, SOURCE), {
				...live,
				body: {
					...retainedBodyJson(live),
					multimedia_map: {
						[path]: {
							media_type: "CommCareImage",
							multimedia_id: "retained-file",
						},
					},
				},
			});
			await asUser(async (client) => {
				body(await call(client));
				const result = await call(client);
				const answer = body(result, true);
				expect(JSON.stringify(result).length).toBeLessThanOrEqual(80_000);
				expect(answer.error_type).toBe("hq_changed");
				expect(
					(answer.remote_changes ?? []).some(
						(c: { observed_digest?: string | null }) =>
							Boolean(c.observed_digest),
					),
				).toBe(false);
			});
		});
	},
	30000,
);

it("lists a change to the app in CommCare HQ, refuses a discard of a state it has since left, and lands one of the state shown with the App Preview line", async () => {
	await seed();
	const renamed = (name: string): RetainedHqAnswer => {
		const live = liveSource();
		return { ...live, body: { ...retainedBodyJson(live), name } };
	};
	await withManagedPeer(async (peer) => {
		shellCreated(peer);
		imported(peer);
		replyRetained(request(peer, SOURCE), renamed("Renamed in HQ"));
		replyRetained(request(peer, SOURCE), renamed("Renamed again in HQ"));
		replyRetained(request(peer, SOURCE), renamed("Renamed again in HQ"));
		imported(peer, "working-app");
		await asUser(async (client) => {
			body(await call(client));
			const before = await snapshot();
			const first = body(await call(client), true);
			expect(first).toMatchObject({
				error_type: "hq_changed",
				app_id: APP,
				remote_changes: [
					{
						kind: "app",
						nova_resource_id: APP,
						name: "Clinic visits",
						hq_name: "working-app",
						parts: ["The app's name"],
						note: null,
						baseline_known: true,
					},
				],
			});
			const stale = first.remote_changes[0].observed_digest;
			/* HQ moved again after the refusal: the discard names a state that
			 * is no longer there, so it is asked again with the new one. */
			const second = body(
				await call(client, {
					discard_hq_changes: [
						{ kind: "app", nova_resource_id: APP, observed_digest: stale },
					],
				}),
				true,
			);
			expect(second).toMatchObject({
				error_type: "hq_changed",
				remote_changes: [{ kind: "app", parts: ["The app's name"] }],
			});
			const shown = second.remote_changes[0].observed_digest;
			expect(shown).not.toBe(stale);
			expect(await snapshot()).toEqual(before);
			expect(
				body(
					await call(client, {
						discard_hq_changes: [
							{ kind: "app", nova_resource_id: APP, observed_digest: shown },
						],
					}),
				),
			).toMatchObject({
				hq_app_action: "updated",
				deployment_state: "uploaded",
				app_preview_note: APP_PREVIEW_NOTE,
			});
			expect(
				await h
					.db()
					.selectFrom("app_deployment_baselines")
					.select(["origin", "discarded_digest", "discarded_by"])
					.execute(),
			).toEqual([
				{ origin: "push", discarded_digest: shown, discarded_by: ACTOR },
			]);
		});
		expect(requests(peer)).toEqual([
			...PROJECT_SPACES,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
			...PROJECT_SPACES,
			`GET ${HOST}${SOURCE}`,
			...PROJECT_SPACES,
			`GET ${HOST}${SOURCE}`,
			...PROJECT_SPACES,
			`GET ${HOST}${SOURCE}`,
			`POST ${HOST}${IMPORT}`,
			`GET ${HOST}${SOURCE}`,
		]);
	});
});

/*
 * Where CommCare HQ keeps a case change is recorded by the first upload that
 * sends it. The plausible failures: an answer that leaves out what the call
 * recorded, so a client keeps work begun before the saved app changed; an
 * offer served with a wire path or a key the browser's dialog reads; an
 * accepted offer that does not reach the publish, or a stale one that moves
 * anything; and a head re-read that skips the caller's edit check, or one
 * that never happens, so a moved head refuses instead of publishing.
 */
describe("the placements an upload records", () => {
	/** Every plan feature but Save to Case, which a move offer can answer. */
	const BUT_SAVE_TO_CASE = PLAN_FEATURE_IDS.filter(
		(id) => id !== "advanced-case-actions",
	);
	const MOVE_OWN =
		"In Visit, the change that saves to this form's patient case moves from a Save to Case block to Case Management.";
	const MOVE_KID =
		"In Visit, the change that makes a new kid case moves from a Save to Case block to Case Management.";

	async function changeKinds(): Promise<string[]> {
		const rows = await h
			.db()
			.selectFrom("app_changes")
			.select("kind")
			.where("app_id", "=", APP)
			.orderBy("seq")
			.execute();
		return rows.map((row) => row.kind);
	}

	/** An editor's save, as an open tab's autosave commits it. */
	function rename(name: string) {
		return commitGuardedBatchProposal({
			appId: APP,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations: [{ kind: "setAppName", name }],
			actorUserId: ACTOR,
			kind: "autosave",
		});
	}

	/**
	 * The project-space read every preflight makes before the publish records
	 * anything, answered after someone saved the app, `times` times.
	 */
	function savedDuringPreflight(peer: MockAgent, times: number) {
		let saves = 0;
		request(peer, "/api/user_domains/v1/?limit=100")
			.reply(async () => {
				saves += 1;
				await rename(`Renamed ${saves}`);
				return { statusCode: 503, data: "" };
			})
			.times(times);
	}

	it("offers its Save to Case moves by form and sentence, refuses a stale digest with the offer as it stands, and records the accepted moves before sending", async () => {
		const app = heldPlacementApp((a) => {
			holdOperation(a, a.own.uuid, a.ownSaveToCase);
			holdOperation(a, a.kid.uuid, a.kidSaveToCase);
		});
		await seed(app.doc);
		await withManagedPeer(async (peer) => {
			await asUser(async (client) => {
				const asked = body(
					await call(client, { confirm_plan_features: BUT_SAVE_TO_CASE }),
					true,
				);
				expect(asked.error_type).toBe("hq_confirmation_needed");
				expect(asked.placements).toEqual({ recorded: 0, moved: 0 });
				expect(asked.placement_moves).toEqual({
					reason: "save-to-case",
					digest: expect.stringMatching(/^[0-9a-f]{64}$/),
					moves: [
						{
							form: "Visit",
							change: "saves to this form's patient case",
							sentence: MOVE_OWN,
						},
						{
							form: "Visit",
							change: "makes a new kid case",
							sentence: MOVE_KID,
						},
					],
				});

				const stale = body(
					await call(client, {
						confirm_plan_features: BUT_SAVE_TO_CASE,
						accept_placement_moves: {
							reason: "save-to-case",
							digest: "0".repeat(64),
						},
					}),
					true,
				);
				expect(stale).toEqual({
					error_type: "hq_placement_moves_changed",
					message:
						"The case changes Nova offered to move have changed since you agreed, so nothing was moved or sent. Here's what would move now.",
					app_id: APP,
					placement_moves: asked.placement_moves,
					placements: { recorded: 0, moved: 0 },
				});
				expect(requests(peer)).toEqual([]);
				expect(await changeKinds()).toEqual([]);

				shellCreated(peer);
				imported(peer);
				const landed = body(
					await call(client, {
						confirm_plan_features: BUT_SAVE_TO_CASE,
						accept_placement_moves: {
							reason: "save-to-case",
							digest: asked.placement_moves.digest,
						},
					}),
				);
				expect(landed).toMatchObject({
					stage: "upload_complete",
					placements: { recorded: 2, moved: 2 },
				});
				expect(Object.hasOwn(landed, "placement_moves")).toBe(false);
			});
			expect(requests(peer)).toEqual([
				...PROJECT_SPACES,
				`POST ${HOST}${IMPORT}`,
				`GET ${HOST}${SOURCE}`,
				`POST ${HOST}${IMPORT}`,
				`GET ${HOST}${SOURCE}`,
			]);
		});
		expect(await changeKinds()).toEqual(["publish-placement"]);
		const { doc } = await loadAppBlueprint(APP, ACTOR, "edit");
		expect(
			doc.forms[app.formUuid].caseOperations?.map((op) => op.placement),
		).toEqual([app.ownBasic, { kind: "basic", slot: "subcase", index: 0 }]);
	});

	it("reads the head again where it moved, and records and sends the placements of the head it read", async () => {
		await seed(heldPlacementApp().doc);
		await withManagedPeer(async (peer) => {
			savedDuringPreflight(peer, 1);
			shellCreated(peer);
			imported(peer);
			await asUser(async (client) => {
				expect(body(await call(client))).toMatchObject({
					stage: "upload_complete",
					placements: { recorded: 2, moved: 0 },
				});
			});
		});
		expect(await changeKinds()).toEqual(["autosave", "publish-placement"]);
		expect(activeRemoteApp((await state()) ?? fail())).toMatchObject({
			pushedRevision: 2,
		});
	});

	it("answers app_changed_while_publishing where the app keeps changing, with nothing sent or recorded", async () => {
		await seed(heldPlacementApp().doc);
		await withManagedPeer(async (peer) => {
			savedDuringPreflight(peer, 3);
			await asUser(async (client) => {
				expect(body(await call(client), true)).toEqual({
					error_type: "app_changed_while_publishing",
					message:
						"This app kept changing while Nova got it ready to publish, so nothing was sent. Publish again once the edits settle.",
					app_id: APP,
					...NOTHING_RECORDED,
				});
			});
			/* Each read is answered here, so each goes out once. */
			expect(requests(peer)).toEqual([
				PROJECT_SPACES_READ,
				PROJECT_SPACES_READ,
				PROJECT_SPACES_READ,
			]);
		});
		expect(await changeKinds()).toEqual(["autosave", "autosave", "autosave"]);
		expect(await state()).toBeNull();
	});
});

function fail(): never {
	throw new Error("Expected a value");
}

describe("a lookup table CommCare HQ manages in the project space", () => {
	const facilities: ServedTable = {
		id: "hq-facilities",
		tag: "facilities",
		fields: ["code", "name"],
		rows: [{ code: "001", name: "North" }],
	};
	const lookup = { projectId: PROJECT, actorId: ACTOR, role: "editor" };

	it("answers hq_managed_data_changed with each change's sentence, not as CommCare HQ refusing the upload", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		const copy = await makeManagedCopy(h, lookup, facilities, TARGET);
		await seed(managedReader([copy]));
		const gone = {
			...facilities,
			fields: ["code"],
			rows: [{ code: "001" }],
		};
		await withManagedPeer(async (peer) => {
			await asUser(async (client) => {
				expect(body(await call(client), true)).toMatchObject({
					error_type: "scope_missing",
					required_scope: "nova.hq.import",
				});
			});
			expect(requests(peer)).toEqual([]);

			serveTableList(peer, "clinic", [gone]);
			serveRows(peer, "clinic", gone);
			await asUser(
				async (client) => {
					const refused = body(await call(client), true);
					expect(refused.error_type).toBe("hq_managed_data_changed");
					expect(refused.message).toBe(
						`${MANAGED_DATA_CHANGED} ${managedColumnGoneItem("name", "facilities", 1)}`,
					);
				},
				ACTOR,
				["nova.read", "nova.write", "nova.hq.write", "nova.hq.import"],
			);
		});
	});

	it("answers managed_table_handed_back where the table was handed back while the upload got ready", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		const copy = await makeManagedCopy(h, lookup, facilities, TARGET);
		await seed(managedReader([copy]));
		await h
			.db()
			.updateTable("lookup_tables")
			.set({
				hq_taken_over_at: new Date("2026-11-03T08:00:00.000Z"),
				hq_taken_over_by: ACTOR,
			})
			.where("id", "=", copy.tableId)
			.execute();
		await withManagedPeer(async (peer) => {
			serveTableList(peer, "clinic", [facilities]);
			serveRows(peer, "clinic", facilities);
			acceptImport(peer, "clinic", 201, {
				before: async () => {
					await h
						.db()
						.updateTable("lookup_tables")
						.set({ hq_taken_over_at: null, hq_taken_over_by: null })
						.where("id", "=", copy.tableId)
						.execute();
				},
			});
			serveSource(peer, "clinic", "source-shell");
			await asUser(async (client) => {
				const refused = body(await call(client), true);
				expect(refused.error_type).toBe("managed_table_handed_back");
				expect(refused.message).toBe(MANAGED_TABLE_HANDED_BACK_AFTER_CREATE);
			});
			expect(
				requests(peer).some((line) => line.endsWith("/fixtures/fixapi/")),
			).toBe(false);
		});
	});
});

/* The app goes to recently deleted, or its publisher is made a viewer or
 * removed from its Project, while a publish runs. The writes it already let
 * out are recorded on their admissions; the next one is refused; and the
 * publisher is told the app was deleted where they may still edit it, and
 * otherwise that what had gone was recorded. A publish whose import landed
 * before that lands, answering the record only to a publisher who may still
 * read it. */
describe("an app that stops being the publisher's to publish while a publish runs", () => {
	async function openWrites() {
		return h
			.db()
			.selectFrom("hq_remote_writes")
			.select("write_kind")
			.where(openRemoteWrite)
			.execute();
	}

	it.each([
		["deleted", appDeletedWhilePublishing("clinic", true)],
		[
			"left to a publisher who can only view it",
			accessLostWhilePublishing("clinic"),
		],
		[
			"left to a publisher removed from its Project",
			accessLostWhilePublishing("clinic"),
		],
	] as const)(
		"records the empty app CommCare HQ made and sends no content once the app is %s meanwhile",
		async (loss, message) => {
			await seed();
			await withManagedPeer(async (peer) => {
				request(peer, IMPORT, "POST").reply(async () => {
					if (loss === "deleted") await softDeleteApp(APP, "creator");
					else if (loss.includes("removed"))
						await h.removeProjectMember(ACTOR, PROJECT);
					else await h.seedProjectMember(ACTOR, PROJECT, "viewer");
					hqSaves.create("working-app");
					return {
						statusCode: 201,
						data: JSON.stringify({ success: true, app_id: "working-app" }),
					};
				});
				shellSource(peer);
				await asUser(async (client) => {
					expect(body(await call(client), true)).toMatchObject({
						error_type: "not_found",
						message,
					});
				});
				expect(
					requests(peer).filter((line) => line.startsWith("POST ")),
				).toEqual([`POST ${HOST}${IMPORT}`]);
			});
			expect(await openWrites()).toEqual([]);
			if (loss === "deleted") await restoreApp(APP, "creator");
			else await h.seedProjectMember(ACTOR, PROJECT, "editor");
			/* The attempt folds nothing past its passed preflight: the next
			 * publish fills the empty app the record names. */
			const record = await state();
			expect(record?.deployment.state).not.toBe("incomplete");
			expect(record?.deployment.resumePhase).toBeNull();
			expect(activeRemoteApp(record ?? fail())?.remoteId).toBe("working-app");
		},
	);

	it.each([
		["made a viewer", true],
		["removed from the Project", false],
	] as const)(
		"lands an update whose publisher was %s while CommCare HQ took it, answering the record only where they may still read it",
		async (_loss, mayRead) => {
			await seed();
			const colleague = "colleague-who-confirmed";
			await h.seedProjectMember(colleague, PROJECT, "editor");
			await withManagedPeer(async (peer) => {
				shellCreated(peer);
				imported(peer);
				await asUser(async (client) => {
					body(await call(client));
				});
				await recordWorkerLevelConfirmations(
					{ ...SCOPE, actorUserId: colleague, role: "editor" },
					TARGET,
					["district"],
					{ expectedEndings: 0 },
				);
				source(peer);
				request(peer, IMPORT, "POST").reply(async () => {
					if (mayRead) await h.seedProjectMember(ACTOR, PROJECT, "viewer");
					else await h.removeProjectMember(ACTOR, PROJECT);
					return {
						statusCode: 200,
						data: JSON.stringify({
							success: true,
							app_id: "working-app",
							version: hqSaves.save("working-app"),
						}),
					};
				});
				source(peer);
				await asUser(async (client) => {
					const result = await call(client);
					const landed = body(result);
					expect(landed.stage).toBe("upload_complete");
					expect(landed.hq_app_id).toBe("working-app");
					if (mayRead) {
						expect(landed.deployment.confirmations).toContainEqual(
							expect.objectContaining({ subject: "district" }),
						);
					} else {
						expect(landed.deployment).toBeNull();
						expect(landed.deployment_state).toBeUndefined();
						expect(landed.sent).toEqual([
							{
								kind: "app",
								nova_id: APP,
								hq_id: "working-app",
								hq_name: null,
							},
						]);
						expect(JSON.stringify(result)).not.toContain(colleague);
					}
				});
			});
			/* The record is whole for whoever may read it. */
			const theirs = await readDeployment(
				{ ...SCOPE, actorUserId: colleague, role: "editor" },
				TARGET,
			);
			expect(activeRemoteApp(theirs ?? fail())?.remoteId).toBe("working-app");
			expect(theirs?.confirmations).toContainEqual(
				expect.objectContaining({ confirmedByName: colleague }),
			);
			expect(theirs?.deployment.state).toBe("uploaded");
		},
	);

	it("sends nothing once the app is deleted while preflight reads the app there", async () => {
		await seed();
		await withManagedPeer(async (peer) => {
			shellCreated(peer);
			imported(peer);
			await asUser(async (client) => {
				body(await call(client));
			});
			const posted = requests(peer).filter((line) =>
				line.startsWith("POST "),
			).length;
			const writes = await h
				.db()
				.selectFrom("hq_remote_writes")
				.select("id")
				.execute();
			const live = liveSource();
			request(peer, SOURCE).reply(async () => {
				await softDeleteApp(APP, "creator");
				return {
					statusCode: live.status,
					data: retainedBodyText(live),
					responseOptions: { headers: { ...live.headers } },
				};
			});
			await asUser(async (client) => {
				expect(body(await call(client), true)).toMatchObject({
					error_type: "not_found",
					message: appDeletedWhilePublishing("clinic", false),
				});
			});
			expect(
				requests(peer).filter((line) => line.startsWith("POST ")),
			).toHaveLength(posted);
			expect(
				await h.db().selectFrom("hq_remote_writes").select("id").execute(),
			).toEqual(writes);
		});
	});
});
