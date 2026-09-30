/** Real SDK dispatch through private work, migrated authorization and publication. */
import type { Client } from "@modelcontextprotocol/client";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { withProjectContext } from "@/lib/case-store";
import { getCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	prepareGenesisCandidate,
	writePreparedGenesisInTransaction,
} from "@/lib/db/appGenesis";
import { loadApp } from "@/lib/db/apps";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { log } from "@/lib/logger";
import { sectionEntryDoc } from "@/lib/preview/engine/__tests__/fixtures/sectionEntry";
import { registerSharedTool } from "../adapters/sharedToolAdapter";
import { registerWorkTools } from "../tools/work";
import { withMcpClient } from "./client";
import { promptDoc } from "./promptFixtures";
import { resultContentText, resultText } from "./resultText";

const h = setupAppStateTestDb("mcp_shared_", { authSchema: "migrated" });
const ACTOR = "editor";
const PROJECT = "shared";
const context = {
	userId: ACTOR,
	scopes: ["nova.read", "nova.write"],
	authKind: "oauth" as const,
};
const register: Parameters<typeof withMcpClient>[0] = (server) => {
	registerWorkTools(server, context);
	for (const entry of SHARED_TOOL_REGISTRY)
		registerSharedTool(server, entry, context);
};
async function seedCanonical(doc: BlueprintDoc) {
	await h.seedProjectMember("creator", PROJECT, "owner");
	const candidate = prepareGenesisCandidate({
		appId: doc.appId,
		projectId: PROJECT,
		mutations: diffDocsToMutations(emptyBlueprintDoc(doc.appId), doc),
	});
	await h.withTransaction((tx) =>
		writePreparedGenesisInTransaction(tx, {
			candidate,
			actorUserId: "creator",
			runId: crypto.randomUUID(),
			status: "complete",
		}),
	);
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	return doc;
}
async function seed() {
	return seedCanonical(promptDoc());
}
async function call(
	client: Client,
	name: string,
	input: Record<string, unknown>,
) {
	const result = await client.callTool({ name, arguments: input });
	if (result.isError) {
		const cause = vi.mocked(log.error).mock.calls.at(-1)?.[1];
		if (cause instanceof Error) throw cause;
	}
	expect(result.isError, resultContentText(result)).not.toBe(true);
	return JSON.parse(resultContentText(result));
}
async function begin(client: Client, appId?: string) {
	return call(client, "begin_work", {
		request_id: crypto.randomUUID(),
		...(appId
			? { app_id: appId }
			: { new_app: { name: "Clinic intake", project_id: PROJECT } }),
	});
}
async function save(client: Client, workId: string) {
	const work = await call(client, "get_work", { work_id: workId });
	return call(client, "save_work", {
		work_id: workId,
		expected_revision: work.revision,
		request_id: crypto.randomUUID(),
	});
}
async function changes(appId: string, includeBaseline = false) {
	let query = h
		.db()
		.selectFrom("app_changes")
		.selectAll()
		.where("app_id", "=", appId);
	if (!includeBaseline) query = query.where("kind", "!=", "fold-baseline");
	return query.orderBy("seq").execute();
}

it("constructs a new app through separate module, form and question calls, then publishes once", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await withMcpClient(register, async (client) => {
		const tools = await client.listTools();
		expect(tools.tools.some((tool) => tool.name === "create_app")).toBe(false);
		const opened = await begin(client);
		const work_id = opened.work_id;
		expect(await h.db().selectFrom("apps").selectAll().execute()).toEqual([]);
		const module = await call(client, "create_module", {
			work_id,
			request_id: "module",
			name: "Intake",
		});
		expect(module).toMatchObject({ ok: true, saved: false, work_id });
		const form = await call(client, "create_form", {
			work_id,
			request_id: "form",
			moduleUuid: module.moduleUuid,
			name: "Patient intake",
			type: "survey",
		});
		const incomplete = await save(client, work_id);
		expect(incomplete.success).toBe(false);
		expect(await h.db().selectFrom("apps").selectAll().execute()).toEqual([]);
		const fieldArgs = {
			work_id,
			request_id: "question",
			moduleUuid: module.moduleUuid,
			formUuid: form.formUuid,
			fields: [{ id: "name", kind: "text", label: "Patient name" }],
		};
		const fields = await call(client, "add_fields", fieldArgs);
		expect(await call(client, "add_fields", fieldArgs)).toEqual(fields);
		const privateForm = await call(client, "get_form", {
			work_id,
			moduleUuid: module.moduleUuid,
			formUuid: form.formUuid,
		});
		expect(privateForm.form.fields).toHaveLength(1);
		const status = await call(client, "get_work", { work_id });
		const saveArgs = {
			work_id,
			request_id: "birth",
			expected_revision: status.revision,
		};
		const saved = await call(client, "save_work", saveArgs);
		expect(saved.success).toBe(true);
		expect(await call(client, "save_work", saveArgs)).toEqual(saved);
		const apps = await h.db().selectFrom("apps").selectAll().execute();
		expect(apps).toHaveLength(1);
		const app = await loadApp(apps[0].id);
		expect(app?.blueprint.fields[fields.fields[0].uuid]).toMatchObject({
			id: "name",
			label: proseText("Patient name"),
		});
		expect(await changes(apps[0].id, true)).toHaveLength(1);
		expect(await call(client, "get_work", { work_id })).toMatchObject({
			app_id: apps[0].id,
			pending_changes: 0,
		});
	});
});

