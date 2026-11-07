/** Historical index ownership proof used only by the one-off retirement tools. */
import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";

export interface RetiredCaseIndex {
	oid: number;
	schema: string;
	name: string;
	definition: string;
	owner: string;
}
export interface CaseIndexRetirementScan {
	indexes: RetiredCaseIndex[];
	blockers: string[];
	digest: string;
}
function tag(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
function literal(value: string): string {
	return `'${value.replaceAll("'", "''")}'::text`;
}

export async function scanCaseExpressionIndexes<DB>(
	db: Kysely<DB>,
): Promise<CaseIndexRetirementScan> {
	const catalog = await sql<
		RetiredCaseIndex & {
			expression: string | null;
			predicate: string | null;
			method: string;
			opclass: string;
			unique: boolean;
			keys: number;
			attributes: number;
			constraint: boolean;
			table_owner: string;
			valid: boolean;
		}
	>`
 SELECT c.oid::integer AS oid,n.nspname AS schema,c.relname AS name,
 pg_get_indexdef(c.oid) AS definition,pg_get_userbyid(c.relowner) AS owner,
 pg_get_userbyid(t.relowner) AS table_owner,pg_get_expr(i.indexprs,i.indrelid) AS expression,
 pg_get_expr(i.indpred,i.indrelid) AS predicate,am.amname AS method,
 opc.opcname AS opclass,i.indisunique AS unique,i.indnkeyatts AS keys,
 i.indnatts AS attributes,i.indisvalid AS valid,
 EXISTS(SELECT 1 FROM pg_constraint WHERE conindid=c.oid) AS constraint
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
 JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_am am ON am.oid=c.relam JOIN pg_opclass opc ON opc.oid=i.indclass[0]
 WHERE i.indrelid=COALESCE(to_regclass('nova_case_runtime.cases'),to_regclass('public.cases'))
 ORDER BY c.relname`.execute(db);
	const indexes: RetiredCaseIndex[] = [];
	const blockers: string[] = [];
	for (const row of catalog.rows) {
		if (row.expression === null) continue;
		// Parse only the exact catalog spelling emitted by historical Nova DDL,
		// then regenerate and compare every byte. Removed properties may no longer
		// occur in current schemas, so current authored state is not ownership.
		const predicate =
			/^\(\(app_id = '((?:[^']|'')*)'::text\) AND \(case_type = '([A-Za-z][A-Za-z0-9_-]*)'::text\)\)$/.exec(
				row.predicate ?? "",
			);
		const property = /properties ->>? '([A-Za-z][A-Za-z0-9_-]*)'::text/.exec(
			row.expression,
		)?.[1];
		const appId = predicate?.[1]?.replaceAll("''", "'");
		const caseType = predicate?.[2];
		const key = property === undefined ? "" : literal(property);
		const own =
			appId === undefined || caseType === undefined || property === undefined
				? undefined
				: [
						["fuzzy", `(properties ->> ${key})`, "gin", "gin_trgm_ops"],
						["int", `((properties ->> ${key}))::integer`, "btree", "int4_ops"],
						[
							"num",
							`((properties ->> ${key}))::numeric`,
							"btree",
							"numeric_ops",
						],
						["contains", `(properties -> ${key})`, "gin", "jsonb_ops"],
					]
						.map(([suffix, expression, method, opclass]) => ({
							name: `cases_${tag(`${appId} ${caseType}`)}_${tag(property)}_${suffix}`,
							expression,
							method,
							opclass,
							predicate: `((app_id = ${literal(appId)}) AND (case_type = ${literal(caseType)}))`,
						}))
						.find((expected) => expected.name === row.name);

		if (
			!own ||
			row.expression !== own.expression ||
			row.predicate !== own.predicate ||
			row.method !== own.method ||
			row.opclass !== own.opclass ||
			row.unique ||
			row.keys !== 1 ||
			row.attributes !== 1 ||
			row.constraint ||
			row.owner !== row.table_owner
		) {
			blockers.push(`Unproven historical index ${row.schema}.${row.name}`);
			continue;
		}
		indexes.push({
			oid: row.oid,
			schema: row.schema,
			name: row.name,
			definition: row.definition,
			owner: row.owner,
		});
	}
	const digest = createHash("sha256")
		.update(JSON.stringify({ indexes, blockers }))
		.digest("hex");
	return { indexes, blockers, digest };
}

/** Run only with old application writers stopped. Each drop commits separately:
 * one transaction holding thousands of index locks is precisely the failure. */
export async function retireCaseExpressionIndexes<DB>(
	db: Kysely<DB>,
	expectedDigest: string,
): Promise<number> {
	const scan = await scanCaseExpressionIndexes(db);
	if (scan.blockers.length) throw new Error(scan.blockers.join("\n"));
	if (scan.digest !== expectedDigest)
		throw new Error(
			"The index inventory changed. Run the read-only scan again and review its digest.",
		);
	let removed = 0;
	for (const index of scan.indexes) {
		const current = await sql<{
			oid: number;
			definition: string;
			owner: string;
		}>`SELECT c.oid::integer AS oid,pg_get_indexdef(c.oid) AS definition,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${index.schema} AND c.relname=${index.name}`.execute(
			db,
		);
		const row = current.rows[0];
		if (
			!row ||
			row.oid !== index.oid ||
			row.definition !== index.definition ||
			row.owner !== index.owner
		)
			throw new Error(
				`Index changed during retirement: ${index.schema}.${index.name}`,
			);
		await sql`DROP INDEX CONCURRENTLY ${sql.id(index.schema, index.name)}`.execute(
			db,
		);
		removed++;
	}
	const final = await scanCaseExpressionIndexes(db);
	if (final.indexes.length || final.blockers.length)
		throw new Error(
			"Historical indexes remain after retirement. Keep writers stopped and inspect the scan.",
		);
	return removed;
}
