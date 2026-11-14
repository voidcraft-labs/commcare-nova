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
	ModuleIconRef,
	SearchWorkflow,
	Uuid,
} from "@/lib/domain";
import {
	afterEmptySearchRegistrationFormOf,
	caseListRegistrationReturnOf,
	caseListsOffering,
	childModuleUuids,
	menuScreenOf,
	moduleDestination,
	moduleFormsReadSearch,
	moduleSearchWorkflow,
	moduleShowsFormsInMenuAbove,
	orderedColumns,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression";
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
export interface GetModuleFormSummary {
	uuid: Uuid;
	name: string;
	type: FormType;
	fieldCount: number;
	icon: FormIconRef | null;
	audio_label: MediaAssetId | null;
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
			parentCaseModuleUuid: Uuid | null;
			child_module_uuids: Uuid[];
			case_type: string | null;
			icon: ModuleIconRef | null;
			audio_label: MediaAssetId | null;
			display_condition: Expression | null;
			/** True when the module is off the menu, with every form in it. */
			hidden_from_menu: boolean;
			/** Present when CommCare HQ receives the module as an advanced
			 *  menu; `kept` when a published app holds it advanced. */
			advanced: { kept: boolean } | null;
			case_list_config: CaseListConfig | null;
			/** Visible case-list COLUMN uuids, in the order each screen renders them.
			 *  A column's `field` is its case property and is a different identity. */
			results_column_order: Uuid[];
			details_column_order: Uuid[];
			case_search_config: CaseSearchConfig | null;
			/** What the menu opens on, or `null` where it has no search. */
			searchWorkflow: SearchWorkflow | null;
			/** True when the menu's forms read the search. */
			formsReadSearch: boolean;
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
	| { kind: "after-empty-search"; formUuid: Uuid; label: string | null }
	| {
			kind: "always";
			formUuid: Uuid;
			label: string | null;
			afterSubmit: CaseListRegistrationReturn;
			followsFormAfterSubmit: boolean;
			icon: FormIconRef | null;
			audio_label: MediaAssetId | null;
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
		};
	return {
		kind: slot.kind,
		formUuid: slot.formUuid,
		label: slot.label ?? null,
		afterSubmit: slot.afterSubmit,
		followsFormAfterSubmit:
			caseListRegistrationReturnOf(doc, moduleUuid)?.kind === "own",
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
		const { moduleUuid, module: mod } = resolved;
		const formUuids = orderedFormUuids(doc, moduleUuid);
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
		return {
			kind: "read",
			data: {
				uuid: moduleUuid,
				name: mod.name,
				opening: moduleDestination(doc, moduleUuid),
				parent_module_uuid: mod.parentModuleUuid ?? null,
				parentCaseModuleUuid: mod.parentCaseModuleUuid ?? null,
				child_module_uuids: childModuleUuids(doc, moduleUuid),
				case_type: mod.caseType ?? null,
				icon: mod.icon ?? null,
				audio_label: mod.audioLabel ?? null,
				display_condition: mod.displayCondition ?? null,
				hidden_from_menu: mod.hiddenFromMenu === true,
				advanced: moduleAdvancedRead(doc, moduleUuid),
				case_list_config: caseListConfig ?? null,
				results_column_order: resultsColumns
					.filter((column) => column.visibleInList !== false)
					.map((column) => column.uuid),
				details_column_order: detailsColumns
					.filter((column) => column.visibleInDetail !== false)
					.map((column) => column.uuid),
				case_search_config: caseSearchConfig ?? null,
				searchWorkflow: moduleSearchWorkflow(mod) ?? null,
				formsReadSearch: moduleFormsReadSearch(mod),
				formsInMenuAbove: moduleShowsFormsInMenuAbove(mod),
				listsOn: menuScreenOf(doc, moduleUuid),
				caseListMenuItem:
					mod.caseListMenuItem === undefined
						? null
						: {
								label: mod.caseListMenuItem.label ?? null,
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
