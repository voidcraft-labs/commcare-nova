import type { CaseType } from "./blueprint";
import { caseDataTypeForFieldKind } from "./caseTypes";
import { isClockKeepingDate } from "./expression/datePattern";
import type { Field } from "./fields";

/**
 * The type a field's bind declares (bind rule R3): a visible question's kind;
 * for a Hidden Value writing a property with an effective type, that type;
 * for any other Hidden Value, a date and time when its calculate is the
 * clock-keeping date (`expression/datePattern.ts::isClockKeepingDate`), and
 * otherwise undefined (`xsd:string`).
 *
 * This is the destination, never the Hidden Value's inferred data type
 * (`expression/inference.ts`): a Hidden Value that writes nothing keeps its
 * `xsd:string` bind whatever its value's type, except the clock-keeping
 * date, which binds `xsd:dateTime` because Core wraps a `Date` under any
 * other bind as `DateData` and drops its clock (`Recalculate.java::wrapData`).
 * One writing a date-and-time property gets `xsd:dateTime`. Callers supply
 * the effective catalog.
 */
export function fieldValueType(field: Field, caseTypes: readonly CaseType[]) {
	if (field.kind !== "hidden") return caseDataTypeForFieldKind(field.kind);
	const writer = field.caseWrite;
	const written =
		writer === undefined
			? undefined
			: caseTypes
					.find((type) => type.name === writer.caseType)
					?.properties.find((property) => property.name === writer.property)
					?.data_type;
	if (written !== undefined) return written;
	return field.calculate !== undefined && isClockKeepingDate(field.calculate)
		? ("datetime" as const)
		: undefined;
}
