import { type Kysely, sql } from "kysely";

// Short-lived coordination for people running a Web preview. An app moving
// between Projects must never bring either its notices or its restores along.
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE TABLE public.preview_form_activity (
		project_id text NOT NULL REFERENCES public.auth_organization(id) ON DELETE CASCADE,
		app_id text NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
		key_digest bytea NOT NULL CHECK (octet_length(key_digest) = 32),
		worker_id text NOT NULL,
		worker_name text NOT NULL,
		title text CHECK (octet_length(title) <= 4096),
		entry_context jsonb NOT NULL CHECK (octet_length(entry_context::text) <= 65536),
		window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 1 AND 3600),
		kind text NOT NULL CHECK (kind IN ('opened','submitted')),
		event_at timestamptz NOT NULL,
		expires_at timestamptz NOT NULL,
		PRIMARY KEY (project_id, app_id, key_digest)
	)`.execute(db);
	await sql`CREATE INDEX preview_form_activity_expiry ON public.preview_form_activity (project_id, app_id, expires_at)`.execute(
		db,
	);
	await sql`CREATE TABLE public.preview_web_restores (
		project_id text NOT NULL REFERENCES public.auth_organization(id) ON DELETE CASCADE,
		app_id text NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
		actor_id text NOT NULL REFERENCES public.auth_user(id) ON DELETE CASCADE,
		worker_id text NOT NULL,
		restored_at timestamptz NOT NULL,
		PRIMARY KEY (project_id, app_id, actor_id, worker_id)
	)`.execute(db);
	await sql`CREATE INDEX preview_web_restores_age ON public.preview_web_restores (project_id, app_id, restored_at)`.execute(
		db,
	);
	await sql`CREATE FUNCTION public.nova_clear_moved_preview_activity() RETURNS trigger
		LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
		BEGIN
			DELETE FROM public.preview_form_activity WHERE project_id = OLD.project_id AND app_id = OLD.id;
			DELETE FROM public.preview_web_restores WHERE project_id = OLD.project_id AND app_id = OLD.id;
			RETURN NEW;
		END
		$body$`.execute(db);
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
