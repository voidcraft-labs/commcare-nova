import type { CaseOptionsSource, CaseType } from "@/lib/domain";
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
