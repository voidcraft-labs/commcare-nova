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
	type ModuleScreenLanding,
	makeTranslationUnitId,
	menuFormUuidsOf,
	menuScreenEntries,
	menuScreenOf,
	menuTileScreenOf,
	moduleHasCaseListMenuItem,
	moduleHasOwnScreen,
	moduleScreenLanding,
	moduleShowsFormsInMenuAbove,
	screenChoosesCaseFirst,
	screenIsBareCaseList,
	type TranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import { menuWithInheritedCaseSettings } from "@/lib/domain/listedForms";
import {
	type ModuleHierarchySource,
	moduleParent,
	moduleSiblingUuids,
} from "@/lib/domain/moduleHierarchy";
import { caseListEntryStillNeedsDatum } from "@/lib/preview/engine/caseListEntryListing";
import { previewDataRefusalOf } from "@/lib/preview/engine/dataRefusal";
import { previewExpressionContext } from "@/lib/preview/engine/expressionContext";
import type {
	PreviewCaseChoice,
	PreviewFormChosenAfterCase,
	PreviewMenuCaseSelection,
} from "@/lib/session/types";
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

/** A menu source that can also say which screens choose their case first
 *  (`menuScreens.ts::screenChoosesCaseFirst`, which reads the whole
 *  document): the document itself, or a menu source carrying it. The
 *  session's order of choices reads it. */
export type PreviewSessionSource =
	| (PreviewMenuSource & { readonly doc: BlueprintDoc })
	| BlueprintDoc;

function sessionDocument(source: PreviewSessionSource): BlueprintDoc {
	return "doc" in source ? source.doc : source;
}

