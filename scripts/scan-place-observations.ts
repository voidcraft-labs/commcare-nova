/** Existing HQ adoptions have durable source place IDs but cannot recover
 * exact v1 external IDs, nullable names or metadata numbers from an old copy.
 * A normal authorized refresh supplies them. No project contents leave SQL. */
import "./lib/loadEnv";
import { Command } from "commander";
import { sql } from "kysely";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const options = new Command()
	.option("--prod", "Read production using the operator IAM connection")
	.parse()
	.opts();
if (options.prod) targetProdDb();

runMain(async () => {
	try {
		const db = await getAppDb();
		const report = await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute(async (tx) => {
				const column = await sql<{
					present: boolean;
				}>`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
				AND table_name='app_locations' AND column_name='hq_observation') AS present`.execute(
					tx,
				);
				const missing = column.rows[0].present
					? sql`p.hq_observation IS NULL`
					: sql`true`;
				const counts = await sql<{
					adopted_apps: string;
					apps_needing_refresh: string;
					places_needing_refresh: string;
					missing_source_identities: string;
				}>`WITH apps AS (
				SELECT s.app_id,count(p.id) FILTER(WHERE p.archived_at IS NULL AND p.hq_location_id IS NOT NULL AND ${missing}) AS missing,
				count(p.id) FILTER(WHERE p.archived_at IS NULL AND p.hq_location_id IS NULL) AS unknown_identity
				FROM app_organization_state s LEFT JOIN app_locations p ON p.app_id=s.app_id
				WHERE s.hq_domain IS NOT NULL GROUP BY s.app_id)
				SELECT count(*)::text AS adopted_apps, count(*) FILTER(WHERE missing>0)::text AS apps_needing_refresh,
				coalesce(sum(missing),0)::text AS places_needing_refresh, coalesce(sum(unknown_identity),0)::text AS missing_source_identities
				FROM apps`.execute(tx);
				return {
					observation_column: column.rows[0].present,
					...counts.rows[0],
				};
			});
		process.stdout.write(JSON.stringify(report) + "\n");
	} finally {
		await closeCaseStoreDatabase();
	}
});
