// components/builder/shared/editorAxes.ts
//
// The menu axes of an expression editor, read from its slot. The checker's
// context (`slotContext`) already says what the slot may read: its profile's
// scope and targets, its rows, its owner and pattern facts. The editor's
// menus speak a smaller vocabulary of the same facts (`caseDataScope`,
// `evaluationTarget`, `ownerValues`, `patternMatching`, `tableScope`), and
// this file is the one place that vocabulary is derived, so no surface
// writes an axis by hand and the offer set stays the gate's accept set.
//
// A leaf with type-only imports from the card registry, so the pure
// cascade-reseed helpers and the React provider can both read it.

import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type LookupTableId,
} from "@/lib/domain";
import {
	activeRowScope,
	type ExpressionContext,
	type ExpressionSlotRef,
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression";
import type { CaseDataScope, EvaluationTarget } from "./editorSchemas";
import type {
	EditorLookupTableDecl,
	EditorLookupTableScope,
} from "./lookupTablePresentation";

/** What an expression editor's menus know about the slot they edit. */
export interface EditorAxes {
	readonly caseDataScope: CaseDataScope;
	readonly evaluationTarget: EvaluationTarget;
	/** The two owner values ("Person using the app", "No owner"): only a case
	 * change's owner. */
	readonly ownerValues: boolean;
	readonly patternMatching?: true;
	/** The data-table row a lookup rule runs against, with its columns from the
	 * Project's catalog. Absent while the catalog has not loaded the table. */
	readonly tableScope?: EditorLookupTableScope;
}

/** Whether this exact form opens with a case already chosen: the fact a case
 * change's case reads follow (`rules/caseOperations.ts`, `sessionCaseAvailable`). */
function formOpensWithCase(context: ExpressionContext): boolean {
	const form = context.form;
	if (form === undefined) return false;
	return (
		context.facts.moduleCaseTypes.get(form.moduleUuid) !== undefined &&
		CASE_LOADING_FORM_TYPES.has(form.type)
	);
}

function caseDataScopeOf(context: ExpressionContext): CaseDataScope {
	// A data-table row the expression reads inside: a lookup rule's own row,
	// or a table-rows query's condition nested in any slot. The checker reads
	// that row's columns there, whatever the slot's own scope.
	if (activeRowScope(context)?.kind === "table") return "table-row";
	switch (context.profile.scope) {
		case "case":
			return "per-case";
		case "table":
			return "table-row";
		// A form's display condition on a menu where the case is picked first
		// reads that one case; everywhere else no case is chosen yet.
		case "session":
			return context.profile.caseData ? "selected-case" : "global";
		// A case change reads the form's case only when this form opens with one.
		// "selected-case" is not the middle answer here: the gate admits none of
		// the chosen case's properties in a form without one.
		case "submission":
			return formOpensWithCase(context) ? "per-case" : "global";
		case "global":
		case "form":
			return "global";
	}
}

function evaluationTargetOf(context: ExpressionContext): EvaluationTarget {
	const { targets } = context.profile;
	const device =
		targets.has("XF") || targets.has("SU") || context.runsOnDevice === true;
	if (!targets.has("CS")) return "on-device";
	return device ? "on-device-and-case-search" : "case-search";
}

function tableIdOf(context: ExpressionContext): LookupTableId | undefined {
	const row = activeRowScope(context);
	return row?.kind === "table" ? row.tableId : undefined;
}

/** The axes of the slot `context` belongs to, at the place in the
 * expression `context` was derived for: a nested query's condition reads the
 * rows that query binds. `lookupTables` is the rows-free Project catalog the
 * editor already holds, which names a data-table row's columns; a surface
 * whose slot reads no table row may leave it out. */
export function editorAxesOf(
	context: ExpressionContext,
	lookupTables: readonly EditorLookupTableDecl[] = [],
): EditorAxes {
	const tableId = tableIdOf(context);
	const table =
		tableId === undefined
			? undefined
			: lookupTables.find((candidate) => candidate.id === tableId);
	return {
		caseDataScope: caseDataScopeOf(context),
		evaluationTarget: evaluationTargetOf(context),
		ownerValues: context.profile.ownerValues,
		...(context.profile.patternMatching && { patternMatching: true }),
		...(table !== undefined && {
			tableScope: { tableId: table.id, columns: table.columns },
		}),
	};
}

/**
 * The checker's context for one slot of `doc` and the editor axes read from
 * it. The same `slotContext` call the deep validator makes, so what the editor
 * offers is judged with exactly what the gate judges with. Undefined when the
 * slot's owner no longer exists.
 */
export function editorAxesForSlot(
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	lookupTypes: LookupTypeIndex,
	lookupTables: readonly EditorLookupTableDecl[] = [],
):
	| { readonly context: ExpressionContext; readonly axes: EditorAxes }
	| undefined {
	const context = slotContext(doc, slot, lookupTypes);
	return context === undefined
		? undefined
		: { context, axes: editorAxesOf(context, lookupTables) };
}
