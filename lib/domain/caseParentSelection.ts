import type { BlueprintDoc } from "./blueprint";
import { CASE_FORM_TYPES } from "./forms";
import type { Uuid } from "./uuid";

function selectsCases(doc: BlueprintDoc, uuid: Uuid): boolean {
	const module = doc.modules[uuid];
	return (
		!!module?.caseType &&
		(module.caseListOnly === true ||
			(doc.formOrder[uuid] ?? []).some((id) => {
				const form = doc.forms[id];
				return form !== undefined && CASE_FORM_TYPES.has(form.type);
			}))
	);
}

/** Record ancestry and the route used to select a record are separate choices. */
export function caseParentSelectionVerdict(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	parentUuid: Uuid,
): { ok: true } | { ok: false; message: string } {
	const module = doc.modules[moduleUuid];
	const parent = doc.modules[parentUuid];
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
	const recordType = doc.caseTypes?.find(
		(type) => type.name === module.caseType,
	);
	if (recordType?.relationship === "extension")
		return {
			ok: false,
			message:
				"Parent selection follows child records. Extension records need a flat list or an explicit filter.",
		};
	const parentType = recordType?.parent_type;
	if (
		parentUuid === moduleUuid ||
		!parentType ||
		parent.caseType !== parentType
	)
		return {
			ok: false,
			message: `Choose a module for the parent record type of ${module.name}.`,
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
