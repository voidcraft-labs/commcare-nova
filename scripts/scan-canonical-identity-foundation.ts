/**
 * READ ONLY — operator shell for the timestamp-frozen canonical identity scan.
 */

import "dotenv/config";
import { Command } from "commander";
import { scanFrozenCanonicalIdentityFoundation } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenScanner";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	readonly prod?: boolean;
	readonly json?: boolean;
	readonly locked?: boolean;
}

const program = new Command();
program
	.name("scan-canonical-identity-foundation")
	.description(
		"Read-only, content-free inventory for the canonical authored-identity maintenance cutover.",
	)
	.option("--prod", "scan production through the operator IAM connection")
	.option("--json", "emit the report as one JSON object")
	.option(
		"--locked",
		"require a quiescent database and take the same table locks the migration uses",
	);
program.parse();
const options = program.opts<Options>();
if (options.prod) targetProdDb();

async function main(): Promise<void> {
	const report = await scanFrozenCanonicalIdentityFoundation(await getAppDb(), {
		locked: options.locked,
	});
	console.log(
		options.json ? JSON.stringify(report) : JSON.stringify(report, null, 2),
	);
	await closeCaseStoreDatabase();
	if (report.findingCount > 0) process.exitCode = 2;
}

runMain(main);
