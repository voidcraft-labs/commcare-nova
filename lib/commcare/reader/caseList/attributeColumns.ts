/**
 * A case's attributes a column reads as `@<name>`, and the column a reading
 * gives a calculated column that reads one alone.
 */
import type { Column } from "@/lib/domain";

/** The case attributes Nova's columns write as `@<name>`. */
export const ATTRIBUTE_PROPERTIES: ReadonlySet<string> = new Set([
	"case_id",
	"owner_id",
	"status",
]);

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
	if (column.kind !== "calculated" || column.expression.kind !== "term")
		return undefined;
	const read = column.expression.term;
	return read.kind === "prop" &&
		read.via === undefined &&
		(read.caseType === undefined || read.caseType === caseType) &&
		ATTRIBUTE_PROPERTIES.has(read.property)
		? read.property
		: undefined;
}