it("keeps edits private and reads either version explicitly", async () => {
	const doc = await seed();
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	await withMcpClient(register, async (client) => {
		const { work_id } = await begin(client, doc.appId);
		const address = { moduleUuid, formUuid };
		const result = await call(client, "add_fields", {
			work_id,
			request_id: "add",
			...address,
			fields: [{ id: "note", kind: "text", label: "Note" }],
		});
		expect(result.saved).toBe(false);
		expect(
			(await call(client, "get_form", { app_id: doc.appId, ...address })).form
				.fields,
		).toHaveLength(1);
		expect(
			(await call(client, "get_form", { work_id, ...address })).form.fields,
		).toHaveLength(2);
		expect(await changes(doc.appId)).toEqual([]);
		expect((await save(client, work_id)).success).toBe(true);
		expect(
			(await loadApp(doc.appId))?.blueprint.fieldOrder[formUuid],
		).toHaveLength(2);
		expect(await changes(doc.appId)).toHaveLength(1);
	});
});

it("reauthorizes work and exact retries after membership loss", async () => {
	const doc = await seed();
	await withMcpClient(register, async (client) => {
		const { work_id } = await begin(client, doc.appId);
		const args = { work_id, request_id: "module", name: "Pending" };
		await call(client, "create_module", args);
		await sql`DELETE FROM auth_member WHERE "userId" = ${ACTOR}`.execute(
			h.db(),
		);
		for (const [name, input] of [
			["create_module", args],
			["get_work", { work_id }],
		] as const) {
			const result = await client.callTool({ name, arguments: input });
			expect(result.isError).toBe(true);
			expect(JSON.parse(resultContentText(result)).error_type).toBe(
				"not_found",
			);
		}
		expect(await changes(doc.appId)).toEqual([]);
	});
});

it("discards only the requested candidate and retains exact prior receipts", async () => {
	const doc = await seed();
	await withMcpClient(register, async (client) => {
		const { work_id } = await begin(client, doc.appId);
		const original = await call(client, "create_module", {
			work_id,
			request_id: "first",
			name: "First",
		});
		const status = await call(client, "get_work", { work_id });
		const args = {
			work_id,
			request_id: "discard",
			expected_revision: status.revision,
		};
		const discarded = await call(client, "discard_work", args);
		await call(client, "create_module", {
			work_id,
			request_id: "second",
			name: "Second",
		});
		expect(await call(client, "discard_work", args)).toEqual(discarded);
		expect(
			await call(client, "create_module", {
				work_id,
				request_id: "first",
				name: "First",
			}),
		).toEqual(original);
		const current = await call(client, "get_work", { work_id });
		expect(current.pending_changes).toBeGreaterThan(0);
		expect(
			current.app.modules.some(
				(module: { name: string }) => module.name === "Second",
			),
		).toBe(true);
		expect(
			current.app.modules.some(
				(module: { name: string }) => module.name === "First",
			),
		).toBe(false);
		expect(await changes(doc.appId)).toEqual([]);
	});
});

