/**
 * SA tool: `searchBlueprint` — find fields, forms, modules, or case
 * properties matching a query.
 *
 * Pure read — no mutations, no SSE emission. The shared tool body here
 * is a thin wrapper over `lib/doc/searchBlueprint.ts`. Both the SA chat
 * factory and the MCP adapter call this the same way.
 */

import { z } from "zod";
import { type SearchResult, searchBlueprint } from "@/lib/doc/searchBlueprint";
import type { BlueprintDoc } from "@/lib/domain";
import type { ToolExecutionContext } from "../toolExecutionContext";

export const searchBlueprintInputSchema = z.object({
	query: z
		.string()
		.describe(
			"Search term: case property name, field id, label text, case type, XPath fragment, or module/form name",
		),
});

export type SearchBlueprintInput = z.infer<typeof searchBlueprintInputSchema>;

/**
 * Echo the query alongside the results so the SA can match output to
 * input across interleaved tool calls. The `results` shape comes straight
 * from the shared `searchBlueprint` helper.
 */
export interface SearchBlueprintResult {
	query: string;
	results: SearchResult[];
}

export const searchBlueprintTool = {
	description:
		"Search the blueprint for fields, forms, modules, or case properties matching a query.",
	inputSchema: searchBlueprintInputSchema,
	async execute(
		input: SearchBlueprintInput,
		_ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<SearchBlueprintResult> {
		const results = searchBlueprint(doc, input.query);
		return { query: input.query, results };
	},
};
