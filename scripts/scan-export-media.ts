/** Aggregate-only export metadata inventory. No file URLs, asset ids, Project
 * names, GCS object contents or credentials enter the result. */
import "./lib/loadEnv";
import { Command } from "commander";
import { sql } from "kysely";
import { getAppDb } from "@/lib/db/pg";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const cli = new Command()
	.option("--prod", "read production using operator IAM")
	.parse();
if (cli.opts().prod) targetProdDb();
async function main() {
	try {
		const record = await (await getAppDb())
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute(async (tx) => {
				await sql`SET LOCAL statement_timeout='15s'`.execute(tx);
				const media = await sql<{
					ready_assets: number;
					projects: number;
					total_bytes: string;
					max_file_bytes: string;
					missing_digest_or_length: number;
					missing_object_key: number;
					above_previous_kind_limit: number;
					projects_above_previous_inventory: number;
				}>`
				WITH ready AS MATERIALIZED (SELECT project_id,kind,size_bytes,content_hash,gcs_object_key FROM media_assets WHERE status='ready' AND kind IN ('image','video','audio')),
				project_size AS (SELECT project_id,count(*) n,sum(size_bytes) bytes FROM ready GROUP BY project_id)
				SELECT count(*)::int ready_assets,count(DISTINCT project_id)::int projects,coalesce(sum(size_bytes),0)::text total_bytes,
				coalesce(max(size_bytes),0)::text max_file_bytes,count(*) FILTER(WHERE content_hash IS NULL OR content_hash!~'^[a-f0-9]{64}$' OR size_bytes IS NULL OR size_bytes<=0)::int missing_digest_or_length,
				count(*) FILTER(WHERE coalesce(gcs_object_key,'')='')::int missing_object_key,
				count(*) FILTER(WHERE size_bytes>1048576*(CASE kind WHEN 'image' THEN 5 WHEN 'audio' THEN 10 ELSE 50 END))::int above_previous_kind_limit,
				(SELECT count(*)::int FROM project_size WHERE n>500 OR bytes>209715200) projects_above_previous_inventory FROM ready`.execute(
					tx,
				);
				const journal = await sql<{
					artifact_journal: boolean;
					parts_journal: boolean;
					target_versions: boolean;
				}>`SELECT
				to_regclass('public.export_artifacts') IS NOT NULL artifact_journal,
				to_regclass('public.export_artifact_parts') IS NOT NULL parts_journal,
				to_regclass('public.export_target_versions') IS NOT NULL target_versions`.execute(
					tx,
				);
				return { ...media.rows[0], ...journal.rows[0] };
			});
		console.log(
			JSON.stringify({ observedAt: new Date().toISOString(), ...record }),
		);
		if (record.missing_digest_or_length || record.missing_object_key)
			process.exitCode = 1;
	} finally {
		await closeCaseStoreDatabase();
	}
}
runMain(main);
