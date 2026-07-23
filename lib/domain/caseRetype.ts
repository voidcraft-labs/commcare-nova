import type { BlueprintDoc, CaseProperty } from "./blueprint";
import { castCanFail, effectiveDataType } from "./casePropertyTypes";
import { materializableCaseTypes } from "./effectiveCaseTypes";
import { CASE_SCALAR_PROPERTY_NAMES } from "./standardCaseProperties";

export interface CaseRetypeConversion {
	readonly property: string;
	readonly fromType: ReturnType<typeof effectiveDataType>;
	readonly toType: ReturnType<typeof effectiveDataType>;
	readonly canPark: boolean;
}

export interface CaseRetypePlan {
	readonly fromType: string;
	readonly toType: string;
	readonly retained: readonly string[];
	readonly conversions: readonly CaseRetypeConversion[];
	readonly parked: readonly string[];
	readonly missingRequired: readonly string[];
	readonly reviewRequired: boolean;
	readonly safe: boolean;
	/** True only when CommCare's case_type-only wire preserves Nova's data view. */
	readonly wirePortable: boolean;
}

/**
 * Describe the complete JSON-data consequence of moving one case between
 * schemas. Scalar case-row metadata is deliberately outside this plan and
 * survives a type change unchanged. `safe` means a later Nova runtime can
 * execute the richer conversion/parking plan atomically; `wirePortable` means
 * CommCare's case_type-only update already has identical data semantics (no
 * conversion or parking). Authored operations currently require the latter.
 * `writtenProperties` contains only values the enclosing operation guarantees
 * to write; callers must not count a conditionally relevant write as satisfying
 * a requirement.
 */
export function planCaseRetype(
	doc: BlueprintDoc,
	fromType: string,
	toType: string,
	writtenProperties: ReadonlySet<string> = new Set(),
): CaseRetypePlan {
	const types = new Map(
		materializableCaseTypes(doc).map((caseType) => [caseType.name, caseType]),
	);
	const source = types.get(fromType);
	const destination = types.get(toType);
	const sourceProperties = (source?.properties ?? []).filter(
		(property) => !CASE_SCALAR_PROPERTY_NAMES.has(property.name),
	);
	const destinationProperties = (destination?.properties ?? []).filter(
		(property) => !CASE_SCALAR_PROPERTY_NAMES.has(property.name),
	);
	const destinationByName = new Map(
		destinationProperties.map((property) => [property.name, property]),
	);
	const sourceNames = new Set(
		sourceProperties.map((property) => property.name),
	);
	const retained: string[] = [];
	const conversions: CaseRetypeConversion[] = [];
	const parked: string[] = [];

	for (const property of sourceProperties) {
		const target = destinationByName.get(property.name);
		if (target === undefined) {
			parked.push(property.name);
			continue;
		}
		const fromDataType = effectiveDataType(property);
		const toDataType = effectiveDataType(target);
		if (fromDataType === toDataType) retained.push(property.name);
		else {
			conversions.push({
				property: property.name,
				fromType: fromDataType,
				toType: toDataType,
				canPark: castCanFail(fromDataType, toDataType),
			});
		}
	}

	const missingRequired = destinationProperties
		.filter(isRequiredCaseProperty)
		.map((property) => property.name)
		.filter(
			(property) =>
				!sourceNames.has(property) && !writtenProperties.has(property),
		);

	const safe =
		source !== undefined &&
		destination !== undefined &&
		missingRequired.length === 0;
	return {
		fromType,
		toType,
		retained,
		conversions,
		parked,
		missingRequired,
		reviewRequired:
			parked.length > 0 || conversions.some((conversion) => conversion.canPark),
		safe,
		wirePortable: safe && conversions.length === 0 && parked.length === 0,
	};
}

function isRequiredCaseProperty(property: CaseProperty): boolean {
	// `required` is an authored XPath, not a static boolean. S04 has no case
	// snapshot with which to prove a conditional requirement false, so any
	// non-empty requirement is conservatively treated as active. S07 may refine
	// this with the shared evaluator, but it must never weaken atomic safety by
	// guessing from expression text here.
	return property.required !== undefined && property.required.trim().length > 0;
}
