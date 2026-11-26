/** Bounded Project reclamation. Supply the operator database and object-store
 * identities. The media reader checks each export generation before refunding its charge. */
import "./lib/loadEnv";
import { Command } from "commander";
import { sql } from "kysely";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import { reclaimExportBatch } from "@/lib/export/artifacts/store";
import { reclaimLookupStorageBatch } from "@/lib/lookup/generations/recovery";
import { reclaimCellStorageBatch } from "@/lib/lookup/largeValues/recovery";
import { runMain } from "./lib/main";

const cli = new Command()
	.requiredOption(
		"--max-batches <count>",
		"maximum short transactions for this invocation",
	)
	.parse();
const limit = Number(cli.opts().maxBatches);
if (!Number.isSafeInteger(limit) || limit < 1)
	throw new Error("Choose a positive batch count.");
async function main() {
	let batches = 0;
	try {
		const db = await getAppDb();
		let after = "";
		while (batches < limit) {
			const project = await sql<{
				project_id: string;
			}>`SELECT project_id FROM lookup_storage_budgets WHERE project_id COLLATE "C">${after}
				ORDER BY project_id COLLATE "C" LIMIT 1`.execute(db);
			const id = project.rows[0]?.project_id;
			if (!id) break;
			after = id;
			while (
				batches < limit &&
				(await withAppTx(
					async (tx) =>
						(await reclaimLookupStorageBatch(tx, id)) ||
						(await reclaimCellStorageBatch(tx, id)) ||
						(await reclaimExportBatch(tx, id)),
				))
			)
				batches++;
		}
		console.log(JSON.stringify({ batches, limitReached: batches === limit }));
	} finally {
		await closeCaseStoreDatabase();
	}
}
runMain(main);
