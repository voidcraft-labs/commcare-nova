import { printAuthoringIcon } from "@/lib/agent/authoring/icons";
import { detailTabSpans } from "@/lib/domain/detailTabs";
import {
	type AppLanguageIdentity,
	effectiveAppLocalization,
	parseLanguageTag,
} from "@/lib/domain/localization";
import {
	type NavigationMedia,
	navigationFilesInLanguage,
} from "@/lib/domain/navigationMedia";
/**
 * SA tool: `getModule` — read one module's metadata + menu media + case
 * list config + case search config + form summary by stable UUID.
 *
 * Pure read — no mutations, no SSE emission. Useful to the SA mid-edit
 * when it needs to confirm a module's case type, inspect the structured
 * `caseListConfig` / `caseSearchConfig` it has authored, or enumerate
 * its forms without re-reading the whole doc. Both the SA chat factory
 * and the MCP adapter call this the same way.
 *
 * `case_list_config` carries the case-list-config verbatim — including its
 * selection behavior, while every column and search input retains its `uuid`,
 * the SA-facing handle for
 * atomic edits. `case_search_config` carries the wholesale case-search
 * shape (display cluster + advanced cluster); the wholesale-replace
 * `setCaseSearchDisplay` / `setCaseSearchAdvanced` tools read it back
 * as the snapshot they merge into. A fresh-session read here surfaces
 * every authoring handle without a parallel call.
 *
 * `icon` / `audio_label` (on the module AND each form summary) carry the
 * stored menu media. This tool returns canonical values; the authoring read
 * projection prints every built-in icon as the catalog slug `setMenuMedia`
 * accepts, so internal `nova-icon:<slug>` identities never reach a caller. One
 * read covers every tile of the module, matching the batch shape.
 *
 * `display_condition` carries the module's typed condition — the read half of
 * the slot `updateModule` writes. Without it the SA would edit a module blind
 * to a rule governing whether the module appears at all, and would overwrite
 * one it had never been shown. `hidden_from_menu` beside it says whether the
 * module is off the menu whatever its condition, and each form summary says
 * the same of its form.
 *
 * `searchWorkflow` and `formsReadSearch` say what the menu opens on and
 * whether its forms read the search, as the search tools state them;
 * `formsInMenuAbove` says whether the module shows its forms in the menu
 * above, and `listsOn` names the screen that lists them
 * (`lib/domain/menuScreens.ts::menuScreenOf`). `caseListMenuItem` and
 * `caseListRegistrationForm` read the module's two case list slots with
 * their menu media, each built-in icon printed as the slug `setMenuMedia`
 * accepts; `followsFormAfterSubmit` says the offered form's own after-submit
 * is in force from the list (`caseListRegistrationReturnOf` gives `own`).
 * Each form summary's `opensFromCaseList` names the form the list offers
 * after an empty search, and `offeredOnCaseListsOf` the modules whose case
 * lists always offer it (`caseListsOffering`).
 *
 * `advanced` says whether CommCare HQ receives the module as an advanced
 * menu (`lib/commcare/moduleKind.ts::emittedModuleKind`), and `kept` whether
 * that is because a published app holds it so (`Module.heldKind`). No edit
 * chooses the kind, so no input carries it.
 */

