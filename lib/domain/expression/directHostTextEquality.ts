import { menuEmittedAdvanced } from "../advancedEntryDatums";
import type { BlueprintDoc } from "../blueprint";
import { effectiveCaseSearchConfig } from "../modules";
import { isStandardCaseListProperty } from "../standardCaseProperties";
import type { Uuid } from "../uuid";
import type { Expression, PropertyRef } from "./types";

/** The text comparison whose left side follows the listed record's direct host. */
export function directHostTextEquality(
	expression: Expression,
): PropertyRef | undefined {
	if (
		expression.kind !== "eq" ||
		expression.left.kind !== "term" ||
		expression.right.kind !== "term"
	)
		return undefined;
	const property = expression.left.term;
	const literal = expression.right.term;
	if (
		property.kind !== "prop" ||
		property.readReached !== true ||
		property.via?.kind !== "ancestor" ||
		property.via.via.length !== 1 ||
		property.via.via[0].identifier !== "host" ||
		property.property === "name" ||
		isStandardCaseListProperty(property.property) ||
		literal.kind !== "literal" ||
		typeof literal.value !== "string" ||
		literal.value.trim() === ""
	)
		return undefined;
	return property;
}

/** The ordinary root device list that consumes the authored condition. */
export function ordinaryDeviceCaseList(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): boolean {
	const module = doc.modules[moduleUuid];
	return (
		module !== undefined &&
		module.caseType !== undefined &&
		module.parentModuleUuid === undefined &&
		module.parentCaseModuleUuid === undefined &&
		module.formsFromMenu === undefined &&
		module.formsInMenuAbove !== true &&
		module.heldKind !== "advanced" &&
		!module.caseListConfig?.additionalCaseTypes?.length &&
		module.caseListConfig?.selection?.kind !== "multiple" &&
		effectiveCaseSearchConfig(module) === undefined &&
		!menuEmittedAdvanced(doc, moduleUuid)
	);
}
