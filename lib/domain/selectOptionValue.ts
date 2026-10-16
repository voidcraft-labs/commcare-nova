// lib/domain/selectOptionValue.ts
//
// The one grammar for a choice's stored VALUE: the token a single- or
// multi-select answer saves, as opposed to the label a person reads.
//
// Shared by the validator (`SELECT_OPTION_VALUE_INVALID` /
// `CASE_PROPERTY_OPTION_VALUE_INVALID`, and their `_DUPLICATE` twins for a
// value two choices of one list hold), the SA/MCP tool schemas, and the
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

import { z } from "zod";
import { suffixUntilFree } from "./idSlug";

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
	"Stored answer value: a unique lowercase identifier such as prefer_not_to_say. Keep it stable after data is collected; wording belongs in label.";

/** The rejection a schema returns when a value breaks the grammar. */
export const SELECT_OPTION_VALUE_REJECTION =
	"A choice value is the stored answer token, not the wording: it cannot hold spaces, quotes, or apostrophes, and cannot be empty. Use a lowercase slug with words joined by underscores (prefer_not_to_say) and put the wording in the label.";

/**
 * The one Zod leaf every model-facing `value` slot is: the grammar as a
 * `pattern`, the rejection as its message, and the description that
 * teaches the shape first. Schemas compose this rather than restating the
 * triple, so a slot cannot carry the rule without the teaching.
 */
export const selectOptionValueSchema = z
	.string()
	.regex(SELECT_OPTION_VALUE_PATTERN, SELECT_OPTION_VALUE_REJECTION)
	.describe(SELECT_OPTION_VALUE_DESCRIPTION);

/**
 * Why a choice's value is refused: the three grammar problems a value has
 * alone, and `duplicate`, a value an earlier choice of the same list holds.
 * HQ's form builder reports a repeated value among one question's choices
 * on exact string equality (Vellum `src/mugs/types/select.js`), and an
 * answer saved with it can't say which choice was meant.
 */
export type SelectOptionValueProblem =
	| "empty"
	| "whitespace"
	| "quote"
	| "duplicate";

/** Why a value is refused alone, or `undefined` when it is admitted. */
export function selectOptionValueProblem(
	value: string,
): Exclude<SelectOptionValueProblem, "duplicate"> | undefined {
	if (value.length === 0) return "empty";
	const hit = FORBIDDEN.exec(value);
	if (hit === null) return undefined;
	return /\s/.test(hit[0]) ? "whitespace" : "quote";
}

export function isValidSelectOptionValue(value: string): boolean {
	return selectOptionValueProblem(value) === undefined;
}

/**
 * Why a value is refused in its list, where `earlier` holds the values of
 * the choices before it: its grammar problem first, then `duplicate`. The
 * comparison is exact, as HQ's form builder and Core compare, so values
 * differing only in case are distinct.
 */
export function selectOptionValueProblemAmong(
	value: string,
	earlier: ReadonlySet<string>,
): SelectOptionValueProblem | undefined {
	return (
		selectOptionValueProblem(value) ??
		(earlier.has(value) ? "duplicate" : undefined)
	);
}

/** A later choice holding a value an earlier choice of its list holds. */
export interface DuplicateSelectOptionValue {
	/** The choice's position in its list, from 0. */
	readonly index: number;
	readonly value: string;
	/** A value no choice of the list holds and no earlier suggestion took. */
	readonly suggestion: string;
}

/**
 * Every later holder of a value in one option list. The first choice
 * holding a value keeps it; each later holder is offered
 * `suffixUntilFree(value, taken)`, where `taken` is the list's values and
 * the suggestions before it, so a third holder of `yes` is offered `yes_3`.
 * A value with a grammar problem is that problem's to report, not this.
 */
export function duplicateSelectOptionValues(
	values: readonly string[],
): DuplicateSelectOptionValue[] {
	const taken = new Set(values);
	const seen = new Set<string>();
	const duplicates: DuplicateSelectOptionValue[] = [];
	values.forEach((value, index) => {
		if (selectOptionValueProblem(value) !== undefined) return;
		if (!seen.has(value)) {
			seen.add(value);
			return;
		}
		const suggestion = suffixUntilFree(value, taken);
		taken.add(suggestion);
		duplicates.push({ index, value, suggestion });
	});
	return duplicates;
}

/**
 * The nearest admitted spelling of what someone typed: every whitespace
 * run becomes one underscore and quote characters disappear. Nothing else
 * changes, so a deliberate `ICD10` or `a-b` stays as typed, and so does an
 * underscore at either edge: this runs on every keystroke of a controlled
 * input, where trimming an edge would erase the `_` someone just typed
 * (or the space that just became one) before the next character arrives.
 * Returns `""` when nothing survives; callers that need a non-empty value
 * fall back themselves.
 */
export function sanitizeSelectOptionValue(raw: string): string {
	return raw.replace(/\s+/g, "_").replace(/['"`]/g, "");
}

/**
 * The value Nova mints for a choice from its label, and the one every
 * refusal suggests: lowercased, every run of characters that is not a
 * letter or a digit (in any script) collapsed to one underscore, edges
 * trimmed, `fallback` when nothing survives. Letters outside ASCII are
 * kept because the grammar admits them: a label of "Sí" should become
 * `sí`, not `s`, and "はい" should keep its characters rather than fall
 * back to `option_2`. With `taken` (the field's other values), the slug is
 * suffixed `_2`, `_3`, … until it names no existing choice, so a repair
 * never suggests a value a sibling already holds.
 */
export function suggestSelectOptionValue(
	label: string,
	fallback: string,
	taken: ReadonlySet<string> = new Set(),
): string {
	return suffixUntilFree(slugOf(label) || fallback, taken);
}

/**
 * The replacement a refusal names for a value already outside the grammar:
 * the value's own admitted spelling when one survives (`"Prefer not to
 * say"` keeps its words as `prefer_not_to_say`), else the label's, else
 * `fallback`; never one a sibling already holds.
 */
export function repairSelectOptionValue(
	value: string,
	label: string,
	fallback: string,
	taken: ReadonlySet<string>,
): string {
	return suffixUntilFree(
		slugOf(sanitizeSelectOptionValue(value)) || slugOf(label) || fallback,
		taken,
	);
}

// Letters, digits, and combining marks survive; everything else is a
// separator. Marks (`\p{M}`) are load-bearing: vowel signs, virama, nukta,
// and tone marks are how Devanagari, Bengali, Thai, and decomposed Latin
// spell a word, so a class of letters and digits alone turns "नमस्ते" into
// "नमस_त". NFC first, so a label typed decomposed ("Si" + U+0301) and its
// precomposed twin ("Sí") mint the same value.
function slugOf(text: string): string {
	return text
		.normalize("NFC")
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, "_")
		.replace(/^_+|_+$/g, "");
}

/**
 * The key of the value space a list of choices belongs to. Every list that
 * names one case property, the property's catalog and every select that
 * writes it, is one space, so a field and its catalog never disagree about a
 * value; a select that writes no property is a space of its own. The
 * select-option repair groups by this key.
 */
export function optionValueSpaceKey(
	owner:
		| { readonly caseType: string; readonly property: string }
		| { readonly fieldUuid: string },
): string {
	return "fieldUuid" in owner
		? `field\u0000${owner.fieldUuid}`
		: `${owner.caseType}\u0000${owner.property}`;
}
