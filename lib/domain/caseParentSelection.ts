import { menuEmittedAdvanced } from "./advancedEntryDatums";
import type { BlueprintDoc } from "./blueprint";
import { CASE_FORM_TYPES } from "./forms";
import { menuFormUuidsOf, menuWithInheritedCaseSettings } from "./listedForms";
import { moduleHasCaseListMenuItem } from "./modules";
import type { Uuid } from "./uuid";

/** Whether the menu, or the source a listing menu takes its forms and case
 * type from, selects records. A listing menu owns no forms, so its visible
 * forms are its source's. */
function selectsCases(doc: BlueprintDoc, uuid: Uuid): boolean {
	const module = menuWithInheritedCaseSettings(doc, uuid);
	return (
		!!module?.caseType &&
		(moduleHasCaseListMenuItem(module) ||
			menuFormUuidsOf(doc, uuid).some((id) => {
				const form = doc.forms[id];
				return form !== undefined && CASE_FORM_TYPES.has(form.type);
			}))
	);
}

/** Record ancestry and the route used to select a record are separate choices.
 * Any menu of another record type may supply a basic menu's parent, as
 * CommCare HQ's menu settings offer them and its build admits them
 * (`views/modules.py::get_modules_with_parent_case_type`); the catalog only
 * marks the likely ones. HQ's offer also leaves out a menu that selects
 * several records, which the picker follows and publishing refuses
 * (`HQ_NESTED_SELECTION_UNREPRESENTABLE`). */
export function caseParentSelectionVerdict(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	parentUuid: Uuid,
): { ok: true } | { ok: false; message: string } {
	const module = menuWithInheritedCaseSettings(doc, moduleUuid);
	const parent = menuWithInheritedCaseSettings(doc, parentUuid);
	if (!module || !selectsCases(doc, moduleUuid))
		return {
			ok: false,
			message: "Parent selection needs a module that uses records.",
		};
	if (!parent || !selectsCases(doc, parentUuid))
		return {
			ok: false,
			message: "Choose a parent module that has a case list or case forms.",
		};
	// A selection follows the links on saved records. The catalog describes
	// what this app writes and cannot describe every link already on a device.
	// A basic menu's selection is HQ's `parent_select`, whose build refuses a
	// menu of the same type (`validators.py::validate_parent_select`); an
	// advanced menu loads the parent through its named index instead.
	if (
		parent.caseType === module.caseType &&
		!menuEmittedAdvanced(doc, moduleUuid)
	)
		return {
			ok: false,
			message: `Choose a menu that lists a different record type from ${module.name}.`,
		};
	const seen = new Set<Uuid>([moduleUuid]);
	let current: Uuid | undefined = parentUuid;
	while (current !== undefined) {
		if (seen.has(current))
			return {
				ok: false,
				message:
					"Parent selection cannot return to a module already in its route.",
			};
		seen.add(current);
		current = doc.modules[current]?.parentCaseModuleUuid;
	}
	return { ok: true };
}
