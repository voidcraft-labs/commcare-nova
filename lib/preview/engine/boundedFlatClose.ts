import { menuEmittedAdvanced } from "@/lib/domain/advancedEntryDatums";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { effectivePostSubmit } from "@/lib/domain/postSubmit";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
import type { Uuid } from "@/lib/domain/uuid";

/** The bounded opening cannot serve an expression or operation that needs
 * records beyond the selection. Keep the initial profile intentionally flat. */
export function boundedFlatCloseForm(
	doc: BlueprintDoc,
	module: Uuid,
	form: Uuid,
) {
	const menu = doc.modules[module];
	const config = menu?.caseListConfig;
	const selection = config?.selection;
	const owner = doc.forms[form];
	if (
		doc.appSettings.runsOnlyOn !== "web-apps" ||
		doc.appSettings.caseSharing ||
		doc.moduleOrder.length !== 1 ||
		doc.moduleOrder[0] !== module ||
		!menu?.caseType ||
		doc.formOrder[module]?.length !== 1 ||
		doc.formOrder[module][0] !== form ||
		menu.parentModuleUuid ||
		menu.parentCaseModuleUuid ||
		menu.displayCondition ||
		menu.badge?.kind === "calculation" ||
		menu.caseSearchConfig ||
		menu.caseListMenuItem ||
		menu.caseListRegistrationForm ||
		!config ||
		!selection ||
		config.filter ||
		config.additionalCaseTypes?.length ||
		config.searchInputs.length ||
		config.deviceLookup ||
		config.tile ||
		menuEmittedAdvanced(doc, module) ||
		owner?.type !== "close" ||
		owner.shadowOf ||
		owner.caseSelections ||
		owner.computedDatums ||
		owner.openingAssignments ||
		owner.activityKeyText ||
		owner.displayCondition ||
		owner.formLinks ||
		owner.closeCondition ||
		effectivePostSubmit(doc, form) !== "app_home"
	)
		return undefined;
	const operations = owner.caseOperations ?? [];
	const own = operations[0];
	if (
		operations.length !== 1 ||
		own?.action !== "own" ||
		own.name ||
		own.owner ||
		own.writes?.length ||
		own.links?.length ||
		(doc.fieldOrder[form] ?? []).some(
			(uuid) =>
				doc.fields[uuid]?.kind !== "hidden" ||
				expressionSlotValues(doc, { entity: "field", uuid }).some(
					({ expression }) =>
						expression.kind !== "term" || expression.term.kind !== "literal",
				),
		)
	)
		return undefined;
	return { caseType: menu.caseType, selection };
}
