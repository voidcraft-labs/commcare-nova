import type {
	MutatingToolResult,
	ReadToolResult,
} from "@/lib/agent/tools/common";

/**
 * Tagged union of every shape a shared tool can return. The `kind`
 * discriminator is set by each tool's own return statement — the
 * adapter dispatches on it via a `switch`, and the type system catches
 * a future third variant at compile time rather than at runtime
 * structural inspection. See `lib/agent/tools/common.ts` for the
 * per-shape definitions.
 */
type SharedToolReturn = MutatingToolResult<unknown> | ReadToolResult<unknown>;

/**
 * Map a shared tool's return value into the payload the MCP client's
 * LLM sees. Two branches, dispatched on the `kind` discriminator:
 *
 *   - `"mutate"` — unwrap `result`, the per-tool typed payload. The
 *     mutations were already persisted through the workspace before the
 *     tool returned; the adapter does NOT re-apply them. `mutations` is
 *     internal introspection data (tests pin golden batches on it); MCP
 *     callers re-read state via read tools, so surfacing it on the wire
 *     would be noise.
 *   - `"read"` — unwrap `data`, the bare per-tool payload.
 *
 * Exhaustive switch — TypeScript narrows `kind` to `never` in the
 * `default` branch, so adding a third variant without a matching
 * case becomes a compile error.
 *
 * Exported so unit tests can call the branches directly without
 * spinning up an MCP server.
 */
function unwrapResult(raw: SharedToolReturn): unknown {
	switch (raw.kind) {
		case "mutate": {
			/* `result.summary` is UI-only presentation captured for the chat
			 * transcript (a friendly action + a location breadcrumb). MCP clients
			 * read the prose `message`, so strip the summary from the wire — in
			 * their context it would be noise, not signal. A success object that's
			 * then just `{ message }` (a tool whose result was a bare prose string
			 * before `summary` rode along) projects back to that bare string, so
			 * the MCP wire shape is byte-identical to before; objects carrying more
			 * (a minted `uuid`) keep their object shape. */
			const r = raw.result;
			if (r !== null && typeof r === "object") {
				const { summary: _summary, ...rest } = r as Record<string, unknown>;
				const keys = Object.keys(rest);
				if (keys.length === 1 && typeof rest.message === "string") {
					return rest.message;
				}
				return rest;
			}
			return r;
		}
		case "read":
			return raw.data;
		default: {
			const _exhaustive: never = raw;
			return _exhaustive;
		}
	}
}

/** Strip chat-only presentation and carry any saved-data consequence on the message. */
export function projectResult(
	raw: SharedToolReturn,
	parkedNote?: string,
): unknown {
	const payload = unwrapResult(raw);
	if (parkedNote === undefined) return payload;
	if (typeof payload === "string") return `${payload}\n\n${parkedNote}`;
	if (
		typeof payload === "object" &&
		payload !== null &&
		"message" in payload &&
		typeof payload.message === "string"
	) {
		return { ...payload, message: `${payload.message}\n\n${parkedNote}` };
	}
	return payload;
}
