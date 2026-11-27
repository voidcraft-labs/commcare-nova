import type { BlueprintDoc } from "./blueprint";
import { castCanFail, effectiveDataType } from "./casePropertyTypes";
import { caseWriteValueField } from "./caseWriteViews";
import { materializableCaseTypes } from "./effectiveCaseTypes";
import type { CaseOperation } from "./forms";
import { CASE_SCALAR_PROPERTY_NAMES } from "./standardCaseProperties";
import type { Uuid } from "./uuid";

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
	readonly datesKeptAsText: readonly string[];
	readonly conversions: readonly CaseRetypeConversion[];
	readonly parked: readonly string[];
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
 * conversion or parking). A required date overwrite is checked separately
 * at the operation, where the new write and its producer are known.
 */
export function planCaseRetype(
	doc: BlueprintDoc,
	fromType: string,
	toType: string,
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
	const retained: string[] = [];
	const datesKeptAsText: string[] = [];
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
		// Dates are already stored as ISO strings. A text property keeps the
		// same value when CommCare changes only the case type.
		if (fromDataType === toDataType) retained.push(property.name);
		else if (fromDataType === "date" && toDataType === "text") {
			retained.push(property.name);
			datesKeptAsText.push(property.name);
		} else {
			conversions.push({
				property: property.name,
				fromType: fromDataType,
				toType: toDataType,
				canPark: castCanFail(fromDataType, toDataType),
			});
		}
	}

	const safe = source !== undefined && destination !== undefined;
	return {
		fromType,
		toType,
		retained,
		datesKeptAsText,
		conversions,
		parked,
		reviewRequired:
			parked.length > 0 || conversions.some((conversion) => conversion.canPark),
		safe,
		wirePortable: safe && conversions.length === 0 && parked.length === 0,
	};
}

/** The sole incompatible property that an unconditional write replaces on
 * this form's fresh, unkeyed case created without links. The root questions
 * write that text and date directly. The native update writes the date
 * and the type together. An optional date would send an explicit empty
 * property that Nova's typed storage cannot preserve. */
export function requiredDateRetypeOverwrite(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operation: CaseOperation,
	producer: CaseOperation | undefined,
	plan?: CaseRetypePlan,
): string | undefined {
	if (
		operation.action !== "update" ||
		operation.retype === undefined ||
		operation.target.kind !== "op" ||
		operation.condition !== undefined ||
		operation.forEach !== undefined ||
		operation.writes?.length !== 1 ||
		operation.rename !== undefined ||
		operation.owner !== undefined ||
		operation.closeAfter === true ||
		operation.links?.length ||
		doc.forms[formUuid]?.type !== "survey" ||
		producer?.action !== "create" ||
		producer.uuid !== operation.target.opUuid ||
		producer.caseType !== operation.caseType ||
		producer.target.kind !== "new" ||
		producer.target.idFrom !== undefined ||
		producer.condition !== undefined ||
		producer.forEach !== undefined ||
		producer.links?.length ||
		producer.writes?.length !== 1
	)
		return undefined;
	const retype =
		plan ?? planCaseRetype(doc, operation.caseType, operation.retype);
	const [conversion] = retype.conversions;
	if (
		!retype.safe ||
		retype.parked.length !== 0 ||
		retype.conversions.length !== 1 ||
		conversion.fromType !== "text" ||
		conversion.toType !== "date"
	)
		return undefined;

	const [source] = producer.writes;
	const [destination] = operation.writes;
	if (
		source.property !== conversion.property ||
		destination.property !== conversion.property ||
		source.via !== undefined ||
		destination.via !== undefined ||
		source.condition !== undefined ||
		destination.condition !== undefined ||
		source.onlyIfChanged === true ||
		destination.onlyIfChanged === true
	)
		return undefined;
	const sourceField = caseWriteValueField(source.value);
	const dateField = caseWriteValueField(destination.value);
	const date = dateField && doc.fields[dateField.field];
	if (
		sourceField === undefined ||
		sourceField.link ||
		doc.fields[sourceField.field]?.kind !== "text" ||
		!doc.fieldOrder[formUuid]?.includes(sourceField.field) ||
		dateField === undefined ||
		dateField.link ||
		date?.kind !== "date" ||
		date.required?.kind !== "match-all" ||
		date.relevant !== undefined ||
		!doc.fieldOrder[formUuid]?.includes(dateField.field)
	)
		return undefined;
	return conversion.property;
}
