/**
 * `nova.compile_app` — produce the CommCare HQ wire format for an owned app.
 *
 * Scope: `nova.read`. Read-only.
 *
 * Two output formats:
 *   - `"json"` — the `HqApplication` JSON as compact text. Use when piping
 *     into tools that parse the HQ wire shape programmatically.
 *   - `"ccz"` — the `.ccz` archive HQ mobile pulls down, base64-encoded
 *     inside a `{ format, encoding, data }` JSON wrapper so the client
 *     knows to decode the `data` field.
 *
 * Expands via `expandDoc` first; `compileCcz` then wraps the HQ JSON plus
 * the app name and source blueprint into the zipped archive.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { errorToString } from "@/lib/commcare/validator/errors";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { collectMediaValidationErrors } from "@/lib/media/mediaValidation";
import {
	McpInvalidInputError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
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
	server.registerTool(
		"compile_app",
		{
			description:
				'Compile an owned app to CommCare HQ format. `format: "json"` returns the HQ JSON; `format: "ccz"` returns the binary archive base64-encoded.',
			inputSchema: {
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
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;
			try {
				/* Single load covers ownership gate, the compile input
				 * (blueprint with rebuilt `fieldParent`), and the
				 * denormalized app name in one Firestore read. Throws
				 * `McpAccessError` on cross-tenant probe or vanished row;
				 * the wire collapses both to `not_found`. */
				const { doc, app } = await loadAppBlueprint(appId, ctx.userId);

				/* Media gate — only the `ccz` format is media-ON, so only it
				 * can hit `expandDoc`'s `requireAssetRef` throw on a stale
				 * media reference (deleted, still-uploading, foreign-owned,
				 * or kind-mismatched asset). Gated by the same
				 * `format === "ccz"` condition as the manifest resolve so the
				 * `json` path stays byte-identical. A media-invalid doc throws
				 * `McpInvalidInputError` → `invalid_input` envelope with the
				 * rule's Elm-shape text, instead of an opaque `internal` error
				 * from the expand throw. */
				if (args.format === "ccz") {
					const mediaErrors = await collectMediaValidationErrors(
						doc,
						ctx.userId,
					);
					if (mediaErrors.length > 0) {
						throw new McpInvalidInputError(
							`This app references media that isn't ready to compile: ${mediaErrors
								.map(errorToString)
								.join(" ")}`,
						);
					}
				}

				/* Media manifest is loaded ONLY for the `ccz` format — the
				 * archive bundles the bytes alongside the references. The
				 * `json` format returns the raw HQ JSON with no byte upload
				 * following it, so it ships media-free: emitting references
				 * without the matching files would render to broken images.
				 * (The HQ upload tool `upload_app_to_hq` is media-ON because
				 * it POSTs the bytes per file after import; this read-only
				 * compile does not.) `undefined` here flows through
				 * `expandDoc`/`compileCcz` as media-off. */
				const assets =
					args.format === "ccz"
						? await resolveMediaManifest(doc, ctx.userId, { withBytes: true })
						: undefined;

				const hqJson = expandDoc(doc, { assets });

				/* Exhaustive switch on the `format` enum: a future third
				 * enum value becomes a compile error via the `never` check
				 * in the `default` branch rather than silently falling into
				 * the ccz path, the way a binary `if/else` would. */
				switch (args.format) {
					case "json":
						/* Content is the bare HQ JSON. The caller asked for
						 * JSON and gets JSON — no envelope, no wrapper. */
						return {
							content: [{ type: "text", text: JSON.stringify(hqJson) }],
						};
					case "ccz": {
						/* `compileCcz` returns a Node `Buffer`; MCP text
						 * content is UTF-8 only, so base64 is the safest
						 * lossless escape. The `encoding` field inside the
						 * JSON wrapper tells the caller to decode rather
						 * than treat the text as the archive directly. */
						const cczBuf = compileCcz(hqJson, app.app_name, doc, { assets });
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										format: "ccz",
										encoding: "base64",
										data: cczBuf.toString("base64"),
									}),
								},
							],
						};
					}
					default: {
						/* `never` narrowing — TypeScript widens `args.format`
						 * to `never` here when every enum value is covered.
						 * Adding a value to the enum without a matching
						 * branch makes `_exhaustive` no longer typeable as
						 * `never`, producing a compile error instead of a
						 * silent runtime fall-through. */
						const _exhaustive: never = args.format;
						throw new Error(`Unreachable compile format: ${_exhaustive}`);
					}
				}
			} catch (err) {
				return toMcpErrorResult(err, {
					appId,
					userId: ctx.userId,
				});
			}
		},
	);
}
