import type {
	AlwaysOfferedRegistration,
	BlueprintDoc,
	Uuid,
} from "@/lib/domain";
import { moduleExpressionContexts } from "../../expressionContext";
import { caseListStepDatumId } from "../../formLinkProjection";
import type { LookupWireNaming } from "../../lookup/naming";
import { toWire } from "../../xpath/wire/fromExpression";
import { NO_MATCHES_RELEVANCY } from "../case-search/noMatches";

/** The action runs on the list before this list's case is selected. HQ passes
 * its XPath unchanged to the suite action, so stored and installed spellings
 * both use the IDs of the aligned entry. */
export function caseListActionCondition(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	showWhen: AlwaysOfferedRegistration["showWhen"],
	target: "hq-json" | "suite",
	naming?: LookupWireNaming,
) {
	if (showWhen === undefined) return undefined;
	if (showWhen.kind === "empty-search") return NO_MATCHES_RELEVANCY;
	return toWire(showWhen.condition, {
		target,
		types: moduleExpressionContexts(
			doc,
			moduleUuid,
			naming,
		)({ slot: "case_list_action_condition" }),
		bindings: {
			datumId: caseListStepDatumId(doc, moduleUuid),
			...(naming !== undefined && {
				lookup: { naming, instanceScope: "suite" },
			}),
		},
	});
}
