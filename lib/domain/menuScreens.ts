// lib/domain/menuScreens.ts
//
// Which screen lists what. A screen is the app's first menu or one menu's
// own screen. A module that shows its forms in the menu above
// (`Module.formsInMenuAbove`) has no entry and no screen of its own: its
// forms and its case list entry list where its entry would be, on its
// parent's screen or, for a top-level module or one under a parent that
// shows its forms above too, on the first menu. This is CommCare Core's
// `MenuLoader.getMenuDisplayables` over the `<menu>` elements both exports
// write, in the same walk and the same order. Every reader of "the forms a
// worker sees here" goes through it.
//
// Whether a screen asks for a case before a form is a fact of the screen:
// Core asks one question of every entry the screen lists
// (`CommCareSession.getDataNeededByAllEntries`), so `screenChoosesCaseFirst`
// is the answer wherever a case must be chosen before a form is listed.

import type { BlueprintDoc } from "./blueprint";
import {
	type EntrySelectionSource,
	entrySelections,
} from "./entryDatumSupplies";
import { CASE_LOADING_FORM_TYPES } from "./forms";
import { menuFormUuidsOf, type PreparedMenuForm } from "./menuForms";
import { projectedModulePreorder } from "./moduleHierarchy";
import {
	moduleHasCaseListMenuItem,
	moduleShowsFormsInMenuAbove,
} from "./modules";
import type { Uuid } from "./uuid";

/** The one source every reader of this file takes. */
export type MenuScreenSource = Pick<
	BlueprintDoc,
	"modules" | "moduleOrder" | "forms" | "formOrder" | "caseTypes"
>;

/** A screen a worker chooses from: the app's first menu, or one menu's own screen. */
export type MenuScreen =
	| { readonly kind: "first-menu" }
	| { readonly kind: "menu"; readonly moduleUuid: Uuid };

export type MenuScreenEntry =
	| { readonly kind: "menu"; readonly moduleUuid: Uuid }
	| {
			readonly kind: "form";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
	  }
	| { readonly kind: "case-list"; readonly moduleUuid: Uuid };

const FIRST_MENU: MenuScreen = { kind: "first-menu" };

export function menuScreenKey(screen: MenuScreen): string {
	return screen.kind === "first-menu"
		? "first-menu"
		: `menu:${screen.moduleUuid}`;
}

/** The module's parent, where it names one that exists. */
function existingParent(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
): Uuid | undefined {
	const parentUuid = doc.modules[moduleUuid]?.parentModuleUuid;
	return parentUuid !== undefined && doc.modules[parentUuid] !== undefined
		? parentUuid
		: undefined;
}

function isAbove(doc: MenuScreenSource, moduleUuid: Uuid): boolean {
	return moduleShowsFormsInMenuAbove(doc.modules[moduleUuid]);
}

/** Whether the module has an entry and a screen of its own. */
export function moduleHasOwnScreen(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
): boolean {
	return doc.modules[moduleUuid] !== undefined && !isAbove(doc, moduleUuid);
}

/** The screen that lists the module's forms and its case list entry. */
export function menuScreenOf(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
): MenuScreen {
	if (!isAbove(doc, moduleUuid)) return { kind: "menu", moduleUuid };
	const parentUuid = existingParent(doc, moduleUuid);
	if (parentUuid !== undefined && !isAbove(doc, parentUuid))
		return { kind: "menu", moduleUuid: parentUuid };
	return FIRST_MENU;
}

/** The screen that lists the module's own entry; undefined where it has none. */
export function menuTileScreenOf(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
): MenuScreen | undefined {
	if (doc.modules[moduleUuid] === undefined || isAbove(doc, moduleUuid))
		return undefined;
	const parentUuid = existingParent(doc, moduleUuid);
	if (parentUuid === undefined || isAbove(doc, parentUuid)) return FIRST_MENU;
	return { kind: "menu", moduleUuid: parentUuid };
}

/** The modules whose forms list on the screen, in module order. */
export function menuScreenContributors(
	doc: MenuScreenSource,
	screen: MenuScreen,
): Uuid[] {
	const key = menuScreenKey(screen);
	return projectedModulePreorder(doc).filter(
		(moduleUuid) => menuScreenKey(menuScreenOf(doc, moduleUuid)) === key,
	);
}

