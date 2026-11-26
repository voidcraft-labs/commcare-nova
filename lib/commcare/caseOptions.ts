import {
	type CaseOptionsSource,
	type DeviceCaseOptionsSource,
	type Field,
	isDeviceCaseOptionsSource,
	type MultiSelectField,
	type SingleSelectField,
} from "@/lib/domain";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import type { RewriteControl } from "./emissionRewrites";
import type { FormNodeProjection } from "./xpath/formNodeProjection";
import { w } from "./xpath/wire/builders";
import { toWire, type WireTermBindings } from "./xpath/wire/fromExpression";
import { caseDbInstance } from "./xpath/wire/instances";
import type { WireExpr } from "./xpath/wire/tree";

/** The whole local device case instance, with no type or filter predicate. */
export function availableCasesNodeset(
	predicates: readonly WireExpr[] = [],
): WireExpr {
	return w.instance(caseDbInstance(), [
		w.step("casedb"),
		w.step("case", predicates),
	]);
}

/** Standard device itemsets, evaluated against the worker's local case database.
 * current() is the question, so candidate relations use immediate-scope joins.
 * `rewrites` is the reader's control over the rewrites the filter's print
 * reaches (`emissionRewrites.ts`); an export passes none. */
export function caseOptionsNodeset(
	source: CaseOptionsSource,
	types: ExpressionContext,
	bindings: WireTermBindings,
	form: FormNodeProjection,
	rewrites?: RewriteControl,
): WireExpr {
	const predicates = [
		w.eq(w.context([w.attr("case_type")]), w.str(source.caseType)),
	];
	if (source.filter !== undefined)
		predicates.push(
			toWire(source.filter, {
				target: "xform",
				types,
				form,
				anchor: { kind: "unaddressable" },
				bindings,
				...(rewrites === undefined ? {} : { rewrites }),
			}),
		);
	return availableCasesNodeset(predicates);
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
	optionsSource: DeviceCaseOptionsSource;
} {
	return (
		(field.kind === "single_select" || field.kind === "multi_select") &&
		isDeviceCaseOptionsSource(field.optionsSource)
	);
}
