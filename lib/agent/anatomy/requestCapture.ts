import { createHash } from "node:crypto";

/** Exact provider input for an explicitly instrumented run. Contains user
 * content; the caller owns authorized storage. Headers are never captured. */
export interface CapturedModelRequest {
	readonly body: string;
	readonly sha256: string;
}

/** Record the serialized Responses request before sending it. Awaiting the
 * sink lets a diagnostic run stop before spending if its evidence cannot be
 * saved. Normal production calls use their transport without this wrapper. */
export function captureModelRequests(
	transport: typeof globalThis.fetch,
	record: (request: CapturedModelRequest) => Promise<void>,
): typeof globalThis.fetch {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname.endsWith("/responses") ||
			url.pathname.endsWith("/responses/compact")
		) {
			const request = new Request(
				input instanceof Request ? input.clone() : input,
				init,
			);
			request.signal.throwIfAborted();
			const body = await request.clone().text();
			await record({
				body,
				sha256: createHash("sha256").update(body).digest("hex"),
			});
			request.signal.throwIfAborted();
		}
		return transport(input, init);
	};
}
