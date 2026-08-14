// Disposition statuses are the three words they mean: accepted, rejected,
// deferred. The old compound names carried their own validation rules in the
// value ("rejected-with-rationale" — rationale is a required column of every
// disposition; "deferred-with-user-visible-consequence" — a consequence field
// nothing ever read, deleted with this rename).

import { type Kysely, sql } from "kysely";

const STATUS_CHECK = "design_review_dispositions_status_check";

const STATUSES = "'accepted', 'rejected', 'deferred'";

const ORIGINAL_STATUSES =
	"'accepted', 'rejected-with-rationale', 'deferred-with-user-visible-consequence'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE design_review_dispositions
			DROP CONSTRAINT IF EXISTS ${sql.id(STATUS_CHECK)},
			ADD CONSTRAINT ${sql.id(STATUS_CHECK)}
				CHECK (status IN (${sql.raw(STATUSES)}))
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE design_review_dispositions
			DROP CONSTRAINT IF EXISTS ${sql.id(STATUS_CHECK)},
			ADD CONSTRAINT ${sql.id(STATUS_CHECK)}
				CHECK (status IN (${sql.raw(ORIGINAL_STATUSES)}))
	`.execute(db);
}
