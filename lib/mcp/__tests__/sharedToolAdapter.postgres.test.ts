/** Actual shared tools through SDK dispatch, migrated authorization and guarded commits. */
import { sql } from "kysely";
import { expect, it } from "vitest";
import { z } from "zod";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { addFieldsTool } from "@/lib/agent/tools/addFields";
import { configureConnectTool } from "@/lib/agent/tools/configureConnect";
import { editFieldTool } from "@/lib/agent/tools/editField";
import { getFormTool } from "@/lib/agent/tools/getForm";
import {
	buildCaseTypeMap,
	withProjectContext,
	withSchemaContext,
} from "@/lib/case-store";
import { getCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp } from "@/lib/db/apps";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { readEvents } from "@/lib/log/reader";
import {
	registerSharedTool,
	type SharedToolModule,
} from "../adapters/sharedToolAdapter";
import { withMcpClient } from "./client";
import { resultText } from "./promptClient";
import { promptDoc } from "./promptFixtures";

const h = setupAppStateTestDb("mcp_shared_", { authSchema: "migrated" });
const ACTOR = "editor";
const PROJECT = "shared";
const context = {
	userId: ACTOR,
	scopes: ["nova.read", "nova.write"],
	authKind: "oauth" as const,
};
const register: Parameters<typeof withMcpClient>[0] = (server) => {
	registerSharedTool(server, "add_fields", addFieldsTool, context, "edit");
	registerSharedTool(server, "edit_field", editFieldTool, context, "edit");
	registerSharedTool(server, "get_form", getFormTool, context, "view");
	registerSharedTool(
		server,
		"configure_connect",
		configureConnectTool,
		context,
		"edit",
	);
};
async function seed() {
	const doc = promptDoc();
	await h.seedAppWithBlueprint(doc, {
		id: doc.appId,
		owner: "creator",
		projectId: PROJECT,
	});
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	return {
		doc,
		address: { app_id: doc.appId, moduleUuid, formUuid },
		fieldUuid: doc.fieldOrder[formUuid][0],
	};
}
async function changes(appId: string) {
	return h
		.db()
		.selectFrom("app_changes")
		.select(["seq", "kind", "actor_id", "run_id", "mutations"])
		.where("app_id", "=", appId)
		.orderBy("seq")
		.execute();
}
async function events(appId: string) {
	const rows = await h
		.db()
		.selectFrom("events")
		.select("event")
		.where("app_id", "=", appId)
		.orderBy("id")
		.execute();
	return rows.map((row) => row.event);
}
it("adds fields once, preserves returned identities and drains matching event envelopes before replying", async () => {
	const { doc, address } = await seed();
	const fieldUuid = testUuid("mcp-created-select");
	const yes = testUuid("mcp-created-yes");
	const no = testUuid("mcp-created-no");
	await withMcpClient(register, async (client) => {
		const payload = JSON.parse(
			resultText(
				await client.callTool({
					name: "add_fields",
					arguments: {
						...address,
						fields: [
							{
								fieldUuid,
								id: "consent",
								kind: "single_select",
								label: proseText("Consent"),
								optionsSource: {
									kind: "inline",
									options: [
										{ optionUuid: yes, value: "yes", label: proseText("Yes") },
										{ optionUuid: no, value: "no", label: proseText("No") },
									],
								},
							},
						],
					},
				}),
			),
		);
		expect(payload).toEqual({
			message: expect.stringContaining("Successfully added 1 field"),
			fields: [
				{
					uuid: fieldUuid,
					id: "consent",
					options: [
						{ uuid: yes, value: "yes" },
						{ uuid: no, value: "no" },
					],
				},
			],
		});
		const app = await loadApp(doc.appId);
		expect(app?.mutation_seq).toBe(1);
		expect(app?.blueprint.fieldOrder[address.formUuid]).toEqual([
			...doc.fieldOrder[address.formUuid],
			fieldUuid,
		]);
		expect(app?.blueprint.fields[fieldUuid]).toMatchObject({
			uuid: fieldUuid,
			kind: "single_select",
			id: "consent",
			optionsSource: {
				kind: "inline",
				options: [
					{ uuid: yes, value: "yes", label: proseText("Yes") },
					{ uuid: no, value: "no", label: proseText("No") },
				],
			},
		});
		const history = await changes(doc.appId);
		expect(history).toEqual([
			{
				seq: "1",
				kind: "mcp",
				actor_id: ACTOR,
				run_id: app?.run_id,
				mutations: expect.any(Array),
			},
		]);
		if (!app?.run_id) throw new Error("MCP run attribution missing");
		const persistedEvents = await readEvents(doc.appId, app.run_id);
		expect(persistedEvents).toHaveLength(history[0].mutations.length);
		expect(persistedEvents).toEqual(
			history[0].mutations.map((mutation, seq) => ({
				kind: "mutation",
				runId: app.run_id,
				ts: expect.any(Number),
				seq,
				actor: "agent",
				source: "mcp",
				stage: `form:${address.formUuid}`,
				mutation,
			})),
		);
		const read = JSON.parse(
			resultText(
				await client.callTool({ name: "get_form", arguments: address }),
			),
		);
		expect(read.moduleUuid).toBe(address.moduleUuid);
		expect(read.formUuid).toBe(address.formUuid);
		expect(read.form.fields.at(-1)).toMatchObject({
			uuid: fieldUuid,
			id: "consent",
		});
		expect(await changes(doc.appId)).toEqual(history);
		expect(await readEvents(doc.appId, app.run_id)).toEqual(persistedEvents);
	});
});
it("preserves object-level and nested schema refinements through actual SDK dispatch", async () => {
	const { doc, address } = await seed();
	const before = await loadApp(doc.appId);
	await withMcpClient(register, async (client) => {
		for (const args of [
			{ app_id: doc.appId, mode: "learn" },
			{ app_id: doc.appId, mode: null, participants: [] },
			{
				app_id: doc.appId,
				mode: "learn",
				participants: [
					{
						formUuid: address.formUuid,
						connect: {
							learn_module: {
								id: "intro",
								name: "Intro",
								description: "First",
								time_estimate: 5,
							},
						},
					},
					{
						formUuid: address.formUuid,
						connect: { assessment: { id: "assessment" } },
					},
				],
			},
		]) {
			const result = await client.callTool({
				name: "configure_connect",
				arguments: args,
			});
			expect(result).toMatchObject({
				isError: true,
				content: [
					{
						type: "text",
						text: expect.stringContaining("Input validation error"),
					},
				],
			});
		}
	});
	expect(await loadApp(doc.appId)).toEqual(before);
	expect(await changes(doc.appId)).toEqual([]);
	expect(await events(doc.appId)).toEqual([]);
});
it("enforces current roles for read and write tools and rejects foreign/deleted apps before executing", async () => {
	const { doc, address } = await seed();
	await h.seedProjectMember(ACTOR, PROJECT, "viewer");
	await withMcpClient(register, async (client) => {
		const before = await loadApp(doc.appId);
		resultText(await client.callTool({ name: "get_form", arguments: address }));
		const denied = await client.callTool({
			name: "add_fields",
			arguments: {
				...address,
				fields: [{ id: "note", kind: "text", label: proseText("Note") }],
			},
		});
		expect(denied).toEqual({
			isError: true,
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error_type: "not_found",
						message: "App not found.",
						app_id: doc.appId,
					}),
				},
			],
		});
		expect(await loadApp(doc.appId)).toEqual(before);
		await sql`DELETE FROM auth_member WHERE "userId" = ${ACTOR}`.execute(
			h.db(),
		);
		const foreign = await client.callTool({
			name: "get_form",
			arguments: address,
		});
		expect(foreign).toEqual(denied);
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		await h
			.db()
			.updateTable("apps")
			.set({
				deleted_at: new Date(),
				recoverable_until: new Date(Date.now() + 1000),
			})
			.where("id", "=", doc.appId)
			.execute();
		expect(
			await client.callTool({ name: "get_form", arguments: address }),
		).toEqual(foreign);
	});
	expect(await changes(doc.appId)).toEqual([]);
	expect(await events(doc.appId)).toEqual([]);
});
it("refuses duplicate field ids without writes and strips app_id from the actual shared input", async () => {
	const { doc, address } = await seed();
	const before = await loadApp(doc.appId);
	const echo: SharedToolModule = {
		description: "Observe admitted input",
		inputSchema: z.strictObject({ value: z.string().default("fallback") }),
		async execute(input, ctx) {
			return {
				kind: "read",
				data: { input, projectId: ctx.projectId, appId: ctx.appId },
			};
		},
	};
	await withMcpClient(
		(server) => {
			register(server);
			registerSharedTool(server, "echo", echo, context, "view");
		},
		async (client) => {
			expect(
				JSON.parse(
					resultText(
						await client.callTool({
							name: "echo",
							arguments: { app_id: doc.appId },
						}),
					),
				),
			).toEqual({
				input: { value: "fallback" },
				projectId: PROJECT,
				appId: doc.appId,
			});
			const refusal = JSON.parse(
				resultText(
					await client.callTool({
						name: "add_fields",
						arguments: {
							...address,
							fields: [
								{
									id: "patient_name",
									kind: "text",
									label: proseText("Duplicate"),
								},
							],
						},
					}),
				),
			);
			expect(refusal).toEqual({
				error: expect.stringContaining('"patient_name"'),
			});
		},
	);
	expect(await loadApp(doc.appId)).toEqual(before);
	expect(await changes(doc.appId)).toEqual([]);
	expect(await events(doc.appId)).toEqual([]);
});
it("commits a real conversion plus patch as one change, with no prefix or log on a late SQL rejection", async () => {
	const { doc, address, fieldUuid } = await seed();
	const before = await loadApp(doc.appId);
	await sql`CREATE FUNCTION reject_mcp_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.mutations) AS m WHERE m->>'kind' = 'updateField') THEN RAISE EXCEPTION 'private late commit rejection'; END IF; RETURN NEW; END $$`.execute(
		h.db(),
	);
	await sql`CREATE TRIGGER reject_mcp_change BEFORE INSERT ON app_changes FOR EACH ROW EXECUTE FUNCTION reject_mcp_change()`.execute(
		h.db(),
	);
	await withMcpClient(register, async (client) => {
		const args = {
			...address,
			fieldUuid,
			updates: {
				kind: "barcode",
				id: "patient_code",
				label: proseText("Patient code"),
			},
		};
		const rejected = await client.callTool({
			name: "edit_field",
			arguments: args,
		});
		expect(rejected).toEqual({
			isError: true,
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error_type: "internal",
						message: "Something went wrong during generation.",
						app_id: doc.appId,
					}),
				},
			],
		});
		expect(await loadApp(doc.appId)).toEqual(before);
		expect(await changes(doc.appId)).toEqual([]);
		expect(await events(doc.appId)).toEqual([]);
		await sql`DROP TRIGGER reject_mcp_change ON app_changes`.execute(h.db());
		const result = JSON.parse(
			resultText(
				await client.callTool({ name: "edit_field", arguments: args }),
			),
		);
		expect(result).toEqual(expect.any(String));
		const app = await loadApp(doc.appId);
		expect(app?.mutation_seq).toBe(1);
		expect(app?.blueprint.fields[fieldUuid]).toMatchObject({
			kind: "barcode",
			id: "patient_code",
			label: proseText("Patient code"),
		});
		const history = await changes(doc.appId);
		expect(history).toHaveLength(1);
		expect(history[0].mutations.map((m) => m.kind)).toEqual([
			"convertField",
			"updateField",
		]);
		if (!app?.run_id) throw new Error("Missing run attribution");
		const logged = await readEvents(doc.appId, app.run_id);
		expect(logged).toEqual(
			history[0].mutations.map((mutation, seq) => ({
				kind: "mutation",
				runId: app.run_id,
				ts: expect.any(Number),
				seq,
				actor: "agent",
				source: "mcp",
				stage: `${seq === 0 ? "convert" : "edit"}:${address.formUuid}`,
				mutation,
			})),
		);
	});
});

