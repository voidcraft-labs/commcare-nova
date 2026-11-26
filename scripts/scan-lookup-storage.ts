/** Aggregate-only, read-only. Before the schema change this reports the lower
 * bound on existing ordinary SQL and any Project needing a larger quota. The
 * post-migration pass reconciles the actual persisted budget and every stored
 * object and row in the Project, with no customer row contents in its output. */
import "./lib/loadEnv";
import { Command } from "commander";
import { sql } from "kysely";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const relations = [
	"lookup_tables",
	"lookup_columns",
	"lookup_rows",
	"lookup_members",
	"lookup_project_edit_receipts",
	"lookup_authoring_receipts",
	"lookup_member_references",
	"lookup_table_references",
	"lookup_column_references",
	"lookup_generations",
	"lookup_generation_pages",
	"lookup_generation_rows",
	"lookup_generation_chunks",
	"lookup_generation_blobs",
	"lookup_bulk_reservations",
	"export_artifacts",
	"export_artifact_parts",
	"lookup_cell_values",
	"lookup_cell_value_refs",
	"lookup_cell_blobs",
	"lookup_cell_segments",
	"lookup_cell_edits",
	"lookup_cell_inputs",
];
const byteRelations = new Set([
	"lookup_generation_blobs",
	"lookup_cell_blobs",
	"lookup_cell_inputs",
]);
const cli = new Command()
	.option("--prod", "read production through the operator IAM connection")
	.parse();
if (cli.opts().prod) targetProdDb();

async function main() {
	try {
		const db = await getAppDb();
		const report = await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute(async (tx) => {
				const catalog = await sql<{
					name: string;
				}>`SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
				WHERE n.nspname='public' AND c.relname=ANY(${[...relations, "lookup_storage_budgets"]}::text[])`.execute(
					tx,
				);
				const present = new Set(catalog.rows.map((r) => r.name));
				const parts = relations
					.filter((r) => present.has(r))
					.map(
						(r) => sql`SELECT project_id,sum(512::bigint +
				${byteRelations.has(r) ? sql`octet_length(project_id)+octet_length(body)` : sql`octet_length((to_jsonb(t)-'external_bytes')::text)`}
				${r === "lookup_bulk_reservations" ? sql`+bytes` : sql``}) AS bytes FROM ${sql.table(r)} t GROUP BY project_id`,
					);
				if (!parts.length) throw new Error("Lookup storage schema is absent.");
				const migrated = present.has("lookup_storage_budgets");
				const budget = migrated
					? sql`SELECT project_id,capacity_bytes,used_bytes FROM lookup_storage_budgets`
					: sql`SELECT NULL::text AS project_id,0::bigint AS capacity_bytes,0::bigint AS used_bytes WHERE false`;
				const result = await sql<{
					project_count: number;
					measured_bytes: string;
					over_capacity: number;
					mismatched: number;
				}>`WITH measured AS
				(SELECT project_id,sum(bytes) AS bytes FROM (${sql.join(parts, sql` UNION ALL `)}) all_payloads GROUP BY project_id),
				budget AS (${budget})
				SELECT count(*)::integer AS project_count,coalesce(sum(m.bytes),0)::text AS measured_bytes,
					count(*) FILTER(WHERE coalesce(m.bytes,0)>coalesce(b.capacity_bytes,34359738368))::integer AS over_capacity,
					count(*) FILTER(WHERE ${migrated} AND coalesce(m.bytes,0)<>coalesce(b.used_bytes,0))::integer AS mismatched
				FROM measured m FULL JOIN budget b USING(project_id)`.execute(tx);
				return {
					mode: migrated ? "reconcile" : "before-migration",
					...result.rows[0],
				};
			});
		console.log(JSON.stringify(report));
		if (report.over_capacity || report.mismatched) process.exitCode = 1;
	} finally {
		await closeCaseStoreDatabase();
	}
}
runMain(main);
