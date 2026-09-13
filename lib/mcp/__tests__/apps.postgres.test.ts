/** App tools through the real SDK, app store and migrated Project schema. */
import { sql } from "kysely";
import { expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp } from "@/lib/db/apps";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { PersistableDoc, Uuid } from "@/lib/domain";
import { loadAppBlueprint } from "../loadApp";
import { registerCreateApp } from "../tools/createApp";
import { registerDeleteApp } from "../tools/deleteApp";
import { registerGetApp } from "../tools/getApp";
import { registerListApps } from "../tools/listApps";
import { withMcpClient } from "./client";
import { resultText } from "./resultText";

const h = setupAppStateTestDb("mcp_apps_", { authSchema: "migrated" });
const ACTOR = "member";
const PROJECT = "shared-project";
const uuidV4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const register: Parameters<typeof withMcpClient>[0] = (server) => {
	const context = {
		userId: ACTOR,
		scopes: ["nova.read", "nova.write"],
		authKind: "api-key" as const,
	};
	for (const tool of [
		registerCreateApp,
		registerDeleteApp,
		registerGetApp,
		registerListApps,
	])
		tool(server, context);
};
interface Birth {
	stage: string;
	app_id: string;
	base_seq: number;
	blueprint: PersistableDoc;
	starter: { module_uuid: Uuid; form_uuid: Uuid; field_uuid: Uuid };
}
function error(
	error_type: string,
	message: string,
	ids: Record<string, string> = {},
) {
	return {
		isError: true,
		content: [
			{ type: "text", text: JSON.stringify({ error_type, message, ...ids }) },
		],
	};
}

