/**
 * `nova.compile_app` — produce the CommCare HQ wire format for an owned app.
 *
 * Scope: `nova.read`. Read-only.
 *
 * Two output formats:
 *   - `"json"` — the `HqApplication` JSON as compact text. Use when piping
 *     into tools that parse the HQ wire shape programmatically.
 *   - `"ccz"` — the `.ccz` archive HQ mobile pulls down, base64-encoded in
 *     the text payload with `_meta.encoding: "base64"` so the client decodes.
 *
 * Expands via `expandDoc` first; `compileCcz` then wraps the HQ JSON plus
 * the app name and source blueprint into the zipped archive.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { toMcpErrorResult } from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { McpAccessError, requireOwnedApp } from "../ownership";
import type { ToolContext } from "../types";

/**
 * Register the `compile_app` tool on an `McpServer`.
 *
 * One Firestore read suffices: `loadAppBlueprint` returns `{ doc, app }`
 * so both the hydrated blueprint (for `expandDoc`) and the denormalized
 * `app_name` (for the ccz profile manifest) come from the same load.
 * `app.app_name` is non-empty by invariant — `denormalize` writes
 * `UNTITLED_APP_NAME` when the in-doc `appName` is blank — so this
 * tool threads `app.app_name` straight into `compileCcz` without a
 * defensive fallback.
 */
export function registerCompileApp(server: McpServer, ctx: ToolContext): void {
	server.tool(
		"compile_app",
		'Compile an owned app to CommCare HQ format. `format: "json"` returns the HQ JSON; `format: "ccz"` returns the binary archive base64-encoded.',
		{
			app_id: z
				.string()
				.describe(
					"Firestore app id to compile. Must be an app the authenticated user owns.",
				),
			format: z
				.enum(["json", "ccz"])
				.describe(
					'"json" for the HQ wire JSON, "ccz" for the binary archive (base64-encoded).',
				),
		},
		async (args) => {
			const appId = args.app_id;
			try {
				await requireOwnedApp(ctx.userId, appId);

				/* Single load covers both the compile input (blueprint with
				 * rebuilt `fieldParent`) and the denormalized app name.
				 * Null means the row vanished between the ownership check
				 * and this read (concurrent hard-delete); map that race to
				 * the same `not_found` a missing-id probe surfaces. */
				const loaded = await loadAppBlueprint(appId);
				if (!loaded) throw new McpAccessError("not_found");
				const { doc, app } = loaded;

				const hqJson = expandDoc(doc);

				if (args.format === "json") {
					return {
						content: [{ type: "text", text: JSON.stringify(hqJson) }],
						_meta: { format: "json", app_id: appId },
					};
				}

				/* `compileCcz` returns a Node `Buffer`; MCP text content is
				 * UTF-8 only, so base64 is the safest lossless escape.
				 * `_meta.encoding: "base64"` tells MCP clients to decode
				 * rather than treat the text as the archive directly. */
				const cczBuf = compileCcz(hqJson, app.app_name, doc);
				return {
					content: [{ type: "text", text: cczBuf.toString("base64") }],
					_meta: { format: "ccz", encoding: "base64", app_id: appId },
				};
			} catch (err) {
				return toMcpErrorResult(err, { appId });
			}
		},
	);
}
