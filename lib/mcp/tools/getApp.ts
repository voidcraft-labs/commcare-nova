/**
 * `nova.get_app` — render a blueprint summary for one owned app.
 *
 * Scope: `nova.read`.
 *
 * Uses the same `summarizeBlueprint` renderer the SA edit-mode prompt
 * consumes. Any drift between the two would create divergent mental
 * models of an app across surfaces (SA reads one summary, MCP clients
 * get another); co-using the renderer makes that impossible by
 * construction and keeps a single canonical domain-vocabulary view.
 *
 * Returns the summary as text content. No persistence, no run id
 * plumbing, no progress emission — a pure read with deterministic
 * per-call side effects scoped to the ownership gate.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { summarizeBlueprint } from "@/lib/agent/summarizeBlueprint";
import { loadApp } from "@/lib/db/apps";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { toMcpErrorResult } from "../errors";
import { McpForbiddenError, requireOwnedApp } from "../ownership";
import type { ToolContext } from "../types";

/**
 * Register the single-argument `get_app` tool on an `McpServer`.
 *
 * Ownership is verified before the app load and, because the two reads
 * aren't atomic, the load path independently surfaces a concurrent
 * hard-delete as `not_found`. A pre-load ownership pass still pays for
 * itself here: cross-tenant probes short-circuit before Firestore has
 * to return anything more than an owner field.
 */
export function registerGetApp(server: McpServer, ctx: ToolContext): void {
	server.tool(
		"get_app",
		"Get a blueprint summary (human-readable markdown) for one of your apps.",
		{
			app_id: z
				.string()
				.describe(
					"Firestore app id to summarize. Must be an app the authenticated user owns.",
				),
		},
		async (args) => {
			const appId = args.app_id;
			try {
				await requireOwnedApp(ctx.userId, appId);

				const app = await loadApp(appId);
				/* Ownership + load aren't atomic — a concurrent hard-delete
				 * between the two reads lands here. Surface as `not_found`
				 * for consistency with the ownership check's own `not_found`
				 * path so MCP clients see one error regardless of which side
				 * of the race they land on. */
				if (!app) throw new McpForbiddenError("not_found");

				/* Firestore persists the `PersistableDoc` shape without the
				 * derived `fieldParent` reverse index (see `toPersistableDoc`).
				 * `summarizeBlueprint` itself doesn't read `fieldParent`, but
				 * the `BlueprintDoc` type requires it, so we rebuild once
				 * here to hand the renderer a well-typed full doc. */
				const doc: BlueprintDoc = { ...app.blueprint, fieldParent: {} };
				rebuildFieldParent(doc);

				return {
					content: [{ type: "text", text: summarizeBlueprint(doc) }],
					_meta: { app_id: appId },
				};
			} catch (err) {
				return toMcpErrorResult(err, { appId });
			}
		},
	);
}
