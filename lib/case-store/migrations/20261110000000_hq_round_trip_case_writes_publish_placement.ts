// A publish records where CommCare HQ keeps each case write as its own app change kind,
// `publish-placement`: a nonempty batch of placement holds, no run, written at the head the publish
// emitted. The function body is the canonical identity foundation's whole, with the kind added to the
// closed set and one arm for the new kind. Additive in effect: every row the revision before writes
// still passes.

import { type Kysely, sql } from "kysely";

/** Admit `publish-placement` app changes that hold only placement holds. */
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

/** Forward only: undoing it would refuse publish placements already in apps' histories. */
export async function down(): Promise<void> {
	throw new Error(
		"This migration is forward-only: undoing it would refuse publish placements already in apps' histories.",
	);
}
