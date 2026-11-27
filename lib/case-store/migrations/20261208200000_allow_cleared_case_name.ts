import { type Kysely, sql } from "kysely";

// CommCare preserves a present, unanswered calendar-day write as a cleared
// case name. New cases and ordinary renames still require a nonblank name.
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "cases" DROP CONSTRAINT IF EXISTS "cases_case_name_check"`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "cases" ADD CONSTRAINT "cases_case_name_check" CHECK (length(case_name) > 0)`.execute(
		db,
	);
}
