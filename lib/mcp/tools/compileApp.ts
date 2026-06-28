/**
 * `nova.compile_app` — produce the CommCare HQ wire format for an owned app.
 *
 * Scope: `nova.read`. Read-only.
 *
 * Two output formats:
 *   - `"json"` — the `HqApplication` JSON as compact text for a media-free
 *     app. When the app HAS media, the bytes ship with the references (HQ has
 *     no single "json + media" import): the result is instead the same
 *     `<app>.zip` bundle the HTTP export ships — MEDIA-ON JSON + HQ bulk-upload
 *     `multimedia.zip` + README — base64-encoded inside a
 *     `{ format: "zip", encoding, data }` wrapper. So a media-free app stays
 *     byte-identical to the pre-media output; a media-bearing app round-trips
 *     intact instead of emitting references to bytes the client never gets.
 *   - `"ccz"` — the `.ccz` archive HQ mobile pulls down, base64-encoded
 *     inside a `{ format: "ccz", encoding, data }` wrapper so the client
 *     knows to decode the `data` field.
 *
 * Both formats expand via `expandDoc`; the zero-tolerance boundary gate runs
 * first so any validator finding — a soundness error, missing completeness
 * work, or a stale media reference — surfaces as actionable `invalid_input`,
 * never a broken artifact.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { buildHqJsonExportArchive } from "@/lib/commcare/multimedia/hqJsonExportArchive";
import { errorToString } from "@/lib/commcare/validator/errors";
import { collectBoundaryViolations } from "@/lib/media/boundaryValidation";
import { resolveMediaManifest } from "@/lib/media/manifest";
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
 * `app_name` (the ccz profile manifest + the json media bundle's filename)
 * come from the same load. `app.app_name` is non-empty by invariant —
 * `denormalize` writes `UNTITLED_APP_NAME` when the in-doc `appName` is
 * blank — so this tool threads it straight into `compileCcz` /
 * `buildHqJsonExportArchive` without a defensive fallback.
 */
export function registerCompileApp(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"compile_app",
		{
			description:
				'Compile an owned app to CommCare HQ format. `format: "json"` returns the HQ JSON as text, or — when the app has media — a base64-encoded zip bundle (JSON + an HQ multimedia upload) so the media round-trips. `format: "ccz"` returns the binary archive base64-encoded.',
			inputSchema: {
				app_id: z
					.string()
					.describe(
						"Firestore app id to compile. Must be an app the authenticated user owns.",
					),
				format: z
					.enum(["json", "ccz"])
					.describe(
						'"json" for the HQ wire JSON (a base64 zip bundle if the app has media), "ccz" for the binary archive (base64-encoded).',
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

				/* Boundary gate — zero tolerance before any expensive work.
				 * Every validator finding (soundness, completeness, media-
				 * state) rejects the compile as a `McpInvalidInputError` →
				 * `invalid_input` envelope carrying each rule's actionable
				 * message, so an invalid app never compiles into an artifact —
				 * and a stale media reference never reaches `expandDoc`'s
				 * `requireAssetRef` throw (an opaque `internal` error). */
				/* Media lives in the app OWNER's namespace (shared at Project
				 * scope), so resolve/validate against `app.owner`, not the
				 * acting member — a Project co-member compiling a shared app must
				 * see the same media the owner attached. */
				const violations = await collectBoundaryViolations(doc, app.owner);
				if (violations.length > 0) {
					throw new McpInvalidInputError(
						`This app isn't ready to compile — fix these first: ${violations
							.map(errorToString)
							.join(" ")}`,
					);
				}

				/* One manifest resolution (with bytes) feeds both the
				 * expander's media references and — for a media-bearing app —
				 * the byte bundle. A media-free app resolves to an empty
				 * manifest at no byte cost. */
				const assets = await resolveMediaManifest(doc, app.owner, {
					withBytes: true,
				});
				const hasMedia = assets.size > 0;

				/* Exhaustive switch on the `format` enum: a future third
				 * enum value becomes a compile error via the `never` check
				 * in the `default` branch rather than silently falling into
				 * the ccz path, the way a binary `if/else` would. */
				switch (args.format) {
					case "json": {
						/* Only a media-bearing app passes the manifest, so a
						 * media-free app expands media-OFF — its JSON stays
						 * byte-identical to the pre-media output instead of
						 * riding on an empty manifest collapsing to the same
						 * shape. */
						const hqJson = expandDoc(doc, hasMedia ? { assets } : {});
						if (!hasMedia) {
							/* Bare HQ JSON — the caller asked for JSON and, with
							 * no media to carry, gets JSON. */
							return {
								content: [{ type: "text", text: JSON.stringify(hqJson) }],
							};
						}
						/* Media-bearing: the same `<app>.zip` the HTTP export
						 * ships, so the `jr://` references travel with their
						 * bytes. base64 inside a `{ format: "zip", ... }`
						 * wrapper — MCP text content is UTF-8 only, and the
						 * wrapper tells the client to decode rather than parse
						 * the text as the app JSON. */
						const archive = buildHqJsonExportArchive(
							app.app_name,
							hqJson,
							assets,
						);
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										format: "zip",
										encoding: "base64",
										data: archive.toString("base64"),
									}),
								},
							],
						};
					}
					case "ccz": {
						/* The archive bundles the bytes alongside the
						 * references; an empty manifest bundles none.
						 * `compileCcz` returns a Node `Buffer`; MCP text
						 * content is UTF-8 only, so base64 is the safest
						 * lossless escape, and the `encoding` field inside the
						 * wrapper tells the caller to decode it. */
						const hqJson = expandDoc(doc, { assets });
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
