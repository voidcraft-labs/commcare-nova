/**
 * Shared MCP tool dispatch — both auth paths (JWT and API-key) hand
 * a verified caller context here. Lifted out of `route.ts` into its
 * own module so `route.ts`, `api-key-auth.ts`, and `jwt-auth.ts` can
 * all import it without forming an import cycle.
 *
 * `mcp-handler` matches `new URL(req.url).pathname` against its
 * computed `${basePath}/mcp` endpoint. The route shim in `route.ts`
 * synthesizes a new Request with URL `/api/auth/mcp` before handing
 * it to Better Auth's `auth.handler`, so by the time the request
 * reaches `dispatchMcpTools` the pathname is always `/api/auth/mcp`
 * — independent of wire path. Hence `basePath: "/api/auth"` here is
 * a stable literal; no more dev-vs-prod branching on
 * `MCP_RESOURCE_PATH`.
 *
 * Fresh `McpServer` per request. Binding tools on every call is cheap
 * (register* helpers just call `server.registerTool`) and the
 * alternative — a long-lived server — would leak the first caller's
 * identity into every subsequent request.
 */

import { createMcpHandler } from "mcp-handler";
import { registerNovaTools } from "@/lib/mcp/server";
import type { ToolContext } from "@/lib/mcp/types";

/**
 * Max wall-clock duration for a single MCP request, in seconds.
 *
 * Re-exported as the `maxDuration` segment config in `route.ts` (the
 * platform's request-timeout knob) AND passed into `createMcpHandler`'s
 * `maxDuration` (the MCP runtime's own streaming cutoff). They serve
 * different layers — platform vs protocol — so both are needed.
 *
 * 300s (5 min) accommodates the longest realistic single tool call
 * the MCP route exposes — `upload_app_to_hq` (network upload to HQ
 * with a built `.ccz`), `validate_app` against a large blueprint, or
 * an LLM-driven `generate_scaffold` — without leaving abandoned
 * requests to accumulate. External MCP clients drive the loop one
 * tool per request, so this ceiling is per-tool, not bundled.
 */
export const MCP_MAX_DURATION_SECONDS = 300;

/**
 * basePath the route shim's synthesized URL is anchored under. The
 * shim sets the path to `/api/auth/mcp` before calling
 * `auth.handler`; `mcp-handler` matches against `${basePath}/mcp` so
 * basePath is `/api/auth`. If the route shim ever changes the
 * synthesized prefix, this literal must move with it.
 */
const SYNTHESIZED_AUTH_BASE_PATH = "/api/auth";

export async function dispatchMcpTools(
	req: Request,
	ctx: ToolContext,
): Promise<Response> {
	return createMcpHandler(
		(server) => {
			registerNovaTools(server, ctx);
		},
		{ serverInfo: { name: "nova", version: "1.0.0" } },
		{
			basePath: SYNTHESIZED_AUTH_BASE_PATH,
			maxDuration: MCP_MAX_DURATION_SECONDS,
		},
	)(req);
}
