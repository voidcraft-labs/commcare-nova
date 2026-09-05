/** Extend the installed private-construction handle constraint before enabling entry points. */
import { type Kysely, sql } from "kysely";

const KIND_CHECK = "design_change_set_handles_entity_kind_check";
const PREVIOUS_KINDS =
	"'module', 'form', 'field', 'option', 'case_list_column', 'search_input', 'case_operation', " +
	"'worker_property', 'user_type', 'persona', 'organization_level', 'location_property', " +
	"'automation', 'automation_criterion', 'automation_setup_criterion', 'automation_update', " +
	"'automation_recipient', 'automation_event', 'automation_user_data_filter'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE design_change_set_handles DROP CONSTRAINT IF EXISTS ${sql.id(KIND_CHECK)}, ADD CONSTRAINT ${sql.id(KIND_CHECK)} CHECK (entity_kind IN (${sql.raw(`${PREVIOUS_KINDS}, 'entry_point'`)}))`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE design_change_set_handles DROP CONSTRAINT IF EXISTS ${sql.id(KIND_CHECK)}, ADD CONSTRAINT ${sql.id(KIND_CHECK)} CHECK (entity_kind IN (${sql.raw(PREVIOUS_KINDS)}))`.execute(
		db,
	);
}
