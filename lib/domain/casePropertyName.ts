import { z } from "zod";
import { isPortableName } from "./portableName";

/**
 * The one accepted Nova vocabulary for an authored case-property name.
 *
 * The pattern is the portable CommCare property identifier grammar and the
 * length bound is the platform's case-property storage limit. The three
 * rejected spellings are pre-cutover CommCare detail aliases, not alternate
 * Nova names. Runtime code never normalizes them: frozen migration code may
 * recognize its own historical inputs, while every live authoring and storage
 * boundary accepts only the final spelling.
 */
export const AUTHORED_CASE_PROPERTY_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH = 255;

/** The first supported class for a direct Basic write on Android. HQ's
 * property validator and XML builder accept these exact Latin-1 letters.
 * The pinned Android parser must also accept every unit of the name. */
const BASIC_ANDROID_PROPERTY_PATTERN =
	/^[A-Za-z][A-Za-z0-9_À-ÖØ-öø-ÿ-]*(?![\s\S])/u;

export function isBasicAndroidCasePropertyName(name: string): boolean {
	return (
		name.length <= MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH &&
		/[^\x00-\x7f]/u.test(name) &&
		BASIC_ANDROID_PROPERTY_PATTERN.test(name) &&
		isPortableName(name, ["android"])
	);
}

export const readCasePropertyNameSchema = z
	.string()
	.min(1, "Case property name must not be empty.")
	.regex(
		AUTHORED_CASE_PROPERTY_NAME_PATTERN,
		"Case property name must start with a letter and contain only letters, digits, underscores, or hyphens.",
	)
	.refine(
		(value) =>
			value !== "name" && value !== "date-opened" && value !== "external-id",
		{
			error:
				"Use Nova's canonical standard property name: case_name, date_opened, or external_id.",
		},
	);
export const authoredCasePropertyNameSchema = readCasePropertyNameSchema.max(
	MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH,
	`Case property name must be ${MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH} characters or fewer.`,
);

export type AuthoredCasePropertyName = z.infer<
	typeof authoredCasePropertyNameSchema
>;
