/** App move dispatch and refusal semantics over the actual tenancy transaction. */
import type { Client } from "@modelcontextprotocol/client";
import { Kysely, PostgresDialect, type PostgresPool, sql } from "kysely";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	claimAndReserveRun,
	commitAppProjectMoveInTransaction,
	loadApp,
} from "@/lib/db/apps";
import { getCurrentPeriod } from "@/lib/db/period";
import type { AppDatabase } from "@/lib/db/pg";
import { registerGetApp } from "../tools/getApp";
import { registerMoveApp } from "../tools/moveApp";
import { withMcpClient } from "./client";
import { resultText } from "./resultText";

const h = setupAppStateTestDb("mcp_move_", { authSchema: "migrated" });
const ACTOR = "mover",
	SOURCE = "source",
	DESTINATION = "destination";
function asUser<T>(
	userId: string,
	run: (client: Client) => Promise<T>,
	scopes = ["nova.read", "nova.write", "nova.projects.write"],
) {
	return withMcpClient((server) => {
		const context = { userId, scopes, authKind: "oauth" as const };
		registerMoveApp(server, context);
		registerGetApp(server, context);
	}, run);
}
async function seed(owner = ACTOR) {
	const app = await h.seedAppWithBlueprint(
		buildDoc({
			appName: "Clinic visits",
			caseTypes: [{ name: "household", properties: [] }],
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Intake",
							type: "survey",
							fields: [f({ id: "note", kind: "text" })],
						},
					],
				},
			],
		}),
		{ id: "moving-app", owner, projectId: SOURCE },
	);
	await h.seedProjectMember(ACTOR, DESTINATION, "admin");
	return app;
}
function request(app: string, to_project_id = DESTINATION) {
	return { name: "move_app", arguments: { app_id: app, to_project_id } };
}
function moved(app: string) {
	return {
		app_id: app,
		from_project_id: SOURCE,
		to_project_id: DESTINATION,
		result: "moved",
	};
}
function already(app: string, project_id: string) {
	return {
		app_id: app,
		project_id,
		result: "already_in_project",
		note: "The app is already in this Project, so nothing moved. Its case-data tenancy was verified and repaired where needed.",
	};
}
function error(
	error_type: string,
	message: string,
	app_id: string,
	project_id?: string,
) {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: JSON.stringify({
					error_type,
					message,
					app_id,
					...(project_id !== undefined && { project_id }),
				}),
			},
		],
	};
}
async function state(app: string) {
	return {
		app: await h.readAppRow(app),
		changes: await h
			.db()
			.selectFrom("app_changes")
			.selectAll()
			.where("app_id", "=", app)
			.orderBy("seq")
			.execute(),
		cases: (
			await h
				.pool()
				.query("SELECT * FROM cases WHERE app_id = $1 ORDER BY case_id", [app])
		).rows,
		presence: await h
			.db()
			.selectFrom("presence")
			.selectAll()
			.where("app_id", "=", app)
			.execute(),
		threads: await h
			.db()
			.selectFrom("threads")
			.selectAll()
			.where("app_id", "=", app)
			.execute(),
	};
}
async function relatedData(app: string) {
	await h
		.pool()
		.query(
			`INSERT INTO cases (case_id, app_id, project_id, case_type, case_name, owner_id, status, properties) VALUES ($1,$2,$3,'household','Ada household',$4,'open','{}'::jsonb)`,
			[crypto.randomUUID(), app, SOURCE, ACTOR],
		);
	await h
		.db()
		.insertInto("presence")
		.values({
			app_id: app,
			user_id: ACTOR,
			session_id: "session",
			name: "Mover",
			image: null,
			email: "mover@dimagi.com",
			color: "blue",
			location: JSON.stringify({ surface: "app" }),
			expire_at: new Date(Date.now() + 60_000),
		})
		.execute();
	await h
		.db()
		.insertInto("threads")
		.values({
			thread_id: "conversation",
			app_id: app,
			design_session_id: null,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			thread_type: "edit",
			summary: "Visit notes",
			run_id: "historical-run",
			active_stream_id: null,
			active_holder_nonce: null,
			messages: JSON.stringify([
				{
					id: "question",
					role: "user",
					parts: [{ type: "text", text: "Keep visit notes" }],
				},
			]),
		})
		.execute();
}

