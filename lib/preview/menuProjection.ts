import {
	type BlueprintDoc,
	type CaseType,
	caseSelectionCanFlowBetweenModules,
	conditionModulesOf,
	type Form,
	type MediaAssetId,
	type MenuScreen,
	type MenuScreenEntry,
	type MenuScreenSource,
	type Module,
	type ModuleIconRef,
	makeTranslationUnitId,
	menuFormUuidsOf,
	menuScreenEntries,
	menuScreenOf,
	menuTileScreenOf,
	moduleHasCaseListMenuItem,
	moduleHasOwnScreen,
	moduleShowsFormsInMenuAbove,
	screenChoosesCaseFirst,
	screenIsBareCaseList,
	type TranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import {
	type ModuleHierarchySource,
	moduleParent,
	moduleSiblingUuids,
} from "@/lib/domain/moduleHierarchy";
import { previewExpressionContext } from "@/lib/preview/engine/expressionContext";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import {
	formDisplayVisibility,
	moduleDisplayVisibility,
	type NavigationDeviceCases,
	type NavigationItemVisibility,
	type NavigationSelectedCase,
} from "./engine/displayConditionEvaluation";
import type { PreviewSearchSessionValues } from "./engine/identity";
import type { PreviewScreen } from "./engine/types";
import type { PreviewLookupStatus } from "./engine/useLookupPreviewData";

export interface PreviewMenuSource extends ModuleHierarchySource {
	readonly caseTypes: readonly CaseType[];
	readonly forms: Readonly<Record<string, Form>>;
	readonly formOrder: Readonly<Record<string, readonly Uuid[]>>;
}

/** Everything one running screen lists, in the order a worker meets it:
 *  the menus with a screen of their own as tiles, and the forms and case list
 *  entries of every menu whose forms list there
 *  (`menuScreens.ts::menuScreenEntries`). */
export function previewScreenEntries(
	doc: MenuScreenSource,
	screen: MenuScreen,
): MenuScreenEntry[] {
	return menuScreenEntries(doc, screen);
}

/** What the builder's authoring surfaces list for a screen in edit mode,
 *  where every menu stays a container of its own forms: Home lists every
 *  top-level menu, and a menu its own forms, its case list entry and its
 *  submenus, whether or not a menu shows its forms in the menu above. */
export function authoringScreenEntries(
	doc: MenuScreenSource,
	screen: MenuScreen,
): MenuScreenEntry[] {
	if (screen.kind === "first-menu")
		return moduleSiblingUuids(doc, null).map((moduleUuid) => ({
			kind: "menu",
			moduleUuid,
		}));
	const { moduleUuid } = screen;
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) return [];
	return [
		...menuFormUuidsOf(doc, moduleUuid).map(
			(formUuid): MenuScreenEntry => ({ kind: "form", moduleUuid, formUuid }),
		),
		...(moduleHasCaseListMenuItem(mod)
			? [{ kind: "case-list", moduleUuid } as const]
			: []),
		...moduleSiblingUuids(doc, moduleUuid).map(
			(child): MenuScreenEntry => ({ kind: "menu", moduleUuid: child }),
		),
	];
}

/** The modules whose screens a worker passes through to reach `screen`,
 *  top first: each one's tile is chosen on the screen above it. */
export function previewScreenPath(
	doc: MenuScreenSource,
	screen: MenuScreen,
): Uuid[] {
	const path: Uuid[] = [];
	let current: MenuScreen | undefined = screen;
	while (current?.kind === "menu" && !path.includes(current.moduleUuid)) {
		path.unshift(current.moduleUuid);
		current = menuTileScreenOf(doc, current.moduleUuid);
	}
	return path;
}

/** The modules whose own visibility gates a module's form and case list
 *  entries in the running app: the menus on the way to the screen that lists
 *  them, then the modules whose condition the entries carry
 *  (`menuScreens.ts::conditionModulesOf`), each once. */
export function previewContributorGatingModules(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
): Uuid[] {
	const gating = previewScreenPath(doc, menuScreenOf(doc, moduleUuid));
	for (const uuid of conditionModulesOf(doc, moduleUuid))
		if (!gating.includes(uuid)) gating.push(uuid);
	return gating;
}

