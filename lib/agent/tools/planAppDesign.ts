/**
 * SA tool: `planAppDesign` — plan the app's design: modules, forms,
 * purposes, per-form design specs, Connect blocks, post-submit flow.
 *
 * A PURE planning step, like `generateSchema` before it: it writes
 * nothing to the doc. The structured input is the plan — module/form
 * structure, each form's `formDesign` free-text spec, case-type
 * assignments, per-form connect blocks — preserved verbatim in the
 * conversation as the tool call's input. Execution happens afterward,
 * one `createModule` call per planned module, each assembling
 * mechanically from its section of this plan (and from the data-model
 * plan's matching case-type entry via `case_type_record`).
 *
 * The result echoes a compact structured index (module/form names,
 * types, connect kinds) so later calls can reference the plan's shape
 * without re-stating it.
 */

import type { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { appDesignPlanSchema } from "../planningSchemas";
import type { ToolExecutionContext } from "../toolExecutionContext";
import type { ReadToolResult } from "./common";

export const planAppDesignInputSchema = appDesignPlanSchema;

export type PlanAppDesignInput = z.infer<typeof planAppDesignInputSchema>;

/**
 * Structured index of the planned design. Mirrors the plan's module
 * order so each follow-up `createModule` call maps 1:1 onto an entry;
 * the full per-form detail (purpose, formDesign, connect) lives in this
 * call's own input, which stays in the conversation verbatim.
 */
export interface PlanAppDesignResult {
	planned: true;
	appName: string;
	connectType: "learn" | "deliver" | null;
	modules: Array<{
		index: number;
		name: string;
		case_type: string | null;
		formCount: number;
		forms: Array<{
			index: number;
			name: string;
			type: string;
			connectKinds?: string[];
		}>;
	}>;
}

export const planAppDesignTool = {
	description:
		"Plan the app's design: every module, its forms, each form's purpose and design spec, case-type assignments, and (for Connect apps) per-form Connect blocks. Call after generateSchema. This records the plan in the conversation — it does not change the app. Execute it afterward with one createModule call per planned module, following the plan's sections.",
	inputSchema: planAppDesignInputSchema,
	async execute(
		input: PlanAppDesignInput,
		_ctx: ToolExecutionContext,
		_doc: BlueprintDoc,
	): Promise<ReadToolResult<PlanAppDesignResult>> {
		return {
			kind: "read" as const,
			data: {
				planned: true,
				appName: input.app_name,
				connectType:
					input.connect_type === "learn" || input.connect_type === "deliver"
						? input.connect_type
						: null,
				modules: input.modules.map((m, i) => ({
					index: i,
					name: m.name,
					case_type: m.case_type,
					formCount: m.forms.length,
					forms: m.forms.map((f, j) => ({
						index: j,
						name: f.name,
						type: f.type,
						...(f.connect && {
							connectKinds: Object.keys(f.connect),
						}),
					})),
				})),
			},
		};
	},
};
