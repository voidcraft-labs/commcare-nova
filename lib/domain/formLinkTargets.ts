// lib/domain/formLinkTargets.ts
//
// What an after-submit link's target is, read the one way every reader
// reads it: `this-form` resolved to the source form in its own menu, the
// target named for a person, and which menus CommCare HQ's form settings
// page offers as a link target. Link cycles are admitted, so nothing here
// walks a graph.

import type { BlueprintDoc } from "./blueprint";
import type { FormLinkTarget } from "./forms";
import { moduleShowsFormsInMenuAbove } from "./modules";
import { moduleUuidOfForm } from "./postSubmit";
import type { Uuid } from "./uuid";

/** A link target with `this-form` resolved: a form in a menu, or a menu. */
export type ResolvedFormLinkTarget =
	| {
			readonly type: "form";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
	  }
	| { readonly type: "module"; readonly moduleUuid: Uuid };

/** A link target as the frame algorithm reads it: `this-form` is the source
 *  form in its own menu. `undefined` when the source form is in no menu. */
export function resolveFormLinkTarget(
	doc: Pick<BlueprintDoc, "formOrder">,
	sourceFormUuid: Uuid,
	target: FormLinkTarget,
): ResolvedFormLinkTarget | undefined {
	switch (target.type) {
		case "form":
			return {
				type: "form",
				moduleUuid: target.moduleUuid,
				formUuid: target.formUuid,
			};
		case "module":
			return { type: "module", moduleUuid: target.moduleUuid };
		case "this-form": {
			const moduleUuid = moduleUuidOfForm(doc, sourceFormUuid);
			return moduleUuid === undefined
				? undefined
				: { type: "form", moduleUuid, formUuid: sourceFormUuid };
		}
	}
}

/** Where a link goes, named for a person. `undefined` when the target no
 *  longer exists; the caller names the link by position then. */
export function formLinkDestination(
	doc: BlueprintDoc,
	sourceFormUuid: Uuid,
	target: FormLinkTarget,
):
	| { readonly kind: "form" | "module" | "this-form"; readonly name: string }
	| undefined {
	switch (target.type) {
		case "form": {
			const form = doc.forms[target.formUuid];
			return form === undefined ? undefined : { kind: "form", name: form.name };
		}
		case "module": {
			const mod = doc.modules[target.moduleUuid];
			return mod === undefined ? undefined : { kind: "module", name: mod.name };
		}
		case "this-form": {
			const form = doc.forms[sourceFormUuid];
			return form === undefined
				? undefined
				: { kind: "this-form", name: form.name };
		}
	}
}

/** The parent of a menu that has one HQ would read as its `root_module`. */
function parentOf(
	doc: Pick<BlueprintDoc, "modules">,
	moduleUuid: Uuid,
): Uuid | undefined {
	const parentUuid = doc.modules[moduleUuid]?.parentModuleUuid;
	return parentUuid !== undefined && doc.modules[parentUuid] !== undefined
		? parentUuid
		: undefined;
}

/** Whether HQ's form settings page lists `targetModuleUuid` as a link target
 *  for a form of `sourceModuleUuid`
 *  (`views/forms.py::_get_linkable_forms_context`): a root menu always; a
 *  submenu only from a submenu whose parent's case type equals the target's
 *  parent's (`caseType ?? ""` on both sides, as HQ compares `case_type`). A
 *  menu that shows its forms in the menu above is never offered (HQ's
 *  `put_in_root` exclusion): it has no screen to open. */
export function menuTargetOffered(
	doc: Pick<BlueprintDoc, "modules">,
	sourceModuleUuid: Uuid,
	targetModuleUuid: Uuid,
): boolean {
	const target = doc.modules[targetModuleUuid];
	if (target === undefined || moduleShowsFormsInMenuAbove(target)) return false;
	const targetParent = parentOf(doc, targetModuleUuid);
	if (targetParent === undefined) return true;
	const sourceParent = parentOf(doc, sourceModuleUuid);
	if (sourceParent === undefined) return false;
	return (
		(doc.modules[sourceParent]?.caseType ?? "") ===
		(doc.modules[targetParent]?.caseType ?? "")
	);
}

/** The target when offered; else its parent, a root and so offered while it
 *  has its own screen and is on the menu. A parent off the menu
 *  (`hiddenFromMenu`, `HIDDEN_MENU_NOT_A_DESTINATION`) or one that shows its
 *  forms in the menu above (`FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION`) takes no
 *  link: then `undefined`. Nova's menus nest one tier (`moduleHierarchy.ts`),
 *  so one step up always reaches a root. */
export function nearestOfferedMenu(
	doc: Pick<BlueprintDoc, "modules">,
	sourceModuleUuid: Uuid,
	targetModuleUuid: Uuid,
): Uuid | undefined {
	if (doc.modules[targetModuleUuid] === undefined) return undefined;
	if (menuTargetOffered(doc, sourceModuleUuid, targetModuleUuid))
		return targetModuleUuid;
	const parentUuid = parentOf(doc, targetModuleUuid);
	if (parentUuid === undefined) return undefined;
	const parent = doc.modules[parentUuid];
	return parent?.hiddenFromMenu === true || moduleShowsFormsInMenuAbove(parent)
		? undefined
		: parentUuid;
}