/** The modules whose running screen chooses a case before a form, each a
 *  module with a screen of its own (`menuScreens.ts::screenChoosesCaseFirst`). */
export function previewCaseFirstModuleUuids(
	doc: MenuScreenSource,
): ReadonlySet<Uuid> {
	return new Set(
		doc.moduleOrder.filter(
			(moduleUuid) =>
				moduleHasOwnScreen(doc, moduleUuid) &&
				screenChoosesCaseFirst(doc, { kind: "menu", moduleUuid }),
		),
	);
}

/** Whether a module's own screen is a bare case list, which the running app
 *  opens on its list (`menuScreens.ts::screenIsBareCaseList`). */
export function previewModuleScreenIsBareCaseList(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
): boolean {
	return screenIsBareCaseList(doc, { kind: "menu", moduleUuid });
}

/** The running screen a module route lands on: its own where it has one,
 *  else the screen that lists its forms. */
export function previewLandingScreenOf(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
): MenuScreen {
	return moduleHasOwnScreen(doc, moduleUuid)
		? { kind: "menu", moduleUuid }
		: menuScreenOf(doc, moduleUuid);
}

/** The running screen a module screen resolves to: the module's own where
 *  it has one, else the screen that lists its forms, Home for the first
 *  menu. */
export function previewRunningModuleScreen(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
): Extract<PreviewScreen, { type: "home" | "module" }> {
	const screen = previewLandingScreenOf(doc, moduleUuid);
	return screen.kind === "first-menu"
		? { type: "home" }
		: { type: "module", moduleUuid: screen.moduleUuid };
}

/** Boolean conjunction in Preview's three-valued navigation domain.
 * A known false result wins over loading; otherwise loading propagates. */
export function combineNavigationVisibility(
	ancestor: NavigationItemVisibility,
	own: NavigationItemVisibility,
): NavigationItemVisibility {
	if (ancestor === "hidden" || own === "hidden") return "hidden";
	if (ancestor === "pending" || own === "pending") return "pending";
	return "shown";
}

/** Project each module's own condition onto its tile. A tile takes its
 *  parent's visibility only where the parent keeps its own screen: under a
 *  parent that shows its forms above, the tile lists on the first menu by
 *  its own condition alone, as HQ conjoins the parent's filter only for a
 *  submenu that shows its forms above (`menus.py::_generate_menu`). */
export function inheritedModuleVisibility(
	doc: ModuleHierarchySource,
	own: ReadonlyMap<Uuid, NavigationItemVisibility>,
): ReadonlyMap<Uuid, NavigationItemVisibility> {
	const result = new Map<Uuid, NavigationItemVisibility>();
	for (const uuid of doc.moduleOrder) {
		const ownVisibility = own.get(uuid) ?? "shown";
		const parentUuid = moduleParent(doc, uuid);
		if (
			parentUuid === undefined ||
			parentUuid === null ||
			moduleShowsFormsInMenuAbove(doc.modules[parentUuid])
		) {
			result.set(uuid, ownVisibility);
			continue;
		}
		result.set(
			uuid,
			combineNavigationVisibility(
				result.get(parentUuid) ?? own.get(parentUuid) ?? "shown",
				ownVisibility,
			),
		);
	}
	return result;
}

/** Whether a contributor's form and case list rows are on the screen that
 *  lists them: the conjunction of the own visibility of every module whose
 *  condition they carry (`conditionModulesOf`: the module, and its parent
 *  where it shows its forms above), an absent module reading `shown`. Each
 *  form's own condition applies after this. */
export function previewContributorVisibility(
	doc: MenuScreenSource,
	own: ReadonlyMap<Uuid, NavigationItemVisibility>,
	moduleUuid: Uuid,
): NavigationItemVisibility {
	return conditionModulesOf(doc, moduleUuid).reduce<NavigationItemVisibility>(
		(visibility, uuid) =>
			combineNavigationVisibility(visibility, own.get(uuid) ?? "shown"),
		"shown",
	);
}

/** The module whose own visibility takes a contributor's rows off its
 *  screen, for the reveal affordance's summary; undefined while its rows
 *  show or wait. */