function sessionMenuSource(source: PreviewSessionSource): PreviewMenuSource {
	if ("doc" in source) return source;
	const caseTypes = source.caseTypes;
	return caseTypes === null
		? { ...source, caseTypes: [] }
		: { ...source, caseTypes };
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
	const mod = menuWithInheritedCaseSettings(doc, moduleUuid);
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
	doc: BlueprintDoc,
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

/**
 * A visibility per module, each read only when asked and then kept. Core reads
 * a menu's condition only on a screen that lists that menu or is its own
 * (`MenuLoader.getMenuDisplayables`), so a condition Core refuses there, one
 * that reads data the device lacks, stops only those screens: a screen asks
 * for the menus it shows, and no other. A refusal is thrown again at every
 * read. Iterating reads every module.
 */
class LazyModuleVisibility
	implements ReadonlyMap<Uuid, NavigationItemVisibility>
{
	readonly #order: readonly Uuid[];
	readonly #members: ReadonlySet<Uuid>;
	readonly #read: (uuid: Uuid) => NavigationItemVisibility;
	readonly #kept = new Map<
		Uuid,
		{ readonly value: NavigationItemVisibility } | { readonly error: unknown }
	>();

	constructor(
		order: readonly Uuid[],
		read: (uuid: Uuid) => NavigationItemVisibility,
	) {
		this.#order = order;
		this.#members = new Set(order);
		this.#read = read;
	}

	get(uuid: Uuid): NavigationItemVisibility | undefined {
		if (!this.#members.has(uuid)) return undefined;
		let kept = this.#kept.get(uuid);
		if (kept === undefined) {
			try {
				kept = { value: this.#read(uuid) };
			} catch (error) {
				kept = { error };
			}
			this.#kept.set(uuid, kept);
		}
		if ("error" in kept) throw kept.error;
		return kept.value;
	}

	has(uuid: Uuid): boolean {
		return this.#members.has(uuid);
	}

	get size(): number {
		return this.#order.length;
	}

	#all(): Map<Uuid, NavigationItemVisibility> {
		return new Map(
			this.#order.map((uuid) => [uuid, this.get(uuid) ?? "shown"] as const),
		);
	}

	entries() {
		return this.#all().entries();
	}

	keys() {
		return this.#all().keys();
	}

	values() {
		return this.#all().values();
	}

	[Symbol.iterator]() {
		return this.#all()[Symbol.iterator]();
	}

	forEach(
		callback: (
			value: NavigationItemVisibility,
			key: Uuid,
			map: ReadonlyMap<Uuid, NavigationItemVisibility>,
		) => void,
		thisArg?: unknown,
	): void {
		for (const [uuid, value] of this.#all())
			callback.call(thisArg, value, uuid, this);
	}
}

/**
 * Module visibility for choosing which screen a location runs, which happens
 * outside every screen: a menu whose condition Core refuses
 * (`engine/dataRefusal.ts`) reads as not shown, so the location lands on a
 * screen above it, which reads that condition itself and shows the refusal as
 * a phone does. Any other error still throws.
 */
export function previewRoutingModuleVisibility(
	doc: ModuleHierarchySource,
	visibility: ReadonlyMap<Uuid, NavigationItemVisibility>,
): ReadonlyMap<Uuid, NavigationItemVisibility> {
	return new LazyModuleVisibility(doc.moduleOrder, (uuid) => {
		try {
			return visibility.get(uuid) ?? "shown";
		} catch (error) {
			if (previewDataRefusalOf(error) !== undefined) return "hidden";
			throw error;
		}
	});
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
	const tiles: LazyModuleVisibility = new LazyModuleVisibility(
		doc.moduleOrder,
		(uuid) => {
			const ownVisibility = own.get(uuid) ?? "shown";
			const parentUuid = moduleParent(doc, uuid);
			if (
				parentUuid === undefined ||
				parentUuid === null ||
				moduleShowsFormsInMenuAbove(doc.modules[parentUuid])
			)
				return ownVisibility;
			return combineNavigationVisibility(
				tiles.get(parentUuid) ?? own.get(parentUuid) ?? "shown",
				ownVisibility,
			);
		},
	);
	return tiles;
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
 * once, when first asked (`LazyModuleVisibility`). Edit mode keeps
 * authoring surfaces reachable, so every module is shown there. A module off
 * the menu is hidden without its condition being read. */
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
	return new LazyModuleVisibility(doc.moduleOrder, (uuid) => {
		const mod = menuWithInheritedCaseSettings(doc, uuid);
		return args.authoring || mod === undefined
			? "shown"
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
				});
	});
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
 * same-type reuse. The explicit parent selection independently names the menu
 * whose selection a child carries or requests.
 */
export function previewMenuCaseContext(
	doc: PreviewMenuSource,
	moduleUuid: Uuid,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
): PreviewMenuCaseContext {
	const mod = menuWithInheritedCaseSettings(doc, moduleUuid);
	if (!mod) return emptyCaseContext();

	const direct = matchingSelection(selections[moduleUuid], mod.caseType);
	const structuralParentUuid = moduleParent(doc, moduleUuid);
	const structuralParentSelection =
		structuralParentUuid === undefined || structuralParentUuid === null
			? undefined
			: matchingSelection(
					selections[structuralParentUuid],
					menuWithInheritedCaseSettings(doc, structuralParentUuid)?.caseType,
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

/** Choosing in one menu clears later selections that depend on that menu's
 * navigation or case selection. Two menus can select the same case type
 * independently. A catalog relationship alone creates no dependency. */
export function dependentMenuSelectionUuids(
	doc: ModuleHierarchySource,
	selectedModuleUuid: Uuid,
): Uuid[] {
	const affected = new Set<Uuid>([selectedModuleUuid]);
	for (const uuid of affected) {
		for (const candidate of doc.moduleOrder) {
			const module = doc.modules[candidate];
			if (
				module?.parentCaseModuleUuid === uuid ||
				module?.parentModuleUuid === uuid
			)
				affected.add(candidate);
		}
	}
	affected.delete(selectedModuleUuid);
	return doc.moduleOrder.filter((uuid) => affected.has(uuid));
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

/**
 * The form that opens once a case is chosen: the form the worker chose
 * before the case, or a link's or a retained command's, where it is one of
 * the list's forms; otherwise none, and the menu lists its forms, however
 * many it shows. A form's command names its entry, which needs nothing more
 * once the case is chosen, so the form opens and no menu is listed, which
 * means no display condition is read: Core reads a command's condition only
 * as `MenuLoader` lists a menu (`addRelevantCommandEntries`), never as the
 * session steps past a datum. A menu's command names no entry, so
 * `CommCareSession.getNeededData` asks for a command even where the menu
 * holds one form (`getEntryForCommand` of the menu's id is null). Neither
 * platform advances past such a menu by itself: Android opens `MenuActivity`
 * on `STATE_COMMAND_ID` (`HomeScreenBaseActivity.handleGetCommand`), and
 * Formplayer only under the app property `cc-auto-advance-menu`
 * (`FormplayerPropertyManager.isAutoAdvanceMenu`, no by default), which Nova
 * never writes.
 */
export function previewRequestedForm(
	formUuids: readonly Uuid[],
	requestedFormUuid?: Uuid,
): Uuid | undefined {
	return requestedFormUuid !== undefined &&
		formUuids.includes(requestedFormUuid)
		? requestedFormUuid
		: undefined;
}

/** What choosing a case on a module's case list goes on to. */
export type PreviewCaseListContinuation =
	/** A menu holds the case: the module's own menu screen, whose submenus
	 *  are listed once it is chosen, or the menu that asked this list for its
	 *  parent case. */
	| "menu-selection"
	/** The list was opened from its case list menu entry, which holds no
	 *  form, so nothing opens (`caseListMenuItemSelection`). */
	| "menu-entry"
	/** A form requested before the case opens once it is chosen
	 *  (`previewRequestedForm`). */
	| "form"
	/** The list's own form menu lists the module's forms for the case. */
	| "form-menu";

/**
 * Where a case list goes once its case is chosen. A list opened with no form
 * requested is its module's case selection on a case-first screen, which
 * continues into the module's menu: its own menu screen where it has
 * submenus, else its own form menu. A list reached through its case list
 * menu entry (a bare case list, a forms-first menu's entry, or the entry a
 * case-first screen lists of a menu showing its forms there that goes on
 * past the screen's case, `previewCaseListMenuEntry`) holds no form.
 * `CaseListScreen` and the menu-screens evidence producer both read this.
 */
export function previewCaseListContinuation(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	request: {
		/** The form the list holds, chosen before the case
		 *  (`previewCaseListFormRequest`). */
		readonly seededFormUuid?: Uuid;
		/** The form of a retained command (`PreviewTaskContinuation`). */
		readonly retainedFormUuid?: Uuid;
		/** Another menu asked this list for its parent case. */
		readonly selectsForParentRequest?: boolean;
	} = {},
): PreviewCaseListContinuation {
	const mod = menuWithInheritedCaseSettings(doc, moduleUuid);
	if (request.selectsForParentRequest === true) return "menu-selection";
	const hasChildren = moduleHasChildren(doc, moduleUuid);
	const listingScreen = menuScreenOf(doc, moduleUuid);
	const openedFromMenuEntry =
		mod !== undefined &&
		moduleHasCaseListMenuItem(mod) &&
		request.seededFormUuid === undefined &&
		request.retainedFormUuid === undefined &&
		(screenIsBareCaseList(doc, listingScreen)
			? !hasChildren
			: !screenChoosesCaseFirst(doc, listingScreen) ||
				(listingScreen.kind === "menu" &&
					listingScreen.moduleUuid !== moduleUuid &&
					previewCaseListMenuEntry(doc, moduleUuid, {
						isCaseFirst: true,
						hasSelectedCase: true,
					}) !== undefined));
	if (openedFromMenuEntry) return "menu-entry";
	if (request.seededFormUuid === undefined && hasChildren)
		return "menu-selection";
	return (request.seededFormUuid ?? request.retainedFormUuid) !== undefined
		? "form"
		: "form-menu";
}

/**
 * Where a module's route lands in the running app, read from the module and
 * the case its menu holds: the case list until a case-first screen's case is
 * chosen, then the menu (`navigation.ts::moduleScreenLanding`). `ModuleScreen`
 * and the menu-screens evidence producer both read this.
 */
export function previewMenuScreenLanding(
	source: PreviewMenuSource & { readonly doc: BlueprintDoc },
	moduleUuid: Uuid,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
	args: {
		readonly mode: "edit" | "preview";
		readonly preserveEntryPointMenu?: boolean;
	},
): ModuleScreenLanding {
	return moduleScreenLanding({
		...(args.preserveEntryPointMenu !== undefined && {
			preserveEntryPointMenu: args.preserveEntryPointMenu,
		}),
		hasModule: source.modules[moduleUuid] !== undefined,
		hasChildren: moduleHasChildren(source, moduleUuid),
		hasSelectedCase:
			previewMenuCaseContext(source, moduleUuid, selections).selectedCase !==
			undefined,
		isBareCaseList: previewModuleScreenIsBareCaseList(source.doc, moduleUuid),
		isCaseFirst:
			moduleHasOwnScreen(source.doc, moduleUuid) &&
			screenChoosesCaseFirst(source.doc, { kind: "menu", moduleUuid }),
		mode: args.mode,
	});
}

/** The case target a case list reads: the form it names, the cases the form
 *  opens, and, where the worker chose the form from a menu after its case,
 *  the module whose case list chose that case (`PreviewCaseTarget`). */
export interface PreviewCaseListTarget {
	readonly formUuid: Uuid;
	readonly cases?: readonly PreviewCaseChoice[];
	readonly formChosenAfterCase?: PreviewFormChosenAfterCase;
}

/** The mark of a form the worker chose from a case list's own form menu
 *  after choosing its case there (`CaseListScreen`). */
export function previewCaseListMenuChoice(
	caseListModuleUuid: Uuid,
): PreviewFormChosenAfterCase {
	return { caseListModuleUuid, fromCaseListMenu: true };
}

/** The mark of a form the worker chose from a menu screen after its case
 *  (`ModuleScreen`): the list that chose the case is the form's own module's
 *  or a parent's whose case the form's menu goes on with
 *  (`previewMenuCaseContext`'s `selectedByModuleUuid`). */
export function previewMenuScreenChoice(
	source: PreviewMenuSource,
	formModuleUuid: Uuid,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
): PreviewFormChosenAfterCase {
	return {
		caseListModuleUuid:
			previewMenuCaseContext(source, formModuleUuid, selections)
				.selectedByModuleUuid ?? formModuleUuid,
	};
}

/**
 * The form a case list holds for the case chosen on it: the target's form,
 * where it is one of the list's case-loading forms and the worker chose it
 * before the case (a forms-first menu's form, a link's, a retained task's);
 * otherwise none. A form chosen from a menu after its case sits above the
 * case in the session, so a list a device reaches back to holds no form:
 * `CommCareSession.stepBack` pops the form's command and stops on the menu,
 * which waits for a command (`shouldPopNext`), a second step back pops the
 * case, and choosing a case on the list lists the menu again.
 */
export function previewCaseListFormRequest(
	target: PreviewCaseListTarget | undefined,
	caseLoadingFormUuids: readonly Uuid[],
): Uuid | undefined {
	if (target === undefined || target.formChosenAfterCase !== undefined)
		return undefined;
	return caseLoadingFormUuids.includes(target.formUuid)
		? target.formUuid
		: undefined;
}

/**
 * Where a route from a form back to a case list goes, and the case target it
 * leaves there, so the next case chosen continues as a device's would. A form
 * the worker chose before its case returns to its own module's list holding
 * the form again, since the case sits above the form's command. A form the
 * worker chose from a menu after its case returns to the list that chose the
 * case, the form's own or a parent's whose case its menu goes on with,
 * holding nothing: that list continues into the menu the case opens, never
 * into a form, and once it shows nothing is chosen.
 */
export function previewCaseListReturn(
	target: PreviewCaseListTarget | undefined,
	form: { readonly moduleUuid: Uuid; readonly formUuid: Uuid },
): {
	readonly moduleUuid: Uuid;
	readonly target: { readonly formUuid: Uuid } | undefined;
} {
	const chosenAfter =
		target?.formUuid === form.formUuid ? target.formChosenAfterCase : undefined;
	return chosenAfter !== undefined
		? { moduleUuid: chosenAfter.caseListModuleUuid, target: undefined }
		: { moduleUuid: form.moduleUuid, target: { formUuid: form.formUuid } };
}

/** A case list's own form menu, held with its chosen cases: the step of
 *  the session between choosing the cases on the list and choosing a form,
 *  which Preview keeps on its own history entry, the cases in that entry's
 *  record in the worker's Preview session that took the step
 *  (`lib/routing/previewHeldMenu.ts`, `previewEntryRecords.ts`). */
export interface PreviewHeldCaseListMenu {
	readonly moduleUuid: Uuid;
	readonly cases: readonly PreviewCaseChoice[];
}

/**
 * The cases a case list shows its form menu for: those the step it shows
 * holds, where the worker chose them on this list and the list goes on into
 * its own form menu, and none otherwise. Choosing the cases opens that step,
 * and choosing a form from its menu opens the form above it, so a step back
 * off the form lands on the menu with the cases held
 * (`CommCareSession.stepBack` pops the form's command and stops where the
 * session waits for a command, `shouldPopNext`), and a step back off the
 * menu reaches the list with nothing chosen. A list that continues into a
 * menu of its own (a module with submenus) holds the case on that menu
 * instead, so its list holds nothing here. `held` is what the entry shows in
 * the session running now, so a step another session took is not there: a
 * case the previous worker, platform or Preview run chose has no standing in
 * the session running now.
 */
export function previewCaseListHeldChoices(
	held: PreviewHeldCaseListMenu | undefined,
	list: {
		readonly moduleUuid: Uuid;
		/** What choosing a case on the list goes on to
		 *  (`previewCaseListContinuation`). */
		readonly continuation: PreviewCaseListContinuation;
	},
): readonly PreviewCaseChoice[] | undefined {
	if (
		held === undefined ||
		list.continuation !== "form-menu" ||
		held.moduleUuid !== list.moduleUuid ||
		held.cases.length === 0
	)
		return undefined;
	return held.cases;
}

/** A case the session holds, with the module whose case list chose it. */
export interface PreviewHeldCaseSelection {
	readonly moduleUuid: Uuid;
	readonly cases: readonly PreviewCaseChoice[];
	/** Present on a parent case a menu's command asked for, chosen after
	 *  that command: the menu. Its list may be on the trail or off it; either
	 *  way the case follows the menu's command in the session, as
	 *  `CommCareSession.getNeededData` asks for the entry's datums only once
	 *  its command is chosen. */
	readonly askedForBy?: Uuid;
}

/**
 * The cases the session holds as a module's command is chosen, in the order
 * they were chosen. The command is listed on the screen that lists the
 * module's entry (its parent's screen, or the first menu, which holds no
 * case), or for a menu that shows its forms in the menu above, on the screen
 * that lists those forms. A screen that chooses its case first
 * (`menuScreens.ts::screenChoosesCaseFirst`) holds every case its menu holds
 * before it lists anything (`previewMenuHeldSelections`); a forms-first
 * screen holds only what was chosen before its own command, because a case
 * its list chose there came after a command it listed (a submenu's, asking
 * for its parent case). A device's frame is `[menu, case, submenu, …]` under
 * a case-first menu and `[menu, submenu, case, …]` under a forms-first one.
 */
export function previewSelectionsBeforeCommand(
	source: PreviewSessionSource,
	moduleUuid: Uuid,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
): PreviewHeldCaseSelection[] {
	const doc = sessionDocument(source);
	const screen = moduleHasOwnScreen(doc, moduleUuid)
		? menuTileScreenOf(doc, moduleUuid)
		: menuScreenOf(doc, moduleUuid);
	if (
		screen === undefined ||
		screen.kind === "first-menu" ||
		screen.moduleUuid === moduleUuid
	)
		return [];
	return screenChoosesCaseFirst(doc, screen)
		? previewMenuHeldSelections(source, screen.moduleUuid, selections)
		: previewSelectionsBeforeCommand(source, screen.moduleUuid, selections);
}

/**
 * The cases the session holds before a module's own case is chosen, in the
 * order they were chosen: those held as its command was chosen
 * (`previewSelectionsBeforeCommand`), then its parent case and that one's
 * parent before it (`previewMenuCaseContext`'s `parentCase`), which its
 * command asked for (`askedForBy`), each module once. A case a case-first
 * menu above chose stays a step of the session whatever the submenu's case
 * type: a device's frame holds `[menu, case, submenu, …]`, and Formplayer's
 * `MenuSessionRunnerService.getStepToFrame` and Android's
 * `BreadcrumbBarHelper.loadTile` read that case's datum, through
 * `CommCareSession.findDatumDefinition` over the menu's own entries, on every
 * screen after it. The wire's entry lists the parent chain root first
 * (`formLinkProjection.ts::entrySessionDatums`).
 */
export function previewSelectionsBefore(
	source: PreviewSessionSource,
	moduleUuid: Uuid,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
): PreviewHeldCaseSelection[] {
	const held = previewSelectionsBeforeCommand(source, moduleUuid, selections);
	const heldModules = new Set<string>(
		held.map((selection) => selection.moduleUuid),
	);
	return [
		...held,
		...previewParentCaseChain(sessionMenuSource(source), moduleUuid, selections)
			.filter((selection) => !heldModules.has(selection.moduleUuid))
			.map((selection) => ({ ...selection, askedForBy: moduleUuid })),
	];
}

/** A module's parent case, chosen first, and that one's parent before it,
 *  root first (`previewMenuCaseContext`'s `parentCase`). */
function previewParentCaseChain(
	source: PreviewMenuSource,
	moduleUuid: Uuid,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
): PreviewHeldCaseSelection[] {
	const chain: PreviewHeldCaseSelection[] = [];
	const seen = new Set<string>([moduleUuid]);
	let current: Uuid = moduleUuid;
	for (;;) {
		const context = previewMenuCaseContext(source, current, selections);
		const parent = context.parentModuleUuid;
		if (
			context.parentCase === undefined ||
			parent === undefined ||
			seen.has(parent)
		)
			break;
		seen.add(parent);
		chain.unshift({ moduleUuid: parent, cases: context.parentCase.cases });
		current = parent;
	}
	return chain;
}

/**
 * The cases a module's menu holds, in the order they were chosen: those
 * chosen before its own (`previewSelectionsBefore`), then its own where it is
 * chosen, with the list that chose it (its own, or the menu above whose
 * same-type case it goes on with).
 */
export function previewMenuHeldSelections(
	source: PreviewSessionSource,
	moduleUuid: Uuid,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
): PreviewHeldCaseSelection[] {
	const context = previewMenuCaseContext(
		sessionMenuSource(source),
		moduleUuid,
		selections,
	);
	if (context.selectedCase === undefined)
		return previewSelectionsBefore(source, moduleUuid, selections);
	const own: PreviewHeldCaseSelection = {
		moduleUuid: context.selectedByModuleUuid ?? moduleUuid,
		cases: context.selectedCase.cases,
	};
	return [
		...previewSelectionsBefore(source, moduleUuid, selections).filter(
			(selection) => selection.moduleUuid !== own.moduleUuid,
		),
		own,
	];
}

/**
 * The case target a route to a menu or to the first menu leaves (a
 * breadcrumb): a case the worker chose before choosing a form from the menu
 * the case opened is no longer held on any list, as Web Apps' breadcrumb
 * ends the session's steps at the screen it names. Every other target stays.
 */
export function previewTargetAboveForm<T extends PreviewCaseListTarget>(
	target: T | undefined,
): T | undefined {
	return target?.formChosenAfterCase === undefined ? target : undefined;
}

/**
 * The menus whose chosen cases a route to a screen lets go, as Web Apps'
 * breadcrumb cuts the session's selections back to the step it names
 * (`spliceSelections`). The session is one path: the cases held as the
 * screen's menu's command was chosen precede it and stay
 * (`previewSelectionsBeforeCommand`: those a case-first menu above chose,
 * never a parent case a forms-first menu's list chose for this menu, which
 * its command asked for), and every other case is chosen after it or on no
 * path to it, and goes. `through` keeps everything the screen's menu holds
 * (`previewMenuHeldSelections`): the crumb of a case names the screen with
 * that case chosen. `keeps` names the menus whose cases the session chose up
 * to the crumb, a parent case a list off the trail chose among them, which
 * precede the cut wherever their lists are.
 */
export function previewMenuSelectionsLetGo(
	source: PreviewSessionSource,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
	screen: {
		readonly moduleUuid: Uuid | undefined;
		readonly through?: boolean;
		readonly keeps?: readonly Uuid[];
	},
): Uuid[] {
	const kept = new Set<string>(screen.keeps ?? []);
	const menu = screen.moduleUuid;
	if (menu !== undefined) {
		if (screen.through === true) kept.add(menu);
		const held =
			screen.through === true
				? previewMenuHeldSelections(source, menu, selections)
				: previewSelectionsBeforeCommand(source, menu, selections);
		for (const selection of held) kept.add(selection.moduleUuid);
	}
	return Object.keys(selections).filter((uuid) => !kept.has(uuid)) as Uuid[];
}

/** A module's case list as its own entry on the module's menu
 *  (`Module.caseListMenuItem`), listed after its forms as HQ's suite lists
 *  the case list command after the form commands (`suite_xml/sections/menus.py`).
 *  Choosing it opens the case list. */
export interface PreviewCaseListMenuEntry {
	/** The entry's label unit: the item's own label when it has one, else the
	 *  module's name, with its translations (`emissionPlan.ts::caseListMenuItemLabelUnit`). */
	readonly labelUnitId: TranslationUnitId;
	/** The label's source text, shown when no translation applies. */
	readonly label: string;
	readonly icon: ModuleIconRef | undefined;
	readonly audioLabel: MediaAssetId | undefined;
}

/**
 * The module's case list entry as an authoring surface shows it, or
 * undefined where the module has none to show: a module without the item or
 * a case type, and a bare case list screen (the screen is its list, so it
 * keeps its landing). Edit mode lists it after the forms whatever the
 * running app does.
 */
export function caseListMenuEntryOf(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
): PreviewCaseListMenuEntry | undefined {
	const mod = menuWithInheritedCaseSettings(doc, moduleUuid);
	if (
		mod === undefined ||
		mod.caseType === undefined ||
		!moduleHasCaseListMenuItem(mod) ||
		screenIsBareCaseList(doc, menuScreenOf(doc, moduleUuid))
	)
		return undefined;
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
	};
}

/**
 * The module's case list entry as the running screen that lists it shows
 * it, or undefined where that screen lists none. CommCare lists the entry
 * only while the session still needs one of its datums
 * (`engine/caseListEntryListing.ts::caseListEntryStillNeedsDatum`): a
 * case-first screen lists nothing before its case is chosen, and once it is
 * chosen lists the entry only where the entry goes on to choose a case past
 * the one chosen (a parent's child, say); its own menu's entry, which
 * chooses exactly that case, is not listed. `isCaseFirst` is the answer of
 * that screen (`menuScreens.ts::screenChoosesCaseFirst`).
 */
export function previewCaseListMenuEntry(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	args: { readonly isCaseFirst: boolean; readonly hasSelectedCase: boolean },
): PreviewCaseListMenuEntry | undefined {
	if (args.isCaseFirst && !args.hasSelectedCase) return undefined;
	const entry = caseListMenuEntryOf(doc, moduleUuid);
	return entry !== undefined && caseListEntryStillNeedsDatum(doc, moduleUuid)
		? entry
		: undefined;
}
