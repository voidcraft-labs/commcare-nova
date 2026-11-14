/** Client-safe authoring projection of entry-point eligibility. */

import {
	afterEmptySearchRegistrationFormOf,
	type BlueprintDoc,
	type EntryPointTarget,
	entryPointAt,
	menuScreenOf,
	moduleShowsFormsInMenuAbove,
} from "@/lib/domain";
import {
	createEntryPointRequirements,
	type EntryPointRequirements,
	entryPointRequirements,
	entryPointSharesFirstMenuCase,
} from "./entryPointProjection";
import { firstMenuSharedCaseSentence } from "./userFacingErrors";

/** Why the gate refuses an entry point on this destination for a menu that
 *  shows its forms in the menu above, in the builder's words, or
 *  `undefined`: the menu itself has no screen to open
 *  (`FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION`), and a frame through the first
 *  menu must not open with its shared case (`first-menu-shared-case`). */
function menuAboveIssue(
	doc: BlueprintDoc,
	target: EntryPointTarget,
): string | undefined {
	const module = doc.modules[target.moduleUuid];
	if (module === undefined) return undefined;
	if (target.kind !== "form" && moduleShowsFormsInMenuAbove(module)) {
		if (target.kind === "module")
			return `"${module.name}" shows its forms in the menu above, so it has no screen of its own for its entry point to open. You can give one of its forms an entry point, or give "${module.name}" its own screen again.`;
		const screen = menuScreenOf(doc, target.moduleUuid);
		const above =
			screen.kind === "first-menu"
				? "the app's first menu"
				: `"${doc.modules[screen.moduleUuid]?.name ?? ""}"`;
		return `"${module.name}" shows its forms in the menu above, so its case list entry point would open ${above} and never the list. You can remove that entry point, or give "${module.name}" its own screen again.`;
	}
	const shared = entryPointSharesFirstMenuCase(doc, target);
	return shared === undefined
		? undefined
		: firstMenuSharedCaseSentence(
				doc.modules[shared.aboveModuleUuid]?.name ?? "",
			);
}

export function entryPointDestination(
	doc: BlueprintDoc,
	target: EntryPointTarget,
) {
	return destinationFromRequirements(
		doc,
		target,
		entryPointRequirements(doc, target),
	);
}

function destinationFromRequirements(
	doc: BlueprintDoc,
	target: EntryPointTarget,
	projected: EntryPointRequirements,
) {
	const module = doc.modules[target.moduleUuid];
	const form = target.kind === "form" ? doc.forms[target.formUuid] : undefined;
	const label =
		target.kind === "form"
			? `${module?.name ?? "Module"} · ${form?.name ?? "Form"}`
			: `${module?.name ?? "Module"} · ${target.kind === "case-list" ? "Case list" : "Module"}`;
	const requiredSelections = projected.available
		? projected.requiredSelections
		: [];
	// The gate names a frame that opens with the first menu's chosen case
	// ahead of the destination's own unavailability
	// (`rules/app.ts::validEntryPoints`), so its sentence leads here too.
	const issue =
		menuAboveIssue(doc, target) ??
		(form &&
		afterEmptySearchRegistrationFormOf(doc, target.moduleUuid) === form.uuid
			? "This form opens only when a search has no matches."
			: projected.available
				? undefined
				: projected.message);
	return {
		target,
		label,
		entryPoint: entryPointAt(doc, target),
		issue,
		requiredSelections,
	};
}
export function entryPointDestinations(doc: BlueprintDoc) {
	const requirements = createEntryPointRequirements(doc);
	const destination = (target: EntryPointTarget) =>
		destinationFromRequirements(doc, target, requirements(target));
	return doc.moduleOrder.flatMap((moduleUuid) => [
		destination({ kind: "module", moduleUuid }),
		destination({ kind: "case-list", moduleUuid }),
		...(doc.formOrder[moduleUuid] ?? []).map((formUuid) =>
			destination({ kind: "form", moduleUuid, formUuid }),
		),
	]);
}