export function previewContributorHiddenBy(
	doc: MenuScreenSource,
	own: ReadonlyMap<Uuid, NavigationItemVisibility>,
	moduleUuid: Uuid,
): Uuid | undefined {
	return conditionModulesOf(doc, moduleUuid).find(
		(uuid) => own.get(uuid) === "hidden",
	);
}

/** The reveal affordance's summary for an item that is off the menu, in
 * place of its condition's summary: the flag hides it whatever the condition
 * says. */
export const OFF_THE_MENU_SUMMARY = "Off the menu";

/** Each module's own visibility: its condition and `hiddenFromMenu`, read
 * once. Edit mode keeps authoring surfaces reachable, so every module is
 * shown there. A module off the menu is hidden without its condition being
 * read. */
export function previewModuleOwnVisibility(
	doc: BlueprintDoc,
	args: {
		readonly authoring: boolean;
		readonly session: PreviewSearchSessionValues;
		readonly lookup: PreviewLookupStatus;
		/** The worker's device cases, which a worker property reads; a
		 * condition that reads them stays `pending` without them. */
		readonly deviceCases?: NavigationDeviceCases;
	},
): ReadonlyMap<Uuid, NavigationItemVisibility> {
	return new Map(
		doc.moduleOrder.map((uuid) => {
			const mod = doc.modules[uuid];
			return [
				uuid,
				args.authoring || mod === undefined
					? ("shown" as const)
					: moduleDisplayVisibility({
							condition: mod.displayCondition,
							types: previewExpressionContext(
								doc,
								{ entity: "module", uuid, slot: "module_display_condition" },
								args.lookup.kind === "data" ? args.lookup.data : undefined,
							),
							hiddenFromMenu: mod.hiddenFromMenu === true,
							session: args.session,
							lookup: args.lookup,
							...(args.deviceCases === undefined
								? {}
								: { deviceCases: args.deviceCases }),
						}),
			] as const;
		}),
	);
}

/** The one running-menu tile visibility projection used by tiles and
 * direct-route admission: each module's own visibility
 * (`previewModuleOwnVisibility`) projected onto its tile
 * (`inheritedModuleVisibility`), so a module off the menu takes the tiles of
 * submenus that list on its screen with it. */
export function previewModuleVisibility(
	doc: BlueprintDoc,
	args: Parameters<typeof previewModuleOwnVisibility>[1],
): ReadonlyMap<Uuid, NavigationItemVisibility> {
	return inheritedModuleVisibility(doc, previewModuleOwnVisibility(doc, args));
}

/** A stable key for one entry of a running screen. */
export function menuScreenEntryKey(entry: MenuScreenEntry): string {
	return entry.kind === "form"
		? `form:${entry.formUuid}`
		: `${entry.kind}:${entry.moduleUuid}`;
}

/**
 * Each entry's place on a running screen, keyed by `menuScreenEntryKey`: a
 * tile by its menu's tile visibility (`inheritedModuleVisibility`); a form or
 * case list row by the menus whose condition it carries
 * (`previewContributorVisibility`), then a form by its own condition and
 * `hiddenFromMenu`, reading the case chosen for its menu on this screen.
 * Edit mode hides no form.
 */
export function previewScreenEntryVisibility(args: {
	readonly doc: BlueprintDoc;
	readonly entries: readonly MenuScreenEntry[];
	readonly ownModuleVisibility: ReadonlyMap<Uuid, NavigationItemVisibility>;
	readonly authoring: boolean;
	readonly session: PreviewSearchSessionValues;
	readonly lookup: PreviewLookupStatus;
	readonly deviceCases?: NavigationDeviceCases;
	/** The case chosen for the form's menu on this screen, which its
	 *  condition reads; undefined where none is chosen. */
	readonly selectedCaseOf: (
		entry: Extract<MenuScreenEntry, { kind: "form" }>,
	) => NavigationSelectedCase | undefined;
}): ReadonlyMap<string, NavigationItemVisibility> {
	const { doc } = args;
	const tiles = inheritedModuleVisibility(doc, args.ownModuleVisibility);
	return new Map(
		args.entries.map((entry) => {
			const key = menuScreenEntryKey(entry);
			if (entry.kind === "menu")
				return [key, tiles.get(entry.moduleUuid) ?? "shown"] as const;
			const contributor = previewContributorVisibility(
				doc,
				args.ownModuleVisibility,
				entry.moduleUuid,
			);
			if (entry.kind !== "form" || args.authoring)
				return [key, contributor] as const;
			const form = doc.forms[entry.formUuid];
			if (form === undefined) return [key, contributor] as const;
			return [
				key,
				combineNavigationVisibility(
					contributor,
					formDisplayVisibility({
						condition: form.displayCondition,
						hiddenFromMenu: form.hiddenFromMenu === true,
						session: args.session,
						types: previewExpressionContext(
							doc,
							{
								entity: "form",
								uuid: form.uuid,
								slot: "form_display_condition",
							},
							args.lookup.kind === "data" ? args.lookup.data : undefined,
						),
						selectedCase: args.selectedCaseOf(entry),
						...(args.deviceCases !== undefined && {
							deviceCases: args.deviceCases,
						}),
						lookup: args.lookup,
					}),
				),
			] as const;
		}),
	);
}

