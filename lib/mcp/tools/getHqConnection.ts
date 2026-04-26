/**
 * `nova.get_hq_connection` — report whether the authenticated user has
 * CommCare HQ credentials configured, and if so, which project space
 * they authorize.
 *
 * Scope: `nova.hq.read` (per-tool, in addition to the route-layer
 * `nova.read` floor). HQ access is orthogonal to Nova-internal
 * read/write — see `lib/mcp/scopes.ts` for the full enforcement model.
 *
 * A user's Nova account can only hold ONE CommCare HQ credential +
 * domain pair at a time, because HQ API keys are scoped per-project on
 * HQ's side (a key authorizes exactly one project). Every Nova surface
 * that uploads to HQ is therefore binary: configured → one known
 * domain; not configured → upload is unavailable. This tool surfaces
 * that binary cleanly so agents can preview the target domain before
 * calling `upload_app_to_hq` without needing the user to type it.
 *
 * Does NOT return the API key or username — the safe public shape from
 * `getCommCareSettings` drops the secret entirely. Nothing this tool
 * returns is information the user couldn't already see in their own
 * Settings page, so exposing it to the authenticated caller leaks
 * nothing new.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCommCareSettings } from "@/lib/db/settings";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

/**
 * Wire shape returned to the MCP client.
 *
 * Discriminated on `configured` so callers branch cleanly without a
 * null check on `domain`: when `configured === false` the payload is
 * a single-key object and `domain` is absent; when `true`, `domain` is
 * always present. The on-disk settings schema enforces that either
 * both are set or neither is — no half-configured state.
 */
type GetHqConnectionBody =
	| { configured: false }
	| {
			configured: true;
			domain: { name: string; displayName: string };
	  };

/**
 * Register the zero-argument `get_hq_connection` tool on an `McpServer`.
 *
 * Thin adapter over `getCommCareSettings`. The DB function already
 * returns a client-safe public shape (`CommCareSettingsPublic`); this
 * tool projects it into the wire shape by dropping the username (not
 * useful to a remote agent that only needs to preview the target
 * domain for a confirmation message).
 */
export function registerGetHqConnection(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"get_hq_connection",
		{
			description:
				"Check whether the authenticated user has a CommCare HQ connection configured, and if so, which project space (domain) it authorizes. Use this before calling `upload_app_to_hq` so you can confirm the target domain with the user — HQ API keys are scoped to exactly one domain per user, so this call is how you learn where an upload would go.",
		},
		async (_extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				/* Per-tool scope gate — runs BEFORE any data read so a
				 * missing-scope token cannot probe whether HQ creds exist
				 * for the user. The route-layer `nova.read` requirement has
				 * already passed; this gate adds the HQ-specific layer.
				 * Throws `McpScopeError` on miss; the surrounding catch
				 * routes through `toMcpErrorResult`'s scope-missing branch. */
				assertScope(ctx.scopes, SCOPES.hqRead, "get_hq_connection");

				const settings = await getCommCareSettings(ctx.userId);
				/* `CommCareSettingsPublic` is a discriminated union — the
				 * `configured: true` branch types `domain` as non-null, so
				 * the wire shape projection is a 1:1 pass-through with no
				 * defensive fallback. */
				const body: GetHqConnectionBody = settings.configured
					? { configured: true, domain: settings.domain }
					: { configured: false };
				return {
					content: [{ type: "text", text: JSON.stringify(body) }],
				};
			} catch (err) {
				return toMcpErrorResult(err, { userId: ctx.userId });
			}
		},
	);
}
