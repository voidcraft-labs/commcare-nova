import {
	type AvailableCasesOptionsSource,
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
import { casePropertyStep } from "./xpath/wire/rowScope";
import type { WireExpr } from "./xpath/wire/tree";

/** The local device case path, with the predicates of the chosen source. */
function deviceCasesNodeset(predicates: readonly WireExpr[] = []): WireExpr {
	return w.instance(caseDbInstance(), [
		w.step("casedb"),
		w.step("case", predicates),
	]);
}

/** Restored cases narrowed by optional row-local status and property checks. */
export function availableCasesNodeset(
	source: Pick<AvailableCasesOptionsSource, "status" | "propertyMatch">,
): WireExpr {
	const predicates: WireExpr[] = [];
	if (source.status !== undefined)
		predicates.push(w.eq(w.context([w.attr("status")]), w.str(source.status)));
	const match = source.propertyMatch;
	if (match !== undefined) {
		const matches = (property: string, text: string) =>
			w.eq(w.context([casePropertyStep(property)]), w.str(text));
		const equals = matches(match.property, match.text);
		predicates.push(
			match.alternateText === undefined
				? equals
				: w.or(
						equals,
						matches(
							match.alternateProperty ?? match.property,
							match.alternateText,
						),
					),
		);
	}
	return deviceCasesNodeset(predicates);
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
	return deviceCasesNodeset(predicates);
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
