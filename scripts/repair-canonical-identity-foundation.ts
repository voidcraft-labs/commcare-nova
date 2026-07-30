/**
 * ⚠️ WRITES WITH --apply — exact, all-app-atomic canonical identity repair.
 *
 * The operator surface owns orchestration only. Both dry-run and apply invoke
 * the same reviewed SQL authority; dry-run executes every real write/proof and
 * then deliberately rolls the caller-owned transaction back.
 */

import "dotenv/config";
import { Command } from "commander";
import { runFrozenCanonicalIdentityRepair } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenDatabaseRepair";
import { CANONICAL_IDENTITY_REPAIR_VERSION } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenRepairManifest";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	readonly prod?: boolean;
	readonly apply?: boolean;
	readonly confirm?: string;
}

const program = new Command();
program
	.name("repair-canonical-identity-foundation")
	.description(
		"Verify or atomically apply the exact canonical identity repair manifest.",
	)
	.option("--prod", "target production through the operator IAM connection")
	.option("--apply", "write the repair; default executes and rolls back")
	.option(
		"--confirm <version>",
		`required with --apply; must equal ${CANONICAL_IDENTITY_REPAIR_VERSION}`,
	);
program.parse();
const options = program.opts<Options>();
if (options.prod) targetProdDb();
if (options.apply && options.confirm !== CANONICAL_IDENTITY_REPAIR_VERSION) {
	throw new Error(
		`--apply requires --confirm ${CANONICAL_IDENTITY_REPAIR_VERSION}`,
	);
}

async function main(): Promise<void> {
	const db = await getAppDb();
	try {
		const report = await runFrozenCanonicalIdentityRepair(db, {
			apply: options.apply === true,
		});
		console.log(JSON.stringify(report, null, 2));
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
