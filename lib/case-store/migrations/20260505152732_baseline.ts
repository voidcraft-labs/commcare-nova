// Case-store baseline schema.
//
// Converted verbatim from the original Atlas-generated migration
// `20260505152732_baseline.sql` when the project moved off Atlas onto
// Kysely's `Migrator` (see `lib/case-store/migrate.ts`). The DDL is
// byte-for-byte the same statements Atlas applied, so a database already
// migrated by Atlas is structurally identical — the migrate runner's
// self-adoption step marks this migration applied on such databases rather
// than re-running it (which would fail on the existing tables).
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE TABLE "case_indices" ("case_id" uuid NOT NULL, "ancestor_id" uuid NOT NULL, "identifier" text NOT NULL, "relationship" text NOT NULL, "depth" integer NOT NULL, PRIMARY KEY ("case_id", "ancestor_id", "identifier"))`.execute(
		db,
	);
	await sql`CREATE INDEX "case_indices_ancestor_id_identifier_idx" ON "case_indices" ("ancestor_id", "identifier")`.execute(
		db,
	);
	await sql`CREATE INDEX "case_indices_case_id_identifier_idx" ON "case_indices" ("case_id", "identifier")`.execute(
		db,
	);
	await sql`CREATE TABLE "case_type_schemas" ("app_id" text NOT NULL, "case_type" text NOT NULL, "schema" jsonb NOT NULL, PRIMARY KEY ("app_id", "case_type"))`.execute(
		db,
	);
	await sql`CREATE TABLE "cases" ("case_id" uuid NOT NULL DEFAULT uuidv7(), "app_id" text NOT NULL, "case_type" text NOT NULL, "owner_id" text NULL, "status" text NULL, "opened_on" timestamptz NULL, "modified_on" timestamptz NULL, "closed_on" timestamptz NULL, "parent_case_id" uuid NULL, "properties" jsonb NOT NULL, PRIMARY KEY ("case_id"))`.execute(
		db,
	);
	await sql`CREATE TABLE "cases_quarantine" ("case_id" uuid NOT NULL, "app_id" text NOT NULL, "case_type" text NOT NULL, "owner_id" text NULL, "status" text NULL, "opened_on" timestamptz NULL, "modified_on" timestamptz NULL, "closed_on" timestamptz NULL, "parent_case_id" uuid NULL, "properties" jsonb NOT NULL, "quarantine_reason" text NOT NULL, "quarantined_at" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("case_id", "quarantined_at"))`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS "cases_quarantine"`.execute(db);
	await sql`DROP TABLE IF EXISTS "cases"`.execute(db);
	await sql`DROP TABLE IF EXISTS "case_type_schemas"`.execute(db);
	await sql`DROP TABLE IF EXISTS "case_indices"`.execute(db);
}
