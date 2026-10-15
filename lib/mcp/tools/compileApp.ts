/**
 * `nova.compile_app` — produce CommCare artifacts for an app the caller can view.
 *
 * Scope: `nova.read`. Read-only.
 *
 * Two output formats:
 *   - `"json"` — the HQ import file: always the same `<app>.zip` the HTTP
 *     export ships (the app JSON, `multimedia.zip` and `lookup-tables.xlsx`
 *     when the app has them, and `README.txt`, the manual-import guide),
 *     base64-encoded inside a `{ format: "zip", encoding, data }` wrapper. The
 *     guide's steps also lead the result as a `nova_manual_import_guide`
 *     block, so a large base64 artifact cannot hide them. The file is made
 *     for no project space, so a `domain` is refused.
 *   - `"ccz"` — the `.ccz` archive a phone installs, made for one project
 *     space the app is published to (the one `server` and `domain` name, or
 *     the only one there is), base64-encoded inside a
 *     `{ format: "ccz", encoding, data }` wrapper. Its profile names that
 *     space's sign-in, sync and submission addresses, and
 *     `_meta["nova/target"]` names the space and the HQ app its ids are.
 *
 * Both formats expand via `expandDoc`; the zero-tolerance boundary gate runs
 * first so any validator finding — a soundness error, missing completeness
 * work, or a stale media reference — surfaces as actionable `invalid_input`,
 * never a broken artifact.
 *
 * Each result names the document version it was built from — the blueprint's
 * `mutation_seq`. The `"ccz"` path stamps it into the profile's
 * `cc-content-version`; the `"json"` path, whose archive must stay the
 * HQ-import artifact, carries it on the result's `_meta`
 * (`nova/compiledAtSeq`) instead.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { expandDoc } from "@/lib/commcare/expander";
import {
	buildHqJsonExportArchive,
	hqImportFileGuide,
} from "@/lib/commcare/multimedia/hqJsonExportArchive";
import { projectSpaceCompatibilityForDownload } from "@/lib/commcare/projectSpaceCompatibility";
import { COMMCARE_SERVER_IDS } from "@/lib/commcare/servers";
import { errorToString } from "@/lib/commcare/validator/errors";
import {
	downloadAttachmentState,
	resolveDownloadTarget,
} from "@/lib/deployment/downloadTarget";
import { downloadRefusalLines } from "@/lib/deployment/runtimeTarget";
import {
	type ExportMode,
	prepareExportBoundary,
} from "@/lib/export/boundaryValidation";
import { compileLocalArchive } from "@/lib/export/localArchive";
import {
	type ExportAdvisory,
	exportAdvisories,
} from "@/lib/publish/exportAdvisories";
import {
	type ManualImportStep,
	renderManualImportGuide,
} from "@/lib/publish/manualImportGuide";
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
 * `app_name` (the json media bundle's filename) come from the same load.
 * `app.app_name` is non-blank by schema, so this tool threads it straight
 * into `buildHqJsonExportArchive` without a defensive fallback; the ccz
 * profile's name is the document's own `appName`, the same value
 * (`lib/db/blueprintRows.ts` reads the document's name from that column).
 */
