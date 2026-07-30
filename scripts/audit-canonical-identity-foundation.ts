/**
 * Immutable-image, read-only post-deploy canonical identity audit.
 *
 * This is an image entrypoint, not rollout orchestration. The disposable
 * operator-owned Job supplies the dedicated audit login and the exact target
 * repository@sha256 image. A pool-one audit workload lets the session-level
 * read-only default cover the scanner's internally owned repeatable-read
 * transaction.
 */

import { createHash } from "node:crypto";
import { sql } from "kysely";
import {
	frozenCanonicalIdentityTerminalAuditExitCode,
	scanFrozenCanonicalIdentityFoundation,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenScanner";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
	readCaseStoreWorkload,
} from "@/lib/case-store/postgres/connection";

async function main(): Promise<number> {
	if (process.argv.length !== 2) {
		throw new Error(
			"The immutable canonical-identity audit entrypoint accepts no arguments.",
		);
	}
	if (readCaseStoreWorkload() !== "audit") {
		throw new Error(
			"The canonical-identity audit entrypoint requires NOVA_DB_WORKLOAD=audit.",
		);
	}
	const databaseUser = process.env.NOVA_DB_USER?.trim();
	const migrationUser = process.env.NOVA_MIGRATION_DB_USER?.trim();
	const runtimeUser = process.env.NOVA_RUNTIME_DB_USER?.trim();
	const auditUser = process.env.NOVA_AUDIT_DB_USER?.trim();
	if (
		databaseUser === undefined ||
		databaseUser.length === 0 ||
		migrationUser === undefined ||
		migrationUser.length === 0 ||
		runtimeUser === undefined ||
		runtimeUser.length === 0 ||
		auditUser === undefined ||
		auditUser.length === 0 ||
		databaseUser !== auditUser
	) {
		throw new Error(
			"The canonical-identity audit entrypoint requires exact nonblank migration, runtime, and audit database roles, with NOVA_DB_USER equal to NOVA_AUDIT_DB_USER.",
		);
	}
	const db = await getCaseStoreDatabase();
	await sql`SET default_transaction_read_only = on`.execute(db);
	const readOnly = await sql<{ value: string }>`
		SHOW default_transaction_read_only
	`.execute(db);
	if (readOnly.rows[0]?.value !== "on") {
		throw new Error("The canonical-identity audit session is not read-only.");
	}
	const report = await scanFrozenCanonicalIdentityFoundation(db, {
		locked: false,
		deployedFoldSecurity: {
			migrationRole: migrationUser,
			runtimeRole: runtimeUser,
			auditRole: auditUser,
		},
	});
	const exitCode = frozenCanonicalIdentityTerminalAuditExitCode(report);
	const reportJson = JSON.stringify(report);
	const reportDigest = createHash("sha256").update(reportJson).digest("hex");
	console.log(
		JSON.stringify({
			severity: exitCode === 0 ? "INFO" : "ERROR",
			message: "[audit] canonical identity database scan complete",
			reportDigest,
			report,
		}),
	);
	return exitCode;
}

async function finish(code: number): Promise<never> {
	try {
		await closeCaseStoreDatabase();
	} catch (error) {
		console.error("[audit] teardown error (ignored):", error);
	}
	process.exit(code);
}

main().then(
	(code) => finish(code),
	(error: unknown) => {
		console.error("[audit] failed:", error);
		return finish(1);
	},
);
