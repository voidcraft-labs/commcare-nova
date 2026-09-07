import type { IncomingMessage, ServerResponse } from "node:http";

/** A Responses HTTP peer, not an agent or UI-stream replacement. Tests choose
 * provider output and its timing; the installed SDK owns validation, tool
 * execution, step boundaries, usage and UI-message projection. */
export class ChatResponsesPeer {
	readonly requests: Record<string, unknown>[] = [];
	private readonly responses: ModelResponse[] = [];
	private readonly pending: ServerResponse[] = [];
	private nextResponse = 0;
	private closing = false;
	private readonly failures: Error[] = [];

	response(): ModelResponse {
		const response = new ModelResponse(this.responses.length);
		this.responses.push(response);
		this.deliver();
		return response;
	}

	readonly handle = (
		request: IncomingMessage,
		response: ServerResponse,
	): void => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			try {
				if (request.method !== "POST" || request.url !== "/v1/responses")
					throw new Error("Unexpected model HTTP request");
				this.requests.push(JSON.parse(Buffer.concat(chunks).toString()));
				this.pending.push(response);
				this.deliver();
			} catch (error) {
				this.failures.push(
					error instanceof Error ? error : new Error(String(error)),
				);
				response.writeHead(400, { "content-type": "application/json" });
				response.end(
					JSON.stringify({ error: { message: "Invalid peer request" } }),
				);
			}
		});
	};

	private deliver(): void {
		while (this.pending.length > 0) {
			let planned = this.responses[this.nextResponse];
			if (!planned && !this.closing) return;
			if (!planned) {
				planned = new ModelResponse(this.nextResponse);
				planned.fail("The test is closing its model peer.");
			}
			const response = this.pending.shift();
			if (!response) throw new Error("Missing model response socket");
			this.nextResponse++;
			planned.attach(response);
		}
	}

	close(): void {
		this.closing = true;
		for (const response of this.responses)
			response.fail("The test is closing its model peer.");
		this.deliver();
	}

	assertHealthy(): void {
		if (this.failures.length > 0)
			throw new AggregateError(this.failures, "Model HTTP peer failed");
		if (this.requests.length !== this.responses.length)
			throw new Error(
				`Expected ${this.responses.length} Responses requests, received ${this.requests.length}`,
			);
	}
}

const usage = {
	input_tokens: 10,
	output_tokens: 5,
	input_tokens_details: { cached_tokens: 0 },
	output_tokens_details: { reasoning_tokens: 0 },
};

export class ModelResponse {
	private socket: ServerResponse | undefined;
	private readonly events: unknown[] = [];
	private ended = false;
	private textValue = "";
	private textStarted = false;
	private textEnded = false;
	private outputIndex = 0;

	constructor(private readonly ordinal: number) {
		this.event({
			type: "response.created",
			response: {
				id: `resp_${ordinal}`,
				created_at: 1,
				model: "offline-model",
			},
		});
		this.event({
			type: "response.in_progress",
			response: {
				id: `resp_${ordinal}`,
				created_at: 1,
				model: "offline-model",
			},
		});
	}

	attach(socket: ServerResponse): void {
		this.socket = socket;
		socket.writeHead(200, { "content-type": "text/event-stream" });
		for (const event of this.events)
			socket.write(`data: ${JSON.stringify(event)}\n\n`);
		if (this.ended) socket.end();
	}

	private event(event: unknown): void {
		if (this.ended) throw new Error("The provider response already ended");
		this.events.push(event);
		this.socket?.write(`data: ${JSON.stringify(event)}\n\n`);
	}

	text(delta: string): void {
		if (!this.textStarted) {
			this.textStarted = true;
			this.event({
				type: "response.output_item.added",
				output_index: this.outputIndex,
				item: { type: "message", id: `msg_${this.ordinal}` },
			});
		}
		this.textValue += delta;
		this.event({
			type: "response.output_text.delta",
			item_id: `msg_${this.ordinal}`,
			delta,
		});
	}

	private endText(): void {
		if (!this.textStarted || this.textEnded) return;
		this.textEnded = true;
		this.event({
			type: "response.output_item.done",
			output_index: this.outputIndex++,
			item: {
				type: "message",
				id: `msg_${this.ordinal}`,
				content: [
					{ type: "output_text", text: this.textValue, annotations: [] },
				],
			},
		});
	}

	tool(
		name: string,
		input: unknown,
		options: { callId?: string; deltaSize?: number } = {},
	): void {
		this.endText();
		const id = `fc_${this.ordinal}_${this.outputIndex}`;
		const callId = options.callId ?? `call_${this.ordinal}_${this.outputIndex}`;
		const args = JSON.stringify(input);
		this.event({
			type: "response.output_item.added",
			output_index: this.outputIndex,
			item: { type: "function_call", id, call_id: callId, name, arguments: "" },
		});
		const size = options.deltaSize ?? args.length;
		for (let offset = 0; offset < args.length; offset += size)
			this.event({
				type: "response.function_call_arguments.delta",
				item_id: id,
				output_index: this.outputIndex,
				delta: args.slice(offset, offset + size),
			});
		this.event({
			type: "response.output_item.done",
			output_index: this.outputIndex++,
			item: {
				type: "function_call",
				id,
				call_id: callId,
				name,
				arguments: args,
				status: "completed",
			},
		});
	}

	finish(): void {
		if (this.ended) return;
		this.endText();
		this.event({
			type: "response.completed",
			response: { usage, incomplete_details: null },
		});
		this.ended = true;
		this.socket?.end();
	}

	fail(message: string): void {
		if (this.ended) return;
		this.endText();
		this.event({
			type: "response.failed",
			sequence_number: 1,
			response: {
				usage,
				error: { code: "invalid_request_error", message },
			},
		});
		this.ended = true;
		this.socket?.end();
	}
}
