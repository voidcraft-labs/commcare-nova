import type { Element } from "domhandler";
import type { DeviceLookupExtra } from "@/lib/domain/modules";
import { el, type WireElementContext, xel } from "../../elementBuilders";
import { w } from "../../xpath/wire/builders";
import { sessionContextPath } from "../../xpath/wire/fromExpression";
import type { WireExpr } from "../../xpath/wire/tree";

/** Values the companion receives before the worker chooses a case. */
export function deviceLookupExtraWire(extra: DeviceLookupExtra): WireExpr {
	if ("value" in extra) return w.str(extra.value);
	const expression = extra.expression;
	if (expression.kind === "term")
		return sessionContextPath(expression.term.field);
	return w.add(
		w.num(expression.left.term.value),
		w.num(expression.right.term.value),
	);
}

export function lookupConfidenceLocaleId(moduleIndex: number): string {
	return `case_lists.m${moduleIndex}.callout.header`;
}

export function lookupCaseKeyWire(property?: string): WireExpr {
	return w.context([
		property === undefined ? w.attr("case_id") : w.step(property),
	]);
}

export function lookupConfidenceColumn(
	moduleIndex: number,
	wire: WireElementContext,
	resultProperty?: string,
): Element {
	return el("field", {}, [
		el("header", {}, [
			el("text", {}, [
				el("locale", { id: lookupConfidenceLocaleId(moduleIndex) }),
			]),
		]),
		el("template", {}, [
			el("text", {}, [
				xel(
					"xpath",
					{ xpath: { function: lookupCaseKeyWire(resultProperty) } },
					wire,
				),
			]),
		]),
	]);
}
