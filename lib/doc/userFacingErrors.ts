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
 *   - SA / MCP tools, server logs, `describeCommitFindings` → the
 *     verbose `ValidationError.message` (unchanged).
 *   - The builder commit gate, the Connect mode switch, and the
 *     export/upload failure surfaces → `userFacingError` here.
 *   - A picker or menu withholding a CHOICE → `offeredChoiceRefusal`,
 *     the same voice narrowed to the one line an item has room for.
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

import { MAX_FORM_ATTACHMENTS } from "@/lib/commcare/constants";
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
	CONNECT_MODE_MISMATCH: (e) =>
		`${q(formName(e))}'s Connect setup doesn't match the app's Connect mode. Configure the app's complete Connect setup together.`,
	BLUEPRINT_ENTITY_UUID_DUPLICATE: () =>
		"Two parts of this app share the same internal identity. Retry the change so Nova can keep them distinct.",
	BLUEPRINT_TOPOLOGY_INVALID: () =>
		"Part of this app is no longer attached where it belongs. Reload the app and try the change again.",
	MUTATION_IDENTITY_COLLISION: () =>
		"That change tried to reuse one part of the app as another. Retry the change so Nova can keep them distinct.",
	MUTATION_SEQUENCE_ANCHOR_INVALID: () =>
		"That change was placed next to something that has moved or disappeared. Reload the app and try again.",
	MUTATION_TARGET_INVALID: () =>
		"That change refers to something that has moved, changed type, or disappeared. Reload the app and try again.",
	MUTATION_CASE_PROPERTY_RENAME_INVALID: () =>
		"That field-name change conflicts with another case-property change in the same save. Reload the app and make one unambiguous change.",
	MUTATION_WIRE_CANONICALITY_INVALID: () =>
		"That change was not represented exactly enough to save safely. Retry it so Nova can preserve every value as authored.",
	CASE_PROPERTY_REFERENCE_INVALID: (e) =>
		`${q(det(e, "caseType", "A case type"))}.${det(e, "property", "property")}'s ${det(e, "slot", "default")} setting contains a reference that isn't available there. Replace it with case, worker, or fixed information that exists in every form using this property.`,
	TRANSLATION_UNIT_UNKNOWN: () =>
		"A translation is attached to content that no longer exists. Open Languages and remove that orphaned translation.",
	TRANSLATION_VALUE_KIND_MISMATCH: () =>
		"A translation no longer matches the kind of content it belongs to. Open Languages and enter that translation again.",
	TRANSLATION_REQUIRED_CONTENT_BLANK: () =>
		"One translated name or heading is blank. Open Languages and add the text workers should see.",
	TRANSLATION_PROTECTED_CONTENT_CHANGED: () =>
		"A translation changed one of the linked values inside its text. Open Languages, restore each protected value, and translate only the surrounding words.",
	APP_STRING_VALUE_UNREPRESENTABLE: () =>
		"One app string contains spacing Nova can't preserve on a device. Open Languages and remove typed \\n text, carriage returns, or spaces at the beginning or end.",

	// ── Worker information, roles, personas ──────────────────────────
	// The rule's own message already carries the specific reason (an illegal
	// character, a reserved word, a length cap), so these repeat the shape
	// rather than the detail and let the validator's sentence say the rest.
	USER_PROPERTY_SLUG_INVALID: (e) => {
		const slug = det(e, "slug", "");
		return slug
			? `CommCare won't accept ${q(slug)} as the name a piece of worker information is saved under. Pick a different one. Letters, numbers, and underscores work.`
			: "CommCare won't accept the name one piece of worker information is saved under. Pick a different one.";
	},
	USER_PROPERTY_SLUG_DUPLICATE: (e) => {
		const slug = det(e, "slug", "");
		return slug
			? `Two pieces of worker information both save under ${q(slug)}. CommCare treats names as the same whatever their capitalization, so give one of them a different name.`
			: "Two pieces of worker information save under the same name. Give one of them a different name.";
	},
	USER_PROPERTY_CHOICES_DUPLICATE: (e) => {
		const slug = det(e, "slug", "");
		return slug
			? `Worker information saved as ${q(slug)} lists the same accepted option more than once. Remove the repeated option so every accepted value appears once.`
			: "One piece of worker information lists the same accepted option more than once. Remove the repeated option so every accepted value appears once.";
	},
	USER_TYPE_NAME_DUPLICATE: (e) => {
		const name = det(e, "name", "");
		return name
			? `Two roles are both called ${q(name)}. Give each one a name of its own, so you can tell them apart when assigning one to a persona.`
			: "Two roles share a name. Give each one a name of its own.";
	},
	PERSONA_NAME_DUPLICATE: (e) => {
		const name = det(e, "name", "");
		return name
			? `Two personas are both called ${q(name)}. Give each one a name of its own, so you can tell which you're previewing as.`
			: "Two personas share a name. Give each one a name of its own.";
	},
	PERSONA_USER_TYPE_UNKNOWN: () =>
		"A persona is assigned to a role that no longer exists. Pick a role for them, or leave their role empty.",
	USER_DATA_UNKNOWN_PROPERTY: () =>
		"A role or persona carries a value for a piece of worker information that no longer exists. Remove the value, or add that information back.",
	USER_DATA_INVALID_CHOICE: () =>
		"A role or persona has a value that isn't one of the accepted options. Pick one from the list, or add it to the list first.",
	USER_PROPERTY_REFERENCE_UNKNOWN: () =>
		"A condition or calculation uses worker information that no longer exists. Choose current worker information or add it back first.",
	ORGANIZATION_LEVEL_CODE_DUPLICATE: () =>
		"Two organization levels use the same code. Give each level its own stable code.",
	ORGANIZATION_LEVEL_NAME_DUPLICATE: () =>
		"Two organization levels have the same name. Give each level a name of its own.",
	ORGANIZATION_LEVEL_PARENT_UNKNOWN: () =>
		"An organization level sits under a level that no longer exists. Choose a current parent or make it a top level.",
	ORGANIZATION_LEVEL_CYCLE: () =>
		"The organization levels loop back on themselves. Change a parent so every path reaches a top level.",
	ORGANIZATION_LEVEL_REFERENCE_UNKNOWN: () =>
		"An organization setting names a level that no longer exists. Choose a current level.",
	ORGANIZATION_LEVEL_CAP_NOT_BELOW: () =>
		"A depth limit points sideways or upward. Choose the same level or one below it.",
	ORGANIZATION_LEVEL_SCOPE_GAP: () =>
		"A limited address-book branch must include the worker's own level and every level down to its deepest choice.",
	ORGANIZATION_LEVEL_SCOPE_NOT_ANCESTOR: () =>
		"A shared address-book branch must start from a level above the workers. Choose one of its ancestors.",
	ORGANIZATION_REVERSE_OWNER_DESTINATION_LIMIT: () =>
		"One new source place would need too many automatic destination places beneath it. Reuse destination levels or use fixed place owners to keep that branch within the limit.",
	LOCATION_PROPERTY_SLUG_INVALID: () =>
		"CommCare won't accept the saved name for this place information. Use a letter or underscore first, then letters, numbers, underscores, or hyphens.",
	LOCATION_PROPERTY_SLUG_DUPLICATE: () =>
		"Two pieces of place information save under the same name. Give one of them a different name.",
	LOCATION_PROPERTY_LEVEL_UNKNOWN: () =>
		"Place information applies to a level that no longer exists. Choose current levels or let it apply everywhere.",
	LOCATION_PROPERTY_REQUIRED_CAPACITY: () =>
		"A place would require more information than Nova can store. Make some place information optional or narrow which levels it applies to.",
	PERSONA_LOCATION_PRIMARY_REPEATED: () =>
		"A persona has the same place more than once. Keep one main place and list each additional place once.",
	LOCATION_OWNER_EXPORT_NOT_ACTIVE: (e) =>
		`${q(formName(e))} assigns new cases with a place-based owner, but Nova does not yet ship the matching device location data and CommCare identity mapping. Use a non-location owner, or remove this owner rule before publishing.`,
	AUTOMATION_INVALID: () =>
		"This automation no longer fits the app. Open it and replace any case, form, place, or worker information that has changed.",

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
		`${q(modName(e))} needs at least one result field so people can tell cases apart. Add a name or another identifying field; if you're replacing the last one, add its replacement first.`,
	MODULE_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE: (e) =>
		`${q(modName(e))} is shown before a case is chosen, so its display condition can't use case information. Use current-user information or a fixed value.`,
	MODULE_DISPLAY_CONDITION_TYPE_ERROR: (e) =>
		`The display condition for ${q(modName(e))} compares values that don't go together. Open it and adjust the comparison.`,
	FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE: (e) =>
		`The display condition for ${q(formName(e))} uses case information that isn't available there. Use information from the selected case only when this module chooses a case first, or use current-user information.`,
	FORM_DISPLAY_CONDITION_TYPE_ERROR: (e) =>
		`The display condition for ${q(formName(e))} compares values that don't go together. Open it and adjust the comparison.`,
	DISPLAY_CONDITION_SEARCH_INPUT_UNAVAILABLE: () =>
		"A display condition reads a search answer before anyone has searched. Remove that reference and use current-user information or a fixed value.",
	DISPLAY_CONDITION_NOT_ON_DEVICE: (e) => {
		const subject = e.scope === "module" ? q(modName(e)) : q(formName(e));
		if (e.details?.reason === "datetime-base") {
			return `The display condition for ${subject} starts a calculation from a date and time, but the time would be lost here. Use a whole date or choose another calculation.`;
		}
		if (e.details?.reason === "calendar-interval") {
			return `The display condition for ${subject} uses a month or year calculation that isn't available here. Use seconds, minutes, hours, days, or weeks.`;
		}
		return `The display condition for ${subject} uses an option that can't run in the app. Open it and choose a simpler comparison or calculation.`;
	},
	DISPLAY_CONDITION_ALWAYS_FALSE: (e) => {
		const subject = e.scope === "module" ? q(modName(e)) : q(formName(e));
		return `The display condition for ${subject} can never be true, so no one could open it. Change or remove the condition.`;
	},

	// ── Case-list config ─────────────────────────────────────────────
	CASE_LIST_COLUMN_UNKNOWN_FIELD: (e) =>
		`One item in ${q(modName(e))} shows ${q(det(e, "field", "case information"))}, but that information isn't saved on this case type. Choose information that exists.`,
	CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH: (e) =>
		`An item in ${q(modName(e))} shows ${q(det(e, "field", "case information"))}, but its display style can't format ${det(e, "resolvedType", "this kind of")} information. Choose matching information or change the display style. Plain text always works.`,
	CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR: (e) =>
		`A calculated value in ${q(modName(e))} has a calculation that doesn't quite add up. Open it and fix the calculation.`,
	CASE_LIST_FILTER_TYPE_ERROR: (e) =>
		`The Cases available setting in ${q(modName(e))} compares values that don't go together. Open the condition and adjust the comparison.`,
	CASE_LIST_ID_MAPPING_EMPTY_VALUE: (e) =>
		`A value label in ${q(modName(e))} has no saved value to match. Enter a value or remove the row.`,
	CASE_LIST_DUPLICATE_SORT_PRIORITY: (e) =>
		`Two items in ${q(modName(e))}'s Default order use the same position. Move one of them or remove it from the order.`,
	CASE_LIST_TILE_CELL_OUT_OF_GRID: (e) =>
		`An item on ${q(modName(e))}'s tile runs off the edge of the layout. Move it back inside, or make it narrower or shorter.`,
	CASE_LIST_TILE_CELLS_OVERLAP: (e) =>
		`Two items on ${q(modName(e))}'s tile sit on top of each other. Move or resize one of them so they don't share the same space.`,
	CASE_LIST_TILE_COLUMN_NOT_PLACED: (e) =>
		`An item shown in ${q(modName(e))} has no place on the tile yet. Put it on the layout, or hide it from the case list.`,
	CASE_LIST_TILE_GROUP_HEADER_ROWS_OUT_OF_RANGE: (e) =>
		`${q(modName(e))} gives its group header every row of the tile, so nothing is left to show for each case. Give the header fewer rows, or make the tile taller.`,
	CASE_LIST_TILE_GROUP_CELL_STRADDLES_HEADER: (e) =>
		`An item on ${q(modName(e))}'s tile crosses the group header boundary. Move or resize it so it sits fully inside the header or fully below it.`,
	CASE_LIST_TILE_GROUP_HEADER_EMPTY: (e) =>
		`Nothing sits in ${q(modName(e))}'s group header, so every group would open with an empty band. Move a field the group shares into the header, or give the header fewer rows.`,
	CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE: (e) =>
		`An image display in ${q(modName(e))} uses ${q(det(e, "value", "the same value"))} twice, so only the first image appears. Change or remove one of the rules.`,
	CASE_LIST_SEARCH_INPUT_SELECT_WIDGET_NOT_SUPPORTED: (e) =>
		`The search field ${q(det(e, "inputName", "in this module"))} uses a dropdown that isn't available here. Change its field type to Text.`,
	CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR: (e) =>
		`The search field ${q(det(e, "inputName", "in this module"))} has a condition that compares values that don't go together. Open it and adjust the comparison.`,
	CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY: (e) =>
		`The search field ${q(det(e, "inputName", "in this module"))} looks for ${q(det(e, "property", "case information"))}, but that information isn't saved on this case type. Choose information that exists.`,
	CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH: (e) =>
		`The search field ${q(det(e, "inputName", "in this module"))} uses a matching option that doesn't fit the information it searches. Choose another matching option or different information.`,
	CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH: (e) =>
		`The search field ${q(det(e, "inputName", "in this module"))} doesn't match the information it searches. For example, a date picker can't search text. Change the field type or choose different information.`,
	CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR: (e) =>
		det(e, "reason", "") === "date-range-default-unsupported"
			? `The search field ${q(det(e, "inputName", "in this module"))} has an old one-date starting value, but a date range needs both dates. Remove the starting value.`
			: `The starting value for search field ${q(det(e, "inputName", "in this module"))} doesn't match its field type. Change the starting value or clear it.`,
	CASE_LIST_SEARCH_INPUT_DEFAULT_CASE_DATA_UNAVAILABLE: (e) =>
		`The starting value for search field ${q(det(e, "inputName", "in this module"))} tries to read a case before one has been selected, so it always comes back empty. Use a fixed value, today's date, or current-user information, or clear it.`,
	CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME: (e) =>
		`Two search fields in ${q(modName(e))} use the same name for conditions, ${q(det(e, "inputName", ""))}. Rename one under More settings.`,
	CASE_LIST_BARE_SEARCH_INPUT_REF: (e) => {
		const input = q(det(e, "inputName", "the search box"));
		return det(e, "mode", "") === "forbids-input-ref"
			? `A setting in ${q(modName(e))} reads ${input} before anyone searches, so it always comes back empty. Remove that reference.`
			: `The Cases available setting in ${q(modName(e))} checks ${input} before anyone's typed in it, so it also matches empty values. Have the condition apply only after ${input} has an answer.`;
	},
	CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE: (e) => {
		const input = q(det(e, "inputName", "in this module"));
		switch (det(e, "reason", "")) {
			case "range-needs-date-range-widget":
				return `The search field ${input} uses “Between dates” with a one-date field. Change its field type to Date range.`;
			case "date-range-needs-range-mode":
				return `The search field ${input} collects a date range but uses a one-value match. Change it to “Between dates” or choose a one-date field.`;
			default:
				return `The search field ${input} uses a matching option that doesn't work with this setup. Choose “Exact value,” or use a custom condition.`;
		}
	},
	CASE_LIST_MATCH_MODE_NOT_ON_DEVICE: (e) => {
		const inputLabel = e.details?.inputLabel || e.details?.inputName;
		const subject = (() => {
			switch (e.details?.surface) {
				case "search-button":
					return `The Search button condition in ${q(modName(e))}`;
				case "advanced-input":
					return `The condition for search field ${q(inputLabel || "this field")}`;
				case "search-input-default":
					return `The default for search field ${q(inputLabel || "this field")}`;
				case "calculated-column":
					return `The calculation for field ${q(det(e, "columnLabel", "this field"))}`;
				case "excluded-owner-ids":
					return `${q(modName(e))}'s assigned cases setting`;
				default:
					return `${q(modName(e))}'s Cases available rule`;
			}
		})();
		const repair =
			e.details?.surface === "filter"
				? "Use “Begins with” here instead, or move the matching rule into a custom search condition."
				: "Use “Begins with,” or choose another matching option.";
		return `${subject} uses a matching option that isn't available here. ${repair}`;
	},
	CASE_LIST_DATE_ADD_NOT_ON_DEVICE: (e) => {
		const inputLabel = e.details?.inputLabel || e.details?.inputName;
		const subject = (() => {
			switch (e.details?.surface) {
				case "search-button":
					return `The Search button condition in ${q(modName(e))}`;
				case "advanced-input":
					return `The condition for search field ${q(inputLabel || "this field")}`;
				case "search-input-default":
					return `The default for search field ${q(inputLabel || "this field")}`;
				case "calculated-column":
					return `The calculation for field ${q(det(e, "columnLabel", "this field"))}`;
				case "excluded-owner-ids":
					return `${q(modName(e))}'s assigned cases setting`;
				default:
					return `${q(modName(e))}'s Cases available rule`;
			}
		})();
		switch (e.details?.reason) {
			case "datetime-base":
				return `${subject} uses a date and time in a calculation that only supports whole dates here, so the time would be lost. Use a date without a time or rewrite the calculation.`;
			default:
				return `${subject} adds ${det(e, "interval", "a calendar interval")}, but month and year calculations aren't available here. Use seconds, minutes, hours, days, or weeks. To use months or years, put the comparison directly in a search condition.`;
		}
	},
	CASE_LIST_EXPRESSION_NOT_ON_DEVICE: (e) => {
		const inputLabel = e.details?.inputLabel || e.details?.inputName;
		const subject = (() => {
			switch (e.details?.surface) {
				case "search-button":
					return `The Search button condition in ${q(modName(e))}`;
				case "advanced-input":
					return `The condition for search field ${q(inputLabel || "this field")}`;
				case "search-input-default":
					return `The default for search field ${q(inputLabel || "this field")}`;
				case "calculated-column":
					return `The calculation for field ${q(det(e, "columnLabel", "this field"))}`;
				case "excluded-owner-ids":
					return `${q(modName(e))}'s assigned cases setting`;
				default:
					return `${q(modName(e))}'s Cases available rule`;
			}
		})();
		switch (e.details?.reason) {
			case "multi-valued-relation-read":
				return `${subject} can read several ${q(det(e, "property", "values"))} values from related cases, but it needs one value. Use “Count related cases” or move the check into a related-case condition.`;
			case "mixed-property-scopes":
				return `${subject} compares information from different cases inside one condition. Finish one condition for each case, then combine those conditions with All, Any, or Not.`;
			case "unrebasable-relation-scope":
				return `${subject} puts a related-case condition or count inside another related-case calculation. Move that condition outside the calculation so each relationship has a clear case to check.`;
			case "nested-multi-case-count":
				return `${subject} counts child cases from inside another child-case condition. Move the count to its own condition, then combine the finished conditions.`;
			case "invalid-geopoint-center":
				return `${subject} uses ${q(det(e, "value", "this value"))} as a location, but it needs a valid latitude and longitude, such as ${q("42.3601, -71.0589")}.`;
			default:
				return `${subject} turns saved list text into several values, but this setting can only use one. Replace it with a single-value calculation.`;
		}
	},
	CASE_LIST_MATCH_MODE_TOKENIZES_WHITESPACE: (e) =>
		`A search in ${q(modName(e))} checks each word in a value separately, so a value with spaces may match more cases than you expect. Use one word or “Begins with.”`,
	CASE_LIST_STRICT_NULL_NOT_PORTABLE: (e) => {
		const inputLabel = e.details?.inputLabel || e.details?.inputName;
		const subject = (() => {
			switch (e.details?.surface) {
				case "search-button":
					return `The Search button condition in ${q(modName(e))}`;
				case "advanced-input":
					return `The condition for search field ${q(inputLabel || "this field")}`;
				case "search-input-default":
					return `The default for search field ${q(inputLabel || "this field")}`;
				case "calculated-column":
					return `The calculation for field ${q(det(e, "columnLabel", "this field"))}`;
				case "excluded-owner-ids":
					return `${q(modName(e))}'s assigned cases setting`;
				default:
					return `${q(modName(e))}'s Cases available rule`;
			}
		})();
		return `${subject} checks whether information was never recorded, but the app can only tell whether it's blank here. Use “is blank” instead.`;
	},
	CASE_LIST_ANCESTOR_EXISTS_NESTS_CROSS_DIRECTION_WALK: (e) =>
		`A condition in ${q(modName(e))} checks a child case inside a parent case, which search can't run. Put the checks side by side or split them into separate search fields.`,
	CASE_LIST_CSQL_NOT_REPRESENTABLE: (e) => {
		const inputLabel = e.details?.inputLabel || e.details?.inputName;
		const subject = inputLabel
			? `The condition for search field ${q(inputLabel)}`
			: `${q(modName(e))}'s Cases available rule`;
		switch (e.details?.reason) {
			case "comparison-needs-case-property":
				return `${subject} needs one piece of case information to search. Choose it first, then compare it with a fixed value or a search answer.`;
			case "case-property-on-value-side":
				return `${subject} compares two case properties. Choose one property and compare it with a fixed value or a search answer.`;
			case "multiple-property-scopes":
				return `${subject} compares properties from different cases. Choose one property and compare it with a value, or make separate related-case conditions.`;
			case "case-query-in-runtime-value":
				return `${subject} puts a case condition inside a calculation. Move that condition into the surrounding rule.`;
			case "related-count-on-value-side":
				return `${subject} uses a related-case count as the comparison value. Put the child-case count first, then compare it with a fixed number or a search answer.`;
			case "unsupported-related-count":
				return `${subject} can only count child cases here. Choose a child relationship, or rewrite the condition without a related-case count.`;
			case "self-relation-not-queryable":
				return `${subject} uses “this case” as a relationship. Choose a parent or child relationship, or remove the related-case condition.`;
			case "csql-string-not-quotable":
				return `${subject} includes both single and double quotation marks in the same fixed value. Use only one kind of quotation mark in that value.`;
			case "calendar-date-add-needs-whole-number":
				return `${subject} shifts a date by months or years without a whole number. Use a fixed whole number or convert one search answer to Number.`;
			case "subcase-count-needs-nonnegative-whole-number":
				return `${subject} compares a child-case count with an unsupported value. Use a whole number that is zero or greater.`;
			default:
				return `${subject} uses a condition that isn't available here. Choose one piece of case information to search, then compare it with a fixed value or a search answer.`;
		}
	},
	FIELD_KIND_PROPERTY_TYPE_MISMATCH: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} saves to ${q(det(e, "property", "a case property"))}, but its type doesn't match how that property is set up. Change the field's type, or save it somewhere else.`,
	FIELD_KIND_WRITERS_DISAGREE: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} saves to ${q(det(e, "property", "a case property"))} in a different format than the other fields that use it. Change this one to match them, or save it somewhere else.`,

	// ── Case-search config ───────────────────────────────────────────
	CASE_SEARCH_CONFIG_REQUIRES_CASE_TYPE: (e) =>
		`${q(modName(e))} has a search set up but no case type, so there's nothing for it to look through. Pick the kind of case it should find, like "patient" or "household".`,
	CASE_SEARCH_EXCLUDED_OWNER_IDS_CASE_DATA_UNAVAILABLE: (e) =>
		`The assigned cases setting on ${q(modName(e))} tries to read a case before one has been selected. Replace it with Show in Results or Hide from Results.`,
	CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR: (e) =>
		`The assigned cases setting on ${q(modName(e))} isn't coming out as text. Check the formula, or clear it.`,
	CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR: (e) =>
		`The condition that controls whether ${q(modName(e))}'s Search button appears has an error. Fix it or clear the condition to always show the button.`,
	CASE_SEARCH_BUTTON_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE: (e) =>
		`The condition that controls whether ${q(modName(e))}'s Search button appears tries to read a case before one has been selected. Use fixed values or current-user information, or clear the condition to always show the button.`,

	// ── Form-level ───────────────────────────────────────────────────
	EMPTY_FORM: (e) =>
		`${q(formName(e))} doesn't have any fields yet. Add at least one.`,
	CASE_WRITE_NO_CASE_ACTION: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is set to save case data, but this form doesn't create, open, or close a case. Remove that case destination, or move the field to a case form.`,
	CASE_WRITE_NOT_DIRECT_CHILD: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} saves to ${q(det(e, "caseType", "a case type"))}, but this form can save only to its main case or one of that case's direct children. Choose one of those destinations, or clear the case destination.`,
	CASE_WRITE_DUPLICATE_PROPERTY: (e) =>
		`In ${q(formName(e))}, several fields save to ${q(det(e, "property", "the same case property"))} in one case action and would overwrite each other. Keep one writer, or point the others somewhere else.`,
	CASE_CREATE_NAME_MISSING: (e) =>
		`${q(formName(e))} creates ${q(det(e, "caseType", "case"))} cases, but nothing gives them a name. Add one field whose case destination property is "case_name".`,
	CASE_CREATE_NAME_DUPLICATE: (e) =>
		`${q(formName(e))} has more than one field naming the same new ${q(det(e, "caseType", "case"))} case. Keep one "case_name" writer and change or clear the others.`,
	RESERVED_CASE_PROPERTY: (e) =>
		`${q(formName(e))} has a field that saves to ${q(det(e, "reservedName", "a reserved name"))}, which is a reserved name. Have it save somewhere else.`,
	CAPTURE_CASE_WRITE_STANDARD_PROPERTY: (e) =>
		`${q(formName(e))} saves an attachment question to ${q(det(e, "property", "a standard property"))}, which CommCare keeps as the case's own ${det(e, "property", "") === "external_id" ? "external id" : "name"}. Save the attachment to a property of its own instead.`,
	FORM_TOO_MANY_ATTACHMENTS: (e) =>
		`${q(formName(e))} asks for ${det(e, "captureCount", "too many")} attachments, and CommCare accepts at most ${MAX_FORM_ATTACHMENTS} per submitted form, a worker who answered them all couldn't submit. Split this into more than one form, or remove some attachment questions.`,
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
	CONNECT_ID_TOO_LONG: (e) =>
		`The Connect ID ${q(det(e, "connectId", ""))} in ${q(formName(e))} is too long. Keep it to 50 characters or fewer.`,
	CONNECT_ID_INVALID_FORMAT: (e) =>
		`The Connect ID ${q(det(e, "connectId", ""))} in ${q(formName(e))} won't work. Use letters, numbers, and underscores, starting with a letter.`,
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
	CASE_OPERATION_DUPLICATE_UUID: () =>
		"Two case operations have the same identity. Remove one and add it again.",
	CASE_OPERATION_INVALID_ID: () =>
		"A case operation has an ID that won't work. Start with a letter or underscore and use only letters, numbers, or underscores.",
	CASE_OPERATION_DUPLICATE_ID: () =>
		"Two case operations use the same ID. Rename one of them.",
	CASE_OPERATION_INVALID_FACETS: () =>
		"A case operation includes a setting that doesn't fit what it does. Review its action and settings.",
	CASE_OPERATION_UNKNOWN_CASE_TYPE: () =>
		"A case operation uses a case type that isn't in this app. Choose an available case type.",
	CASE_OPERATION_INVALID_CASE_TYPE: () =>
		"A case operation uses a case type name that CommCare can't store. Choose a shorter name made from letters, numbers, underscores, or hyphens.",
	CASE_OPERATION_RESERVED_CASE_TYPE: () =>
		"That case type is managed by the platform and can't be changed here. Choose one of your app's case types.",
	CASE_OPERATION_UNKNOWN_PROPERTY: () =>
		"A case operation writes case information that isn't set up on that case type. Add it or choose another property.",
	CASE_OPERATION_RESERVED_PROPERTY: () =>
		"A case operation writes to a reserved name. Use the operation's matching setting or another property.",
	CASE_OPERATION_EXPRESSION_TYPE: (e) => {
		if (e.details?.reason === "datetime-base") {
			return "A date calculation in this case operation starts from a date and time, but the time would be lost here. Use a whole date or choose another calculation.";
		}
		if (e.details?.reason === "calendar-interval") {
			return "A date calculation in this case operation uses months or years, which aren't available here. Use seconds, minutes, hours, days, or weeks.";
		}
		return "A value or condition in this case operation doesn't fit where it's used. Review the highlighted operation.";
	},
	CASE_OPERATION_TARGET_INVALID: () =>
		"A case operation can't resolve the case it should work on. Choose a valid target.",
	CASE_OPERATION_TARGET_TYPE_MISMATCH: () =>
		"A case operation points to the wrong kind of case. Choose a target with the same case type.",
	CASE_OPERATION_REFERENCE_ORDER: () =>
		"A case operation refers to a case that isn't created yet. Move the create operation before this one.",
	CASE_OPERATION_EXECUTION_ORDER: () =>
		"These case operations use an order the running form can't preserve. Put authored-ID creates before updates and closes, and keep each repeating section's operations together in form order.",
	CASE_OPERATION_REPEAT_INVALID: () =>
		"A case operation points to a repeating section that isn't available. Choose a repeat in this form.",
	CASE_OPERATION_REPEAT_CORRELATION: () =>
		"These case operations don't run over the same repeating section. Use the same repeat so each row stays paired.",
	CASE_OPERATION_AMBIGUOUS_REFERENCE: () =>
		"This case operation refers to several created cases as though there were one. Run it over the same repeat.",
	CASE_OPERATION_SESSION_UNAVAILABLE: () =>
		"This form doesn't open with one selected case, so a case operation can't use the current case. Choose another target.",
	CASE_OPERATION_LINK_INVALID: () =>
		"A case link in this operation isn't valid. Review its name and target.",
	CASE_OPERATION_RETYPE_UNSAFE: () =>
		"Changing this case's type would leave required information missing. Add those values or choose another case type.",
	CASE_HASHTAG_ON_CREATE_FORM: (e) =>
		`${q(formName(e))} creates a new case but reads from one that doesn't exist yet (${det(e, "hashtag", "a case reference")}). Point it at a form question instead.`,
	PRIMARY_CASE_FIELD_IN_REPEAT: (e) => {
		const f = det(e, "fieldId", "a field");
		return `In ${q(formName(e))}, ${q(f)} is inside a repeating section but saves to the form's main case, which a repeat can't do. Move it out of the repeat, or save it to a child case instead.`;
	},

	// ── Field-level ──────────────────────────────────────────────────
	SELECT_NO_OPTIONS: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is a multiple-choice field with no choices yet. Add at least one.`,
	SELECT_TOO_FEW_OPTIONS: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is a multiple-choice field with only one choice. Add another so there's something to pick between.`,
	CASE_WRITE_UNKNOWN_TYPE: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} saves to the ${q(det(e, "caseType", "case type"))} case type, but no case type by that name exists. Add that case type, or point the field at one that does.`,
	HIDDEN_NO_VALUE: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is hidden but has no value, so it'll always stay blank. Give it a default or a calculated value.`,
	REQUIRED_ON_HIDDEN: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is hidden, so it can't be required, no one can fill it in. Turn off required, or make the field visible.`,
	CALCULATE_ON_VISIBLE_INPUT: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} has a calculated value, but only hidden fields can. On a visible field, whatever someone types gets ignored. Move it to a hidden field, or drop the calculation.`,
	UNQUOTED_STRING_LITERAL: (e) =>
		`A formula on ${q(fieldName(e))} in ${q(formName(e))} looks like plain text. If you meant the words ${q(det(e, "bareWord", ""))}, put quotes around them.`,
	VALIDATION_ON_NON_INPUT_KIND: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} can't have a validation rule, only fields people answer can. Remove it, or change the field's type.`,
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
	LOOKUP_SELECT_FILTER_TERM_NOT_ALLOWED: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} filters lookup choices with information that isn't available while choices are being built. Use lookup columns, fixed values, current-user/session values, or an eligible earlier answer.`,
	LOOKUP_SELECT_FILTER_FIELD_NOT_EARLIER: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} filters its choices using an answer that comes later in the form. Move the source question earlier or remove that dependency.`,
	LOOKUP_SELECT_FILTER_FIELD_REPEAT_SCOPE: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} filters its choices using a repeated answer from a different repetition context. Use a root answer or an earlier answer from the current or an enclosing repeat.`,
	LOOKUP_SELECT_FILTER_TYPE_ERROR: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} has a lookup-choice filter whose values don't fit the comparison. Adjust the referenced columns, values, or operator.`,
	LOOKUP_SELECT_FILTER_NOT_ON_DEVICE: (e) =>
		e.details?.reason === "datetime-base"
			? `${q(fieldName(e))} in ${q(formName(e))} filters its choices with a date and time calculation, but the time would be lost here. Use a whole date or choose another calculation.`
			: `${q(fieldName(e))} in ${q(formName(e))} filters its choices with a month or year calculation that isn't available here. Use seconds, minutes, hours, days, or weeks.`,

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
	PROSE_EDITOR_ROUND_TRIP_LOSS: (e) =>
		`The text on ${q(fieldName(e))} in ${q(formName(e))} contains something the editor can't safely preserve. Re-enter its text and references.`,
	CYCLE: (e) =>
		`Some field formulas or lookup choices in ${q(formName(e))} depend on each other in a loop, so their values can't settle. Remove one of the references to break it.`,
	TYPE_ERROR: (e) =>
		`A formula on ${q(fieldName(e))} in ${q(formName(e))} uses text where it needs a number, so the result might come out wrong. Check the values it's working with.`,

	// ── Lookup references ────────────────────────────────────────────
	LOOKUP_CONTEXT_UNAVAILABLE: () =>
		"Lookup data hasn't finished reconnecting yet. Wait a moment, then try that change again.",
	LOOKUP_TABLE_NOT_AVAILABLE: () =>
		"This setting uses a lookup table that isn't available in this Project. Choose an available table, or clear the setting.",
	LOOKUP_COLUMN_NOT_AVAILABLE: () =>
		"This setting uses a lookup column that isn't available anymore. Choose another column, or clear the setting.",
	LOOKUP_COLUMN_TYPE_MISMATCH: (e) =>
		`This setting needs ${det(e, "acceptedColumnTypes", "a different kind of")} data, but the selected lookup column contains ${det(e, "actualColumnType", "incompatible")} data. Choose a compatible column.`,
	LOOKUP_CARRIER_EXPORT_NOT_ACTIVE: () =>
		"Lookup-powered choices and calculations aren't ready to export yet. Remove the lookup-powered setting before exporting.",
	LOOKUP_SELECT_SOURCE_VALUE_BLANK: (e) =>
		`A lookup-powered choice list uses ${det(e, "columnLabel", "a column")} for its saved values, but ${det(e, "offendingRowCount", "some")} row(s) in ${det(e, "tableName", "the lookup table")} leave it blank. Fill in those rows or choose another value column.`,
	LOOKUP_SELECT_SOURCE_VALUE_WHITESPACE: (e) =>
		`A lookup-powered choice list uses ${det(e, "columnLabel", "a column")} for its saved values, but ${det(e, "offendingRowCount", "some")} row(s) in ${det(e, "tableName", "the lookup table")} contain spaces or line breaks there. Saved values can't contain whitespace. Tidy those rows or choose another value column.`,
	LOOKUP_SELECT_SOURCE_VALUE_DUPLICATE: (e) =>
		`A lookup-powered choice list uses ${det(e, "columnLabel", "a column")} for its saved values, but ${det(e, "tableName", "the lookup table")} repeats the same value in several rows. Make the values unique or choose another value column.`,
	LOOKUP_SELECT_SOURCE_LABEL_BLANK: (e) =>
		`A lookup-powered choice list uses ${det(e, "columnLabel", "a column")} for its labels, but ${det(e, "offendingRowCount", "some")} row(s) in ${det(e, "tableName", "the lookup table")} leave it blank. Fill in those rows or choose another label column.`,
	LOOKUP_FIXTURE_EXPORT_TOO_LARGE: () =>
		"This app references more lookup data than it can bundle at once. Shrink or split the largest lookup tables and try again.",

	// ── Media (export boundary) ──────────────────────────────────────
	MEDIA_ASSET_NOT_FOUND: () =>
		"An attached media file is missing, it may have been deleted. Open the slot and pick another file, or clear it.",
	MEDIA_ASSET_NOT_READY: () =>
		"An attached media file hasn't finished uploading yet. Give it a moment, or clear the slot.",
	MEDIA_KIND_MISMATCH: (e) => {
		const kind = det(e, "expectedKind", "");
		return kind
			? `An attached file is the wrong type, this slot takes ${kind}. Swap it out, or clear the slot.`
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
	"Something went wrong preparing your app. This is on our end. Try again, and let us know if it keeps happening.";

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

/**
 * The line a picker or menu shows beside a choice it will not offer.
 *
 * Not `describeCommitFindings`: that is the commit-REJECTION report,
 * past tense about an attempt, framed with "nothing was changed", and
 * multi-line. A withheld choice was never attempted — the question is
 * asked while the item is still being drawn — so that frame describes
 * something that did not happen, in a span that collapses its newlines
 * into the middle of a sentence. And not the whole list either: an item
 * has room for one line, and the author fixes one thing at a time.
 *
 * The first finding in the builder's own voice, which is also what
 * `useBlueprintMutations` says when a dispatch really is refused — so a
 * disabled choice and the refusal it spares the author agree.
 */
export function offeredChoiceRefusal(
	findings: readonly ValidationError[],
): string {
	const first = findings[0];
	return first === undefined
		? "This choice isn't available here."
		: userFacingError(first);
}

/** Exposed for the exhaustiveness test only. */
export const USER_MESSAGE_CODES = new Set(
	Object.keys(USER_MESSAGE_BY_CODE) as ValidationErrorCode[],
);
