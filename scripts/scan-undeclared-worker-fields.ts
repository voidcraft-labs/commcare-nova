/**
 * READ-ONLY: list every saved app holding a worker read the gate refuses:
 *
 * - a read from the session by name (`session-user` with no `worker-record`
 *   source, printed `instance('commcaresession')/session/user/data/<name>`)
 *   where the name is neither a key CommCare gives every worker
 *   (`BUILT_IN_USER_PROPERTY_SLUGS`) nor a worker property the app declares
 *   (`undeclared-worker-field`, issue #913): HQ's restore holds a key only for
 *   a field the project space defines, Core refuses a read of a key the device
 *   holds no node for, and a publish asks the project space only for the
 *   worker properties the app declares;
 * - a read by name, from the session or the worker's record (an expression's
 *   `session-user`, a prose `user-ref` part), of a slug the app declares
 *   (`worker-property-read-by-name`), which the gate asks to be read by the
 *   property's identity.
 *
 * An app this lists fails the whole-document gate and every export until it
 * is repaired (`migrate-undeclared-worker-fields.ts`). The scan and the
 * repair ask one finder (`lib/undeclaredWorkerFieldRepair.ts::needsWorkerFieldRepair`),
 * which walks the whole persisted document.
 *
 * Output names app ids alone, one per line, never a field name or a value.
 * Exit 0 when no app holds such a read, 1 when one does, 2 when an app could
 * not be read.
 */

import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { loadPersistedBlueprintReadOnly } from "./lib/loadPersistedBlueprint";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import { needsWorkerFieldRepair } from "./lib/undeclaredWorkerFieldRepair";

interface Options {
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-undeclared-worker-fields")
	.description(
		"Print the id of every saved app with a worker read the gate refuses: a field read from the session that is neither built in nor declared, or a declared field read by name (read-only).",
	)
	.option("--app <appId>", "scope the scan to one app")
	.option(
		"--prod",
		"scan production Cloud SQL through your read-only gcloud IAM identity",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx --conditions=react-server scripts/scan-undeclared-worker-fields.ts\n" +
			"  $ npx tsx --conditions=react-server scripts/scan-undeclared-worker-fields.ts --app <appId>\n" +
			"  $ npx tsx --conditions=react-server scripts/scan-undeclared-worker-fields.ts --prod\n",
	);
program.parse();
const options = program.opts<Options>();
if (options.prod === true) targetProdDb();

async function main(): Promise<void> {
	const db = await getAppDb();
	let query = db.selectFrom("apps").select("id");
	if (options.app !== undefined) query = query.where("id", "=", options.app);
	const rows = await query.orderBy("id").execute();
	if (options.app !== undefined && rows.length === 0) {
		throw new Error("No app matched --app.");
	}

	let found = 0;
	let unreadable = 0;
	for (const { id } of rows) {
		let holds: boolean;
		try {
			const blueprint = await db
				.transaction()
				.setIsolationLevel("repeatable read")
				.setAccessMode("read only")
				.execute((tx) => loadPersistedBlueprintReadOnly(tx, id));
			if (blueprint === null) {
				unreadable += 1;
				console.error(`unreadable ${id}`);
				continue;
			}
			holds = needsWorkerFieldRepair(blueprint);
		} catch {
			unreadable += 1;
			console.error(`unreadable ${id}`);
			continue;
		}
		if (holds) {
			found += 1;
			console.log(id);
		}
	}
	console.error(
		`scanned ${rows.length} apps · ${found} hold the read · ${unreadable} unreadable`,
	);
	process.exitCode = unreadable > 0 ? 2 : found > 0 ? 1 : 0;
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
