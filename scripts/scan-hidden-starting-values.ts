/** Count pending HQ publishes whose historical reading omitted a hidden
 * starting answer. The scan needs only the baseline's notice, never its
 * form source or data. */
import "./lib/loadEnv";
import { Command } from "commander";
import { sql } from "kysely";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const { prod } = new Command()
	.description(
		"Count pending publishes that may still omit a hidden starting answer.",
	)
	.option("--prod", "read production using the operator identity")
	.parse()
	.opts<{ prod?: boolean }>();
if (prod) targetProdDb();

runMain(async () => {
	try {
		const db = await getAppDb();
		const report = await db
			.transaction()
			.setAccessMode("read only")
			.execute(async (trx) => {
				const result = await sql<{
					of: string;
					deployment: string;
					count: number;
				}>`
				select b.first_publish_changes ->> 'of' as "of",
					case when d.state = 'ended' then 'ended' else 'active' end as deployment,
					count(*)::integer as count
				from app_deployment_baselines b
				join app_deployments d on d.id = b.deployment_id
				where (b.first_publish_changes -> 'ids') ? 'hidden-value-defaults-dropped'
				group by 1, 2 order by 1, 2
			`.execute(trx);
				return result.rows;
			});
		console.log(JSON.stringify({ deployments: report }, null, 2));
	} finally {
		await closeCaseStoreDatabase();
	}
});
