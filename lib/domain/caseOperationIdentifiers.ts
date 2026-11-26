/**
 * Author-facing identifiers carried by a case operation.
 *
 * These values become XForm element names, so the portable vocabulary is
 * deliberately narrower than a general display slug. Operation and connection
 * ids may start with a letter or underscore. Connections and written properties
 * also allow hyphens, and properties must start with a letter.
 *
 * The validator, builder verdicts, and SA/MCP schemas all consume these exact
 * predicates and messages. Keep the rule here in the domain vocabulary rather
 * than restating a regex on each authoring surface.
 */

import { AUTHORED_CASE_PROPERTY_NAME_PATTERN } from "./casePropertyName";
import { suffixUntilFree } from "./idSlug";
import { isPortableName } from "./portableName";
import { questionIdProblem } from "./questionId";
import { submittedAction } from "./submittedAnswerName";
import { XML_NCNAME_PATTERN } from "./xmlName";

export const CASE_OPERATION_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const CASE_OPERATION_LINK_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** Advanced open actions also preserve periods and the Latin-1 letters
 * À–Ö, Ø–ö and ø–ÿ. Their exact case-sensitive names survive a native
 * transaction and an authenticated worker restore. */
export const ADVANCED_CASE_INDEX_IDENTIFIER_REGEX =
	/^[A-Za-z_À-ÖØ-öø-ÿ][A-Za-z0-9_.À-ÖØ-öø-ÿ-]*$/;
/** A written property's name: the catalog's grammar. */
export const CASE_OPERATION_PROPERTY_REGEX =
	AUTHORED_CASE_PROPERTY_NAME_PATTERN;

export const CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE =
	"Start with a letter or underscore; use only letters, digits, or underscores.";

export const CASE_OPERATION_LINK_IDENTIFIER_FORMAT_MESSAGE =
	"Start with a letter or underscore. Use only letters, digits, underscores, or hyphens.";

export const ADVANCED_CASE_INDEX_IDENTIFIER_FORMAT_MESSAGE =
	"Start with a Latin-1 letter or underscore. Use Latin-1 letters, digits, underscores, hyphens, or periods.";

export const CASE_OPERATION_PROPERTY_FORMAT_MESSAGE =
	"Start with a letter; use only letters, digits, underscores, or hyphens.";

export function isCaseOperationIdentifier(value: string): boolean {
	return CASE_OPERATION_IDENTIFIER_REGEX.test(value);
}

export function isCaseOperationLinkIdentifier(value: string): boolean {
	return CASE_OPERATION_LINK_IDENTIFIER_REGEX.test(value);
}

export function isAdvancedCaseIndexIdentifier(value: string): boolean {
	return (
		ADVANCED_CASE_INDEX_IDENTIFIER_REGEX.test(value) &&
		XML_NCNAME_PATTERN.test(value) &&
		isPortableName(value, ["web-apps"]) &&
		isPortableName(value, ["android"])
	);
}

export function isCaseOperationProperty(value: string): boolean {
	return CASE_OPERATION_PROPERTY_REGEX.test(value);
}

/**
 * The id the form's own case operation is born with: the case type with every
 * character the identifier grammar refuses turned into `_`, prefixed `case_`
 * where that spelling is not a question ID CommCare HQ's form builder takes
 * or is a name a worker's submission reads as an instruction (`registration`
 * on Web Apps), and suffixed `_2`, `_3`, … past the form's other operation ids.
 */
export function ownCaseOperationId(
	caseType: string,
	takenIds: ReadonlySet<string>,
): string {
	const spelled = caseType.replace(/[^A-Za-z0-9_]/g, "_");
	const base =
		questionIdProblem(spelled) === undefined &&
		submittedAction(spelled) === undefined
			? spelled
			: `case_${spelled}`;
	return suffixUntilFree(base, takenIds);
}
