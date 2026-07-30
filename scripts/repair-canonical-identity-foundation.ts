/**
 * ⚠️ WRITES WITH --apply — exact, all-app-atomic canonical identity repair.
 *
 * The operator surface owns orchestration only. Both dry-run and apply invoke
 * the same reviewed SQL authority; dry-run executes every real write/proof and
 * then deliberately rolls the caller-owned transaction back.
 */

import "dotenv/config";
import { Command } from "commander";
import { sql } from "kysely";
import { FROZEN_OCCURRENCE_TABLES } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenOccurrenceManifest";
import {
	CANONICAL_IDENTITY_REPAIR_RESULT_DIGEST,
	CANONICAL_IDENTITY_REPAIR_VERSION,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenRepairManifest";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import {
	applyCanonicalIdentityFoundationRepairInTransaction,
	loadCanonicalIdentityRepairSnapshotsInTransaction,
} from "@/lib/db/apps";
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

interface RepairReport {
	readonly mode: "dry-run" | "applied";
	readonly version: typeof CANONICAL_IDENTITY_REPAIR_VERSION;
	readonly affectedApps: number;
	readonly deletedRows: number;
	readonly updatedEntityRows: number;
	readonly updatedCatalogs: number;
	readonly resultDigest: string;
	readonly occurrenceSourceDigest: string;
	readonly occurrenceResultDigest: string;
}

class DryRunRollback extends Error {
	constructor(readonly report: RepairReport) {
		super("Rollback the verified canonical identity repair rehearsal.");
	}
}

async function main(): Promise<void> {
	const db = await getAppDb();
	let report: RepairReport;
	try {
		report = await db
			.transaction()
			.setIsolationLevel("serializable")
			.execute(async (tx) => {
				const existingOccurrenceTables = (
					await sql<{ table_name: string }>`
						SELECT class.relname AS table_name
						FROM pg_catalog.pg_class AS class
						JOIN pg_catalog.pg_namespace AS namespace
						  ON namespace.oid = class.relnamespace
						WHERE namespace.nspname = 'public'
						  AND class.relkind IN ('r', 'p')
						  AND class.relname = ANY(
							${sql.val([...FROZEN_OCCURRENCE_TABLES])}
						  )
						ORDER BY class.relname
					`.execute(tx)
				).rows.map((row) => row.table_name);
				await sql`
					LOCK TABLE ${sql.join(
						existingOccurrenceTables.map((table) => sql.table(table)),
					)}
					IN SHARE ROW EXCLUSIVE MODE
				`.execute(tx);
				await sql`SELECT id FROM apps ORDER BY id FOR UPDATE`.execute(tx);
				const before =
					await loadCanonicalIdentityRepairSnapshotsInTransaction(tx);
				const proof = await applyCanonicalIdentityFoundationRepairInTransaction(
					tx,
					before,
				);
				if (proof.resultDigest !== CANONICAL_IDENTITY_REPAIR_RESULT_DIGEST) {
					throw new Error("Canonical identity repair manifest result drifted.");
				}
				const completed: RepairReport = {
					mode: options.apply ? "applied" : "dry-run",
					version: CANONICAL_IDENTITY_REPAIR_VERSION,
					...proof,
				};
				if (!options.apply) throw new DryRunRollback(completed);
				return completed;
			});
	} catch (error) {
		if (!(error instanceof DryRunRollback)) throw error;
		report = error.report;
	}
	console.log(JSON.stringify(report, null, 2));
	await closeCaseStoreDatabase();
}

runMain(main);