it("commits the new tenant with cases and one attributed change, preserves the conversation and changes who can read", async () => {
	const app = await seed();
	await relatedData(app);
	await h.seedProjectMember("source-reader", SOURCE, "viewer");
	await h.seedProjectMember("destination-reader", DESTINATION, "viewer");
	const before = await state(app),
		blueprint = (await loadApp(app))?.blueprint;
	await asUser(ACTOR, async (client) => {
		expect(
			JSON.parse(resultText(await client.callTool(request(app, SOURCE)))),
		).toEqual(already(app, SOURCE));
		expect(await state(app)).toEqual(before);
		expect(JSON.parse(resultText(await client.callTool(request(app))))).toEqual(
			moved(app),
		);
		const after = await state(app);
		expect(after.app).toMatchObject({
			project_id: DESTINATION,
			mutation_seq: "1",
			owner: ACTOR,
		});
		expect(after.cases).toEqual(
			before.cases.map((row) => ({ ...row, project_id: DESTINATION })),
		);
		expect(after.threads).toEqual(before.threads);
		expect(after.presence).toEqual([]);
		expect(
			after.changes.map(
				({
					seq,
					kind,
					actor_id,
					from_project_id,
					to_project_id,
					mutations,
				}) => ({
					seq,
					kind,
					actor_id,
					from_project_id,
					to_project_id,
					mutations,
				}),
			),
		).toEqual([
			{
				seq: "1",
				kind: "project-move",
				actor_id: ACTOR,
				from_project_id: SOURCE,
				to_project_id: DESTINATION,
				mutations: [],
			},
		]);
		expect((await loadApp(app))?.blueprint).toEqual(blueprint);
		expect(JSON.parse(resultText(await client.callTool(request(app))))).toEqual(
			already(app, DESTINATION),
		);
		expect(await state(app)).toEqual(after);
	});
	await asUser("source-reader", async (client) =>
		expect(
			await client.callTool({ name: "get_app", arguments: { app_id: app } }),
		).toEqual(error("not_found", "App not found.", app)),
	);
	await asUser("destination-reader", async (client) =>
		expect(
			JSON.parse(
				resultText(
					await client.callTool({
						name: "get_app",
						arguments: { app_id: app },
					}),
				),
			),
		).toMatchObject({ project: { id: DESTINATION, name: DESTINATION } }),
	);
});

it("rolls back tenant, cases, history and presence on a late history failure and succeeds on retry", async () => {
	const app = await seed();
	await relatedData(app);
	const before = await state(app);
	await h
		.pool()
		.query(
			`CREATE FUNCTION reject_move() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private late move diagnostic'; END $$; CREATE TRIGGER reject_move BEFORE INSERT ON app_changes FOR EACH ROW EXECUTE FUNCTION reject_move()`,
		);
	await asUser(ACTOR, async (client) => {
		expect(await client.callTool(request(app))).toEqual(
			error(
				"internal",
				"Something went wrong during generation.",
				app,
				DESTINATION,
			),
		);
		expect(await state(app)).toEqual(before);
		await h.pool().query("DROP TRIGGER reject_move ON app_changes");
		expect(JSON.parse(resultText(await client.callTool(request(app))))).toEqual(
			moved(app),
		);
	});
});

