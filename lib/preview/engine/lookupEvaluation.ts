// lib/preview/engine/lookupEvaluation.ts
//
// Lookup-backed choices over one loaded fixture snapshot. A choice list
// evaluates as the itemset Core evaluates: the caller prints the nodeset the
// wire writes (`lib/commcare/lookupOptions.ts::lookupOptionsNodeset`) at the
// Preview target and evaluates it over the fixture instances
// (`xpathInstances.ts::lookupXPathInstances`); this module reads each
// selected row node back as its row and projects the value and label cells.
// The row filter is never folded or evaluated row by row here: `position()`,
// `current()` and every non-row read mean what they mean on the device
// because the device's own text runs over the device's own instance shape.
//
// Blank semantics are the fixture boundary's: a missing cell and a
// stored-empty cell both read as empty text (`lookupFixtureCellText`, the
// wire emits every defined column, an empty element for both).

import { lookupFixtureCellText } from "@/lib/commcare/lookup/cellText";
import {
	type LookupWireNaming,
	lookupWireNaming,
} from "@/lib/commcare/lookup/naming";
import {
	type BlueprintDoc,
	expressionSlotValues,
	type LookupColumnId,
	type LookupOptionsSource,
	type LookupTableId,
	type Uuid,
} from "@/lib/domain";
import { typeCheckerBypassMessage } from "@/lib/domain/expression";
import {
	type AstMapHooks,
	mapExpressionAst,
} from "@/lib/domain/expression/mapAst";
import type { Expression } from "@/lib/domain/expression/types";
import type {
	LookupColumn,
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { isXPathNodeSet, type XPathRuntimeValue } from "../xpath/runtimeValues";
import type { LookupChoice } from "./types";

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

export type { LookupChoice } from "./types";

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
			hint: "the carrier references a table outside the loaded set. Reload the lookup data for the doc's referenced tables, or repair the doc.",
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
			hint: "the definitions snapshot and the doc disagree. Refresh the lookup data; if the column was deleted, the commit validator owns the repair.",
		}),
	);
}

// ── Snapshot coverage ────────────────────────────────────────────────
//
// A snapshot covers only the tables the doc referenced AT FETCH TIME,
// so "a snapshot exists" is NOT "this carrier is decidable": a validly
// committed edit can reference a Project table or a fresh column the
// held snapshot predates. Every evaluation surface asks coverage
// FIRST and treats a miss as its loading state (the generation-keyed
// refetch is already in flight); the requireTable/requireColumn
// throws below then fire only on a genuinely bypassed validator.

interface LookupIdentityCollector {
	covered: boolean;
	check: (tableId: LookupTableId, columnId?: LookupColumnId) => void;
}

function identityCollector(
	data: PreviewLookupData | undefined,
): LookupIdentityCollector {
	const collector: LookupIdentityCollector = {
		covered: true,
		check: (tableId, columnId) => {
			const table = data?.tablesById.get(tableId);
			if (table === undefined) {
				collector.covered = false;
				return;
			}
			if (
				columnId !== undefined &&
				!table.columns.some((column) => column.id === columnId)
			) {
				collector.covered = false;
			}
		},
	};
	return collector;
}

function coverageHooks(collector: LookupIdentityCollector): AstMapHooks {
	return {
		mapExpression: (expr) => {
			if (expr.kind === "table-lookup") {
				collector.check(expr.tableId, expr.resultColumnId);
			}
			if (expr.kind === "table-rows") collector.check(expr.tableId);
			// Descend — nested `where`s carry the table-column terms.
			return undefined;
		},
		mapTerm: (node) => {
			if (node.kind === "table-column") {
				collector.check(node.tableId, node.columnId);
			}
			return undefined;
		},
	};
}

/**
 * Does the snapshot cover every lookup identity this predicate
 * references? `undefined` data covers exactly the carrier-free case.
 */
export function predicateLookupsCovered(
	predicate: Expression,
	data: PreviewLookupData | undefined,
): boolean {
	const collector = identityCollector(data);
	mapExpressionAst(predicate, coverageHooks(collector));
	return collector.covered;
}

/** Expression twin of {@link predicateLookupsCovered}. */
export function expressionLookupsCovered(
	expression: Expression,
	data: PreviewLookupData | undefined,
): boolean {
	const collector = identityCollector(data);
	mapExpressionAst(expression, coverageHooks(collector));
	return collector.covered;
}

