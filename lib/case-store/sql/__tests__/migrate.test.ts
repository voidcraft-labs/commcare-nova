// Tests for `runCaseStoreMigrations` (Kysely `Migrator` + Atlas-baseline
// self-adoption). Uses per-test databases (not the BEGIN/ROLLBACK fixture)
// because the migrator opens its own transactions and creates real tables that
// must persist across the calls under test.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "./perTestDatabase";

const dbHandle = setupPerTestDatabase({ databaseNamePrefix: "migrate_test_" });

const BASELINE_NAMES = [
	"20260505152732_baseline",
	"20260506022302_add_case_name_column",
];

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
		expect(await ledgerNames(db)).toEqual(BASELINE_NAMES);
	});

	it("is idempotent — a second run applies nothing and does not throw", async () => {
		const db = dbHandle.db;
		await runCaseStoreMigrations(db);
		await expect(runCaseStoreMigrations(db)).resolves.toBeUndefined();
		expect(await ledgerNames(db)).toEqual(BASELINE_NAMES);
	});

	it("self-adopts an Atlas-migrated database (schema present, no Kysely ledger)", async () => {
		const db = dbHandle.db;
		// Build the schema, then erase Kysely's ledger to reproduce the Atlas-era
		// signature: tables exist, but Kysely has never tracked them.
		await runCaseStoreMigrations(db);
		await sql`DROP TABLE kysely_migration`.execute(db);
		await sql`DROP TABLE IF EXISTS kysely_migration_lock`.execute(db);

		// A naive `migrateToLatest` would now re-run the baseline and fail on the
		// existing `cases` table. Self-adoption must seed the ledger instead so
		// this resolves without touching the schema.
		await expect(runCaseStoreMigrations(db)).resolves.toBeUndefined();
		expect(await ledgerNames(db)).toEqual(BASELINE_NAMES);
		expect(await regclassExists(db, "public.cases")).toBe(true);
		expect(await columnExists(db, "cases", "case_name")).toBe(true);
	});
});
