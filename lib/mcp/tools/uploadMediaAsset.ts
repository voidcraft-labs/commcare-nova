/**
 * `nova.upload_media_asset` — upload a media file to a Nova Project's
 * media library from inline base64 bytes (MCP-only). The target defaults
 * to the caller's personal Project; an explicit `project_id` targets a
 * shared Project instead (membership at `edit` required).
 *
 * The browser uploads via the hash → signed-PUT → confirm dance in
 * `app/api/media/upload` — it can compute the sha256 client-side and PUT
 * straight to GCS. An MCP client (Claude Code et al) can't run that flow,
 * so it needs a bytes-inline path: the caller sends the file's base64 and
 * filename, the server decodes, validates, stores, and returns the asset
 * id the `attach*` / `set*` media tools then reference.
 *
 * The bytes pass through the SAME validation pipeline the HTTP confirm
 * route runs (`validateMediaBytes` — extension whitelist, size cap,
 * magic-bytes sniff, body checks, sha256). The rejection contract is
 * therefore identical: the accepted set is the registry's
 * (`lib/domain/multimedia.ts::ACCEPTED_FORMATS`), each format in the variant
 * every CommCare platform plays. The `claimedContentHash` is omitted — the bytes
 * never left the server's memory, so there's nothing to tamper with
 * between a claim and the store (validate.ts documents the MCP path skips
 * it).
 *
 * After a clean validation the tool publishes through
 * `lib/media/publishReadyMedia.ts::publishReadyMedia`, the one in-memory
 * publisher: it dedups against the Project library (same
 * `(project_id, contentHash)` probe the HTTP path uses), so a re-upload of
 * bytes already present returns the existing `ready` asset's id without
 * re-storing; on a miss it writes the content-addressed GCS object and
 * publishes the complete `ready` row in one metadata transaction, reconciling
 * an ambiguous commit response under the same content lock. Its permission
 * refusal (`MediaPublishPermissionError`) maps back to this tool's two access
 * errors, so a caller reads the same answer whichever check refused it.
 *
 * MCP-only tool: hand-registered via the `register*(server, ctx)` facade,
 * not the shared adapter — it neither operates on a `BlueprintDoc` nor
 * targets an app id, so it doesn't fit the shared-tool contract.
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ensurePersonalProject } from "@/lib/auth/provisionProject";
import { ASSET_SIZE_CAPS_BYTES, asMediaAssetId } from "@/lib/domain/multimedia";
import {
	MediaPublishPermissionError,
	publishReadyMedia,
} from "@/lib/media/publishReadyMedia";
import { validateMediaBytes } from "@/lib/media/validate";
import { ProjectPermissionError } from "@/lib/projects/manage";
import {
	McpInvalidInputError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { McpAccessError, requireProjectAccess } from "../ownership";
import type { ToolContext } from "../types";

const MAX_INLINE_UPLOAD_BYTES = Math.max(
	...Object.values(ASSET_SIZE_CAPS_BYTES),
);
const MAX_INLINE_BASE64_CHARS = Math.ceil(MAX_INLINE_UPLOAD_BYTES / 3) * 4;
const UPLOAD_PERMISSION_MESSAGE =
	"Your role in this Project can't upload media. Ask a Project admin to make you an editor.";

/**
 * Input schema for `upload_media_asset`, exported so the schema-compiler
 * smoke test (`scripts/test-schema.ts`) can exercise it the same way it
 * does the shared tools. The registration below passes the object schema
 * to `McpServer.registerTool` whole.
 *
 * No `app_id` slot: media is Project-scoped, not app-scoped. The optional
 * `project_id` targets a shared Project's library; omitted, the upload
 * lands in the caller's personal Project (resolved from `ctx.userId` via
 * `ensurePersonalProject`).
 */
export const uploadMediaAssetInputSchema = z.strictObject({
	filename: z
		.string()
		.min(1)
		.max(255)
		.describe(
			"The file's name including its extension (e.g. `clinic-logo.png`). The extension is pre-screened and must match the file's real format.",
		),
	mime_type: z
		.string()
		.min(1)
		.describe(
			"The file's MIME type (e.g. `image/png`, `audio/mpeg`, `video/mp4`). Checked against the file's real bytes, a mismatch is rejected.",
		),
	data_base64: z
		.string()
		.min(1)
		.max(MAX_INLINE_BASE64_CHARS)
		.describe("The file's full contents, base64-encoded."),
	project_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Optional Project whose media library receives the file, from list_projects. Requires an editor or higher role there. Omitted, the file lands in your personal Project's library. Media is Project-scoped, so use the Project of the app that will reference it.",
		),
});

