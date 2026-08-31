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
 * authoring values accepted by `setMenuMedia`: uploaded-media UUIDs pass
 * through, while a stored built-in ref projects to its catalog slug. Internal
 * `nova-icon:<slug>` identities never leak into the tool protocol. One read
 * covers every tile of the module, matching the batch shape.
 *
 * `display_condition` carries the module's typed condition — the read half of
 * the slot `updateModule` writes. Without it the SA would edit a module blind
 * to a rule governing whether the module appears at all, and would overwrite
 * one it had never been shown.
 */

import type { z } from "zod";
import { countFieldsUnder, orderedFormUuids } from "@/lib/doc/fieldWalk";
import type {
	CaseListConfig,
	CaseSearchConfig,
	FormIconRef,
	FormIconSlug,
	FormType,
	MediaAssetId,
	ModuleIconRef,
	ModuleIconSlug,
	Uuid,
} from "@/lib/domain";
import {
	childModuleUuids,
	isBuiltinIconRef,
	orderedColumns,
	parseBuiltinIconSlug,
} from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
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
 * `icon` projects a built-in ref to its authoring slug while uploaded-media
 * UUIDs pass through unchanged. `audio_label` is an uploaded-media UUID.
 */
export interface GetModuleFormSummary {
	uuid: Uuid;
	name: string;
	type: FormType;
	fieldCount: number;
	icon: FormIconSlug | MediaAssetId | null;
	audio_label: MediaAssetId | null;
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
			parent_module_uuid: Uuid | null;
			child_module_uuids: Uuid[];
			case_type: string | null;
			icon: ModuleIconSlug | MediaAssetId | null;
			audio_label: MediaAssetId | null;
			display_condition: Predicate | null;
			case_list_config: CaseListConfig | null;
			/** Visible case-list COLUMN uuids, in the order each screen renders them.
			 *  A column's `field` is its case property and is a different identity. */
			results_column_order: Uuid[];
			details_column_order: Uuid[];
			case_search_config: CaseSearchConfig | null;
			forms: GetModuleFormSummary[];
	  };

export const getModuleTool = {
	description:
		"Get a module by stable UUID: parent and ordered child menu UUIDs, metadata, menu media, case-list selection and definitions plus the independent visible Results and Details UUID orders, case-search config, and a form summary.",
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
				parent_module_uuid: mod.parentModuleUuid ?? null,
				child_module_uuids: childModuleUuids(doc, moduleUuid),
				case_type: mod.caseType ?? null,
				icon: projectModuleIcon(mod.icon),
				audio_label: mod.audioLabel ?? null,
				display_condition: mod.displayCondition ?? null,
				case_list_config: caseListConfig ?? null,
				results_column_order: resultsColumns
					.filter((column) => column.visibleInList !== false)
					.map((column) => column.uuid),
				details_column_order: detailsColumns
					.filter((column) => column.visibleInDetail !== false)
					.map((column) => column.uuid),
				case_search_config: caseSearchConfig ?? null,
				forms: formUuids.map((fUuid) => {
					const f = doc.forms[fUuid];
					return {
						uuid: fUuid,
						name: f?.name ?? "",
						type: f?.type ?? "survey",
						fieldCount: countFieldsUnder(doc, fUuid),
						icon: projectFormIcon(f?.icon),
						audio_label: f?.audioLabel ?? null,
					};
				}),
			},
		};
	},
};

function projectModuleIcon(
	icon: ModuleIconRef | undefined,
): ModuleIconSlug | MediaAssetId | null {
	if (icon === undefined) return null;
	if (!isBuiltinIconRef(icon)) return icon;
	return parseBuiltinIconSlug(icon) as ModuleIconSlug;
}

function projectFormIcon(
	icon: FormIconRef | undefined,
): FormIconSlug | MediaAssetId | null {
	if (icon === undefined) return null;
	if (!isBuiltinIconRef(icon)) return icon;
	return parseBuiltinIconSlug(icon) as FormIconSlug;
}
