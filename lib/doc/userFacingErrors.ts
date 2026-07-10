/**
 * User-facing rendering of validator findings — the BUILDER voice.
 *
 * A `ValidationError` carries TWO things at once: a stable `code` (+ a
 * `location` and structured `details`) and a verbose, person-to-person
 * `message`. That `message` is written for the AGENT and the logs — it
 * names the underlying constraint in full, because that detail is what
 * lets the SA self-correct and what a developer reading a report needs.
 *
 * That detail is the WRONG shape at the builder surface. A person who
 * just hit a wall is already a little frustrated; the copy's job is to
 * make the stop feel like a nudge from a helpful colleague, not a fault
 * report from a machine. So this module is the other rendering of the
 * same finding:
 *
 *   - Warm and conversational — what you'd actually say out loud, not a
 *     spec sentence. Contractions, plain words, no stiffness.
 *   - Pointed at the RIGHT fix. The instruction names the one move that
 *     actually clears it. A name collision is the canonical trap: "give
 *     each module a different name" wrongly implies renaming BOTH — the
 *     real fix is "rename this one, or the other one." Every "duplicate"
 *     code here frames the fix as acting on ONE thing, a choice, never a
 *     blanket "make them all unique."
 *   - Free of wire/platform vocabulary (no XML, XForm, XPath, suite,
 *     nodes, "the navigation menu", JavaRosa, raw slot keys). The user
 *     never needs to know WHY CommCare can't do a thing — only what they
 *     can do about it.
 *   - Short. The situation, then the move. No "before you can use or
 *     export it" tails — the user knows why they were stopped.
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

/** The field's semantic ID, or "a field". */
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
	// Reached in the builder only by trying to remove the app's last module, so
	// "add one" reads backwards — you'd add another BEFORE removing this one.
	NO_MODULES: () =>
		"An app needs at least one module, so you can't remove your last one. Add another first if you want to replace it.",
	EMPTY_APP_NAME: () => "Your app needs a name. Add one to get started.",
	RESERVED_CASE_TYPE_NAME: (e) => {
		const ct = det(e, "caseType", "");
		return ct
			? `${q(ct)} is a reserved word, so it can't be a case type. Try something more specific, like ${q(`${ct}_record`)}.`
			: 'That case type uses a reserved word. Try something more specific, like adding "_record".';
	},
	MISSING_CHILD_CASE_MODULE: (e) => {
		const ct = det(e, "caseType", "");
		return ct
			? `Your forms create ${q(ct)} cases, but there's no module showing them yet. Add a module for ${q(ct)}.`
			: "Some of your forms create child cases that have nowhere to show. Add a module for that case type.";
	},
	FORM_LINK_CIRCULAR: () =>
		"Your follow-on links loop in a circle, so people would get stuck going form to form. Point one of them at a module instead of another form to break the loop.",
	CONNECT_ID_DUPLICATE: (e) =>
		`The Connect ID ${q(det(e, "connectId", ""))} is already used by another form. Give this one a different ID, or change the other form's first.`,
	CONNECT_NO_PARTICIPATING_FORMS: () =>
		"You've turned Connect on for the app, but no form is using it yet. Set up Connect on at least one form, or turn it off for the app.",

	// ── Module-level ─────────────────────────────────────────────────
	NO_CASE_TYPE: (e) =>
		`${q(modName(e))} has forms that work with cases, but you haven't picked a case type for it yet. Choose the kind of case it manages, like "patient" or "household".`,
	CASE_LIST_ONLY_HAS_FORMS: (e) =>
		`${q(modName(e))} is set to show only a case list, but it still has forms attached. Remove the forms.`,
	CASE_LIST_ONLY_NO_CASE_TYPE: (e) =>
		`${q(modName(e))} is set to show a case list, but you haven't said which case type to list. Pick one.`,
	// Fires for a formless module — a plain survey menu (no case type) as well as
	// a case module. In the builder it's reached by removing a survey module's
	// last form or clearing a viewer's case type, so it must not assume a case
	// type and must read sensibly for a delete (not just "add a form").
	NO_FORMS_OR_CASE_LIST: (e) =>
		`${q(modName(e))} needs at least one form. Add a form, or, if you're removing its last one, delete the whole module instead.`,
	INVALID_CASE_TYPE_FORMAT: (e) =>
		`${q(modName(e))}'s case type ${q(det(e, "caseType", ""))} isn't a valid name. Start it with a letter and stick to letters, numbers, underscores, and hyphens.`,
	CASE_TYPE_TOO_LONG: (e) =>
		`${q(modName(e))}'s case type name is too long. Try a shorter one.`,
	MISSING_CASE_LIST_COLUMNS: (e) =>
		`${q(modName(e))}'s case list doesn't have any columns yet, so there's no way to tell cases apart. Add at least one — a name column is a good start.`,

	// ── Case-list config ─────────────────────────────────────────────
	CASE_LIST_COLUMN_UNKNOWN_FIELD: (e) =>
		`One of ${q(modName(e))}'s case list columns shows ${q(det(e, "field", "a property"))}, which isn't a property on this case type. Point it at one that exists.`,
	CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH: (e) =>
		`A ${det(e, "columnKind", "formatted")} column in ${q(modName(e))} shows ${q(det(e, "field", "a property"))}, but that property holds ${det(e, "resolvedType", "a different kind of")} values, which this column style can't format. Pick a matching property, or switch the column to a style that fits — plain text always works.`,
	CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR: (e) =>
		`A calculated column in ${q(modName(e))} has a calculation that doesn't quite add up. Open it and take a look.`,
	CASE_LIST_FILTER_TYPE_ERROR: (e) =>
		`The case list filter in ${q(modName(e))} is comparing values that don't go together. Open it and adjust the comparison.`,
	CASE_LIST_ID_MAPPING_EMPTY_VALUE: (e) =>
		`A value-mapping column in ${q(modName(e))} has a row with no value to match on. Fill it in, or remove the row.`,
	CASE_LIST_DUPLICATE_SORT_PRIORITY: (e) =>
		`Two case list columns in ${q(modName(e))} are sorting at the same priority. Change one of them, or drop the sort from one.`,
	CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE: (e) =>
		`An image column in ${q(modName(e))} has two rows with the value ${q(det(e, "value", ""))}, so only the first image shows up. Change or remove one of them.`,
	CASE_LIST_SEARCH_INPUT_SELECT_WIDGET_NOT_SUPPORTED: (e) =>
		`The search input ${q(det(e, "inputName", "in this module"))} is set to a dropdown, which isn't supported here. Switch it to a plain text input.`,
	CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR: (e) =>
		`The search input ${q(det(e, "inputName", "in this module"))} has a condition that doesn't add up. Open it and fix the condition.`,
	CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY: (e) =>
		`The search input ${q(det(e, "inputName", "in this module"))} searches ${q(det(e, "property", "a property"))}, which doesn't exist on that case type. Point it at one that does.`,
	CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH: (e) =>
		`The search input ${q(det(e, "inputName", "in this module"))} uses a search mode that doesn't fit the property it's searching. Pick a different mode, or search a property that fits.`,
	CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH: (e) =>
		`The search input ${q(det(e, "inputName", "in this module"))} uses an input type that doesn't match the property it searches — like a date picker on a text field. Change one so they line up.`,
	CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR: (e) =>
		`The search input ${q(det(e, "inputName", "in this module"))} has a default value that doesn't match its input type. Fix the default, or clear it.`,
	CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME: (e) =>
		`Two search inputs in ${q(modName(e))} share the name ${q(det(e, "inputName", ""))}. Rename one of them.`,
	CASE_LIST_BARE_SEARCH_INPUT_REF: (e) => {
		const input = q(det(e, "inputName", "the search box"));
		return det(e, "mode", "") === "forbids-input-ref"
			? `A setting in ${q(modName(e))} reads ${input}, but it runs before anyone searches — so it always comes back empty. Remove that reference.`
			: `A filter in ${q(modName(e))} checks ${input} before anyone's typed in it, so it matches empty values too. Have it apply only once ${input} has something in it.`;
	},
	CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE: (e) =>
		`The search input ${q(det(e, "inputName", "in this module"))} uses a mode the case list can't handle this way. Switch to a single-value mode like "exact", or build it as an advanced search input.`,
	CASE_LIST_MATCH_MODE_NOT_ON_DEVICE: (e) =>
		`A search in ${q(modName(e))} uses a match type that isn't available where it runs, so the case list won't load. Use "starts-with" here instead, or move it to an advanced search input.`,
	CASE_LIST_MATCH_MODE_TOKENIZES_WHITESPACE: (e) =>
		`A search in ${q(modName(e))} matches against a value with spaces in it, which splits into separate words and matches more than you'd expect. Use a single word, or "starts-with".`,
	CASE_LIST_ANCESTOR_EXISTS_NESTS_CROSS_DIRECTION_WALK: (e) =>
		`A search in ${q(modName(e))} tucks a child-case check inside a parent-case check, which it can't run. Put them side by side instead, or split them into separate inputs.`,
	FIELD_KIND_PROPERTY_TYPE_MISMATCH: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} saves to ${q(det(e, "property", "a case property"))}, but its type doesn't match how that property is set up. Change the field's type, or save it somewhere else.`,
	FIELD_KIND_WRITERS_DISAGREE: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} saves to ${q(det(e, "property", "a case property"))} in a different format than the other fields that use it. Change this one to match them, or save it somewhere else.`,

	// ── Case-search config ───────────────────────────────────────────
	CASE_SEARCH_CONFIG_REQUIRES_CASE_TYPE: (e) =>
		`${q(modName(e))} has a search set up but no case type, so there's nothing for it to look through. Pick the kind of case it should find, like "patient" or "household".`,
	CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE: (e) =>
		`The search screen for ${q(modName(e))} has nothing to search by yet. Add a search field, or a filter to narrow the list.`,
	CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR: (e) =>
		`The excluded-owners setting on ${q(modName(e))} isn't coming out as text. Check the formula, or clear it.`,
	CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT: (e) =>
		`${q(modName(e))} filters on ${q(det(e, "property", "a property"))} in both its default filter and a search input, which can come back empty. Keep just one.`,
	CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR: (e) =>
		`The condition for when ${q(modName(e))}'s search button shows has an error. Fix it, or clear it to always show the button.`,

	// ── Form-level ───────────────────────────────────────────────────
	EMPTY_FORM: (e) =>
		`${q(formName(e))} doesn't have any fields yet. Add at least one.`,
	NO_CASE_NAME_FIELD: (e) =>
		`${q(formName(e))} creates cases, but nothing's giving them a name. Add a field with the ID "case_name".`,
	CASE_NAME_FIELD_MISSING: (e) =>
		`${q(formName(e))} needs a field named "case_name" to name its cases, but there isn't one. Add it, or rename an existing field to "case_name".`,
	RESERVED_CASE_PROPERTY: (e) =>
		`${q(formName(e))} has a field that saves to ${q(det(e, "reservedName", "a reserved name"))}, which is a reserved name. Have it save somewhere else.`,
	CASE_PROPERTY_MISSING_FIELD: (e) =>
		`${q(formName(e))} still saves a value from a field that's no longer there. Remove that, or add the field back.`,
	MEDIA_CASE_PROPERTY: (e) =>
		`${q(formName(e))} is trying to save a media field to the case. Images, audio, and video can't be saved as case data, so don't have that field save to the case.`,
	CASE_PRELOAD_MISSING_FIELD: (e) =>
		`${q(formName(e))} loads a saved value into a field that isn't there. Add the field back, or remove that load.`,
	CASE_PRELOAD_RESERVED: (e) =>
		`${q(formName(e))} loads a value into a reserved property name. Use a custom property instead.`,
	DUPLICATE_CASE_PROPERTY: (e) =>
		`In ${q(formName(e))}, two fields save to ${q(det(e, "property", "the same case property"))} and would overwrite each other. Rename one of them, or point it somewhere else.`,
	CLOSE_CONDITION_WRONG_TYPE: (e) =>
		`${q(formName(e))} has a close condition but isn't a close form. Make it a close form, or drop the condition.`,
	CLOSE_FORM_NO_CASE_TYPE: (e) =>
		`${q(formName(e))} is a close form, but its module has no case type. Give the module a case type, or change the form's type.`,
	CLOSE_CONDITION_INCOMPLETE: (e) =>
		`${q(formName(e))}'s close condition needs both a field and an answer. Fill in both, or remove it to always close.`,
	CLOSE_CONDITION_FIELD_NOT_FOUND: (e) =>
		`${q(formName(e))}'s close condition points at a field that isn't in the form. Point it at one that is.`,
	INVALID_POST_SUBMIT: (e) =>
		`${q(formName(e))}'s After Submit setting isn't one of the options. Pick one.`,
	POST_SUBMIT_PARENT_MODULE_UNSUPPORTED: (e) =>
		`${q(formName(e))} is set to go to its parent module after submitting, but it doesn't have one. Pick a different spot to land.`,
	POST_SUBMIT_MODULE_CASE_LIST_ONLY: (e) =>
		`${q(formName(e))} is set to head back to its module after submitting, but that module has no form list to land on. Send people to "Previous Screen" or "App Home" instead.`,
	FORM_LINK_EMPTY: (e) =>
		`${q(formName(e))} has follow-on links turned on but none added. Add a link, or turn the setting off.`,
	FORM_LINK_NO_FALLBACK: (e) =>
		`${q(formName(e))} has conditional follow-on links but no fallback. Set where people go when none of the conditions match.`,
	FORM_LINK_TARGET_NOT_FOUND: (e) =>
		`A follow-on link in ${q(formName(e))} points to a form or module that's gone. Update it.`,
	FORM_LINK_SELF_REFERENCE: (e) =>
		`A follow-on link in ${q(formName(e))} points back to the same form. Send it somewhere else.`,
	CONNECT_ID_MISSING: (e) =>
		`The Connect ${det(e, "connectKind", "")} in ${q(formName(e))} needs an ID. Give it one — unique across the app, 50 characters or fewer.`,
	CONNECT_ID_TOO_LONG: (e) =>
		`The Connect ID ${q(det(e, "connectId", ""))} in ${q(formName(e))} is too long. Keep it to 50 characters or fewer.`,
	CONNECT_ID_INVALID_FORMAT: (e) =>
		`The Connect ID ${q(det(e, "connectId", ""))} in ${q(formName(e))} won't work. Use letters, numbers, and underscores, starting with a letter.`,
	CONNECT_MISSING_LEARN: (e) =>
		`${q(formName(e))} is set up for Connect but has no Learn Module or Assessment turned on. Turn on at least one.`,
	CONNECT_MISSING_DELIVER: (e) =>
		`${q(formName(e))} is set up for Connect but has no Deliver Unit or Task turned on. Turn on at least one.`,
	CONNECT_EMPTY_XPATH: (e) =>
		`A Connect setting on ${q(formName(e))} was left blank. Fill it in, or remove that piece.`,
	CONNECT_UNQUOTED_XPATH: (e) =>
		`A Connect setting on ${q(formName(e))} looks like text but isn't quoted. Wrap the value in single quotes.`,
	DUPLICATE_FIELD_ID: (e) =>
		`${q(formName(e))} has two fields with the same ID at the same level. Rename one of them.`,
	CASE_PROPERTY_BAD_FORMAT: (e) =>
		`${q(formName(e))} saves to ${q(det(e, "property", "a case property"))}, which isn't a valid name. Use letters, numbers, underscores, or hyphens, starting with a letter.`,
	CASE_PROPERTY_TOO_LONG: (e) =>
		`${q(formName(e))} saves to a name that's way too long. Give it a shorter one.`,
	CASE_HASHTAG_ON_CREATE_FORM: (e) =>
		`${q(formName(e))} creates a new case but reads from one that doesn't exist yet (${det(e, "hashtag", "a case reference")}). Point it at a form question instead.`,
	PRIMARY_CASE_FIELD_IN_REPEAT: (e) => {
		const f = det(e, "fieldId", "a field");
		return `In ${q(formName(e))}, ${q(f)} is inside a repeating section but saves to the form's main case — which a repeat can't do. Move it out of the repeat, or save it to a child case instead.`;
	},
	CHILD_CASE_NO_NAME_FIELD: (e) => {
		const ct = det(e, "caseType", "");
		return ct
			? `${q(formName(e))} creates ${q(ct)} cases but nothing's giving them a name. Add a field with the ID "case_name" that saves to ${q(ct)}.`
			: `${q(formName(e))} creates child cases but nothing's giving them a name. Add a field with the ID "case_name" that saves to that case type.`;
	},

	// ── Field-level ──────────────────────────────────────────────────
	SELECT_NO_OPTIONS: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is a multiple-choice field with no choices yet. Add at least one.`,
	SELECT_TOO_FEW_OPTIONS: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is a multiple-choice field with only one choice. Add another so there's something to pick between.`,
	CASE_PROPERTY_ON_UNKNOWN_TYPE: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} saves to the ${q(det(e, "caseType", "case type"))} case type, but no case type by that name exists. Add that case type, or point the field at one that does.`,
	HIDDEN_NO_VALUE: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is hidden but has no value, so it'll always stay blank. Give it a default or a calculated value.`,
	REQUIRED_ON_HIDDEN: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is hidden, so it can't be required — no one can fill it in. Turn off required, or make the field visible.`,
	CALCULATE_ON_VISIBLE_INPUT: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} has a calculated value, but only hidden fields can — on a visible field, whatever someone types gets ignored. Move it to a hidden field, or drop the calculation.`,
	UNQUOTED_STRING_LITERAL: (e) =>
		`A formula on ${q(fieldName(e))} in ${q(formName(e))} looks like plain text. If you meant the words ${q(det(e, "bareWord", ""))}, put quotes around them.`,
	VALIDATION_ON_NON_INPUT_KIND: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} can't have a validation rule — only fields people answer can. Remove it, or change the field's type.`,
	EMPTY_REPEAT_COUNT: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} repeats a set number of times, but you haven't said how many. Set the count.`,
	EMPTY_IDS_QUERY: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} repeats over a list of records, but none is chosen yet. Pick the records it should repeat over.`,
	INVALID_FIELD_ID: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} has an ID that won't work. Use letters, numbers, and underscores, starting with a letter.`,
	RESERVED_FIELD_ID_PREFIX: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} uses an ID prefix that's reserved for fields Nova creates. Pick a different ID.`,
	FIXTURE_REFERENCE_NOT_MODELED: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} pulls from a data source Nova doesn't support. For a fixed set of choices, add them as options on the field instead.`,

	// ── XPath / formula deep validation ──────────────────────────────
	XPATH_SYNTAX: (e) =>
		`A formula on ${q(fieldName(e))} in ${q(formName(e))} can't be read. Check for unbalanced parentheses or stray characters.`,
	UNKNOWN_FUNCTION: (e) =>
		`A formula on ${q(fieldName(e))} in ${q(formName(e))} uses a function that doesn't exist. Double-check the spelling.`,
	WRONG_ARITY: (e) =>
		`A formula on ${q(fieldName(e))} in ${q(formName(e))} gives a function the wrong number of inputs. Check how many it expects.`,
	INVALID_REF: (e) =>
		`A formula on ${q(fieldName(e))} in ${q(formName(e))} points to a field that isn't here. Check for a typo, or a field that was renamed or removed.`,
	INVALID_CASE_REF: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} reads a case value this form can't get to. Check the spelling, or make sure a field actually saves it.`,
	CYCLE: (e) =>
		`Some calculated fields in ${q(formName(e))} depend on each other in a loop, so none of them can be worked out. Remove one of the references to break it.`,
	TYPE_ERROR: (e) =>
		`A formula on ${q(fieldName(e))} in ${q(formName(e))} uses text where it needs a number, so the result might come out wrong. Check the values it's working with.`,

	// ── Media (export boundary) ──────────────────────────────────────
	MEDIA_ASSET_NOT_FOUND: () =>
		"An attached media file is missing — it may have been deleted. Open the slot and pick another file, or clear it.",
	MEDIA_ASSET_NOT_READY: () =>
		"An attached media file hasn't finished uploading yet. Give it a moment, or clear the slot.",
	MEDIA_KIND_MISMATCH: (e) => {
		const kind = det(e, "expectedKind", "");
		return kind
			? `An attached file is the wrong type — this slot takes ${kind}. Swap it out, or clear the slot.`
			: "An attached file is the wrong type for its slot. Swap it out, or clear the slot.";
	},
	MEDIA_EXPORT_TOO_LARGE: () =>
		"This app has more media than it can export at once. Remove or shrink some attachments and try again.",
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
