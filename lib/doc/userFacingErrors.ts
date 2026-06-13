/**
 * User-facing rendering of validator findings — the BUILDER voice.
 *
 * A `ValidationError` carries TWO things at once: a stable `code` (+ a
 * `location` and structured `details`) and a verbose, person-to-person
 * `message`. That `message` is written for the AGENT and the logs — it
 * names the underlying constraint in full ("ids become XML element
 * names", "CommCare builds the navigation menu from module names"),
 * because the detail is what lets the SA self-correct and what a
 * developer reading a report needs.
 *
 * That detail is the WRONG shape at the builder surface. A person
 * renaming a module doesn't need to know CommCare renders a menu from the
 * name — only that this name is taken and to pick another. So this module
 * is the other rendering of the same finding: concise, present-tense,
 * naming the offending entity, free of wire/platform vocabulary (no XML,
 * XForm, XPath, suite, nodes, "the navigation menu", JavaRosa). What the
 * user can't do + what to do about it, and nothing else.
 *
 * The split, by audience:
 *   - SA / MCP tools, server logs, `describeIntroducedErrors` → the
 *     verbose `ValidationError.message` (unchanged).
 *   - The builder commit gate, the Connect mode switch, and the
 *     export/upload failure surfaces → `userFacingError` here.
 *
 * Same finding, two voices. Deepen an explanation in the validator's
 * `message`, never here.
 *
 * Exhaustiveness: every code classified shape / soundness / completeness
 * / environment (the classes a user can actually encounter — at a commit
 * or at the export boundary) MUST have an entry. `oracle` codes are
 * generator-bug tripwires `runValidation` never produces; if one somehow
 * reaches a user it's a Nova bug, and the generic fallback says so rather
 * than leaking wire detail. The exhaustiveness test
 * (`__tests__/userFacingErrors.test.ts`) pins this against
 * `VALIDITY_CLASS_BY_CODE`.
 */

import type {
	ValidationError,
	ValidationErrorCode,
} from "@/lib/commcare/validator/errors";

// ── Interpolation helpers ──────────────────────────────────────────
//
// Every helper has a fallback noun: a finding whose location/details
// don't carry a name still reads as a complete sentence ("this module")
// rather than a broken `"undefined"`. Accuracy where the name is present,
// graceful generality where it isn't.

/** Double-quote a value for inline display. */
const q = (value: string): string => `"${value}"`;

/** A non-blank string, or the fallback. */
function present(value: string | undefined, fallback: string): string {
	return value && value.trim().length > 0 ? value : fallback;
}

/** The module's display name, or "this module". */
const modName = (e: ValidationError): string =>
	present(e.location.moduleName, "this module");

/** The form's display name, or "this form". */
const formName = (e: ValidationError): string =>
	present(e.location.formName, "this form");

/** The field's semantic id, or "a field". */
const fieldName = (e: ValidationError): string =>
	present(e.location.fieldId, "a field");

/** A `details` value, or the fallback. */
const det = (e: ValidationError, key: string, fallback: string): string =>
	present(e.details?.[key], fallback);

type UserMessageBuilder = (err: ValidationError) => string;

// ── The code → builder table ───────────────────────────────────────

/**
 * One concise builder per user-reachable code. `Partial` over the full
 * code union: oracle codes intentionally have no entry and fall through
 * to the generic line. The exhaustiveness test guarantees every
 * shape/soundness/completeness/environment code IS present.
 */
const USER_MESSAGE_BY_CODE: Partial<
	Record<ValidationErrorCode, UserMessageBuilder>
