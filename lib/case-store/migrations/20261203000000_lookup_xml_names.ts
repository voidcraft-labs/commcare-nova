import { type Kysely, sql } from "kysely";

// XML 1.0, fifth edition, NameStartChar and NameChar without the namespace
// separator. Freeze the ranges in this migration. A later runtime grammar
// change must never change the catalog a previous migration installs.
const start =
	"A-Z_a-z" +
	"\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF" +
	"\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF" +
	"\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}";
const continuation = `${start}0-9.\u00B7\u0300-\u036F\u203F-\u2040-`;
const xmlName = `^[${start}][${continuation}]*$`;
const previousName = "^[A-Za-z_][A-Za-z0-9_-]*$";

// Take the two ALTER locks as one bounded acquisition. A failed NOWAIT
// releases locks taken inside its subtransaction before the next attempt.
async function lockTables(db: Kysely<unknown>): Promise<void> {
	await sql`
		DO $$
		DECLARE deadline constant timestamptz := clock_timestamp() + interval '5 seconds';
		BEGIN
			LOOP
				BEGIN
					LOCK TABLE public.lookup_tables, public.lookup_columns IN ACCESS EXCLUSIVE MODE NOWAIT;
					RETURN;
				EXCEPTION WHEN lock_not_available THEN
					IF clock_timestamp() >= deadline THEN RAISE; END IF;
				END;
				PERFORM pg_sleep(0.05);
			END LOOP;
		END $$
	`.execute(db);
}

function nameCheck(column: "tag" | "wire_name", xml: boolean) {
	const name = sql.id(column);
	// "C" makes bracket ranges compare code points regardless of the
	// database locale. On rollback restore the preceding catalog definition.
	const grammar = xml
		? sql`${name} COLLATE "C" ~ ${sql.lit(xmlName)}`
		: sql`${name} ~ ${sql.lit(previousName)}`;
	const limit = column === "tag" ? 32 : 255;
	return sql`char_length(${name}) BETWEEN 1 AND ${sql.lit(limit)}
		AND ${grammar} AND ${name} !~ '^xml'`;
}

async function installChecks(db: Kysely<unknown>, xml: boolean) {
	await sql`
		ALTER TABLE public.lookup_tables
			DROP CONSTRAINT lookup_tables_tag_check,
			ADD CONSTRAINT lookup_tables_tag_check CHECK (${nameCheck("tag", xml)})
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_columns
			DROP CONSTRAINT lookup_columns_wire_name_check,
			ADD CONSTRAINT lookup_columns_wire_name_check CHECK (${nameCheck("wire_name", xml)})
	`.execute(db);
}

/** Widen the names stored in Project data without changing a row, its identity,
 * its revision, or the exact-name uniqueness constraints. A reference is
 * separately checked against the worker and editor that consume its name. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await lockTables(db);
	await installChecks(db, true);
}

/** Local teardown can restore the old checks while the data still fits. */
export async function down(db: Kysely<unknown>): Promise<void> {
	await lockTables(db);
	const result = await sql<{ tags: string; columns: string }>`
		SELECT
			(SELECT count(*)::text FROM public.lookup_tables
			 WHERE tag COLLATE "C" !~ ${previousName}) AS tags,
			(SELECT count(*)::text FROM public.lookup_columns
			 WHERE wire_name COLLATE "C" !~ ${previousName}) AS columns
	`.execute(db);
	const counts = result.rows[0];
	if (!counts) throw new Error("The lookup name count returned no row.");
	if (counts.tags !== "0" || counts.columns !== "0") {
		throw new Error(
			`The previous lookup name checks cannot read ${counts.tags} table tags and ${counts.columns} column names. Restore the compatible data before rolling back.`,
		);
	}
	await installChecks(db, false);
}
