// Install the two rolling-deploy trigger functions before Better Auth's own
// migrator changes its tables. The paired scan/migrate scripts attach them to
// the populated auth tables after their 1.7 backfills. Defining the routines
// here keeps the exact public-routine inventory valid on fresh databases too,
// where those auth tables do not exist until the next migration phase.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE OR REPLACE FUNCTION public.nova_fill_auth_account_issuer_v17()
		RETURNS trigger
		LANGUAGE plpgsql
		AS $$
		BEGIN
			IF NEW.issuer IS NULL THEN
				CASE NEW."providerId"
					WHEN 'google' THEN
						NEW.issuer := 'https://accounts.google.com';
					WHEN 'credential' THEN
						NEW.issuer := 'local:credential';
						NEW."accountId" := NEW."userId";
					ELSE
						RAISE EXCEPTION 'Legacy auth account provider % has no reviewed issuer mapping', NEW."providerId";
				END CASE;
			END IF;
			RETURN NEW;
		END;
		$$
	`.execute(db);

	await sql`
		CREATE OR REPLACE FUNCTION public.nova_fill_oauth_client_application_type_v17()
		RETURNS trigger
		LANGUAGE plpgsql
		AS $$
		BEGIN
			IF NEW."applicationType" IS NULL THEN
				IF jsonb_array_length(NEW."redirectUris") > 0
					AND NOT EXISTS (
						SELECT 1
						FROM jsonb_array_elements_text(NEW."redirectUris") AS redirect(uri)
						WHERE redirect.uri !~ '^http://(localhost|127[.]0[.]0[.]1|[[]::1[]])(:[0-9]+)?/'
					) THEN
					NEW."applicationType" := 'native';
				ELSIF jsonb_array_length(NEW."redirectUris") > 0
					AND NOT EXISTS (
						SELECT 1
						FROM jsonb_array_elements_text(NEW."redirectUris") AS redirect(uri)
						WHERE redirect.uri !~ '^https://'
					) THEN
					NEW."applicationType" := 'web';
				ELSE
					RAISE EXCEPTION 'Legacy OAuth client redirect URIs have no reviewed application type';
				END IF;
			END IF;
			RETURN NEW;
		END;
		$$
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		DO $$
		BEGIN
			IF to_regclass('public.auth_oauth_client') IS NOT NULL THEN
				DROP TRIGGER IF EXISTS nova_oauth_client_application_type_v17
					ON public.auth_oauth_client;
			END IF;
			IF to_regclass('public.auth_account') IS NOT NULL THEN
				DROP TRIGGER IF EXISTS nova_auth_account_issuer_v17
					ON public.auth_account;
			END IF;
		END
		$$
	`.execute(db);
	await sql`
		DROP FUNCTION IF EXISTS public.nova_fill_oauth_client_application_type_v17()
	`.execute(db);
	await sql`
		DROP FUNCTION IF EXISTS public.nova_fill_auth_account_issuer_v17()
	`.execute(db);
}
