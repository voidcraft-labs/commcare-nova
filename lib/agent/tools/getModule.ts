/**
 * SA tool: `getModule` — read one module's metadata + menu media + case
 * list config + case search config + form summary by positional index.
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
 * shape (display cluster + advanced cluster); the wholesale-replace
 * `setCaseSearchDisplay` / `setCaseSearchAdvanced` tools read it back
 * as the snapshot they merge into. A fresh-session read here surfaces
 * every authoring handle without a parallel call.
 *
 * `icon` / `audio_label` (on the module AND each form summary) carry the
 * STORED menu-media refs — an uploaded asset id or a built-in
 * `nova-icon:<slug>` ref, `null` when unset. This is the read side of
 * `setMenuMedia`'s single-slot contract: its slots are
 * required-and-nullable, so to touch one slot of a tile the SA reads the
 * other's current value here and passes it back verbatim
 * (`resolveIconInput` round-trips a stored built-in ref unchanged). One
 * read covers every tile of the module, matching the batch shape.
 */

import { z } from "zod";
import { countFieldsUnder, orderedFormUuids } from "@/lib/doc/fieldWalk";
import type {
	BlueprintDoc,
	CaseListConfig,
	CaseSearchConfig,
	FormType,
} from "@/lib/domain";
import { resolveModuleUuid } from "../blueprintHelpers";
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
 * `icon` / `audio_label` are the form tile's stored menu-media refs.
 */
export interface GetModuleFormSummary {
	formIndex: number;
	name: string;
	type: FormType;
	fieldCount: number;
	icon: string | null;
	audio_label: string | null;
}

/**
 * Two legal result shapes:
 *
 *   - `{ error }` when the moduleIndex is out of range.
 *   - Module snapshot — metadata + menu media + structured case list
 *     config + case search config + per-form summary. Each config field
 *     is `null` when the module has not yet authored that surface (a
 *     survey-only module, or a freshly created case-carrying module
 *     before the corresponding tool family has run).
 */
export type GetModuleResult =
	| { error: string }
	| {
			moduleIndex: number;
			name: string;
			case_type: string | null;
			icon: string | null;
			audio_label: string | null;
			case_list_config: CaseListConfig | null;
			case_search_config: CaseSearchConfig | null;
			forms: GetModuleFormSummary[];
	  };

export const getModuleTool = {
	description:
		"Get a module by index. Returns module metadata, the module tile's stored menu media (icon + audio_label — pass these back to setMenuMedia to preserve a slot), the structured case list config (columns + filter + searchInputs — every column and search input carries its uuid for atomic edits), the case search config (display cluster + advanced cluster — wholesale-shaped, no uuids), and a summary of its forms including each form tile's menu media.",
	inputSchema: getModuleInputSchema,
	async execute(
		input: GetModuleInput,
		_ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<ReadToolResult<GetModuleResult>> {
		const { moduleIndex } = input;
		const moduleUuid = resolveModuleUuid(doc, moduleIndex);
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
		const formUuids = orderedFormUuids(doc, moduleUuid);
		return {
			kind: "read",
			data: {
				moduleIndex,
				name: mod.name,
				case_type: mod.caseType ?? null,
				icon: mod.icon ?? null,
				audio_label: mod.audioLabel ?? null,
				case_list_config: mod.caseListConfig ?? null,
				case_search_config: mod.caseSearchConfig ?? null,
				forms: formUuids.map((fUuid, i) => {
					const f = doc.forms[fUuid];
					return {
						formIndex: i,
						name: f?.name ?? "",
						type: f?.type ?? "survey",
						fieldCount: countFieldsUnder(doc, fUuid),
						icon: f?.icon ?? null,
						audio_label: f?.audioLabel ?? null,
					};
				}),
			},
		};
	},
};
