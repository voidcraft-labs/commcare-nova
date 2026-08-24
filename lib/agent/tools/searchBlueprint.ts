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
import type { ToolInvocationContext } from "../workspace/types";
import type { ReadToolResult } from "./common";

export const searchBlueprintInputSchema = z
	.object({
		query: z
			.string()
			.describe(
				"Search term: case property name, field id, label text, case type, XPath fragment, or module/form name",
			),
	})
	.strict();

export type SearchBlueprintInput = z.infer<typeof searchBlueprintInputSchema>;

/**
 * Most matches this tool will return in one call.
 *
 * The underlying query is unbounded, and on a large app a short query
 * matches most of it — a single letter against a production app renders
 * over half a million characters, which is past what any tool result
 * can carry to a model and far past what one is worth reading. Both
 * consumers then lose: the MCP caller's result is replaced by a preview
 * of itself, and the chat SA pays six figures of tokens for a haystack.
 *
 * A result set this large is a signal the query was too broad, not a
 * payload to deliver. The cap is on COUNT rather than characters so the
 * number the caller sees ("50 of 3,214") is the one it can act on.
 *
 * This bound lives at the tool boundary and not in
 * `lib/doc/searchBlueprint.ts`, because the builder's search hook shows
 * a scrolling list to a person and legitimately wants every match.
 */
const MAX_RESULTS = 50;

/**
 * Echo the query alongside the results so the SA can match output to
 * input across interleaved tool calls. The `results` shape comes straight
 * from the shared `searchBlueprint` helper.
 *
 * `truncated` is present only when matches were withheld. Its absence is
 * the caller's proof that it is holding every match — without that, a
 * capped result and a complete one are indistinguishable, and an agent
 * that assumes it has seen every writer of a case property will edit
 * the ones it saw and miss the rest.
 */
export interface SearchBlueprintResult {
	query: string;
	results: SearchResult[];
	truncated?: {
		shown: number;
		total: number;
		message: string;
	};
}

export const searchBlueprintTool = {
	description:
		"Search the blueprint for fields, forms, modules, or case properties matching a query. Results carry stable UUIDs and parent-aware menu paths; module matches include parent and ordered child UUIDs.",
	inputSchema: searchBlueprintInputSchema,
	async execute(
		input: SearchBlueprintInput,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<SearchBlueprintResult>> {
		const doc = ctx.snapshot.doc;
		const results = searchBlueprint(doc, input.query);
		if (results.length <= MAX_RESULTS) {
			return { kind: "read", data: { query: input.query, results } };
		}
		return {
			kind: "read",
			data: {
				query: input.query,
				results: results.slice(0, MAX_RESULTS),
				truncated: {
					shown: MAX_RESULTS,
					total: results.length,
					message: `"${input.query}" matches ${results.length} places in this app; the first ${MAX_RESULTS} are here. Search a fuller name, a case property, or a field id to narrow it, or read a specific module or form with get_module / get_form. Do not treat these ${MAX_RESULTS} as every match.`,
				},
			},
		};
	},
};
