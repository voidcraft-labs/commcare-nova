// lib/case-store/sql/compileLookup.ts
//
// Compile the S05 lookup-table carriers to Kysely expressions.
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
import { expressionBuilder } from "kysely";
import type { StoredLookupColumnDataType } from "@/lib/db/pg";
import {
	missingPredicateThunkMessage,
	typeCheckerBypassMessage,
} from "@/lib/domain/predicate/errors";
import type {
	TableColumnTerm,
	ValueExpression,
} from "@/lib/domain/predicate/types";
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
>;

/** The enclosing `table-lookup`'s row scope during `where` compilation. */
export interface LookupRowScope {
	readonly tableId: string;
	readonly rowAlias: string;
}

/** Module-scoped expression builder (same idiom as the sibling compilers). */
const eb = expressionBuilder<Database, keyof Database>();

/** Compile a `table-lookup` expression to its first-match scalar subquery. */
export function compileTableLookup(
	expr: Extract<ValueExpression, { kind: "table-lookup" }>,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const compilePredicate = ctx.compilePredicate;
	if (compilePredicate === undefined) {
		throw new Error(
			missingPredicateThunkMessage({
				where: "compileLookup",
				arm: "table-lookup",
				slot: "`table-lookup` carries a `Predicate` row filter (`where`)",
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

	const dyn = eb as DynamicExprBuilder;
	const query = ctx.db.selectFrom(
		`lookup_rows as ${rowAlias}` as never,
	) as unknown as DynamicLookupRowsQuery;
	return query
		.where(dyn(`${rowAlias}.project_id`, "=", ctx.projectId))
		.where(dyn(`${rowAlias}.table_id`, "=", expr.tableId))
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
				hint: "reject the AST at validation — a row-relative column read has no meaning without its fixture row.",
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
	columnId: string,
	dataType: StoredLookupColumnDataType,
): AliasableExpression<unknown> {
	const jsonRead = (eb as DynamicExprBuilder)
		.ref(`${rowAlias}.values`, "->>")
		.key(columnId);
	return eb.cast(jsonRead, POSTGRES_CAST_FOR_DATA_TYPE[dataType]);
}

/** Resolve a column's declared type from the threaded definitions snapshot. */
function requireLookupColumnType(
	ctx: TermCompileContext,
	tableId: string,
	columnId: string,
	where: string,
): StoredLookupColumnDataType {
	const table = ctx.lookupTableSchemas?.get(tableId);
	const dataType = table?.get(columnId);
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