/**
 * The hidden entries of a running screen, for the reveal affordance: each
 * entry's name and the summary of what hides it. A tile is summarized by its
 * own menu; a form or case list row by the menu that takes it off the screen
 * (`previewContributorHiddenBy`), else a form by its own condition.
 */
export function previewHiddenScreenEntries(args: {
	readonly doc: BlueprintDoc;
	readonly entries: readonly MenuScreenEntry[];
	readonly visibility: ReadonlyMap<string, NavigationItemVisibility>;
	readonly ownModuleVisibility: ReadonlyMap<Uuid, NavigationItemVisibility>;
	readonly name: (entry: MenuScreenEntry) => string;
	readonly summary: (
		owner: Pick<Module, "hiddenFromMenu" | "displayCondition" | "caseType">,
	) => string | undefined;
}): {
	readonly key: string;
	readonly name: string;
	readonly summary: string | undefined;
}[] {
	const { doc } = args;
	return args.entries.flatMap((entry) => {
		const key = menuScreenEntryKey(entry);
		if (args.visibility.get(key) !== "hidden") return [];
		const hidingModuleUuid =
			entry.kind === "menu"
				? entry.moduleUuid
				: previewContributorHiddenBy(
						doc,
						args.ownModuleVisibility,
						entry.moduleUuid,
					);
		const hidingModule =
			hidingModuleUuid === undefined
				? undefined
				: doc.modules[hidingModuleUuid];
		const form = entry.kind === "form" ? doc.forms[entry.formUuid] : undefined;
		const owner = hidingModule ?? form;
		return owner === undefined
			? []
			: [
					{
						key,
						name: args.name(entry),
						summary: args.summary({
							hiddenFromMenu: owner.hiddenFromMenu,
							displayCondition: owner.displayCondition,
							caseType: hidingModule?.caseType,
						}),
					},
				];
	});
}

export interface PreviewMenuCaseContext {
	/** Case bound to this module menu. May be inherited from its structural
	 * parent when both menus use the same case type. */
	readonly selectedCase: PreviewMenuCaseSelection | undefined;
	readonly selectedByModuleUuid: Uuid | undefined;
	/** A different-type case parent's ordered selection. This constrains the
	 * child population to cases related to any selected parent; it is independent
	 * of the structural menu parent. */
	readonly parentCase: PreviewMenuCaseSelection | undefined;
	readonly parentModuleUuid: Uuid | undefined;
	/** The case-type selector still required before this module can run. */
	readonly requiredParentCase:
		| { readonly caseType: string; readonly moduleUuid: Uuid }
		| undefined;
}

/**
 * Resolve the running menu's case context without confusing the menu tree
 * with the case-type tree. Structural ancestry permits only the deliberate
 * same-type reuse. Case-type ancestry independently finds the module HQ's
 * `parent_select` would use and either carries its selection or requests it.
 */
