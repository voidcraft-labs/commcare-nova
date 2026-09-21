import {
	type BlueprintDoc,
	casePropertyTargetKey,
	isStandardCaseListProperty,
} from "@/lib/domain";
import { declarersOf, referencingCarrierUuids } from "./referenceIndex";

/** Uses the canonical reference inventory, including operation writers. */
export function unusedCasePropertyError(
	doc: BlueprintDoc,
	caseType: string,
	property: string,
): string | undefined {
	if (isStandardCaseListProperty(property))
		return `${caseType}.${property} is built-in record metadata and cannot be removed.`;
	if (
		declarersOf(doc, caseType, property).length > 0 ||
		referencingCarrierUuids(doc, casePropertyTargetKey(caseType, property))
			.length > 0
	) {
		return `${caseType}.${property} is still used by the app. Remove its reads and writes before removing its definition.`;
	}
	return undefined;
}