/** Everything the screen lists, in the order a worker meets it. */
export function menuScreenEntries(
	doc: MenuScreenSource,
	screen: MenuScreen,
): MenuScreenEntry[] {
	const key = menuScreenKey(screen);
	const entries: MenuScreenEntry[] = [];
	for (const moduleUuid of projectedModulePreorder(doc)) {
		const mod = doc.modules[moduleUuid];
		if (mod === undefined) continue;
		if (menuScreenKey(menuScreenOf(doc, moduleUuid)) === key) {
			for (const formUuid of menuFormUuidsOf(doc, moduleUuid))
				entries.push({ kind: "form", moduleUuid, formUuid });
			if (moduleHasCaseListMenuItem(mod))
				entries.push({ kind: "case-list", moduleUuid });
			continue;
		}
		const tile = menuTileScreenOf(doc, moduleUuid);
		if (tile !== undefined && menuScreenKey(tile) === key)
			entries.push({ kind: "menu", moduleUuid });
	}
	return entries;
}

/** The modules whose display condition and `hiddenFromMenu` gate a
 *  contributor's entries: the module, then its parent where it shows above. */
export function conditionModulesOf(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
): Uuid[] {
	const parentUuid = existingParent(doc, moduleUuid);
	return isAbove(doc, moduleUuid) && parentUuid !== undefined
		? [moduleUuid, parentUuid]
		: [moduleUuid];
}

/** The menu above, for copy: the first menu, or the parent by name. */
export function menuAbove(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
):
	| { readonly kind: "first-menu" }
	| {
			readonly kind: "menu";
			readonly moduleUuid: Uuid;
			readonly name: string;
	  } {
	const parentUuid = existingParent(doc, moduleUuid);
	if (parentUuid === undefined || isAbove(doc, parentUuid))
		return { kind: "first-menu" };
	return {
		kind: "menu",
		moduleUuid: parentUuid,
		name: doc.modules[parentUuid]?.name ?? "",
	};
}

/** A menu screen whose entries are exactly one case list entry of its own
 *  module and, after it, zero or more menu entries. */
export function screenIsBareCaseList(
	doc: MenuScreenSource,
	screen: MenuScreen,
): boolean {
	if (screen.kind !== "menu") return false;
	const [first, ...rest] = menuScreenEntries(doc, screen);
	return (
		first?.kind === "case-list" &&
		first.moduleUuid === screen.moduleUuid &&
		rest.every((entry) => entry.kind === "menu")
	);
}

export interface ScreenCaseFirstBlocker {
	readonly reason:
		| "first-menu"
		| "bare-case-list"
		| "opens-without-a-case"
		| "chooses-another-case";
	/** The contributor that keeps the screen forms first; present for
	 *  `opens-without-a-case` and `chooses-another-case`. */
	readonly moduleUuid?: Uuid;
	/** Its first form that opens without a case; present for `opens-without-a-case`. */
	readonly formUuid?: Uuid;
}

function formTypeOf(
	doc: MenuScreenSource,
	formUuid: Uuid,
	prepared: PreparedMenuForm | undefined,
) {
	return prepared?.formUuid === formUuid
		? prepared.type
		: doc.forms[formUuid]?.type;
}

/** The key of the first case the module's entries choose: its first menu
 *  form's entry, else its browse entry. A module's case-loading menu forms
 *  and its browse entry all start with that one selection. */
function firstSelectionKey(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
	prepared: PreparedMenuForm | undefined,
): string | undefined {
	const firstForm = menuFormUuidsOf(doc, moduleUuid, prepared)[0];
	const entry =
		firstForm !== undefined && doc.forms[firstForm] !== undefined
			? ({ kind: "form", module: moduleUuid, form: firstForm } as const)
			: ({ kind: "browse", module: moduleUuid } as const);
	return entrySelections(doc, entry)[0]?.key;
}

/**
 * What keeps the screen forms first, or undefined where nothing does. The
 * first match of: the first menu (Core asks for a command while none is
 * chosen); a bare case list, which Core opens on its list; the first
 * contributor holding a menu form that opens without a case; the first
 * contributor other than the host whose first case differs from the host's.
 */
