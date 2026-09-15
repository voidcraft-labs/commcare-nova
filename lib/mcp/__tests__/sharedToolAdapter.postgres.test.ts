/** Actual shared tools through SDK dispatch, migrated authorization and guarded commits. */
import { sql } from "kysely";
import { expect, it } from "vitest";
import { z } from "zod";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { addFieldsTool } from "@/lib/agent/tools/addFields";
import {
	getCasePropertyTool,
	updateCasePropertyTool,
} from "@/lib/agent/tools/caseProperties";
import { configureConnectTool } from "@/lib/agent/tools/configureConnect";
import { editFieldTool } from "@/lib/agent/tools/editField";
import { getFormTool } from "@/lib/agent/tools/getForm";
import {
	addLocationPropertiesTool,
	addOrganizationLevelsTool,
	createLocationTool,
	getOrganizationTool,
} from "@/lib/agent/tools/organization";
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
import { promptDoc } from "./promptFixtures";
import { resultText } from "./resultText";

const h = setupAppStateTestDb("mcp_shared_", { authSchema: "migrated" });
const ACTOR = "editor";
const PROJECT = "shared";
const context = {
	userId: ACTOR,
	scopes: ["nova.read", "nova.write"],
	authKind: "oauth" as const,
};
const register: Parameters<typeof withMcpClient>[0] = (server) => {
	registerSharedTool(
		server,
		"get_case_property",
		getCasePropertyTool,
		context,
		"view",
	);
	registerSharedTool(
		server,
		"update_case_property",
		updateCasePropertyTool,
		context,
		"edit",
	);
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

it("reads and edits one catalog property through MCP without changing saved case values", async () => {
	const doc: BlueprintDoc = promptDoc();
	doc.caseTypes = [
		{
			name: "plot",
			properties: [
				{
					name: "beds",
					label: proseText("Beds"),
					data_type: "int",
					validation: { parts: [{ kind: "text", text: ". >= 1" }] },
					validation_msg: proseText("Enter at least one bed."),
				},
			],
		},
	];
	await h.seedAppWithBlueprint(doc, {
		id: doc.appId,
		owner: "creator",
		projectId: PROJECT,
	});
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const schema = await withSchemaContext();
	await schema.applySchemaChange({
		appId: doc.appId,
		caseType: "plot",
		caseTypeSchemas: buildCaseTypeMap(doc),
		syncedSeq: 0,
	});
	const store = await withProjectContext(PROJECT, ACTOR, ACTOR);
	await store.insert({
		appId: doc.appId,
		row: {
			case_id: "plot-1",
			case_type: "plot",
			case_name: "North plot",
			modified_on: new Date("2026-09-13T00:00:00Z"),
			properties: { beds: 5 },
		},
	});
	const db = await getCaseStoreDatabase();
	const beforeCases = await db.selectFrom("cases").selectAll().execute();
	const address = { app_id: doc.appId, caseType: "plot", property: "beds" };
	await withMcpClient(register, async (client) => {
		expect(
			JSON.parse(
				resultText(
					await client.callTool({
						name: "get_case_property",
						arguments: address,
					}),
				),
			),
		).toMatchObject({ property: { label: "Beds", validation: ". >= 1" } });
		expect(
			JSON.parse(
				resultText(
					await client.callTool({
						name: "update_case_property",
						arguments: {
							...address,
							updates: {
								label: "Number of beds",
								validation: null,
								validation_msg: null,
							},
						},
					}),
				),
			),
		).toEqual({ ok: true });
		expect(
			JSON.parse(
				resultText(
					await client.callTool({
						name: "get_case_property",
						arguments: address,
					}),
				),
			),
		).toEqual({
			caseType: "plot",
			property: { name: "beds", label: "Number of beds", data_type: "int" },
		});
		const writes = await changes(doc.appId);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			kind: "mcp",
			actor_id: ACTOR,
			mutations: [
				{
					kind: "setCaseProperty",
					caseType: "plot",
					property: {
						name: "beds",
						label: proseText("Number of beds"),
						data_type: "int",
					},
				},
			],
		});
		expect(await db.selectFrom("cases").selectAll().execute()).toEqual(
			beforeCases,
		);
		await h.seedProjectMember(ACTOR, PROJECT, "viewer");
		resultText(
			await client.callTool({ name: "get_case_property", arguments: address }),
		);
		expect(
			await client.callTool({
				name: "update_case_property",
				arguments: { ...address, updates: { label: "Denied" } },
			}),
		).toHaveProperty("isError", true);
		expect(await changes(doc.appId)).toEqual(writes);
	});
});

