// Tests for `runCaseStoreMigrations` (Kysely `Migrator` over idempotent
// adoption baselines). Uses per-test databases (not the BEGIN/ROLLBACK fixture)
// because the migrator opens its own transactions and creates real tables that
// must persist across the calls under test.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { caseStoreMigrations } from "@/lib/case-store/migrations";
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
		await runCaseStoreMigrations(db);

		expect(await regclassExists(db, "public.cases")).toBe(true);
		expect(await regclassExists(db, "public.case_indices")).toBe(true);
		expect(await regclassExists(db, "public.case_type_schemas")).toBe(true);
		expect(await regclassExists(db, "public.cases_quarantine")).toBe(true);
		// `case_name` comes from the second migration — its presence proves both
		// migrations ran, in order.
		expect(await columnExists(db, "cases", "case_name")).toBe(true);
		expect(await ledgerNames(db)).toEqual(EXPECTED_LEDGER);
	});

	it("is idempotent — a second run applies nothing and does not throw", async () => {
		const db = dbHandle.db;
		await runCaseStoreMigrations(db);
		await expect(runCaseStoreMigrations(db)).resolves.toBeUndefined();
		expect(await ledgerNames(db)).toEqual(EXPECTED_LEDGER);
	});

	it("adopts a pre-existing (Atlas-style) schema that has no Kysely ledger", async () => {
		const db = dbHandle.db;
		// Build the schema, then erase Kysely's ledger to reproduce the Atlas-era
		// signature: the tables exist, but Kysely has never tracked them.
		await runCaseStoreMigrations(db);
		await sql`DROP TABLE kysely_migration`.execute(db);
		await sql`DROP TABLE IF EXISTS kysely_migration_lock`.execute(db);

		// The idempotent baselines must replay as a clean no-op against the
		// existing schema (no "relation already exists" / "constraint already
		// exists"), and the ledger must end up fully recorded.
		await expect(runCaseStoreMigrations(db)).resolves.toBeUndefined();
		expect(await ledgerNames(db)).toEqual(EXPECTED_LEDGER);
		expect(await regclassExists(db, "public.cases")).toBe(true);
		expect(await columnExists(db, "cases", "case_name")).toBe(true);
	});

	it("adds case_name when adopting a volume that only had the first baseline", async () => {
		const db = dbHandle.db;
		// Reproduce the narrow window where only the first baseline had run: the
		// tables exist but `case_name` (the second baseline's effect) does not, and
		// there is no Kysely ledger. The idempotent second baseline must still add
		// the column rather than being wrongly skipped.
		await runCaseStoreMigrations(db);
		await sql`DROP TABLE kysely_migration`.execute(db);
		await sql`DROP TABLE IF EXISTS kysely_migration_lock`.execute(db);
		await sql`ALTER TABLE "cases" DROP CONSTRAINT IF EXISTS "cases_case_name_check"`.execute(
			db,
		);
		await sql`ALTER TABLE "cases" DROP COLUMN "case_name"`.execute(db);
		await sql`ALTER TABLE "cases_quarantine" DROP COLUMN IF EXISTS "case_name"`.execute(
			db,
		);
		expect(await columnExists(db, "cases", "case_name")).toBe(false);

		await expect(runCaseStoreMigrations(db)).resolves.toBeUndefined();
		expect(await columnExists(db, "cases", "case_name")).toBe(true);
		expect(await ledgerNames(db)).toEqual(EXPECTED_LEDGER);
	});
});
