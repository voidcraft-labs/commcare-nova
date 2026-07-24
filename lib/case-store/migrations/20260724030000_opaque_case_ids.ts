// Widen the case-identity column family from `uuid` to `text`, activating
// opaque CommCare wire ids as first-class storage. The five columns are
// `cases.case_id`, `cases.parent_case_id`, `case_indices.case_id`,
// `case_indices.ancestor_id`, and `parked_case_values.case_id`; every other
// identity artifact follows structurally — the `cases` PK and the
// `case_indices` PK/indexes rebuild inside their ALTERs, the
// `parked_case_values` FK is dropped and re-added around its column's
// widening so it never spans a uuid/text mismatch, and Nova-generated ids
// keep `uuidv7()::text` as the column default.
//
// `cases` lives in `nova_case_runtime` once privilege convergence has run
// (production) and in `public` before it (local dev, the test harness), so
// the block resolves that schema explicitly instead of trusting the
// connection search path; `case_indices` and `parked_case_values` are
// migration-owned and always `public`.
//
// Each ALTER guards on the column's current type, so the ledger-erase
// replay over an already-widened schema no-ops. Every `ALTER TYPE` takes
// ACCESS EXCLUSIVE with a table rewrite; the deploy-blocking Job runs it
// while the previous revision serves. That revision's writers have no
// single consistent acquisition order across this family (inserts take
// `cases` then `case_indices`; sample reset takes `case_indices` first;
// schema edits and parked-review writes take `cases` then
// `parked_case_values`), so no DDL ordering can rule a deadlock out
// statically. Instead the block acquires all three tables UP FRONT in
// the majority writer order under a short `lock_timeout`: a collision
// with an in-flight writer fails this transaction fast — BEFORE any
// rewrite work — and the Job rerun is a plain build re-trigger, rather
// than the deadlock detector cancelling a mid-rewrite migration. `down`
// exists for local/test teardown only and assumes every stored id still
// casts back to `uuid`.

import { type Kysely, sql } from "kysely";

function columnIsUuid(schemaExpr: string, table: string, column: string) {
	return `(
		SELECT atttypid = 'uuid'::regtype FROM pg_attribute
		 WHERE attrelid = format('%I.%I', ${schemaExpr}, '${table}')::regclass
		   AND attname = '${column}'
	)`;
}

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`DO $$
		DECLARE
			cases_schema text;
		BEGIN
			SELECT n.nspname INTO cases_schema
			  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE c.oid = COALESCE(
				to_regclass('nova_case_runtime.cases'),
				to_regclass('public.cases')
			 );
			IF cases_schema IS NULL THEN
				RAISE EXCEPTION 'cases table not found in nova_case_runtime or public — the baseline migration must run first';
			END IF;

			EXECUTE 'SET LOCAL lock_timeout = ''5s''';
			EXECUTE format('LOCK TABLE %I.cases IN ACCESS EXCLUSIVE MODE', cases_schema);
			EXECUTE 'LOCK TABLE public.case_indices IN ACCESS EXCLUSIVE MODE';
			EXECUTE 'LOCK TABLE public.parked_case_values IN ACCESS EXCLUSIVE MODE';
			EXECUTE 'SET LOCAL lock_timeout = 0';

			EXECUTE 'ALTER TABLE public.parked_case_values DROP CONSTRAINT IF EXISTS parked_case_values_case_id_fkey';

			IF ${sql.raw(columnIsUuid("cases_schema", "cases", "case_id"))} THEN
				EXECUTE format('ALTER TABLE %I.cases ALTER COLUMN case_id DROP DEFAULT', cases_schema);
				EXECUTE format('ALTER TABLE %I.cases ALTER COLUMN case_id TYPE text USING case_id::text', cases_schema);
			END IF;
			EXECUTE format('ALTER TABLE %I.cases ALTER COLUMN case_id SET DEFAULT uuidv7()::text', cases_schema);

			IF ${sql.raw(columnIsUuid("cases_schema", "cases", "parent_case_id"))} THEN
				EXECUTE format('ALTER TABLE %I.cases ALTER COLUMN parent_case_id TYPE text USING parent_case_id::text', cases_schema);
			END IF;

			IF ${sql.raw(columnIsUuid("'public'", "case_indices", "case_id"))} THEN
				ALTER TABLE public.case_indices ALTER COLUMN case_id TYPE text USING case_id::text;
			END IF;
			IF ${sql.raw(columnIsUuid("'public'", "case_indices", "ancestor_id"))} THEN
				ALTER TABLE public.case_indices ALTER COLUMN ancestor_id TYPE text USING ancestor_id::text;
			END IF;

			IF ${sql.raw(columnIsUuid("'public'", "parked_case_values", "case_id"))} THEN
				ALTER TABLE public.parked_case_values ALTER COLUMN case_id TYPE text USING case_id::text;
			END IF;

			EXECUTE format(
				'ALTER TABLE public.parked_case_values ADD CONSTRAINT parked_case_values_case_id_fkey FOREIGN KEY (case_id) REFERENCES %I.cases (case_id) ON DELETE CASCADE',
				cases_schema
			);
		END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DO $$
		DECLARE
			cases_schema text;
		BEGIN
			SELECT n.nspname INTO cases_schema
			  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE c.oid = COALESCE(
				to_regclass('nova_case_runtime.cases'),
				to_regclass('public.cases')
			 );
			IF cases_schema IS NULL THEN
				RETURN;
			END IF;

			EXECUTE 'ALTER TABLE public.parked_case_values DROP CONSTRAINT IF EXISTS parked_case_values_case_id_fkey';
			EXECUTE 'ALTER TABLE public.parked_case_values ALTER COLUMN case_id TYPE uuid USING case_id::uuid';
			EXECUTE 'ALTER TABLE public.case_indices ALTER COLUMN ancestor_id TYPE uuid USING ancestor_id::uuid';
			EXECUTE 'ALTER TABLE public.case_indices ALTER COLUMN case_id TYPE uuid USING case_id::uuid';
			EXECUTE format('ALTER TABLE %I.cases ALTER COLUMN parent_case_id TYPE uuid USING parent_case_id::uuid', cases_schema);
			EXECUTE format('ALTER TABLE %I.cases ALTER COLUMN case_id DROP DEFAULT', cases_schema);
			EXECUTE format('ALTER TABLE %I.cases ALTER COLUMN case_id TYPE uuid USING case_id::uuid', cases_schema);
			EXECUTE format('ALTER TABLE %I.cases ALTER COLUMN case_id SET DEFAULT uuidv7()', cases_schema);
			EXECUTE format(
				'ALTER TABLE public.parked_case_values ADD CONSTRAINT parked_case_values_case_id_fkey FOREIGN KEY (case_id) REFERENCES %I.cases (case_id) ON DELETE CASCADE',
				cases_schema
			);
		END $$`.execute(db);
}
