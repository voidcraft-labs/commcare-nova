/**
 * The forms that create, in a basic subcase slot, a child of their own
 * module's case type: an unheld create of that type takes the slot as any
 * child does, and a held one keeps it. HQ's build writes such a child's
 * parent index only where the project space leaves `DONT_INDEX_SAME_CASETYPE`
 * off, HQ's default (`corehq/apps/app_manager/xform.py::XForm._create_casexml`,
 * `corehq/toggles/__init__.py`), so a publish checks the project space for
 * the capability `same-type-child-links` wherever this list is not empty.
 *
 * Read from `placement.ts::planPlacements`, so it cannot disagree with the
 * `subcases` the plan emits.
 */

import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { moduleCaseTypeForActions } from "./formLinkProjection";
import { appPlacements } from "./placement";

export interface SameTypeChildCase {
	readonly formUuid: Uuid;
	readonly operationUuid: Uuid;
	readonly caseType: string;
	/** "registers" on a registration form, "works-on" on a form that loads
	 *  its case. */
	readonly ownCase: "registers" | "works-on";
}

/**
 * Every create placed (held or simplest) in a basic subcase slot whose case
 * type is its module's case type for actions (HQ's `form.get_case_type()`),
 * in document order.
 */
export function sameTypeBasicChildCases(
	doc: BlueprintDoc,
): readonly SameTypeChildCase[] {
	const found: SameTypeChildCase[] = [];
	const placements = appPlacements(doc);
	for (const moduleUuid of doc.moduleOrder) {
		const moduleType = moduleCaseTypeForActions(doc, moduleUuid);
		if (moduleType === "") continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			const planned = placements.get(formUuid)?.placements;
			if (form === undefined || planned === undefined) continue;
			for (const operation of form.caseOperations ?? []) {
				const placement = planned.get(operation.uuid)?.placement;
				if (
					operation.action === "create" &&
					operation.caseType === moduleType &&
					placement?.kind === "basic" &&
					(placement.slot === "subcase" || placement.slot === "subcase-row")
				)
					found.push({
						formUuid,
						operationUuid: operation.uuid,
						caseType: operation.caseType,
						ownCase: form.type === "registration" ? "registers" : "works-on",
					});
			}
		}
	}
	return found;
}
