/**
 * `nova.get_hq_connection` — report whether the authenticated user has
 * CommCare HQ credentials configured, and if so, which project spaces they
 * can upload to and which one is the active default.
 *
 * Scope: `nova.hq.read` (per-tool, in addition to the route-layer
 * `nova.read` floor). HQ access is orthogonal to Nova-internal
 * read/write — see `lib/mcp/scopes.ts` for the full enforcement model.
 *
 * A CommCare HQ API key can be unscoped, in which case it reaches every
 * project space its owner belongs to. So this tool returns the full set the
 * key can upload to (`available_domains`) plus the user's chosen default
 * (`domain`). `domain` is `null` precisely when the key reaches multiple
 * spaces and the user hasn't picked a default yet — the caller should then
 * pick one from `available_domains` (e.g. prompt the user) and pass it to
 * `upload_app_to_hq` rather than letting the upload guess.
 *
 * Does NOT return the API key or username — the safe public shape from
 * `getCommCareSettings` drops the secret entirely. Nothing this tool
 * returns is information the user couldn't already see in their own
 * Settings page, so exposing it to the authenticated caller leaks nothing.
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

/** A project space the key can upload to. */
type DomainBody = { name: string; displayName: string };

/**
 * Wire shape returned to the MCP client.
 *
 * Discriminated on `configured`. When configured, `available_domains` lists
 * every space the key can upload to (length 1 ⇒ a single-space key), and
 * `domain` is the active default — `null` when the key is multi-space and no
 * default has been chosen, signalling the caller to pick from
 * `available_domains`. A configured row always carries at least one available
 * domain — not by the schema (`approved_domains` defaults to `[]`) but by the
 * runtime collapse in `getCommCareSettings`, which reports `configured: false`
 * when the stored set is empty.
 */
type GetHqConnectionBody =
	| { configured: false }
	| {
			configured: true;
			domain: DomainBody | null;
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
				"Check the user's CommCare HQ connection: whether it's configured, every project space (domain) the API key can upload to (`available_domains`), and the active default (`domain`). Call this before `upload_app_to_hq` to confirm the target. `domain` is null when the key reaches multiple spaces and no default is chosen — pick one from `available_domains` and pass it to `upload_app_to_hq`.",
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
							domain: settings.domain,
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
