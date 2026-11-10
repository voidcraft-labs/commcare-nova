import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { scanConversationSources } from "./lib/conversationSourceBaseline";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const program = new Command()
	.description(
		"Read-only conversation source census; no extraction, writes, or source text in output.",
	)
	.option("--prod", "read production using the operator identity")
	.option("--bucket <name>", "explicit media bucket; required for production")
	.parse();
const options = program.opts<{ prod?: boolean; bucket?: string }>();
if (options.prod) {
	if (!options.bucket)
		throw new Error(
			"--prod requires --bucket so local media configuration cannot affect a production census",
		);
	targetProdDb();
}
if (options.bucket) process.env.NOVA_MEDIA_BUCKET = options.bucket;
runMain(async () => {
	try {
		const db = await getAppDb();
		const { report } = await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.execute((tx) => scanConversationSources(tx));
		console.log(JSON.stringify(report));
	} finally {
		await closeCaseStoreDatabase();
	}
});