it("preserves nested refinements after transport admission without advancing private work", async () => {
	const doc = await seed();
	await withMcpClient(register, async (client) => {
		const { work_id } = await begin(client, doc.appId);
		const before = await call(client, "get_work", { work_id });
		const result = await client.callTool({
			name: "configure_connect",
			arguments: { work_id, request_id: "invalid-connect", mode: "learn" },
		});
		expect(result.isError).toBe(true);
		expect(JSON.parse(resultContentText(result))).toMatchObject({
			error_type: "invalid_input",
			message: expect.stringMatching(/participants|participant/i),
		});
		const after = await call(client, "get_work", { work_id });
		expect(after.pending_changes).toBe(before.pending_changes);
		expect(after.app).toEqual(before.app);
		expect(await changes(doc.appId)).toEqual([]);
	});
});

it("requires a clean checkpoint for organization rows and applies their effects immediately", async () => {
	const doc = await seed();
	await withMcpClient(register, async (client) => {
		const { work_id } = await begin(client, doc.appId);
		await call(client, "add_organization_levels", {
			work_id,
			request_id: "levels",
			levels: [
				{
					code: "district",
					name: "District",
					caseFlow: { workers: "none", ownsCases: false },
					addressBook: { reach: "own-branch" },
				},
			],
		});
		const organization = await call(client, "get_organization", { work_id });
		const early = await client.callTool({
			name: "create_location",
			arguments: {
				work_id,
				request_id: "early-place",
				name: "North",
				levelUuid: "District",
				expectedRevision: organization.revision,
			},
		});
		expect(early.isError).toBe(true);
		expect((await save(client, work_id)).success).toBe(true);
		const ready = await call(client, "get_organization", { work_id });
		const placeArgs = {
			work_id,
			request_id: "place",
			name: "North",
			levelUuid: "District",
			expectedRevision: ready.revision,
		};
		const placed = await call(client, "create_location", placeArgs);
		const canonical = await call(client, "get_organization", {
			app_id: doc.appId,
		});
		expect(canonical.locations).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "North" })]),
		);
		expect((await call(client, "get_work", { work_id })).pending_changes).toBe(
			0,
		);
		await call(client, "create_module", {
			work_id,
			request_id: "later-app-edit",
			name: "Pending",
		});
		const pending = await call(client, "get_work", { work_id });
		expect(await call(client, "create_location", placeArgs)).toEqual(placed);
		const collision = await client.callTool({
			name: "create_module",
			arguments: { work_id, request_id: "place", name: "Collision" },
		});
		expect(collision.isError).toBe(true);
		expect(JSON.parse(resultContentText(collision))).toMatchObject({
			error_type: "invalid_input",
		});
		expect((await call(client, "get_work", { work_id })).revision).toBe(
			pending.revision,
		);
	});
});

it("does not expose another member's pending work through reads or discovery", async () => {
	const doc = await seed();
	await h.seedProjectMember("colleague", PROJECT, "editor");
	const work = await withMcpClient(register, (client) =>
		begin(client, doc.appId),
	);
	await withMcpClient(
		(server) => registerWorkTools(server, { ...context, userId: "colleague" }),
		async (client) => {
			const result = await client.callTool({
				name: "get_work",
				arguments: { work_id: work.work_id },
			});
			expect(result.isError).toBe(true);
			expect(JSON.parse(resultContentText(result)).error_type).toBe(
				"not_found",
			);
			expect(await call(client, "list_work", { project_id: PROJECT })).toEqual({
				work: [],
			});
		},
	);
});

