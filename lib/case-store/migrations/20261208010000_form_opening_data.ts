import { type Kysely, sql } from "kysely";
import { up as bindSessions } from "../../auth/migrations/20261208010000_form_opening_sessions";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
	await sql`CREATE TABLE public.form_opening_data (
		audience_sha256 text NOT NULL CHECK (length(audience_sha256) = 64),
		content_sha256 text NOT NULL CHECK (length(content_sha256) = 64),
		app_id text NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
		project_id text NOT NULL,
		session_id text NOT NULL,
		data bytea NOT NULL,
		expires_at timestamptz NOT NULL,
		PRIMARY KEY (audience_sha256,content_sha256)
	)`.execute(db);
	await sql`CREATE INDEX form_opening_data_expiry ON public.form_opening_data (expires_at)`.execute(
		db,
	);
	await sql`CREATE INDEX form_opening_data_session ON public.form_opening_data (session_id)`.execute(
		db,
	);
	await sql`CREATE INDEX form_opening_data_app ON public.form_opening_data (app_id)`.execute(
		db,
	);
	// The scheduled maintenance role can reclaim expired rows, without SELECT,
	// UPDATE or DELETE authority on a live worker's projection.
	await sql`CREATE FUNCTION public.nova_reclaim_expired_form_openings()
		RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
		WITH retired AS (
			DELETE FROM public.form_opening_data WHERE (audience_sha256,content_sha256) IN (
				SELECT audience_sha256,content_sha256 FROM public.form_opening_data
				WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED
			) RETURNING 1
		) SELECT count(*)::integer FROM retired
		$$`.execute(db);
	await sql`REVOKE ALL ON FUNCTION public.nova_reclaim_expired_form_openings() FROM PUBLIC`.execute(
		db,
	);
	await bindSessions(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP FUNCTION public.nova_reclaim_expired_form_openings()`.execute(
		db,
	);
	await sql`DROP TABLE public.form_opening_data`.execute(db);
}
