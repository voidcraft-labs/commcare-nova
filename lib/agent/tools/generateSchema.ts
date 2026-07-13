/**
 * SA tool: `generateSchema` — plan the app's data model (name + case-type
 * catalog).
 *
 * A PURE planning step: it writes nothing to the doc. The structured
 * input — the full describe-rich case-type catalog — is the plan itself,
 * preserved verbatim in the conversation as the tool call's input; the
 * result echoes a compact structured index of it. Case-type RECORDS land
 * on the doc later, each riding the `createModule` call for the module
 * that owns the type (`case_type_record`), so a record never exists
 * ahead of the module that satisfies its validator obligations.
 *
 * The first tool call of a new build, after the SA has reasoned the
 * whole design through and written it to the user. Both the SA chat
 * factory and the MCP adapter call this through the shared
 * `ToolExecutionContext` interface.
 */

import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { caseTypesOutputSchema } from "../planningSchemas";
import type { ToolExecutionContext } from "../toolExecutionContext";
import type { ReadToolResult } from "./common";

export const generateSchemaInputSchema = z
	.object({
		appName: z.string().describe("Short app name (2-5 words)"),
		caseTypes: caseTypesOutputSchema.shape.case_types,
	})
	.strict();

export type GenerateSchemaInput = z.infer<typeof generateSchemaInputSchema>;

/**
 * Structured index of the planned data model — one entry per case type,
 * carrying the property names plus the parent link, so the follow-up
 * `createModule` calls can reference the plan without re-reading
 * anything. The full property detail lives in this call's own input,
 * which stays in the conversation verbatim.
 */
export interface GenerateSchemaResult {
	planned: true;
	appName: string;
	caseTypes: Array<{
		name: string;
		parent_type?: string;
		propertyCount: number;
		properties: string[];
	}>;
}

export const generateSchemaTool = {
	description:
		"Record the app's data model — the first tool call of a build, after the design is reasoned through. Pure plan, changes nothing; each case type's record lands later via its own createModule call's case_type_record.",
	inputSchema: generateSchemaInputSchema,
	async execute(
		input: GenerateSchemaInput,
		_ctx: ToolExecutionContext,
		_doc: BlueprintDoc,
	): Promise<ReadToolResult<GenerateSchemaResult>> {
		return {
			kind: "read" as const,
			data: {
				planned: true,
				appName: input.appName,
				caseTypes: input.caseTypes.map((ct) => ({
					name: ct.name,
					...(ct.parent_type != null && { parent_type: ct.parent_type }),
					propertyCount: ct.properties.length,
					properties: ct.properties.map((p) => p.name),
				})),
			},
		};
	},
};
