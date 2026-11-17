/**
 * The lines a person reads for what changed between two documents, by
 * place: CommCare HQ's list counts the questions of a form that changed, and
 * Nova's list names each one, because it is the list of what a choice
 * removes and a count does not tell a person which of their edits go.
 *
 * Client-safe: the publish dialog, the Publishing card and MCP read one
 * text. Every line is returned; the number of lines is bounded by the size
 * of the app, not by the number of edits, so no line is cut.
 */

import type {
	AppPart,
	DocumentChanges,
	FormChange,
	FormPart,
	MenuChange,
	MenuPart,
	QuestionRef,
} from "@/lib/doc/documentChanges";
import { namesInWords } from "./planFeatures";

/** Which list the lines are for: CommCare HQ's counts questions, Nova's names them. */
export type DocumentChangeSide = "hq" | "nova";

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

function count(n: number): string {
	return COUNT_FORMAT.format(n);
}

const MENU_PART_WORDS: Readonly<Record<MenuPart, string>> = {
	name: "its name",
	"case-list": "its case list",
	"case-details": "its case details",
	search: "its search",
	settings: "its settings",
	note: "its note",
};

const FORM_PART_WORDS: Readonly<Record<FormPart, string>> = {
	name: "its name",
	menu: "its menu",
	settings: "its settings",
	"case-changes": "what it saves to cases",
	"after-submit": "where it goes after submit",
	note: "its note",
};

const APP_PART_LINES: Readonly<Record<AppPart, string>> = {
	name: "The app's name",
	languages: "The app's languages",
	settings: "The app's settings",
	logo: "The app's logo",
	"case-types": "The case types",
	"worker-properties": "Worker properties",
	roles: "Roles",
	personas: "Personas",
	organization: "The organization",
	automations: "Automations",
};

function menuPlace(name: string): string {
	return `The menu “${name}”`;
}

function formPlace(form: Pick<FormChange, "name" | "menuName">): string {
	return `The form “${form.name}” in the menu “${form.menuName}”`;
}

function quoted(questions: readonly QuestionRef[]): string {
	return namesInWords(questions.map((question) => `“${question.name}”`));
}

const QUESTION_VERBS = ["added", "removed", "changed", "moved"] as const;

/**
 * The question clauses of a form's line. The first carries the noun: "3
 * questions added, 1 removed" on CommCare HQ's side, "questions added:
 * “a” and “b”, removed: “c”" on Nova's.
 */
function questionClauses(
	questions: FormChange["questions"],
	side: DocumentChangeSide,
): string[] {
	const clauses: string[] = [];
	for (const verb of QUESTION_VERBS) {
		const listed = questions[verb];
		if (listed.length === 0) continue;
		const first = clauses.length === 0;
		const noun = listed.length === 1 ? "question" : "questions";
		if (side === "hq") {
			clauses.push(
				first
					? `${count(listed.length)} ${noun} ${verb}`
					: `${count(listed.length)} ${verb}`,
			);
		} else {
			clauses.push(
				first
					? `${noun} ${verb}: ${quoted(listed)}`
					: `${verb}: ${quoted(listed)}`,
			);
		}
	}
	return clauses;
}

function menuLines(menu: MenuChange): string[] {
	switch (menu.state) {
		case "added":
			return [`${menuPlace(menu.name)} was added`];
		case "removed":
			return [`${menuPlace(menu.name)} was removed`];
		case "changed": {
			const lines: string[] = [];
			if (menu.parts.length > 0)
				lines.push(
					`${menuPlace(menu.name)}: ${namesInWords(
						menu.parts.map((part) => MENU_PART_WORDS[part]),
					)} changed`,
				);
			if (menu.formsReordered)
				lines.push(`${menuPlace(menu.name)}: its forms are in a new order`);
			return lines;
		}
		default: {
			const unplaced: never = menu.state;
			return unplaced;
		}
	}
}

function formLine(form: FormChange, side: DocumentChangeSide): string {
	switch (form.state) {
		case "added":
			return `${formPlace(form)} was added`;
		case "removed":
			return `${formPlace(form)} was removed`;
		case "changed":
			return `${formPlace(form)}: ${[
				...questionClauses(form.questions, side),
				...form.parts.map((part) => FORM_PART_WORDS[part]),
			].join(", ")}`;
		default: {
			const unplaced: never = form.state;
			return unplaced;
		}
	}
}

function translationTextLine(n: number): string {
	return n === 1 ? "1 translation changed" : `${count(n)} translations changed`;
}

function translationReviewLine(n: number, side: DocumentChangeSide): string {
	if (side === "hq")
		return n === 1
			? "1 translation to review, because its source text changed in CommCare HQ"
			: `${count(n)} translations to review, because their source text changed in CommCare HQ`;
	return n === 1
		? "The review mark on 1 translation"
		: `Review marks on ${count(n)} translations`;
}

function mediaLine(n: number): string {
	return n === 1
		? "1 picture or sound changed"
		: `${count(n)} pictures or sounds changed`;
}

/**
 * Every line of a list of changes, in this order: the app's parts, the
 * menus' order, each menu and then each form that changed, the
 * translations, and last the pictures and sounds. Its length is
 * `changes.count`.
 */
export function documentChangeLines(
	changes: DocumentChanges,
	side: DocumentChangeSide,
): readonly string[] {
	const lines: string[] = changes.app.map((part) => APP_PART_LINES[part]);
	if (changes.menusReordered) lines.push("The menus are in a new order");
	for (const menu of changes.menus) lines.push(...menuLines(menu));
	for (const form of changes.forms) lines.push(formLine(form, side));
	if (changes.translations.text > 0)
		lines.push(translationTextLine(changes.translations.text));
	if (changes.translations.review > 0)
		lines.push(translationReviewLine(changes.translations.review, side));
	if (changes.mediaFiles > 0) lines.push(mediaLine(changes.mediaFiles));
	return lines;
}

/** The most names `madeByLine` lists before it counts the rest. */
const MADE_BY_NAMES = 3;

/**
 * Under Nova's heading, where someone other than the member reading made
 * some of its changes: "Some of these were made by {names}.", three names
 * at most and then "and {n} others".
 */
export function madeByLine(names: readonly string[]): string {
	if (names.length <= MADE_BY_NAMES)
		return `Some of these were made by ${namesInWords(names)}.`;
	const rest = names.length - MADE_BY_NAMES;
	return `Some of these were made by ${names.slice(0, MADE_BY_NAMES).join(", ")} and ${count(rest)} ${rest === 1 ? "other" : "others"}.`;
}