it("asks for conversion consent, leaves case data untouched while staged, and reports parking at save", async () => {
	const doc = buildDoc({
		appId: "conversion-app",
		appName: "Patient measurements",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name", data_type: "text" },
					{ name: "weight", label: "Weight", data_type: "decimal" },
					{ name: "unused", label: "Unused", data_type: "text" },
				],
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
								kind: "text",
								id: "patient_name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "decimal",
								id: "weight",
								caseWrite: { caseType: "patient", property: "weight" },
							}),
						],
					},
				],
			},
		],
	});
	await seedCanonical(doc);
	const store = await withProjectContext(PROJECT, ACTOR, ACTOR);
	await store.insert({
		appId: doc.appId,
		row: {
			case_id: "patient",
			case_type: "patient",
			case_name: "Patient",
			modified_on: new Date("2026-04-01T00:00:00Z"),
			properties: { weight: 1.5 },
		},
	});
	const db = await getCaseStoreDatabase();
	const beforeApp = await loadApp(doc.appId);
	const beforeCases = await db.selectFrom("cases").selectAll().execute();
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const fieldUuid = doc.fieldOrder[formUuid][1];
	const args = {
		moduleUuid,
		formUuid,
		fieldUuid,
		updates: { kind: "int" },
	};
	await withMcpClient(register, async (client) => {
		const { work_id } = await begin(client, doc.appId);
		const consent = JSON.parse(
			resultText(
				await client.callTool({
					name: "edit_field",
					arguments: { ...args, work_id, request_id: "impact" },
				}),
			),
		);
		expect(consent).toMatchObject({
			needsConfirmation: {
				caseType: "patient",
				newlyHeldCases: 1,
				consequence:
					"Values move to Data to review; affected cases are excluded until review.",
				recovery:
					"Review the values in Case data or revert the property conversion.",
				confirmation: { confirmConversion: true },
				property: "weight",
				fromType: "decimal",
				toType: "int",
				totalWithValue: 1,
				uncastable: 1,
				alreadyHeld: 0,
				samples: [1.5],
			},
		});
		expect(await loadApp(doc.appId)).toEqual(beforeApp);
		expect(await db.selectFrom("cases").selectAll().execute()).toEqual(
			beforeCases,
		);
		expect(
			await db.selectFrom("parked_case_values").selectAll().execute(),
		).toEqual([]);
		expect(await changes(doc.appId)).toEqual([]);
		const confirmed = JSON.parse(
			resultText(
				await client.callTool({
					name: "edit_field",
					arguments: {
						...args,
						work_id,
						request_id: "convert",
						confirmConversion: true,
					},
				}),
			),
		);
		expect(confirmed).toMatchObject({
			ok: true,
			field: { uuid: fieldUuid, kind: "int" },
		});
		expect(await loadApp(doc.appId)).toEqual(beforeApp);
		expect(await db.selectFrom("cases").selectAll().execute()).toEqual(
			beforeCases,
		);
		expect(
			await db.selectFrom("parked_case_values").selectAll().execute(),
		).toEqual([]);
		await call(client, "remove_case_properties", {
			work_id,
			request_id: "remove-unused",
			properties: [{ caseType: "patient", property: "unused" }],
		});
		const state = await call(client, "get_work", { work_id });
		const saveArgs = {
			work_id,
			request_id: "save-conversion",
			expected_revision: state.revision,
		};
		const beforeEntities = await h
			.db()
			.selectFrom("blueprint_entities")
			.selectAll()
			.where("app_id", "=", doc.appId)
			.orderBy("uuid")
			.execute();
		const beforeEvents = await h
			.db()
			.selectFrom("events")
			.selectAll()
			.where("app_id", "=", doc.appId)
			.orderBy("id")
			.execute();
		await sql`CREATE FUNCTION reject_mcp_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private late checkpoint failure'; END $$`.execute(
			h.db(),
		);
		await sql`CREATE TRIGGER reject_mcp_checkpoint BEFORE INSERT ON authoring_checkpoints FOR EACH ROW EXECUTE FUNCTION reject_mcp_checkpoint()`.execute(
			h.db(),
		);
		const rejected = await client.callTool({
			name: "save_work",
			arguments: saveArgs,
		});
		expect(rejected.isError).toBe(true);
		expect(await loadApp(doc.appId)).toEqual(beforeApp);
		expect(
			await h
				.db()
				.selectFrom("blueprint_entities")
				.selectAll()
				.where("app_id", "=", doc.appId)
				.orderBy("uuid")
				.execute(),
		).toEqual(beforeEntities);
		expect(await db.selectFrom("cases").selectAll().execute()).toEqual(
			beforeCases,
		);
		expect(
			await db.selectFrom("parked_case_values").selectAll().execute(),
		).toEqual([]);
		expect(await changes(doc.appId)).toEqual([]);
		expect(
			await h
				.db()
				.selectFrom("events")
				.selectAll()
				.where("app_id", "=", doc.appId)
				.orderBy("id")
				.execute(),
		).toEqual(beforeEvents);
		expect((await call(client, "get_work", { work_id })).revision).toBe(
			state.revision,
		);
		await sql`DROP TRIGGER reject_mcp_checkpoint ON authoring_checkpoints`.execute(
			h.db(),
		);
		const saved = await call(client, "save_work", saveArgs);
		expect(saved).toMatchObject({
			success: true,
			dataReview: {
				values: 1,
				location: "Case data",
				reasons: [expect.any(String)],
				additionalReasons: 0,
			},
		});
		expect(confirmed).not.toHaveProperty("summary");
		// Recover the window after canonical commit and before the ordinary
		// session recorded its response. The checkpoint owns this consequence.
		await h
			.db()
			.updateTable("authoring_session_requests")
			.set({ result_json: null })
			.where("ordinary_session_id", "=", work_id)
			.where("request_id", "=", "save-conversion")
			.execute();
		expect(await call(client, "save_work", saveArgs)).toEqual(saved);
		expect((await loadApp(doc.appId))?.blueprint.fields[fieldUuid].kind).toBe(
			"int",
		);
		expect(
			await db
				.selectFrom("parked_case_values")
				.select([
					"case_id",
					"property",
					"original_value",
					"from_type",
					"to_type",
					"dismissed_at",
				])
				.execute(),
		).toEqual([
			{
				case_id: "patient",
				property: "weight",
				original_value: 1.5,
				from_type: "decimal",
				to_type: "int",
				dismissed_at: null,
			},
		]);
		expect(
			await db
				.selectFrom("cases")
				.select(["case_id", "case_name", "properties"])
				.execute(),
		).toEqual([{ case_id: "patient", case_name: "Patient", properties: {} }]);
		expect(await changes(doc.appId)).toHaveLength(1);
	});
});

