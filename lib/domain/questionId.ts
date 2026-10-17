// lib/domain/questionId.ts
//
// The one grammar for a question ID, and the names a form's source can never
// hold. Every surface reads it: the validator (`INVALID_FIELD_ID`, the
// Connect id rules, the case-operation id and link rules), the builder and
// tool verdicts in `lib/doc/identifierVerdicts.ts`, and the Connect id
// minter.
//
// What binds is HQ's form builder, which a person can open any Nova form in:
// Vellum reports an error on a question ID that does not match
// `/^(?!XML)[a-zA-Z][\w-]*$/` (case-sensitive `XML`) or is `meta` in any case
// (Vellum `src/util.js::isValidElementName`, `src/mugs/baseSpecs.js`
// `databind.nodeID.validationFunc`), and warns on `case`, `registration` and
// `script` in any case (`src/mugs/baseSpecs.js::RESERVED_NAMES`). Nova keeps
// refusing the hyphen Vellum accepts, a rule of its own. HQ's build removes a
// root node named `meta` (`xform.py::XForm.already_has_meta`), and a root
// `case` in a form with basic case actions is read as the form's own case
// block (`xform.py::XForm.case_node`). Vellum finds `instance`, `bind` and
// `parsererror` by bare element name at any depth (`src/parser.js`, and
// jQuery's `parseXML`, which takes any `parsererror` element for its own parse
// failure), so a form holding an element of one of those names never opens.
//
// A Save to Case block is read by name too: Vellum's
// `src/saveToCase.js::parseDataNode` searches the block's `<case>` for
// `create` and `close` at any depth, so a property or connection of either
// name reads as the block starting or closing its case.
//
// CommCare Connect's receiver searches a submission at every depth for the
// five names of `RESERVED_CONNECT_BLOCK_IDS` (commcare-connect
// `form_receiver/processor.py::_get_matching_blocks`) and reads each match's
// namespace, which a Nova wrapper of that name has none of, so it answers 500.

import { type FreeNameOffer, freeNameClause, suffixUntilFree } from "./idSlug";

/** A letter first, then letters, digits or underscores, never `XML` first. */
export const QUESTION_ID_PATTERN = /^(?!XML)[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Names refused by one rule: `anyCase` compared lowercased, as Vellum
 * compares them, and `exact` compared as written.
 */
export interface ReservedNames {
	readonly anyCase: ReadonlySet<string>;
	readonly exact: ReadonlySet<string>;
}

/**
 * The names no question, group, repeat, section or Connect block may take.
 * The pins are kept by the controls `targeted-reserved-node-names` and
 * `targeted-parsererror-node-name` (the three names HQ's form builder can't
 * open a form with) and `targeted-reserved-question-names` (the names its
 * editors warn about, and `case` at a form's root): removing one is a
 * reviewed change.
 */
export const RESERVED_QUESTION_IDS: ReservedNames = {
	anyCase: new Set(["meta", "case", "registration", "script"]),
	exact: new Set(["instance", "bind", "parsererror"]),
};

/** The names CommCare Connect's receiver keeps for itself, exact. */
export const RESERVED_CONNECT_BLOCK_IDS: ReservedNames = {
	anyCase: new Set(),
	exact: new Set([
		"assessment",
		"deliver",
		"module",
		"task",
		"work_area_update",
	]),
};

/** True when `id` is one of `names`. */
export function isReservedName(id: string, names: ReservedNames): boolean {
	return names.exact.has(id) || names.anyCase.has(id.toLowerCase());
}

export type QuestionIdProblem =
	| "leading-underscore"
	| "not-letter-first"
	| "characters"
	| "xml-prefix"
	| "reserved-name";

/**
 * Why `id` can't be a question ID, the first that applies in this order, or
 * `undefined` when it can. `alsoReserved` adds names one kind of ID refuses
 * beside the question names (a Connect block's).
 */
export function questionIdProblem(
	id: string,
	alsoReserved?: ReservedNames,
): QuestionIdProblem | undefined {
	if (id.startsWith("_")) return "leading-underscore";
	if (!/^[A-Za-z]/.test(id)) return "not-letter-first";
	if (!/^[A-Za-z0-9_]*$/.test(id)) return "characters";
	if (id.startsWith("XML")) return "xml-prefix";
	if (
		isReservedName(id, RESERVED_QUESTION_IDS) ||
		(alsoReserved !== undefined && isReservedName(id, alsoReserved))
	)
		return "reserved-name";
	return undefined;
}

/**
 * The one normalizer every minter and every refusal's offered replacement
 * use. Its result always passes `questionIdProblem`
 * with the same `alsoReserved`: `_notes` → `notes`, `_1st` → `q1st`,
 * `XMLcode` → `qXMLcode`, `Meta` → `q_Meta`, `first name` → `first_name`.
 * The caller settles a collision with `suffixUntilFree`.
 */
export function editorSafeQuestionId(
	id: string,
	alsoReserved?: ReservedNames,
): string {
	let safe = id.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+/, "");
	if (!/^[A-Za-z]/.test(safe) || safe.startsWith("XML")) safe = `q${safe}`;
	if (
		isReservedName(safe, RESERVED_QUESTION_IDS) ||
		(alsoReserved !== undefined && isReservedName(safe, alsoReserved))
	)
		safe = `q_${safe}`;
	return safe;
}

/** The replacement a refusal offers: editor-safe and free among `taken`. */
export function freeQuestionId(
	id: string,
	taken: ReadonlySet<string>,
	alsoReserved?: ReservedNames,
): string {
	return suffixUntilFree(editorSafeQuestionId(id, alsoReserved), taken);
}

