// lib/domain/selectOptionValue.ts
//
// The one grammar for a choice's stored VALUE: the token a single- or
// multi-select answer saves, as opposed to the label a person reads.
//
// Shared by the validator (`SELECT_OPTION_VALUE_INVALID` /
// `CASE_PROPERTY_OPTION_VALUE_INVALID`), the SA/MCP tool schemas, and the
// builder's option editor, so the three editors accept and refuse the same
// values for the same reason, and every one of them teaches the same shape
// before a value is rejected.
//
// What binds is the wire, not taste. JavaRosa's form parser flags a choice
// `<value>` holding whitespace or a quote character (`commcare-core
// .../xform/parse/XFormParser.java::parseItem`, the ` \n\t\f\r'"\`` scan);
// CommCare Android then throws on ANY select whose value contains a space
// (`commcare-android .../views/widgets/QuestionWidget.java::getSelectChoices`),
// and a multi-select answer is a space-joined list of these tokens, so a
// space inside one makes it two (`selected()` splits on spaces). A quote
// breaks the XPath literal a value is compared with (`field = 'value'`),
// which is how the case list projects a select's labels. An empty value is
// a choice that saves nothing, which no reader can tell from "unanswered".
//
// Everything else is admitted: the grammar is deliberately NOT a slug
// grammar, because stored values are data and a stricter rule would
// refuse codes that are perfectly safe on the wire (`ICD10`, `a-b`). The
// slug is the shape Nova TEACHES and mints, not the only one it accepts.

import { slugifyId } from "./idSlug";

/** The characters a stored choice value can never hold. */
const FORBIDDEN = /[\s'"`]/;

/**
 * The admitted grammar as one anchored pattern, for schemas that carry a
 * `pattern` to the model (the negation of `FORBIDDEN`, non-empty).
 */
export const SELECT_OPTION_VALUE_PATTERN = /^[^\s'"`]+$/;

/**
 * The sentence every model-facing `value` slot carries. It states the
 * shape before the model writes one, so the rejection below is a repair,
 * not the first time the rule is heard.
 */
export const SELECT_OPTION_VALUE_DESCRIPTION =
	"The stored answer token, never shown to people: a lowercase slug with words joined by underscores (prefer_not_to_say), unique within the field, and kept stable once data exists. No spaces, quotes, or apostrophes: the device refuses a choice value holding a space, and a multi-select answer is a space-separated list of these tokens. The wording belongs in the label.";

/** The rejection a schema returns when a value breaks the grammar. */
export const SELECT_OPTION_VALUE_REJECTION =
	"A choice value is the stored answer token, not the wording: it cannot hold spaces, quotes, or apostrophes, and cannot be empty. Use a lowercase slug with words joined by underscores (prefer_not_to_say) and put the wording in the label.";

export type SelectOptionValueProblem = "empty" | "whitespace" | "quote";

/** Why a value is refused, or `undefined` when it is admitted. */
export function selectOptionValueProblem(
	value: string,
): SelectOptionValueProblem | undefined {
	if (value.length === 0) return "empty";
	const hit = FORBIDDEN.exec(value);
	if (hit === null) return undefined;
	return /\s/.test(hit[0]) ? "whitespace" : "quote";
}

export function isValidSelectOptionValue(value: string): boolean {
	return selectOptionValueProblem(value) === undefined;
}

/**
 * The nearest admitted spelling of what someone typed: whitespace runs
 * become one underscore, quote characters disappear, and the edges are
 * trimmed of underscores. Case and every other character survive, so a
 * deliberate `ICD10` or `a-b` stays as typed. Returns `""` when nothing
 * survives; callers that need a non-empty value fall back themselves.
 */
export function sanitizeSelectOptionValue(raw: string): string {
	return raw
		.replace(/\s+/g, "_")
		.replace(/['"`]/g, "")
		.replace(/^_+|_+$/g, "");
}

/**
 * The value Nova mints for a choice from its label: the same slug every
 * other derived id uses (`slugifyId`), with `fallback` when the label has
 * nothing to keep.
 */
export function suggestSelectOptionValue(
	label: string,
	fallback: string,
): string {
	return slugifyId(label, fallback);
}
