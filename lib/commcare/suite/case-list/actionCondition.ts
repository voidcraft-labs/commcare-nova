import type {
	AlwaysOfferedRegistration,
	BlueprintDoc,
	Uuid,
} from "@/lib/domain";
import { moduleExpressionContexts } from "../../expressionContext";
import {
	caseListActionDatums,
	caseListActionTarget,
	caseListSessionDatums,
	caseListStepDatumId,
	formLinkProjectionContext,
} from "../../formLinkProjection";
import {
	identityLookupWireNaming,
	type LookupWireNaming,
} from "../../lookup/naming";
import { toWire } from "../../xpath/wire/fromExpression";
import { serializeWire } from "../../xpath/wire/serialize";
import type { WireExpr } from "../../xpath/wire/tree";
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

/**
 * The instances a list action's condition reads that CommCare HQ's build
 * does not declare where the list asks for its case, by id, in reading order.
 *
 * HQ copies the condition into the action's `relevant` as written
 * (`sections/details.py::get_case_list_form_action`) but declares an entry's
 * instances from the XPath it collects for that entry
 * (`post_process/instances.py::_get_all_xpaths_for_entry`), and the details'
 * part of that is `xml_models.py::Detail.get_all_xpaths`: the detail's
 * nodeset, its variables and each action's frames, never an action's
 * `relevant`. Core evaluates the condition in the entry's own scope
 * (`Detail.getCustomActions` → `CommCareSession.getEvaluationContext`), and a
 * read of an instance that scope lacks throws, so the list does not open.
 *
 * The declared set counted here is what every entry showing the host's list
 * holds for certain: the datums before and at the host's selection
 * (`caseListSessionDatums`) and the action's own frame datums. A table is
 * named by its own id (`identityLookupWireNaming`), so two reads of one table
 * meet at one id. Nothing is read where the condition is not one.
 */
export function caseListActionUndeclaredInstances(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	showWhen: AlwaysOfferedRegistration["showWhen"],
): readonly string[] {
	if (showWhen?.kind !== "condition") return [];
	const naming = identityLookupWireNaming();
	const condition = caseListActionCondition(
		doc,
		moduleUuid,
		showWhen,
		"suite",
		naming,
	);
	if (condition === undefined) return [];
	const read = idsOf(condition);
	if (read.length === 0) return [];
	const ctx = formLinkProjectionContext(doc, { lookupNaming: naming });
	const declared = new Set<string>();
	for (const datum of caseListSessionDatums(doc, ctx, moduleUuid)) {
		if (datum.nodeset !== undefined)
			for (const id of idsOf(datum.nodeset)) declared.add(id);
		if (datum.function !== undefined)
			for (const id of idsOf(datum.function)) declared.add(id);
	}
	const target = caseListActionTarget(doc, ctx, moduleUuid);
	if (target !== undefined)
		for (const { value } of caseListActionDatums(doc, ctx, moduleUuid, target))
			for (const id of idsOf(value)) declared.add(id);
	return read.filter((id) => !declared.has(id));
}

function idsOf(expr: WireExpr): string[] {
	return [
		...new Set(
			[...serializeWire(expr, { target: "suite" }).instances].map(
				(instance) => instance.id,
			),
		),
	];
}
