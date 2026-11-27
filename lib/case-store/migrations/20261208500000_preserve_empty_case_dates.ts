import { type Kysely, sql } from "kysely";

// Existing case records stay unchanged. This conversion only widens the
// canonical stored declaration for an already recognized Date property.
const legacyDate = JSON.stringify({ type: "string", format: "date" });
const dateWithEmpty = JSON.stringify({
	type: "string",
	anyOf: [{ format: "date" }, { const: "" }],
});

async function replaceSchemaProperty(
	db: Kysely<unknown>,
	from: string,
	to: string,
): Promise<void> {
	await sql`
		update case_type_schemas as schema_row
		set schema = jsonb_set(
			schema_row.schema,
			'{properties}',
			(select jsonb_object_agg(p.name, case
				when p.declaration = ${from}::jsonb then ${to}::jsonb
				else p.declaration end)
			from jsonb_each(schema_row.schema->'properties') as p(name, declaration))
		)
		where exists (
			select 1 from jsonb_each(schema_row.schema->'properties') as p(name, declaration)
			where p.declaration = ${from}::jsonb
		)
	`.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
	await replaceSchemaProperty(db, legacyDate, dateWithEmpty);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// A historical blank Date could not be represented. Refuse a destructive
	// rollback once a submission depends on the new storage representation.
	const rows = await sql<{ hasEmptyDate: boolean }>`
		select exists (
			select 1 from case_type_schemas as schema_row
			join cases on cases.app_id = schema_row.app_id
				and cases.case_type = schema_row.case_type
			cross join lateral jsonb_each(schema_row.schema->'properties') as p(name, declaration)
			where p.declaration = ${dateWithEmpty}::jsonb
				and (cases.properties -> p.name) = '""'::jsonb
		) as "hasEmptyDate"
	`.execute(db);
	if (rows.rows[0]?.hasEmptyDate)
		throw new Error(
			"An empty case date has been saved. Restore from the cutover checkpoint to roll back.",
		);
	await replaceSchemaProperty(db, dateWithEmpty, legacyDate);
}
