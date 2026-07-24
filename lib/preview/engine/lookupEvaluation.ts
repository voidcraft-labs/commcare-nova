// lib/preview/engine/lookupEvaluation.ts
//
// Client-side evaluation of the S05 lookup-table carriers over one
// loaded fixture snapshot: `table-lookup` first-match values and
// lookup-backed select choices.
//
// The evaluation strategy is the shipped search-surface pattern
// (`searchExpressionEvaluation.ts`): print the authored AST through
// the SAME on-device predicate emitter the wire uses, then evaluate
// the printed XPath with the preview evaluator — never a second AST
// interpreter. The one lookup-specific twist is the fixture-row
// scope: the emitter prints same-table `table-column` terms as bare
// row-relative wire names (exactly the device's itemset-predicate
// shape), and the per-row `EvalContext` resolves those names against
// the row's lexicalized cells. The `item-list:` instance vocabulary
// never appears — the row scope is established by iterating the
// loaded rows, not by resolving a fixture instance ref.
//
// Blank semantics are the fixture boundary's: a missing cell and a
// stored-empty cell both read as empty text (`lookupFixtureCellText`
// — the wire emits every defined column, empty element for both), and
// a no-match `table-lookup` folds to the empty string, which is what
// CommCare Core's scalar unpack produces for the wire's empty
// node-set (`""` under string operators, `NaN` under numeric
// coercion). Folding to a PLAIN text literal is exact device parity
// because the emitters coerce only through explicit AST nodes — a
// node read and a string literal are unpacked identically by every
// scalar operator.
//
// Rows hold the authored `(order_key, row uuid)` order the snapshot
// reader delivers; the first row whose filter matches is the wire's
// `[<where>][1]` positional first-match.

