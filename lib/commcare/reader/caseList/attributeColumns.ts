/**
 * The case attribute a column reads as `@<name>`, and the column a reading
 * gives a calculated column that reads it alone.
 */
import { type Column, EXPRESSION_ONLY_COLUMN_PROPERTIES } from "@/lib/domain";

/**
 * The case attributes Nova's property columns write as `@<name>`: the case's
 * id alone (`EXPRESSION_ONLY_COLUMN_PROPERTIES`). A column over `status` or
 * `owner_id` is the property field HQ's Case List page stores, so a stored
 * `@status` or `@owner_id` is a calculated column Nova prints as it stands.
 */
export const ATTRIBUTE_PROPERTIES: ReadonlySet<string> =
	EXPRESSION_ONLY_COLUMN_PROPERTIES;

/**
 * The attribute a calculated column of a menu of `caseType` reads alone, or
 * undefined: Nova writes such a column as the expression `@<name>` with the
 * `plain` format, which is the plain column over that attribute, so a reading
 * gives it as that plain column (`columns.ts::readDetailColumn`).
 */
export function calculatedAttributeField(
	column: Column,
	caseType: string | undefined,
): string | undefined {
	if (
		column.kind !== "calculated" ||
		column.showAs !== undefined ||
		column.texts !== undefined ||
		column.expression.kind !== "term"
	)
		return undefined;
	const read = column.expression.term;
	return read.kind === "prop" &&
		read.via === undefined &&
		(read.caseType === undefined || read.caseType === caseType) &&
		ATTRIBUTE_PROPERTIES.has(read.property)
		? read.property
		: undefined;
}