it("binds names throughout a recursive place request and stores property identities", async () => {
	const { doc } = await seed();
	await withMcpClient(
		(server) => {
			registerSharedTool(
				server,
				"add_organization_levels",
				addOrganizationLevelsTool,
				context,
				"edit",
			);
			registerSharedTool(
				server,
				"add_location_properties",
				addLocationPropertiesTool,
				context,
				"edit",
			);
			registerSharedTool(
				server,
				"create_location",
				createLocationTool,
				context,
				"edit",
			);
			registerSharedTool(
				server,
				"get_organization",
				getOrganizationTool,
				context,
				"view",
			);
		},
		async (client) => {
			async function call(name: string, input: Record<string, unknown>) {
				const result = await client.callTool({
					name,
					arguments: { app_id: doc.appId, ...input },
				});
				expect(result.isError, resultText(result)).not.toBe(true);
				const payload = JSON.parse(resultText(result));
				expect(payload).not.toHaveProperty("error");
				return payload;
			}
			await call("add_organization_levels", {
				levels: [
					{
						code: "district",
						name: "District",
						caseFlow: { workers: "none", ownsCases: false },
						addressBook: { reach: "own-branch" },
					},
					{
						code: "clinic",
						name: "Clinic",
						parentLevelUuid: "District",
						caseFlow: { workers: "none", ownsCases: false },
						addressBook: { reach: "own-branch" },
					},
					{
						code: "ward",
						name: "Ward",
						parentLevelUuid: "Clinic",
						caseFlow: { workers: "none", ownsCases: false },
						addressBook: { reach: "own-branch" },
					},
				],
			});
			await call("add_location_properties", {
				properties: [{ slug: "staff", label: "Staff" }],
			});
			const before = await call("get_organization", {});
			const created = await call("create_location", {
				expectedRevision: before.revision,
				name: "North",
				levelUuid: "District",
				values: { staff: "8" },
				descendants: [
					{
						name: "Central",
						levelUuid: "Clinic",
						values: { Staff: "4" },
						descendants: [
							{ name: "Outreach", levelUuid: "Ward", values: { staff: "2" } },
						],
					},
				],
			});
			await call("create_location", {
				expectedRevision: created.revision,
				parentId: "North",
				levelUuid: "Clinic",
				name: "South",
				values: { staff: "3" },
			});
			const saved = await call("get_organization", { includeValues: true });
			const app = await loadApp(doc.appId);
			if (!app?.blueprint) throw new Error("Missing saved app.");
			const property = Object.values(app.blueprint.locationProperties ?? {})[0];
			const levels = Object.values(app.blueprint.organizationLevels ?? {});
			expect(saved.locations).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "Outreach",
						levelUuid: levels.find((item) => item.name === "Ward")?.uuid,
						values: { [property.uuid]: "2" },
					}),
					expect.objectContaining({
						name: "South",
						parentId: created.location.id,
						values: { [property.uuid]: "3" },
					}),
				]),
			);
			const duplicate = await client.callTool({
				name: "create_location",
				arguments: {
					app_id: doc.appId,
					expectedRevision: saved.revision,
					parentId: "North",
					levelUuid: "Clinic",
					name: "Duplicate",
					values: { staff: "1", Staff: "2" },
				},
			});
			expect(duplicate.isError).toBe(true);
			expect(duplicate.content).toEqual([
				{
					type: "text",
					text: expect.stringContaining(
						"Two values reference the same property",
					),
				},
			]);
			const unchanged = await call("get_organization", { includeValues: true });
			expect(unchanged.locations).toEqual(saved.locations);
			expect(unchanged.revision).toBe(saved.revision);
		},
	);
});

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
								label: "Consent",
								optionsSource: {
									kind: "inline",
									options: [
										{ optionUuid: yes, value: "yes", label: "Yes" },
										{ optionUuid: no, value: "no", label: "No" },
									],
								},
							},
						],
					},
				}),
			),
		);
		expect(payload).toEqual({
			ok: true,
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
						text: expect.stringMatching(
							/Input validation error|"error_type":"invalid_input"/,
						),
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
				fields: [{ id: "note", kind: "text", label: "Note" }],
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
									label: "Duplicate",
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
				label: "Patient code",
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
		expect(result).toHaveProperty("ok", true);
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
					result: { ok: true, summary: { subject: "App" } },
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
				else expect(JSON.parse(resultText(response))).toEqual({ ok: true });
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
				expect(result).toHaveProperty("ok", true);
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
					arguments: { ...args, confirmConversion: true },
				}),
			),
		);
		expect(confirmed).toMatchObject({
			ok: true,
			field: { uuid: fieldUuid, kind: "int" },
			dataReview: {
				values: 1,
				location: "Case data",
				reasons: [expect.any(String)],
				additionalReasons: 0,
			},
		});
		expect(confirmed).not.toHaveProperty("summary");
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
						updates: { kind: "hidden", calculate: '"automatic"' },
					},
				}),
			),
		);
		expect(accepted).toMatchObject({
			ok: true,
			field: { uuid: fieldUuid, kind: "hidden" },
			conversion: { from: "text", to: "hidden" },
		});
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
