/**
 * SA tool: `remove_media_asset` — delete one media asset from the user's
 * library.
 *
 * The deletion mechanics — the reference guard and the storage purge — live in
 * `lib/media/assetDeletion.ts`, shared with the browser `DELETE` route so the
 * two surfaces can't drift. This tool wraps them with the one SA-specific
 * concern: it also checks the in-hand WORKING doc (which may carry unsaved
 * mutations the persisted copy lacks) before scanning the owner's other apps.
 *
 * **Reference guard.** Refuse if any carrier — in the current working app OR any
 * other live app — still points at the asset, naming the slots to clear:
 * deleting a referenced asset orphans a live reference the media-validation gate
 * would later reject far from where the SA could fix it.
 *
 * Ownership is enforced by `loadAssetForOwner`, which throws
 * `MediaAssetOwnershipError` for a foreign-owned row; the tool maps both "not
 * yours" and "doesn't exist" to the same "not found" message so a probing caller
 * can't tell them apart.
 *
 * Read-shaped (`kind: "read"`): the deletion is an external side effect on the
 * library, not a doc mutation, so there's no `Mutation` to advance the SA's
 * working doc.
 */

import { z } from "zod";
import {
	loadAssetForOwner,
	MediaAssetOwnershipError,
} from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { asAssetId } from "@/lib/domain";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";
import { extractObjectKeyForAsset } from "@/lib/domain/multimedia";
import {
	describeCarrier,
	findAppReferencesToAsset,
	purgeAssetStorage,
} from "@/lib/media/assetDeletion";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import type { ReadToolResult } from "../common";

export const removeMediaAssetInputSchema = z
	.object({
		assetId: z
			.string()
			.min(1)
			.describe(
				"The id of the media asset to delete (from list_media_assets).",
			),
	})
	.strict();

export type RemoveMediaAssetInput = z.infer<typeof removeMediaAssetInputSchema>;

/** A successful deletion or an Elm-shape refusal/error string. */
export type RemoveMediaAssetResult =
	| { removed: true; message: string }
	| { error: string };

export const removeMediaAssetTool = {
	description:
		"Delete one media asset from the user's library. Refuses if any live app still references the asset anywhere — clear those references first. Identify the asset by its id from list_media_assets.",
	inputSchema: removeMediaAssetInputSchema,
	async execute(
		input: RemoveMediaAssetInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<ReadToolResult<RemoveMediaAssetResult>> {
		const assetId = asAssetId(input.assetId);

		// Ownership-gate + resolve the asset. A foreign-owned row throws
		// `MediaAssetOwnershipError`; collapse it to the same "not found" the
		// missing-row branch returns so a probing caller can't distinguish "isn't
		// yours" from "doesn't exist".
		const asset = await loadAssetForOwner(ctx.userId, assetId).catch(
			(err: unknown) => {
				if (err instanceof MediaAssetOwnershipError) return null;
				throw err;
			},
		);
		if (!asset) {
			return {
				kind: "read" as const,
				data: {
					error: `No media asset with id "${input.assetId}" is in your library — it may already have been deleted. Run list_media_assets to see the current assets.`,
				},
			};
		}

		// Reference guard, part 1: the in-hand WORKING doc (current app, possibly
		// carrying unsaved mutations the persisted copy lacks).
		const inHandCarriers = [
			...new Set(
				[...walkAssetRefs(doc)]
					.filter((ref) => ref.assetId === input.assetId)
					.map(describeCarrier),
			),
		];
		if (inHandCarriers.length > 0) {
			return {
				kind: "read" as const,
				data: {
					error: `Can't delete media asset "${input.assetId}" — the app still uses it on ${inHandCarriers.join("; ")}. Clear those references (attach different media or empty the slot) before deleting the asset.`,
				},
			};
		}

		// Reference guard, part 2: every OTHER live app's persisted doc. The
		// current app is covered by the working-doc check above, so skip it here.
		const otherAppReferences = await findAppReferencesToAsset(
			ctx.userId,
			input.assetId,
			{ skipAppId: ctx.appId },
		);
		if (otherAppReferences.length > 0) {
			return {
				kind: "read" as const,
				data: {
					error: `Can't delete media asset "${input.assetId}" — other apps still use it: ${otherAppReferences.join("; ")}. Clear those references before deleting the asset.`,
				},
			};
		}

		// No live references — purge the row, the bytes, and the document-extract
		// sibling (if any), keeping shared bytes intact.
		await purgeAssetStorage(asset, {
			alsoDelete: [extractObjectKeyForAsset(asset)],
		});

		return {
			kind: "read" as const,
			data: {
				removed: true,
				message: `Deleted media asset "${input.assetId}" (${asset.originalFilename}).`,
			},
		};
	},
};
