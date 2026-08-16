/**
 * Shared MCP tool dispatch: both auth paths (JWT and API-key) hand
 * a verified caller context here. Lifted out of `route.ts` into its
 * own module so `route.ts`, `api-key-auth.ts`, and `jwt-auth.ts` can
 * all import it without forming an import cycle.
 *
 * The SDK's `createMcpHandler` is fetch-native: `handler.fetch` maps
 * a `Request` straight to a `Response` with no pathname matching, so
 * the URL the route shim synthesizes (`/api/auth/mcp`, needed for
 * Better Auth's router) is invisible to the protocol layer. In its
 * default legacy-stateless mode the handler serves modern (2026-era)
 * clients with SDK-managed sessions and pre-2026 Streamable HTTP
 * clients per-request, and answers GET / DELETE with 405 itself.
 *
 * Fresh `McpServer` per request: the factory passed to
 * `createMcpHandler` runs once per incoming request, and the
 * `ToolContext` reaches tools only through the `registerNovaTools`
 * closure, never through SDK `authInfo`. Binding tools on every call
 * is cheap (register* helpers just call `server.registerTool`) and
 * the alternative: a long-lived server, would leak the first
 * caller's identity into every subsequent request.
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as Sentry from "@sentry/nextjs";
import { registerNovaTools } from "@/lib/mcp/server";
import type { ToolContext } from "@/lib/mcp/types";

/**
 * Max wall-clock duration for a single MCP request, in seconds.
 *
 * The `maxDuration` segment config in `route.ts` (the platform's
 * request-timeout knob) matches this number; Next requires that
 * export to be a numeric literal, so the two are kept in sync by
 * hand and the route's docblock points back here.
 *
 * 300s (5 min) accommodates the longest realistic single tool call
 * the MCP route exposes: `upload_app_to_hq` (network upload to HQ
 * with a built `.ccz`), a guarded commit against a large blueprint, or
 * an LLM-driven `create_module`: without leaving abandoned
 * requests to accumulate. External MCP clients drive the loop one
 * tool per request, so this ceiling is per-tool, not bundled.
 */
export const MCP_MAX_DURATION_SECONDS = 300;

export async function dispatchMcpTools(
	req: Request,
	ctx: ToolContext,
): Promise<Response> {
	/* Attribute every Sentry event from this verified MCP request to its
	 * caller. Both auth paths (JWT, API key) converge here with a verified
	 * `ctx`, and the credential carries only the user id: the JWT `sub`
	 * claim or the API-key row's `referenceId`, no email, so this is
	 * id-only attribution; the first-party web surface sets the richer
	 * name/email user in `lib/auth-utils.ts`. */
	Sentry.setUser({ id: ctx.userId });
	const handler = createMcpHandler(() => {
		const server = new McpServer({ name: "nova", version: "1.0.0" });
		registerNovaTools(server, ctx);
		return server;
	});
	/* No `handler.close()` after fetch: the Response body may still be
	 * streaming (SSE) when fetch resolves, and the per-request handler
	 * is released with the request scope anyway. */
	return handler.fetch(req);
}