it.each([false, true])(
	"awaits the actual log INSERT before replying, including a tool failure: %s",
	async (throws) => {
		const { doc } = await seed();
		const tool: SharedToolModule = {
			description: "Commit then return or fail",
			inputSchema: z.object({}),
			async execute(_input, ctx) {
				const result = await ctx.applyBatch({
					mutations: [{ kind: "setAppName", name: "Committed" }],
					stage: "rename",
				});
				if (!result.ok) throw new Error(result.error);
				if (throws)
					throw new Error("private tool failure after accepted commit");
				return {
					kind: "mutate",
					mutations: result.mutations,
					result: { message: "Saved.", summary: { subject: "App" } },
				};
			},
		};
		await withMcpClient(
			(server) =>
				registerSharedTool(server, "commit_probe", tool, context, "edit"),
			async (client) => {
				const response = await whileBlocked(
					h,
					(pg) => pg.query("LOCK TABLE events IN ACCESS EXCLUSIVE MODE"),
					() =>
						client.callTool({
							name: "commit_probe",
							arguments: { app_id: doc.appId },
						}),
					async (settled, controller) => {
						expect(settled).toBe(false);
						expect(
							(
								await controller.query(
									"SELECT app_name FROM apps WHERE id = $1",
									[doc.appId],
								)
							).rows,
						).toEqual([{ app_name: "Committed" }]);
						expect(
							(
								await controller.query(
									"SELECT seq FROM app_changes WHERE app_id = $1",
									[doc.appId],
								)
							).rows,
						).toEqual([{ seq: "1" }]);
					},
				);
				if (throws)
					expect(response).toMatchObject({
						isError: true,
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error_type: "internal",
									message: "Something went wrong during generation.",
									app_id: doc.appId,
								}),
							},
						],
					});
				else expect(JSON.parse(resultText(response))).toBe("Saved.");
				expect(await events(doc.appId)).toEqual([
					{
						kind: "mutation",
						runId: expect.any(String),
						ts: expect.any(Number),
						seq: 0,
						actor: "agent",
						source: "mcp",
						stage: "rename",
						mutation: { kind: "setAppName", name: "Committed" },
					},
				]);
			},
		);
	},
);

