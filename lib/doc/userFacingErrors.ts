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
 * than leaking wire detail. The table requires every non-oracle code at
 * compile time, derived from `VALIDITY_CLASS_BY_CODE`.
 */

import { MAX_FORM_ATTACHMENTS } from "@/lib/commcare/constants";
import type {
	ValidationError,
	ValidationErrorCode,
} from "@/lib/commcare/validator/errors";
import type { UserFacingValidationCode } from "@/lib/commcare/validator/gate";
import {
	type EntryPointIdProblem,
	entryPointIdProblemSentence,
} from "@/lib/domain/entryPoints";
import {
	type CaseOperationNameProblem,
	caseOperationNameSentence,
	type QuestionIdProblem,
	questionIdProblemSentence,
	sourceWritePropertySentence,
} from "@/lib/domain/questionId";
import { standardCasePropertyDisplayLabel } from "@/lib/domain/standardCaseProperties";

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

/** A sentence's subject placed later in a sentence. */
const lowerFirst = (subject: string): string =>
	subject.charAt(0).toLowerCase() + subject.slice(1);

const QUESTION_ID_PROBLEMS: ReadonlySet<string> = new Set<QuestionIdProblem>([
	"leading-underscore",
	"not-letter-first",
	"characters",
	"xml-prefix",
	"reserved-name",
]);

/**
 * The question-id sentence a finding's `problem` and `suggestedId` details
 * name, which the verdicts say too; `undefined` when the finding carries
 * neither (a document from before the details).
 */
const questionIdSentence = (
	e: ValidationError,
	id: string,
	noun: "question" | "connect",
): string | undefined => {
	const problem = e.details?.problem;
	const suggestedId = e.details?.suggestedId;
	if (problem === undefined || suggestedId === undefined) return undefined;
	if (!QUESTION_ID_PROBLEMS.has(problem)) return undefined;
	return questionIdProblemSentence(
		id,
		problem as QuestionIdProblem,
		suggestedId,
		noun,
	);
};

/** The after-submit picker's label for each stored destination. */
function afterSubmitLabel(destination: string, parentName: string): string {
	switch (destination) {
		case "app_home":
			return "App home";
		case "firstMenu":
			return "First menu";
		case "module":
			return "This module";
		case "parentMenu":
			return `Parent module: ${parentName}`;
		default:
			return "Previous screen";
	}
}

/** How a withheld destination reads inside the reason's sentence. */
function afterSubmitPhrase(destination: string): string {
	switch (destination) {
		case "module":
			return "its module";
		case "parentMenu":
			return "the parent module";
		default:
			return "the previous screen";
	}
}

/**
 * `POST_SUBMIT_NOT_OFFERED`: the reason's sentence, then the destinations
 * the form is offered as the picker labels them. The validator's message
 * says the same with the tool's values.
 */
function postSubmitNotOfferedSentence(e: ValidationError): string {
	const form = q(formName(e));
	const module = q(modName(e));
	const parentName = det(e, "parentName", "the parent module");
	const phrase = afterSubmitPhrase(det(e, "destination", "previous"));
	const offered = (e.details?.offered ?? "app_home,firstMenu")
		.split(",")
		.filter((value) => value.length > 0)
		.map((value) => q(afterSubmitLabel(value, parentName)))
		.join(", ");
	const reason = (() => {
		switch (e.details?.reason) {
			case "menu-selects-several":
				return `${form} goes to the previous screen after submit, but ${module} selects several cases, and CommCare has no previous screen to return to there.`;
			case "parent-selects-several":
				return `${form} goes to ${phrase} after submit, but ${module} sits under ${q(parentName)}, which selects several cases.`;
			case "menu-opens-on-search":
				return `${form} goes to the previous screen after submit, but ${module} opens on Search, and CommCare can't go back to the previous screen there.`;
			case "menu-is-case-list-only":
				return `${form} goes to its module after submit, but ${module} is a case list with no forms, so there is no form list to land on.`;
			case "no-parent-menu":
				return `${form} goes to the parent module after submit, but ${module} has no parent module.`;
			case "menu-off-the-menu":
				return `${form} goes to ${phrase} after submit, but ${module} is off the menu: on Android that screen lists nothing, and Web Apps opens another screen instead.`;
			case "parent-off-the-menu":
				return `${form} goes to the parent module after submit, but ${q(parentName)} is off the menu: on Android it lists none of its own forms, and Web Apps opens the app's first screen instead.`;
			default:
				return `${form} goes somewhere after submit that ${module} doesn't offer.`;
		}
	})();
	return `${reason} Choose one of: ${offered}.`;
}

const ENTRY_POINT_ID_PROBLEMS: ReadonlySet<string> =
	new Set<EntryPointIdProblem>(["characters", "edge", "doubled-hyphen"]);

const CASE_OPERATION_NAME_PROBLEMS: ReadonlySet<string> =
	new Set<CaseOperationNameProblem>([
		"stops_form_builder",
		"reads_as_case_action",
	]);

/** The reserved-name sentence of an operation id or link finding. */
const caseOperationNameFindingSentence = (
	e: ValidationError,
	name: string | undefined,
): string | undefined => {
	const problem = e.details?.problem;
	const suggestedId = e.details?.suggestedId;
	if (
		name === undefined ||
		problem === undefined ||
		suggestedId === undefined ||
		!CASE_OPERATION_NAME_PROBLEMS.has(problem)
	)
		return undefined;
	return caseOperationNameSentence(
		name,
		problem as CaseOperationNameProblem,
		suggestedId,
	);
};

/**
 * The person-facing name of the module surface a wire-slot finding sits on,
 * one arm per `ModuleWireSlotSurface` so a finding on a search field's
 * required condition, check, or hidden value is never reported as the
 * module's Cases available rule.
 */
const moduleWireSlotSubject = (e: ValidationError): string => {
	const inputLabel = q(
		present(e.details?.inputLabel ?? e.details?.inputName, "this field"),
	);
	switch (e.details?.surface) {
		case "search-button":
			return `The Search button condition in ${q(modName(e))}`;
		case "advanced-input":
			return `The condition for search field ${inputLabel}`;
		case "search-input-default":
			return `The default for search field ${inputLabel}`;
		case "search-input-required":
			return `The required condition for search field ${inputLabel}`;
		case "search-input-validation":
			return `The check on search field ${inputLabel}`;
		case "search-input-hidden-value":
			return `The hidden search value ${inputLabel}`;
		case "calculated-column":
			return `The calculation for field ${q(det(e, "columnLabel", "this field"))}`;
		case "excluded-owner-ids":
			return `${q(modName(e))}'s assigned cases setting`;
		default:
			return `${q(modName(e))}'s Cases available rule`;
	}
};

/** The field id at the end of a `/data/...` path: what the builder calls it. */
const pathLeaf = (path: string): string =>
	path.slice(path.lastIndexOf("/") + 1);

/**
 * An after-submit link named by where it goes, from the `destination` /
 * `destinationKind` details the form-link rules stamp; "one of the links"
 * when the target is gone.
 */
