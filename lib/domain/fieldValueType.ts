import type { CaseType } from "./blueprint";
import { caseDataTypeForFieldKind } from "./caseTypes";
import type { Field } from "./fields";

/** Hidden values inherit an effective destination type without another authored
 * type setting. Callers supply the effective catalog, including inferred writers. */
export function fieldValueType(field: Field, caseTypes: readonly CaseType[]) {
	if (field.kind !== "hidden") return caseDataTypeForFieldKind(field.kind);
	const writer = field.caseWrite;
	return writer === undefined
		? undefined
		: caseTypes
				.find((type) => type.name === writer.caseType)
				?.properties.find((property) => property.name === writer.property)
				?.data_type;
}
