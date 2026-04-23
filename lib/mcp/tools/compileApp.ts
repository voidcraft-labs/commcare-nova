/**
 * `nova.compile_app` — produce the CommCare HQ wire format for an
 * owned Nova app.
 *
 * Scope: `nova.read`. Read-only — no mutations, no event-log writes.
 *
 * Two output formats:
 *
 *   - `"json"` returns the `HqApplication` JSON inline as
 *     pretty-printed text. Ideal for debugging an app or piping into
 *     ad-hoc tools that parse the HQ wire shape.
 *
 *   - `"ccz"` returns the `.ccz` archive (the zipped bundle HQ mobile
 *     pulls down). MCP text content is UTF-8 only, so binary is
 *     base64-encoded in the text payload and `_meta.encoding: "base64"`
 *     tells the client to decode.
 *
 * The app is always expanded via `expandDoc` first. `compileCcz` takes
 * the HQ JSON + app name + source `BlueprintDoc` and produces the
 * archive buffer; `expandDoc` owns the domain→wire boundary so the
 * JSON-format path is just the same expansion without the zip step.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { loadApp } from "@/lib/db/apps";
import { toMcpErrorResult } from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { McpAccessError, requireOwnedApp } from "../ownership";
import type { ToolContext } from "../types";

/**
 * Register the `compile_app` tool on an `McpServer`.
 *
 * The tool performs two Firestore reads on the happy path: one via
 * `loadAppBlueprint` for the hydrated `BlueprintDoc` (the compile input)
 * and one direct `loadApp` for the denormalized `app_name` (passed to
 * `compileCcz` for the profile manifest). The second read is deliberate
 * — `loadAppBlueprint` intentionally narrows to the blueprint shape so
 * every caller that wants it doesn't have to destructure a larger
 * record. Rate is low (user-initiated compile) and Firestore hot-reads
 * are cheap, so the duplicate read is the simpler tradeoff over
 * widening the helper's contract.
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
					'"json" for the pretty-printed HQ wire JSON, "ccz" for the binary archive (base64-encoded).',
				),
		},
		async (args) => {
			const appId = args.app_id;
			try {
				await requireOwnedApp(ctx.userId, appId);

				/* `loadAppBlueprint` hydrates `fieldParent` from `fieldOrder`;
				 * the compile pipeline's case-block injection walks that
				 * reverse index, so the rebuild must happen before
				 * `expandDoc` sees the doc. Null means the row vanished
				 * between the ownership check and the load — map that
				 * concurrent-hard-delete race to the same `not_found` a
				 * missing-id probe surfaces. */
				const doc = await loadAppBlueprint(appId);
				if (!doc) throw new McpAccessError("not_found");

				/* Second read for the denormalized `app_name` — the ccz
				 * profile manifest needs it but `BlueprintDoc.appName` is
				 * the normalized (possibly blank) in-doc value; the
				 * denormalized `app_name` column carries the list-display
				 * default. Empty string falls back to "Untitled" so the
				 * emitted profile is always valid HQ XML. */
				const app = await loadApp(appId);
				if (!app) throw new McpAccessError("not_found");
				const appName = app.app_name || "Untitled";

				const hqJson = expandDoc(doc);

				if (args.format === "json") {
					return {
						content: [{ type: "text", text: JSON.stringify(hqJson, null, 2) }],
						_meta: { format: "json", app_id: appId },
					};
				}

				/* `compileCcz` returns a Node `Buffer`; MCP text content is
				 * UTF-8 only, so base64 is the safest lossless escape.
				 * `_meta.encoding: "base64"` tells MCP clients to decode
				 * rather than treat the text as the archive directly. */
				const cczBuf = compileCcz(hqJson, appName, doc);
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
