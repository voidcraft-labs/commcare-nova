import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { scanThreadStorage } from "@/lib/db/threadStorageScan";
import { runMain } from "./lib/main";
import { migrateThreadStorage } from "./lib/threadStorageCutover";

const options = new Command()
	.description(
		"Direct maintenance cutover to incremental transcripts. Dry-run by default; execution requires the exact scan digest and drained runtime access.",
	)
	.requiredOption(
		"--scan-digest <digest>",
		"reviewed transcript digest from scan-thread-storage",
	)
	.option("--execute", "perform the reviewed cutover")
	.parse()
	.opts<{ scanDigest: string; execute?: boolean }>();

runMain(async () => {
	try {
		const db = await getAppDb();
		if (options.execute)
			console.log(
				JSON.stringify(await migrateThreadStorage(db, options.scanDigest)),
			);
		else {
			const report = await db
				.transaction()
				.setIsolationLevel("repeatable read")
				.execute(scanThreadStorage);
			if (report.transcriptDigest !== options.scanDigest)
				throw new Error(
					"Transcript scan changed. Scan again before the cutover.",
				);
			console.log(JSON.stringify({ applied: false, ...report }));
		}
	} finally {
		await closeCaseStoreDatabase();
	}
});
