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
import { Command, Option } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import {
	IMPORT_SCOPE,
	importScopeCutoff,
	type RepairPhase,
	repairImportScope,
	repairLines,
} from "./lib/hqImportScope";
import { runMain } from "./lib/main";

interface Options {
	before: Date;
	phase: RepairPhase;
	execute?: boolean;
}

const program = new Command();
program
	.name("migrate-hq-import-scope")
	.description(
		`Add ${IMPORT_SCOPE} to eligible pre-cutoff client lists and to each eligible consent, live refresh token and enabled API key that holds nova.hq.read and nova.hq.write, in one transaction. Dry run by default.`,
	)
	.addOption(
		new Option(
			"--phase <name>",
			"keys before the migration, oauth after the deploy",
		)
			.choices(["keys", "oauth"])
			.makeOptionMandatory(),
	)
	.requiredOption(
		"--before <utc>",
		"cutoff recorded before the scope-aware revision began receiving traffic, in YYYY-MM-DDTHH:mm:ssZ form",
		importScopeCutoff,
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
			"  $ npx tsx scripts/migrate-hq-import-scope.ts --phase keys --before <utc>\n" +
			"  $ npx tsx scripts/migrate-hq-import-scope.ts --phase oauth --before <utc> --execute\n",
	);
program.parse();
const options = program.opts<Options>();

async function main(): Promise<void> {
	try {
		const repair = await repairImportScope(await getCaseStoreDatabase(), {
			execute: options.execute === true,
			before: options.before,
			phase: options.phase,
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