export function registerCompileApp(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"compile_app",
		{
			description:
				'Compile an app you can view. `format: "json"` returns the CommCare HQ import file, a base64-encoded zip holding the app JSON, its media and Project data when it has them, and a README with the manual import steps; the steps also come first as a `nova_manual_import_guide` text block. The import file works in any project space, so it takes no `domain`. `format: "ccz"` returns the mobile app file base64-encoded, made for one project space the app is already published to: it signs workers in there and sends their forms there. Pass `domain` (and `server` when two servers hold that name) to choose among several; an app published nowhere has no CCZ yet. `_meta["nova/target"]` names the project space and HQ app a CCZ is made for. A download checks no project space, so `_meta["nova/projectSpaceCompatibility"]` reports semantic app capabilities as `not_checked` without blocking the compile; when the report is relevant, a `nova_project_space_compatibility` text block appears before the artifact. Check one actual destination with `check_project_space_compatibility`, or let `upload_app_to_hq` perform its authoritative pre-write check.',
			inputSchema: z.object({
				server: z
					.enum(COMMCARE_SERVER_IDS)
					.optional()
					.describe(
						"CommCare server of the project space a CCZ is for, when the app is published to more than one. For the import file it only scopes attachment links.",
					),
				domain: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Project space a CCZ is for, by name, when the app is published to more than one. Not taken for `format: "json"`.',
					),
				app_id: z
					.string()
					.describe("App id to compile. Requires view access to its Project."),
				format: z
					.enum(["json", "ccz"])
					.describe(
						'"json" for the CommCare HQ import file (a base64 zip), "ccz" for the mobile app file of one published project space (base64-encoded).',
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
				/* A CCZ is made for one project space this app is published
				 * to, and the import file for none: a reached deployment only
				 * scopes its attachment links. The same choice the browser
				 * download makes, over the document this call loaded. */
				const download = await resolveDownloadTarget(
					{
						appId,
						projectId: access.projectId,
						role: access.role,
						actorUserId: access.actorUserId,
					},
					{
						format: args.format,
						...(args.server !== undefined && { server: args.server }),
						...(args.domain !== undefined && { domain: args.domain }),
						doc,
					},
				);
				if ("kind" in download) {
					throw new McpInvalidInputError(
						[
							download.message,
							...downloadRefusalLines(download).map((line) => `- ${line}`),
						].join("\n"),
					);
				}
				const { attachmentTarget } = download;
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
					downloadAttachmentState(download),
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
						/* The blueprint's `mutation_seq` rides on the result's
						 * `_meta` (protocol metadata, no `outputSchema` needed)
						 * rather than inside the archive, which is the
						 * HQ-import artifact. The file carries no runtime URL:
						 * CommCare HQ writes its own when it builds the app.
						 * Only a media-bearing app passes the manifest, so a
						 * media-free app expands media-OFF. */
						const hqJson = expandDoc(preparedDoc, {
							attachmentTarget,
							...(hasMedia && { assets }),
							...(lookupNaming && { lookupNaming }),
						});
						const guide = hqImportFileGuide({
							appName: app.app_name,
							doc: preparedDoc,
							assets,
							lookupWorkbook,
						});
						/* base64 inside a `{ format: "zip", ... }` wrapper: MCP
						 * text content is UTF-8 only, and the wrapper tells the
						 * client to decode rather than parse the text. */
						const archive = buildHqJsonExportArchive(
							app.app_name,
							hqJson,
							assets,
							lookupWorkbook,
							renderManualImportGuide(guide),
						);
						return {
							content: [
								...projectSpaceCompatibilityContent,
								...advisoryContent,
								manualImportGuideContent(guide),
								{
									type: "text",
									text: JSON.stringify({
										format: "zip",
										encoding: "base64",
										data: archive.toString("base64"),
									}),
								},
							],
							_meta: {
								"nova/compiledAtSeq": compiledAtSeq,
								...projectSpaceCompatibilityMeta,
								...advisoryMeta,
							},
						};
					}
					case "ccz": {
						if (download.format !== "ccz") {
							throw new Error(
								"A CCZ is always made for one project space, and the choice named none.",
							);
						}
						/* The one `.ccz` assembly the browser download uses,
						 * for the project space chosen above: the archive
						 * bundles the bytes alongside the references (an empty
						 * manifest bundles none) and stamps the blueprint's
						 * `mutation_seq` into the profile's
						 * `cc-content-version`. It returns a Node `Buffer`;
						 * MCP text content is UTF-8 only, so base64 is the
						 * safest lossless escape, and the `encoding` field
						 * inside the wrapper tells the caller to decode it. */
						const cczBuf = compileLocalArchive(
							boundary.prepared,
							download.runtimeTarget,
							download.identity,
						);
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
								"nova/target": {
									server: download.target.server,
									domain: download.target.domain,
									hq_app_id: download.target.hqAppId,
								},
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

/** The import file's manual steps, before the artifact for the reason the
 * other leading blocks are: a large base64 result cannot hide them. */
function manualImportGuideContent(guide: readonly ManualImportStep[]) {
	return {
		type: "text" as const,
		text: JSON.stringify({
			kind: "nova_manual_import_guide",
			manual_import_guide: guide,
		}),
	};
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
