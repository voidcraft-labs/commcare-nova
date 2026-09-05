// Tests for `runCaseStoreMigrations` (Kysely `Migrator` over idempotent
// adoption baselines). Uses per-test databases (not the BEGIN/ROLLBACK fixture)
// because the migrator opens its own transactions and creates real tables that
// must persist across the calls under test.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
	runCaseStoreMigrations,
	runCaseStoreMigrationsWithReport,
} from "@/lib/case-store/migrate";
import { caseStoreMigrations } from "@/lib/case-store/migrations";
import * as designLocalization from "@/lib/case-store/migrations/20260815010000_design_localization";
import { setupPerTestDatabase } from "./perTestDatabase";

const dbHandle = setupPerTestDatabase({ databaseNamePrefix: "migrate_test_" });

// Derive the expected ledger contents from the migration set itself, so adding
// a migration doesn't require editing this test (the ledger lists every applied
// name, ordered by name).
const EXPECTED_LEDGER = Object.keys(caseStoreMigrations).sort();

async function ledgerNames(db: Kysely<unknown>): Promise<string[]> {
	const r = await sql<{
		name: string;
	}>`SELECT name FROM kysely_migration ORDER BY name`.execute(db);
	return r.rows.map((row) => row.name);
}

async function regclassExists(
	db: Kysely<unknown>,
	qualifiedName: string,
): Promise<boolean> {
	const r = await sql<{
		reg: string | null;
	}>`SELECT to_regclass(${qualifiedName}) AS reg`.execute(db);
	return r.rows[0]?.reg != null;
}

async function columnExists(
	db: Kysely<unknown>,
	table: string,
	column: string,
): Promise<boolean> {
	const r = await sql<{ exists: boolean }>`SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = ${table} AND column_name = ${column}
	) AS exists`.execute(db);
	return r.rows[0]?.exists === true;
}

describe("runCaseStoreMigrations", () => {
	it("creates the full schema and records the ledger on a fresh database", async () => {
		const db = dbHandle.db;
		const report = await runCaseStoreMigrationsWithReport(db);

		expect(report.appliedMigrationNames).toEqual(EXPECTED_LEDGER);
		expect(await regclassExists(db, "public.cases")).toBe(true);
		expect(await regclassExists(db, "public.case_indices")).toBe(true);
		expect(await regclassExists(db, "public.case_type_schemas")).toBe(true);
		expect(await regclassExists(db, "public.parked_case_values")).toBe(true);
		expect(await regclassExists(db, "public.media_reference_index_state")).toBe(
			false,
		);
		// The baseline's whole-row quarantine sink is created and then
		// dropped by the park migration — the full chain must end
		// without it.
		expect(await regclassExists(db, "public.cases_quarantine")).toBe(false);
		// `case_name` comes from the second migration — its presence proves both
		// migrations ran, in order.
		expect(await columnExists(db, "cases", "case_name")).toBe(true);
		expect(await ledgerNames(db)).toEqual(EXPECTED_LEDGER);
	});

	it("is idempotent — a second run applies nothing and does not throw", async () => {
		const db = dbHandle.db;
		await runCaseStoreMigrations(db);
		await expect(runCaseStoreMigrationsWithReport(db)).resolves.toEqual({
			appliedMigrationNames: [],
		});
		await expect(runCaseStoreMigrations(db)).resolves.toBeUndefined();
		expect(await ledgerNames(db)).toEqual(EXPECTED_LEDGER);
	});

	it("adopts existing localization tables when its ledger row is absent", async () => {
		const db = dbHandle.db;
		await runCaseStoreMigrations(db);

		await expect(designLocalization.up(db)).resolves.toBeUndefined();
		expect(
			await regclassExists(db, "public.design_localization_attempts"),
		).toBe(true);
		expect(
			await regclassExists(
				db,
				"public.design_localization_batch_usage_accounts",
			),
		).toBe(true);
	});

	it("fails closed when a final schema loses its immutable migration ledger", async () => {
		const db = dbHandle.db;
		await runCaseStoreMigrations(db);
		await sql`DROP TABLE kysely_migration`.execute(db);
		await sql`DROP TABLE IF EXISTS kysely_migration_lock`.execute(db);

		/* Still fails closed, just earlier: the canonical-identity migration now
		 * runs its repair first, and the repair's boundary check refuses a
		 * database whose canonical state is already applied but whose ledger no
		 * longer records it. Either refusal is the point — a re-run must never
		 * replay a destructive migration over a schema that already has it. */
		await expect(runCaseStoreMigrations(db)).rejects.toThrow(
			/canonical identity repair/i,
		);
	});

	it("does not replay history to heal drift in a fully ledgered final schema", async () => {
		const db = dbHandle.db;
		await runCaseStoreMigrations(db);
		await sql`ALTER TABLE "cases" DROP CONSTRAINT IF EXISTS "cases_case_name_check"`.execute(
			db,
		);
		await sql`ALTER TABLE "cases" DROP COLUMN "case_name"`.execute(db);
		expect(await columnExists(db, "cases", "case_name")).toBe(false);

		await expect(runCaseStoreMigrations(db)).resolves.toBeUndefined();
		expect(await columnExists(db, "cases", "case_name")).toBe(false);
		expect(await ledgerNames(db)).toEqual(EXPECTED_LEDGER);
	});
});