export function screenCaseFirstBlocker(
	doc: MenuScreenSource,
	screen: MenuScreen,
	prepared?: PreparedMenuForm,
): ScreenCaseFirstBlocker | undefined {
	if (screen.kind === "first-menu") return { reason: "first-menu" };
	if (screenIsBareCaseList(doc, screen)) return { reason: "bare-case-list" };
	const contributors = menuScreenContributors(doc, screen);
	for (const moduleUuid of contributors) {
		// A form of a module with no case type loads no case, whatever its type.
		const hasCaseType = doc.modules[moduleUuid]?.caseType !== undefined;
		const formUuid = menuFormUuidsOf(doc, moduleUuid, prepared).find((uuid) => {
			const type = formTypeOf(doc, uuid, prepared);
			return (
				!hasCaseType || type === undefined || !CASE_LOADING_FORM_TYPES.has(type)
			);
		});
		if (formUuid !== undefined)
			return { reason: "opens-without-a-case", moduleUuid, formUuid };
	}
	const [host, ...others] = contributors;
	if (host === undefined) return undefined;
	const hostKey = firstSelectionKey(doc, host, prepared);
	for (const moduleUuid of others) {
		if (firstSelectionKey(doc, moduleUuid, prepared) !== hostKey)
			return { reason: "chooses-another-case", moduleUuid };
	}
	return undefined;
}

/**
 * Whether a worker chooses a case before a form on the screen: nothing keeps
 * it forms first, and it lists an entry Core opens, a form or a case list. A
 * screen that lists only menus asks for a command, since Core finds no entry
 * to ask a case of (`CommCareSession.getNeededData`, `STATE_COMMAND_ID` where
 * the current command has no entries). On a screen with one contributor this
 * is `menuForms.ts::moduleIsCaseFirst` of that module.
 */
export function screenChoosesCaseFirst(
	doc: MenuScreenSource,
	screen: MenuScreen,
	prepared?: PreparedMenuForm,
): boolean {
	if (screenCaseFirstBlocker(doc, screen, prepared) !== undefined) return false;
	return menuScreenContributors(doc, screen).some((moduleUuid) => {
		const mod = doc.modules[moduleUuid];
		return (
			menuFormUuidsOf(doc, moduleUuid, prepared).length > 0 ||
			(mod !== undefined && moduleHasCaseListMenuItem(mod))
		);
	});
}

/**
 * Whether every form of every menu that shows its forms above opens one
 * chosen case, the same one: each form's entry chooses a case first, and
 * every first choice is one selection (`entrySelections`' key, which two
 * entries share exactly where the wire gives them one datum id). There HQ's
 * build puts that case ahead of every frame it builds through the first menu
 * (`workflow.py::WorkflowHelper._root_module_datums`), so a submenu that
 * keeps its screen under a top-level menu above opens with it. Where the
 * wire's root lists also differ in a value ahead of the case (a value a
 * submenu carries from its parent's first form, an advanced menu's own case
 * names) HQ's frame holds no shared case, and this answer still holds: it is
 * the domain's reading of the shape, and holds wherever the wire's does.
 *
 * Each call reads a view of its own, so the selection projection's per-document
 * cache never outlives a reducer's write to the same draft.
 */
export function firstMenuOpensOneCase(doc: EntrySelectionSource): boolean {
	const view: EntrySelectionSource = {
		modules: doc.modules,
		moduleOrder: doc.moduleOrder,
		forms: doc.forms,
		formOrder: doc.formOrder,
	};
	let shared: string | undefined;
	for (const moduleUuid of projectedModulePreorder(view)) {
		if (!moduleShowsFormsInMenuAbove(view.modules[moduleUuid])) continue;
		for (const formUuid of view.formOrder[moduleUuid] ?? []) {
			if (view.forms[formUuid] === undefined) continue;
			const key = entrySelections(view, {
				kind: "form",
				module: moduleUuid,
				form: formUuid,
			})[0]?.key;
			if (key === undefined || (shared !== undefined && key !== shared))
				return false;
			shared = key;
		}
	}
	return shared !== undefined;
}
