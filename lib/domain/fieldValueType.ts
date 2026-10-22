import type { CaseType } from "./blueprint";
import { caseDataTypeForFieldKind } from "./caseTypes";
import type { Field } from "./fields";

/**
 * The type a field's bind declares: a visible question's kind, and for a
 * Hidden Value the effective type of the property it writes (undefined when
 * it writes none). This is the destination, never the Hidden Value's inferred
 * data type (`expression/inference.ts`): a Hidden Value that writes nothing
 * keeps its `xsd:string` bind whatever its value's type, and one writing a
 * date-and-time property gets `xsd:dateTime`. Callers supply the effective
 * catalog.
 */
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
