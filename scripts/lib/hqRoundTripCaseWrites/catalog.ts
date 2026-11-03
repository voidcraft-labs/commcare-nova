/**
 * Every `pg_catalog` read the case-writes cutover and its tests make (step
 * 5's part 09, section 15). Each read names its relation by schema and name,
 * resolved through `pg_catalog.to_regclass`, `to_regprocedure` or
 * `to_regnamespace` over a `format`-quoted identifier: never a constraint or
 * routine name alone, and never the session's `search_path`.
 *
 * A name alone is not unique in the catalog. Every app-test namespace
 * (`public.nova_create_app_test_namespace`) holds copies of the app tables
 * with their constraints, and a constraint's or routine's name repeats in
 * each. A read that matched by name alone answers whichever tuple its scan
 * meets first, which after a `VACUUM FULL` and with index scans off is the
 * copy written before the live object was replaced. Resolving the relation
 * first makes `(conrelid, conname)` and the routine's oid unique, so the
 * answer is the live object whatever the heap order.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";

type CatalogReader = Kysely<AppDatabase> | Transaction<AppDatabase>;

/** The cutover reads only Nova's own schema; `cases` lives in
 *  `nova_case_runtime` in production and the cutover reads no catalog row
 *  of it. */
export type CatalogSchema = "public";

/** The catalog does not hold an object the cutover reads to prove its
 *  migrations applied. */
export class CatalogObjectMissingError extends Error {
	readonly name = "CatalogObjectMissingError";
}

function missing(
	kind: "relation" | "constraint" | "routine" | "schema",
	name: string,
	where: string,
): CatalogObjectMissingError {
	return new CatalogObjectMissingError(
		`The catalog has no ${kind} ${name} on ${where}, which this cutover reads to prove its migrations applied. The cutover stopped; compare the ledger with main's migrations.`,
	);
}

/** Whether `schema.table` names a relation, resolved without the search path. */
async function relationPresent(
	tx: CatalogReader,
	schema: CatalogSchema,
	table: string,
): Promise<boolean> {
	const row = await sql<{ present: boolean }>`
		SELECT pg_catalog.to_regclass(pg_catalog.format('%I.%I', ${schema}::text, ${table}::text)) IS NOT NULL AS present
	`.execute(tx);
	return row.rows[0]?.present === true;
}

/** `pg_get_constraintdef` of the named constraint of the named relation. */
export async function constraintDefinition(
	tx: CatalogReader,
	schema: CatalogSchema,
	table: string,
	constraint: string,
): Promise<string> {
	const result = await sql<{ definition: string | null }>`
		SELECT pg_catalog.pg_get_constraintdef(c.oid) AS definition
		FROM pg_catalog.pg_constraint AS c
		WHERE c.conrelid = pg_catalog.to_regclass(pg_catalog.format('%I.%I', ${schema}::text, ${table}::text))
			AND c.conname = ${constraint}
	`.execute(tx);
	const definition = result.rows[0]?.definition;
	if (typeof definition === "string") return definition;
	if (!(await relationPresent(tx, schema, table))) {
		throw missing("relation", table, schema);
	}
	throw missing("constraint", constraint, `${schema}.${table}`);
}

/** Every constraint of the named relation, by name, with its definition
 *  (for byte-identical images), in code-point order of name. */
export async function relationConstraints(
	tx: CatalogReader,
	schema: CatalogSchema,
	table: string,
): Promise<ReadonlyMap<string, string>> {
	if (!(await relationPresent(tx, schema, table))) {
		throw missing("relation", table, schema);
	}
	const result = await sql<{ name: string; definition: string }>`
		SELECT c.conname AS name, pg_catalog.pg_get_constraintdef(c.oid) AS definition
		FROM pg_catalog.pg_constraint AS c
		WHERE c.conrelid = pg_catalog.to_regclass(pg_catalog.format('%I.%I', ${schema}::text, ${table}::text))
		ORDER BY c.conname COLLATE "C"
	`.execute(tx);
	if (result.rows.length === 0) {
		throw missing("constraint", "of any name", `${schema}.${table}`);
	}
	return new Map(result.rows.map((row) => [row.name, row.definition]));
}

/** `pg_get_functiondef` of the routine the schema-qualified signature
 *  names, such as `routineDefinition(tx, "public",
 *  "nova_admit_app_change_insert()")`. */
export async function routineDefinition(
	tx: CatalogReader,
	schema: CatalogSchema,
	signature: string,
): Promise<string> {
	const result = await sql<{ definition: string | null }>`
		SELECT pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(pg_catalog.format('%I.%s', ${schema}::text, ${signature}::text))) AS definition
	`.execute(tx);
	const definition = result.rows[0]?.definition;
	if (typeof definition === "string") return definition;
	throw missing("routine", signature, schema);
}

/** Every routine of the schema, by signature (`name(argument types)`, the
 *  spelling `routineDefinition` takes), with its definition (for
 *  byte-identical images), in code-point order of signature. Aggregates are
 *  left out: `pg_get_functiondef` prints none, and no migration of the
 *  window makes one. */
export async function schemaRoutines(
	tx: CatalogReader,
	schema: CatalogSchema,
): Promise<ReadonlyMap<string, string>> {
	const namespace = await sql<{ present: boolean }>`
		SELECT pg_catalog.to_regnamespace(pg_catalog.quote_ident(${schema}::text)) IS NOT NULL AS present
	`.execute(tx);
	if (namespace.rows[0]?.present !== true) {
		throw missing("schema", schema, "this database");
	}
	const result = await sql<{ signature: string; definition: string }>`
		SELECT routines.signature, routines.definition
		FROM (
			SELECT
				pg_catalog.format('%s(%s)', p.proname, pg_catalog.oidvectortypes(p.proargtypes)) AS signature,
				pg_catalog.pg_get_functiondef(p.oid) AS definition
			FROM pg_catalog.pg_proc AS p
			WHERE p.pronamespace = pg_catalog.to_regnamespace(pg_catalog.quote_ident(${schema}::text))
				AND p.prokind <> 'a'
		) AS routines
		ORDER BY routines.signature COLLATE "C"
	`.execute(tx);
	if (result.rows.length === 0) {
		throw missing("routine", "of any name", schema);
	}
	return new Map(result.rows.map((row) => [row.signature, row.definition]));
}
