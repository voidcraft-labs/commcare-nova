/** Which forms a worker can reach from one particular menu. Ownership remains in formOrder. */
import type { BlueprintDoc } from "./blueprint";
import type { Form } from "./forms";
import type { Module } from "./modules";
import { isDeeplySettled } from "./settled";
import type { Uuid } from "./uuid";

type MenuFormDoc = Pick<BlueprintDoc, "forms" | "formOrder" | "modules">;
/** One form as an authoring preparation holds it before it is in the doc. */
export type PreparedMenuForm = Pick<Form, "type"> & {
	readonly formUuid: Uuid;
};

/** The module's menu forms, in order: every form of the module except its
 *  case list registration form. */
export function menuFormUuidsOf(
	doc: MenuFormDoc,
	moduleUuid: Uuid,
	prepared?: PreparedMenuForm,
): Uuid[] {
	const source = doc.modules[moduleUuid]?.formsFromMenu;
	const owner = source?.menuUuid ?? moduleUuid;
	const action = doc.modules[owner]?.caseListRegistrationForm;
	const registration =
		action?.kind === "after-empty-search" ? action.formUuid : undefined;
	const excluded = source?.excludedFormUuids
		? new Set(source.excludedFormUuids)
		: undefined;
	return (doc.formOrder[owner] ?? []).filter((formUuid) => {
		if (formUuid === registration || excluded?.has(formUuid)) return false;
		const form =
			prepared?.formUuid === formUuid ? prepared : doc.forms[formUuid];
		return form !== undefined;
	});
}

const otherRoutes = new WeakMap<
	BlueprintDoc["modules"],
	ReadonlyMap<Uuid, readonly Module[]>
>();

/** Every menu listing a source form, including the owner. Rules on the single
 * form have to hold on each route. Editing in either menu changes that same form. */
export function formRouteUuids(
	doc: MenuFormDoc,
	owner: Uuid,
	form: Uuid,
): Uuid[] {
	let bySource = otherRoutes.get(doc.modules);
	if (!bySource) {
		const routes = new Map<Uuid, Module[]>();
		for (const menu of Object.values(doc.modules)) {
			const source = menu.formsFromMenu;
			if (!source) continue;
			const siblings = routes.get(source.menuUuid);
			if (siblings) siblings.push(menu);
			else routes.set(source.menuUuid, [menu]);
		}
		if (isDeeplySettled(doc.modules)) otherRoutes.set(doc.modules, routes);
		bySource = routes;
	}
	return [
		owner,
		...(bySource.get(owner) ?? [])
			.filter((route) => routeContainsForm(doc, route.uuid, form))
			.map((route) => route.uuid),
	];
}

/** A menu listing another menu's forms whose own screen lists nothing: it
 * shows none of its source's forms, and no submenu shows forms in it. It has
 * no `<menu>` on the device, as HQ's build writes none for a menu without a
 * command (`suite_xml/sections/menus.py`), so nothing can open it. */
export function listedMenuIsEmpty(doc: MenuFormDoc, uuid: Uuid): boolean {
	const route = doc.modules[uuid];
	if (!route?.formsFromMenu || route.formsInMenuAbove === true) return false;
	if (menuFormUuidsOf(doc, uuid).length > 0) return false;
	return !Object.values(doc.modules).some(
		(child) =>
			child.parentModuleUuid === uuid &&
			child.formsInMenuAbove === true &&
			menuFormUuidsOf(doc, child.uuid).length > 0,
	);
}

/** The authoring menu and stable identity of a form reached from this menu. An excluded
 * form and a form stored in an unrelated menu have no route here. */
export function sourceMenuOfListedForm(
	doc: MenuFormDoc,
	routeMenuUuid: Uuid,
	formUuid: Uuid,
): Uuid | undefined {
	const route = doc.modules[routeMenuUuid];
	if (!route || !menuFormUuidsOf(doc, routeMenuUuid).includes(formUuid)) return;
	return route.formsFromMenu?.menuUuid ?? routeMenuUuid;
}

/** The settings of the route's actual list. The source supplies the type and selection
 * cardinality. The route owns its columns, search, ordering and display conditions. */
export function menuWithInheritedCaseSettings(
	doc: Pick<BlueprintDoc, "modules">,
	uuid: Uuid,
	localized?: Module,
): Module | undefined {
	const route = localized ?? doc.modules[uuid];
	const from = route?.formsFromMenu;
	if (from === undefined) return route;
	const source = doc.modules[from.menuUuid];
	if (source === undefined) return;
	return {
		...route,
		caseType: source.caseType,
		...(route.caseListConfig && {
			caseListConfig: {
				...route.caseListConfig,
				selection: source.caseListConfig?.selection,
			},
		}),
	};
}

/** Ownership for an ordinary menu, membership for a route. Some owned forms are reached
 * through search; callers that distinguish such forms can apply their own placed refusal. */
export function routeContainsForm(
	doc: Pick<BlueprintDoc, "formOrder" | "modules">,
	moduleUuid: Uuid,
	formUuid: Uuid,
): boolean {
	const source = doc.modules[moduleUuid]?.formsFromMenu;
	if (!source) return doc.formOrder[moduleUuid]?.includes(formUuid) === true;
	const registration = doc.modules[source.menuUuid]?.caseListRegistrationForm;
	return (
		doc.formOrder[source.menuUuid]?.includes(formUuid) === true &&
		!source.excludedFormUuids?.includes(formUuid) &&
		(registration?.kind !== "after-empty-search" ||
			registration.formUuid !== formUuid)
	);
}

/** A basic form selects the cases of its source menu and parent chain. The menu through
 * which the worker opens it contributes the details for its own case and, when both
 * menus choose a parent, the detail for the immediate parent case. */
export function basicMenuSelectionPath(
	doc: Pick<BlueprintDoc, "modules">,
	routeUuid: Uuid,
): { source: Uuid; detail: Uuid }[] {
	const route = doc.modules[routeUuid];
	const owner = route?.formsFromMenu?.menuUuid ?? routeUuid;
	const parent = doc.modules[owner]?.parentCaseModuleUuid;
	const path: { source: Uuid; detail: Uuid }[] = [];
	const seen = new Set<Uuid>();
	let current: Uuid | undefined = owner;
	while (current && !seen.has(current)) {
		seen.add(current);
		const detail =
			current === owner
				? routeUuid
				: current === parent && route?.parentCaseModuleUuid
					? route.parentCaseModuleUuid
					: current;
		path.push({ source: current, detail });
		current = doc.modules[current]?.parentCaseModuleUuid;
	}
	return path.reverse();
}
