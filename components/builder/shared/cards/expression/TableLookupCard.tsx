"use client";

import { useId } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import {
	ANY_CONSTRAINT,
	acceptsType,
	matchAll,
	type SlotConstraint,
	tableLookup,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	useEditorErrorsAt,
	usePredicateEditContext,
	WithLookupTableScope,
} from "../../editorContext";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import {
	type EditorLookupColumnDecl,
	type EditorLookupTableDecl,
	lookupColumnDisplayLabel,
} from "../../lookupTablePresentation";
import { appendKindSlot, type EditorPath } from "../../path";
import { InlineError } from "../../primitives/CardShell";
import { PredicateFocusBoundary } from "../ChildPredicateEditor";

function firstResultColumn(
	table: EditorLookupTableDecl,
	constraint: SlotConstraint,
): EditorLookupColumnDecl | undefined {
	return table.columns.find(
		(column) =>
			constraint.accepts === "any" || acceptsType(constraint, column.dataType),
	);
}

export function tableLookupDefault(
	ctx: ExpressionEditContext,
	constraint: SlotConstraint = ANY_CONSTRAINT,
): Extract<ValueExpression, { kind: "table-lookup" }> {
	for (const table of ctx.lookupTables ?? []) {
		const column = firstResultColumn(table, constraint);
		if (column !== undefined) {
			return tableLookup(table.id, column.id, matchAll());
		}
	}
	throw new Error(
		"A table lookup cannot be created without an available result column that fits this value.",
	);
}

interface TableLookupCardProps {
	readonly value: Extract<ValueExpression, { kind: "table-lookup" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
	readonly constraint?: SlotConstraint;
}

export function TableLookupCard({
	value,
	onChange,
	path,
	constraint = ANY_CONSTRAINT,
}: TableLookupCardProps) {
	const ctx = usePredicateEditContext();
	const tableSelectId = useId();
	const columnSelectId = useId();
	const tables = ctx.lookupTables;
	const table = tables.find((candidate) => candidate.id === value.tableId);
	const resultColumn = table?.columns.find(
		(column) => column.id === value.resultColumnId,
	);
	const eligibleTables = tables.filter(
		(candidate) =>
			candidate.id === value.tableId ||
			firstResultColumn(candidate, constraint) !== undefined,
	);
	const eligibleColumns =
		table?.columns.filter(
			(column) =>
				column.id === value.resultColumnId ||
				constraint.accepts === "any" ||
				acceptsType(constraint, column.dataType),
		) ?? [];
	const tableErrors = useEditorErrorsAt(
		appendKindSlot(path, "table-lookup", "tableId"),
	);
	const columnErrors = useEditorErrorsAt(
		appendKindSlot(path, "table-lookup", "resultColumnId"),
	);

	const selectTable = (nextId: string | null) => {
		const nextTable = tables.find((candidate) => candidate.id === nextId);
		if (nextTable === undefined) return;
		const nextColumn = firstResultColumn(nextTable, constraint);
		if (nextColumn === undefined) return;
		onChange(tableLookup(nextTable.id, nextColumn.id, matchAll()));
	};

	const selectColumn = (nextId: string | null) => {
		const nextColumn = table?.columns.find((column) => column.id === nextId);
		if (table === undefined || nextColumn === undefined) return;
		onChange(tableLookup(table.id, nextColumn.id, value.where));
	};

	return (
		<div className="space-y-3">
			<div className="grid gap-3 @md:grid-cols-2">
				<div className="space-y-1.5">
					<label
						htmlFor={tableSelectId}
						className="text-[13px] font-medium text-nova-text-secondary"
					>
						Data table
					</label>
					<Select value={value.tableId} onValueChange={selectTable}>
						<SelectTrigger
							id={tableSelectId}
							aria-label="Data table"
							aria-invalid={table === undefined || tableErrors.length > 0}
							className="h-11 w-full border-white/[0.06] bg-nova-deep/50 px-3 text-sm dark:bg-nova-deep/50"
						>
							<SelectValue>
								{table?.name ?? "A table that is no longer available"}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{eligibleTables.map((candidate) => (
								<SelectItem key={candidate.id} value={candidate.id}>
									{candidate.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<InlineError errors={tableErrors} />
				</div>

				<div className="space-y-1.5">
					<label
						htmlFor={columnSelectId}
						className="text-[13px] font-medium text-nova-text-secondary"
					>
						Value column
					</label>
					<Select
						value={value.resultColumnId}
						onValueChange={selectColumn}
						disabled={table === undefined}
					>
						<SelectTrigger
							id={columnSelectId}
							aria-label="Lookup result column"
							aria-invalid={
								resultColumn === undefined || columnErrors.length > 0
							}
							className="h-11 w-full border-white/[0.06] bg-nova-deep/50 px-3 text-sm dark:bg-nova-deep/50"
						>
							<SelectValue>
								{resultColumn === undefined
									? "A column that is no longer available"
									: lookupColumnDisplayLabel(resultColumn)}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{eligibleColumns.map((column) => (
								<SelectItem key={column.id} value={column.id}>
									{lookupColumnDisplayLabel(column)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<InlineError errors={columnErrors} />
				</div>
			</div>

			<div className="space-y-1.5">
				<p className="text-[13px] font-medium text-nova-text-secondary">
					Use the first row where
				</p>
				{table === undefined ? (
					<div className="rounded-lg border border-dashed border-white/[0.06] px-3 py-2 text-[13px] text-nova-text-muted">
						Choose an available table to repair this lookup.
					</div>
				) : (
					<WithLookupTableScope table={table}>
						<PredicateFocusBoundary
							value={value.where}
							onChange={(where) =>
								onChange(tableLookup(table.id, value.resultColumnId, where))
							}
							path={appendKindSlot(path, "table-lookup", "where")}
							variant="nested"
						/>
					</WithLookupTableScope>
				)}
			</div>
		</div>
	);
}
