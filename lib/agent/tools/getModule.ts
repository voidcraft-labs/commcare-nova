/**
 * SA tool: `getModule` — read one module's metadata + case list config
 * + case search config + form summary by positional index.
 *
 * Pure read — no mutations, no SSE emission. Useful to the SA mid-edit
 * when it needs to confirm a module's case type, inspect the structured
 * `caseListConfig` / `caseSearchConfig` it has authored, or enumerate
 * its forms without re-reading the whole doc. Both the SA chat factory
 * and the MCP adapter call this the same way.
 *
 * `case_list_config` carries the case-list-config verbatim — every
 * column and search input retains its `uuid`, the SA-facing handle for
 * atomic edits. `case_search_config` carries the wholesale case-search
 * shape (claim cluster + display cluster); the wholesale-replace
 * `setCaseSearchClaim` / `setCaseSearchDisplay` tools read it back as
 * the snapshot they merge into. A fresh-session read here surfaces
 * every authoring handle without a parallel call.
 */

import { z } from "zod";
import { countFieldsUnder } from "@/lib/doc/fieldWalk";
import type {
	BlueprintDoc,
	CaseListConfig,
	CaseSearchConfig,
	FormType,
} from "@/lib/domain";
import type { ToolExecutionContext } from "../toolExecutionContext";
import type { ReadToolResult } from "./common";

export const getModuleInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
	})
	.strict();

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
 *   - Module snapshot — metadata + structured case list config + case
 *     search config + per-form summary. Each config field is `null`
 *     when the module has not yet authored that surface (a survey-
 *     only module, or a freshly created case-carrying module before
 *     the corresponding tool family has run).
 */
export type GetModuleResult =
	| { error: string }
	| {
			moduleIndex: number;
			name: string;
			case_type: string | null;
			case_list_config: CaseListConfig | null;
			case_search_config: CaseSearchConfig | null;
			forms: GetModuleFormSummary[];
	  };

export const getModuleTool = {
	description:
		"Get a module by index. Returns module metadata, the structured case list config (columns + filter + searchInputs — every column and search input carries its uuid for atomic edits), the case search config (claim cluster + display cluster — wholesale-shaped, no uuids), and a summary of its forms.",
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
				case_search_config: mod.caseSearchConfig ?? null,
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
