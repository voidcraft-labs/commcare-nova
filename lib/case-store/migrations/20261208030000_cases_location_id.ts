// Add the `location_id` scalar column to `cases`.
//
// A case block's `<update>` can carry a `location_id` key, and CommCare HQ
// stores it as the case's own location column rather than as a property
// (`corehq/form_processor/backends/sql/update_strategy.py::
// SqlCaseUpdateStrategy._apply_update_action`, `CommCareCase.location_id`,
// a 255-character column). Its restore writes the column back as a
// `location_id` element of the case when it holds text
// (`casexml/apps/case/xml/generator.py::V2CaseXMLGenerator.
// add_custom_properties`), and its case search index holds no such property
// (`corehq/pillows/case_search.py::_get_case_properties` reads `case_json` and
// the indexed metadata, which names no location). The case store keeps it the
// same way: a column beside `external_id`, never a JSONB key, read by the
// standard name through `RESERVED_SCALAR_COLUMN_BY_PROPERTY`.
//
// It is an opaque text a form wrote, not one of the Project's places
// (`app_locations`), and it grants no one access to anything.
//
// Nullable with no default: a case no form gave a location holds none.
// Metadata-only `ADD COLUMN` (nullable, no default) is catalog-only on modern
// Postgres and safe while the previous revision serves, which neither reads
// nor writes the column. No index: it is a preview-scale filter target, the
// same sequential-scan budget as `external_id`.
//
// Dual-sourced with the `location_id` field on `CasesTable` in
// `lib/case-store/sql/database.ts` (added in the same change).
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "location_id" text`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "cases" DROP COLUMN IF EXISTS "location_id"`.execute(
		db,
	);
}