function caseWriteAdapterBlueprint(): BlueprintDoc {
	return buildDoc({
		appName: "Case-write MCP parity",
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "sibling",
				parent_type: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "child",
				parent_type: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
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
						name: "Follow up",
						type: "followup",
						fields: [f({ kind: "text", id: "friendly_name" })],
					},
				],
			},
			...["sibling", "child"].map((caseType) => ({
				name: `${caseType} cases`,
				caseType,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: `${caseType} notes`,
						type: "survey" as const,
						fields: [f({ kind: "text", id: `${caseType}_notes` })],
					},
				],
			})),
		],
	});
}

it.each(["child", "sibling"] as const)(
	"rechecks the actual case-write membership rule for %s without fabricated commits",
	async (destination) => {
		const doc = caseWriteAdapterBlueprint();
		await h.seedAppWithBlueprint(doc, {
			id: doc.appId,
			owner: "creator",
			projectId: PROJECT,
		});
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const fieldUuid = doc.fieldOrder[formUuid][0];
		const before = await loadApp(doc.appId);
		await withMcpClient(register, async (client) => {
			const result = JSON.parse(
				resultText(
					await client.callTool({
						name: "edit_field",
						arguments: {
							app_id: doc.appId,
							moduleUuid,
							formUuid,
							fieldUuid,
							updates: {
								kind: "text",
								caseWrite: { caseType: destination, property: "case_name" },
							},
						},
					}),
				),
			);
			if (destination === "child") {
				expect(result).toEqual(expect.any(String));
				const app = await loadApp(doc.appId);
				expect(app?.blueprint.fields[fieldUuid]).toMatchObject({
					caseWrite: { caseType: "child", property: "case_name" },
				});
				expect(app?.mutation_seq).toBe(1);
				expect(await changes(doc.appId)).toHaveLength(1);
				expect(await events(doc.appId)).toHaveLength(1);
			} else {
				expect(result).toEqual({ error: expect.stringContaining("sibling") });
				expect(await loadApp(doc.appId)).toEqual(before);
				expect(await changes(doc.appId)).toEqual([]);
				expect(await events(doc.appId)).toEqual([]);
			}
		});
	},
);