/** Which kind of ID a sentence speaks of. */
export type QuestionIdNoun = "question" | "connect";

/**
 * The one sentence for each refusal of a question or Connect block ID,
 * which every surface says: the validator's finding after its location,
 * the builder and tool verdicts, and the builder's renderer.
 */
export function questionIdProblemSentence(
	id: string,
	problem: QuestionIdProblem,
	freeId: string,
	noun: QuestionIdNoun = "question",
): string {
	const subject = noun === "connect" ? "A Connect ID" : "A question ID";
	const free = freeNameClause(freeId);
	switch (problem) {
		case "leading-underscore":
			return `${subject} can't start with an underscore, because CommCare HQ's form builder can't keep it. ${free}`;
		case "not-letter-first":
			return `${subject} starts with a letter, and CommCare HQ's form builder can't keep one that doesn't. ${free}`;
		case "characters":
			return `${subject} holds only letters, digits and underscores. ${free}`;
		case "xml-prefix":
			return `${subject} can't start with "XML", because CommCare HQ's form builder can't keep it. ${free}`;
		case "reserved-name":
			return `${reservedNameClause(id)} ${free}`;
	}
}

function reservedNameClause(id: string): string {
	const lower = id.toLowerCase();
	if (lower === "meta")
		return `"${id}" is a name CommCare keeps for the form's own details.`;
	if (lower === "case")
		return `"${id}" is a name CommCare keeps for a form's case data.`;
	if (RESERVED_QUESTION_IDS.anyCase.has(lower))
		return `"${id}" is a name CommCare HQ's form builder warns about.`;
	if (RESERVED_QUESTION_IDS.exact.has(id))
		return `"${id}" is a name CommCare HQ's form builder can't open a form with.`;
	return `"${id}" is a name CommCare Connect keeps for itself, and it can't receive a form whose block is called that.`;
}

// ── Names inside a form's Save to Case blocks ───────────────────────

/**
 * True for exactly the three names HQ's form builder can't open a form
 * holding: an element of one of them anywhere in the source stops it.
 */
export function stopsFormBuilder(name: string): boolean {
	return RESERVED_QUESTION_IDS.exact.has(name);
}

/** The case action HQ's form builder reads a Save to Case child name as. */
export type FormBuilderCaseAction = "close" | "create";

/**
 * The case action a property or connection named `name` reads as inside a
 * Save to Case block, or `undefined`. `update`, `index` and `attachment`
 * read as nothing that changes the block's action.
 */
export function formBuilderCaseAction(
	name: string,
): FormBuilderCaseAction | undefined {
	return name === "close" || name === "create" ? name : undefined;
}

/** Why HQ's form builder can't keep a property a Save to Case block writes. */
export type SourceWritePropertyProblem = "stops_form_builder" | "closes_case";

/**
 * Why a case property can't be written by a block in a form's source, or
 * `undefined`. `create` is never a writable property, so only `close` reads
 * as an action here. A property written only through a basic action is not
 * asked: HQ's build adds that block and the source never holds it.
 */
export function sourceWritePropertyProblem(
	property: string,
): SourceWritePropertyProblem | undefined {
	if (stopsFormBuilder(property)) return "stops_form_builder";
	if (formBuilderCaseAction(property) === "close") return "closes_case";
	return undefined;
}

/** The sentence for a property a Save to Case block can't write. */
export function sourceWritePropertySentence(
	property: string,
	problem: SourceWritePropertyProblem,
): string {
	return problem === "closes_case"
		? `CommCare HQ's form builder reads a property named "${property}" as closing the case, so editing this form there would close the case every time it's sent. Save it under another property name here.`
		: `CommCare HQ's form builder can't open a form that saves a property named "${property}" from a case change. Save it under another property name here.`;
}

/** Why a case operation id or a link identifier names a node it can't. */
export type CaseOperationNameProblem =
	| "stops_form_builder"
	| "reads_as_case_action";

/**
 * Why a case operation id can't be used beyond its format, or `undefined`.
 * An operation names its block's wrapper, above `<case>`, so only the three
 * names that stop the form builder apply.
 */
export function caseOperationIdNameProblem(
	id: string,
): CaseOperationNameProblem | undefined {
	return stopsFormBuilder(id) ? "stops_form_builder" : undefined;
}

/**
 * Why a link identifier can't be used beyond its format, or `undefined`. A
 * link names an element under the block's `<case>/<index>`, where the form
 * builder also reads `close` and `create` as the block's action.
 */
export function caseOperationLinkNameProblem(
	identifier: string,
): CaseOperationNameProblem | undefined {
	if (stopsFormBuilder(identifier)) return "stops_form_builder";
	if (formBuilderCaseAction(identifier) !== undefined)
		return "reads_as_case_action";
	return undefined;
}

/** The free name a case operation or link refusal offers. */
export function freeCaseOperationName(
	name: string,
	taken: ReadonlySet<string>,
): string {
	return suffixUntilFree(`q_${name}`, taken);
}

/** The sentence for an operation id or link identifier of a reserved name. */
export function caseOperationNameSentence(
	name: string,
	problem: CaseOperationNameProblem,
	freeName: string,
	offer: FreeNameOffer = "free-here",
): string {
	const free = freeNameClause(freeName, offer);
	if (problem === "stops_form_builder")
		return `"${name}" is a name CommCare HQ's form builder can't open a form with. ${free}`;
	return formBuilderCaseAction(name) === "create"
		? `"${name}" is a name CommCare HQ's form builder reads as starting a new case. ${free}`
		: `"${name}" is a name CommCare HQ's form builder reads as closing the case. ${free}`;
}