/**
 * Register the `upload_media_asset` tool on an `McpServer`.
 *
 * The handler validates BEFORE allocating any storage: a base64 decode
 * failure or a validation rejection throws `McpInvalidInputError`, which
 * the outer catch maps to an `invalid_input` envelope carrying the
 * pipeline's Elm-shape message verbatim — so an MCP client sees exactly
 * why its upload was refused (wrong format, too big, corrupt, etc.).
 */
export function registerUploadMediaAsset(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"upload_media_asset",
		{
			description:
				"Upload a media file (image, audio, or video) from inline base64 bytes, returning the asset id the attach/set media tools reference. Media is Project-scoped: pass project_id to upload into a shared Project's library (use the Project of the app that will reference it); omit it for your personal Project. Images: .png, .jpg, .gif, .webp, .bmp, .ico or .avif. Audio: .mp3, .wav (8- or 16-bit PCM), .m4a (AAC), .flac, .ogg (Vorbis or Opus), .aac, .amr or .mid. Video: .mp4 (H.264, HEVC Main or MPEG-4 Part 2), .webm (VP8, or VP9 in 8-bit 4:2:0 color) or .mkv. ICO and AVIF play only in Web Apps; AAC, AMR, MIDI, HEVC, MPEG-4 Part 2 and MKV play only on Android, and an app takes a file only where it plays on every platform the app runs on. list_media_assets shows where each file plays. The file is validated (format, encoding, size, integrity) before it's stored; a re-upload of an identical file returns the existing asset.",
			inputSchema: uploadMediaAssetInputSchema,
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				/* Decode the base64 payload. A malformed string is a client
				 * mistake, not a server bug — throw `McpInvalidInputError`
				 * so it surfaces as an `invalid_input` envelope with an
				 * actionable message rather than landing in the generic
				 * `internal` bucket. `Buffer.from(.., "base64")` is lenient
				 * (it silently drops invalid chars), so an empty decode of a
				 * non-empty input is the signal that the payload wasn't
				 * valid base64. */
				const base64 = args.data_base64.replace(/\s+/g, "");
				const bytes = Buffer.from(base64, "base64");
				if (bytes.length === 0) {
					throw new McpInvalidInputError(
						"The base64 file contents couldn't be decoded into any bytes. Make sure `data_base64` is the file's full base64 encoding.",
					);
				}

				/* Run the shared validation gauntlet. `claimedSizeBytes` is
				 * the decoded length (there's no separate client claim to
				 * cross-check on this path), and `claimedContentHash` is
				 * omitted — the bytes never left server memory, so there's
				 * no transit window to verify against. A rejection rides
				 * through as `invalid_input` with the pipeline's Elm-shape
				 * message. */
				const result = await validateMediaBytes({
					bytes,
					claimedMimeType: args.mime_type,
					claimedSizeBytes: bytes.length,
					originalFilename: args.filename,
				});
				if (!result.ok) {
					throw new McpInvalidInputError(result.message);
				}
				const validated = result.validated;

				/* Resolve the target Project — the tenancy + access gate
				 * every read site authorizes against. An explicit project_id
				 * needs the `edit` capability there; omitted, the upload
				 * lands in the caller's personal Project (mirrors
				 * `begin_work`). */
				const project = args.project_id
					? (
							await requireProjectAccess(
								ctx.userId,
								args.project_id,
								"edit",
								UPLOAD_PERMISSION_MESSAGE,
							)
						).projectId
					: await ensurePersonalProject(ctx.userId);

				const publication = await publishReadyMedia({
					actorUserId: ctx.userId,
					projectId: project,
					bytes,
					validated,
					originalFilename: args.filename,
					assetId: asMediaAssetId(randomUUID()),
				}).catch((error: unknown) => {
					if (!(error instanceof MediaPublishPermissionError)) throw error;
					throw error.reason === "not-a-member"
						? new McpAccessError("not_owner", "project")
						: new ProjectPermissionError(UPLOAD_PERMISSION_MESSAGE);
				});

				return successResult(
					publication.assetId,
					validated.kind,
					publication.kind === "deduplicated",
				);
			} catch (err) {
				return toMcpErrorResult(err, {
					userId: ctx.userId,
					projectId: args.project_id,
				});
			}
		},
	);
}

/**
 * Build the success envelope for an uploaded (or deduplicated) asset. The
 * JSON content carries the `asset_id` the attach/set tools consume, the
 * resolved `kind`, and a `deduplicated` flag so a caller knows whether its
 * bytes were freshly stored or matched an existing library entry.
 */
function successResult(
	assetId: string,
	kind: string,
	deduplicated: boolean,
): McpToolSuccessResult {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({ asset_id: assetId, kind, deduplicated }),
			},
		],
	};
}
