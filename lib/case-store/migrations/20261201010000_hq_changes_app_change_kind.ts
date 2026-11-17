// A bring-in of changes made in CommCare HQ is recorded as its own app change kind,
// `hq-changes`: a nonempty batch, no run, the acting member as actor, written at the head that
// member reviewed. The function body is the publish placement migration's whole, with the kind
// added to the closed set and one arm for it after the empty-batch refusal. Additive in effect:
// every row the revision before writes still passes, and that revision writes no row of the kind.
// It replaces the routine alone; the trigger that calls it is left as it is, so it takes no lock
// on `app_changes` or on any other table the serving revision reads or writes.

import { type Kysely, sql } from "kysely";

/** Admit `hq-changes` app changes that carry a nonempty batch and no run. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE OR REPLACE FUNCTION public.nova_admit_app_change_insert()
		RETURNS trigger
		LANGUAGE plpgsql
		VOLATILE
		NOT LEAKPROOF
		SET search_path = pg_catalog
		AS $function$
		DECLARE
			current_project_id text;
			current_head bigint;
		BEGIN
			IF NEW.kind NOT IN (
				'autosave',
				'mcp',
				'chat',
				'publish-placement',
				'blueprint-migration',
				'hq-changes',
				'fold-baseline',
				'project-move'
			) THEN
				RAISE EXCEPTION 'app_changes insert has an unsupported kind';
			END IF;
			IF btrim(NEW.batch_id) = ''
				OR btrim(NEW.actor_id) = ''
				OR (NEW.run_id IS NOT NULL AND btrim(NEW.run_id) = '')
			THEN
				RAISE EXCEPTION 'app_changes insert has a blank envelope identity';
			END IF;
			IF NEW.kind = 'fold-baseline' THEN
				IF NEW.mutations <> '[]'::jsonb THEN
					RAISE EXCEPTION 'fold-baseline app changes must be empty';
				END IF;
				RETURN NEW;
			END IF;
			IF NEW.kind = 'project-move' THEN
				SELECT app.project_id, app.mutation_seq
				INTO current_project_id, current_head
				FROM public.apps AS app
				WHERE app.id = NEW.app_id
				FOR UPDATE;
				IF NOT FOUND
					OR current_project_id IS DISTINCT FROM NEW.from_project_id
					OR NEW.seq IS DISTINCT FROM current_head + 1
				THEN
					RAISE EXCEPTION
						'project-move app change does not start at the locked app Project/head';
				END IF;
				RETURN NEW;
			END IF;
			IF NEW.mutations = '[]'::jsonb THEN
				RAISE EXCEPTION
					'non-move non-baseline app changes must contain mutations';
			END IF;
			IF NEW.kind = 'hq-changes' AND NEW.run_id IS NOT NULL THEN
				RAISE EXCEPTION 'hq-changes app changes carry no run';
			END IF;
			IF NEW.kind = 'publish-placement' THEN
				IF NEW.run_id IS NOT NULL OR jsonb_typeof(NEW.mutations) <> 'array' THEN
					RAISE EXCEPTION
						'publish-placement app changes hold only placement holds and no run';
				END IF;
				IF EXISTS (
					SELECT 1
					FROM jsonb_array_elements(NEW.mutations) AS mutation
					WHERE jsonb_typeof(mutation) <> 'object'
						OR mutation->>'kind' IS DISTINCT FROM 'holdPlacements'
				) THEN
					RAISE EXCEPTION
						'publish-placement app changes hold only placement holds and no run';
				END IF;
			END IF;
			RETURN NEW;
		END
		$function$
	`.execute(db);
}

/** Forward only: undoing it would refuse changes brought in from CommCare HQ already in apps' histories. */
export async function down(): Promise<void> {
	throw new Error(
		"This migration is forward-only: undoing it would refuse changes brought in from CommCare HQ already in apps' histories.",
	);
}
