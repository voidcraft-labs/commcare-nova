// Better Auth identifies an account by ("providerId", "accountId"). Releases
// 1.7.0 through 1.7.2 keyed it by (issuer, "accountId") instead, and a database
// those releases migrated holds `auth_account.issuer` as NOT NULL, a unique
// (issuer, "accountId") index, and Nova's rolling-deploy fill trigger. Better
// Auth no longer writes `issuer`; its startup schema check reports a required
// column it does not write and refuses every auth request until the column
// accepts NULL.
//
// Every step is conditional: a database created after the issuer scheme never
// holds the column, the index, or the trigger, and case-store migrations run
// before Better Auth's own migrator has created `auth_account` at all.
//
// The column itself stays. This migration runs while the previous revision is
// still serving, and that revision reads and writes `issuer`.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		DO $$
		BEGIN
			IF to_regclass('public.auth_account') IS NOT NULL THEN
				DROP TRIGGER IF EXISTS nova_auth_account_issuer_v17
					ON public.auth_account;
				IF EXISTS (
					SELECT 1
					FROM information_schema.columns
					WHERE table_schema = 'public'
						AND table_name = 'auth_account'
						AND column_name = 'issuer'
				) THEN
					ALTER TABLE public.auth_account ALTER COLUMN issuer DROP NOT NULL;
				END IF;
			END IF;
		END
		$$
	`.execute(db);
	await sql`
		DROP INDEX IF EXISTS public."auth_account_issuer_accountId_uidx"
	`.execute(db);
	await sql`
		DROP FUNCTION IF EXISTS public.nova_fill_auth_account_issuer_v17()
	`.execute(db);
}

export async function down(): Promise<void> {
	throw new Error(
		"Retiring the Better Auth issuer identity is forward-only: accounts created afterwards carry no issuer, so the required column and its unique index cannot be restored.",
	);
}
