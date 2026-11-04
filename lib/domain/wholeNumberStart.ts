/**
 * A whole-number question can't open on a decimal number.
 *
 * A question's starting value is a setvalue, which casts the text the value
 * gives through the question's own answer class
 * (`SetValueAction.java::processAction`), and an integer question's class
 * reads it with `Integer.parseInt` (`IntegerData.java::cast`), which throws
 * on `2.5` and stops the form as it opens. A property whose agreed type is
 * `decimal` can hold such a value whichever writer saved it, since an
 * integer writer and a decimal one agree on `decimal`
 * (`expression/ruleSets.ts::agreedStorageType`).
 */

import type { PersistableDoc } from "./blueprint";
import { inferExpressionTypes } from "./expression/inference";
import type { Field } from "./fields";

/** Whether starting `field` on the case's value of `(caseType, property)`
 *  would open a whole-number question on a decimal number. */
export function wholeNumberStartsOnDecimal(
	doc: PersistableDoc,
	field: Field,
	caseType: string,
	property: string,
): boolean {
	return (
		field.kind === "int" &&
		inferExpressionTypes(doc).propertyTypes.get(caseType)?.get(property)
			?.type === "decimal"
	);
}