it("creates a shared starter, returns persisted identities, reads it and deletes it through the same protocol", async () => {
	await h.seedProjectMember("creator", PROJECT, "owner");
	await h.seedProjectMember(ACTOR, PROJECT, "admin");
	await sql`UPDATE auth_organization SET name = 'Clinic team' WHERE id = ${PROJECT}`.execute(
		h.db(),
	);
	await withMcpClient(register, async (client) => {
		const born = JSON.parse(
			resultText(
				await client.callTool({
					name: "create_app",
					arguments: { app_name: "Clinic intake", project_id: PROJECT },
				}),
			),
		) as Birth;
		const loaded = await loadAppBlueprint(born.app_id, ACTOR);
		expect(born).toEqual({
			stage: "app_created",
			app_id: born.app_id,
			base_seq: 1,
			blueprint: toPersistableDoc(loaded.doc),
			starter: born.starter,
		});
		expect(born.app_id).toMatch(uuidV4);
		expect(loaded.app).toMatchObject({
			owner: ACTOR,
			project_id: PROJECT,
			app_name: "Clinic intake",
			status: "complete",
			mutation_seq: 1,
			run_id: expect.stringMatching(uuidV4),
			run_holder_nonce: null,
		});
		const { module_uuid, form_uuid, field_uuid } = born.starter;
		expect(born.blueprint.moduleOrder).toEqual([module_uuid]);
		expect(born.blueprint.formOrder).toEqual({ [module_uuid]: [form_uuid] });
		expect(born.blueprint.fieldOrder).toEqual({ [form_uuid]: [field_uuid] });
		expect(born.blueprint.forms[form_uuid]).toMatchObject({
			uuid: form_uuid,
			type: "survey",
		});
		expect(born.blueprint.fields[field_uuid]).toMatchObject({
			uuid: field_uuid,
			kind: "text",
			id: "question_1",
		});
		expect(
			await h
				.db()
				.selectFrom("app_changes")
				.select(["seq", "kind", "actor_id", "run_id", "mutations"])
				.where("app_id", "=", born.app_id)
				.execute(),
		).toEqual([
			{
				seq: "1",
				kind: "fold-baseline",
				actor_id: ACTOR,
				run_id: loaded.app.run_id,
				mutations: [],
			},
		]);
		const text = resultText(
			await client.callTool({
				name: "get_app",
				arguments: { app_id: born.app_id },
			}),
		);
		expect(JSON.parse(text)).toMatchObject({
			project: { id: PROJECT, name: "Clinic team" },
			app: {
				name: "Clinic intake",
				modules: [{ forms: [{ uuid: form_uuid, fields: 1 }] }],
			},
		});
		const deleted = JSON.parse(
			resultText(
				await client.callTool({
					name: "delete_app",
					arguments: { app_id: born.app_id },
				}),
			),
		);
		const row = await h.readAppRow(born.app_id);
		if (!(row?.recoverable_until instanceof Date))
			throw new Error("Deletion deadline was not persisted");
		expect(deleted).toEqual({
			stage: "app_deleted",
			app_id: born.app_id,
			deleted: true,
			recoverable_until: row.recoverable_until.toISOString(),
		});
		expect(
			await client.callTool({
				name: "get_app",
				arguments: { app_id: born.app_id },
			}),
		).toEqual(error("not_found", "App not found.", { app_id: born.app_id }));
		expect(
			JSON.parse(
				resultText(await client.callTool({ name: "list_apps", arguments: {} })),
			),
		).toEqual({ apps: [] });
		expect((await loadApp(born.app_id))?.blueprint).toEqual(born.blueprint);
	});
});
it("defaults to one personal Project, persists fallback names and gives each app a distinct run", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await withMcpClient(register, async (client) => {
		const apps: string[] = [];
		for (const arguments_ of [{}, { app_name: " \t " }]) {
			const born = JSON.parse(
				resultText(
					await client.callTool({ name: "create_app", arguments: arguments_ }),
				),
			) as Birth;
			expect(born.blueprint.appName).toBe("Untitled");
			apps.push(born.app_id);
		}
		expect(new Set(apps).size).toBe(2);
		const rows = await h
			.db()
			.selectFrom("apps")
			.select(["id", "project_id", "run_id", "status", "app_name"])
			.orderBy("id")
			.execute();
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((row) => row.run_id)).size).toBe(2);
		for (const row of rows) {
			expect(row).toMatchObject({
				run_id: expect.stringMatching(uuidV4),
				status: "complete",
				app_name: "Untitled",
			});
			expect(row.project_id).not.toBe(PROJECT);
		}
		const personal = await sql<{
			id: string;
			name: string;
		}>`SELECT id, name FROM auth_organization WHERE slug = ${`personal-${ACTOR}`}`.execute(
			h.db(),
		);
		expect(personal.rows).toEqual([
			{ id: rows[0].project_id, name: "Personal" },
		]);
		expect(rows[1].project_id).toBe(rows[0].project_id);
	});
});
it("refuses Project/viewer creation and foreign or underprivileged app reads/writes with exact envelopes", async () => {
	const own = await h.seedApp({ owner: "creator", project_id: PROJECT });
	const foreign = await h.seedApp({
		id: "foreign",
		owner: "outsider",
		project_id: "foreign-project",
	});
	await h.seedProjectMember(ACTOR, PROJECT, "viewer");
	const before = await h
		.db()
		.selectFrom("apps")
		.selectAll()
		.orderBy("id")
		.execute();
	await withMcpClient(register, async (client) => {
		expect(
			await client.callTool({
				name: "create_app",
				arguments: { project_id: PROJECT },
			}),
		).toEqual(
			error(
				"permission_denied",
				"Your role in this Project can't create apps. Ask a Project admin to make you an editor.",
				{ project_id: PROJECT },
			),
		);
		for (const project_id of ["foreign-project", "missing-project"]) {
			expect(
				await client.callTool({
					name: "create_app",
					arguments: { project_id },
				}),
			).toEqual(error("not_found", "Project not found.", { project_id }));
		}
		for (const app_id of [foreign, "missing-app"]) {
			for (const name of ["get_app", "delete_app"]) {
				expect(await client.callTool({ name, arguments: { app_id } })).toEqual(
					error("not_found", "App not found.", { app_id }),
				);
			}
		}
		expect(
			await client.callTool({ name: "delete_app", arguments: { app_id: own } }),
		).toEqual(error("not_found", "App not found.", { app_id: own }));
		expect(
			JSON.parse(
				resultText(
					await client.callTool({
						name: "get_app",
						arguments: { app_id: own },
					}),
				),
			),
		).toMatchObject({
			app: { appId: own, modules: [{ forms: [{ fields: 1 }] }] },
		});
	});
	expect(
		await h.db().selectFrom("apps").selectAll().orderBy("id").execute(),
	).toEqual(before);
	expect(await h.db().selectFrom("app_changes").selectAll().execute()).toEqual(
		[],
	);
});
it("surfaces a real genesis write failure and rolls back the root, entities, baseline and change", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await sql`CREATE FUNCTION reject_test_genesis() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private storage failure'; END $$`.execute(
		h.db(),
	);
	await sql`CREATE TRIGGER reject_test_genesis BEFORE INSERT ON blueprint_entities FOR EACH ROW EXECUTE FUNCTION reject_test_genesis()`.execute(
		h.db(),
	);
	await withMcpClient(register, async (client) => {
		expect(
			await client.callTool({
				name: "create_app",
				arguments: { project_id: PROJECT },
			}),
		).toEqual(
			error("internal", "Something went wrong during generation.", {
				project_id: PROJECT,
			}),
		);
		for (const table of [
			"apps",
			"blueprint_entities",
			"app_changes",
			"app_change_fold_baselines",
		] as const) {
			expect(await h.db().selectFrom(table).selectAll().execute()).toEqual([]);
		}
		await sql`DROP TRIGGER reject_test_genesis ON blueprint_entities`.execute(
			h.db(),
		);
		expect(
			JSON.parse(
				resultText(
					await client.callTool({
						name: "create_app",
						arguments: { project_id: PROJECT },
					}),
				),
			),
		).toMatchObject({ stage: "app_created", base_seq: 1 });
	});
});
