import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createModelCallTransport, createNovaOpenAI } from "../openaiProvider";

/** The real provider and SDK speak Responses to a loopback HTTP server. Only
 * destination routing changes; fetch, body decoding and Zod remain real. */
export async function withResponsesPeer<T>(
	handle: (request: IncomingMessage, response: ServerResponse) => void,
	run: (
		provider: ReturnType<typeof createNovaOpenAI>,
		transport: typeof globalThis.fetch,
	) => Promise<T>,
): Promise<T> {
	const server = createServer(handle);
	const transport = createModelCallTransport();
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("No peer port");
		const fetch: typeof globalThis.fetch = (input, init) => {
			const url = new URL(String(input));
			if (
				url.origin !== "https://api.openai.com" ||
				url.pathname !== "/v1/responses"
			) {
				throw new Error(
					`Unexpected provider destination: ${url.origin}${url.pathname}`,
				);
			}
			return transport.fetch(
				`http://127.0.0.1:${address.port}${url.pathname}`,
				init,
			);
		};
		return await run(createNovaOpenAI("synthetic-local-only", fetch), fetch);
	} finally {
		await transport.destroy();
		server.closeAllConnections();
		if (server.listening)
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
	}
}

export function respondWithObject(
	response: ServerResponse,
	text: string,
	opts: { incomplete?: boolean; reasoning?: string } = {},
): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const event = (value: unknown) =>
		response.write(`data: ${JSON.stringify(value)}\n\n`);
	event({
		type: "response.created",
		response: { id: "resp_local", created_at: 1, model: "local-model" },
	});
	if (opts.reasoning) {
		event({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "reasoning", id: "rs_local" },
		});
		event({
			type: "response.reasoning_summary_text.delta",
			item_id: "rs_local",
			summary_index: 0,
			delta: opts.reasoning,
		});
		event({
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "reasoning",
				id: "rs_local",
				summary: [{ type: "summary_text", text: opts.reasoning }],
			},
		});
	}
	event({
		type: "response.output_item.added",
		output_index: 1,
		item: { type: "message", id: "msg_local" },
	});
	// Split JSON so the real SDK must assemble it before validating.
	for (const delta of [text.slice(0, 5), text.slice(5)]) {
		event({ type: "response.output_text.delta", item_id: "msg_local", delta });
	}
	event({
		type: "response.output_item.done",
		output_index: 1,
		item: {
			type: "message",
			id: "msg_local",
			content: [{ type: "output_text", text, annotations: [] }],
		},
	});
	event({
		type: opts.incomplete ? "response.incomplete" : "response.completed",
		response: {
			incomplete_details: opts.incomplete
				? { reason: "max_output_tokens" }
				: null,
			usage: {
				input_tokens: 11,
				output_tokens: 7,
				input_tokens_details: { cached_tokens: 3 },
				output_tokens_details: { reasoning_tokens: 2 },
			},
		},
	});
	response.end();
}
