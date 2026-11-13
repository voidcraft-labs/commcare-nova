import { type Kysely, sql } from "kysely";

/**
 * A lookup table's tag and a column's wire name take CommCare HQ's grammar
 * over ASCII: an unaccented letter or underscore, then letters, digits,
 * underscores and hyphens, never starting with lowercase `xml`
 * (`fixtures/utils.py::is_identifier_invalid`). The two checks
 * `20260722053000_lookup_tables` wrote inline carry no name the migration
 * chose, so each is found by its text and replaced by a named, wider one.
 * Every stored row passed the narrower check, so the wider one validates
 * without a scan, and the revision serving while this runs writes only
 * names both checks accept. Run again over the same schema (the adoption
 * replay), it finds its own checks by the same text and writes them again.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// Wait five seconds for a lock, and no longer, while the previous revision serves.
	await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
	await sql`
		DO $$
		DECLARE held record;
		BEGIN
			FOR held IN
				SELECT conrelid::regclass AS relation, conname
				FROM pg_constraint
				WHERE contype = 'c'
					AND (
						(conrelid = 'public.lookup_tables'::regclass
							AND pg_get_constraintdef(oid) LIKE '%tag ~%')
						OR (conrelid = 'public.lookup_columns'::regclass
							AND pg_get_constraintdef(oid) LIKE '%wire_name ~%')
					)
			LOOP
				EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', held.relation, held.conname);
			END LOOP;
		END $$
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_tables ADD CONSTRAINT lookup_tables_tag_check CHECK (
			char_length(tag) BETWEEN 1 AND 32
			AND tag ~ '^[A-Za-z_][A-Za-z0-9_-]*$'
			AND tag !~ '^xml'
		)
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_columns ADD CONSTRAINT lookup_columns_wire_name_check CHECK (
			char_length(wire_name) BETWEEN 1 AND 255
			AND wire_name ~ '^[A-Za-z_][A-Za-z0-9_-]*$'
			AND wire_name !~ '^xml'
		)
	`.execute(db);
	// Hand the batch back as it was found.
	await sql`SET LOCAL lock_timeout = 0`.execute(db);
}

/**
 * Puts back the two definitions `20260722053000_lookup_tables` wrote, under
 * the names `up` gave them, and refuses before it changes anything while a
 * stored name needs the wider grammar.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
	const held = await sql<{ tags: string; wire_names: string }>`
		SELECT
			(SELECT count(*)::text FROM public.lookup_tables
				WHERE tag !~ '^[A-Za-z_][A-Za-z0-9_]*$' OR tag ~* '^xml') AS tags,
			(SELECT count(*)::text FROM public.lookup_columns
				WHERE wire_name !~ '^[A-Za-z_][A-Za-z0-9_]*$' OR wire_name ~* '^xml') AS wire_names
	`.execute(db);
	const tags = held.rows[0]?.tags ?? "0";
	const wireNames = held.rows[0]?.wire_names ?? "0";
	if (tags !== "0" || wireNames !== "0") {
		throw new Error(
			`Nova can't put the earlier lookup name checks back: ${tags} table tags and ${wireNames} ` +
				"column names hold a hyphen or start with XML in capitals, which the earlier checks " +
				"refuse. Renaming them first lets the rollback run.",
		);
	}
	await sql`
		ALTER TABLE public.lookup_tables
			DROP CONSTRAINT lookup_tables_tag_check,
			ADD CONSTRAINT lookup_tables_tag_check CHECK (
				char_length(tag) BETWEEN 1 AND 32
				AND tag ~ '^[A-Za-z_][A-Za-z0-9_]*$'
				AND tag !~* '^xml'
			)
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_columns
			DROP CONSTRAINT lookup_columns_wire_name_check,
			ADD CONSTRAINT lookup_columns_wire_name_check CHECK (
				char_length(wire_name) BETWEEN 1 AND 255
				AND wire_name ~ '^[A-Za-z_][A-Za-z0-9_]*$'
				AND wire_name !~* '^xml'
			)
	`.execute(db);
}
