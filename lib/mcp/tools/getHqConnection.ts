/**
 * `nova.get_hq_connection` — report whether the authenticated user has
 * CommCare HQ credentials configured, and if so, which project spaces they
 * can upload to.
 *
 * Scope: `nova.hq.read` (per-tool, in addition to the route-layer
 * `nova.read` floor). HQ access is orthogonal to Nova-internal
 * read/write — see `lib/mcp/scopes.ts` for the full enforcement model.
 *
 * A CommCare HQ API key can be unscoped, in which case it reaches every
 * project space its owner belongs to. So this tool returns the full set the
 * key can upload to (`available_domains`). When that set holds more than one
 * space, the caller asks the user which space and passes their choice to
 * `upload_app_to_hq` rather than letting the upload guess — there is no stored
 * default; a multi-space key's target is always the user's per-upload choice.
 *
 * Does NOT return the API key or username — the safe public shape from
 * `getCommCareSettings` drops the secret entirely. Nothing this tool
 * returns is information the user couldn't already see in their own
 * Settings page, so exposing it to the authenticated caller leaks nothing.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { COMMCARE_SERVERS, type CommCareServer } from "@/lib/commcare/servers";
import { getCommCareSettings } from "@/lib/db/settings";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

/** A project space the key can upload to. */
type DomainBody = { name: string; displayName: string };

/**
 * Wire shape returned to the MCP client.
 *
 * Discriminated on `configured`. When configured, `available_domains` lists
 * every space the key can upload to (length 1 ⇒ a single-space key); a
 * multi-space set means the caller must pick a target for `upload_app_to_hq`.
 * A configured row always carries at least one available domain — not by the
 * schema (`approved_domains` defaults to `[]`) but by the runtime collapse in
 * `getCommCareSettings`, which reports `configured: false` when the stored set
 * is empty.
 *
 * `server` / `server_url` name which HQ deployment the connection lives on
 * (US / India / EU are separate deployments); uploads land there.
 */
type GetHqConnectionBody =
	| { configured: false }
	| {
			configured: true;
			server: CommCareServer;
			server_url: string;
			available_domains: DomainBody[];
	  };

/**
 * Register the zero-argument `get_hq_connection` tool on an `McpServer`.
 *
 * Thin adapter over `getCommCareSettings`, which already returns a
 * client-safe public shape (`CommCareSettingsPublic`) with the username and
 * key material dropped; this tool renames `availableDomains` to the wire's
 * snake_case `available_domains` and passes the rest through.
 */
export function registerGetHqConnection(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"get_hq_connection",
		{
			description:
				"Check the user's CommCare HQ connection: whether it's configured, which HQ deployment it lives on (`server`/`server_url` — US, India, and EU are separate CommCare servers), and every project space (domain) the API key can upload to (`available_domains`). Call this before `upload_app_to_hq` to confirm the target. When `available_domains` holds more than one space, ask the user which space and pass their choice to `upload_app_to_hq` — never choose for them; a multi-space key's target is always the user's per-upload decision.",
		},
		async (_extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				/* Per-tool scope gate — runs BEFORE any data read so a
				 * missing-scope token cannot probe whether HQ creds exist
				 * for the user. The route-layer `nova.read` requirement has
				 * already passed; this gate adds the HQ-specific layer.
				 * Throws `McpScopeError` on miss; the surrounding catch
				 * routes through `toMcpErrorResult`'s scope-missing branch. */
				assertScope(ctx, SCOPES.hqRead, "get_hq_connection");

				const settings = await getCommCareSettings(ctx.userId);
				const body: GetHqConnectionBody = settings.configured
					? {
							configured: true,
							server: settings.server,
							server_url: COMMCARE_SERVERS[settings.server].baseUrl,
							available_domains: settings.availableDomains,
						}
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
