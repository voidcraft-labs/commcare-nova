/**
 * SA tool: `getModule` — read one module's metadata + case list columns
 * + form summary by positional index.
 *
 * Pure read — no mutations, no SSE emission. Useful to the SA mid-edit
 * when it needs to confirm a module's case type or enumerate its forms
 * without re-reading the whole doc. Both the SA chat factory and the
 * MCP adapter call this the same way.
 */

import { z } from "zod";
import { countFieldsUnder } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, CaseListColumn, FormType } from "@/lib/domain";
import type { ToolExecutionContext } from "../toolExecutionContext";

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
 *   - Module snapshot — metadata + columns + per-form summary.
 */
export type GetModuleResult =
	| { error: string }
	| {
			moduleIndex: number;
			name: string;
			case_type: string | null;
			case_list_columns: CaseListColumn[] | null;
			forms: GetModuleFormSummary[];
	  };

export const getModuleTool = {
	name: "getModule" as const,
	description:
		"Get a module by index. Returns module metadata, case list columns, and a summary of its forms.",
	inputSchema: getModuleInputSchema,
	async execute(
		input: GetModuleInput,
		_ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<GetModuleResult> {
		const { moduleIndex } = input;
		const moduleUuid = doc.moduleOrder[moduleIndex];
		if (!moduleUuid) return { error: `Module ${moduleIndex} not found` };
		const mod = doc.modules[moduleUuid];
		if (!mod) return { error: `Module ${moduleIndex} not found` };
		const formUuids = doc.formOrder[moduleUuid] ?? [];
		return {
			moduleIndex,
			name: mod.name,
			case_type: mod.caseType ?? null,
			case_list_columns: mod.caseListColumns ?? null,
			forms: formUuids.map((fUuid, i) => {
				const f = doc.forms[fUuid];
				return {
					formIndex: i,
					name: f?.name ?? "",
					type: f?.type ?? "survey",
					fieldCount: countFieldsUnder(doc, fUuid),
				};
			}),
		};
	},
};
