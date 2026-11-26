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
import { questionIdProblem } from "./questionId";
import { submittedAction } from "./submittedAnswerName";

export const CASE_OPERATION_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const CASE_OPERATION_LINK_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** HQ's Advanced open action can also build a name with complete dot-separated parts. */
export const ADVANCED_OPEN_LINK_IDENTIFIER_REGEX =
	/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;
/** A written property's name: the catalog's grammar. */
export const CASE_OPERATION_PROPERTY_REGEX =
	AUTHORED_CASE_PROPERTY_NAME_PATTERN;

export const CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE =
	"Start with a letter or underscore; use only letters, digits, or underscores.";

export const CASE_OPERATION_LINK_IDENTIFIER_FORMAT_MESSAGE =
	"Start with a letter or underscore. Use only letters, digits, underscores, or hyphens.";

export const ADVANCED_OPEN_LINK_IDENTIFIER_FORMAT_MESSAGE =
	"Start each part with a letter or underscore. Use letters, digits, underscores, or hyphens within each part, with a single period between parts.";

export const CASE_OPERATION_PROPERTY_FORMAT_MESSAGE =
	"Start with a letter; use only letters, digits, underscores, or hyphens.";

export function isCaseOperationIdentifier(value: string): boolean {
	return CASE_OPERATION_IDENTIFIER_REGEX.test(value);
}

export function isCaseOperationLinkIdentifier(value: string): boolean {
	return CASE_OPERATION_LINK_IDENTIFIER_REGEX.test(value);
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