const formLinkPhrase = (e: ValidationError): string => {
	const destination = e.details?.destination;
	if (!destination) return "one of the after-submit links";
	return e.details?.destinationKind === "module"
		? `the link to the ${q(destination)} module`
		: `the link to ${q(destination)}`;
};

/**
 * Why a choice's stored value was refused, from the `problem` detail the
 * two option-value rules stamp; the neutral phrase when it is absent.
 */
const optionValueProblemPhrase = (e: ValidationError): string => {
	/* JSON-quoted rather than `q()`: a blank value would otherwise render
	 * as an empty pair of quotes, and a tab or a quote mark inside the
	 * value has to stay visible for the sentence to make sense. */
	const shown = JSON.stringify(e.details?.optionValue ?? "");
	switch (e.details?.problem) {
		case "empty":
			return "has an empty stored value";
		case "whitespace":
			return `has the stored value ${shown}, which contains a space`;
		case "quote":
			return `has the stored value ${shown}, which contains a quote mark`;
		default:
			return `has the stored value ${shown}, which the app can't store`;
	}
};

type UserMessageBuilder = (err: ValidationError) => string;

/** The formula a form-logic finding sits in: on a question, in a form, or
 * in the rule of a case property when no form carries it. */
const formulaSubject = (e: ValidationError): string =>
	e.location.fieldId === undefined
		? e.location.formName === undefined
			? "A formula"
			: `A formula in ${q(formName(e))}`
		: `A formula on ${q(fieldName(e))} in ${q(formName(e))}`;

/** One value of a case property type, from a `valueType`-style detail. */
const oneValuePhrase = (type: string | undefined): string => {
	switch (type) {
		case "int":
			return "a whole number";
		case "decimal":
			return "a number";
		case "date":
			return "a date";
		case "datetime":
			return "a date and time";
		case "time":
			return "a time";
		case "geopoint":
			return "a location";
		case "text":
			return "text";
		case "single_select":
			return "a choice";
		case "multi_select":
			return "several choices";
		default:
			return "a value";
	}
};

/** What a property of a type holds, in the plural. */
const heldValuesPhrase = (type: string | undefined): string => {
	switch (type) {
		case "int":
			return "whole numbers";
		case "decimal":
			return "numbers";
		case "date":
			return "dates";
		case "datetime":
			return "dates and times";
		case "time":
			return "times";
		case "geopoint":
			return "locations";
		case "text":
			return "text";
		case "single_select":
			return "a choice";
		case "multi_select":
			return "several choices";
		default:
			return "another kind of value";
	}
};

/** Several kinds as one phrase, from a comma-joined list of types. */
const valuesPhrase = (types: string | undefined, first: string | undefined) => {
	const phrases = [
		...new Set(
			(types === undefined ? [first] : types.split(",")).map(oneValuePhrase),
		),
	];
	return phrases.length <= 1
		? (phrases[0] ?? "a value")
		: `${phrases.slice(0, -1).join(", ")} or ${phrases[phrases.length - 1]}`;
};

// ── The code → builder table ───────────────────────────────────────

/** The field a misplaced section sits in, from `parentKind` / `parentId`. */
const sectionParentPhrase = (e: ValidationError): string => {
	const id = e.details?.parentId;
	if (id === undefined || id.trim().length === 0) return "another field";
	return `the ${det(e, "parentKind", "field")} ${q(id)}`;
};

/** "one field sits" / "3 fields sit", from `looseCount`. */
const looseFieldsPhrase = (e: ValidationError): string => {
	const count = det(e, "looseCount", "");
	if (count === "1") return "one field sits";
	return `${present(count, "some")} fields sit`;
};

const USER_MESSAGE_BY_CODE: Record<
	UserFacingValidationCode,
	UserMessageBuilder
