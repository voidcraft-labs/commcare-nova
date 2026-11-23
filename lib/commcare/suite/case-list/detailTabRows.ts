import type { DetailTab } from "@/lib/domain/detailTabs";
import type { Expression } from "@/lib/domain/expression/types";
import type { Uuid } from "@/lib/domain/uuid";
import type { ModuleExpressionContexts } from "../../expressionContext";
import type { LookupWireNaming } from "../../lookup/naming";
import { w } from "../../xpath/wire/builders";
import {
	toWire,
	toWireNodes,
	type WireTermBindings,
} from "../../xpath/wire/fromExpression";
import { caseDbInstance, resultsInstance } from "../../xpath/wire/instances";

export type DetailCaseRoot = "casedb" | Parameters<typeof resultsInstance>[0];
export function detailRowExpressionWire(
	expression: Expression,
	tabUuid: Uuid,
	slot: "case_detail_tab_filter" | "case_detail_tab_rows",
	target: "hq-json" | "suite",
	root: DetailCaseRoot,
	expressions: ModuleExpressionContexts,
	naming?: LookupWireNaming,
	bindings?: WireTermBindings,
) {
	// The rows are the detail's nodeset; the filter is a condition.
	const lower = slot === "case_detail_tab_rows" ? toWireNodes : toWire;
	return lower(expression, {
		target,
		root,
		types: expressions({ slot, member: { tabUuid } }),
		bindings: {
			...bindings,
			...(naming && { lookup: { naming, instanceScope: "suite" } }),
		},
	});
}

/** The child shorthand uses this detail's own case instance. The parent
 * comparison reads current() from the enclosing detail, independent of any
 * other case in the session. CaseXPath.parent_id selects the named index. */
export function detailTabRowNodes(
	tab: DetailTab,
	root: DetailCaseRoot,
	expressions: ModuleExpressionContexts,
	naming?: LookupWireNaming,
	bindings?: WireTermBindings,
) {
	const source = tab.rowSource;
	if (!source) return;
	const lower = (
		expression: Expression,
		slot: "case_detail_tab_rows" | "case_detail_tab_filter",
	) =>
		detailRowExpressionWire(
			expression,
			tab.uuid,
			slot,
			"suite",
			root,
			expressions,
			naming,
			bindings,
		);
	if (source.kind === "records")
		return lower(source.rows, "case_detail_tab_rows");
	const instance = root === "casedb" ? caseDbInstance() : resultsInstance(root);
	return w.instance(instance, [
		w.step(root === "casedb" ? "casedb" : "results"),
		w.step("case", [
			w.eq(w.context([w.attr("case_type")]), w.str(source.caseType)),
			w.eq(
				w.context([w.step("index"), w.step("parent")]),
				w.current([w.attr("case_id")]),
			),
			w.eq(w.context([w.attr("status")]), w.str("open")),
			...(source.condition
				? [lower(source.condition, "case_detail_tab_filter")]
				: []),
		]),
	]);
}
