import type { BlueprintDoc, Module } from "@/lib/domain";
import { moduleFormsReadSearch } from "@/lib/domain/modules";
import { searchAnswersOf } from "../../emissionPlan";
import { caseListStepDatumId } from "../../formLinkProjection";
import type { WireTermBindings } from "../../xpath/wire/fromExpression";

/** Selected-case Details and form context use the same prior selections as
 * this menu’s case list. An inline query has also supplied its responses. */
export function detailBindings(
	doc: BlueprintDoc,
	menu: Module,
): WireTermBindings {
	const datumId = caseListStepDatumId(doc, menu.uuid);
	if (!moduleFormsReadSearch(menu)) return { datumId };
	const answers = searchAnswersOf(doc, menu.uuid);
	return {
		datumId,
		searchInputInstanceId: answers.instanceId,
		searchInputNames: answers.names,
	};
}