it("reports real conversion impact before consent and retains the saved-value note after a confirmed migration", async () => {
	const doc = buildDoc({
		appId: "conversion-app",
		appName: "Patient measurements",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name", data_type: "text" },
					{ name: "weight", label: "Weight", data_type: "decimal" },
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
	await h.seedAppWithBlueprint(doc, {
		id: doc.appId,
		owner: "author",
		projectId: PROJECT,
	});
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const schema = await withSchemaContext();
	await schema.applySchemaChange({
		appId: doc.appId,
		caseType: "patient",
		caseTypeSchemas: buildCaseTypeMap(doc),
		syncedSeq: 0,
	});
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
		app_id: doc.appId,
		moduleUuid,
		formUuid,
		fieldUuid,
		updates: { kind: "int" },
	};
	await withMcpClient(register, async (client) => {
		const consent = JSON.parse(
			resultText(
				await client.callTool({ name: "edit_field", arguments: args }),
			),
		);
		expect(consent).toEqual({
			message: expect.stringContaining("Nothing was changed."),
			needsConfirmation: {
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
					arguments: { ...args, confirmConversion: true },
				}),
			),
		);
		expect(confirmed).toEqual(expect.any(String));
		expect(confirmed).toContain(
			"Data note: 1 saved case value could not convert",
		);
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

it("admits a staged conversion whose required calculation arrives in the same call", async () => {
	const { doc, address, fieldUuid } = await seed();
	const before = await loadApp(doc.appId);
	const calculate = { parts: [{ kind: "text", text: '"automatic"' }] };
	await withMcpClient(register, async (client) => {
		const missing = JSON.parse(
			resultText(
				await client.callTool({
					name: "edit_field",
					arguments: { ...address, fieldUuid, updates: { kind: "hidden" } },
				}),
			),
		);
		expect(missing).toEqual({
			error: expect.stringMatching(/calculate|default_value/),
		});
		expect(await loadApp(doc.appId)).toEqual(before);
		expect(await changes(doc.appId)).toEqual([]);
		const accepted = JSON.parse(
			resultText(
				await client.callTool({
					name: "edit_field",
					arguments: {
						...address,
						fieldUuid,
						updates: { kind: "hidden", calculate },
					},
				}),
			),
		);
		expect(accepted).toEqual(expect.any(String));
		expect((await loadApp(doc.appId))?.blueprint.fields[fieldUuid]).toEqual({
			uuid: fieldUuid,
			id: "patient_name",
			kind: "hidden",
			calculate,
		});
		const committed = await changes(doc.appId);
		expect(committed).toHaveLength(1);
		expect(committed[0].mutations.map((m) => m.kind)).toEqual([
			"convertField",
			"updateField",
		]);
	});
});
