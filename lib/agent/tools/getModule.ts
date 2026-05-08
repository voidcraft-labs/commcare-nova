/**
 * SA tool: `getModule` — read one module's metadata + case list config
 * + form summary by positional index.
 *
 * Pure read — no mutations, no SSE emission. Useful to the SA mid-edit
 * when it needs to confirm a module's case type, inspect the structured
 * `caseListConfig` it has authored, or enumerate its forms without
 * re-reading the whole doc. Both the SA chat factory and the MCP
 * adapter call this the same way.
 *
 * The returned `case_list_config` is the structured `CaseListConfig`
 * verbatim — every column and search input carries its `uuid`, the
 * SA-facing handle for atomic edits. The atomic write tools
 * (`updateCaseListColumn`, `removeCaseListColumn`,
 * `reorderCaseListColumns`, and the search-input parallels) consume
 * those uuids directly, so a fresh-session read here surfaces every
 * authoring handle without a parallel call.
 */

import { z } from "zod";
import { countFieldsUnder } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, CaseListConfig, FormType } from "@/lib/domain";
import type { ToolExecutionContext } from "../toolExecutionContext";
import type { ReadToolResult } from "./common";

export const getModuleInputSchema = z.object({
	moduleIndex: z.number().describe("0-based module index"),
});

export type GetModuleInput = z.infer<typeof getModuleInputSchema>;

/**
 * Per-form summary included in the `getModule` result. `fieldCount`
 * counts fields at every nesting depth so the SA gets a real size signal
 * (a form with three groups of five fields reads as 15, not 3).
 */
export interface GetModuleFormSummary {
	formIndex: number;
	name: string;
	type: FormType;
	fieldCount: number;
}

/**
 * Two legal result shapes:
 *
 *   - `{ error }` when the moduleIndex is out of range.
 *   - Module snapshot — metadata + structured case list config + per-form
 *     summary. `case_list_config` is `null` when the module has no
 *     authored config yet (a survey-only module or a freshly created
 *     case-carrying module before any case-list-config tool runs).
 */
export type GetModuleResult =
	| { error: string }
	| {
			moduleIndex: number;
			name: string;
			case_type: string | null;
			case_list_config: CaseListConfig | null;
			forms: GetModuleFormSummary[];
	  };

export const getModuleTool = {
	description:
		"Get a module by index. Returns module metadata, the structured case list config (columns + filter + searchInputs — every column and search input carries its uuid for atomic edits), and a summary of its forms.",
	inputSchema: getModuleInputSchema,
	async execute(
		input: GetModuleInput,
		_ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<ReadToolResult<GetModuleResult>> {
		const { moduleIndex } = input;
		const moduleUuid = doc.moduleOrder[moduleIndex];
		if (!moduleUuid) {
			return {
				kind: "read",
				data: { error: `Module ${moduleIndex} not found` },
			};
		}
		const mod = doc.modules[moduleUuid];
		if (!mod) {
			return {
				kind: "read",
				data: { error: `Module ${moduleIndex} not found` },
			};
		}
		const formUuids = doc.formOrder[moduleUuid] ?? [];
		return {
			kind: "read",
			data: {
				moduleIndex,
				name: mod.name,
				case_type: mod.caseType ?? null,
				case_list_config: mod.caseListConfig ?? null,
				forms: formUuids.map((fUuid, i) => {
					const f = doc.forms[fUuid];
					return {
						formIndex: i,
						name: f?.name ?? "",
						type: f?.type ?? "survey",
						fieldCount: countFieldsUnder(doc, fUuid),
					};
				}),
			},
		};
	},
};