export function previewMenuCaseContext(
	doc: PreviewMenuSource,
	moduleUuid: Uuid,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
): PreviewMenuCaseContext {
	const mod = doc.modules[moduleUuid];
	if (!mod) return emptyCaseContext();

	const direct = matchingSelection(selections[moduleUuid], mod.caseType);
	const structuralParentUuid = moduleParent(doc, moduleUuid);
	const structuralParentSelection =
		structuralParentUuid === undefined || structuralParentUuid === null
			? undefined
			: matchingSelection(
					selections[structuralParentUuid],
					doc.modules[structuralParentUuid]?.caseType,
				);
	const inherited =
		structuralParentSelection !== undefined &&
		structuralParentSelection.caseType === mod.caseType &&
		structuralParentUuid !== undefined &&
		structuralParentUuid !== null &&
		caseSelectionCanFlowBetweenModules(doc.modules[structuralParentUuid], mod)
			? structuralParentSelection
			: undefined;
	const selectedCase = direct ?? inherited;
	const selectedByModuleUuid = direct
		? moduleUuid
		: inherited
			? (structuralParentUuid ?? undefined)
			: undefined;

	if (!mod.caseType) {
		return {
			...emptyCaseContext(),
			selectedCase,
			selectedByModuleUuid,
		};
	}
	const caseParentModuleUuid = mod.parentCaseModuleUuid;
	const parentCaseType = caseParentModuleUuid
		? doc.modules[caseParentModuleUuid]?.caseType
		: undefined;
	if (!parentCaseType) {
		return {
			...emptyCaseContext(),
			selectedCase,
			selectedByModuleUuid,
		};
	}
	if (!caseParentModuleUuid) {
		return {
			...emptyCaseContext(),
			selectedCase,
			selectedByModuleUuid,
		};
	}
	/* A menu that shows its forms on its parent's screen opens with the case
	 * chosen there as its parent case wherever that case is of its parent
	 * case type, whichever menu `parentCaseModuleUuid` names: the wire gives
	 * both selections one datum id (`menuScreens.ts::screenCaseFirstBlocker`,
	 * rule 4). The parent is that screen's host, its first contributor. */
	const screenHostUuid =
		moduleShowsFormsInMenuAbove(mod) &&
		structuralParentUuid !== undefined &&
		structuralParentUuid !== null &&
		structuralParentUuid !== caseParentModuleUuid &&
		!moduleShowsFormsInMenuAbove(doc.modules[structuralParentUuid])
			? structuralParentUuid
			: undefined;
	const hostSelection =
		screenHostUuid === undefined
			? undefined
			: matchingSelection(selections[screenHostUuid], parentCaseType);
	const ownParentSelection = matchingSelection(
		selections[caseParentModuleUuid],
		parentCaseType,
	);
	const caseParentSelection =
		ownParentSelection === undefined || ownParentSelection.cases.length === 0
			? (hostSelection ?? ownParentSelection)
			: ownParentSelection;
	const parentSelectionModuleUuid =
		caseParentSelection === hostSelection && hostSelection !== undefined
			? (screenHostUuid ?? caseParentModuleUuid)
			: caseParentModuleUuid;
	/* An absent parent selection still needs the ordinary parent-selector
	 * journey. Once selected, the complete ordered set constrains the child
	 * population to the union of direct non-extension children. */
	if (
		caseParentSelection === undefined ||
		caseParentSelection.cases.length === 0
	) {
		return {
			...emptyCaseContext(),
			selectedCase,
			selectedByModuleUuid,
			requiredParentCase: {
				caseType: parentCaseType,
				moduleUuid: caseParentModuleUuid,
			},
		};
	}
	return {
		selectedCase,
		selectedByModuleUuid,
		parentCase: caseParentSelection,
		parentModuleUuid: parentSelectionModuleUuid,
		requiredParentCase: undefined,
	};
}

export function moduleHasChildren(
	doc: ModuleHierarchySource,
	moduleUuid: Uuid,
): boolean {
	return moduleSiblingUuids(doc, moduleUuid).length > 0;
}

/** Module selections made stale by choosing a new case of `ancestorCaseType`.
 * Case ancestry is deliberately independent of menu ancestry, so this walks
 * the case-type graph and then projects matching modules wherever they live in
 * the menu tree. The fixed-point walk is cycle-safe for a malformed snapshot. */
