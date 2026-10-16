import type {
	CaseOptionsSource,
	CaseType,
	Field,
	MultiSelectField,
	SingleSelectField,
} from "@/lib/domain";
import { emitCaseListFilter } from "./predicate/caseListFilterEmitter";
import { quoteLiteral } from "./predicate/stringQuoting";
import type { OnDeviceTermEmissionContext } from "./predicate/termEmitter";

/** Standard device itemsets, evaluated against the worker's local case database.
 * current() is the question, so candidate relations use immediate-scope joins. */
export function caseOptionsNodeset(
	source: CaseOptionsSource,
	caseTypes: readonly CaseType[],
	bindings: OnDeviceTermEmissionContext,
): string {
	const base = `instance('casedb')/casedb/case[@case_type=${quoteLiteral(source.caseType, "case-list-filter")}]`;
	return source.filter === undefined
		? base
		: `${base}[${emitCaseListFilter(source.filter, "casedb", { caseTypes: [...caseTypes], currentCaseType: source.caseType }, { kind: "unaddressable" }, bindings)}]`;
}

/**
 * Whether a question's choices are the worker's cases: a select whose
 * `optionsSource` is `cases`, which `xform/builder.ts::buildFieldParts`
 * writes as an `<itemset>` over `casedb`. HQ's form builder reports an error
 * on every question that holds an itemset without the plan privilege
 * `lookup_tables` (Vellum's `src/itemset.js`, given `features.lookup_tables`
 * by `views/formdesigner.py`), so publish asks for that privilege for such
 * a question (`planPrivileges.ts`), and the builder's itemset arm reads this
 * same test.
 */
export function fieldTakesCaseChoices(field: Field): field is (
	| SingleSelectField
	| MultiSelectField
) & {
	optionsSource: CaseOptionsSource;
} {
	return (
		(field.kind === "single_select" || field.kind === "multi_select") &&
		field.optionsSource.kind === "cases"
	);
}
