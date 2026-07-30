import { z } from "zod";

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

export const authoredCasePropertyNameSchema = z
	.string()
	.min(1, "Case property name must not be empty.")
	.max(
		MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH,
		`Case property name must be ${MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH} characters or fewer.`,
	)
	.regex(
		AUTHORED_CASE_PROPERTY_NAME_PATTERN,
		"Case property name must start with a letter and contain only letters, digits, underscores, or hyphens.",
	)
	.refine(
		(value) =>
			value !== "name" && value !== "date-opened" && value !== "external-id",
		{
			message:
				"Use Nova's canonical standard property name: case_name, date_opened, or external_id.",
		},
	);

export type AuthoredCasePropertyName = z.infer<
	typeof authoredCasePropertyNameSchema
>;
