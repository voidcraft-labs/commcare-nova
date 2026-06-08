/**
 * `nova.upload_media_asset` — upload a media file to the calling user's
 * library from inline base64 bytes (MCP-only).
 *
 * The browser uploads via the hash → PUT → confirm dance in
 * `app/api/media/upload` — it computes the sha256 client-side and PUTs the
 * bytes to a same-origin route. An MCP client (Claude Code et al) can't run
 * that flow,
 * so it needs a bytes-inline path: the caller sends the file's base64 and
 * filename, the server decodes, validates, stores, and returns the asset
 * id the `attach*` / `set*` media tools then reference.
 *
 * The bytes pass through the SAME validation pipeline the HTTP confirm
 * route runs (`validateMediaBytes` — extension whitelist, size cap,
 * magic-bytes sniff, library re-parse, sha256). The rejection contract is
 * therefore identical: the accepted set excludes `.m4a` / `.ogg` (HQ
 * can't ingest them). The `claimedContentHash` is omitted — the bytes
 * never left the server's memory, so there's nothing to tamper with
 * between a claim and the store (validate.ts documents the MCP path skips
 * it).
 *
 * After a clean validation the tool dedups against the user's library
 * (same `(owner, contentHash)` probe the HTTP path uses): a re-upload of
 * bytes already present returns the existing `ready` asset's id without
 * re-storing. On a miss it writes the GCS object, creates the asset row,
 * and flips it to `ready` with the validated dimensions / duration —
 * collapsing the HTTP flow's two phases (initiate + confirm) into one
 * server-side pass, since there's no client round trip to gate.
 *
 * MCP-only tool: hand-registered via the `register*(server, ctx)` facade,
 * not the shared adapter — it neither operates on a `BlueprintDoc` nor
 * targets an app id, so it doesn't fit the shared-tool contract.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	confirmAssetReady,
	createPendingAsset,
	findReadyAssetByOwnerAndHash,
} from "@/lib/db/mediaAssets";
import {
	ASSET_SIZE_CAPS_BYTES,
	gcsObjectKeyFor,
} from "@/lib/domain/multimedia";
import { validateMediaBytes } from "@/lib/media/validate";
import { uploadAssetBytes } from "@/lib/storage/media";
import {
	McpInvalidInputError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import type { ToolContext } from "../types";

const MAX_INLINE_UPLOAD_BYTES = Math.max(
	...Object.values(ASSET_SIZE_CAPS_BYTES),
);
const MAX_INLINE_UPLOAD_MB = Math.floor(MAX_INLINE_UPLOAD_BYTES / 1024 / 1024);
const MAX_INLINE_BASE64_CHARS = Math.ceil(MAX_INLINE_UPLOAD_BYTES / 3) * 4;

/**
 * Input schema for `upload_media_asset`, declared as a `z.object` so the
 * schema-compiler smoke test (`scripts/test-schema.ts`) can exercise it
 * the same way it does the shared tools. The registration below hands the
 * raw `.shape` to `McpServer.registerTool` (which wants a `ZodRawShape`),
 * so the wire surface is byte-identical to an inline shape — the object
 * wrapper exists only to give the schema an exported, testable identity.
 *
 * No `app_id` slot: the upload targets the user's library (resolved from
 * `ctx.userId`), not a specific app.
 */
export const uploadMediaAssetInputSchema = z
	.object({
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
				"The file's MIME type (e.g. `image/png`, `audio/mpeg`, `video/mp4`). Checked against the file's real bytes — a mismatch is rejected.",
			),
		data_base64: z
			.string()
			.min(1)
			.max(MAX_INLINE_BASE64_CHARS)
			.describe("The file's full contents, base64-encoded."),
	})
	.strict();

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
				"Upload a media file (image, audio, or video) to your library from inline base64 bytes, returning the asset id the attach/set media tools reference. Audio must be .mp3 or .wav and video .mp4 — CommCare HQ can't ingest .m4a or .ogg. Images: .png/.jpg/.gif/.webp. The file is validated (format, size, integrity) before it's stored; a re-upload of an identical file returns the existing asset.",
			inputSchema: uploadMediaAssetInputSchema.shape,
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
				if (base64.length > MAX_INLINE_BASE64_CHARS) {
					throw new McpInvalidInputError(
						`The inline media payload is too large. Uploads are capped at ${MAX_INLINE_UPLOAD_MB} MB before base64 encoding; send a smaller file.`,
					);
				}
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

				/* Dedup against the user's library on the validated content
				 * hash. A re-upload of bytes already present as a `ready`
				 * asset returns that asset's id and skips the store entirely
				 * — same dedup the HTTP initiate route does, just after
				 * validation instead of before (the MCP path has no
				 * client-computed hash to probe with up front). */
				const existing = await findReadyAssetByOwnerAndHash(
					ctx.userId,
					validated.contentHash,
				);
				if (existing) {
					return successResult(existing.id, validated.kind, true);
				}

				/* New blob. Write the GCS object first, then the asset row,
				 * then flip it `ready` with the validated dimensions /
				 * duration. The HTTP flow splits store (the byte-PUT route)
				 * from confirm (re-validate); here there's no client round
				 * trip, so both collapse into one server-side pass against the
				 * already-validated bytes. */
				const gcsObjectKey = gcsObjectKeyFor(
					ctx.userId,
					validated.contentHash,
					validated.extension,
				);
				await uploadAssetBytes({
					gcsObjectKey,
					bytes,
					contentType: validated.mimeType,
				});
				const pending = await createPendingAsset({
					owner: ctx.userId,
					contentHash: validated.contentHash,
					mimeType: validated.mimeType,
					kind: validated.kind,
					extension: validated.extension,
					sizeBytes: validated.sizeBytes,
					gcsObjectKey,
					originalFilename: args.filename,
				});
				await confirmAssetReady({
					assetId: pending.assetId,
					...(validated.dimensions !== undefined && {
						dimensions: validated.dimensions,
					}),
					...(validated.durationMs !== undefined && {
						durationMs: validated.durationMs,
					}),
				});

				return successResult(pending.assetId, validated.kind, false);
			} catch (err) {
				return toMcpErrorResult(err, { userId: ctx.userId });
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
