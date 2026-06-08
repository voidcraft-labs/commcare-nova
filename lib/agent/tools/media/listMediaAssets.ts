/**
 * SA tool: `list_media_assets` — list the calling user's media assets.
 *
 * Load-bearing: this is how the SA discovers the asset ids the `attach*` /
 * `set*` media tools need. Without it, the SA has no way to learn which
 * assets the user has uploaded, so every media attachment would be a
 * blind guess at an id.
 *
 * Reuses the same library read the web library route uses
 * (`listReadyAssetsForOwner`) — `ready` assets only, newest first,
 * owner-scoped. The tool projects each row to the same client-facing wire
 * shape (`toWireMediaAsset`) so the SA sees the identical fields the
 * browser library does: id, kind, filename / display name, MIME type,
 * status, size, plus dimensions / duration.
 *
 * One page per call (the library page size). The library is cursor-
 * paginated; the tool surfaces `nextCursor` so a follow-up call can
 * fetch the next page, and accepts an optional `kind` filter when the SA
 * only wants images, audio, or video.
 *
 * Read-only — no doc mutation. Returns a `ReadToolResult` (`kind:
 * "read"`); the chat wrapper unwraps `data`, the MCP adapter projects it
 * to the wire envelope.
 */

import { z } from "zod";
import {
	listReadyAssetsForOwner,
	toWireMediaAsset,
	type WireMediaAsset,
} from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { MEDIA_KINDS } from "@/lib/domain";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import type { ReadToolResult } from "../common";

export const listMediaAssetsInputSchema = z
	.object({
		kind: z
			.enum(MEDIA_KINDS)
			.optional()
			.describe(
				"Filter to one media kind (`image` / `audio` / `video`). Omit to list every kind.",
			),
		cursor: z
			.string()
			.optional()
			.describe(
				"Opaque page cursor from a previous call's `nextCursor`. Omit for the first page.",
			),
	})
	.strict();

export type ListMediaAssetsInput = z.infer<typeof listMediaAssetsInputSchema>;

/**
 * One page of the user's library plus the next-page cursor. `assets`
 * carries the same wire shape the browser library renders; `nextCursor`
 * is `null` on the last page.
 */
export interface ListMediaAssetsResult {
	assets: WireMediaAsset[];
	nextCursor: string | null;
}

export const listMediaAssetsTool = {
	description:
		"List the user's uploaded media assets (ready ones, newest first). This is how you discover the asset ids the attach/set media tools need. Each asset carries its id, kind, filename, MIME type, and size. Optionally filter by kind; paginate with the returned cursor.",
	inputSchema: listMediaAssetsInputSchema,
	async execute(
		input: ListMediaAssetsInput,
		ctx: ToolExecutionContext,
		_doc: BlueprintDoc,
	): Promise<ReadToolResult<ListMediaAssetsResult>> {
		const { assets, nextCursor } = await listReadyAssetsForOwner(ctx.userId, {
			// The tool filters by a single kind; the DB layer takes a set, so wrap it.
			...(input.kind !== undefined && { kinds: [input.kind] }),
			...(input.cursor !== undefined && { cursor: input.cursor }),
		});
		return {
			kind: "read" as const,
			data: {
				assets: assets.map(toWireMediaAsset),
				nextCursor,
			},
		};
	},
};
