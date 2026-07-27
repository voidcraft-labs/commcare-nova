/**
 * Author-facing identifiers carried by a case operation.
 *
 * These values become XForm element names, so the portable vocabulary is
 * deliberately narrower than a general display slug: ASCII letters, digits,
 * and underscores only. Operation and connection ids may begin with an
 * underscore; case properties must begin with a letter.
 *
 * The validator, builder verdicts, and SA/MCP schemas all consume these exact
 * predicates and messages. Keep the rule here in the domain vocabulary rather
 * than restating a regex on each authoring surface.
 */

export const CASE_OPERATION_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const CASE_OPERATION_PROPERTY_REGEX = /^[A-Za-z][A-Za-z0-9_]*$/;

export const CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE =
	"Start with a letter or underscore; use only letters, digits, or underscores.";

export const CASE_OPERATION_PROPERTY_FORMAT_MESSAGE =
	"Start with a letter; use only letters, digits, or underscores.";

export function isCaseOperationIdentifier(value: string): boolean {
	return CASE_OPERATION_IDENTIFIER_REGEX.test(value);
}

export function isCaseOperationProperty(value: string): boolean {
	return CASE_OPERATION_PROPERTY_REGEX.test(value);
}
