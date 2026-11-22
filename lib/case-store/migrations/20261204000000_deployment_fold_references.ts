import { type Kysely, sql } from "kysely";

/** A conversion binds each published revision to its own certified document.
 * Existing deployments gain a pointer only when an operator writes a fold. */
export async function up(db: Kysely<unknown>): Promise<void> {
	// Acquire the existing FK parents and baseline together. A busy writer can
	// finish or the migration can retry without holding a subset while waiting.
	await sql`DO $acquire$
		DECLARE deadline timestamptz := clock_timestamp() + interval '5 seconds';
		BEGIN LOOP
			BEGIN
				LOCK TABLE public.app_deployment_baselines IN ACCESS EXCLUSIVE MODE NOWAIT;
				LOCK TABLE public.app_deployments, public.app_deployment_resources,
					public.app_change_fold_baselines IN SHARE ROW EXCLUSIVE MODE NOWAIT;
				RETURN;
			EXCEPTION WHEN lock_not_available THEN
				IF clock_timestamp() >= deadline THEN RAISE; END IF;
			END;
			PERFORM pg_sleep(0.05);
		END LOOP; END $acquire$`.execute(db);
	await sql`
		CREATE TABLE IF NOT EXISTS public.app_deployment_fold_references (
			deployment_id uuid NOT NULL REFERENCES public.app_deployments(id) ON DELETE CASCADE,
			fold_seq bigint NOT NULL,
			app_id text NOT NULL,
			mapping_id uuid NOT NULL REFERENCES public.app_deployment_resources(id),
			published_revision bigint NOT NULL CHECK (published_revision >= 0 AND published_revision < fold_seq),
			original_source_digest text NOT NULL CHECK (original_source_digest ~ '^[0-9a-f]{64}$'),
			state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
			PRIMARY KEY (deployment_id, fold_seq),
			FOREIGN KEY (app_id, fold_seq) REFERENCES public.app_change_fold_baselines(app_id, seq)
				DEFERRABLE INITIALLY DEFERRED
		)
	`.execute(db);
	await sql`
		CREATE OR REPLACE FUNCTION public.nova_reject_deployment_fold_reference_update()
		RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
		BEGIN RAISE EXCEPTION 'A certified deployment reference is immutable'; END $body$;
		CREATE OR REPLACE TRIGGER app_deployment_fold_reference_immutable
			BEFORE UPDATE ON public.app_deployment_fold_references FOR EACH ROW
			EXECUTE FUNCTION public.nova_reject_deployment_fold_reference_update()
	`.execute(db);
	// A remote read belongs to one continuous claim. A release and restore
	// must fence an observation even if they both finish during that read.
	await sql`CREATE OR REPLACE TRIGGER app_deployment_resources_claim_token
		BEFORE UPDATE OF released_at ON public.app_deployment_resources FOR EACH ROW
		WHEN (OLD.released_at IS DISTINCT FROM NEW.released_at)
		EXECUTE FUNCTION public.rotate_deployment_push_token()`.execute(db);
	await sql`ALTER TABLE public.app_deployment_baselines
		ADD COLUMN IF NOT EXISTS reference_fold_seq bigint,
		ADD COLUMN IF NOT EXISTS reference_source_digest text
	`.execute(db);
	await sql`
		DO $body$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.app_deployment_baselines'::regclass
				AND conname = 'app_deployment_baselines_reference') THEN
				ALTER TABLE public.app_deployment_baselines
					ADD CONSTRAINT app_deployment_baselines_reference FOREIGN KEY (deployment_id, reference_fold_seq)
						REFERENCES public.app_deployment_fold_references(deployment_id, fold_seq),
					ADD CONSTRAINT app_deployment_baselines_reference_pair CHECK (
						(reference_fold_seq IS NULL AND reference_source_digest IS NULL) OR
						(reference_fold_seq IS NOT NULL AND reference_source_digest IS NOT NULL
							AND source_digest IS NOT NULL AND reference_source_digest = source_digest
							AND nova_revision IS NOT NULL AND nova_revision < reference_fold_seq
							AND origin IN ('push','changes','read'))
					);
			END IF;
		END $body$
	`.execute(db);
}

export async function down(): Promise<void> {
	throw new Error(
		"Removing certified comparison points would discard published revisions.",
	);
}
