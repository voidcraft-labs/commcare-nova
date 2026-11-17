/**
 * The `hq-changes` app change kind, admitted by the database. The plausible
 * failures: the new kind admitted with a run or with no mutations; an
 * earlier kind's admission changed by the replacement, so a row the serving
 * revision writes during the deploy is refused; a replacement that does not
 * replay over its own result; and one that takes a lock on a table the
 * serving revision reads or writes, which would stall it while the migrate
 * Job runs.
 */

import { type Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";
import { down, up } from "../20261201010000_hq_changes_app_change_kind";

const MIGRATION = "20261201010000_hq_changes_app_change_kind";
const FUNCTION = "public.nova_admit_app_change_insert()";

/* Every migration before this one: the admission function as the publish
 * placement migration wrote it. */
const database = setupPerTestDatabase({
	databaseNamePrefix: "hq_changes_kind_",
	prepareTemplate: async (db) => {
		const result = await new Migrator({
			db,
			provider: {
				getMigrations: async () =>
					Object.fromEntries(
						Object.entries(caseStoreMigrations).filter(
							([name]) => name < MIGRATION,
						),
					),
			},
		}).migrateToLatest();
		if (result.error !== undefined) throw result.error;
	},
});

const APP = "hq-changes-app";
const PROJECT = "hq-changes-project";

const RENAME = { kind: "setAppName", name: "Edited" };
const HOLDS = {
	kind: "holdPlacements",
	holds: [
		{
			target: "query-repeat",
			fieldUuid: "01992000-0000-7000-8000-000000000031",
			placement: "count",
		},
	],
};

async function seedApp(db: Kysely<unknown>): Promise<void> {
	await sql`INSERT INTO public.apps (id, owner, project_id, app_name, app_name_lower,
		module_count, form_count, mutation_seq, status, awaiting_input)
		VALUES (${APP}, 'owner', ${PROJECT}, 'Brought in', 'brought in',
		0, 0, 0, 'complete', false)`.execute(db);
}

interface ChangeRow {
	readonly kind: string;
	readonly mutations: unknown;
	readonly runId?: string;
	readonly fromProjectId?: string;
	readonly toProjectId?: string;
}

class RolledBack extends Error {}

/**
 * What the admission trigger says of one row: `"admitted"`, or the message
 * it raised. The insert runs in a transaction that is always rolled back, so
 * the deferred checks a commit would run never fire, and no row stays.
 */
async function admission(db: Kysely<unknown>, row: ChangeRow): Promise<string> {
	try {
		await db.transaction().execute(async (tx) => {
			await sql`INSERT INTO public.app_changes
				(app_id, seq, batch_id, actor_id, run_id, kind, mutations,
				 from_project_id, to_project_id)
				VALUES (${APP}, 1, 'batch-1', 'member-1', ${row.runId ?? null}, ${row.kind},
				 ${JSON.stringify(row.mutations)}::jsonb,
				 ${row.fromProjectId ?? null}, ${row.toProjectId ?? null})`.execute(tx);
			throw new RolledBack();
		});
	} catch (error) {
		if (error instanceof RolledBack) return "admitted";
		if (error instanceof Error) return error.message;
		throw error;
	}
	throw new Error("The admission probe's transaction committed.");
}

/** Every row the revision before this one writes or refuses, with what it
 *  answered there: the replacement must answer each the same. */
const EARLIER_ROWS: readonly ChangeRow[] = [
	{ kind: "autosave", mutations: [RENAME] },
	{ kind: "autosave", mutations: [] },
	{ kind: "mcp", runId: "run-1", mutations: [RENAME] },
	{ kind: "chat", runId: "run-1", mutations: [RENAME] },
	{ kind: "chat", runId: " ", mutations: [RENAME] },
	{ kind: "publish-placement", mutations: [HOLDS] },
	{ kind: "publish-placement", mutations: [HOLDS, RENAME] },
	{ kind: "publish-placement", runId: "run-1", mutations: [HOLDS] },
	{ kind: "blueprint-migration", mutations: [HOLDS, RENAME] },
	{ kind: "fold-baseline", mutations: [] },
	{ kind: "fold-baseline", mutations: [RENAME] },
	{
		kind: "project-move",
		mutations: [],
		fromProjectId: PROJECT,
		toProjectId: "another-project",
	},
	{
		kind: "project-move",
		mutations: [],
		fromProjectId: "not-the-app-project",
		toProjectId: "another-project",
	},
	{ kind: "placement-publish", mutations: [HOLDS] },
];

async function verdicts(db: Kysely<unknown>, rows: readonly ChangeRow[]) {
	const answered: { row: ChangeRow; verdict: string }[] = [];
	for (const row of rows) {
		answered.push({ row, verdict: await admission(db, row) });
	}
	return answered;
}

async function functionState(db: Kysely<unknown>) {
	const rows = await sql<{ oid: string; definition: string; trigger: string }>`
		SELECT ${FUNCTION}::regprocedure::oid::int8::text AS oid,
			pg_catalog.pg_get_functiondef(${FUNCTION}::regprocedure) AS definition,
			(SELECT tgfoid::int8::text FROM pg_catalog.pg_trigger
				WHERE tgrelid = 'public.app_changes'::regclass
					AND tgname = 'app_changes_admit_insert') AS trigger
	`.execute(db);
	return rows.rows[0];
}

describe(MIGRATION, () => {
	it("admits hq-changes with a batch and no run, refuses it empty or with a run, and answers every earlier row as before", async () => {
		const db = database.db;
		await seedApp(db);
		const before = await verdicts(db, EARLIER_ROWS);
		expect(
			await admission(db, { kind: "hq-changes", mutations: [RENAME] }),
		).toBe("app_changes insert has an unsupported kind");

		await up(db);

		expect(
			await admission(db, { kind: "hq-changes", mutations: [RENAME, HOLDS] }),
		).toBe("admitted");
		expect(await admission(db, { kind: "hq-changes", mutations: [] })).toBe(
			"non-move non-baseline app changes must contain mutations",
		);
		expect(
			await admission(db, {
				kind: "hq-changes",
				runId: "run-1",
				mutations: [RENAME],
			}),
		).toBe("hq-changes app changes carry no run");

		expect(await verdicts(db, EARLIER_ROWS)).toEqual(before);
		expect(before.map(({ verdict }) => verdict)).toEqual([
			"admitted",
			"non-move non-baseline app changes must contain mutations",
			"admitted",
			"admitted",
			"app_changes insert has a blank envelope identity",
			"admitted",
			"publish-placement app changes hold only placement holds and no run",
			"publish-placement app changes hold only placement holds and no run",
			"admitted",
			"admitted",
			"fold-baseline app changes must be empty",
			"admitted",
			"project-move app change does not start at the locked app Project/head",
			"app_changes insert has an unsupported kind",
		]);
	});

	it("replaces the function in place, replays over its own result, and locks no table the serving revision uses", async () => {
		const db = database.db;
		await seedApp(db);
		const prefix = await functionState(db);
		expect(prefix.trigger).toBe(prefix.oid);
		expect(prefix.definition).not.toContain("hq-changes");

		const heldLocks = await db.transaction().execute(async (tx) => {
			await up(tx);
			const locks = await sql<{ relation: string; mode: string }>`
				SELECT lock.relation::regclass::text AS relation, lock.mode
				FROM pg_catalog.pg_locks AS lock
				JOIN pg_catalog.pg_class AS class ON class.oid = lock.relation
				WHERE lock.pid = pg_catalog.pg_backend_pid()
					AND lock.locktype = 'relation'
					AND class.relnamespace NOT IN
						('pg_catalog'::regnamespace, 'pg_toast'::regnamespace)
				ORDER BY 1, 2
			`.execute(tx);
			return locks.rows;
		});
		expect(heldLocks).toEqual([]);

		const once = await functionState(db);
		expect(once.oid).toBe(prefix.oid);
		expect(once.trigger).toBe(prefix.oid);
		expect(once.definition).toContain("'hq-changes'");

		await up(db);
		expect(await functionState(db)).toEqual(once);
		expect(
			await admission(db, { kind: "hq-changes", mutations: [RENAME] }),
		).toBe("admitted");
	});

	it("refuses to run down, since that would refuse changes already brought in", async () => {
		await expect(down()).rejects.toThrow(/forward-only/);
	});
});
