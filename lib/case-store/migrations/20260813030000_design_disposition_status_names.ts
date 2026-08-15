// Disposition statuses are the three words they mean: accepted, rejected,
// deferred. The old compound names carried their own validation rules in the
// value ("rejected-with-rationale" — rationale is a required column of every
// disposition; "deferred-with-user-visible-consequence" — a consequence field
// nothing ever read, deleted with this rename).
//
// Rows written under the old vocabulary exist only in development databases
// (the design pipeline has never served production). The remap rewrites both
// halves of each such row — the constrained `status` column and the payload
// the read path re-parses — so the constraint lands on a populated database
// and the surviving rows read back under the current disposition schema.

import { type Kysely, sql } from "kysely";

const STATUS_CHECK = "design_review_dispositions_status_check";

const STATUSES = "'accepted', 'rejected', 'deferred'";

const ORIGINAL_STATUSES =
	"'accepted', 'rejected-with-rationale', 'deferred-with-user-visible-consequence'";

const RENAME_STATUS = (column: string) => `CASE ${column}
	WHEN 'rejected-with-rationale' THEN 'rejected'
	WHEN 'deferred-with-user-visible-consequence' THEN 'deferred'
	ELSE ${column}
END`;

export async function up(db: Kysely<unknown>): Promise<void> {
	// The old constraint forbids the new names, so it drops before the remap
	// and the new constraint lands after it.
	await sql`
		ALTER TABLE design_review_dispositions
			DROP CONSTRAINT IF EXISTS ${sql.id(STATUS_CHECK)}
	`.execute(db);
	await sql`
		UPDATE design_review_dispositions
		SET
			status = ${sql.raw(RENAME_STATUS("status"))},
			payload = jsonb_set(
				payload - 'userVisibleConsequence',
				'{status}',
				to_jsonb(${sql.raw(RENAME_STATUS("payload->>'status'"))})
			)
		WHERE status IN ('rejected-with-rationale', 'deferred-with-user-visible-consequence')
			OR payload ? 'userVisibleConsequence'
	`.execute(db);
	await sql`
		ALTER TABLE design_review_dispositions
			ADD CONSTRAINT ${sql.id(STATUS_CHECK)}
				CHECK (status IN (${sql.raw(STATUSES)}))
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// The dropped consequence text is unrecoverable; the rename maps back so
	// the restored constraint holds over remapped rows.
	await sql`
		ALTER TABLE design_review_dispositions
			DROP CONSTRAINT IF EXISTS ${sql.id(STATUS_CHECK)}
	`.execute(db);
	await sql`
		UPDATE design_review_dispositions
		SET
			status = CASE status
				WHEN 'rejected' THEN 'rejected-with-rationale'
				WHEN 'deferred' THEN 'deferred-with-user-visible-consequence'
				ELSE status
			END,
			payload = jsonb_set(
				payload,
				'{status}',
				to_jsonb(CASE payload->>'status'
					WHEN 'rejected' THEN 'rejected-with-rationale'
					WHEN 'deferred' THEN 'deferred-with-user-visible-consequence'
					ELSE payload->>'status'
				END)
			)
		WHERE status IN ('rejected', 'deferred')
	`.execute(db);
	await sql`
		ALTER TABLE design_review_dispositions
			ADD CONSTRAINT ${sql.id(STATUS_CHECK)}
				CHECK (status IN (${sql.raw(ORIGINAL_STATUSES)}))
	`.execute(db);
}
