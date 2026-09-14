import type { ServerResponse } from "node:http";

export type ProviderOutput =
	| { type: "text"; text: string }
	| { type: "search"; query: string }
	| { type: "tool"; name: string; input: unknown; callId: string }
	| { type: "compaction"; id: string; encryptedContent: string };
export interface ProviderRequest {
	model?: string;
	input?: Array<Record<string, unknown>>;
	tools?: Array<{
		type: string;
		name?: string;
		defer_loading?: boolean;
		strict?: boolean;
		parameters?: {
			additionalProperties?: boolean;
			required?: string[];
			properties?: Record<string, unknown>;
		};
	}>;
	tool_choice?: unknown;
	store?: boolean;
	include?: string[];
	reasoning?: { effort?: string; summary?: string };
	prompt_cache_key?: string;
	prompt_cache_options?: unknown;
	parallel_tool_calls?: boolean;
}

/** Only the provider's HTTP output is scripted. The installed OpenAI decoder
 * produces tool calls, opaque checkpoint parts, usage and step boundaries. */
export function respondWithParts(
	response: ServerResponse,
	output: readonly ProviderOutput[],
	ordinal: number,
): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const event = (value: unknown) =>
		response.write(`data: ${JSON.stringify(value)}\n\n`);
	event({
		type: "response.created",
		response: { id: `resp_${ordinal}`, created_at: 1, model: "offline-design" },
	});
	for (const [index, part] of output.entries()) {
		if (part.type === "search") {
			const search = {
				type: "tool_search_call",
				id: `search_${ordinal}_${index}`,
				execution: "server",
				call_id: null,
				status: "completed",
				arguments: { query: part.query },
			};
			event({
				type: "response.output_item.added",
				output_index: index * 2,
				item: search,
			});
			event({
				type: "response.output_item.done",
				output_index: index * 2,
				item: search,
			});
			event({
				type: "response.output_item.done",
				output_index: index * 2 + 1,
				item: {
					type: "tool_search_output",
					id: `search_output_${ordinal}_${index}`,
					execution: "server",
					call_id: null,
					status: "completed",
					tools: [],
				},
			});
		} else if (part.type === "compaction") {
			event({
				type: "response.output_item.done",
				output_index: index * 2,
				item: {
					type: "compaction",
					id: part.id,
					encrypted_content: part.encryptedContent,
				},
			});
		} else if (part.type === "tool") {
			const id = `fc_${ordinal}_${index}`;
			const args = JSON.stringify(part.input);
			event({
				type: "response.output_item.added",
				output_index: index * 2,
				item: {
					type: "function_call",
					id,
					call_id: part.callId,
					name: part.name,
					arguments: "",
				},
			});
			// Multiple chunks force actual provider argument assembly before validation.
			const split = Math.ceil(args.length / 2);
			for (const delta of [args.slice(0, split), args.slice(split)])
				event({
					type: "response.function_call_arguments.delta",
					item_id: id,
					output_index: index * 2,
					delta,
				});
			event({
				type: "response.output_item.done",
				output_index: index * 2,
				item: {
					type: "function_call",
					id,
					call_id: part.callId,
					name: part.name,
					arguments: args,
					status: "completed",
				},
			});
		} else {
			const id = `msg_${ordinal}_${index}`;
			event({
				type: "response.output_item.added",
				output_index: index * 2,
				item: { type: "message", id },
			});
			event({
				type: "response.output_text.delta",
				item_id: id,
				delta: part.text,
			});
			event({
				type: "response.output_item.done",
				output_index: index * 2,
				item: {
					type: "message",
					id,
					content: [{ type: "output_text", text: part.text, annotations: [] }],
				},
			});
		}
	}
	event({
		type: "response.completed",
		response: {
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens_details: { reasoning_tokens: 0 },
			},
			incomplete_details: null,
		},
	});
	response.end();
}
