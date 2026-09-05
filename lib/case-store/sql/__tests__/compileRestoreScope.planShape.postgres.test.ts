// lib/case-store/sql/__tests__/compileRestoreScope.planShape.postgres.test.ts
//
// The closure's PLAN, not its latency. A latency budget on a laptop is noise;
// the plan shape is the thing that silently regresses, and each assertion here
// stands for a measured cliff on a 50k-case / 60k-edge tenant:
//
// | shape                                   | at |live| = 54 |
// | --------------------------------------- | -------------- |
// | correlated `Aggregate` extension probe   |         28 ms  |
// | the same rule as two plain `EXISTS`      |        210 ms  |
//
// Written the obvious way — two `EXISTS` probes, one per relationship —
// Postgres lifts each into a hashed semi-join and scans the WHOLE tenant's
// `case_indices` joined to the whole tenant's `cases`, twice, however small
// the restore is. A subquery carrying an aggregate cannot be pulled up, so
// `compileRestoreScope` writes the rule as `bool_and` and the probe stays
// correlated. Nothing else in the file explains why that shape was chosen,
// and nothing else would notice it being "simplified" back.

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { beforeEach, expect, it } from "vitest";
import { buildRestoreScope } from "../compileRestoreScope";
import type { Database } from "../database";
import { setupPerTestDatabase } from "./perTestDatabase";

const handle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "restore_plan",
});
let db: Kysely<Database>;

beforeEach(async () => {
	db = new Kysely<Database>({
		dialect: new PostgresDialect({
			pool: handle.pool as unknown as PostgresPool,
		}),
	});
	return async () => {
		await db.destroy();
	};
});

const APP = "app-plan-shape";
const PROJECT = "project-plan-shape";
const CASES = 50_000;
const HOUSEHOLDS = 10_000;
/** Ten case-sharing groups — a worker assigned across a handful of places. */
const OWNER_IDS = Array.from({ length: 10 }, (_, i) => `owner${i + 1}`);

/**
 * A tenant shaped like a real one: bounded households of roughly four members,
 * plus a one-in-eight extension layer. Bounded components are what make the
 * restore's size independent of the tenant's, which is the property the plan
 * shape has to preserve.
 */
async function seedTenant(): Promise<void> {
	const { pool } = handle;
	await pool.query(
		`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		 VALUES ($1, $2, $2, $1, lower($1))`,
		[APP, PROJECT],
	);
	await pool.query(
		`INSERT INTO cases (case_id, app_id, project_id, case_type, owner_id, status, case_name, properties)
		 SELECT 'h'||i, $1, $2, 'household', 'owner'||i,
		        CASE WHEN i % 11 = 0 THEN 'closed' ELSE 'open' END,
		        'household '||i, '{}'::jsonb
		 FROM generate_series(1, ${HOUSEHOLDS}) i`,
		[APP, PROJECT],
	);
	await pool.query(
		`INSERT INTO cases (case_id, app_id, project_id, case_type, owner_id, status, case_name, properties)
		 SELECT 'p'||i, $1, $2, 'patient', 'owner'||(1 + (i % ${HOUSEHOLDS})),
		        CASE WHEN i % 13 = 0 THEN 'closed' ELSE 'open' END,
		        'patient '||i, '{}'::jsonb
		 FROM generate_series(1, ${CASES - HOUSEHOLDS}) i`,
		[APP, PROJECT],
	);
	await pool.query(
		`INSERT INTO case_indices (case_id, ancestor_id, target_case_type, identifier, relationship, depth)
		 SELECT 'p'||i, 'h'||(1 + (i % ${HOUSEHOLDS})), 'household', 'parent', 'child', 1
		 FROM generate_series(1, ${CASES - HOUSEHOLDS}) i`,
	);
	await pool.query(
		`INSERT INTO case_indices (case_id, ancestor_id, target_case_type, identifier, relationship, depth)
		 SELECT 'p'||i, 'p'||(i - 1), 'patient', 'host', 'extension', 1
		 FROM generate_series(2, ${CASES - HOUSEHOLDS}) i WHERE i % 8 = 0`,
	);
	await pool.query("ANALYZE cases");
	await pool.query("ANALYZE case_indices");
}

it("keeps the closure proportional to the restore, not to the tenant", async () => {
	await seedTenant();

	const { creator, restrict } = buildRestoreScope(db, {
		appId: APP,
		projectId: PROJECT,
		ownerIds: OWNER_IDS,
	});
	const compiled = restrict(
		creator
			.selectFrom("cases as c")
			.selectAll("c")
			.where("c.app_id", "=", APP)
			.where("c.project_id", "=", PROJECT)
			.where("c.case_type", "=", "patient"),
		"c",
	)
		.orderBy("c.opened_on")
		.limit(50)
		.compile();

	const explained = await handle.pool.query(
		`EXPLAIN (ANALYZE) ${compiled.sql}`,
		[...compiled.parameters],
	);
	const plan = explained.rows
		.map((row: Record<string, string>) => row["QUERY PLAN"])
		.join("\n");

	// The extension probe stays correlated. `hashed SubPlan` is the exact text
	// Postgres prints when it lifts the probe into a whole-tenant semi-join.
	expect(plan).not.toMatch(/hashed SubPlan/);
	expect(plan).toMatch(/SubPlan/);

	// Propagation reaches `case_indices` through a bitmap OR of the two
	// existing `(case_id, identifier)` / `(ancestor_id, identifier)` indexes,
	// driven by the recursion's own worktable. Both halves matter: without the
	// BitmapOr the walk scans the edge table, and without the WorkTable driving
	// it the planner has picked the tenant as the outer relation.
	expect(plan).toMatch(/BitmapOr/);
	expect(plan).toMatch(/WorkTable Scan/);

	// The extension probe's far side — the join that proves the edge belongs to
	// this tenant — must never become a whole-tenant scan. This is the
	// expensive half of the hashed shape, pinned directly rather than only
	// implied by the assertion above.
	expect(plan).not.toMatch(/Seq Scan on cases probe_far/);

	// One tenant-proportional read survives, deliberately: the `avail` walk
	// hash-joins the tenant's extension edges (5,000 rows / ~7 ms here) rather
	// than probing them per available case. A `case_indices (case_id,
	// relationship)` index does NOT change that — the planner still costs the
	// hash lower, measured — so the index is not carried. The `cases` seed scan
	// is likewise sequential, because `cases` deliberately carries no
	// `(app_id, project_id, owner_id)` index; adding one is a decision about
	// every owner-filtered read, not about this closure.
}, 300_000);
