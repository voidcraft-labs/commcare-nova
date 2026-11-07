import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { getAppDb } from "../lib/db/pg";
import { runMain } from "./lib/main";
import { retireCaseExpressionIndexes } from "./lib/retireCaseExpressionIndexes";

const program = new Command()
	.requiredOption(
		"--scan-digest <sha256>",
		"reviewed read-only inventory digest",
	)
	.requiredOption(
		"--writers-stopped",
		"confirm ingress and all old application writers are stopped",
	)
	.parse();
runMain(async () => {
	try {
		const db = await getAppDb();
		console.log(
			JSON.stringify({
				removed: await retireCaseExpressionIndexes(
					db,
					program.opts().scanDigest,
				),
			}),
		);
	} finally {
		await closeCaseStoreDatabase();
	}
});
