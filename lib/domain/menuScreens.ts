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
// is the answer wherever a case must be chosen before a form is listed. It
// reads whether a menu is emitted advanced, which reads the whole document,
// so it takes a `BlueprintDoc` where the rest of this file takes a
// `MenuScreenSource`.

import { advancedLoadTags, menuEmittedAdvanced } from "./advancedEntryDatums";
import type { BlueprintDoc } from "./blueprint";
import {
	type DatumEntry,
	type EntrySelectionSource,
	entrySelections,
	rootSelectionAlignment,
} from "./entryDatumSupplies";
import { CASE_LOADING_FORM_TYPES } from "./forms";
import { menuFormUuidsOf, type PreparedMenuForm } from "./menuForms";
import { projectedModulePreorder } from "./moduleHierarchy";
import {
	moduleHasCaseListMenuItem,
	moduleShowsFormsInMenuAbove,
} from "./modules";
import { isSettled } from "./settled";
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

/** Every screen's contributors and entries, keyed by `menuScreenKey`. */
interface Screens {
	readonly contributors: ReadonlyMap<string, readonly Uuid[]>;
	readonly entries: ReadonlyMap<string, readonly MenuScreenEntry[]>;
}

/** Every screen of `doc` in one walk of the module preorder. */
function screensOf(doc: MenuScreenSource): Screens {
	const contributors = new Map<string, Uuid[]>();
	const entries = new Map<string, MenuScreenEntry[]>();
	const push = <T>(into: Map<string, T[]>, key: string, value: T) => {
		const list = into.get(key);
		if (list === undefined) into.set(key, [value]);
		else list.push(value);
	};
	for (const moduleUuid of projectedModulePreorder(doc)) {
		const own = menuScreenKey(menuScreenOf(doc, moduleUuid));
		push(contributors, own, moduleUuid);
		const mod = doc.modules[moduleUuid];
		if (mod === undefined) continue;
		for (const formUuid of menuFormUuidsOf(doc, moduleUuid))
			push(entries, own, { kind: "form", moduleUuid, formUuid });
		if (moduleHasCaseListMenuItem(mod))
			push(entries, own, { kind: "case-list", moduleUuid });
		const tile = menuTileScreenOf(doc, moduleUuid);
		if (tile !== undefined && menuScreenKey(tile) !== own)
			push(entries, menuScreenKey(tile), { kind: "menu", moduleUuid });
	}
	return { contributors, entries };
}

/** A value no write can reach any more (`settled.ts`). */
function settled(value: unknown): boolean {
	return typeof value !== "object" || value === null || isSettled(value);
}

/** Whether every part of `doc` a screen reads is settled. */
function screenPartsSettled(doc: MenuScreenSource): boolean {
	if (
		!settled(doc.modules) ||
		!settled(doc.moduleOrder) ||
		!settled(doc.forms) ||
		!settled(doc.formOrder)
	)
		return false;
	for (const mod of Object.values(doc.modules))
		if (!settled(mod) || !settled(mod?.caseListRegistrationForm)) return false;
	for (const order of Object.values(doc.formOrder))
		if (!settled(order)) return false;
	return true;
}

/**
 * The screens of a document whose screen parts are settled, remembered by the
 * identity of those four parts; a draft or a part still open to a write gets
 * a walk of its own on every call, because a remembered answer for an object
 * that changed under it would be a wrong verdict.
 */
const screensByParts = new WeakMap<
	object,
	WeakMap<object, WeakMap<object, WeakMap<object, Screens>>>
>();

function knownScreens(doc: MenuScreenSource): Screens {
	const byOrder = screensByParts.get(doc.modules);
	const byForms = byOrder?.get(doc.moduleOrder);
	const byFormOrder = byForms?.get(doc.forms);
	const known = byFormOrder?.get(doc.formOrder);
	if (known !== undefined) return known;
	const screens = screensOf(doc);
	if (!screenPartsSettled(doc)) return screens;
	const order = byOrder ?? new WeakMap();
	if (byOrder === undefined) screensByParts.set(doc.modules, order);
	const forms = byForms ?? new WeakMap();
	if (byForms === undefined) order.set(doc.moduleOrder, forms);
	const formOrder = byFormOrder ?? new WeakMap();
	if (byFormOrder === undefined) forms.set(doc.forms, formOrder);
	formOrder.set(doc.formOrder, screens);
	return screens;
}