it("keeps source denials app-scoped, destination denials Project-scoped, and scopes ahead of both", async () => {
	const app = await seed();
	await h.seedProjectMember("reader", SOURCE, "viewer");
	await h.seedProjectMember("other", "foreign", "owner");
	await h.seedProjectMember(ACTOR, "low-role", "editor");
	const before = await state(app);
	await asUser("reader", async (client) => {
		for (const app_id of [app, "missing"])
			expect(await client.callTool(request(app_id))).toEqual(
				error("not_found", "App not found.", app_id),
			);
	});
	await asUser(ACTOR, async (client) => {
		for (const to of ["foreign", "missing"])
			expect(await client.callTool(request(app, to))).toEqual(
				error("not_found", "Project not found.", app, to),
			);
		expect(await client.callTool(request(app, "low-role"))).toEqual(
			error(
				"permission_denied",
				"Moving an app into a Project requires an admin or owner role there. Ask an admin or owner of the destination Project to grant you that role, or have them move the app.",
				app,
				"low-role",
			),
		);
	});
	await asUser(
		ACTOR,
		async (client) => {
			for (const app_id of [app, "missing"]) {
				const result = await client.callTool(request(app_id));
				expect(result.isError).toBe(true);
				const content = result.content[0];
				if (content.type !== "text") throw new Error("Expected text error");
				expect(JSON.parse(content.text)).toMatchObject({
					error_type: "scope_missing",
					app_id,
					required_scope: "nova.projects.write",
				});
				expect(JSON.parse(content.text)).not.toHaveProperty("project_id");
			}
		},
		["nova.read", "nova.write"],
	);
	expect(await state(app)).toEqual(before);
});

it("refuses an administrator's move until the source owner can retain access", async () => {
	const app = await seed("source-owner");
	await h.seedProjectMember(ACTOR, SOURCE, "admin");
	const before = await state(app);
	await asUser(ACTOR, async (client) => {
		expect(await client.callTool(request(app))).toEqual(
			error(
				"permission_denied",
				"This move would take the app away from the source Project's owner. Either an owner moves the app themselves, or every owner of the source Project must already be a member of the destination Project.",
				app,
				DESTINATION,
			),
		);
		expect(await state(app)).toEqual(before);
		await h.seedProjectMember("source-owner", DESTINATION, "viewer");
		expect(JSON.parse(resultText(await client.callTool(request(app))))).toEqual(
			moved(app),
		);
	});
});

it("refuses an active run, propagates a failed stale refund, then refunds exactly once before moving", async () => {
	const app = await seed(),
		period = getCurrentPeriod();
	await h.seedCreditMonth(ACTOR, period, {
		allowance: 100,
		consumed: 0,
		bonus: 0,
	});
	await claimAndReserveRun(app, "edit", "owned-run", ACTOR, 5, SOURCE);
	await asUser(ACTOR, async (client) => {
		const active = await state(app);
		expect(await client.callTool(request(app))).toEqual(
			error(
				"invalid_input",
				"This app is being generated right now. Try the move again once the run finishes.",
				app,
				DESTINATION,
			),
		);
		expect(await state(app)).toEqual(active);
		expect(
			JSON.parse(resultText(await client.callTool(request(app, SOURCE)))),
		).toEqual(already(app, SOURCE));
		expect(await state(app)).toEqual(active);
		await h
			.db()
			.updateTable("apps")
			.set({ lock_expire_at: new Date(Date.now() - 60_000) })
			.where("id", "=", app)
			.execute();
		const expired = await state(app);
		await h
			.pool()
			.query(
				`CREATE FUNCTION reject_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private credit diagnostic'; END $$; CREATE TRIGGER reject_refund BEFORE UPDATE ON credit_months FOR EACH ROW EXECUTE FUNCTION reject_refund()`,
			);
		expect(await client.callTool(request(app))).toEqual(
			error(
				"internal",
				"Something went wrong during generation.",
				app,
				DESTINATION,
			),
		);
		expect(await state(app)).toEqual(expired);
		expect(await h.readConsumed(ACTOR, period)).toBe(5);
		await h.pool().query("DROP TRIGGER reject_refund ON credit_months");
		expect(JSON.parse(resultText(await client.callTool(request(app))))).toEqual(
			moved(app),
		);
		expect(await h.readConsumed(ACTOR, period)).toBe(0);
		expect(await h.readRunLock(app)).toBeUndefined();
		expect(await h.readReservation(app)).toMatchObject({
			reserved: 5,
			settled: true,
		});
		expect(JSON.parse(resultText(await client.callTool(request(app))))).toEqual(
			already(app, DESTINATION),
		);
		expect(await h.readConsumed(ACTOR, period)).toBe(0);
	});
});

