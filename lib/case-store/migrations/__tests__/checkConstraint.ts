import { type Kysely, sql } from "kysely";

/** Evaluate the installed CHECK, without constructing unrelated parent rows.
 * Inspecting its source for a word would also accept NOT IN or a tautology. */
export async function checkConstraintVerdicts(
	db: Kysely<unknown>,
	table: string,
	constraint: string,
	column: string,
	values: readonly string[],
): Promise<readonly { value: string; admitted: boolean | null }[]> {
	const installed = await sql<{ expression: string }>`
  SELECT pg_get_expr(conbin, conrelid) AS expression
  FROM pg_constraint
  WHERE conrelid = ${table}::regclass AND conname = ${constraint}
   AND contype = 'c' AND convalidated
 `.execute(db);
	const expression = installed.rows[0]?.expression;
	if (installed.rows.length !== 1 || expression === undefined)
		throw new Error(`Expected one validated CHECK ${table}.${constraint}`);
	const result = await sql<{ value: string; admitted: boolean | null }>`
  SELECT ${sql.id(column)} AS value, (${sql.raw(expression)}) AS admitted
  FROM unnest(${[...values]}::text[]) WITH ORDINALITY AS candidate(${sql.id(column)}, position)
  ORDER BY position
 `.execute(db);
	return result.rows;
}