/** The modules whose forms list on the screen, in module order. */
export function menuScreenContributors(
	doc: MenuScreenSource,
	screen: MenuScreen,
): Uuid[] {
	return [...(knownScreens(doc).contributors.get(menuScreenKey(screen)) ?? [])];
}

/** Everything the screen lists, in the order a worker meets it. */
export function menuScreenEntries(
	doc: MenuScreenSource,
	screen: MenuScreen,
): MenuScreenEntry[] {
	return [...(knownScreens(doc).entries.get(menuScreenKey(screen)) ?? [])];
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
		| "chooses-another-case"
		| "form-chooses-apart"
		| "case-list-entry-apart";
	/** The contributor that keeps the screen forms first; present for
	 *  `opens-without-a-case`, `chooses-another-case`, `form-chooses-apart`
	 *  and `case-list-entry-apart`. */
	readonly moduleUuid?: Uuid;
	/** Its first form that opens without a case, for `opens-without-a-case`;
	 *  its form that asks for another datum first, for `form-chooses-apart`. */
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

/**
 * The key of the first datum an advanced load asks for: its datum is
 * `case_id_<tag>` (`models/form_actions.py::LoadUpdateAction.case_session_var`),
 * so two loads, or a load and an advanced case list entry, ask for one datum
 * exactly where their tags are one.
 */
function advancedDatumKey(tag: string): string {
	return JSON.stringify(["advanced-datum", tag]);
}

/**
 * The key of the first datum an entry asks for, a form's or a case list
 * entry's, equal for two entries exactly where Core reads one datum id first
 * (`CommCareSession.getDataNeededByAllEntries` compares `getDataId`), or
 * undefined where the entry asks for no case.
 *
 * The case list entry of a menu emitted advanced is HQ's one datum
 * `case_id_case_<type>` (`suite_xml/sections/entries.py::
 * EntriesHelper.entry_for_module`), with no alignment: the datum of a load
 * tagged `case_<type>`, so a form whose first load holds that tag starts with
 * it too, and one tagged otherwise does not.
 *
 * Every other entry's first selection, aligned with the root menu's, takes
 * the id of the root's datum it matches (`formLinkProjection.ts::
 * alignWithRootMenu`, which a basic case list entry passes through as a
 * form's does, HQ's `add_parent_datums` over `entry_for_module`), so it reads
 * the root entry's own key: its first form's, read the same way, so an
 * advanced root's `case_id_<tag>`, or its basic case list's where it has no
 * form (HQ aligns with nothing there and the child keeps its basic id).
 * Otherwise a basic entry starts with its first selection (`entrySelections`'
 * key), and a form of a menu emitted advanced with its first load's datum,
 * `case_id_<tag>` (`advancedEntryDatums.ts::advancedLoadTags`): a held tag as
 * held, or `load_<type><n>` stepped past a name the form already holds. The
 * one spelling this does not separate is an unaligned datum HQ renames by its
 * case type because the root's entry holds the same id, which no two entries
 * of one screen tell apart.
 */
function entryFirstDatumKey(
	doc: BlueprintDoc,
	entry: DatumEntry,
	visiting: ReadonlySet<Uuid> = new Set(),
): string | undefined {
	if (visiting.has(entry.module)) return undefined;
	if (entry.kind === "browse" && menuEmittedAdvanced(doc, entry.module))
		return advancedDatumKey(
			`case_${doc.modules[entry.module]?.caseType ?? ""}`,
		);
	if (entry.kind === "form") {
		const choices = doc.forms[entry.form]?.caseSelections;
		if (choices && choices[0]?.source.kind !== "choose") return undefined;
	}
	const [first] = entrySelections(doc, entry);
	if (first === undefined) return undefined;
	const alignment = rootSelectionAlignment(doc, entry);
	const match = alignment.matches.find(
		(pair) => pair.targetModuleUuid === first.module,
	);
	const parent = alignment.parentEntry;
	if (match !== undefined && parent !== undefined) {
		const [parentFirst] = entrySelections(doc, parent);
		if (parentFirst?.module !== match.sourceModuleUuid) return first.key;
		return parent.kind === "form"
			? entryFirstDatumKey(doc, parent, new Set([...visiting, entry.module]))
			: parentFirst.key;
	}
	if (entry.kind === "browse" || !menuEmittedAdvanced(doc, entry.module))
		return first.key;
	const tag =
		doc.forms[entry.form]?.caseSelections?.[0]?.tag ??
		advancedLoadTags(doc, entry.form)[0];
	return tag === undefined ? first.key : advancedDatumKey(tag);
}

/** The key of the first datum the module's case list entry asks for, or
 *  undefined where it has none (`entryFirstDatumKey` of its browse entry). */
function caseListEntryKey(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): string | undefined {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined || !moduleHasCaseListMenuItem(mod)) return undefined;
	return entryFirstDatumKey(doc, { kind: "browse", module: moduleUuid });
}

