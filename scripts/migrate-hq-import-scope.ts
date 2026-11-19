/**
 * WRITER: give `nova.hq.import` to the grants that existed when the scope was
 * added, in one transaction. Dry run by default; `--execute` writes. A second
 * run changes nothing. Production execution belongs to the
 * commcare-nova-historical-repair Job on the maintenance image, never a human
 * `--prod` connection.
 *
 * Which rows, and why, is `lib/hqImportScope.ts`'s. Its read-only pair is
 * `scan-hq-import-scope.ts`. It prints counts only.
 */

import "./lib/loadEnv";
import { Command } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import {
	IMPORT_SCOPE,
	repairImportScope,
	repairLines,
} from "./lib/hqImportScope";
import { runMain } from "./lib/main";

interface Options {
	execute?: boolean;
}

const program = new Command();
program
	.name("migrate-hq-import-scope")
	.description(
		`Add ${IMPORT_SCOPE} to every OAuth client list that lacks it, and to every consent, live refresh token and enabled API key that holds nova.hq.read and nova.hq.write, in one transaction. Dry run by default.`,
	)
	.option("--execute", "write the change")
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Writes NOVA_DB_LOCAL_URL locally. Production writes run inside the\n" +
			"  explicit commcare-nova-historical-repair Job using the maintenance\n" +
			"  image (hq-import-scope-repair.cjs). There is intentionally no\n" +
			"  --prod writer shortcut.\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/migrate-hq-import-scope.ts\n" +
			"  $ npx tsx scripts/migrate-hq-import-scope.ts --execute\n",
	);
program.parse();
const options = program.opts<Options>();

async function main(): Promise<void> {
	try {
		const repair = await repairImportScope(await getCaseStoreDatabase(), {
			execute: options.execute === true,
		});
		console.log(
			repair.written
				? `Added ${IMPORT_SCOPE}:\n`
				: `DRY RUN: nothing written. Pass --execute to apply.\n`,
		);
		for (const line of repairLines(repair)) console.log(line);
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
