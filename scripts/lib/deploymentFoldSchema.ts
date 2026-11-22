import { type Kysely, sql } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";

/** The scan also runs on the deployed database before its migration. Admit
 * exactly the previous storage or the candidate. A missing relation in the
 * middle of an install is never grounds to disregard existing certificates. */
export async function deploymentFoldSchema(
	db: Kysely<AppDatabase>,
): Promise<"prior" | "certificates"> {
	const result = await sql<{
		table_kind: string | null;
		columns: string[];
		constraints: string[];
		immutable: string | null;
		claim_trigger: string | null;
		trigger_body: string | null;
		installed: boolean;
	}>`
		WITH objects AS (
			SELECT to_regclass('public.app_deployment_baselines') AS baseline,
				to_regclass('public.app_deployment_fold_references') AS cert,
				to_regprocedure('public.nova_reject_deployment_fold_reference_update()') AS guard
		)
		SELECT (SELECT relkind FROM pg_class WHERE oid = cert) AS table_kind,
			ARRAY(SELECT (CASE WHEN a.attrelid = cert THEN 'certificate.' ELSE 'baseline.' END)
					|| a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
					|| CASE WHEN a.attnotnull THEN ' required' ELSE '' END
					|| CASE WHEN a.atthasdef THEN ' default' ELSE '' END
				FROM pg_attribute a
				WHERE a.attnum > 0 AND NOT a.attisdropped AND
					(a.attrelid = cert OR (a.attrelid = baseline AND
						a.attname IN ('reference_fold_seq', 'reference_source_digest', 'readback_push_token', 'readback_source_digest')))) AS columns,
			ARRAY(SELECT (CASE WHEN c.conrelid = cert THEN 'certificate ' ELSE 'baseline ' END)
					|| replace(pg_get_constraintdef(c.oid, true), 'public.', '')
				FROM pg_constraint c WHERE
					(c.conrelid = cert AND c.contype IN ('p','c','f','u','x')) OR
					(c.conrelid = baseline AND c.conname IN
						('app_deployment_baselines_reference', 'app_deployment_baselines_reference_pair'))) AS constraints,
			(SELECT concat_ws(' ', t.tgname, t.tgenabled, t.tgtype, t.tgfoid = guard,
					t.tgqual IS NULL AND t.tgattr = ''::int2vector)
				FROM pg_trigger t WHERE t.tgrelid = cert
					AND t.tgname = 'app_deployment_fold_reference_immutable') AS immutable,
			(SELECT replace(pg_get_triggerdef(t.oid, true), 'public.', '') || ' ' || t.tgenabled::text
				FROM pg_trigger t WHERE t.tgrelid = 'public.app_deployment_resources'::regclass
					AND t.tgname = 'app_deployment_resources_claim_token') AS claim_trigger,
			(SELECT p.prosrc FROM pg_proc p WHERE p.oid = guard) AS trigger_body,
			EXISTS (SELECT 1 FROM public.kysely_migration
				WHERE name = '20261204000000_deployment_fold_references') AS installed
		FROM objects`.execute(db);
	const schema = result.rows[0];
	if (!schema) throw new Error("The database returned no deployment schema.");
	if (
		!schema.installed &&
		schema.table_kind === null &&
		!schema.columns.length &&
		!schema.constraints.length &&
		schema.trigger_body === null &&
		schema.claim_trigger === null
	)
		return "prior";
	const columns = [
		"baseline.readback_push_token uuid",
		"baseline.readback_source_digest text",
		"baseline.reference_fold_seq bigint",
		"baseline.reference_source_digest text",
		"certificate.app_id text required",
		"certificate.deployment_id uuid required",
		"certificate.fold_seq bigint required",
		"certificate.mapping_id uuid required",
		"certificate.original_source_digest text required",
		"certificate.published_revision bigint required",
		"certificate.state jsonb required",
	];
	const constraints = [
		"certificate PRIMARY KEY (deployment_id, fold_seq)",
		"certificate FOREIGN KEY (deployment_id) REFERENCES app_deployments(id) ON DELETE CASCADE",
		"certificate FOREIGN KEY (mapping_id) REFERENCES app_deployment_resources(id)",
		"certificate FOREIGN KEY (app_id, fold_seq) REFERENCES app_change_fold_baselines(app_id, seq) DEFERRABLE INITIALLY DEFERRED",
		"certificate CHECK (published_revision >= 0 AND published_revision < fold_seq)",
		"certificate CHECK (original_source_digest ~ '^[0-9a-f]{64}$'::text)",
		"certificate CHECK (jsonb_typeof(state) = 'object'::text)",
		"baseline FOREIGN KEY (deployment_id, reference_fold_seq) REFERENCES app_deployment_fold_references(deployment_id, fold_seq)",
		"baseline CHECK (reference_fold_seq IS NULL AND reference_source_digest IS NULL OR reference_fold_seq IS NOT NULL AND reference_source_digest IS NOT NULL AND source_digest IS NOT NULL AND reference_source_digest = source_digest AND nova_revision IS NOT NULL AND nova_revision < reference_fold_seq AND (origin = ANY (ARRAY['push'::text, 'changes'::text, 'read'::text])))",
	];
	if (
		schema.table_kind === "r" &&
		equalSet(schema.columns, columns) &&
		equalSet(schema.constraints, constraints) &&
		schema.claim_trigger ===
			"CREATE TRIGGER app_deployment_resources_claim_token BEFORE UPDATE OF released_at ON app_deployment_resources FOR EACH ROW WHEN (old.released_at IS DISTINCT FROM new.released_at) EXECUTE FUNCTION rotate_deployment_push_token() O" &&
		schema.immutable === "app_deployment_fold_reference_immutable O 19 t t" &&
		schema.trigger_body?.trim() ===
			"BEGIN RAISE EXCEPTION 'A certified deployment reference is immutable'; END"
	)
		return "certificates";
	throw new Error(
		"The deployment fold schema is incomplete or differs from the candidate migration. Check its columns, constraints and claim and immutability triggers.",
	);
}

function equalSet(actual: string[], expected: string[]): boolean {
	return (
		actual.length === expected.length &&
		expected.every((item) => actual.includes(item))
	);
}
