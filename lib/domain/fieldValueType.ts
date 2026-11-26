import type { CaseType } from "./blueprint";
import { caseDataTypeForFieldKind } from "./caseTypes";
import type { FieldCaseWriteView } from "./caseWriteViews";
import { isClockKeepingDate } from "./expression/datePattern";
import type { Field } from "./fields";

/**
 * The type a field's bind declares (bind rule R3): a visible question's kind;
 * for a Hidden Value whose answer a case operation saves to a property with
 * an effective type, that type; for any other Hidden Value, a date and time
 * when its calculate is the clock-keeping date
 * (`expression/datePattern.ts::isClockKeepingDate`), and otherwise undefined
 * (`xsd:string`).
 *
 * This is the destination, never the Hidden Value's inferred data type
 * (`expression/inference.ts`): a Hidden Value that writes nothing keeps its
 * `xsd:string` bind whatever its value's type, except the clock-keeping
 * date, which binds `xsd:dateTime` because Core wraps a `Date` under any
 * other bind as `DateData` and drops its clock (`Recalculate.java::wrapData`).
 * One writing a date-and-time property gets `xsd:dateTime`. Callers supply
 * the effective catalog and the field's writes
 * (`caseWriteViews.ts::fieldCaseWriteViews`); the first write whose property
 * has an effective type decides.
 */
export function fieldValueType(
	field: Field,
	caseTypes: readonly CaseType[],
	writes: readonly Pick<FieldCaseWriteView, "caseType" | "property">[],
) {
	if (field.kind !== "hidden") return caseDataTypeForFieldKind(field.kind);
	for (const write of writes) {
		const written = caseTypes
			.find((type) => type.name === write.caseType)
			?.properties.find(
				(property) => property.name === write.property,
			)?.data_type;
		if (written !== undefined) return written;
	}
	return field.calculate !== undefined && isClockKeepingDate(field.calculate)
		? ("datetime" as const)
		: undefined;
}

/**
 * Whether one write of `field`'s answer saves a date and time's moment: the
 * field's value type is a date and time and the property the write saves to
 * is not a `date`. Such a write reads the answer's moment as text
 * (`commcare/xform/datetimeCaseValue.ts`, the `nova_datetime_` sibling); a
 * date-and-time question's answer saved to a `date` property is saved as it
 * is, which CommCare keeps as its day (`ruleSets.ts::isAnswerWriteAssignable`).
 */
export function writesMoment(
	field: Field,
	caseTypes: readonly CaseType[],
	writes: readonly Pick<FieldCaseWriteView, "caseType" | "property">[],
	write: Pick<FieldCaseWriteView, "caseType" | "property">,
): boolean {
	if (fieldValueType(field, caseTypes, writes) !== "datetime") return false;
	const written = caseTypes
		.find((type) => type.name === write.caseType)
		?.properties.find(
			(property) => property.name === write.property,
		)?.data_type;
	return written !== "date";
}
