/**
 * The `publish-placement` app change kind, admitted by the database. The
 * plausible failures: the new kind admitted with something other than
 * placement holds in it, or with a run; an earlier kind's admission changed
 * by the replacement; and a migration or a reader that resolves the
 * admission function by its name alone, so a same-named object elsewhere,
 * met first by a catalog scan or first on the search path, is the one it
 * changes or reads.
 */

import { type Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";
import {
	down,
	up,
} from "../20261110000000_hq_round_trip_case_writes_publish_placement";

const MIGRATION = "20261110000000_hq_round_trip_case_writes_publish_placement";
const FUNCTION = "public.nova_admit_app_change_insert()";
const DECOY_SCHEMA = "nova_app_test_decoy";
const DECOY_FUNCTION = `${DECOY_SCHEMA}.nova_admit_app_change_insert()`;

/* Every migration before this one: the admission function as the canonical
 * identity foundation wrote it. */
const database = setupPerTestDatabase({
	databaseNamePrefix: "publish_placement_kind_",
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

const APP = "publish-placement-app";
const PROJECT = "publish-placement-project";

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
		VALUES (${APP}, 'owner', ${PROJECT}, 'Published app', 'published app',
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
				VALUES (${APP}, 1, 'batch-1', 'owner', ${row.runId ?? null}, ${row.kind},
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

const EARLIER_KINDS: readonly ChangeRow[] = [
	{ kind: "autosave", mutations: [{ kind: "setAppName", name: "Edited" }] },
	{
		kind: "mcp",
		runId: "run-1",
		mutations: [{ kind: "setAppName", name: "Edited" }],
	},
	{
		kind: "chat",
		runId: "run-1",
		mutations: [{ kind: "setAppName", name: "Edited" }],
	},
	{
		kind: "blueprint-migration",
		mutations: [HOLDS, { kind: "setAppName", name: "Edited" }],
	},
	{ kind: "fold-baseline", mutations: [] },
	{
		kind: "project-move",
		mutations: [],
		fromProjectId: PROJECT,
		toProjectId: "another-project",
	},
];

async function earlierKindVerdicts(db: Kysely<unknown>) {
	const verdicts: { kind: string; verdict: string }[] = [];
	for (const row of EARLIER_KINDS) {
		verdicts.push({ kind: row.kind, verdict: await admission(db, row) });
	}
	return verdicts;
}

/** The schema of every function named like the admission function, in the
 *  order a sequential scan of `pg_proc` meets them. */
async function byNameScanOrder(db: Kysely<unknown>): Promise<string[]> {
	const rows = await sql<{ schema_name: string }>`
		SELECT pronamespace::regnamespace::text AS schema_name
		FROM pg_catalog.pg_proc
		WHERE proname = 'nova_admit_app_change_insert'
	`.execute(db);
	return rows.rows.map((row) => row.schema_name);
}

async function functionDefinition(
	db: Kysely<unknown>,
	signature: string,
): Promise<{ oid: number; definition: string }> {
	const rows = await sql<{ oid: number; definition: string }>`
		SELECT ${signature}::regprocedure::oid::int8 AS oid,
			pg_catalog.pg_get_functiondef(${signature}::regprocedure) AS definition
	`.execute(db);
	const [row] = rows.rows;
	return { oid: Number(row.oid), definition: row.definition };
}

async function admissionTriggerFunction(db: Kysely<unknown>): Promise<number> {
	const rows = await sql<{ oid: number }>`
		SELECT tgfoid::int8 AS oid
		FROM pg_catalog.pg_trigger
		WHERE tgrelid = 'public.app_changes'::regclass
			AND tgname = 'app_changes_admit_insert'
	`.execute(db);
	return Number(rows.rows[0].oid);
}

async function decoyState(db: Kysely<unknown>) {
	const fn = await functionDefinition(db, DECOY_FUNCTION);
	const table = await sql<{ rows: string }>`
		SELECT COALESCE(jsonb_agg(to_jsonb(decoy) ORDER BY decoy.seq)::text, '[]') AS rows
		FROM nova_app_test_decoy.app_changes AS decoy
	`.execute(db);
	const columns = await sql<{ columns: string }>`
		SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ','
			ORDER BY attnum) AS columns
		FROM pg_catalog.pg_attribute
		WHERE attrelid = 'nova_app_test_decoy.app_changes'::regclass
			AND attnum > 0 AND NOT attisdropped
	`.execute(db);
	return {
		function: fn,
		rows: table.rows[0].rows,
		columns: columns.rows[0].columns,
	};
}

/**
 * A decoy schema holding a same-named admission function and `app_changes`
 * table, first on the session's search path, and first in `pg_proc`'s heap,
 * so a by-name catalog scan meets the decoy before the real function.
 */
async function installDecoy(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE SCHEMA nova_app_test_decoy`.execute(db);
	await sql`
		CREATE FUNCTION nova_app_test_decoy.nova_admit_app_change_insert()
		RETURNS trigger
		LANGUAGE plpgsql
		SET search_path = pg_catalog
		AS $function$
		BEGIN
			RETURN NEW;
		END
		$function$
	`.execute(db);
	await sql`
		CREATE TABLE nova_app_test_decoy.app_changes
			(LIKE public.app_changes INCLUDING DEFAULTS)
	`.execute(db);
	await sql`
		INSERT INTO nova_app_test_decoy.app_changes
			(app_id, seq, batch_id, actor_id, kind, mutations)
		VALUES (${APP}, 1, 'decoy', 'system:decoy', 'autosave', '[]'::jsonb)
	`.execute(db);
	await sql`
		CREATE TRIGGER app_changes_admit_insert
			BEFORE INSERT ON nova_app_test_decoy.app_changes
			FOR EACH ROW
			EXECUTE FUNCTION nova_app_test_decoy.nova_admit_app_change_insert()
	`.execute(db);
	// The rewrite packs the heap, so the next version of a tuple lands after
	// every tuple it holds. Rewriting the public function's catalog tuple with
	// its own setting then puts its live version after the decoy's.
	await sql`VACUUM FULL pg_catalog.pg_proc`.execute(db);
	await sql`
		ALTER FUNCTION public.nova_admit_app_change_insert()
			SET search_path = pg_catalog
	`.execute(db);
	await sql`SET enable_indexscan = off`.execute(db);
	await sql`SET enable_indexonlyscan = off`.execute(db);
	await sql`SET enable_bitmapscan = off`.execute(db);
	await sql`SET search_path = nova_app_test_decoy, public`.execute(db);
}

/** The harness's precondition, which no assertion below may assume. */
async function assertDecoyMetFirst(db: Kysely<unknown>): Promise<void> {
	const order = await byNameScanOrder(db);
	if (order.length !== 2 || order[0] !== DECOY_SCHEMA) {
		throw new Error(
			`Harness defect: a by-name scan of pg_proc must meet the decoy before the public function, and it met ${JSON.stringify(order)}. Change the decoy's seeding order until it does.`,
		);
	}
}

describe(MIGRATION, () => {
	it("admits a publish-placement row that holds only placement holds and no run", async () => {
		const db = database.db;
		await seedApp(db);
		const publish = { kind: "publish-placement", mutations: [HOLDS] };
		const before = await earlierKindVerdicts(db);
		expect(await admission(db, publish)).toBe(
			"app_changes insert has an unsupported kind",
		);

		await up(db);

		const holdsOnly =
			"publish-placement app changes hold only placement holds and no run";
		expect(await admission(db, publish)).toBe("admitted");
		expect(
			await admission(db, {
				kind: "publish-placement",
				mutations: [HOLDS, HOLDS],
			}),
		).toBe("admitted");
		expect(
			await admission(db, { kind: "publish-placement", mutations: [] }),
		).toBe("non-move non-baseline app changes must contain mutations");
		expect(
			await admission(db, {
				kind: "publish-placement",
				mutations: [HOLDS, { kind: "setAppName", name: "Edited" }],
			}),
		).toBe(holdsOnly);
		expect(
			await admission(db, {
				kind: "publish-placement",
				mutations: [HOLDS, "holdPlacements"],
			}),
		).toBe(holdsOnly);
		expect(
			await admission(db, { kind: "publish-placement", mutations: HOLDS }),
		).toBe(holdsOnly);
		expect(
			await admission(db, {
				kind: "publish-placement",
				runId: "run-1",
				mutations: [HOLDS],
			}),
		).toBe(holdsOnly);
		expect(
			await admission(db, { kind: "placement-publish", mutations: [HOLDS] }),
		).toBe("app_changes insert has an unsupported kind");

		const after = await earlierKindVerdicts(db);
		expect(after).toEqual(before);
		expect(after.map(({ verdict }) => verdict)).toEqual(
			EARLIER_KINDS.map(() => "admitted"),
		);
	});

	it("replaces the public function in place and leaves a same-named decoy untouched", async () => {
		const db = database.db;
		await seedApp(db);
		await installDecoy(db);
		await assertDecoyMetFirst(db);
		const decoyBefore = await decoyState(db);
		const publicBefore = await functionDefinition(db, FUNCTION);
		const triggerBefore = await admissionTriggerFunction(db);
		expect(triggerBefore).toBe(publicBefore.oid);
		expect(publicBefore.definition).not.toContain("publish-placement");

		await up(db);

		await assertDecoyMetFirst(db);
		const publicAfter = await functionDefinition(db, FUNCTION);
		expect(publicAfter.oid).toBe(publicBefore.oid);
		expect(publicAfter.definition).toContain("'publish-placement'");
		expect(await admissionTriggerFunction(db)).toBe(publicBefore.oid);
		expect(await decoyState(db)).toEqual(decoyBefore);
		expect(
			await admission(db, { kind: "publish-placement", mutations: [HOLDS] }),
		).toBe("admitted");
	});

	it("refuses to run down, since that would refuse placements already recorded", async () => {
		await expect(down()).rejects.toThrow(/forward-only/);
	});
});
