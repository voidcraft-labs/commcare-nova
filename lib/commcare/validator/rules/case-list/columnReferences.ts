/**
 * Rule: every runtime-active non-calculated column on
 * `caseListConfig.columns` carries a `field` that resolves to a property the
 * module's case type admits
 * — declared on `ct.properties[]`, written by a form field via
 * `case_property_on === mod.caseType`, or part of CommCare's standard
 * set (`case_name`, `date_opened`, …).
 *
 * `caseListConfig` carries one columns array — display + sort + calc +
 * visibility, all together. Calculated columns are the lone arm
 * without a `field` slot (their expression is the source); the field-
 * reference check skips them and leaves their property resolution to
 * the per-operand walk inside `calculatedColumnTypeCheck`. Every other
 * column kind exposes the same `field: string` slot, and every runtime
 * renderer reads the case property by that name. Fully off-screen, unsorted
 * legacy definitions are recovery state rather than runtime input, so the rule
 * ignores them until an author shows or sorts by them again.
 *
 * Property resolution routes through the shared `propertyExists`
 * helper, which reads the memoized `ValidationContext` augmented case-
 * type list — so this rule's admission set agrees with every other
 * case-list-config rule by construction.
 */

import {
	type BlueprintDoc,
	type Column,
	caseListColumnHasRuntimeRole,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";
import { propertyExists } from "./shared";

export function columnReferences(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (!config || !mod.caseType) return [];

	const errors: ValidationError[] = [];
	const caseType = mod.caseType;

	for (let index = 0; index < config.columns.length; index++) {
		const col = config.columns[index];
		if (!caseListColumnHasRuntimeRole(col)) continue;
		// Calculated columns have no `field` — their property references
		// live inside the `expression` AST and the per-operand type
		// checker (`calculatedColumnTypeCheck`) walks them through the
		// same admission set this rule consults.
		if (col.kind === "calculated") continue;
		if (propertyExists(doc, caseType, col.field)) continue;
		errors.push(buildUnknownFieldError(mod, moduleUuid, caseType, index, col));
	}

	return errors;
}

/**
 * Renders the `CASE_LIST_COLUMN_UNKNOWN_FIELD` error for a non-calculated
 * column whose `field` does not resolve. Authors locate the offending
 * entry by 1-based index + header so the message reads as a sentence
 * without the editor having to count discriminated-union arms. Takes
 * the resolved `caseType` as a parameter so the type system carries
 * the invariant the entry-point already established (`mod.caseType`
 * present) — no runtime re-check, no defensive throw.
 */
function buildUnknownFieldError(
	mod: Module,
	moduleUuid: Uuid,
	caseType: string,
	index: number,
	col: Exclude<Column, { kind: "calculated" }>,
): ValidationError {
	return validationError(
		"CASE_LIST_COLUMN_UNKNOWN_FIELD",
		"module",
		`Column "${col.header}" (column #${index + 1}) on the case list of module "${mod.name}" points at the case property "${col.field}", but no case property by that name is declared on case type "${caseType}", written by any form field via \`case_property_on\`, or part of CommCare's standard set ("case_name", "date_opened", …). Either add "${col.field}" to the "${caseType}" case type's properties, point a form field at it via \`case_property_on\`, or change the column's field to one of those names.`,
		{ moduleUuid, moduleName: mod.name },
		{ field: col.field, columnUuid: col.uuid, index: String(index) },
	);
}
