import { z } from "zod";

/**
 * Open CommCare session-user data names. The wire writes these names as XML
 * element steps, while HQ's worker-data vocabulary admits hyphens after the
 * leading letter or underscore.
 */
export const SESSION_USER_FIELD_PATTERN = /^[a-zA-Z_][-a-zA-Z0-9_]*$/;

export const externalUserPropertyNameSchema = z
	.string()
	.regex(
		SESSION_USER_FIELD_PATTERN,
		"Session-user field must start with a letter or underscore and contain only letters, digits, underscores, or hyphens.",
	);