/**
 * Whether a snapshot covers every table a form's logic, Connect block and
 * links read. Printing such a read needs the table's naming, so an entry
 * whose logic reads a table waits for the covering snapshot before its engine
 * is built. A choice list's source is left out: its choices have their own
 * loading state.
 */
export function formLogicLookupsCovered(
	doc: BlueprintDoc,
	formUuid: Uuid,
	data: PreviewLookupData | undefined,
): boolean {
	const covered = (owner: {
		readonly entity: "form" | "field";
		readonly uuid: Uuid;
	}) =>
		expressionSlotValues(doc, owner).every(
			({ ref, expression }) =>
				ref.slot === "lookup_options_source" ||
				expressionLookupsCovered(expression, data),
		);
	if (!covered({ entity: "form", uuid: formUuid })) return false;
	const visit = (parent: Uuid): boolean =>
		(doc.fieldOrder[parent] ?? []).every(
			(uuid) => covered({ entity: "field", uuid }) && visit(uuid),
		);
	return visit(formUuid);
}

/**
 * Does the snapshot cover a lookup-backed select's whole identity —
 * table, value/label columns, and every carrier in its filter?
 */
export function lookupOptionsSourceCovered(
	source: LookupOptionsSource,
	data: PreviewLookupData | undefined,
	sortColumnId?: LookupColumnId,
): boolean {
	const collector = identityCollector(data);
	collector.check(source.tableId, source.valueColumnId);
	collector.check(source.tableId, source.labelColumnId);
	if (sortColumnId !== undefined) collector.check(source.tableId, sortColumnId);
	if (source.filter !== undefined) {
		mapExpressionAst(source.filter, coverageHooks(collector));
	}
	return collector.covered;
}

/**
 * A lookup-backed select's live choices from its evaluated itemset nodeset:
 * each selected row, projected to its value/label column cell text. Rows
 * whose cells are blank stay included: row-dependent validity (blank values,
 * duplicates) is the export boundary's verdict, and the running preview
 * renders the fixture the device would carry.
 *
 * A row node's sibling multiplicity is its position in the table's ordered
 * rows, which is the order the fixture instance holds them in.
 *
 * Without `sortColumnId` the choices keep the nodeset's order, the table's
 * row order, as a form select's do. With it they are ordered by that
 * column's cell text compared code unit by code unit, ties in row order: the
 * order Core gives an `<itemset>` with a `<sort>`
 * (`ItemsetBinding.sortChoices` compares Java strings with a stable sort),
 * never a locale's collation.
 */
export function lookupChoicesFromNodeset(
	source: LookupOptionsSource,
	data: PreviewLookupData,
	nodeset: XPathRuntimeValue,
	sortColumnId?: LookupColumnId,
): readonly LookupChoice[] {
	if (!isXPathNodeSet(nodeset))
		throw new Error(
			"A lookup choice list's itemset did not select rows. Preview evaluates the nodeset the form writes, which always names the table's rows.",
		);
	const { table, rows } = requireTable(
		data,
		source.tableId,
		"lookupChoicesFromNodeset",
	);
	const valueColumn = requireColumn(
		table,
		source.valueColumnId,
		"lookupChoicesFromNodeset",
	);
	const labelColumn = requireColumn(
		table,
		source.labelColumnId,
		"lookupChoicesFromNodeset",
	);
	const sortColumn =
		sortColumnId === undefined
			? undefined
			: requireColumn(table, sortColumnId, "lookupChoicesFromNodeset");
	const choices: {
		readonly choice: LookupChoice;
		readonly sortText: string;
	}[] = [];
	for (const node of nodeset.nodes) {
		const row = rows[node.multiplicity];
		if (row === undefined)
			throw new Error(
				`A lookup choice list selected row ${node.multiplicity + 1} of table \`${table.name}\`, which holds ${rows.length} rows in the loaded snapshot.`,
			);
		choices.push({
			choice: {
				key: row.id as string,
				value: lookupFixtureCellText(
					valueColumn.dataType,
					row.values[valueColumn.id],
				),
				label: lookupFixtureCellText(
					labelColumn.dataType,
					row.values[labelColumn.id],
				),
			},
			sortText:
				sortColumn === undefined
					? ""
					: lookupFixtureCellText(
							sortColumn.dataType,
							row.values[sortColumn.id],
						),
		});
	}
	if (sortColumn !== undefined) {
		// `Array.prototype.sort` is stable, and `<` on strings compares UTF-16
		// code units, as Java's `String.compareTo` does.
		choices.sort((a, b) =>
			a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0,
		);
	}
	return choices.map((entry) => entry.choice);
}
