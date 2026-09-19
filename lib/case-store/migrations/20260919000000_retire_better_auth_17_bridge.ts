// Retires what carried Nova from Better Auth 1.6 onto 1.7.
//
// Account identity. Better Auth identifies an account by ("providerId",
// "accountId"). Releases 1.7.0 through 1.7.2 keyed it by (issuer, "accountId")
// instead, and a database those releases migrated holds `auth_account.issuer`
// as NOT NULL with a unique (issuer, "accountId") index. Better Auth no longer
// writes `issuer`; its startup schema check reports a required column it does
// not write and refuses every auth request until the column accepts NULL.
//
// Rolling-deploy bridge. `20260829000000_better_auth_17_rolling_deploy_bridge`
// installed three trigger functions so inserts from a still-serving 1.6 revision
// stayed valid. No 1.6 revision remains, and Better Auth writes the OAuth client
// fields itself. `auth_oauth_client."public"` and `"type"` are the 1.6 columns
// its 1.7 upgrade retires.
//
// Every step is conditional: a database created after 1.7 holds none of this,
// and case-store migrations run before Better Auth's own migrator has created
// its tables at all.
//
// `auth_account.issuer` itself stays. This migration runs while the previous
// revision is still serving, and that revision reads and writes it.

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
			IF to_regclass('public.auth_oauth_client') IS NOT NULL THEN
				DROP TRIGGER IF EXISTS nova_oauth_client_resource_v17
					ON public.auth_oauth_client;
				DROP TRIGGER IF EXISTS nova_oauth_client_application_type_v17
					ON public.auth_oauth_client;
				ALTER TABLE public.auth_oauth_client
					DROP COLUMN IF EXISTS "public",
					DROP COLUMN IF EXISTS "type";
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
	await sql`
		DROP FUNCTION IF EXISTS public.nova_fill_oauth_client_application_type_v17()
	`.execute(db);
	await sql`
		DROP FUNCTION IF EXISTS public.nova_link_oauth_client_resource_v17()
	`.execute(db);
}

export async function down(): Promise<void> {
	throw new Error(
		"Retiring the Better Auth 1.7 bridge is forward-only: accounts created afterwards carry no issuer, so the required column and its unique index cannot be restored.",
	);
}
