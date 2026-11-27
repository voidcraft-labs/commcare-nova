import { menuEmittedAdvanced } from "./advancedEntryDatums";
import type { BlueprintDoc } from "./blueprint";
import { BOUNDED_FLAT_CLOSE_MAXIMUM } from "./caseSelectionLimits";
import type { Expression } from "./expression/types";
import { effectivePostSubmit } from "./postSubmit";
import { expressionSlotValues } from "./referenceSlots";
import type { Uuid } from "./uuid";

/** One plain Text answer can make another answer required without reading a selected record. */
function localRequiredCondition(
	doc: BlueprintDoc,
	form: Uuid,
	field: Uuid,
	expression: Expression,
): boolean {
	if (expression.kind === "match-all") return true;
	if (expression.kind === "term")
		return expression.term.kind === "literal" && expression.term.value === true;
	if (expression.kind !== "eq") return false;
	const { left, right } = expression;
	return (
		left.kind === "term" &&
		left.term.kind === "field" &&
		left.term.uuid !== field &&
		left.term.filters === undefined &&
		left.term.role === undefined &&
		doc.fieldParent[left.term.uuid] === form &&
		doc.fields[left.term.uuid]?.kind === "text" &&
		right.kind === "term" &&
		right.term.kind === "literal" &&
		typeof right.term.value === "string"
	);
}

/** The bounded opening cannot serve an expression or operation that needs
 * records beyond the selection. Keep the initial profile intentionally flat. */
export function boundedFlatSelectionForm(
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
		doc.appSettings.captureLocation ||
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
		menu.entryPoint ||
		menu.caseListEntryPoint ||
		menu.formsFromMenu ||
		!config ||
		!selection ||
		config.filter ||
		config.additionalCaseTypes?.length ||
		config.searchInputs.length ||
		config.deviceLookup ||
		config.tile ||
		config.contextAboveForm ||
		menuEmittedAdvanced(doc, module) ||
		(owner?.type !== "close" && owner?.type !== "followup") ||
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
		own.links?.length
	)
		return undefined;
	for (const uuid of doc.fieldOrder[form] ?? []) {
		const field = doc.fields[uuid];
		const slots = expressionSlotValues(doc, { entity: "field", uuid });
		if (
			field?.kind === "hidden" &&
			slots.every(
				({ expression }) =>
					expression.kind === "term" && expression.term.kind === "literal",
			)
		)
			continue;
		if (
			owner.type !== "followup" ||
			field?.kind !== "text" ||
			slots.some(
				({ ref, expression }) =>
					ref.slot !== "required" ||
					!localRequiredCondition(doc, form, uuid, expression),
			) ||
			field.addressLookup ||
			field.androidApp ||
			field.receiveFrom ||
			field.sendTopics ||
			field.keypad
		)
			return undefined;
	}

	return { caseType: menu.caseType, selection };
}

/** Only the higher authored limit routes through the bounded worker path. */
export function authoredBoundedFlatSelection(
	doc: BlueprintDoc,
	module: Uuid,
	form: Uuid | undefined,
) {
	const profile = form && boundedFlatSelectionForm(doc, module, form);
	return profile?.selection.maximum === BOUNDED_FLAT_CLOSE_MAXIMUM
		? profile
		: undefined;
}
