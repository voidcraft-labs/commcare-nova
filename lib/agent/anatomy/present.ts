/**
 * A model message as a page can carry it: the same shape, with the two
 * values a rehydrated message may hold that no client boundary accepts
 * replaced by what they stand for. A `URL` becomes its text (which is what
 * the wire serializes), and binary bytes become a labeled placeholder so an
 * image attachment's payload never ships to a page that does not render it.
 */

import type { ModelMessage } from "ai";

function present(value: unknown): unknown {
	if (value instanceof URL) return value.href;
	if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
		return `[binary, ${value.byteLength.toLocaleString("en-US")} bytes]`;
	}
	if (Array.isArray(value)) return value.map(present);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, present(entry)]),
		);
	}
	return value;
}

export function presentableMessage(message: ModelMessage): ModelMessage {
	return present(message) as ModelMessage;
}
