// Serialize every Better Auth Project-membership mutation with Nova's
// membership-dependent app transactions, including missing-row decisions.
//
// INSERT / UPDATE / DELETE take one EXCLUSIVE transaction-scoped advisory lock
// in a BEFORE STATEMENT trigger, before PostgreSQL can lock any membership
// tuple. Nova's app transactions take the matching SHARED lock before reading
// membership. This ordering avoids tuple/advisory inversions and covers
// zero-row DML.
//
// Once PostgreSQL reaches the BEFORE TRUNCATE trigger, it rejects without
// waiting on the advisory gate. PostgreSQL takes ACCESS EXCLUSIVE on the table
// before firing that trigger, so ordinary table-lock waiting may still occur;
// adding an advisory wait there could deadlock with an app transaction that
// already owns the shared gate and is about to read `auth_member`.

import { type Kysely, sql } from "kysely";
import {
	PROJECT_MEMBERSHIP_GATE_KEY,
	PROJECT_MEMBERSHIP_GATE_NAMESPACE,
} from "../../db/projectMembershipGate";

const LOCK_FUNCTION = "nova_lock_auth_member_membership_gate";
const TRUNCATE_FUNCTION = "nova_reject_auth_member_truncate";
const DML_TRIGGER = "nova_auth_member_membership_gate";
const TRUNCATE_TRIGGER = "nova_auth_member_reject_truncate";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql
		.raw(`
		CREATE OR REPLACE FUNCTION public.${LOCK_FUNCTION}()
		RETURNS trigger
		LANGUAGE plpgsql
		SET search_path = pg_catalog
		AS $function$
		BEGIN
			PERFORM pg_catalog.pg_advisory_xact_lock(
				${PROJECT_MEMBERSHIP_GATE_NAMESPACE},
				${PROJECT_MEMBERSHIP_GATE_KEY}
			);
			RETURN NULL;
		END;
		$function$
	`)
		.execute(db);

	await sql
		.raw(`
		CREATE OR REPLACE FUNCTION public.${TRUNCATE_FUNCTION}()
		RETURNS trigger
		LANGUAGE plpgsql
		SET search_path = pg_catalog
		AS $function$
		BEGIN
			RAISE EXCEPTION USING
				ERRCODE = '55000',
				MESSAGE = 'TRUNCATE auth_member is prohibited; use membership DML.';
		END;
		$function$
	`)
		.execute(db);

	await sql
		.raw(`
		DROP TRIGGER IF EXISTS ${DML_TRIGGER} ON public.auth_member;
		CREATE TRIGGER ${DML_TRIGGER}
		BEFORE INSERT OR UPDATE OR DELETE ON public.auth_member
		FOR EACH STATEMENT
		EXECUTE FUNCTION public.${LOCK_FUNCTION}()
	`)
		.execute(db);

	await sql
		.raw(`
		DROP TRIGGER IF EXISTS ${TRUNCATE_TRIGGER} ON public.auth_member;
		CREATE TRIGGER ${TRUNCATE_TRIGGER}
		BEFORE TRUNCATE ON public.auth_member
		FOR EACH STATEMENT
		EXECUTE FUNCTION public.${TRUNCATE_FUNCTION}()
	`)
		.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql
		.raw(`
		DROP TRIGGER IF EXISTS ${TRUNCATE_TRIGGER} ON public.auth_member;
		DROP TRIGGER IF EXISTS ${DML_TRIGGER} ON public.auth_member;
		DROP FUNCTION IF EXISTS public.${TRUNCATE_FUNCTION}();
		DROP FUNCTION IF EXISTS public.${LOCK_FUNCTION}()
	`)
		.execute(db);
}
