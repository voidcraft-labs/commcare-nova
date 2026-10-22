import type { Uuid } from "@/lib/domain";
import { w } from "../xpath/wire/builders";
import type { WireExpr } from "../xpath/wire/tree";
import type { FormPath } from "./formPath";
import type { GeneratedNodePlan } from "./generatedNodes";

/** HQ generates untyped case-update binds. Reading a date-valued question into
 * one wraps it as DateData and loses the clock. A sibling text value preserves
 * the full instant on both HQ-regenerated and directly emitted submissions.
 * Its name is the form's plan of generated nodes' (`generatedNodes.ts`). */
export function datetimeCaseValuePath(
	plan: GeneratedNodePlan,
	fieldUuid: Uuid,
	path: FormPath,
): FormPath {
	const last = path.segments().at(-1);
	if (last?.kind !== "element")
		throw new Error("A datetime answer must have an element path.");
	return path.parent().child(plan.datetime(fieldUuid));
}

/**
 * The one spelling of a datetime case value, written on an untyped node: the
 * field's sibling text value here, and every Save to Case leaf that writes a
 * datetime property (`caseOps.ts`). HQ's form builder writes a Save to Case
 * row's bind with no `type`, so a typed leaf loses its clock on the first
 * save; this calculate keeps the instant on an untyped node, with the
 * device's offset and milliseconds. A value that is already a string is
 * parsed and printed again in the device's zone.
 */
export function datetimeCaseValueExpression(expression: WireExpr): WireExpr {
	// Core format-date(node-set) passes through toDate(), which rounds a
	// typed Date to midnight. coalesce unpacks the selected value first.
	return w.call("if", [
		w.eq(expression, w.str("")),
		w.str(""),
		w.call("format-date", [
			w.call("coalesce", [expression, w.str("")]),
			w.str("%Y-%m-%dT%H:%M:%S.%3%Z"),
		]),
	]);
}

export function datetimeCaseValueCalculate(path: FormPath): WireExpr {
	return datetimeCaseValueExpression(path.toWire());
}
