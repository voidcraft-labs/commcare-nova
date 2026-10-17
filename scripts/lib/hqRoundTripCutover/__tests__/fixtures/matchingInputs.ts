/**
 * Built inputs for the matcher's pure tests: HQ's side and Nova's side of one
 * deployment, written by hand to reach one rule each. That the rules pair
 * HQ's real forms is the retained reads' test (`matchingOverHq.test.ts`).
 */

import type { HqPath, HqSideForm, HqSideMenu } from "../../matching";
import type { QuestionPathForm, QuestionPathMenu } from "../../questionPaths";

/** A stable UUID for a short label, so a test reads by name. */
export function uuidOf(label: string): string {
	let hash = 0;
	for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return `00000000-0000-4000-8000-${hash.toString(16).padStart(12, "0").slice(-12)}`;
}

function hqPaths(paths: readonly (string | HqPath)[]): HqPath[] {
	return paths.map((path) =>
		typeof path === "string" ? { path, generated: false } : path,
	);
}

export function hqForm(
	name: string | readonly string[],
	paths: readonly (string | HqPath)[],
	extra: Partial<Pick<HqSideForm, "xmlns" | "readUniqueId">> = {},
): Omit<HqSideForm, "position"> {
	return {
		xmlns: extra.xmlns ?? `http://openrosa.org/formdesigner/hq-${String(name)}`,
		readUniqueId: extra.readUniqueId ?? `read-${String(name)}`,
		names: typeof name === "string" ? [name] : [...name],
		paths: hqPaths(paths),
	};
}

export function hqMenu(
	name: string | readonly string[],
	caseType: string,
	forms: readonly Omit<HqSideForm, "position">[],
	uniqueId = `hq-menu-${String(name)}`,
): Omit<HqSideMenu, "position"> {
	return {
		uniqueId,
		caseType,
		names: typeof name === "string" ? [name] : [...name],
		forms: forms.map((form, position) => ({ ...form, position })),
	};
}

/** HQ's menus in the order given, each at its position. */
export function hq(
	menus: readonly Omit<HqSideMenu, "position">[],
): HqSideMenu[] {
	return menus.map((menu, position) => ({
		...menu,
		position,
		forms: menu.forms.map((form, formPosition) => ({
			...form,
			position: formPosition,
		})),
	}));
}

export function novaForm(
	label: string,
	name: string,
	paths: readonly string[],
): QuestionPathForm {
	return { uuid: uuidOf(label), name, paths };
}

export function novaMenu(
	label: string,
	name: string,
	caseType: string | null,
	forms: readonly QuestionPathForm[],
	lifted = false,
): QuestionPathMenu {
	return { uuid: uuidOf(label), name, caseType, lifted, forms };
}

/** A seeded shuffle, so an order test draws the same orders every run. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
	const result = [...items];
	let state = seed >>> 0 || 1;
	for (let index = result.length - 1; index > 0; index--) {
		state = (state * 1_103_515_245 + 12_345) >>> 0;
		const other = state % (index + 1);
		[result[index], result[other]] = [result[other] as T, result[index] as T];
	}
	return result;
}

/** Nova's side handed over in another order: its menus, and the forms inside each. */
export function reordered(
	menus: readonly QuestionPathMenu[],
	seed: number,
): QuestionPathMenu[] {
	return shuffled(menus, seed).map((menu, index) => ({
		...menu,
		forms: shuffled(menu.forms, seed + index + 1),
	}));
}
