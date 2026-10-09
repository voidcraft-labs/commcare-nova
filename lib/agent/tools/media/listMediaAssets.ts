/**
 * SA tool: `list_media_assets` — list the app's Project media library.
 *
 * Load-bearing: this is how the SA discovers the asset ids the `attach*` /
 * `set*` media tools need. Without it, the SA has no way to learn which
 * assets the Project has uploaded, so every media attachment would be a
 * blind guess at an id.
 *
 * Reuses the same library read the web library route uses
 * (`listReadyAssetsForProject`) — `ready` assets only, newest first,
 * scoped to the app's Project. The tool projects each row to the same
 * client-facing wire shape (`toWireMediaAsset`) so the SA sees the
 * identical fields the browser library does: id, kind, filename / display
 * name, MIME type, status, size, plus dimensions / duration.
 *
 * One page per call (the library page size). The library is cursor-
 * paginated; the tool surfaces `nextCursor` so a follow-up call can
 * fetch the next page, and accepts an optional `kind` filter when the SA
 * only wants a particular media or document kind.
 *
 * Read-only — no doc mutation. Returns a `ReadToolResult` (`kind:
 * "read"`); the chat wrapper unwraps `data`, the MCP adapter projects it
 * to the wire envelope.
 */

import { z } from "zod";
import {
	listReadyAssetsForProject,
	toWireMediaAsset,
	type WireMediaAsset,
} from "@/lib/db/mediaAssets";
import { ASSET_KINDS } from "@/lib/domain";
import type { ToolInvocationContext } from "../../workspace/types";
import type { ReadToolResult } from "../common";
import { requireToolProjectId } from "./shared";

export const listMediaAssetsInputSchema = z.strictObject({
	kind: z
		.enum(ASSET_KINDS)
		.optional()
		.describe(
			"Filter to one file kind: image, audio, video, pdf, text, docx or xlsx. Omit to list every kind.",
		),
	query: z
		.string()
		.max(255)
		.optional()
		.describe(
			"Case-insensitive text to find in filenames, display names and extracted document titles. Search covers the whole Project library before pagination.",
		),
	cursor: z
		.string()
		.optional()
		.describe(
			"Opaque page cursor from a previous call's `nextCursor`. Omit for the first page.",
		),
});

export type ListMediaAssetsInput = z.infer<typeof listMediaAssetsInputSchema>;

/**
 * One page of the Project's library plus the next-page cursor. `assets`
 * carries the same wire shape the browser library renders; `nextCursor`
 * is `null` on the last page.
 */
export interface ListMediaAssetsResult {
	assets: WireMediaAsset[];
	nextCursor: string | null;
}

export const listMediaAssetsTool = {
	description:
		"Search or list files in the Project library, including documents not attached to this conversation. Returns document, image, audio and video ids, names, preparation status and the next page cursor. Read document requirements with readSource; use media ids with attachment tools. Newest files first.",
	inputSchema: listMediaAssetsInputSchema,
	async execute(
		input: ListMediaAssetsInput,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<ListMediaAssetsResult>> {
		/* A genesis change set has no app row; its invocation scope is the
		 * library's tenant. Canonical calls keep resolving the app's fresh
		 * Project, exactly as before. */
		const projectId =
			ctx.appId === null
				? ctx.projectId
				: await requireToolProjectId(ctx.appId);
		const { assets, nextCursor } = await listReadyAssetsForProject(projectId, {
			// The tool filters by a single kind; the DB layer takes a set, so wrap it.
			...(input.kind !== undefined && { kinds: [input.kind] }),
			...(input.cursor !== undefined && { cursor: input.cursor }),
			...(input.query !== undefined && { query: input.query }),
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
