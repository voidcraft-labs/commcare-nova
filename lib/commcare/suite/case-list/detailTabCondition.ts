import type { Uuid } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import type { ModuleExpressionContexts } from "../../expressionContext";
import type { LookupWireNaming } from "../../lookup/naming";
import { toWire, type WireTermBindings } from "../../xpath/wire/fromExpression";
import type { DetailCaseRoot } from "./detailTabRows";

/** Core evaluates a child detail's relevance in the selected outer case.
 * HQ copies this XPath directly onto the detail without interpolating it. */
export function detailTabConditionWire(
	condition: Expression,
	tabUuid: Uuid,
	expressions: ModuleExpressionContexts,
	target: "suite" | "hq-json",
	root: DetailCaseRoot,
	lookupNaming?: LookupWireNaming,
	bindings?: WireTermBindings,
) {
	return toWire(condition, {
		target,
		root,
		types: expressions({
			slot: "case_detail_tab_condition",
			member: { tabUuid },
		}),
		bindings: {
			...bindings,
			...(lookupNaming && {
				lookup: { naming: lookupNaming, instanceScope: "suite" },
			}),
		},
	});
}