> &
	Partial<
		Record<Exclude<ValidationErrorCode, UserFacingValidationCode>, never>
	> = {
	// ── App-level ────────────────────────────────────────────────────
	// Reached in the builder only by trying to remove the app's last module, so
	// "add one" reads backwards — you'd add another BEFORE removing this one.
	NO_MODULES: () =>
		"An app needs at least one module, so you can't remove your last one. Add another first if you want to replace it.",
	EMPTY_APP_NAME: () => "Your app needs a name. Add one to get started.",
	APP_TEXT_UNREPRESENTABLE: (e) =>
		`${det(e, "label", "Some app text")} contains a character Nova can't preserve. You can remove ${det(e, "character", "that character")} or retype the affected text.`,
	RESERVED_CASE_TYPE_NAME: (e) => {
		const ct = det(e, "caseType", "");
		return ct
			? `${q(ct)} is a reserved word, so it can't be a case type. Try something more specific, like ${q(`${ct}_record`)}.`
			: 'That case type uses a reserved word. Try something more specific, like adding "_record".';
	},
	XPATH_CARRIER_CONTEXT_UNAVAILABLE: () =>
		"An after-submit formula reads the form after it has closed. Save the value to a case property or read session data instead.",
	XPATH_FUNCTION_CONTEXT_UNAVAILABLE: (e) => {
		const question = q(det(e, "choiceFieldId", "that question"));
		switch (e.details?.reason) {
			case "here":
				return `${formulaSubject(e)} uses here(), which is where the worker is. A case list knows that and a form doesn't. You can add a location question and use its answer instead.`;
			case "choice-name-dynamic":
				return `${formulaSubject(e)} asks for the label of a choice of ${question}, whose choices come from a Project data table or from cases. You can read the label from where the choices come from instead.`;
			case "choice-name":
				return `${formulaSubject(e)} asks for the label of a choice of ${question}, which a form can't read here. You can use the answer itself instead.`;
			default:
				return "A function in a formula needs information that isn't available here. Use it where that information is available, or rewrite the formula.";
		}
	},
	MISSING_CHILD_CASE_MODULE: (e) => {
		const ct = det(e, "caseType", "");
		return ct
			? `Your forms create ${q(ct)} cases, but there's no module showing them yet. Add a module for ${q(ct)}.`
			: "Some of your forms create child cases that have nowhere to show. Add a module for that case type.";
	},
	FORM_LINK_CIRCULAR: () =>
		"Your after-submit links loop in a circle, so people would get stuck going form to form. Point one of them at a module instead of another form to break the loop.",
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
	CASE_PROPERTY_OPTION_VALUE_INVALID: (e) =>
		`A choice on the ${q(det(e, "caseType", "case type"))} property ${q(det(e, "property", "property"))} ${optionValueProblemPhrase(e)}. A choice's value is the answer the app saves, so it can't hold spaces or quote marks and can't be empty. Use ${q(det(e, "suggestedValue", "a_value_like_this"))} and keep the wording in the label.`,
	CASE_PROPERTY_OPTION_VALUE_DUPLICATE: (e) =>
		`Two choices of the ${q(det(e, "caseType", "case type"))} property ${q(det(e, "property", "property"))} both store ${q(det(e, "optionValue", ""))}, so a saved value can't say which was chosen. ${q(det(e, "suggestedValue", "a_new_value"))} is free for the second.`,
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
		`${q(formName(e))} assigns new cases to one particular place, and the exported rule names that place by Nova's own id, which CommCare HQ doesn't recognize, so the rule would match nobody. Assign to a place beneath the current case owner instead, or remove this owner rule.`,
	ENTRY_POINT_INVALID: (e) => {
		switch (e.details?.reason) {
			case "duplicate-id":
				return "Two deep links use the same ID. Give one of them a different ID.";
			case "id-format": {
				const problem = e.details?.problem;
				const suggestedId = e.details?.suggestedId;
				return problem !== undefined &&
					suggestedId !== undefined &&
					ENTRY_POINT_ID_PROBLEMS.has(problem)
					? entryPointIdProblemSentence(
							problem as EntryPointIdProblem,
							suggestedId,
						)
					: "This deep link ID needs lowercase letters, numbers, underscores, or hyphens.";
			}
			case "display-conditions":
				return "Only a link to a form can skip display conditions. Keep display conditions enabled for this destination.";
			default:
				return "This change would leave a deep link without a usable destination. In Deep links, choose a compatible destination or remove that link first.";
		}
	},
	AUTOMATION_INVALID: () =>
		"This automation no longer fits the app. Open it and replace any case, form, place, or worker information that has changed.",

	// ── Module-level ─────────────────────────────────────────────────
	CASE_PARENT_SELECTION_INVALID: (e) =>
		`${q(modName(e))} needs a compatible parent list. Choose a module for its parent record type, or turn off parent selection.`,
	CASE_PARENT_SELECTION_CONFLICT: (e) =>
		`${q(modName(e))} would reuse a different parent selected in its containing menu. Choose that containing module as the parent selector, or move this module out of the submenu.`,
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
	NESTED_MENU_CROSS_TYPE_ROOT_REQUIRES_FORM: (e) =>
		`${q(modName(e))} uses a different case type from its parent, and that parent only shows Results. Add a form to the parent, use the same case type, or make this module top-level.`,
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
	DISPLAY_CONDITION_USE_HIDDEN_FROM_MENU: (e) => {
		const subject = e.scope === "module" ? modName(e) : formName(e);
		return `${q(det(e, "name", subject))} has a display condition that starts with "never". To keep it off the menu, turn off "Show on the menu" and keep the rest of the condition.`;
	},
	HIDDEN_MENU_NOT_A_DESTINATION: (e) => {
		const arm = e.details?.arm;
		const module =
			arm === "link" ? det(e, "targetModuleName", "this module") : modName(e);
		const what =
			arm === "link"
				? `the link from ${q(formName(e))}`
				: arm === "case-list-entry-point"
					? "its case list entry point"
					: "its entry point";
		return `${q(module)} is off the menu, so ${what} would open a menu with nothing in it on Android and the app's first screen in Web Apps. Point it at a form inside the module, or show the module on the menu again.`;
	},

	// ── Case-list config ─────────────────────────────────────────────
	CASE_LIST_COLUMN_UNKNOWN_FIELD: (e) =>
		`One item in ${q(modName(e))} shows ${q(det(e, "field", "case information"))}, but that information isn't saved on this case type. Choose information that exists.`,
	CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH: (e) =>
		`An item in ${q(modName(e))} shows ${q(det(e, "field", "case information"))}, but its display style can't format ${det(e, "resolvedType", "this kind of")} information. Choose matching information or change the display style. Plain text always works.`,
	CASE_LIST_COLUMN_OVER_ATTACHMENT_SLOT: (e) =>
		`An item in ${q(modName(e))} shows ${q(det(e, "field", "case information"))}, but that case property holds an attached file rather than a value, so the item would stay empty on every case. Show something else, or change the question that saves it so it saves a link to the file instead.`,
	CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR: (e) =>
		`A calculated value in ${q(modName(e))} has a calculation that doesn't quite add up. Open it and fix the calculation.`,
	CASE_LIST_FILTER_TYPE_ERROR: (e) =>
		`The Cases available setting in ${q(modName(e))} compares values that don't go together. Open the condition and adjust the comparison.`,
	CASE_LIST_DUPLICATE_SORT_PRIORITY: (e) =>
		`Two items in ${q(modName(e))}'s Default order use the same position. Move one of them or remove it from the order.`,
	CASE_LIST_SORT_PROPERTY_AMBIGUOUS: (e) =>
		det(e, "shape", "") === "first-column-differs"
			? `In ${q(modName(e))}, CommCare gives this order rule to the first column with the same value, which is ${q(det(e, "firstLabel", "another column"))}, and that column orders differently. You can put the order rule on that column, or move this column ahead of it.`
			: `${q(modName(e))} already orders by the same value on ${q(det(e, "otherLabel", "another column"))}. CommCare keeps one order rule for each value, so the list needs only that one.`,
	CASE_TILE_HIDDEN_CALCULATED_SORT: (e) => {
		if (det(e, "shape", "") === "case_id") {
			const recordId = standardCasePropertyDisplayLabel("case_id");
			return `${q(modName(e))}'s tile list can't order by ${recordId} unless ${recordId} is on the tile. You can show it in Results and place it on the tile.`;
		}
		return `${q(modName(e))}'s tile list can't order by a calculation that isn't on the tile. You can place that column on the tile, or order by a case property.`;
	},
	CASE_LIST_ID_MAPPING_KEY_CHARACTERS: (e) =>
		`${q(modName(e))} has a value label for ${q(det(e, "value", "a saved value"))}, and a saved value there can't hold &, <, >, " or '. You can change the value or remove its label.`,
	CASE_LIST_DATE_PATTERN_APOSTROPHE: (e) =>
		`A date style in ${q(modName(e))} holds a straight apostrophe ('), and CommCare HQ's date column has no way to store one. You can use a curved one (’).`,
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
	MULTI_SELECT_PERSISTENT_TILE: (e) =>
		`${q(modName(e))} lets people choose several cases, so its Results tile can't stay above a form. Turn off “Keep tile visible in forms.”`,
	MULTI_SELECT_NO_BATCH_CONSUMER: (e) =>
		`${q(modName(e))} is set to Several cases, but it has no follow-up or close form that can use the complete selection and no compatible child workflow can receive it. Add one of those forms, carry the same case selection into a child that has one, or switch Selection to One case.`,
	CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE: (e) =>
		`An image display in ${q(modName(e))} uses ${q(det(e, "value", "the same value"))} twice, so only the first image appears. Change or remove one of the rules.`,
	CASE_LIST_MULTI_SELECT_INPUT_NEEDS_DIRECT_MATCH: (e) =>
		`The search field ${q(det(e, "inputName", "in this module"))} lets people choose several values, so it needs to be named after the case information it searches on this case type. Rename it to match, or switch it to a single-choice field.`,
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
	CASE_LIST_SEARCH_INPUT_REQUIRED_CONDITION_TYPE_ERROR: (e) =>
		`The required condition for search field ${q(det(e, "inputName", "in this module"))} compares values that don't go together. Open it and adjust the comparison.`,
	CASE_LIST_SEARCH_INPUT_REQUIRED_CONDITION_CASE_DATA_UNAVAILABLE: (e) =>
		`The required condition for search field ${q(det(e, "inputName", "in this module"))} tries to read a case before one has been selected, so it can never hold. Compare other search answers, fixed values, or current-user information instead.`,
	CASE_LIST_SEARCH_INPUT_VALIDATION_RULE_TYPE_ERROR: (e) =>
		`The check on search field ${q(det(e, "inputName", "in this module"))} compares values that don't go together. Open it and adjust the comparison.`,
	CASE_LIST_SEARCH_INPUT_VALIDATION_RULE_CASE_DATA_UNAVAILABLE: (e) =>
		`The check on search field ${q(det(e, "inputName", "in this module"))} tries to read a case before one has been selected, so it can never pass. Compare other search answers, fixed values, or current-user information instead.`,
	CASE_LIST_SEARCH_INPUT_HIDDEN_VALUE_TYPE_ERROR: (e) =>
		`The hidden search value ${q(det(e, "inputName", "in this module"))} is built from values that don't go together. Open it and adjust the calculation.`,
	CASE_LIST_SEARCH_INPUT_HIDDEN_VALUE_CASE_DATA_UNAVAILABLE: (e) =>
		`The hidden search value ${q(det(e, "inputName", "in this module"))} tries to read a case before one has been selected, so it always comes back empty. Use the current time, today's date, a fixed value, or current-user information.`,
	CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_SCOPE: (e) =>
		`The row rule for search field ${q(det(e, "inputName", "in this module"))} reads something the Search screen can't see yet. Use columns from the data table, fixed values, or current-user information.`,
	CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_TYPE_ERROR: (e) =>
		`The row rule for search field ${q(det(e, "inputName", "in this module"))} compares values that don't go together. Open it and adjust the comparison.`,
	CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_NOT_ON_DEVICE: (e) =>
		`The row rule for search field ${q(det(e, "inputName", "in this module"))} uses a date calculation the device can't run. Use a whole date with seconds, minutes, hours, days, or weeks.`,
	CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME: (e) =>
		`Two search fields in ${q(modName(e))} use the same name for conditions, ${q(det(e, "inputName", ""))}. Rename one under More settings.`,
	CASE_LIST_SEARCH_INPUT_NAME_IS_DEFAULT_FILTER: (e) =>
		`The search field ${q(det(e, "inputName", "in this module"))} in ${q(modName(e))} has the name CommCare gives its own search filters, so it would never search a case. Rename it under More settings.`,
	CASE_LIST_SEARCH_INPUT_NAME_RESERVED: (e) =>
		`The search field ${q(det(e, "inputName", "in this module"))} in ${q(modName(e))} has a name CommCare reads as a search setting, so it would never search a case. Rename it under More settings.`,
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
		const subject = moduleWireSlotSubject(e);
		const repair =
			e.details?.surface === "filter"
				? "Use “Begins with” here instead, or move the matching rule into a custom search condition."
				: "Use “Begins with,” or choose another matching option.";
		return `${subject} uses a matching option that isn't available here. ${repair}`;
	},
	CASE_LIST_DATE_ADD_NOT_ON_DEVICE: (e) => {
		const subject = moduleWireSlotSubject(e);
		switch (e.details?.reason) {
			case "datetime-base":
				return `${subject} uses a date and time in a calculation that only supports whole dates here, so the time would be lost. Use a date without a time or rewrite the calculation.`;
			default:
				return `${subject} adds ${det(e, "interval", "a calendar interval")}, but month and year calculations aren't available here. Use seconds, minutes, hours, days, or weeks. To use months or years, put the comparison directly in a search condition.`;
		}
	},
	CASE_LIST_EXPRESSION_NOT_ON_DEVICE: (e) => {
		const subject = moduleWireSlotSubject(e);
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
		const subject = moduleWireSlotSubject(e);
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
			case "system-datetime-value": {
				const label = standardCasePropertyDisplayLabel(
					det(e, "property", "date_opened"),
				);
				return e.details?.shape === "is-blank"
					? `CommCare's search can't ask whether ${q(label)} is blank. Every case has one. Remove that check from ${lowerFirst(subject)}.`
					: `${q(label)} is compared with a date and time. Give it a date and time in ${lowerFirst(subject)}, or remove that check.`;
			}
			default:
				return `${subject} uses a condition that isn't available here. Choose one piece of case information to search, then compare it with a fixed value or a search answer.`;
		}
	},
	FIELD_KIND_PROPERTY_TYPE_MISMATCH: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} saves to ${q(det(e, "property", "a case property"))}, but its type doesn't match how that property is set up. Change the field's type, or save it somewhere else.`,
	FIELD_KIND_WRITERS_DISAGREE: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} saves to ${q(det(e, "property", "a case property"))} in a different format than the other fields that use it. Change this one to match them, or save it somewhere else.`,
	HIDDEN_VALUE_WRITER_TYPE_MISMATCH: (e) => {
		const field = q(fieldName(e));
		const property = q(det(e, "property", "a case property"));
		const value = valuesPhrase(e.details?.valueTypes, e.details?.valueType);
		const source =
			e.location.field === "default_value"
				? "its starting value"
				: "its calculation";
		switch (e.details?.reason) {
			case "clock-lost":
				return `${field} saves to ${property}, which holds dates and times, but its value keeps only the day because ${q(det(e, "clockSource", "an earlier hidden value"))} doesn't keep the time. You can save it from a question or now() instead.`;
			case "hidden-disagreement":
				return e.details?.disagreement === "own"
					? `${field} saves ${value} to ${property} from different results, so the property has no one kind of value. You can have every result of ${source} give the same kind.`
					: `${field} saves ${value} to ${property}, but other hidden values save a different kind of value there. You can have them all give the same kind, or save this one somewhere else.`;
			default: {
				const wanted = e.details?.propertyType;
				const consequence =
					e.details?.consequence === "stops-form"
						? " A form that fills a question from it would stop when it opens."
						: e.details?.consequence === "wrong-kind"
							? " Forms and case lists that read it would get the wrong kind of value."
							: "";
				return `${field} saves ${value} to ${property}, which holds ${heldValuesPhrase(wanted)}.${consequence} You can change ${source} to give ${wanted === undefined ? "the same kind" : oneValuePhrase(wanted)}, or save it somewhere else.`;
			}
		}
	},
	SELECT_PRELOAD_WRITE_NOT_AN_OPTION: (e) => {
		const writer =
			e.location.fieldId !== undefined
				? q(fieldName(e))
				: e.details?.operationId !== undefined
					? `The case operation ${q(e.details.operationId)}`
					: "A value";
		const value = q(det(e, "value", "this value"));
		return `${writer} saves ${value} to ${q(det(e, "property", "a case property"))}, which ${q(det(e, "readerField", "a choice question"))} in ${q(det(e, "readerForm", "another form"))} starts on, but ${value} isn't one of its choices. You can save one of its choices instead, or save it somewhere else.`;
	},

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
	SEARCH_FIRST_REQUIRES_CASE_FIRST_MODULE: (e) =>
		`${q(modName(e))} is set to open on Search, but its first screen isn't a case selection. Give it a case type and keep only forms that work on an existing case, or turn Search first off.`,
	SEARCH_FIRST_NO_BUTTON_DISPLAY_CONDITION: (e) =>
		`${q(modName(e))} opens on Search, so there's no Search button for its button condition to control. Clear the condition, or turn Search first off.`,
	SEARCH_FIRST_UNIQUE_INSTANCE: (e) =>
		`${q(modName(e))} shares its search results with a module that opens on Search, and CommCare can't tell the two apart. Keep a search-first module without submenus, and don't select a parent case from one.`,
	SEARCH_NO_MATCHES_DUPLICATE: (e) =>
		`${q(modName(e))} has more than one form set to open when a search finds nothing, and Results can offer only one. Keep one and change the others back to menu forms.`,
	SEARCH_NO_MATCHES_ENTRY_REQUIRES_SEARCH_FIRST: (e) =>
		`${q(formName(e))} opens when a search finds nothing, but ${q(modName(e))} doesn't open on Search. Turn Search first on for the module, or make this a menu form again.`,
	SEARCH_NO_MATCHES_ENTRY_NOT_REGISTRATION: (e) =>
		`${q(formName(e))} opens when a search finds nothing, so it needs to register a new case. Make it a registration form, or make it a menu form again.`,
	SEARCH_NO_MATCHES_ENTRY_HAS_NAVIGATION: (e) =>
		`${q(formName(e))} opens when a search finds nothing. It can return to Results or First menu, but can't have after-submit links, a display condition, or be taken off the menu. Clear those settings, or make it a menu form again.`,
	SEARCH_NO_MATCHES_ENTRY_MULTIPLE_RETURN: (e) =>
		`${q(formName(e))} registers one case, but ${q(modName(e))} selects several. Choose First menu after submit, or change the module to one-case selection.`,
	CASE_SEARCH_RELATED_CALCULATION_UNREPRESENTABLE: (e) =>
		`In ${q(modName(e))}, ${q(det(e, "columnHeader", "Calculated value"))} uses related-case information that Search can't show consistently. Show one parent property by itself, build the calculation from the current case, or delete this calculated item.`,

	// ── Form-level ───────────────────────────────────────────────────
	EMPTY_FORM: (e) =>
		e.details?.problem === "no_question"
			? `${q(formName(e))} has sections or groups and no question in them yet. Add a question, a label or a hidden value.`
			: `${q(formName(e))} doesn't have any fields yet. Add at least one.`,
	FORM_SECTION_NOT_TOP_LEVEL: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is a section sitting inside ${sectionParentPhrase(e)}. A section is a page of the form, so it belongs at the top level. Move it out.`,
	FORM_SECTIONS_INCOMPLETE: (e) =>
		`${q(formName(e))} is split into sections, but ${looseFieldsPhrase(e)} outside every section. Once a form has sections, every field belongs inside one. Add ${det(e, "looseCount", "") === "1" ? "it" : "them"} to a section, or remove the sections to go back to a single page.`,
	FORM_SECTION_USER_REPEAT: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} lets people add entries, but it sits inside section ${q(det(e, "sectionTitle", det(e, "sectionId", "")))}, and a section shows on one screen where entries can't be added. Move the repeat out of the sections, or give it a fixed count.`,
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
	POST_SUBMIT_NOT_OFFERED: (e) => postSubmitNotOfferedSentence(e),
	FORM_LINK_EMPTY: (e) =>
		`${q(formName(e))} has after-submit links turned on but none added. Add a link, or turn the setting off.`,
	FORM_LINK_NO_FALLBACK: (e) =>
		`${q(formName(e))}'s after-submit links all have conditions, so it needs an otherwise. Choose where people go when none of them match, or add a link without a condition at the end.`,
	FORM_LINK_TARGET_NOT_FOUND: (e) =>
		`An after-submit link in ${q(formName(e))} points to a form or module that's gone. Point it somewhere else, or remove it.`,
	FORM_LINK_TARGET_NO_MATCHES_FORM: (e) =>
		`An after-submit link in ${q(formName(e))} points to a form that only opens when a search finds nothing. Point it at the module instead, or remove it.`,
	FORM_LINK_SELF_REFERENCE: (e) =>
		`An after-submit link in ${q(formName(e))} points back to the same form. Send it somewhere else.`,
	FORM_LINK_UNREACHABLE: (e) =>
		`In ${q(formName(e))}, ${formLinkPhrase(e)} can never be used: an earlier link has no condition, so it always wins. Move this link above it, or give that link a condition.`,
	FORM_LINK_DATUMS_INCOMPLETE: (e) =>
		`In ${q(formName(e))}, ${formLinkPhrase(e)} can't hand over the case that form needs. Choose a destination this form can pass its case to, or set the value to carry by hand.`,
	FORM_LINK_SEARCH_CASE_UNREPRESENTABLE: (e) =>
		`In ${q(formName(e))}, ${formLinkPhrase(e)} assigns a different case to a destination that opens on Search. You can remove the manual assignment so Nova can match the case automatically, or choose a destination that opens on its case list.`,
	FORM_LINK_DATUM_UNUSED: (e) =>
		`In ${q(formName(e))}, ${formLinkPhrase(e)} carries a case its destination no longer asks for. Remove that value, or choose a destination that needs it.`,
	FORM_LINK_DATUM_TARGET_COLLISION: (e) =>
		`In ${q(formName(e))}, ${formLinkPhrase(e)} carries more than one value for the same selected case. You can keep one carried value for that case.`,
	FORM_LINK_SELECTION_CARDINALITY: (e) =>
		`${q(formName(e))} can't carry its complete case selection straight into that form. Send people to the destination's form list so they can choose again, or give both forms the same case selection and limit.`,
	FORM_LINK_SELECTION_CASE_TYPE_CHANGED: (e) =>
		`A Case change in ${q(formName(e))} can change the selected cases to another type before the next form opens. Send people to the destination's form list so they can choose matching cases, or keep every selected case as ${q(det(e, "expectedCaseType", "the destination's case type"))}.`,
	CONNECT_ID_TOO_LONG: (e) =>
		`The Connect ID ${q(det(e, "connectId", ""))} in ${q(formName(e))} is too long. Keep it to 50 characters or fewer.`,
	CONNECT_ID_INVALID_FORMAT: (e) => {
		const id = det(e, "connectId", "");
		const sentence = questionIdSentence(e, id, "connect");
		return sentence === undefined
			? `The Connect ID ${q(id)} in ${q(formName(e))} won't work. Use letters, numbers, and underscores, starting with a letter.`
			: `The Connect ID ${q(id)} in ${q(formName(e))} needs a change. ${sentence}`;
	},
	CONNECT_DELIVER_FORM_HOLDS_TASK: (e) =>
		`${q(formName(e))} holds both a deliver unit and a task. CommCare Connect checks the delivery before it completes the task, so it turns away the visit in this form while the task is assigned. A task goes in a form of its own.`,
	SESSION_DATUM_NOT_SUPPLIED: (e) => {
		const subject =
			e.location.fieldUuid !== undefined
				? q(fieldName(e))
				: det(e, "carrier", "") === "form-link"
					? `A link from ${q(formName(e))}`
					: `A Connect setting of ${q(formName(e))}`;
		const form = q(formName(e));
		const alternative =
			det(e, "carrier", "") === "form-link"
				? "a case property or the worker's own record"
				: "a question or a case property";
		if (det(e, "reason", "") === "target-not-requested")
			return `${subject} carries a selected record the destination no longer asks for. You can remove that carried value or choose another destination.`;
		switch (det(e, "datumKind", "")) {
			case "selected-case":
				return `${subject} reads the case chosen in ${q(det(e, "datumModuleName", "that menu"))}, but ${form} no longer opens with that choice, so CommCare can't open the form. You can choose the case before this form, or read ${alternative} instead.`;
			case "new-case":
				return `${subject} reads the id of the case ${form} registers, but the form no longer registers one. You can read ${alternative} instead.`;
			case "new-child-case":
				return `${subject} reads the id of a new ${det(e, "datumCaseType", "child")} case, but this form no longer creates one shared case outside a repeat. You can read ${alternative} instead.`;
			case "worker-record":
				return `${subject} reads the id of the worker's own record, but ${form} no longer saves to it. You can read #user/ values instead.`;
			case "tile-group-parents":
				return `${subject} reads the grouped cases' connections, but the case list no longer groups its tiles. You can group the tiles again, or read a case property instead.`;
			default:
				return `${subject} reads a session value this form no longer opens with. You can read ${alternative} instead.`;
		}
	},
	CASE_PROPERTY_NAME_FORM_BUILDER_CANNOT_KEEP: (e) => {
		const property = det(e, "property", "that property");
		const operationId = e.details?.operationId;
		const writer =
			e.location.fieldId !== undefined
				? q(fieldName(e))
				: typeof operationId === "string" && operationId.length > 0
					? `The case change ${q(operationId)}`
					: "A case change";
		return `${writer} in ${q(formName(e))} saves the case property ${q(property)}. ${sourceWritePropertySentence(
			property,
			e.details?.problem === "closes_case"
				? "closes_case"
				: "stops_form_builder",
		)}`;
	},
	FIELD_ID_NAMES_CONNECT_BLOCK: (e) => {
		const suggestedId = e.details?.suggestedId;
		const offer =
			typeof suggestedId === "string" && suggestedId.length > 0
				? ` ${q(suggestedId)} is free for the field.`
				: "";
		return `${q(fieldName(e))} and a CommCare Connect block of ${q(formName(e))} share one name, so the form would hold two items CommCare can't tell apart. You can rename the field, or give the block another ID.${offer}`;
	},
	DUPLICATE_FIELD_ID: (e) =>
		`${q(formName(e))} has two fields with the same ID at the same level. Rename one of them.`,
	CASE_PROPERTY_BAD_FORMAT: (e) =>
		`${q(formName(e))} saves to ${q(det(e, "property", "a case property"))}, which isn't a valid name. Use letters, numbers, underscores, or hyphens, starting with a letter.`,
	CASE_PROPERTY_TOO_LONG: (e) =>
		`${q(formName(e))} saves to a name that's way too long. Give it a shorter one.`,
	CASE_OPERATION_DUPLICATE_UUID: () =>
		"Two case operations have the same identity. Remove one and add it again.",
	CASE_OPERATION_INVALID_ID: (e) =>
		caseOperationNameFindingSentence(e, e.details?.operationId) ??
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
		if (e.details?.reason === "clock-lost") {
			return "A value in this case operation keeps only the day of a date and time, so saving it here would record midnight instead of the moment. You can save it from a question or now() instead.";
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
	MULTI_SELECT_SHARED_CASE_EXPRESSION: (e) =>
		`A setting in ${q(formName(e))} reads one selected case, but this form handles several cases together. Remove that case reference, or use it inside a Case change whose “Which case” is “The case this form opened.”`,
	MULTI_SELECT_APP_OPERATION_CASE_READ: (e) =>
		`A Case change in ${q(formName(e))} runs once for the form but reads one selected case. Set its “Which case” to “The case this form opened,” or remove that case reference.`,
	MULTI_SELECT_AUTHORED_KEY_CREATE: (e) =>
		`The Case change ${q(det(e, "operationId", "that creates a case"))} uses one form answer as the identity for every new case. Under Identity, choose “A distinct case each time.”`,
	MULTI_SELECT_SESSION_OPERATION_LINK: (e) =>
		`A connection in the Case change ${q(det(e, "operationId", "in this form"))} points to “The case this form opened,” but that means several cases here. Choose a case made earlier in the form or a case found by a calculation.`,
	MULTI_SELECT_FANOUT_CHILD_DATUM: (e) =>
		`${q(formName(e))} creates a separate child case for each selected case, so an after-submit link can't carry or read one child case for the whole selection. Link to the destination module so the next case can be chosen there, or remove the child-case reference from the link.`,
	MULTI_SELECT_OPERATION_ORDER: (e) =>
		`In ${q(formName(e))}, a Case change that runs once comes after a change that runs for each selected case. Move every once-per-form change above the selected-case changes.`,
	CASE_OPERATION_LINK_INVALID: (e) =>
		caseOperationNameFindingSentence(e, e.details?.linkIdentifier) ??
		"A case link in this operation isn't valid. Review its name and target.",
	CASE_OPERATION_RETYPE_UNSAFE: () =>
		"Changing this case's type would leave required information missing. Add those values or choose another case type.",
	CASE_HASHTAG_ON_CREATE_FORM: (e) =>
		`${q(formName(e))} creates a new case but reads from one that doesn't exist yet (${det(e, "hashtag", "a case reference")}). Point it at a form question instead.`,
	PRIMARY_CASE_FIELD_IN_REPEAT: (e) => {
		const f = det(e, "fieldId", "a field");
		return `In ${q(formName(e))}, ${q(f)} is inside a repeating section but saves to the form's main case, which a repeat can't do. Move it out of the repeat, or save it to a child case instead.`;
	},
	USERCASE_WRITE_UNDECLARED_PROPERTY: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} saves to ${q(det(e, "property", "a worker detail"))} on the worker's own record, but no worker detail by that name exists. Add it under Worker information in App setup, or pick one that's already there.`,
	USERCASE_WRITE_MANAGED_PROPERTY: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} saves to ${q(det(e, "property", "a worker detail"))} on the worker's own record, which Nova keeps in step with the worker's profile, so an answer there would be replaced the next time that worker changes. Save to a worker detail you added under Worker information instead.`,
	USERCASE_FIELD_IN_REPEAT: (e) =>
		`In ${q(formName(e))}, ${q(det(e, "fieldId", "a field"))} is inside a repeating section but saves to the worker's own record, which holds one answer rather than one per repeat. Move it out of the repeat.`,

	// ── Field-level ──────────────────────────────────────────────────
	SELECT_DEFAULT_NOT_AN_OPTION: (e) =>
		`The starting value for ${q(fieldName(e))} is not one of its choices. Choose an available answer or clear the starting value.`,
	SELECT_NO_OPTIONS: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is a multiple-choice field with no choices yet. Add at least one.`,
	SELECT_TOO_FEW_OPTIONS: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is a multiple-choice field with only one choice. Add another so there's something to pick between.`,
	SELECT_OPTION_VALUE_INVALID: (e) =>
		`A choice on ${q(fieldName(e))} in ${q(formName(e))} ${optionValueProblemPhrase(e)}. A choice's value is the answer the app saves, so it can't hold spaces or quote marks and can't be empty. Use ${q(det(e, "suggestedValue", "a_value_like_this"))} and keep the wording in the label.`,
	SELECT_OPTION_VALUE_DUPLICATE: (e) =>
		`Two choices of ${q(fieldName(e))} in ${q(formName(e))} both store ${q(det(e, "optionValue", ""))}, so a saved answer can't say which was chosen. ${q(det(e, "suggestedValue", "a_new_value"))} is free for the second.`,
	SELECT_OPTION_LABEL_EMPTY: (e) =>
		`${e.details?.optionPosition ? `Choice ${e.details.optionPosition}` : "A choice"} on ${q(fieldName(e))} in ${q(formName(e))} has no label in any language and no image, audio or video, so workers would see an empty choice. Give it a label, or attach media to it.`,
	CASE_WRITE_UNKNOWN_TYPE: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} saves to the ${q(det(e, "caseType", "case type"))} case type, but no case type by that name exists. Add that case type, or point the field at one that does.`,
	HIDDEN_VALUE_BOTH_SOURCES: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} has both a calculated value and a default. A hidden value takes a calculation or a starting value, and Nova doesn't yet write both on one field. Remove the default, or drop the calculation if you wanted a fixed value.`,
	REQUIRED_ON_HIDDEN: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} is hidden, so it can't be required, no one can fill it in. Turn off required, or make the field visible.`,
	CALCULATE_ON_VISIBLE_INPUT: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} has a calculated value, but only hidden fields can. On a visible field, whatever someone types gets ignored. Move it to a hidden field, or drop the calculation.`,
	VALIDATION_ON_NON_INPUT_KIND: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} can't have a validation rule, only fields people answer can. Remove it, or change the field's type.`,
	REPEAT_COUNT_TYPE: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} needs an integer question for its count. Choose an integer question, or use an explicit numeric expression such as int(number(...)).`,
	EMPTY_REPEAT_COUNT: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} repeats a set number of times, but you haven't said how many. Set the count.`,
	EMPTY_IDS_QUERY: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} repeats over a list of records, but none is chosen yet. Pick the records it should repeat over.`,
	INVALID_FIELD_ID: (e) => {
		const sentence = questionIdSentence(e, fieldName(e), "question");
		return sentence === undefined
			? `${q(fieldName(e))} in ${q(formName(e))} has an ID that won't work. Use letters, numbers, and underscores, starting with a letter.`
			: `${q(fieldName(e))} in ${q(formName(e))} needs another ID. ${sentence}`;
	},
	LOOKUP_SELECT_FILTER_TERM_NOT_ALLOWED: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} filters lookup choices with information that isn't available while choices are being built. Use lookup columns, fixed values, current-user/session values, or an eligible earlier answer.`,
	LOOKUP_SELECT_FILTER_FIELD_NOT_EARLIER: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} filters its choices using an answer that comes later in the form. Move the source question earlier or remove that dependency.`,
	LOOKUP_SELECT_FILTER_FIELD_REPEAT_SCOPE: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} filters its choices using a repeated answer from a different repetition context. Use a root answer or an earlier answer from the current or an enclosing repeat.`,
	CASE_SELECT_SOURCE_INVALID: (e) =>
		`${q(fieldName(e))} needs a record type and label property that are available in this app. You can choose them in the choice source settings.`,
	CASE_SELECT_FILTER_INVALID: (e) =>
		`${q(fieldName(e))} uses information that isn't available in its choice filter. You can use candidate records, the selected record, worker information, and earlier answers in the same form and repeat.`,
	CASE_SELECT_FILTER_NOT_ON_DEVICE: (e) =>
		`${q(fieldName(e))} uses a choice filter that can't run on a device. You can choose another comparison or calculation.`,
	LOOKUP_SELECT_FILTER_TYPE_ERROR: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} has a lookup-choice filter whose values don't fit the comparison. Adjust the referenced columns, values, or operator.`,
	LOOKUP_SELECT_FILTER_NOT_ON_DEVICE: (e) =>
		e.details?.reason === "datetime-base"
			? `${q(fieldName(e))} in ${q(formName(e))} filters its choices with a date and time calculation, but the time would be lost here. Use a whole date or choose another calculation.`
			: `${q(fieldName(e))} in ${q(formName(e))} filters its choices with a month or year calculation that isn't available here. Use seconds, minutes, hours, days, or weeks.`,

	// ── XPath / formula deep validation ──────────────────────────────
	INVALID_REF: (e) => {
		if (e.details?.identity === "choice")
			return `A formula on ${q(fieldName(e))} in ${q(formName(e))} uses a choice that ${q(det(e, "choiceFieldName", "that question"))} no longer has. You can choose one of its current choices.`;
		if (e.details?.ref !== "/data")
			return `A formula on ${q(fieldName(e))} in ${q(formName(e))} points to a field that isn't here. Check for a typo, or a field that was renamed or removed.`;
		/* A Connect setting's formula belongs to the form, not a field. */
		return e.location.fieldId === undefined
			? `A CommCare Connect setting of ${q(formName(e))} reads the whole form, not a question. You can point it at a question, a group or a repeat instead.`
			: `A formula on ${q(fieldName(e))} in ${q(formName(e))} reads the whole form, not a question. You can point it at a question, a group or a repeat instead.`;
	},
	INVALID_CASE_REF: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} reads a case value this form can't get to. Check the spelling, or make sure a field actually saves it.`,
	INVALID_SEARCH_REF: (e) =>
		`${q(fieldName(e))} in ${q(formName(e))} reads a search answer this form can't get to. Only a form that opens after a search finds no matches can read its module's Search prompts.`,
	PROSE_EDITOR_ROUND_TRIP_LOSS: (e) =>
		`The text on ${q(fieldName(e))} in ${q(formName(e))} contains something the editor can't safely preserve. Re-enter its text and references.`,
	CYCLE: (e) => {
		/* A loop closed by a group's or repeat's display condition has no
		 * reference to remove on one of its edges, so that shape is named by
		 * its containment (the runner stamps the container and descendant);
		 * every other loop is one of references. `loop` is the runner's
		 * step-by-step reading of the cycle, with the form root trimmed. */
		const container = e.details?.container;
		const loop = det(e, "loop", "").replaceAll("/data/", "");
		if (container !== undefined) {
			const kind = det(e, "containerKind", "group");
			const inside = q(pathLeaf(det(e, "descendant", "a field")));
			return `In ${q(formName(e))}, whether the ${kind} ${q(pathLeaf(container))} shows depends, through a chain of references, on ${inside}, which sits inside it, so the ${kind} would control a value it depends on and nothing can settle. ${loop} Move ${inside} out of the ${kind}, or change one of those references so nothing inside the ${kind} feeds its display condition.`;
		}
		return `Some field formulas or lookup choices in ${q(formName(e))} depend on each other in a loop, so their values can't settle. ${loop} Remove one of the references to break it.`;
	},
	TYPE_ERROR: (e) =>
		e.details?.reason === "datetime-literal-precision"
			? `${formulaSubject(e)} has a time finer than a millisecond, and CommCare compares times to the millisecond. You can choose a time to the millisecond, second or minute.`
			: `A formula on ${q(fieldName(e))} in ${q(formName(e))} uses text where it needs a number, so the result might come out wrong. Check the values it's working with.`,
	XPATH_INCOMPATIBLE_VALUES: (e) => {
		switch (e.details?.reason) {
			case "date-datetime":
				return `${formulaSubject(e)} compares a date with a date and time. You can wrap the date and time in date() to compare days.`;
			case "datetime-ordering":
				return `${formulaSubject(e)} orders a date and time against something that isn't one. You can compare it with another date and time, or wrap it in date() to compare days.`;
			case "boolean":
				return `${formulaSubject(e)} compares a true-or-false result with another kind of value, and CommCare counts anything that isn't blank or zero as true. You can compare the two values themselves, or use the true-or-false result on its own.`;
			default:
				return `${formulaSubject(e)} compares two kinds of information that don't line up. You can compare it with a value of the same kind instead.`;
		}
	},
	XPATH_MANY_VALUES: (e) =>
		e.details?.reason === "selected-cases"
			? `${formulaSubject(e)} reads every case chosen in ${q(det(e, "menuName", "its menu"))} where it needs one value. You can count or join them.`
			: e.details?.prose === "true"
				? `The text of ${q(fieldName(e))} in ${q(formName(e))} shows an answer from every entry of ${e.details?.repeatId === undefined ? "a repeat" : `the repeat ${q(e.details.repeatId)}`}, where it can show only one. You can move the question into the repeat, or show a hidden value that counts or joins the entries.`
				: `${formulaSubject(e)} reads an answer from every entry of ${e.details?.repeatId === undefined ? "a repeat" : `the repeat ${q(e.details.repeatId)}`} where it needs one value. You can count or join the entries, or read just one of them.`,
	XPATH_TIME_ORDERING: (e) => {
		const where =
			e.location.formName === undefined
				? `The ${det(e, "slot", "condition")} rule of ${q(det(e, "property", "a case property"))}`
				: e.location.fieldId === undefined
					? `A formula in ${q(formName(e))}`
					: `A formula on ${q(fieldName(e))} in ${q(formName(e))}`;
		return `${where} compares a time of day with before or after. CommCare compares these as numbers and a time is not one, so it would never be true. Compare a date instead, or check a time with equals.`;
	},

	// ── Lookup references ────────────────────────────────────────────
	LOOKUP_CONTEXT_UNAVAILABLE: () =>
		"Lookup data hasn't finished reconnecting yet. Wait a moment, then try that change again.",
	LOOKUP_TABLE_NOT_AVAILABLE: () =>
		"This setting uses a lookup table that isn't available in this Project. Choose an available table, or clear the setting.",
	LOOKUP_TAG_RESERVED_BY_RUNTIME: (e) =>
		e.details?.reservedWord !== undefined
			? `The export tag for ${q(det(e, "tableName", "this data table"))} contains ${e.details.reservedWord}, which CommCare reads as its own data. You can rename the export tag in Project data, then try again.`
			: `The export tag for ${q(det(e, "tableName", "this data table"))} is reserved by CommCare. You can rename the export tag in Project data, then try again.`,
	LOOKUP_COLUMN_NOT_AVAILABLE: () =>
		"This setting uses a lookup column that isn't available anymore. Choose another column, or clear the setting.",
	LOOKUP_COLUMN_TYPE_MISMATCH: (e) =>
		`This setting needs ${det(e, "acceptedColumnTypes", "a different kind of")} data, but the selected lookup column contains ${det(e, "actualColumnType", "incompatible")} data. Choose a compatible column.`,
	LOOKUP_CELL_TEXT_CHANGED_BY_HQ: (e) =>
		`The ${q(det(e, "columnLabel", "affected"))} column in ${q(det(e, "tableName", "this data table"))} has leading or trailing whitespace that CommCare HQ would remove. You can remove that whitespace in Project data.`,
	LOOKUP_CELL_TEXT_UNREPRESENTABLE: (e) =>
		`The ${q(det(e, "columnLabel", "affected"))} column in ${q(det(e, "tableName", "the data table"))} contains characters Nova can't preserve. You can remove them or retype the affected values in Project data.`,
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
	LOOKUP_HQ_PUSH_TOO_LARGE: () =>
		"This app references more lookup data than CommCare HQ accepts in one upload. Shrink or split the largest lookup tables and try again.",
	HQ_NESTED_SELECTION_UNREPRESENTABLE: (e) => {
		const named = (key: string, fallback: string) => {
			const name = det(e, key, "");
			return name ? q(name) : fallback;
		};
		const parent = named("sourceModuleName", "the parent menu");
		const child = named("targetModuleName", "this menu");
		const keeps =
			"Preview keeps this selection, and so does a CCZ for a project space the app is already published to.";
		if (det(e, "reason", "") === "smaller-child-maximum") {
			const sourceMaximum = det(e, "sourceMaximum", "the parent's limit");
			return `CommCare HQ can't yet keep the limit of ${det(e, "targetMaximum", "fewer")} selected cases in ${child} under ${parent}, which selects up to ${sourceMaximum}. You can raise the limit in ${child} to ${sourceMaximum} or more. ${keeps}`;
		}
		return `CommCare HQ can't yet find the cases for ${child} from several cases selected in ${parent}. You can set ${parent} to select one case. ${keeps}`;
	},
	LOOKUP_TAG_RESERVED_BY_HQ: (e) =>
		`CommCare HQ keeps the name ${det(e, "tag", "types")} for its own list of the tables in an upload, so a table cannot be exported under it. Rename that table's export tag in Project data, then try again.`,

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