import type { z } from "zod";
import { listIconDestinations } from "@/lib/commcare/listIconAction";
import { advancedKindReasons } from "@/lib/commcare/moduleKind";
import { countFieldsUnder, orderedFormUuids } from "@/lib/doc/fieldWalk";
import type {
	BlueprintDoc,
	CaseListConfig,
	CaseListRegistrationReturn,
	CaseSearchConfig,
	FormIconRef,
	FormType,
	MediaAssetId,
	MenuScreen,
	Module,
	ModuleIconRef,
	SearchWorkflow,
	Uuid,
} from "@/lib/domain";
import {
	afterEmptySearchRegistrationFormOf,
	caseListRegistrationReturnOf,
	caseListsOffering,
	childModuleUuids,
	entryPointTargetLabel,
	menuFormUuidsOf,
	menuScreenLayout,
	menuScreenOf,
	menuWithInheritedCaseSettings,
	moduleDestination,
	moduleFormsReadSearch,
	moduleSearchWorkflow,
	moduleShowsFormsInMenuAbove,
	orderedColumns,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression";
import type { MenuBadge } from "@/lib/domain/menuBadge";
import type { ToolInvocationContext } from "../workspace/types";
import type { ReadToolResult } from "./common";
import {
	moduleAddressSchema,
	resolveModuleAddress,
} from "./shared/entityAddresses";

export const getModuleInputSchema = moduleAddressSchema;

export type GetModuleInput = z.infer<typeof getModuleInputSchema>;

/**
 * Per-form summary included in the `getModule` result. `fieldCount`
 * counts fields at every nesting depth so the SA gets a real size signal
 * (a form with three groups of five fields reads as 15, not 3).
 * `icon` is the stored ref; `audio_label` is an uploaded-media UUID.
 */
interface LanguageFiles {
	language: AppLanguageIdentity;
	icon: ReturnType<typeof printAuthoringIcon> | null;
	audio_label: MediaAssetId | null;
}

function languageFiles(
	doc: BlueprintDoc,
	carrier: NavigationMedia | undefined,
): { files_by_language?: LanguageFiles[] } {
	if (!carrier?.mediaByLanguage) return {};
	const app = effectiveAppLocalization(doc.localization);
	return {
		files_by_language: app.languageOrder.map((tag) => {
			const files = navigationFilesInLanguage(carrier, tag, app);
			return {
				language: parseLanguageTag(tag),
				icon: files.icon ? printAuthoringIcon(files.icon) : null,
				audio_label: files.audioLabel ?? null,
			};
		}),
	};
}

export interface GetModuleFormSummary {
	uuid: Uuid;
	name: string;
	type: FormType;
	fieldCount: number;
	icon: FormIconRef | null;
	audio_label: MediaAssetId | null;
	files_by_language?: LanguageFiles[];
	/**
	 * True when the form is its menu's registration from the case list
	 * after an empty search (`caseListRegistrationForm`, the
	 * `after-empty-search` arm): offered on the results after a search finds
	 * nothing, and on no menu.
	 */
	opensFromCaseList: boolean;
	/** The modules whose case lists always offer the form, in module order. */
	offeredOnCaseListsOf: Uuid[];
	/** True when the form is off the menu (`hiddenFromMenu`). */
	hidden_from_menu: boolean;
}

/**
 * Two legal result shapes:
 *
 *   - `{ error }` when the module UUID is not in the app.
 *   - Module snapshot — metadata + menu media + structured case list
 *     config + case search config + per-form summary. Each config field
 *     is `null` when the module has not yet authored that surface (a
 *     survey-only module, or a freshly created case-carrying module
 *     before the corresponding tool family has run).
 */
export type GetModuleResult =
	| { error: string }
	| {
			uuid: Uuid;
			name: string;
			opening: ReturnType<typeof moduleDestination>;
			parent_module_uuid: Uuid | null;
			forms_from_menu: {
				menuUuid: Uuid;
				name: string;
				excludedFormUuids: readonly Uuid[];
			} | null;
			parentCaseModuleUuid: Uuid | null;
			child_module_uuids: Uuid[];
			case_type: string | null;
			icon: ModuleIconRef | null;
			audio_label: MediaAssetId | null;
			files_by_language?: LanguageFiles[];
			display_condition: Expression | null;
			badge: MenuBadge | null;
			/** True when the module is off the menu, with every form in it. */
			hidden_from_menu: boolean;
			/** Present when CommCare HQ receives the module as an advanced
			 *  menu; `kept` when a published app holds it advanced. */
			advanced: { kept: boolean } | null;
			case_list_config: CaseListConfig | null;
			/** For each image column, the deep links (by external ID) of the
			 *  forms a tap on its icon on Results may submit; present only when
			 *  some image column has one. */
			listIconDestinations?: {
				columnUuid: Uuid;
				deepLinks: { id: string; form: string }[];
			}[];
			/** Visible case-list COLUMN uuids, in the order each screen renders them.
			 *  A column's `field` is its case property and is a different identity. */
			results_column_order: Uuid[];
			details_column_order: Uuid[];
			detail_tabs?: { tabUuid: Uuid; title: string; columnUuids: Uuid[] }[];
			case_search_config: CaseSearchConfig | null;
			available_project_searches?: readonly { uuid: string; name: string }[];
			/** What the menu opens on, or `null` where it has no search. */
			searchWorkflow: SearchWorkflow | null;
			/** True when the menu's forms read the search. */
			formsReadSearch: boolean;
			/** The ordinary menu's saved individual choice, including when inactive. */
			menuLayout: "list" | "grid";
			/** The actual layout of the screen containing this module's forms. */
			formsMenuLayout: "list" | "grid";
			/** True when the module shows its forms in the menu above. */
			formsInMenuAbove: boolean;
			/** The screen that lists the module's forms. */
			listsOn: MenuScreen;
			/** The case list as its own menu item; `label` null uses the
			 *  module's name. */
			caseListMenuItem: {
				label: string | null;
				icon: ModuleIconRef | null;
				audio_label: MediaAssetId | null;
				files_by_language?: LanguageFiles[];
			} | null;
			/** The registration the case list offers; `label` null uses the
			 *  form's name. */
			caseListRegistrationForm: CaseListRegistrationRead | null;
			forms: GetModuleFormSummary[];
	  };

/** The registration a case list offers, as `getModule` reads it. The
 *  `always` arm adds where a worker goes after registering, whether the
 *  form's own after-submit is in force from the list, and the Register
 *  button's media. */
export type CaseListRegistrationRead =
	| {
			kind: "after-empty-search";
			formUuid: Uuid;
			label: string | null;
			afterSubmit: CaseListRegistrationReturn;
			followsFormAfterSubmit: boolean;
	  }
	| {
			kind: "always";
			formUuid: Uuid;
			target?: import("@/lib/domain").CaseListActionTarget;
			showWhen?: import("@/lib/domain").AlwaysOfferedRegistration["showWhen"];
			label: string | null;
			afterSubmit: CaseListRegistrationReturn;
			followsFormAfterSubmit: boolean;
			icon: FormIconRef | null;
			audio_label: MediaAssetId | null;
			files_by_language?: LanguageFiles[];
	  };

function caseListRegistrationRead(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): CaseListRegistrationRead | null {
	const slot = doc.modules[moduleUuid]?.caseListRegistrationForm;
	if (slot === undefined) return null;
	if (slot.kind === "after-empty-search")
		return {
			kind: slot.kind,
			formUuid: slot.formUuid,
			label: slot.label ?? null,
			afterSubmit: slot.afterSubmit ?? "case-list",
			followsFormAfterSubmit:
				caseListRegistrationReturnOf(doc, moduleUuid)?.kind === "own",
		};
	return {
		kind: slot.kind,
		formUuid: slot.formUuid,
		label: slot.label ?? null,
		afterSubmit: slot.afterSubmit,
		...(slot.target && { target: slot.target }),
		...(slot.showWhen && { showWhen: slot.showWhen }),
		followsFormAfterSubmit:
			caseListRegistrationReturnOf(doc, moduleUuid)?.kind === "own",
		...languageFiles(doc, slot),
		icon: slot.icon ?? null,
		audio_label: slot.audioLabel ?? null,
	};
}

/** Whether CommCare HQ receives `moduleUuid` as an advanced menu, and
 *  whether a published app keeps it so: the read `getModule` and the
 *  snapshot give. */
export function moduleAdvancedRead(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): { kept: boolean } | null {
	const reasons = advancedKindReasons(doc, moduleUuid);
	if (reasons.length === 0) return null;
	return { kept: reasons.some((reason) => reason.kind === "held") };
}

export const getModuleTool = {
	description:
		"Read a module, its child menus, forms, Results and Details configuration, Search and normal opening screen.",
	inputSchema: getModuleInputSchema,
	async execute(
		input: GetModuleInput,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<GetModuleResult>> {
		const doc = ctx.snapshot.doc;
		const resolved = resolveModuleAddress(doc, input);
		if (!resolved.ok) {
			return {
				kind: "read",
				data: { error: resolved.error },
			};
		}
		const { moduleUuid } = resolved;
		const mod =
			menuWithInheritedCaseSettings(doc, moduleUuid) ?? resolved.module;
		const formUuids = mod.formsFromMenu
			? menuFormUuidsOf(doc, moduleUuid)
			: orderedFormUuids(doc, moduleUuid);
		const caseListConfig = mod.caseListConfig;
		const caseSearchConfig = mod.caseSearchConfig;
		// Each screen's own sequence — the SA addresses a column by naming the
		// one it should follow, so a storage-order read would misplace it.
		const resultsColumns =
			caseListConfig === undefined
				? []
				: orderedColumns(caseListConfig, "list");
		const detailsColumns =
			caseListConfig === undefined
				? []
				: orderedColumns(caseListConfig, "detail");
		const shownDetails = detailsColumns.filter(
			(column) => column.visibleInDetail !== false,
		);
		return {
			kind: "read",
			data: {
				uuid: moduleUuid,
				name: mod.name,
				forms_from_menu: mod.formsFromMenu
					? {
							menuUuid: mod.formsFromMenu.menuUuid,
							name: doc.modules[mod.formsFromMenu.menuUuid].name,
							excludedFormUuids: mod.formsFromMenu.excludedFormUuids ?? [],
						}
					: null,
				opening: moduleDestination(doc, moduleUuid),
				parent_module_uuid: mod.parentModuleUuid ?? null,
				parentCaseModuleUuid: mod.parentCaseModuleUuid ?? null,
				child_module_uuids: childModuleUuids(doc, moduleUuid),
				case_type: mod.caseType ?? null,
				...languageFiles(doc, mod),
				icon: mod.icon ?? null,
				audio_label: mod.audioLabel ?? null,
				display_condition: mod.displayCondition ?? null,
				badge: mod.badge ?? null,
				hidden_from_menu: mod.hiddenFromMenu === true,
				advanced: moduleAdvancedRead(doc, moduleUuid),
				case_list_config: caseListConfig ?? null,
				...listIconDestinationsRead(doc, mod),
				...(caseListConfig?.detailTabs && {
					detail_tabs: (
						detailTabSpans(caseListConfig.detailTabs, shownDetails) ?? []
					).map(({ tab, start, end }) => ({
						tabUuid: tab.uuid,
						title: tab.title,
						columnUuids: shownDetails.slice(start, end).map((c) => c.uuid),
					})),
				}),
				results_column_order: resultsColumns
					.filter((column) => column.visibleInList !== false)
					.map((column) => column.uuid),
				details_column_order: shownDetails.map((column) => column.uuid),
				case_search_config: caseSearchConfig ?? null,
				...(doc.appSettings.projectSearches && {
					available_project_searches: Object.entries(
						doc.appSettings.projectSearches,
					).map(([uuid, search]) => ({ uuid, name: search.name })),
				}),
				searchWorkflow: moduleSearchWorkflow(mod) ?? null,
				formsReadSearch: moduleFormsReadSearch(mod),
				menuLayout: mod.menuLayout ?? "list",
				formsMenuLayout: menuScreenLayout(doc, menuScreenOf(doc, moduleUuid)),
				formsInMenuAbove: moduleShowsFormsInMenuAbove(mod),
				listsOn: menuScreenOf(doc, moduleUuid),
				caseListMenuItem:
					mod.caseListMenuItem === undefined
						? null
						: {
								label: mod.caseListMenuItem.label ?? null,
								...languageFiles(doc, mod.caseListMenuItem),
								icon: mod.caseListMenuItem.icon ?? null,
								audio_label: mod.caseListMenuItem.audioLabel ?? null,
							},
				caseListRegistrationForm: caseListRegistrationRead(doc, moduleUuid),
				forms: formUuids.map((fUuid) => {
					const f = doc.forms[fUuid];
					return {
						uuid: fUuid,
						name: f?.name ?? "",
						type: f?.type ?? "survey",
						fieldCount: countFieldsUnder(doc, fUuid),
						...languageFiles(doc, f),
						icon: f?.icon ?? null,
						audio_label: f?.audioLabel ?? null,
						opensFromCaseList:
							afterEmptySearchRegistrationFormOf(doc, moduleUuid) === fUuid,
						offeredOnCaseListsOf: caseListsOffering(doc, fUuid),
						hidden_from_menu: f?.hiddenFromMenu === true,
					};
				}),
			},
		};
	},
};

/** The deep links each image column's icon may name
 * (`listIconAction.ts::listIconDestinations`), or nothing when no image
 * column has one. */
function listIconDestinationsRead(
	doc: BlueprintDoc,
	mod: Module,
): {
	listIconDestinations?: {
		columnUuid: Uuid;
		deepLinks: { id: string; form: string }[];
	}[];
} {
	const read = (mod.caseListConfig?.columns ?? []).flatMap((column) => {
		if (column.kind !== "image-map") return [];
		const deepLinks = listIconDestinations(doc, mod, column).map(
			(destination) => ({
				id: destination.entryPointId,
				form: entryPointTargetLabel(doc, destination.target),
			}),
		);
		return deepLinks.length > 0 ? [{ columnUuid: column.uuid, deepLinks }] : [];
	});
	return read.length > 0 ? { listIconDestinations: read } : {};
}