/** The module's menu forms on the screen, each with the key of the first
 *  datum its entry asks for. */
function menuFormKeys(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	prepared: PreparedMenuForm | undefined,
): { readonly formUuid: Uuid; readonly key: string | undefined }[] {
	return menuFormUuidsOf(doc, moduleUuid, prepared)
		.filter((formUuid) => doc.forms[formUuid] !== undefined)
		.map((formUuid) => ({
			formUuid,
			key: entryFirstDatumKey(doc, {
				kind: "form",
				module: moduleUuid,
				form: formUuid,
			}),
		}));
}

/**
 * What keeps the screen forms first that the screen's shape alone says, or
 * undefined where nothing does: the first menu (Core asks for a command
 * while none is chosen); a bare case list, which Core opens on its list; the
 * first contributor holding a menu form that opens without a case. It reads
 * no case a form chooses, so it takes the narrower source.
 */
export function screenShapeBlocker(
	doc: MenuScreenSource,
	screen: MenuScreen,
	prepared?: PreparedMenuForm,
): ScreenCaseFirstBlocker | undefined {
	if (screen.kind === "first-menu") return { reason: "first-menu" };
	if (screenIsBareCaseList(doc, screen)) return { reason: "bare-case-list" };
	for (const moduleUuid of menuScreenContributors(doc, screen)) {
		// A form of a module with no case type loads no case, whatever its type.
		const hasCaseType = doc.modules[moduleUuid]?.caseType !== undefined;
		const formUuid = menuFormUuidsOf(doc, moduleUuid, prepared).find((uuid) => {
			const type = formTypeOf(doc, uuid, prepared);
			return (
				!hasCaseType ||
				type === undefined ||
				(doc.forms[uuid]?.caseSelections === undefined
					? !CASE_LOADING_FORM_TYPES.has(type)
					: doc.forms[uuid].caseSelections?.[0]?.source.kind !== "choose")
			);
		});
		if (formUuid !== undefined)
			return { reason: "opens-without-a-case", moduleUuid, formUuid };
	}
	return undefined;
}

/**
 * What keeps the screen forms first, or undefined where nothing does: the
 * first match of `screenShapeBlocker`; else, every entry on the screen
 * compared with the first datum the host's first entry asks for (its first
 * form's, else its case list entry's), the first that asks for another: a
 * contributor other than the host whose first entry does
 * (`chooses-another-case`), another form of a contributor whose first form
 * agrees (`form-chooses-apart`, a menu emitted advanced whose forms load
 * under different tags), then a case list entry (`case-list-entry-apart`, an
 * advanced menu's entry beside forms whose first load is tagged otherwise).
 * Core asks for a case first only where every entry needs one datum first
 * (`CommCareSession.getDataNeededByAllEntries`).
 */
export function screenCaseFirstBlocker(
	doc: BlueprintDoc,
	screen: MenuScreen,
	prepared?: PreparedMenuForm,
): ScreenCaseFirstBlocker | undefined {
	const shape = screenShapeBlocker(doc, screen, prepared);
	if (shape !== undefined) return shape;
	const contributors = menuScreenContributors(doc, screen);
	const [host] = contributors;
	if (host === undefined) return undefined;
	const hostKey =
		menuFormKeys(doc, host, prepared)[0]?.key ?? caseListEntryKey(doc, host);
	for (const moduleUuid of contributors) {
		const forms = menuFormKeys(doc, moduleUuid, prepared);
		const firstKey = forms[0]?.key ?? caseListEntryKey(doc, moduleUuid);
		if (moduleUuid !== host && firstKey !== hostKey)
			return { reason: "chooses-another-case", moduleUuid };
		const apart = forms.find((form) => form.key !== hostKey);
		if (apart !== undefined)
			return {
				reason: "form-chooses-apart",
				moduleUuid,
				formUuid: apart.formUuid,
			};
	}
	for (const moduleUuid of contributors) {
		const key = caseListEntryKey(doc, moduleUuid);
		if (key !== undefined && key !== hostKey)
			return { reason: "case-list-entry-apart", moduleUuid };
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
	doc: BlueprintDoc,
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