import { lookupFixtureCellText } from "@/lib/commcare/lookup/cellText";
import {
	type LookupWireNaming,
	lookupWireNaming,
} from "@/lib/commcare/lookup/naming";
import { emitCaseListFilter } from "@/lib/commcare/predicate";
import type { OnDeviceTermEmissionContext } from "@/lib/commcare/predicate/termEmitter";
import type {
	LookupColumnId,
	LookupOptionsSource,
	LookupTableId,
	Uuid,
} from "@/lib/domain";
import {
	literal,
	mapExpressionAst,
	mapPredicateAst,
	typeCheckerBypassMessage,
} from "@/lib/domain/predicate";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate/types";
import type {
	LookupColumn,
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { toBoolean } from "../xpath/coerce";
import { evaluate } from "../xpath/evaluator";
import type { EvalContext } from "../xpath/types";

/**
 * One Project lookup snapshot projected for client evaluation:
 * definitions plus complete ordered rows from ONE consistent read,
 * with the wire naming and per-table indexes derived once. Build via
 * {@link previewLookupData}; hold for the surface's own stability
 * contract (the form engine captures one at activation so choices
 * stay stable within a form session; navigation surfaces read the
 * live builder-session cache).
 */
export interface PreviewLookupData {
	readonly projectRevision: string;
	readonly definitions: readonly LookupTableDefinition[];
	readonly rowsByTable: ReadonlyMap<LookupTableId, readonly LookupFixtureRow[]>;
	readonly naming: LookupWireNaming;
	readonly tablesById: ReadonlyMap<LookupTableId, LookupTableDefinition>;
}

/** Derive the evaluation-ready projection from a fixture snapshot. */
export function previewLookupData(snapshot: {
	readonly projectRevision: string;
	readonly definitions: readonly LookupTableDefinition[];
	readonly rowsByTable: ReadonlyMap<LookupTableId, readonly LookupFixtureRow[]>;
}): PreviewLookupData {
	return {
		projectRevision: snapshot.projectRevision,
		definitions: snapshot.definitions,
		rowsByTable: snapshot.rowsByTable,
		naming: lookupWireNaming(snapshot.definitions),
		tablesById: new Map(snapshot.definitions.map((table) => [table.id, table])),
	};
}

/** One rendered choice of a lookup-backed select, in authored row order. */
export interface LookupChoice {
	readonly value: string;
	readonly label: string;
}

/**
 * Non-row bindings for one carrier evaluation. `outer` resolves
 * everything that is NOT the fixture row — absolute `/data/` form
 * paths, `/session/` identity paths, and (for form display
 * conditions) the self-property hashtags `emitSelfProperty` prints.
 * `formFields` maps referenced form-answer uuids to the absolute
 * printed paths `outer.getValue` resolves; `emitSelfProperty` prints
 * a direct self case-property read into whatever `outer`'s
 * `resolveHashtag` understands.
 */
export interface LookupEvaluationBindings {
	readonly outer: EvalContext;
	readonly formFields?: ReadonlyMap<Uuid, string>;
	readonly emitSelfProperty?: (property: {
		readonly property: string;
	}) => string;
}

function requireTable(
	data: PreviewLookupData,
	tableId: LookupTableId,
	where: string,
): { table: LookupTableDefinition; rows: readonly LookupFixtureRow[] } {
	const table = data.tablesById.get(tableId);
	const rows = data.rowsByTable.get(tableId);
	if (table !== undefined && rows !== undefined) return { table, rows };
	throw new Error(
		typeCheckerBypassMessage({
			where: `lookupEvaluation.${where}`,
			summary: `lookup table \`${tableId}\` is not in the loaded fixture snapshot`,
			expected:
				"the builder session loads every table the doc references before a carrier evaluates; validation rejects unavailable lookup identities at commit",
			received: `a snapshot of ${data.definitions.length} table(s) at Project revision ${data.projectRevision}`,
			hint: "the carrier references a table outside the loaded set — reload the lookup data for the doc's referenced tables, or repair the doc.",
		}),
	);
}

function requireColumn(
	table: LookupTableDefinition,
	columnId: LookupColumnId,
	where: string,
): LookupColumn {
	const column = table.columns.find((c) => c.id === columnId);
	if (column !== undefined) return column;
	throw new Error(
		typeCheckerBypassMessage({
			where: `lookupEvaluation.${where}`,
			summary: `column \`${columnId}\` is not declared on lookup table \`${table.name}\``,
			expected:
				"validation rejects unavailable lookup column identities before a carrier can evaluate",
			received: `table \`${table.id}\` with ${table.columns.length} column(s)`,
			hint: "the definitions snapshot and the doc disagree — refresh the lookup data; if the column was deleted, the commit validator owns the repair.",
		}),
	);
}

/**
 * Per-row `EvalContext`: a bare single-segment path is a row-relative
 * column wire name (the emitter's row-scope printing) and reads the
 * row's lexicalized cell; everything else — absolute form paths,
 * session paths, hashtags — delegates to the outer context.
 * `position`/`last()` are the row's position over the COMPLETE row
 * sequence, the device's nodeset-predicate context.
 */
function rowEvalContext(
	columnsByWireName: ReadonlyMap<string, LookupColumn>,
	row: LookupFixtureRow,
	position: number,
	size: number,
	outer: EvalContext,
): EvalContext {
	return {
		contextPath: "",
		position,
		size,
		resolveHashtag: (ref) => outer.resolveHashtag(ref),
		getValue: (path) => {
			const segments = path.split("/").filter(Boolean);
			if (segments.length === 1) {
				const column = columnsByWireName.get(segments[0]);
				if (column !== undefined) {
					return lookupFixtureCellText(column.dataType, row.values[column.id]);
				}
			}
			return outer.getValue(path);
		},
	};
}

function emissionContext(
	data: PreviewLookupData,
	tableId: LookupTableId,
	bindings: LookupEvaluationBindings,
): OnDeviceTermEmissionContext {
	return {
		...(bindings.formFields !== undefined && {
			formFields: bindings.formFields,
		}),
		...(bindings.emitSelfProperty !== undefined && {
			emitSelfProperty: bindings.emitSelfProperty,
		}),
		lookup: {
			naming: data.naming,
			// `unaddressable` keeps the anchor honest: a bare self
			// case-property read inside a row filter either goes through
			// `emitSelfProperty` (form display conditions) or throws the
			// emitter's validation-bypass error loudly.
			rowScope: { tableId, caseAnchor: { kind: "unaddressable" } },
		},
	};
}

/**
 * Evaluate one row filter across a table's complete ordered rows.
 * The filter is emitted ONCE (row-scoped) and evaluated per row —
 * the device's prompt-rebuild re-filter over its embedded fixture.
 * Nested `table-lookup`s inside the filter are folded to their
 * literal results first (validation rejects them today; folding keeps
 * this module total if that ever loosens).
 */
function matchingRows(
	data: PreviewLookupData,
	tableId: LookupTableId,
	filter: Predicate | undefined,
	bindings: LookupEvaluationBindings,
	caller: string,
): {
	table: LookupTableDefinition;
	rows: readonly LookupFixtureRow[];
	matches: (row: LookupFixtureRow, index: number) => boolean;
} {
	const { table, rows } = requireTable(data, tableId, caller);
	if (filter === undefined) {
		return { table, rows, matches: () => true };
	}
	const folded = foldTableLookupsInPredicate(filter, data, bindings);
	const emitted = emitCaseListFilter(
		folded,
		"casedb",
		{},
		{ kind: "unaddressable" },
		emissionContext(data, tableId, bindings),
	);
	const columnsByWireName = new Map(
		table.columns.map((column) => [column.wireName, column]),
	);
	return {
		table,
		rows,
		matches: (row, index) =>
			toBoolean(
				evaluate(
					emitted,
					rowEvalContext(
						columnsByWireName,
						row,
						index + 1,
						rows.length,
						bindings.outer,
					),
				),
			),
	};
}

/**
 * Evaluate a `table-lookup` to its scalar text result: the first row
 * in authored order matching `where`, reading the result column's
 * lexicalized cell. No match is the empty string — Core's scalar
 * unpack of the wire's empty node-set.
 */
export function evaluateTableLookup(
	expr: Extract<ValueExpression, { kind: "table-lookup" }>,
	data: PreviewLookupData,
	bindings: LookupEvaluationBindings,
): string {
	const { table, rows, matches } = matchingRows(
		data,
		expr.tableId,
		expr.where,
		bindings,
		"evaluateTableLookup",
	);
	const resultColumn = requireColumn(
		table,
		expr.resultColumnId,
		"evaluateTableLookup",
	);
	for (const [index, row] of rows.entries()) {
		if (matches(row, index)) {
			return lookupFixtureCellText(
				resultColumn.dataType,
				row.values[resultColumn.id],
			);
		}
	}
	return "";
}

/**
 * Fold every `table-lookup` in a predicate to its literal result so
 * downstream emission and evaluation never meet the carrier kinds.
 */
export function foldTableLookupsInPredicate(
	predicate: Predicate,
	data: PreviewLookupData,
	bindings: LookupEvaluationBindings,
): Predicate {
	return mapPredicateAst(predicate, foldHooks(data, bindings));
}

/** Expression twin of {@link foldTableLookupsInPredicate}. */
export function foldTableLookupsInExpression(
	expression: ValueExpression,
	data: PreviewLookupData,
	bindings: LookupEvaluationBindings,
): ValueExpression {
	return mapExpressionAst(expression, foldHooks(data, bindings));
}

function foldHooks(
	data: PreviewLookupData,
	bindings: LookupEvaluationBindings,
) {
	return {
		mapExpression: (expr: ValueExpression) =>
			expr.kind === "table-lookup"
				? {
						kind: "term" as const,
						term: literal(evaluateTableLookup(expr, data, bindings)),
					}
				: undefined,
	};
}

/** Does this predicate carry a `table-lookup` anywhere (nested
 *  `where`s included)? Callers use it to distinguish "needs the
 *  fixture snapshot" from "evaluable now". */
export function predicateReferencesTableLookup(predicate: Predicate): boolean {
	let found = false;
	mapPredicateAst(predicate, {
		mapExpression: (expr) => {
			if (expr.kind === "table-lookup") found = true;
			return undefined;
		},
	});
	return found;
}

/**
 * Compute a lookup-backed select's live choices: the filtered rows in
 * authored order, each projected to its value/label column cell text.
 * Rows whose cells are blank stay included — row-dependent validity
 * (blank values, duplicates) is the export boundary's verdict, and
 * the running preview renders the fixture the device would carry.
 */
export function evaluateLookupChoices(
	source: LookupOptionsSource,
	data: PreviewLookupData,
	bindings: LookupEvaluationBindings,
): readonly LookupChoice[] {
	const { table, rows, matches } = matchingRows(
		data,
		source.tableId,
		source.filter,
		bindings,
		"evaluateLookupChoices",
	);
	const valueColumn = requireColumn(
		table,
		source.valueColumnId,
		"evaluateLookupChoices",
	);
	const labelColumn = requireColumn(
		table,
		source.labelColumnId,
		"evaluateLookupChoices",
	);
	const choices: LookupChoice[] = [];
	for (const [index, row] of rows.entries()) {
		if (!matches(row, index)) continue;
		choices.push({
			value: lookupFixtureCellText(
				valueColumn.dataType,
				row.values[valueColumn.id],
			),
			label: lookupFixtureCellText(
				labelColumn.dataType,
				row.values[labelColumn.id],
			),
		});
	}
	return choices;
}
