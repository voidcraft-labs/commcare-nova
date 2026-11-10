import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { scanConversationSources } from "./lib/conversationSourceBaseline";
import { migrateConversationSources } from "./lib/conversationSourceCutover";
import { runMain } from "./lib/main";

const options = new Command()
	.description(
		"Retain conversation sources during the reviewed direct maintenance cutover. Dry-run by default.",
	)
	.requiredOption("--scan-digest <digest>", "reviewed source scan digest")
	.requiredOption("--bucket <name>", "source media bucket")
	.option("--execute", "perform the cutover")
	.parse()
	.opts<{ scanDigest: string; bucket: string; execute?: boolean }>();
process.env.NOVA_MEDIA_BUCKET = options.bucket;
runMain(async () => {
	try {
		const db = await getAppDb();
		if (options.execute)
			console.log(
				JSON.stringify(
					await migrateConversationSources(db, options.scanDigest),
				),
			);
		else {
			const { report } = await db
				.transaction()
				.setIsolationLevel("repeatable read")
				.execute((tx) => scanConversationSources(tx));
			if (report.scanDigest !== options.scanDigest)
				throw new Error("Source scan changed. Scan again before the cutover.");
			console.log(JSON.stringify({ applied: false, ...report }));
		}
	} finally {
		await closeCaseStoreDatabase();
	}
});
