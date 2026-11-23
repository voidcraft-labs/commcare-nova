// lib/case-store/sql/compileLookup.ts
//
// Compile the lookup-table carriers to Kysely expressions.
//
// A `table-lookup` expression becomes a correlated first-match scalar
// subquery over the Project's `lookup_rows`: the first row in authored
// `(order_key, id)` order matching `where`, reading the result column's
// cell typed by its declared data type. No match is SQL `NULL` — the
// wire's empty node-set — never manufactured empty text; a matched
// row's absent cell also reads `NULL`, which `is-blank` covers exactly
// as it covers an absent case property. A `table-column` term reads
// one UUID-keyed cell off the enclosing lookup's row alias and is
// legal nowhere else (the validator's row-scope contract; the compiler
// defends with invariants, never guesses).
//
// Tenancy: every subquery filters `project_id` to the bound Project —
// the JOIN-side half of the tenant contract, same as relation walks.
// The outer case row's alias stays visible inside the subquery, so
// case-property terms in a lookup `where` keep reading the anchor row
// (the wire's captured case anchor), while same-table column terms
// read the fixture row.

import type { AliasableExpression, Expression } from "kysely";
import { expressionBuilder, sql } from "kysely";
import type { StoredLookupColumnDataType } from "@/lib/db/pg";
import {
	missingPredicateThunkMessage,
	typeCheckerBypassMessage,
} from "@/lib/domain/expression/errors";
import type {
	Expression as DomainExpression,
	TableColumnTerm,
} from "@/lib/domain/expression/types";
import {
	type LookupRead,
	lookupReadType,
	lookupReadTypes,
} from "@/lib/domain/lookupRead";
import type {
	LookupFixtureDataSnapshot,
	LookupFixtureRow,
} from "@/lib/lookup/types";
import type { ExpressionCompileContext } from "./compileExpression";
import type { TermCompileContext } from "./compileTerm";
import type { Database } from "./database";
import { POSTGRES_CAST_FOR_DATA_TYPE } from "./dataTypeTokens";

/**
 * Rows-free lookup definitions for carrier compilation: table id →
 * (column id → declared data type). The caller projects this from the
 * same Project-scoped definitions snapshot validation used — the
 * compiler never reads `lookup_columns` at query time, so the cast a
 * comparison uses is exactly the one the type checker resolved.
 */
export type LookupTableSchemas = ReadonlyMap<
	string,
	ReadonlyMap<string, StoredLookupColumnDataType>
> & {
	readonly projection?: {
		readonly projectId: string;
		readonly rows: ReadonlyMap<string, readonly LookupFixtureRow[]>;
	};
};

/** The store receives a Project-bound server-produced snapshot. Binding the
 * actual row bodies also serves checked HQ restores with no database row ID. */
export function workerLookupSchemas(
	projectId: string,
	snapshot: Pick<LookupFixtureDataSnapshot, "definitions" | "rowsByTable">,
): LookupTableSchemas {
	return Object.assign(
		new Map(
			snapshot.definitions.map((table) => [table.id, lookupReadTypes(table)]),
		),
		{ projection: { projectId, rows: snapshot.rowsByTable } },
	);
}

/** The enclosing `table-lookup`'s row scope during `where` compilation. */
export interface LookupRowScope {
	readonly tableId: string;
	readonly rowAlias: string;
}

/** Module-scoped expression builder (same idiom as the sibling compilers). */
const eb = expressionBuilder<Database, keyof Database>();

