/**
 * Places in an HQ app, as the reader makes them for findings
 * (`lib/publish/hqFindings.ts::HqPlace`): a menu's and a form's name is its
 * name in the app's first language, a question's path its data path below the
 * form's root. Three projections of a place: `placeOrder`, the order an
 * account lists findings in; `whereText`, a stable key in that order, which an
 * identity claim takes; and `placeKey`, the place by position alone, the only
 * spelling of a place a reader defect's line holds.
 */

import type { HqPlace } from "@/lib/publish/hqFindings";

type FormPlace = Extract<HqPlace, { kind: "form" }>;

export function appPlace(): HqPlace {
	return { kind: "app" };
}

export function appSettingsPlace(): HqPlace {
	return { kind: "app-settings" };
}

export function languagesPlace(): HqPlace {
	return { kind: "languages" };
}

export function menuPlace(menu: number, name: string): HqPlace {
	return { kind: "menu", menu, name };
}

export function formPlace(
	menu: number,
	form: number,
	menuName: string,
	name: string,
): HqPlace {
	return { kind: "form", menu, form, menuName, name };
}

/** `path` is the question's data path below the form's root, a name per step. */
export function questionPlace(
	form: FormPlace,
	path: readonly string[],
): HqPlace {
	return {
		kind: "question",
		menu: form.menu,
		form: form.form,
		menuName: form.menuName,
		formName: form.name,
		path: path.join("/"),
	};
}

/** A position, padded so that text order is number order. */
function position(n: number): string {
	return String(n).padStart(9, "0");
}

/** What a menu's places follow one another by under the menu: itself, its
 *  case list, its detail, its search, then its forms. */
const MENU_PART = {
	menu: "0",
	"case-list": "1",
	"case-detail": "2",
	search: "3",
	form: "4",
} as const;

/**
 * The place's sort key: the app, its settings, its languages, then each menu
 * at its index with its case list, detail and search, then that menu's forms
 * at their index, each followed by its questions in path order, step by step
 * (a question's steps are joined by a space, which sorts before every
 * character a question id holds, so a group sorts before what it holds); then
 * lookup tables, media and the organization.
 */
export function whereText(place: HqPlace): string {
	switch (place.kind) {
		case "app":
			return "0";
		case "app-settings":
			return "1";
		case "languages":
			return "2";
		case "menu":
		case "case-list":
		case "case-detail":
		case "search":
			return `3 ${position(place.menu)} ${MENU_PART[place.kind]}`;
		case "form":
			return `3 ${position(place.menu)} ${MENU_PART.form} ${position(place.form)}`;
		case "question":
			return `3 ${position(place.menu)} ${MENU_PART.form} ${position(place.form)} q ${place.path.split("/").join(" ")}`;
		case "lookup-table":
			return `4 ${place.tag}`;
		case "media":
			return `5 ${place.path}`;
		case "organization":
			return "6";
	}
}

/** Orders two places as the app reads (`whereText`'s order). */
export function placeOrder(a: HqPlace, b: HqPlace): number {
	const left = whereText(a);
	const right = whereText(b);
	return left < right ? -1 : left > right ? 1 : 0;
}

/** The place by position alone, which holds no name, path, tag or file of the app. */
export function placeKey(place: HqPlace): string {
	switch (place.kind) {
		case "app":
		case "app-settings":
		case "languages":
		case "organization":
		case "lookup-table":
		case "media":
			return place.kind;
		case "menu":
		case "case-list":
		case "case-detail":
		case "search":
			return `${place.kind}[${place.menu}]`;
		case "form":
		case "question":
			return `${place.kind}[${place.menu},${place.form}]`;
	}
}