it("blocks captured submissions without writes while retaining same-Project recovery", async () => {
	const app = await seed();
	await h
		.db()
		.insertInto("form_submission_intents")
		.values({
			app_id: app,
			project_id: SOURCE,
			created_by: ACTOR,
			entry_key: crypto.randomUUID(),
			form_uuid: testUuid("form"),
			app_mutation_seq: 0,
			request_digest: "digest",
			result: null,
		})
		.execute();
	const before = await state(app);
	await asUser(ACTOR, async (client) => {
		expect(await client.callTool(request(app))).toEqual(
			error(
				"invalid_input",
				"This app has captured form submissions and cannot move Projects yet. Keep it in its current Project.",
				app,
				DESTINATION,
			),
		);
		expect(
			JSON.parse(resultText(await client.callTool(request(app, SOURCE)))),
		).toEqual(already(app, SOURCE));
		expect(await state(app)).toEqual(before);
	});
});

it.each([SOURCE, DESTINATION])(
	"reports the committed outcome when a concurrent move wins a request targeting %s",
	async (requestedProject) => {
		const app = await seed();
		const writer = new Kysely<AppDatabase>({
			dialect: new PostgresDialect({
				pool: new Pool({
					connectionString: h.uri(),
					max: 1,
				}) as unknown as PostgresPool,
			}),
		});
		await asUser(ACTOR, async (client) => {
			let pending:
				| Promise<
						| { ok: true; value: Awaited<ReturnType<Client["callTool"]>> }
						| { ok: false; error: unknown }
				  >
				| undefined;
			try {
				await writer.transaction().execute(async (tx) => {
					expect(
						await commitAppProjectMoveInTransaction(
							tx,
							{
								appId: app,
								expectedFromProjectId: SOURCE,
								toProjectId: DESTINATION,
								actorUserId: ACTOR,
								assetIdMap: new Map(),
							},
							{ batchId: crypto.randomUUID() },
						),
					).toEqual({ kind: "moved" });
					// Preflight sees the committed source; the repair queues behind this real,
					// still-uncommitted move. Observe the database wait before letting it commit.
					pending = client.callTool(request(app, requestedProject)).then(
						(value) => ({ ok: true as const, value }),
						(error: unknown) => ({ ok: false as const, error }),
					);
					const deadline = Date.now() + 1000;
					for (;;) {
						const blocked = await sql<{
							count: number;
						}>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`.execute(
							tx,
						);
						if (blocked.rows[0].count > 0) break;
						if (Date.now() > deadline)
							throw new Error(
								"Recovery never waited behind the concurrent move",
							);
						await new Promise<void>((resolve) => setImmediate(resolve));
					}
				});
				if (pending === undefined) throw new Error("Recovery was not started");
				const outcome = await pending;
				if (!outcome.ok) throw outcome.error;
				expect(JSON.parse(resultText(outcome.value))).toEqual(
					already(app, DESTINATION),
				);
				expect((await h.readAppRow(app))?.project_id).toBe(DESTINATION);
				expect(
					await h
						.db()
						.selectFrom("app_changes")
						.select("seq")
						.where("app_id", "=", app)
						.execute(),
				).toEqual([{ seq: "1" }]);
			} finally {
				if (pending !== undefined) await pending;
				await writer.destroy();
			}
		});
	},
);