/** Compile a `table-lookup` expression to its first-match scalar subquery. */
export function compileTableLookup(
	expr: Extract<DomainExpression, { kind: "table-lookup" }>,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const compilePredicate = ctx.compilePredicate;
	if (compilePredicate === undefined) {
		throw new Error(
			missingPredicateThunkMessage({
				where: "compileLookup",
				arm: "table-lookup",
				slot: "`table-lookup` carries a `DomainExpression` row filter (`where`)",
			}),
		);
	}
	const resultType = requireLookupColumnType(
		ctx,
		expr.tableId,
		expr.resultColumnId,
		"compileTableLookup",
	);

	// Depth-suffixed alias, mirroring the relation-walk leaf rule:
	// nested table lookups are validator-rejected, but a lookup inside
	// a relation walk's inner predicate compiles at an incremented
	// depth, so its alias can never shadow an outer lookup's row.
	const rowAlias = `lkr_${ctx.relationPathDepth ?? 0}`;
	const whereExpr = compilePredicate(expr.where, {
		...ctx,
		lookupRowScope: { tableId: expr.tableId, rowAlias },
	});

	const projection = ctx.lookupTableSchemas?.projection;
	let query: DynamicLookupRowsQuery;
	if (projection) {
		if (projection.projectId !== ctx.projectId)
			throw new Error("The worker’s lookup data belongs to another Project.");
		const rows = projection.rows.get(expr.tableId);
		if (!rows)
			throw new Error("This worker’s current lookup rows are unavailable.");
		// WITH ORDINALITY preserves restore order including equal rows and
		// remote rows without a Nova identity. Values never enter SQL text.
		const encoded = JSON.stringify(
			rows.map((row) => ({
				id: row.id,
				values: row.values,
				content: { attributes: row.attributes, occurrences: row.occurrences },
			})),
		);
		const source =
			sql`(SELECT item->>'id' AS id,item->'values' AS values,item->'content' AS content,position AS order_key FROM jsonb_array_elements(${encoded}::jsonb) WITH ORDINALITY AS source(item,position))`.as(
				rowAlias,
			);
		query = ctx.db.selectFrom(source) as unknown as DynamicLookupRowsQuery;
	} else {
		// Legacy store callers get only fully inline global tables. Every normal
		// worker path supplies its authorized, hydrated projection above.
		const dyn = eb as DynamicExprBuilder;
		query = (
			ctx.db.selectFrom(
				`lookup_rows as ${rowAlias}` as never,
			) as unknown as DynamicLookupRowsQuery
		)
			.where(dyn(`${rowAlias}.project_id`, "=", ctx.projectId))
			.where(dyn(`${rowAlias}.table_id`, "=", expr.tableId))
			.where(
				eb.exists(
					ctx.db
						.selectFrom("lookup_tables")
						.select("id")
						.where("project_id", "=", ctx.projectId)
						.where("id", "=", expr.tableId)
						.where(
							sql<boolean>`worker_access='all' AND NOT EXISTS (SELECT 1 FROM lookup_rows external_row WHERE (external_row.project_id,external_row.table_id)=(lookup_tables.project_id,lookup_tables.id) AND external_row.external_bytes>0) AND (hq_server is null or hq_taken_over_at is not null or hq_canonical->'source' is null or (hq_canonical #>> '{source,distribution}' = 'global' and hq_canonical #>> '{source,inventory}' = 'complete' and hq_canonical #>> '{source,storage}' is null))`,
						),
				),
			);
	}
	return query
		.where(whereExpr)
		.orderBy(`${rowAlias}.order_key`, "asc")
		.orderBy(`${rowAlias}.id`, "asc")
		.limit(1)
		.select(
			lookupCellRead(rowAlias, expr.resultColumnId, resultType).as("v"),
		) as unknown as AliasableExpression<unknown>;
}

/** Compile a `table-column` term inside the enclosing lookup's row scope. */
export function compileLookupColumnTerm(
	term: TableColumnTerm,
	ctx: TermCompileContext,
): AliasableExpression<unknown> {
	const scope = ctx.lookupRowScope;
	if (scope === undefined) {
		throw new Error(
			typeCheckerBypassMessage({
				where: "compileLookup.compileLookupColumnTerm",
				summary:
					"a `table-column` term reached the SQL compiler outside any `table-lookup` row scope",
				expected:
					"the type checker admits `table-column` only inside the owning `table-lookup`'s `where`, where `compileTableLookup` sets the row scope",
				received: `a \`table-column\` term for table \`${term.tableId}\` with no enclosing row scope`,
				hint: "reject the AST at validation, a row-relative column read has no meaning without its fixture row.",
			}),
		);
	}
	if (term.tableId !== scope.tableId) {
		throw new Error(
			typeCheckerBypassMessage({
				where: "compileLookup.compileLookupColumnTerm",
				summary:
					"a `table-column` term names a different table than the enclosing `table-lookup`",
				expected: `same-table column terms only (enclosing table \`${scope.tableId}\`)`,
				received: `a column term for table \`${term.tableId}\``,
				hint: "the validator rejects other-table columns inside a lookup `where`; correct the AST.",
			}),
		);
	}
	const dataType = requireLookupColumnType(
		ctx,
		term.tableId,
		term.columnId,
		"compileLookupColumnTerm",
	);
	return lookupCellRead(scope.rowAlias, term.columnId, dataType);
}

