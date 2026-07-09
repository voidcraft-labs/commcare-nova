/**
 * SA tool: `remove_media_asset` — delete one media asset from the user's
 * library.
 *
 * The deletion mechanics — the reference guard and the storage purge — live in
 * `lib/media/assetDeletion.ts`, shared with the browser `DELETE` route so the
 * two surfaces can't drift. This tool wraps them with the one SA-specific
 * concern: it also checks the in-hand WORKING doc (which may carry unsaved
 * mutations the persisted copy lacks) before scanning the Project's other apps.
 *
 * **Reference guard.** Refuse if any carrier — in the current working app OR any
 * other live app — still points at the asset, naming the slots to clear:
 * deleting a referenced asset orphans a live reference the export boundary gate
 * would later reject far from where the SA could fix it.
 *
 * Authorization is by Project: the asset is loaded id-only (`loadAssetById`) and
 * accepted only when its `project_id` matches the app's Project; a foreign-Project
 * row and a missing row collapse to the same "not found" message so a probing
 * caller can't tell them apart.
 *
 * Read-shaped (`kind: "read"`): the deletion is an external side effect on the
 * library, not a doc mutation, so there's no `Mutation` to advance the SA's
 * working doc.
 */

import { z } from "zod";
import { listReferencingAppIds, loadAssetById } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { asAssetId } from "@/lib/domain";
import { extractObjectKeyForAsset } from "@/lib/domain/multimedia";
import {
	carriersForAsset,
	findAppReferencesToAsset,
	purgeAssetStorage,
} from "@/lib/media/assetDeletion";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import type { ReadToolResult } from "../common";
import { requireToolProjectId } from "./shared";

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

		const projectId = await requireToolProjectId(ctx.appId);

		// Resolve the asset id-only, then Project-gate it. A row in another Project
		// (or no row at all) collapses to the same "not found" so a probing caller
		// can't distinguish "isn't in your Project" from "doesn't exist".
		const asset = await loadAssetById(assetId);
		if (!asset || asset.project_id !== projectId) {
			return {
				kind: "read" as const,
				data: {
					error: `No media asset with id "${input.assetId}" is in your library — it may already have been deleted. Run list_media_assets to see the current assets.`,
				},
			};
		}

		// Reference guard, part 1: the in-hand WORKING doc (current app, possibly
		// carrying unsaved mutations the persisted copy lacks). Same carrier walk
		// the persisted-doc guard uses, so the two refusals can't phrase a carrier
		// differently.
		const inHandCarriers = carriersForAsset(doc, input.assetId);
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
		// `listReferencingAppIds` reads the reverse index — the guard re-walks only
		// those candidates instead of loading every one of the Project's apps.
		const otherAppReferences = await findAppReferencesToAsset(
			projectId,
			input.assetId,
			await listReferencingAppIds(input.assetId),
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