it("runs a saved worker journey through work-scoped MCP calls and refuses pending candidates", async () => {
	const doc = await seed();
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	await withMcpClient(register, async (client) => {
		const { work_id } = await begin(client, doc.appId);
		await call(client, "add_fields", {
			work_id,
			request_id: "journey-field",
			formUuid,
			fields: [{ id: "notes", kind: "text", label: "Notes" }],
		});
		expect((await save(client, work_id)).success).toBe(true);
		const args = {
			work_id,
			request_id: "journey",
			purpose: "Inspect saved intake entry",
		};
		const journey = await call(client, "start_app_test", args);
		try {
			expect(journey.testId).toEqual(expect.any(String));
			expect(await call(client, "start_app_test", args)).toEqual(journey);
		} finally {
			await call(client, "continue_app_test", {
				work_id,
				request_id: "finish-journey",
				testId: journey.testId,
				expectedStep: journey.step,
				action: { kind: "finish" },
			});
		}
		await call(client, "create_module", {
			work_id,
			request_id: "pending-module",
			name: "Unfinished",
		});
		const refused = await client.callTool({
			name: "start_app_test",
			arguments: { ...args, request_id: "pending-journey" },
		});
		expect(refused.isError).toBe(true);
		expect(JSON.parse(resultContentText(refused))).toMatchObject({
			error_type: "invalid_input",
			message: expect.stringContaining("Save the current app changes"),
		});
	});
});

it("serves ordered journey actions with deferred section names and bounded retained evidence over the real MCP transport", async () => {
	const doc = await seedCanonical(sectionEntryDoc());
	await withMcpClient(register, async (client) => {
		const started = await call(client, "start_app_test", {
			app_id: doc.appId,
			request_id: "start",
			purpose: "Inspect selected assets",
		});
		const input = {
			app_id: doc.appId,
			request_id: "journey",
			testId: started.testId,
			expectedStep: 0,
			actions: [
				{ action: { kind: "menu", moduleUuid: "Visits" } },
				{ action: { kind: "form", formUuid: "Inspect" } },
				{ action: { kind: "section", sectionUuid: "second" } },
			],
		};
		const response = await call(client, "continue_app_test", input);
		expect(response).toMatchObject({
			step: 3,
			results: [
				{ step: 1 },
				{ step: 2 },
				{ step: 3, observation: { canSubmit: true } },
			],
		});
		expect(await call(client, "continue_app_test", input)).toEqual(response);
		const page = await call(client, "read_app_test", {
			app_id: doc.appId,
			testId: started.testId,
			limit: 2,
		});
		expect(page).toMatchObject({
			throughStep: 3,
			steps: [{ step: 0 }, { step: 1 }],
			nextCursor: { afterStep: 1, throughStep: 3 },
		});
		const rest = await call(client, "read_app_test", {
			app_id: doc.appId,
			testId: started.testId,
			...page.nextCursor,
		});
		expect(rest.steps).toMatchObject([{ step: 2 }, { step: 3 }]);
		await call(client, "continue_app_test", {
			app_id: doc.appId,
			request_id: "finish",
			testId: started.testId,
			expectedStep: 3,
			actions: [{ action: { kind: "finish" } }],
		});
	});
});
