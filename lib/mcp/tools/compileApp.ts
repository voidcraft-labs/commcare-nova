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
 *
 * Each result names the document version it was built from — the blueprint's
 * `mutation_seq`. The `"ccz"` path stamps it into the profile's
 * `cc-content-version`; the `"json"` path (whose `text` body must stay the
 * byte-identical HQ-import artifact) carries it on the result's `_meta`
 * (`nova/compiledAtSeq`) instead.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import {
	featureFlagReportForDownload,
	type HqFeatureFlagReport,
} from "@/lib/commcare/featureFlags";
import { buildHqJsonExportArchive } from "@/lib/commcare/multimedia/hqJsonExportArchive";
import { errorToString } from "@/lib/commcare/validator/errors";
import { attachmentDeploymentTargetFor } from "@/lib/deployment/attachmentSpace";
import { attachmentUrlTargetFor } from "@/lib/deployment/attachmentTarget";
import {
	type ExportMode,
	prepareExportBoundary,
} from "@/lib/export/boundaryValidation";
import {
	type ExportAdvisory,
	exportAdvisories,
} from "@/lib/publish/exportAdvisories";
import {
	McpInvalidInputError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import type { ToolContext } from "../types";

type CompileFormat = "json" | "ccz";

export const COMPILE_EXPORT_MODE_BY_FORMAT = {
	json: "hq-json",
	ccz: "ccz",
} as const satisfies Record<CompileFormat, ExportMode>;

/**
 * Register the `compile_app` tool on an `McpServer`.
 *
 * One read suffices: `loadAppBlueprint` returns `{ doc, app, access }`
 * so the hydrated blueprint, authorized Project scope, and denormalized
 * `app_name` (the ccz profile manifest + the json media bundle's filename)
 * come from the same load. `app.app_name` is non-blank by schema, so this
 * tool threads it straight into `compileCcz` / `buildHqJsonExportArchive`
 * without a defensive fallback.
 */
export function registerCompileApp(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"compile_app",
		{
			description:
				'Compile an owned app to CommCare HQ format. Before invoking this tool, call `get_app_hq_feature_flags` without a domain if the user has not already been shown the app requirements, so they can understand them before export. `format: "json"` returns the HQ JSON as text, or, when the app has media, a base64-encoded zip bundle (JSON + an HQ multimedia upload) so the media round-trips. `format: "ccz"` returns the binary archive base64-encoded. When the app uses HQ feature flags, a text block before the artifact repeats the requirements so large base64 results cannot hide them; because a downloaded artifact has no known destination, these are requirements, not flags Nova has confirmed missing.',
			inputSchema: z.object({
				app_id: z
					.string()
					.describe(
						"App id to compile. Must be an app the authenticated user owns.",
					),
				format: z
					.enum(["json", "ccz"])
					.describe(
						'"json" for the HQ wire JSON (a base64 zip bundle if the app has media), "ccz" for the binary archive (base64-encoded).',
					),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;
			try {
				/* Single load covers ownership gate, the compile input
				 * (blueprint with rebuilt `fieldParent`), and the
				 * denormalized app name in one read. Throws
				 * `McpAccessError` on cross-tenant probe or vanished row;
				 * the wire collapses both to `not_found`. */
				const { doc, app, access } = await loadAppBlueprint(appId, ctx.userId);

				/* Boundary gate — zero tolerance before any expensive work.
				 * Every validator finding (soundness, completeness, media-
				 * state) rejects the compile as a `McpInvalidInputError` →
				 * `invalid_input` envelope carrying each rule's actionable
				 * message, so an invalid app never compiles into an artifact —
				 * and a stale media reference never reaches `expandDoc`'s
				 * `requireAssetRef` throw (an opaque `internal` error). */
				/* An app's media lives in its PROJECT (the sharing boundary), so
				 * resolve/validate against the authorized `access`, not the acting caller —
				 * matches the web export path (`prepareCompileRequest`) so a Project
				 * co-member (who reaches this tool at `view`) compiles the project's
				 * media the same way through MCP as through the browser. No leak: the
				 * manifest resolves only the ids the app's own blueprint references,
				 * filtered to the project. */
				const mode = COMPILE_EXPORT_MODE_BY_FORMAT[args.format];
				/* Neither artifact carries a target of its own, so attachment
				 * links resolve from the app's deployment record — exactly what
				 * the browser download path does. With no project space holding
				 * the app, or more than one, there is no honest address and the
				 * links are left out. */
				const attachmentDeploymentTarget = await attachmentDeploymentTargetFor({
					appId,
					projectId: access.projectId,
					role: access.role,
					actorUserId: access.actorUserId,
				});
				const attachmentTarget = attachmentUrlTargetFor(
					attachmentDeploymentTarget,
				);
				const boundary = await prepareExportBoundary({
					mode,
					access,
					doc,
					compiledAtSeq: app.mutation_seq,
					attachmentTarget,
				});
				if (!boundary.ok) {
					throw new McpInvalidInputError(
						`This app isn't ready to compile. Fix these first: ${boundary.violations
							.map(errorToString)
							.join(" ")}`,
					);
				}

				/* One manifest resolution (with bytes) feeds both the
				 * expander's media references and — for a media-bearing app —
				 * the byte bundle. A media-free app resolves to an empty
				 * manifest at no byte cost. */
				const {
					doc: preparedDoc,
					assets,
					compiledAtSeq,
					lookupWire,
				} = boundary.prepared;
				const hasMedia = assets.size > 0;
				const featureFlagReport = featureFlagReportForDownload(preparedDoc);
				const featureFlagContent =
					featureFlagAdvisoryContent(featureFlagReport);
				const featureFlagMeta = {
					"nova/featureFlagRequirements": featureFlagReport,
				};
				/* What the artifact could not carry, said beside it rather
				 * than instead of it: the compile succeeded and the bytes are
				 * complete for the target Nova could name. */
				const advisories = exportAdvisories(
					preparedDoc,
					attachmentDeploymentTarget.kind,
				);
				const advisoryContent = exportAdvisoryContent(advisories);
				const advisoryMeta =
					advisories.length === 0
						? {}
						: { "nova/exportAdvisories": advisories };

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
						 * shape. The blueprint's `mutation_seq` rides on the
						 * result's `_meta` (protocol metadata, no `outputSchema`
						 * needed) rather than the `text` body — the JSON export
						 * is the byte-identical HQ-import artifact, so the seq
						 * names its document version out-of-band. */
						const compiledAtMeta = {
							_meta: {
								"nova/compiledAtSeq": compiledAtSeq,
								...featureFlagMeta,
								...advisoryMeta,
							},
						};
						const hqJson = expandDoc(
							preparedDoc,
							hasMedia ? { assets, attachmentTarget } : { attachmentTarget },
						);
						if (!hasMedia) {
							/* Bare HQ JSON — the caller asked for JSON and, with
							 * no media to carry, gets JSON. */
							return {
								content: [
									...featureFlagContent,
									...advisoryContent,
									{ type: "text", text: JSON.stringify(hqJson) },
								],
								...compiledAtMeta,
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
								...featureFlagContent,
								...advisoryContent,
								{
									type: "text",
									text: JSON.stringify({
										format: "zip",
										encoding: "base64",
										data: archive.toString("base64"),
									}),
								},
							],
							...compiledAtMeta,
						};
					}
					case "ccz": {
						/* The archive bundles the bytes alongside the
						 * references; an empty manifest bundles none.
						 * `compileCcz` returns a Node `Buffer`; MCP text
						 * content is UTF-8 only, so base64 is the safest
						 * lossless escape, and the `encoding` field inside the
						 * wrapper tells the caller to decode it. */
						const hqJson = expandDoc(preparedDoc, {
							assets,
							attachmentTarget,
							...(lookupWire && { lookupNaming: lookupWire.naming }),
						});
						/* Stamp the blueprint's `mutation_seq` into the profile's
						 * `cc-content-version` so the archive names the exact
						 * document version it was built from. */
						const cczBuf = compileCcz(hqJson, app.app_name, preparedDoc, {
							assets,
							compiledAtSeq,
							...(lookupWire && { lookup: lookupWire }),
						});
						return {
							content: [
								...featureFlagContent,
								...advisoryContent,
								{
									type: "text",
									text: JSON.stringify({
										format: "ccz",
										encoding: "base64",
										data: cczBuf.toString("base64"),
									}),
								},
							],
							_meta: { ...featureFlagMeta, ...advisoryMeta },
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

/** Separate leading advisory block keeps the requested artifact byte-identical
 * while ensuring a host's initial-result preview shows the requirements before
 * a potentially megabyte-scale artifact. */
function featureFlagAdvisoryContent(report: HqFeatureFlagReport) {
	if (report.required_flags.length === 0) return [];
	return [
		{
			type: "text" as const,
			text: JSON.stringify({
				kind: "nova_hq_feature_flag_requirements",
				feature_flag_requirements: report,
			}),
		},
	];
}

/** The download path's advisories, in the same leading-block shape the
 * feature-flag requirements use and for the same reason: a host's initial
 * result preview shows them before a potentially megabyte-scale artifact. */
function exportAdvisoryContent(advisories: readonly ExportAdvisory[]) {
	if (advisories.length === 0) return [];
	return [
		{
			type: "text" as const,
			text: JSON.stringify({
				kind: "nova_export_advisories",
				export_advisories: advisories,
			}),
		},
	];
}
