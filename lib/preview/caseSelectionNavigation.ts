import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { menuEmittedAdvanced } from "@/lib/domain/advancedEntryDatums";
import { advancedChainIndex } from "@/lib/domain/advancedModule";
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
	const module = doc.modules[moduleUuid];
	const parentUuid = module?.parentCaseModuleUuid;
	const childType = module?.caseType;
	const parentType =
		parentUuid === undefined ? undefined : doc.modules[parentUuid]?.caseType;
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
	return {
		caseType: parentCase.caseType,
		caseIds: parentCase.cases.map((choice) => choice.caseId),
		...(index !== undefined && { index }),
	};
}
