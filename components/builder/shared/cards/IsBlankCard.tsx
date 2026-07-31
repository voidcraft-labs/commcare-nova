// components/builder/shared/cards/IsBlankCard.tsx
//
// Renders the `is-blank` predicate (absent or empty string). The
// portable absent-or-empty operator — emits cleanly on every CCHQ
// dialect.

"use client";
import {
	absenceSubjectConstraint,
	isBlank,
	type Predicate,
	prop,
	sessionContext,
	tableColumn,
} from "@/lib/domain/predicate";
import {
	caseDataInScope,
	type PredicateEditContext,
	tableRowInScope,
} from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { PredicateVerbMenu } from "./PredicateVerbMenu";

export function isBlankDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "is-blank" }> {
	if (tableRowInScope(ctx)) {
		const column = ctx.tableScope?.columns[0];
		if (ctx.tableScope === undefined || column === undefined) {
			throw new Error(
				"A table-row blank condition requires one active-table column.",
			);
		}
		return isBlank(tableColumn(ctx.tableScope.tableId, column.id));
	}
	// A global slot reads no case. Seed a REAL always-present session
	// value (never an invented user-data field name); the author swaps
	// the subject to their own current-user field from the picker.
	if (!caseDataInScope(ctx)) return isBlank(sessionContext("username"));
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties[0];
	const propName = property?.name ?? "";
	return isBlank(prop(ctx.currentCaseType, propName));
}

interface IsBlankCardProps {
	readonly value: Extract<Predicate, { kind: "is-blank" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function IsBlankCard({ value, onChange, path }: IsBlankCardProps) {
	return (
		<div className="space-y-2">
			<div className="grid grid-cols-1 @md:grid-cols-[1.4fr_auto] gap-2 items-start">
				<ExpressionPicker
					value={value.left}
					onChange={(left) => onChange(isBlank(left))}
					path={appendSlot(path, "left")}
					constraint={absenceSubjectConstraint()}
					presentation="subject"
					variant="nested"
				/>
				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>
			<div className="text-[13px] leading-relaxed text-nova-text-muted">
				Matches when this information is blank or hasn’t been recorded
			</div>
		</div>
	);
}