export function previewCaseDescendantModuleUuids(
	doc: PreviewMenuSource,
	ancestorCaseType: string,
): Uuid[] {
	const descendants = new Set<string>();
	for (let pass = 0; pass < doc.caseTypes.length; pass++) {
		let changed = false;
		for (const candidate of doc.caseTypes) {
			if (
				candidate.parent_type !== undefined &&
				(candidate.parent_type === ancestorCaseType ||
					descendants.has(candidate.parent_type)) &&
				!descendants.has(candidate.name)
			) {
				descendants.add(candidate.name);
				changed = true;
			}
		}
		if (!changed) break;
	}
	return doc.moduleOrder.filter((uuid) => {
		const caseType = doc.modules[uuid]?.caseType;
		return caseType !== undefined && descendants.has(caseType);
	});
}

function matchingSelection(
	selection: PreviewMenuCaseSelection | undefined,
	caseType: Module["caseType"],
): PreviewMenuCaseSelection | undefined {
	return selection?.caseType === caseType ? selection : undefined;
}

function emptyCaseContext(): PreviewMenuCaseContext {
	return {
		selectedCase: undefined,
		selectedByModuleUuid: undefined,
		parentCase: undefined,
		parentModuleUuid: undefined,
		requiredParentCase: undefined,
	};
}

/** After record selection, prefer the requested form if it is eligible;
 * otherwise skip the form menu only when exactly one form is known eligible. */
export function previewAutomaticForm(
	entries: readonly {
		readonly form: { readonly uuid: Uuid };
		readonly visibility: NavigationItemVisibility;
	}[],
	requestedFormUuid?: Uuid,
): Uuid | undefined {
	const requested = entries.find(
		(entry) => entry.form.uuid === requestedFormUuid,
	);
	if (requested?.visibility === "shown") return requested.form.uuid;
	const shown = entries.filter((entry) => entry.visibility === "shown");
	return !entries.some((entry) => entry.visibility === "pending") &&
		shown.length === 1
		? shown[0].form.uuid
		: undefined;
}

/** A module's case list as its own entry on the module's menu
 *  (`Module.caseListMenuItem`), listed after its forms as HQ's suite lists
 *  the case list command after the form commands (`suite_xml/sections/menus.py`). */
export interface PreviewCaseListMenuEntry {
	/** The entry's label unit: the item's own label when it has one, else the
	 *  module's name, with its translations (`emissionPlan.ts::caseListMenuItemLabelUnit`). */
	readonly labelUnitId: TranslationUnitId;
	/** The label's source text, shown when no translation applies. */
	readonly label: string;
	readonly icon: ModuleIconRef | undefined;
	readonly audioLabel: MediaAssetId | undefined;
	/**
	 * What choosing the entry does. In a forms-first menu it opens the case
	 * list. In a case-first menu Core asks the datum every entry shares before
	 * the command (`CommCareSession.java::getDataNeededByAllEntries`), so the
	 * case is chosen first and the menu lists the entry beside the forms;
	 * choosing it then is the selection itself.
	 */
	readonly action: "open-case-list" | "selection";
}

/**
 * The module's case list entry as the screen that lists it shows it, or
 * undefined where it lists none: a module without the item or a case type, a
 * bare case list screen (the screen is its list, so it keeps its landing),
 * and a case-first screen before its case is chosen, whose forms are not
 * listed yet either. `isCaseFirst` is the answer of that screen
 * (`menuScreens.ts::screenChoosesCaseFirst`).
 */
export function previewCaseListMenuEntry(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
	args: { readonly isCaseFirst: boolean; readonly hasSelectedCase: boolean },
): PreviewCaseListMenuEntry | undefined {
	const mod = doc.modules[moduleUuid];
	if (
		mod === undefined ||
		mod.caseType === undefined ||
		!moduleHasCaseListMenuItem(mod) ||
		screenIsBareCaseList(doc, menuScreenOf(doc, moduleUuid))
	)
		return undefined;
	if (args.isCaseFirst && !args.hasSelectedCase) return undefined;
	const item = mod.caseListMenuItem;
	const ownLabel = item?.label;
	return {
		labelUnitId:
			ownLabel === undefined
				? makeTranslationUnitId("module", moduleUuid, "name")
				: makeTranslationUnitId(
						"module",
						moduleUuid,
						"case-list-menu-item-label",
					),
		label: ownLabel ?? mod.name,
		icon: item?.icon,
		audioLabel: item?.audioLabel,
		action: args.isCaseFirst ? "selection" : "open-case-list",
	};
}