/**
 * Typed cell read: `<rowAlias>.values ->> '<columnId>'` cast per the
 * column's declared type — the same cast table property reads use, so
 * a lookup cell and a case property of the same type compare under
 * identical SQL semantics. Column ids are validated UUIDs, so the
 * inline key cannot inject (same argument as JSONB property reads).
 */
function lookupCellRead(
	rowAlias: string,
	read: LookupRead,
	dataType: StoredLookupColumnDataType,
): AliasableExpression<unknown> {
	const content = sql.ref(`${rowAlias}.content`);
	const values = sql.ref(`${rowAlias}.values`);
	if (typeof read !== "string" && "attributeId" in read)
		return sql`${content}->'attributes'->>${read.attributeId}::text`;
	const column = typeof read === "string" ? read : read.columnId;
	const items = sql`${content}->'occurrences'->${column}::text`;
	const property = typeof read === "string" ? undefined : read.propertyId;
	const filter = typeof read === "string" ? undefined : read.where;
	const position = typeof read === "string" ? undefined : read.occurrence;
	const before = typeof read !== "string" && read.positionBeforeFilter;
	const selected = sql`SELECT item,ord FROM jsonb_array_elements(${items}) WITH ORDINALITY AS occurrence(item,ord)
		${filter ? sql`WHERE ${before ? sql`ord = ${position} AND` : sql``} item->'properties'->>${filter.propertyId}::text=${filter.equals}` : sql``}
		ORDER BY ord ${position === undefined || before ? sql`` : sql`OFFSET ${position - 1} LIMIT 1`}`;
	// A Core scalar conversion rejects a nodeset with more than one node. A
	// scalar subquery has that same property, including after a detail filter.
	const field = property
		? sql`(SELECT item->'properties'->>${property}::text FROM (${selected}) AS matched WHERE (item->'properties') ? ${property}::text)`
		: sql`(SELECT item->>'text' FROM (${selected}) AS matched)`;
	const sparse =
		property || filter || (position ?? 1) !== 1
			? sql`null`
			: sql`${values}->>${column}::text`;
	return eb.cast(
		sql`CASE WHEN ${items} IS NULL THEN ${sparse} ELSE ${field} END`,
		POSTGRES_CAST_FOR_DATA_TYPE[dataType],
	);
}

/** Resolve a column's declared type from the threaded definitions snapshot. */
function requireLookupColumnType(
	ctx: TermCompileContext,
	tableId: string,
	columnId: LookupRead,
	where: string,
): StoredLookupColumnDataType {
	const table = ctx.lookupTableSchemas?.get(tableId);
	const dataType = lookupReadType(table, columnId);
	if (dataType !== undefined) return dataType;
	throw new Error(
		typeCheckerBypassMessage({
			where: `compileLookup.${where}`,
			summary:
				ctx.lookupTableSchemas === undefined
					? "a lookup carrier reached a compile site with no `lookupTableSchemas` in context"
					: table === undefined
						? `lookup table \`${tableId}\` is not in the threaded definitions snapshot`
						: `column \`${columnId}\` is not declared on lookup table \`${tableId}\``,
			expected:
				"the caller threads the Project's rows-free lookup definitions (table id → column id → data type) through `ctx.lookupTableSchemas` for every slot the validator admits carriers into",
			received:
				ctx.lookupTableSchemas === undefined
					? "`ctx.lookupTableSchemas` is undefined"
					: `snapshot covers ${ctx.lookupTableSchemas.size} table(s)`,
			hint: "validation rejects unavailable lookup identities before SQL compilation, so a missing entry here means the compile site did not thread the same definitions snapshot validation used.",
		}),
	);
}

// Type-erased local views — same rationale as the sibling compilers:
// Kysely's typed builder can't enumerate runtime alias strings against
// `Database`'s static column set. Each surfaces only the methods this
// module uses.

/** Binary-op + JSON-read shape over runtime `${alias}.${column}` strings. */
type DynamicExprBuilder = {
	(left: string, op: string, right: unknown): Expression<unknown>;
	ref: (
		reference: string,
		op: "->>",
	) => { key: (key: string) => AliasableExpression<unknown> };
};

/** First-match scalar subquery shape for `compileTableLookup`. */
interface DynamicLookupRowsQuery {
	where: (predicate: Expression<unknown>) => DynamicLookupRowsQuery;
	orderBy: (ref: string, dir: "asc") => DynamicLookupRowsQuery;
	limit: (n: number) => DynamicLookupRowsQuery;
	select: (selection: {
		readonly expression: unknown;
	}) => DynamicLookupRowsQuery;
}
