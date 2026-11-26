/** Read-only pre/post-cutover inventory. Historical receipts contain a
 * post-submission observation. They cannot establish continuous link history
 * through a case reset, a workspace edit or a reused caller-supplied ID. */
import "./lib/loadEnv";
import { Command } from "commander";
import { sql } from "kysely";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "@/lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const options = new Command()
	.description(
		"Count saved links and available link history by app and Project.",
	)
	.option("--prod", "read production as the operator")
	.parse()
	.opts<{ prod?: boolean }>();
if (options.prod) targetProdDb();
runMain(async () => {
	try {
		const db = await getCaseStoreDatabase();
		await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute(async (tx) => {
				const shape = await sql<{
					columns: number;
				}>`SELECT count(*)::int AS columns FROM pg_attribute
				WHERE attrelid = 'cases'::regclass AND attname IN ('index_history_complete', 'cleared_index_identifiers')
				AND NOT attisdropped`.execute(tx);
				const columns = shape.rows[0]?.columns;
				if (columns !== 0 && columns !== 2)
					throw new Error("The case index history schema is incomplete.");
				const coverage =
					columns === 2
						? sql`count(*) FILTER (WHERE c.index_history_complete)::int`
						: sql`0::int`;
				const markers =
					columns === 2
						? sql`sum(cardinality(c.cleared_index_identifiers))::int`
						: sql`0::int`;
				const observed = await sql`WITH populations AS (
				SELECT c.app_id, c.project_id, count(*)::int AS cases, ${coverage} AS tracked,
					${markers} AS known_clears
				FROM cases c GROUP BY c.app_id, c.project_id
			), edges AS (
				SELECT c.app_id, c.project_id, count(*)::int AS live_edges,
					count(*) FILTER (WHERE target.app_id IS DISTINCT FROM c.app_id
						OR target.project_id IS DISTINCT FROM c.project_id)::int AS unavailable_targets
				FROM case_indices i JOIN cases c ON c.case_id=i.case_id
				LEFT JOIN cases target ON target.case_id=i.ancestor_id
				WHERE i.depth=1 GROUP BY c.app_id,c.project_id
			), receipts AS (
				SELECT f.app_id, f.project_id, count(*)::int AS receipts,
					count(*) FILTER (WHERE f.result ? 'caseDatabasePatch')::int AS observed_patches,
					sum(CASE WHEN jsonb_typeof(f.result->'caseDatabasePatch'->'indices')='array'
						THEN jsonb_array_length(f.result->'caseDatabasePatch'->'indices') ELSE 0 END)::int AS observed_edges
				FROM form_submission_intents f WHERE f.result IS NOT NULL GROUP BY f.app_id,f.project_id
			), scopes AS (
				SELECT app_id, project_id FROM populations UNION SELECT app_id, project_id FROM receipts
			)
			SELECT s.app_id, s.project_id, a.project_id IS NOT DISTINCT FROM s.project_id AS current_project,
				coalesce(p.cases,0) AS cases, coalesce(p.tracked,0) AS tracked_from_creation, coalesce(p.known_clears,0) AS known_clears,
				coalesce(e.live_edges,0) AS live_edges, coalesce(e.unavailable_targets,0) AS unavailable_targets,
				coalesce(r.receipts,0) AS completed_receipts, coalesce(r.observed_patches,0) AS observed_patches,
				coalesce(r.observed_edges,0) AS observed_edges
			FROM scopes s LEFT JOIN populations p USING(app_id,project_id)
			LEFT JOIN edges e USING(app_id,project_id) LEFT JOIN receipts r USING(app_id,project_id)
			LEFT JOIN apps a ON a.id=s.app_id ORDER BY s.app_id,s.project_id`.execute(
					tx,
				);
				console.log(
					JSON.stringify({
						historyInstalled: columns === 2,
						scopes: observed.rows,
					}),
				);
			});
	} finally {
		await closeCaseStoreDatabase();
	}
});
