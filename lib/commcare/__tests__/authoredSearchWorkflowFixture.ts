/**
 * A fixture document's searches given the workflow the cutover gives a
 * stored menu (`lib/doc/searchWorkflowPlan.ts::authoredSearchWorkflow`), for
 * fixtures built in the shape a search had before it held a workflow: no
 * `workflow`, no `formsReadSearch`. Every module with an ordinary search
 * takes what the planner gives it from its inputs, its filter and the app's
 * declaration, so the fixture's wire stays the wire the planner keeps.
 */
import { authoredSearchWorkflow } from "@/lib/doc/searchWorkflowPlan";
import {
	type BlueprintDoc,
	declaresWebApps,
	effectiveCaseSearchConfig,
	visibleSearchInputs,
} from "@/lib/domain";
import { effectiveFilterForEmission } from "@/lib/domain/expression";

export function withAuthoredSearchWorkflows(doc: BlueprintDoc): BlueprintDoc {
	const modules = { ...doc.modules };
	for (const moduleUuid of doc.moduleOrder) {
		const mod = modules[moduleUuid];
		if (mod === undefined) continue;
		const search = effectiveCaseSearchConfig(mod);
		if (search === undefined) continue;
		const authored = authoredSearchWorkflow({
			searchFirst: false,
			hasVisibleInput:
				visibleSearchInputs(mod.caseListConfig?.searchInputs ?? []).length > 0,
			hasEffectiveFilter:
				effectiveFilterForEmission(mod.caseListConfig?.filter) !== undefined,
			declaresWebApps: declaresWebApps(doc),
		});
		if (authored.workflow === undefined) continue;
		modules[moduleUuid] = {
			...mod,
			caseSearchConfig: { ...search, workflow: authored.workflow },
		};
	}
	return { ...doc, modules };
}
