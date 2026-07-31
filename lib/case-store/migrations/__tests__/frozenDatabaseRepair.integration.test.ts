import { sql } from "kysely";
import { describe, expect, test } from "vitest";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { readFrozenFoldFamilyObjectKeys } from "../20260728000000_canonical_identity_foundation/frozenDatabaseMigration";
import { runFrozenCanonicalIdentityRepair } from "../20260728000000_canonical_identity_foundation/frozenDatabaseRepair";
import { captureFrozenStorageSnapshot } from "../20260728000000_canonical_identity_foundation/frozenOccurrenceDispatcher";
import { canonicalIdentityDigest } from "../20260728000000_canonical_identity_foundation/frozenTransform";

const MIGRATION_NAME = "20260728000000_canonical_identity_foundation";
const TERMINAL_MESSAGE =
	"Canonical identity repair is no longer applicable: the canonical identity migration is already applied.";
const DRIFT_MESSAGE = "part-way through the canonical identity repair";

const database = setupPerTestDatabase({
	databaseNamePrefix: "frozen_repair_terminal_",
});

async function terminalEvidenceDigest(): Promise<string> {
	const ledger = await sql<{ name: string; timestamp: string }>`
		SELECT name, timestamp::text AS timestamp
		FROM public.kysely_migration
		WHERE name = ${MIGRATION_NAME}
		ORDER BY convert_to(name, 'UTF8')
	`.execute(database.db);
	return canonicalIdentityDigest({
		ledger: ledger.rows,
		foldFamilyObjectKeys: await readFrozenFoldFamilyObjectKeys(database.db),
		storage: await captureFrozenStorageSnapshot(database.db),
	});
}

describe.sequential("frozen canonical-identity repair terminal state", () => {
	test("refuses the exact post-canonical state precisely and writes nothing", async () => {
		await runCaseStoreMigrations(database.db);
		const before = await terminalEvidenceDigest();

		await expect(
			runFrozenCanonicalIdentityRepair(database.db, { apply: true }),
		).rejects.toThrow(TERMINAL_MESSAGE);

		expect(await terminalEvidenceDigest()).toBe(before);
	}, 120_000);

	test("keeps a direct unledgered canonical state classified as drift", async () => {
		await runCaseStoreMigrations(database.db);
		await sql`
			DELETE FROM public.kysely_migration
			WHERE name = ${MIGRATION_NAME}
		`.execute(database.db);

		await expect(
			runFrozenCanonicalIdentityRepair(database.db, { apply: true }),
		).rejects.toThrow(DRIFT_MESSAGE);
	}, 120_000);

	test("keeps a partial fold family classified as drift", async () => {
		await runCaseStoreMigrations(database.db);
		await sql`
			DROP TRIGGER app_change_fold_baselines_immutable
			ON public.app_change_fold_baselines
		`.execute(database.db);

		await expect(
			runFrozenCanonicalIdentityRepair(database.db, { apply: true }),
		).rejects.toThrow(DRIFT_MESSAGE);
	}, 120_000);
});
