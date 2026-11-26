/**
 * The child case types CommCare HQ's Case Detail page offers a data tab of
 * a menu's case type: each type a basic form of a menu of that case type
 * opens as a child case it does not close (`views/modules.py`,
 * `app.get_subcase_types(module.case_type)`; `models/applications.py::
 * Application.get_subcase_types`, `models/forms.py::Form.get_subcase_types`).
 * The page's tab menu lists only these (`details/bootstrap5/
 * detail_tab_nodeset.js`, `dropdownOptions`), so a tab's child type outside
 * them is cleared by the page's next save.
 *
 * Total over a document the validator refuses: a form whose case wire does
 * not build (a registration that names no case yet, a slot reading a question
 * the form no longer holds) adds no child here, and the validator reports that
 * form's own finding.
 */

import type { BlueprintDoc } from "@/lib/domain";
import { type FormCaseWirePlan, planFormCaseWire } from "./casePlacementPlan";

export function hqOfferedChildCaseTypes(
	doc: BlueprintDoc,
	caseType: string | undefined,
): ReadonlySet<string> {
	const offered = new Set<string>();
	if (caseType === undefined) return offered;
	for (const moduleUuid of doc.moduleOrder) {
		if (doc.modules[moduleUuid]?.caseType !== caseType) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			let plan: FormCaseWirePlan;
			try {
				plan = planFormCaseWire(doc, formUuid);
			} catch {
				continue;
			}
			if (plan.kind !== "basic") continue;
			for (const child of plan.actions.subcases)
				if (child.case_type && child.close_condition.type === "never")
					offered.add(child.case_type);
		}
	}
	return offered;
}
