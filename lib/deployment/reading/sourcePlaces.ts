/**
 * Places in CommCare HQ's source of an app, as acceptance names where a
 * difference lies: the app, a menu by its position, a form by its position
 * or its `xmlns`, and a question by its form and its data path. A menu's and
 * a form's name is its name in the app's first language, as the reader names
 * the places of its own findings (`lib/commcare/reader/place.ts`).
 *
 * Pure.
 */

import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import {
	appPlace,
	formPlace,
	menuPlace,
	questionPlace,
} from "@/lib/commcare/reader/place";
import type { HqPlace } from "@/lib/publish/hqFindings";

type FormPlace = Extract<HqPlace, { kind: "form" }>;

export interface SourcePlaces {
	readonly app: HqPlace;
	/** The menu at `index`, or the app where the source holds none there. */
	menu(index: number): HqPlace;
	/** The menu whose `unique_id` is `uniqueId`, or the app. */
	menuOfId(uniqueId: string): HqPlace;
	/** The form whose `xmlns` is `xmlns`, or the app. */
	formOf(xmlns: string): HqPlace;
	/** The form at `form` of the menu at `menu`, or that menu, or the app. */
	formAt(menu: number, form: number): HqPlace;
	/** The question at the absolute data path `path` (`/data/a/b`) of the form of `xmlns`;
	 *  that form where the path is the data root, or the app where no form has the `xmlns`. */
	questionOf(xmlns: string, path: string): HqPlace;
	/** The question at the steps `steps` below the data root of the form of `xmlns`. */
	questionAt(xmlns: string, steps: readonly string[]): HqPlace;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text a language map holds in `language`, or blank. */
function textIn(map: unknown, language: string | undefined): string {
	if (language === undefined || !isRecord(map)) return "";
	const text = map[language];
	return typeof text === "string" ? text : "";
}

/** The steps of an absolute data path below its root: `/data/a/b` is `a`, `b`. */
export function stepsBelowRoot(path: string): readonly string[] {
	return path
		.split("/")
		.filter((step) => step !== "")
		.slice(1);
}

/** Each source's places, made once: acceptance names places in several checks, and nothing
 *  writes to a source. */
const placesOfSources = new WeakMap<HqAppSource, SourcePlaces>();

export function sourcePlaces(source: HqAppSource): SourcePlaces {
	const known = placesOfSources.get(source);
	if (known !== undefined) return known;
	const made = placesOf(source);
	placesOfSources.set(source, made);
	return made;
}

function placesOf(source: HqAppSource): SourcePlaces {
	const first = source.langs[0];
	const rawMenus = Array.isArray(source.raw.modules)
		? (source.raw.modules as unknown[])
		: [];
	const menuName = (index: number): string => {
		const raw = rawMenus[index];
		return isRecord(raw) ? textIn(raw.name, first) : "";
	};
	const formName = (menu: number, form: number): string => {
		const raw = rawMenus[menu];
		const forms = isRecord(raw) && Array.isArray(raw.forms) ? raw.forms : [];
		const rawForm: unknown = forms[form];
		return isRecord(rawForm) ? textIn(rawForm.name, first) : "";
	};
	const menu = (index: number): HqPlace =>
		index >= 0 && index < source.modules.length
			? menuPlace(index, menuName(index))
			: appPlace();
	const formAt = (menuIndex: number, form: number): HqPlace => {
		const held = source.modules[menuIndex];
		if (held === undefined) return appPlace();
		if (form < 0 || form >= held.forms.length) return menu(menuIndex);
		return formPlace(
			menuIndex,
			form,
			menuName(menuIndex),
			formName(menuIndex, form),
		);
	};
	/* The first form holding each `xmlns`, in menu order and then form order. */
	let firstHolders: Map<string, readonly [number, number]> | undefined;
	const formOf = (xmlns: string): HqPlace => {
		if (firstHolders === undefined) {
			firstHolders = new Map();
			for (const [menuIndex, held] of source.modules.entries())
				for (const [formIndex, one] of held.forms.entries())
					if (one.xmlns !== null && !firstHolders.has(one.xmlns))
						firstHolders.set(one.xmlns, [menuIndex, formIndex]);
		}
		const holder = firstHolders.get(xmlns);
		return holder === undefined ? appPlace() : formAt(holder[0], holder[1]);
	};
	const questionAt = (xmlns: string, steps: readonly string[]): HqPlace => {
		const form = formOf(xmlns);
		if (form.kind !== "form" || steps.length === 0) return form;
		return questionPlace(form as FormPlace, steps);
	};
	return {
		app: appPlace(),
		menu,
		menuOfId: (uniqueId) =>
			menu(source.modules.findIndex((held) => held.uniqueId === uniqueId)),
		formOf,
		formAt,
		questionOf: (xmlns, path) => questionAt(xmlns, stepsBelowRoot(path)),
		questionAt,
	};
}
