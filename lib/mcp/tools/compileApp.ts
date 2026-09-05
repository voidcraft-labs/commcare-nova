import { COMMCARE_SERVER_IDS } from "@/lib/commcare/servers";
import {
	downloadDeploymentTarget,
	downloadRuntimeTarget,
} from "@/lib/deployment/runtimeTarget";
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
import { buildHqJsonExportArchive } from "@/lib/commcare/multimedia/hqJsonExportArchive";
import { projectSpaceCompatibilityForDownload } from "@/lib/commcare/projectSpaceCompatibility";
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
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
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
				'Compile an owned app to CommCare HQ format. `format: "json"` returns the HQ JSON as text, or, when the app has media or Project data, a base64-encoded zip bundle so every companion artifact travels with it. `format: "ccz"` returns the binary archive base64-encoded. A download has no selected CommCare HQ project space, so `_meta["nova/projectSpaceCompatibility"]` reports semantic app capabilities as `not_checked` without blocking the compile. When the report is relevant, a `nova_project_space_compatibility` text block appears before the artifact so a large base64 result cannot hide it. Check one actual destination later with `check_project_space_compatibility`, or let `upload_app_to_hq` perform its authoritative pre-write check.',
			inputSchema: z.object({
				server: z
					.enum(COMMCARE_SERVER_IDS)
					.optional()
					.describe(
						"CommCare server for the download. Required when this app has no unique deployed project space.",
					),
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
				const runtimeTarget = downloadRuntimeTarget(
					attachmentDeploymentTarget,
					args.server,
				);
				if (!runtimeTarget)
					throw new McpInvalidInputError(
						"Choose a CommCare server for this download, then try again.",
					);
				const selectedDeployment = downloadDeploymentTarget(
					attachmentDeploymentTarget,
					args.server,
				);
				const attachmentTarget = attachmentUrlTargetFor(selectedDeployment);
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
					lookupNaming,
					lookupWire,
					lookupWorkbook,
				} = boundary.prepared;
				const hasMedia = assets.size > 0;
				const projectSpaceCompatibility =
					projectSpaceCompatibilityForDownload(preparedDoc);
				const projectSpaceCompatibilityContent = compatibilityContent(
					projectSpaceCompatibility,
				);
				const projectSpaceCompatibilityMeta = {
					"nova/projectSpaceCompatibility": projectSpaceCompatibility,
				};
				/* What the artifact could not carry, said beside it rather
				 * than instead of it: the compile succeeded and the bytes are
				 * complete for the target Nova could name. */
				const advisories = exportAdvisories(
					preparedDoc,
					selectedDeployment.kind,
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
								...projectSpaceCompatibilityMeta,
								...advisoryMeta,
							},
						};
						const hqJson = expandDoc(preparedDoc, {
							runtimeTarget,
							attachmentTarget,
							...(hasMedia && { assets }),
							...(lookupNaming && { lookupNaming }),
						});
						if (!hasMedia && lookupWorkbook === undefined) {
							/* Bare HQ JSON — the caller asked for JSON and, with
							 * nothing to carry alongside it, gets JSON. */
							return {
								content: [
									...projectSpaceCompatibilityContent,
									...advisoryContent,
									{ type: "text", text: JSON.stringify(hqJson) },
								],
								...compiledAtMeta,
							};
						}
						/* Carrying companions: the same `<app>.zip` the HTTP
						 * export ships, so the `jr://` references travel with
						 * their bytes and the app's lookup tables travel with
						 * the app. base64 inside a `{ format: "zip", ... }`
						 * wrapper — MCP text content is UTF-8 only, and the
						 * wrapper tells the client to decode rather than parse
						 * the text as the app JSON. */
						const archive = buildHqJsonExportArchive(
							app.app_name,
							hqJson,
							assets,
							lookupWorkbook,
						);
						return {
							content: [
								...projectSpaceCompatibilityContent,
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
							runtimeTarget,
							assets,
							attachmentTarget,
							...(lookupNaming && { lookupNaming }),
						});
						/* Stamp the blueprint's `mutation_seq` into the profile's
						 * `cc-content-version` so the archive names the exact
						 * document version it was built from. */
						const cczBuf = compileCcz(hqJson, app.app_name, preparedDoc, {
							runtimeTarget,
							assets,
							compiledAtSeq,
							...(lookupWire && { lookup: lookupWire }),
						});
						return {
							content: [
								...projectSpaceCompatibilityContent,
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
							_meta: {
								...projectSpaceCompatibilityMeta,
								...advisoryMeta,
							},
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

/** Separate leading compatibility block keeps the requested artifact
 * byte-identical while ensuring a host's initial-result preview shows relevant
 * destination requirements before a potentially megabyte-scale artifact. */
function compatibilityContent(report: ProjectSpaceCompatibilityReport) {
	if (report.status === "not_needed") return [];
	return [
		{
			type: "text" as const,
			text: JSON.stringify({
				kind: "nova_project_space_compatibility",
				project_space_compatibility: report,
			}),
		},
	];
}

/** The download path's advisories, in the same leading-block shape the
 * project-space report uses and for the same reason: a host's initial
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
