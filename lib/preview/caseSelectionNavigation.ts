import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { menuEmittedAdvanced } from "@/lib/domain/advancedEntryDatums";
import { advancedChainIndex } from "@/lib/domain/advancedModule";
import { menuWithInheritedCaseSettings } from "@/lib/domain/listedForms";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import type { ParentCaseSelection } from "./engine/caseDataBindingTypes";

/** The running Results row action, shared by the browser and app tests. */
export function caseSelectionRowAction(args: {
	readonly hasDetails: boolean;
	readonly multiple: boolean;
	readonly canContinue: boolean;
}): "detail" | "form" | "none" {
	return args.hasDetails
		? "detail"
		: args.multiple
			? "none"
			: args.canContinue
				? "form"
				: "none";
}

/**
 * What a case named in a list's address (`/cases/{caseId}`) does, by the
 * rule its row follows: on a parent's list another menu asked for, whose
 * datum names no details screen (the row goes on, `"form"`), it goes on with
 * the case as the row does, since a session holding that selection asks for
 * no confirmation (`EntityScreen.getLongDetail` over the needed datum);
 * anywhere else it opens the case's details.
 */
export function caseSelectionRouteCaseAction(args: {
	readonly rowAction: "detail" | "form" | "none";
	readonly selectsForParentRequest: boolean;
}): "detail" | "continue" {
	return args.selectsForParentRequest && args.rowAction === "form"
		? "continue"
		: "detail";
}

/**
 * The index name `moduleUuid`'s list follows from the case chosen in its
 * parent selection, where the menu is emitted advanced: the one identifier
 * the app's child links from the menu's case type to the parent's use
 * (`advancedChainIndex`), which the chained load's nodeset reads as
 * `index/<identifier>` (`suite_xml/sections/entries.py::EntriesHelper.
 * get_parent_filter_by_ref_id`). `undefined` for a menu emitted basic, whose
 * list reads every non-extension index (`get_parent_filter`), and for a menu
 * with no parent selection.
 */
export function parentCaseIndex(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): string | undefined {
	const module = menuWithInheritedCaseSettings(doc, moduleUuid);
	const parentUuid = module?.parentCaseModuleUuid;
	const childType = module?.caseType;
	const parentType =
		parentUuid === undefined
			? undefined
			: menuWithInheritedCaseSettings(doc, parentUuid)?.caseType;
	if (!childType || !parentType) return undefined;
	if (!menuEmittedAdvanced(doc, moduleUuid)) return undefined;
	const index = advancedChainIndex(doc, childType, parentType);
	// A chain no one name follows blocks the advanced kind, so an advanced
	// menu always has one.
	return index.kind === "one" ? index.identifier : undefined;
}

/**
 * The selected-parent constraint a read of `moduleUuid`'s list carries: the
 * parent menu's ordered choice, and the index name the child follows where
 * the menu is emitted advanced (`parentCaseIndex`). One answer for the
 * browser's screens and App Tests, so both list what the device lists.
 */
export function parentCaseConstraint(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	parentCase: PreviewMenuCaseSelection | undefined,
): ParentCaseSelection | undefined {
	if (parentCase === undefined) return undefined;
	const index = parentCaseIndex(doc, moduleUuid);
	const parentUuid = doc.modules[moduleUuid]?.parentCaseModuleUuid;
	const additionalCaseTypes =
		parentUuid && doc.modules[parentUuid]?.caseListConfig?.additionalCaseTypes;
	return {
		caseType: parentCase.caseType,
		...(additionalCaseTypes?.length && { additionalCaseTypes }),
		caseIds: parentCase.cases.map((choice) => choice.caseId),
		...(index !== undefined && { index }),
	};
}
