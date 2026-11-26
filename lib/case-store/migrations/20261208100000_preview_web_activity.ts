import { type Kysely, sql } from "kysely";

/** Runtime-owned previews can be initialized before the auth ledger in a
 * fresh database. The app is the deletion boundary of both short-lived rows. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE TABLE public.preview_form_activity (
		project_id text NOT NULL,
		app_id text NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
		key_digest text NOT NULL CHECK (length(key_digest) = 64),
		entry_key text NOT NULL,
		worker_id text NOT NULL,
		worker_name text NOT NULL,
		title text CHECK (octet_length(title) <= 4096),
		case_ids text[] NOT NULL,
		window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 1 AND 3600),
		kind text NOT NULL CHECK (kind IN ('opened', 'submitted')),
		event_at timestamptz NOT NULL,
		expires_at timestamptz NOT NULL,
		PRIMARY KEY (app_id, project_id, key_digest)
	)`.execute(db);
	await sql`CREATE INDEX preview_form_activity_expires
		ON public.preview_form_activity (expires_at)`.execute(db);
	await sql`CREATE TABLE public.preview_web_restores (
		project_id text NOT NULL,
		app_id text NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
		actor_id text NOT NULL,
		worker_id text NOT NULL,
		restored_at timestamptz NOT NULL,
		PRIMARY KEY (app_id, project_id, actor_id, worker_id)
	)`.execute(db);
	await sql`CREATE INDEX preview_web_restores_restored_at
		ON public.preview_web_restores (restored_at)`.execute(db);
	await sql`CREATE FUNCTION public.nova_clear_moved_preview_activity() RETURNS trigger
		SECURITY DEFINER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
		BEGIN
			DELETE FROM public.preview_form_activity WHERE app_id = OLD.id AND project_id = OLD.project_id;
			DELETE FROM public.preview_web_restores WHERE app_id = OLD.id AND project_id = OLD.project_id;
			RETURN NEW;
		END $$`.execute(db);
	await sql`REVOKE ALL ON FUNCTION public.nova_clear_moved_preview_activity() FROM PUBLIC`.execute(
		db,
	);
	await sql`CREATE TRIGGER clear_moved_preview_activity AFTER UPDATE OF project_id ON public.apps
		FOR EACH ROW WHEN (OLD.project_id IS DISTINCT FROM NEW.project_id)
		EXECUTE FUNCTION public.nova_clear_moved_preview_activity()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TRIGGER clear_moved_preview_activity ON public.apps`.execute(
		db,
	);
	await sql`DROP FUNCTION public.nova_clear_moved_preview_activity()`.execute(
		db,
	);
	await sql`DROP TABLE public.preview_web_restores, public.preview_form_activity`.execute(
		db,
	);
}
