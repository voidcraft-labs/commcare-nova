import { type Kysely, sql } from "kysely";

/** Admit the one-time operator baseline after the authoring cutover. Historical
 * rows stay immutable; runtime retains read-only access to baseline storage. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE OR REPLACE FUNCTION nova_admit_app_change_fold_baseline_insert()
		RETURNS trigger
		LANGUAGE plpgsql
		VOLATILE
		NOT LEAKPROOF
		SET search_path = pg_catalog
		AS $function$
		DECLARE
			current_transaction xid;
			expected_snapshot jsonb;
		BEGIN
			-- xmin is a 32-bit xid while pg_current_xact_id() is the
			-- epoch-aware xid8. Compare the exact current low 32 bits instead of
			-- their text renderings so admission remains correct across xid wrap.
			current_transaction := (
				mod(
					pg_current_xact_id()::text::numeric,
					4294967296::numeric
				)::bigint::text
			)::xid;
			expected_snapshot :=
				public.nova_current_app_change_fold_snapshot(NEW.app_id);
			IF expected_snapshot IS NULL
				OR NEW.snapshot::text IS DISTINCT FROM expected_snapshot::text
			THEN
				RAISE EXCEPTION
					'app_change_fold_baselines insert snapshot does not equal current app state';
			END IF;
			IF NEW.snapshot_digest IS DISTINCT FROM
				public.nova_app_change_fold_snapshot_digest(NEW.snapshot)
			THEN
				RAISE EXCEPTION
					'app_change_fold_baselines insert digest does not match snapshot';
			END IF;
			IF NOT EXISTS (
				SELECT 1
				FROM public.app_changes AS marker
				JOIN public.apps AS app ON app.id = marker.app_id
				WHERE marker.app_id = NEW.app_id
					AND marker.seq = NEW.seq
					AND marker.kind = 'fold-baseline'
					AND marker.mutations = '[]'::jsonb
					AND marker.from_project_id IS NULL
					AND marker.to_project_id IS NULL
					AND app.mutation_seq = NEW.seq
					AND app.project_id = NEW.project_id
					AND marker.xmin = current_transaction
					AND app.xmin = current_transaction
					AND NOT EXISTS (
						SELECT 1
						FROM public.blueprint_entities AS entity
						WHERE entity.app_id = NEW.app_id
							AND entity.xmin <> current_transaction
					)
					AND (
						(
							((marker.batch_id = 'fold-baseline:canonical-identity-foundation' AND marker.actor_id = 'system:canonical-identity-foundation')
							OR (marker.batch_id = 'fold-baseline:unified-authoring' AND marker.actor_id = 'system:unified-authoring'))
							AND marker.run_id IS NULL
						)
						OR
						(
							NEW.seq = 1
							AND marker.batch_id = 'genesis:' || marker.app_id
							AND marker.actor_id = app.owner
							AND marker.run_id = app.run_id
						)
					)
			) THEN
				RAISE EXCEPTION 'app_change_fold_baselines insert requires an exact horizon or genesis marker';
			END IF;
			RETURN NEW;
		END
		$function$;

		CREATE OR REPLACE FUNCTION nova_require_app_change_fold_baseline()
		RETURNS trigger
		LANGUAGE plpgsql
		VOLATILE
		NOT LEAKPROOF
		SET search_path = pg_catalog
		AS $function$
		DECLARE
			app_owner text;
			app_run_id text;
		BEGIN
			IF TG_OP <> 'INSERT'
				AND EXISTS (
					SELECT 1
					FROM public.app_change_fold_baselines AS baseline
					WHERE baseline.app_id = OLD.app_id
						AND baseline.seq = OLD.seq
				)
			THEN
				RAISE EXCEPTION
					'app change fold markers are immutable';
			END IF;
			IF TG_OP = 'DELETE' THEN
				RETURN OLD;
			END IF;
			SELECT app.owner, app.run_id
			INTO app_owner, app_run_id
			FROM public.apps AS app
			WHERE app.id = NEW.app_id;
			IF NEW.kind = 'fold-baseline' THEN
				IF NOT (
					NEW.mutations = '[]'::jsonb
					AND NEW.from_project_id IS NULL
					AND NEW.to_project_id IS NULL
					AND (
					(
						((NEW.batch_id = 'fold-baseline:canonical-identity-foundation' AND NEW.actor_id = 'system:canonical-identity-foundation')
							OR (NEW.batch_id = 'fold-baseline:unified-authoring' AND NEW.actor_id = 'system:unified-authoring'))
						AND NEW.run_id IS NULL
					)
					OR
					(
						NEW.seq = 1
						AND NEW.batch_id = 'genesis:' || NEW.app_id
						AND NEW.actor_id = app_owner
						AND NEW.run_id IS NOT DISTINCT FROM app_run_id
					)
					)
				)
				THEN
					RAISE EXCEPTION
						'only an exact fold marker may carry an empty app-change batch';
				END IF;
				IF NOT EXISTS (
					SELECT 1
					FROM public.app_change_fold_baselines AS baseline
					WHERE baseline.app_id = NEW.app_id
						AND baseline.seq = NEW.seq
				)
				THEN
					RAISE EXCEPTION
						'exact horizon and genesis markers require a fold baseline';
				END IF;
			END IF;
			RETURN NEW;
		END
		$function$;

	`.execute(db);
}