> = {
	// ── App-level ────────────────────────────────────────────────────
	NO_MODULES: () =>
		"Your app has no modules yet. Add at least one before you can use or export it.",
	EMPTY_APP_NAME: () =>
		"Your app needs a name. Give it one before you can use or export it.",
	DUPLICATE_MODULE_NAME: (e) =>
		`Another module is already named ${q(modName(e))}. Give each module a different name.`,
	RESERVED_CASE_TYPE_NAME: (e) => {
		const ct = det(e, "caseType", "");
		return ct
			? `${q(ct)} is a reserved name and can't be used as a case type. Try something more specific, like ${q(`${ct}_record`)}.`
			: 'That case type uses a reserved name. Try something more specific, like adding "_record".';
	},
	MISSING_CHILD_CASE_MODULE: (e) => {
		const ct = det(e, "caseType", "");
		return ct
			? `The ${q(ct)} cases your forms create have nowhere to show. Add a module for ${q(ct)}.`
			: "Some child cases your forms create have nowhere to show. Add a module for that case type.";
	},
	FORM_LINK_CIRCULAR: () =>
		"Your form links loop back on themselves, which would leave people stuck after submitting. Point one of the links at a module instead of a form.",
	CONNECT_ID_DUPLICATE: (e) =>
		`The Connect id ${q(det(e, "connectId", ""))} is already used by another form. Give each Connect block a unique id.`,
	CONNECT_NO_PARTICIPATING_FORMS: () =>
		"This Connect app has no form taking part in Connect yet. Give at least one form a Connect block, or turn Connect off for the app.",

	// ── Module-level ─────────────────────────────────────────────────
	NO_CASE_TYPE: (e) =>
		`${q(modName(e))} has forms that work with cases but no case type set. Choose the case type it manages, like "patient" or "household".`,
	CASE_LIST_ONLY_HAS_FORMS: (e) =>
		`${q(modName(e))} is set to only show a case list, but it also has forms. Remove the forms, or turn off the list-only setting.`,
	CASE_LIST_ONLY_NO_CASE_TYPE: (e) =>
		`${q(modName(e))} is set to show a case list but has no case type to display. Choose which case type it lists.`,
	NO_FORMS_OR_CASE_LIST: (e) =>
		`${q(modName(e))} has a case type but nothing to do. Add a form, or set it to show a case list.`,
	INVALID_CASE_TYPE_FORMAT: (e) =>
		`${q(modName(e))}'s case type ${q(det(e, "caseType", ""))} isn't a valid name. Start it with a letter and use only letters, numbers, underscores, or hyphens.`,
	CASE_TYPE_TOO_LONG: (e) =>
		`${q(modName(e))}'s case type name is too long. Use a shorter name.`,
	MISSING_CASE_LIST_COLUMNS: (e) =>
		`${q(modName(e))}'s case list has no columns, so people can't tell cases apart. Add at least one column, like a name.`,

	// ── Case-list config ─────────────────────────────────────────────
	CASE_LIST_COLUMN_UNKNOWN_FIELD: (e) =>
		`A case list column in ${q(modName(e))} shows ${q(det(e, "field", "a property"))}, which isn't a property on this case type. Point it at an existing property.`,
	CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR: (e) =>
		`A calculated column in ${q(modName(e))} has a calculation that doesn't add up. Open the column and fix it.`,
	CASE_LIST_FILTER_TYPE_ERROR: (e) =>
		`The case list filter in ${q(modName(e))} has an error — the values it compares don't fit together. Open the filter and fix it.`,
	CASE_LIST_ID_MAPPING_EMPTY_VALUE: (e) =>
		`A value-mapping column in ${q(modName(e))} has a row with no value to match. Fill it in, or remove the row.`,
	CASE_LIST_DUPLICATE_SORT_PRIORITY: (e) =>
		`Two case list columns in ${q(modName(e))} sort at the same priority. Give each sorted column a different priority.`,
	CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE: (e) =>
		`An image column in ${q(modName(e))} has two rows with the value ${q(det(e, "value", ""))}, so only the first image shows. Change or remove one.`,
	CASE_LIST_SEARCH_INPUT_SELECT_WIDGET_NOT_SUPPORTED: (e) =>
		`Search input ${q(det(e, "inputName", "in this module"))} uses a dropdown, which isn't supported here. Change it to a text input.`,
	CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR: (e) =>
		`Search input ${q(det(e, "inputName", "in this module"))} has a condition that doesn't add up. Open the input and fix it.`,
	CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY: (e) =>
		`Search input ${q(det(e, "inputName", "in this module"))} searches ${q(det(e, "property", "a property"))}, which doesn't exist on that case type. Point it at an existing property.`,
	CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH: (e) =>
		`Search input ${q(det(e, "inputName", "in this module"))} uses a search mode that doesn't fit the property's type. Pick a different mode, or a property that fits.`,
	CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH: (e) =>
		`Search input ${q(det(e, "inputName", "in this module"))} uses an input type that doesn't fit the property it searches — like a date picker against text. Change one so they match.`,
	CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR: (e) =>
		`Search input ${q(det(e, "inputName", "in this module"))} has a default value that doesn't match its input type. Fix the default, or remove it.`,
	CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME: (e) =>
		`Two search inputs in ${q(modName(e))} share the name ${q(det(e, "inputName", ""))}. Rename one.`,
	CASE_LIST_BARE_SEARCH_INPUT_REF: (e) =>
		`A condition in ${q(modName(e))} uses search input ${q(det(e, "inputName", ""))} in a way that matches empty values. Only apply it when the input has a value.`,
	CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE: (e) =>
		`Search input ${q(det(e, "inputName", "in this module"))} uses a mode the case list can't support this way. Switch to a single-value mode like "exact", or build it as an advanced search input.`,
	CASE_LIST_MATCH_MODE_NOT_ON_DEVICE: (e) =>
		`A search in ${q(modName(e))} uses a match type that isn't available where it runs, so the case list won't load. Use "starts-with" here, or move it to an advanced search input.`,
	CASE_LIST_MATCH_MODE_TOKENIZES_WHITESPACE: (e) =>
		`A search condition in ${q(modName(e))} matches against a value with spaces, which splits it into separate words and matches more broadly than intended. Use a single word, or "starts-with".`,
	CASE_LIST_ANCESTOR_EXISTS_NESTS_CROSS_DIRECTION_WALK: (e) =>
		`A search condition in ${q(modName(e))} nests a child-case check inside a parent-case check, which the search can't run. Make them side by side, or separate inputs.`,
	FIELD_KIND_PROPERTY_TYPE_MISMATCH: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} saves to ${q(det(e, "property", "a case property"))}, but its type doesn't match how that property is set up. Change the field's type, or save to a different property.`,
	FIELD_KIND_WRITERS_DISAGREE: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} saves to ${q(det(e, "property", "a case property"))} in a different format than other fields that write to it. Make them all use the same type.`,

	// ── Case-search config ───────────────────────────────────────────
	CASE_SEARCH_CONFIG_REQUIRES_CASE_TYPE: (e) =>
		`${q(modName(e))} has search turned on but no case type chosen. Pick what kind of case the search returns, or turn search off.`,
	CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE: (e) =>
		`Search is on for ${q(modName(e))} but there's nothing to search by. Add a search field or a default filter, or turn search off.`,
	CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR: (e) =>
		`The excluded-owners setting on ${q(modName(e))} doesn't produce valid text. Fix the expression, or clear it.`,
	CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT: (e) =>
		`${q(modName(e))} filters on ${q(det(e, "property", "a property"))} in both its default filter and a search field, which can return nothing. Keep just one.`,
	CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR: (e) =>
		`The condition for when ${q(modName(e))}'s search button shows has an error. Fix it, or clear it to always show the button.`,

	// ── Form-level ───────────────────────────────────────────────────
	EMPTY_FORM: (e) =>
		`${q(formName(e))} has no fields yet. Add at least one before you can use it.`,
	NO_CASE_NAME_FIELD: (e) =>
		`${q(formName(e))} creates cases but nothing provides the case name. Add a field with the id "case_name".`,
	CASE_NAME_FIELD_MISSING: (e) =>
		`${q(formName(e))} expects a field to provide the case name, but it's missing. Add it, or rename an existing field to "case_name".`,
	RESERVED_CASE_PROPERTY: (e) =>
		`${q(formName(e))} saves a field to ${q(det(e, "reservedName", "a reserved name"))}, which is reserved. Rename that field's save target.`,
	CASE_PROPERTY_MISSING_FIELD: (e) =>
		`${q(formName(e))} saves a case property from a field that no longer exists. Remove the mapping, or add the field back.`,
	MEDIA_CASE_PROPERTY: (e) =>
		`${q(formName(e))} tries to save a media field to the case property ${q(det(e, "property", ""))}. Images, audio, and video can't be saved as case data — clear that field's save target.`,
	CASE_PRELOAD_MISSING_FIELD: (e) =>
		`${q(formName(e))} loads a saved value into a field that doesn't exist. Add the field, or remove the preload.`,
	CASE_PRELOAD_RESERVED: (e) =>
		`${q(formName(e))} loads a value into a reserved property name. Use a custom property instead.`,
	DUPLICATE_CASE_PROPERTY: (e) =>
		`In ${q(formName(e))}, two fields save to ${q(det(e, "property", "the same case property"))} and would overwrite each other. Give each a different save target.`,
	REGISTRATION_NO_CASE_PROPS: (e) =>
		`${q(formName(e))} creates cases but saves no information to them. Set at least one field to save to the case.`,
	CLOSE_CONDITION_WRONG_TYPE: (e) =>
		`${q(formName(e))} has a close condition but isn't a close form. Make it a close form, or remove the condition.`,
	CLOSE_FORM_NO_CASE_TYPE: (e) =>
		`${q(formName(e))} is a close form but its module has no case type. Give the module a case type, or change the form type.`,
	CLOSE_CONDITION_INCOMPLETE: (e) =>
		`${q(formName(e))}'s close condition needs both a field and an answer. Fill in both, or remove it to always close.`,
	CLOSE_CONDITION_FIELD_NOT_FOUND: (e) =>
		`${q(formName(e))}'s close condition checks a field that isn't in the form. Point it at an existing field.`,
	INVALID_POST_SUBMIT: (e) =>
		`${q(formName(e))} has an unrecognized destination for after submitting. Choose one of the available options.`,
	POST_SUBMIT_PARENT_MODULE_UNSUPPORTED: (e) =>
		`${q(formName(e))} is set to go to the parent menu after submitting, but its module has no parent. Pick a different destination.`,
	POST_SUBMIT_MODULE_CASE_LIST_ONLY: (e) =>
		`${q(formName(e))} is set to return to its module after submitting, but that module has no form list. Choose "previous" or the app home instead.`,
	FORM_LINK_EMPTY: (e) =>
		`${q(formName(e))} has an empty set of follow-on links. Add a link, or turn the setting off.`,
	FORM_LINK_NO_FALLBACK: (e) =>
		`${q(formName(e))} has conditional follow-on links but no fallback. Set where to go when none of the conditions match.`,
	FORM_LINK_TARGET_NOT_FOUND: (e) =>
		`A follow-on link in ${q(formName(e))} points to a form or module that no longer exists. Update it.`,
	FORM_LINK_SELF_REFERENCE: (e) =>
		`A follow-on link in ${q(formName(e))} points back to the same form. Point it somewhere else.`,
	CONNECT_ID_MISSING: (e) =>
		`The Connect ${det(e, "connectKind", "")} block in ${q(formName(e))} needs an id. Set one — unique across the app, 50 characters or fewer.`,
	CONNECT_ID_TOO_LONG: (e) =>
		`The Connect id ${q(det(e, "connectId", ""))} in ${q(formName(e))} is too long. Use 50 characters or fewer.`,
	CONNECT_ID_INVALID_FORMAT: (e) =>
		`The Connect id ${q(det(e, "connectId", ""))} in ${q(formName(e))} isn't valid. Use letters, numbers, and underscores, starting with a letter.`,
	CONNECT_MISSING_LEARN: (e) =>
		`${q(formName(e))} takes part in Connect but has no learn module or assessment turned on. Turn on at least one.`,
	CONNECT_MISSING_DELIVER: (e) =>
		`${q(formName(e))} takes part in Connect but has no deliver unit or task turned on. Turn on at least one.`,
	CONNECT_EMPTY_XPATH: (e) =>
		`A Connect setting on ${q(formName(e))} was left blank. Fill it in, or remove that sub-config.`,
	CONNECT_UNQUOTED_XPATH: (e) =>
		`A Connect setting on ${q(formName(e))} looks like text but isn't quoted. Put single quotes around the value.`,
	DUPLICATE_FIELD_ID: (e) =>
		`${q(formName(e))} has two fields with the same id at the same level. Rename one so each is unique.`,
	CASE_PROPERTY_BAD_FORMAT: (e) =>
		`${q(formName(e))} saves to the case property ${q(det(e, "property", ""))}, which isn't a valid name. Use letters, numbers, underscores, or hyphens, starting with a letter.`,
	CASE_PROPERTY_TOO_LONG: (e) =>
		`${q(formName(e))} has a case property name that's too long. Shorten ${q(det(e, "property", "it"))}.`,
	CASE_HASHTAG_ON_CREATE_FORM: (e) =>
		`${q(formName(e))} creates a new case but reads from a case that doesn't exist yet (${det(e, "hashtag", "a case reference")}). Reference a form question instead.`,
	PRIMARY_CASE_FIELD_IN_REPEAT: (e) => {
		const f = det(e, "fieldId", "a field");
		return `In ${q(formName(e))}, ${q(f)} sits inside a repeating section but saves to the form's main case, which a repeat can't do. Move it out of the repeat, or save it to a child case.`;
	},
	CHILD_CASE_NO_NAME_FIELD: (e) => {
		const ct = det(e, "caseType", "");
		return ct
			? `${q(formName(e))} creates ${q(ct)} child cases but nothing provides their name. Add a field with the id "case_name" that saves to ${q(ct)}.`
			: `${q(formName(e))} creates child cases but nothing provides their name. Add a field with the id "case_name" that saves to that case type.`;
	},

	// ── Field-level ──────────────────────────────────────────────────
	SELECT_NO_OPTIONS: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is a multiple-choice field with no options. Add at least one.`,
	HIDDEN_NO_VALUE: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is a hidden field with nothing to fill it in, so it stays blank. Give it a calculated value or a default.`,
	REQUIRED_ON_HIDDEN: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is hidden, so it can't be required — no one can fill it in. Turn off required, or make it visible.`,
	CALCULATE_ON_VISIBLE_INPUT: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} has a calculated value, but only hidden fields can — on a visible field, what people type is ignored. Move it to a hidden field, or remove the calculation.`,
	UNQUOTED_STRING_LITERAL: (e) =>
		`A formula on ${q(fieldName(e))} in ${q(formName(e))} looks like plain text. If you meant the words ${q(det(e, "bareWord", ""))}, put quotes around them.`,
	VALIDATION_ON_NON_INPUT_KIND: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} can't have a validation rule — only fields people answer can. Remove it, or change the field's type.`,
	EMPTY_REPEAT_COUNT: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} repeats a set number of times, but you haven't said how many. Set the count.`,
	EMPTY_IDS_QUERY: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} repeats over a list of records, but none is chosen. Choose the records it repeats over.`,
	INVALID_FIELD_ID: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} has an invalid id. Use letters, numbers, and underscores, starting with a letter.`,
	RESERVED_FIELD_ID_PREFIX: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} uses an id prefix reserved for fields Nova creates. Pick a different id.`,
	FIXTURE_REFERENCE_NOT_MODELED: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} uses a data source Nova doesn't support. For a fixed set of choices, add them as select options instead.`,

	// ── XPath / formula deep validation ──────────────────────────────
	XPATH_SYNTAX: (e) =>
		`A formula on ${q(fieldName(e))} in ${q(formName(e))} can't be read. Check for unbalanced parentheses or stray characters.`,
	UNKNOWN_FUNCTION: (e) =>
		`A formula on ${q(fieldName(e))} in ${q(formName(e))} uses a function that doesn't exist. Check the spelling.`,
	WRONG_ARITY: (e) =>
		`A formula on ${q(fieldName(e))} in ${q(formName(e))} gives a function the wrong number of inputs.`,
	INVALID_REF: (e) =>
		`A formula on ${q(fieldName(e))} in ${q(formName(e))} refers to a field that isn't here. Check for a typo or a renamed field.`,
	INVALID_CASE_REF: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} refers to a case value this form can't read. Check the spelling, or make sure a field saves it.`,
	CYCLE: (e) =>
		`Some calculated fields in ${q(formName(e))} depend on each other in a loop, so none can be worked out. Remove one of the references.`,
	TYPE_ERROR: (e) =>
		`A formula on ${q(fieldName(e))} in ${q(formName(e))} uses text where a number is expected, so the result may be wrong.`,

	// ── Media (export boundary) ──────────────────────────────────────
	MEDIA_ASSET_NOT_FOUND: () =>
		"An attached media file can't be found and may have been deleted. Open the slot and pick another file, or clear it.",
	MEDIA_ASSET_NOT_READY: () =>
		"An attached media file hasn't finished uploading. Wait for it to finish, or clear the slot.",
	MEDIA_KIND_MISMATCH: (e) => {
		const kind = det(e, "expectedKind", "");
		return kind
			? `An attached file is the wrong type — this slot takes ${kind}. Replace it, or clear the slot.`
			: "An attached file is the wrong type for its slot. Replace it, or clear the slot.";
	},
	MEDIA_EXPORT_TOO_LARGE: () =>
		"This app has too much media to export at once. Remove or shrink some attachments, then try again.",
};

/** The line shown when a finding has no builder — an `oracle` code, which
 *  `runValidation` never emits, or a code retired off a historical event
 *  log. Either way it's a Nova-side problem, not something the user
 *  authored, so the copy says so instead of leaking wire detail. */
const GENERIC_INTERNAL =
	"Something went wrong preparing your app. This is on our end — try again, and let us know if it keeps happening.";

/**
 * Render a validator finding as the concise builder-surface line. The SA
 * and logs keep `err.message`; this is the user's voice.
 */
export function userFacingError(err: ValidationError): string {
	return (USER_MESSAGE_BY_CODE[err.code] ?? (() => GENERIC_INTERNAL))(err);
}

/** Render a list of findings to their user lines, in order. */
export function userFacingErrors(errors: readonly ValidationError[]): string[] {
	return errors.map(userFacingError);
}

/** Exposed for the exhaustiveness test only. */
export const USER_MESSAGE_CODES = new Set(
	Object.keys(USER_MESSAGE_BY_CODE) as ValidationErrorCode[],
);
