// Runtime-reader holder stamping and traffic-epoch rollout state.
//
// The database owns holder identity so no lifecycle call site can accidentally
// restamp an old run as new code. Claims lock the app row first; this row trigger
// then locks the compatibility singleton FOR SHARE. A runtime-floor raise takes
// the deployment-cutover gate, locks compatibility FOR UPDATE, and performs a
// plain MVCC census without locking app rows. Those two winner orders are both
// safe and avoid a compatibility-row -> app-row lock inversion.
//
// Compatibility and epoch DML take the deployment-cutover advisory gate in
// BEFORE STATEMENT triggers—before tuple locks. Epoch TRUNCATE rejects directly
// without advisory waiting because PostgreSQL already holds ACCESS EXCLUSIVE by
// the time a TRUNCATE trigger fires.

import { type Kysely, sql } from "kysely";
import {
	DEPLOYMENT_CUTOVER_GATE_KEY,
	DEPLOYMENT_CUTOVER_GATE_NAMESPACE,
} from "../../db/deploymentCutoverGate";

const CUTOVER_LOCK_FUNCTION = "nova_lock_deployment_cutover_gate";
const EPOCH_TRUNCATE_FUNCTION = "nova_reject_runtime_epoch_truncate";
const HOLDER_STAMP_FUNCTION = "nova_stamp_runtime_reader_holder";
const COMPATIBILITY_DML_TRIGGER = "lookup_reference_compatibility_cutover_gate";
const EPOCH_DML_TRIGGER = "runtime_reader_traffic_epochs_cutover_gate";
const EPOCH_TRUNCATE_TRIGGER = "runtime_reader_traffic_epochs_reject_truncate";
const HOLDER_STAMP_TRIGGER = "apps_runtime_reader_holder_stamp";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE public.apps
			ADD COLUMN IF NOT EXISTS run_runtime_reader_version integer
				CHECK (
					run_runtime_reader_version IS NULL
					OR run_runtime_reader_version >= 0
				)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS apps_runtime_reader_holder_census_idx
			ON public.apps (run_runtime_reader_version, id)
			WHERE status = 'generating' OR lock_run_id IS NOT NULL
	`.execute(db);

	await sql`
		ALTER TABLE public.lookup_reference_compatibility
			ADD COLUMN IF NOT EXISTS continuous_registry_traffic_since timestamptz(3)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS public.runtime_reader_traffic_epochs (
			target_version integer PRIMARY KEY CHECK (target_version > 0),
			continuous_traffic_since timestamptz(3) NOT NULL
				DEFAULT clock_timestamp()
		)
	`.execute(db);

	await sql
		.raw(`
		CREATE OR REPLACE FUNCTION public.${CUTOVER_LOCK_FUNCTION}()
		RETURNS trigger
		LANGUAGE plpgsql
		SET search_path = pg_catalog
		AS $function$
		BEGIN
			PERFORM pg_catalog.pg_advisory_xact_lock(
				${DEPLOYMENT_CUTOVER_GATE_NAMESPACE},
				${DEPLOYMENT_CUTOVER_GATE_KEY}
			);
			RETURN NULL;
		END;
		$function$
	`)
		.execute(db);

	await sql
		.raw(`
		CREATE OR REPLACE FUNCTION public.${EPOCH_TRUNCATE_FUNCTION}()
		RETURNS trigger
		LANGUAGE plpgsql
		SET search_path = pg_catalog
		AS $function$
		BEGIN
			RAISE EXCEPTION USING
				ERRCODE = '55000',
				MESSAGE = 'TRUNCATE runtime_reader_traffic_epochs is prohibited; delete explicit targets.';
		END;
		$function$
	`)
		.execute(db);

	await sql
		.raw(`
		CREATE OR REPLACE FUNCTION public.${HOLDER_STAMP_FUNCTION}()
		RETURNS trigger
		LANGUAGE plpgsql
		SET search_path = pg_catalog
		AS $function$
		DECLARE
			old_mode text;
			old_run_id text;
			new_mode text;
			new_run_id text;
			raw_version text;
			runtime_version integer;
			required_version integer;
		BEGIN
			IF TG_OP <> 'INSERT' THEN
				IF OLD.status = 'generating' THEN
					old_mode := 'build';
					old_run_id := CASE
						WHEN OLD.res_period IS NULL THEN NULLIF(OLD.run_id, '')
						ELSE NULLIF(OLD.res_run_id, '')
					END;
				ELSIF OLD.lock_run_id IS NOT NULL THEN
					old_mode := 'edit';
					old_run_id := NULLIF(OLD.lock_run_id, '');
				END IF;
			END IF;

			IF NEW.status = 'generating' THEN
				new_mode := 'build';
				new_run_id := CASE
					WHEN NEW.res_period IS NULL THEN NULLIF(NEW.run_id, '')
					ELSE NULLIF(NEW.res_run_id, '')
				END;
			ELSIF NEW.lock_run_id IS NOT NULL THEN
				new_mode := 'edit';
				new_run_id := NULLIF(NEW.lock_run_id, '');
			END IF;

			-- An absent holder never retains a stale operational stamp.
			IF new_mode IS NULL THEN
				NEW.run_runtime_reader_version := NULL;
				RETURN NEW;
			END IF;

			-- Heartbeats, paused resumes, and build reservation booking preserve the
			-- original stamp. In particular, a reserved build never falls back to the
			-- row run id when its reservation identity is missing.
			IF old_mode IS NOT DISTINCT FROM new_mode
				AND old_run_id IS NOT DISTINCT FROM new_run_id
			THEN
				NEW.run_runtime_reader_version := OLD.run_runtime_reader_version;
				RETURN NEW;
			END IF;

			SELECT compatibility.minimum_runtime_reader_version
			INTO required_version
			FROM public.lookup_reference_compatibility AS compatibility
			WHERE compatibility.id = 1
			FOR SHARE;

			IF NOT FOUND THEN
				RAISE EXCEPTION USING
					ERRCODE = '55000',
					MESSAGE = 'lookup-reference compatibility state is missing';
			END IF;

			-- Legacy/corrupt present identities are representable only while the
			-- runtime floor is zero. They remain unstamped and census as version zero.
			IF new_run_id IS NULL THEN
				IF required_version > 0 THEN
					RAISE EXCEPTION USING
						ERRCODE = '55000',
						MESSAGE = 'runtime holder identity is missing below the database floor';
				END IF;
				NEW.run_runtime_reader_version := NULL;
				RETURN NEW;
			END IF;

			raw_version := COALESCE(
				NULLIF(pg_catalog.current_setting('nova.runtime_reader_version', true), ''),
				'0'
			);
			IF raw_version !~ '^(0|[1-9][0-9]*)$' THEN
				RAISE EXCEPTION USING
					ERRCODE = '22023',
					MESSAGE = 'invalid nova.runtime_reader_version';
			ELSE
				BEGIN
					runtime_version := raw_version::integer;
				EXCEPTION
					WHEN numeric_value_out_of_range THEN
						RAISE EXCEPTION USING
							ERRCODE = '22023',
							MESSAGE = 'invalid nova.runtime_reader_version';
				END;
			END IF;

			IF runtime_version < required_version THEN
				RAISE EXCEPTION USING
					ERRCODE = '55000',
					MESSAGE = 'runtime reader version is below the database floor';
			END IF;

			NEW.run_runtime_reader_version := runtime_version;
			RETURN NEW;
		END;
		$function$
	`)
		.execute(db);

	await sql
		.raw(`
		DROP TRIGGER IF EXISTS ${COMPATIBILITY_DML_TRIGGER}
		ON public.lookup_reference_compatibility;
		CREATE TRIGGER ${COMPATIBILITY_DML_TRIGGER}
		BEFORE INSERT OR UPDATE OR DELETE
		ON public.lookup_reference_compatibility
		FOR EACH STATEMENT
		EXECUTE FUNCTION public.${CUTOVER_LOCK_FUNCTION}();

		DROP TRIGGER IF EXISTS ${EPOCH_DML_TRIGGER}
		ON public.runtime_reader_traffic_epochs;
		CREATE TRIGGER ${EPOCH_DML_TRIGGER}
		BEFORE INSERT OR UPDATE OR DELETE
		ON public.runtime_reader_traffic_epochs
		FOR EACH STATEMENT
		EXECUTE FUNCTION public.${CUTOVER_LOCK_FUNCTION}();

		DROP TRIGGER IF EXISTS ${EPOCH_TRUNCATE_TRIGGER}
		ON public.runtime_reader_traffic_epochs;
		CREATE TRIGGER ${EPOCH_TRUNCATE_TRIGGER}
		BEFORE TRUNCATE ON public.runtime_reader_traffic_epochs
		FOR EACH STATEMENT
		EXECUTE FUNCTION public.${EPOCH_TRUNCATE_FUNCTION}();

		DROP TRIGGER IF EXISTS ${HOLDER_STAMP_TRIGGER} ON public.apps;
		CREATE TRIGGER ${HOLDER_STAMP_TRIGGER}
		BEFORE INSERT OR UPDATE OF
			status,
			run_id,
			res_period,
			res_run_id,
			lock_run_id,
			run_runtime_reader_version
		ON public.apps
		FOR EACH ROW
		EXECUTE FUNCTION public.${HOLDER_STAMP_FUNCTION}();
	`)
		.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql
		.raw(`
		DROP TRIGGER IF EXISTS ${HOLDER_STAMP_TRIGGER} ON public.apps;
		DROP TRIGGER IF EXISTS ${EPOCH_TRUNCATE_TRIGGER}
			ON public.runtime_reader_traffic_epochs;
		DROP TRIGGER IF EXISTS ${EPOCH_DML_TRIGGER}
			ON public.runtime_reader_traffic_epochs;
		DROP TRIGGER IF EXISTS ${COMPATIBILITY_DML_TRIGGER}
			ON public.lookup_reference_compatibility;
		DROP FUNCTION IF EXISTS public.${HOLDER_STAMP_FUNCTION}();
		DROP FUNCTION IF EXISTS public.${EPOCH_TRUNCATE_FUNCTION}();
		DROP FUNCTION IF EXISTS public.${CUTOVER_LOCK_FUNCTION}();
	`)
		.execute(db);

	await sql`DROP TABLE IF EXISTS public.runtime_reader_traffic_epochs`.execute(
		db,
	);
	await sql`DROP INDEX IF EXISTS public.apps_runtime_reader_holder_census_idx`.execute(
		db,
	);
	await sql`
		ALTER TABLE public.lookup_reference_compatibility
			DROP COLUMN IF EXISTS continuous_registry_traffic_since
	`.execute(db);
	await sql`
		ALTER TABLE public.apps
			DROP COLUMN IF EXISTS run_runtime_reader_version
	`.execute(db);
}
