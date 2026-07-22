// Separate chat attribution (`run_id`) from run-holder generation. A thread's
// run id intentionally spans many claims, so it cannot fence a reaped process
// from a later same-thread successor. `run_holder_nonce` is server-minted for
// every claim and remains as the reaper tombstone used by false-reap self-heal.
//
// Holders created by a pre-nonce serving revision remain null/v0 and are
// census-visible. While the compatibility switch is false, lifecycle CAS keeps
// the historical mode/run contract: reapers may clear v0 holders and a resume
// may upgrade its still-paused holder with a fresh server nonce. S02c2 drains
// every remaining v0 holder/receiver before raising the floor and irreversibly
// enabling exact-nonce authority.

import { type Kysely, sql } from "kysely";
import { up as restoreRuntimeReaderRollout } from "./20260722080000_runtime_reader_rollout";

const HOLDER_STAMP_FUNCTION = "nova_stamp_runtime_reader_holder";
const HOLDER_STAMP_TRIGGER = "apps_runtime_reader_holder_stamp";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		DROP TRIGGER IF EXISTS apps_runtime_reader_holder_stamp ON public.apps
	`.execute(db);
	await sql`
		ALTER TABLE public.apps
			ADD COLUMN IF NOT EXISTS run_holder_nonce uuid
	`.execute(db);
	await sql`
		ALTER TABLE public.threads
			ADD COLUMN IF NOT EXISTS active_holder_nonce uuid
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_reference_compatibility
			ADD COLUMN IF NOT EXISTS run_holder_nonce_enforced boolean
				NOT NULL DEFAULT false
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_reference_compatibility
			DROP CONSTRAINT IF EXISTS run_holder_nonce_enforcement_floor_check
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_reference_compatibility
			ADD CONSTRAINT run_holder_nonce_enforcement_floor_check CHECK (
				NOT run_holder_nonce_enforced
				OR minimum_runtime_reader_version >= 1
			)
	`.execute(db);
	await sql
		.raw(`
		CREATE OR REPLACE FUNCTION public.nova_guard_lookup_reference_compatibility_row()
		RETURNS trigger
		LANGUAGE plpgsql
		AS $function$
		BEGIN
			IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
				RAISE EXCEPTION USING
					ERRCODE = '55000',
					MESSAGE = 'lookup-reference compatibility state is permanent';
			END IF;

			IF NEW.minimum_writer_version < OLD.minimum_writer_version
				OR NEW.minimum_stream_receiver_version
					< OLD.minimum_stream_receiver_version
				OR NEW.minimum_runtime_reader_version
					< OLD.minimum_runtime_reader_version
			THEN
				RAISE EXCEPTION USING
					ERRCODE = '23514',
					MESSAGE = 'lookup-reference compatibility floors are monotonic';
			END IF;

			IF OLD.run_holder_nonce_enforced
				AND NOT NEW.run_holder_nonce_enforced
			THEN
				RAISE EXCEPTION USING
					ERRCODE = '23514',
					MESSAGE = 'run-holder nonce enforcement is irreversible';
			END IF;

			RETURN NEW;
		END
		$function$
	`)
		.execute(db);
	// A present holder written before nonce-aware runtime is v0. The newly added
	// column is already NULL, but clear any stale pre-v1 capability stamp so the
	// census reports it honestly. Scope this to NULL nonces: migration replay
	// after v1 traffic must never erase a concrete holder generation.
	await sql`
		UPDATE public.apps
		SET run_runtime_reader_version = NULL
		WHERE (status = 'generating' OR lock_run_id IS NOT NULL)
			AND run_holder_nonce IS NULL
	`.execute(db);

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
			old_nonce uuid;
			new_mode text;
			new_run_id text;
			new_nonce uuid;
			raw_version text;
			runtime_declared boolean;
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
				old_nonce := OLD.run_holder_nonce;
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
			new_nonce := NEW.run_holder_nonce;

			-- No present holder means no runtime capability stamp. The nonce is
			-- deliberately retained as the exact last-holder/reaper tombstone.
			IF new_mode IS NULL THEN
				NEW.run_runtime_reader_version := NULL;
				RETURN NEW;
			END IF;

			raw_version := NULLIF(
				pg_catalog.current_setting('nova.runtime_reader_version', true),
				''
			);
			runtime_declared := raw_version IS NOT NULL;

			-- Ordinary commits, heartbeats, and terminal writes do not redeclare a
			-- runtime version. They may preserve an unchanged holder, but an identity
			-- change without a declaration is a legacy v0 claim.
			IF NOT runtime_declared
				AND old_mode IS NOT DISTINCT FROM new_mode
				AND old_run_id IS NOT DISTINCT FROM new_run_id
				AND old_nonce IS NOT DISTINCT FROM new_nonce
			THEN
				NEW.run_runtime_reader_version := OLD.run_runtime_reader_version;
				RETURN NEW;
			END IF;

			IF NOT runtime_declared THEN
				raw_version := '0';
			END IF;
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

			-- An explicitly declared v0 claim must erase any inherited generation,
			-- even when a same-thread successor happens to reuse mode/run id. Without
			-- this downgrade, an old tab could retain the predecessor's nonce and the
			-- census could falsely bless the v0 successor as v1.
			IF runtime_version < 1 THEN
				IF runtime_version < required_version THEN
					RAISE EXCEPTION USING
						ERRCODE = '55000',
						MESSAGE = 'runtime reader version is below the database floor';
				END IF;
				NEW.run_holder_nonce := NULL;
				NEW.run_runtime_reader_version := NULL;
				RETURN NEW;
			END IF;

			-- A v1+ holder must always carry the full concrete generation.
			IF new_run_id IS NULL OR new_nonce IS NULL THEN
				RAISE EXCEPTION USING
					ERRCODE = '55000',
					MESSAGE = 'runtime holder identity is missing below the database floor';
			END IF;

			IF runtime_version < required_version THEN
				RAISE EXCEPTION USING
					ERRCODE = '55000',
					MESSAGE = 'runtime reader version is below the database floor';
			END IF;

			IF old_mode IS NOT DISTINCT FROM new_mode
				AND old_run_id IS NOT DISTINCT FROM new_run_id
				AND old_nonce IS NOT DISTINCT FROM new_nonce
			THEN
				NEW.run_runtime_reader_version := OLD.run_runtime_reader_version;
				RETURN NEW;
			END IF;

			NEW.run_runtime_reader_version := runtime_version;
			RETURN NEW;
		END;
		$function$
	`)
		.execute(db);

	await sql
		.raw(`
		CREATE TRIGGER ${HOLDER_STAMP_TRIGGER}
		BEFORE INSERT OR UPDATE OF
			status,
			run_id,
			res_period,
			res_run_id,
			lock_run_id,
			awaiting_input,
			lock_expire_at,
			updated_at,
			run_holder_nonce,
			run_runtime_reader_version
		ON public.apps
		FOR EACH ROW
		EXECUTE FUNCTION public.${HOLDER_STAMP_FUNCTION}();
	`)
		.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		DROP TRIGGER IF EXISTS apps_runtime_reader_holder_stamp ON public.apps
	`.execute(db);
	await sql`
		DROP FUNCTION IF EXISTS public.nova_stamp_runtime_reader_holder()
	`.execute(db);
	await sql`
		ALTER TABLE public.threads DROP COLUMN IF EXISTS active_holder_nonce
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_reference_compatibility
			DROP CONSTRAINT IF EXISTS run_holder_nonce_enforcement_floor_check
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_reference_compatibility
			DROP COLUMN IF EXISTS run_holder_nonce_enforced
	`.execute(db);
	await sql
		.raw(`
		CREATE OR REPLACE FUNCTION public.nova_guard_lookup_reference_compatibility_row()
		RETURNS trigger
		LANGUAGE plpgsql
		AS $function$
		BEGIN
			IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
				RAISE EXCEPTION USING
					ERRCODE = '55000',
					MESSAGE = 'lookup-reference compatibility state is permanent';
			END IF;

			IF NEW.minimum_writer_version < OLD.minimum_writer_version
				OR NEW.minimum_stream_receiver_version
					< OLD.minimum_stream_receiver_version
				OR NEW.minimum_runtime_reader_version
					< OLD.minimum_runtime_reader_version
			THEN
				RAISE EXCEPTION USING
					ERRCODE = '23514',
					MESSAGE = 'lookup-reference compatibility floors are monotonic';
			END IF;

			RETURN NEW;
		END
		$function$
	`)
		.execute(db);
	await sql`
		ALTER TABLE public.apps DROP COLUMN IF EXISTS run_holder_nonce
	`.execute(db);
	await restoreRuntimeReaderRollout(db);
}
