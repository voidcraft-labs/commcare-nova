/**
 * SA tool: `remove_media_asset` — delete one media asset from the user's
 * library.
 *
 * No DELETE HTTP route exists to reuse; the deletion is composed here from
 * the same storage + DB primitives the upload-rejection path uses:
 * `loadAssetForOwner` (ownership-gate + resolve the GCS object key),
 * `mediaAssets.deleteAsset` (Firestore row), and `storage.deleteAsset`
 * (GCS object) only when no other asset row shares the bytes.
 *
 * **Reference guard.** Before deleting, the tool scans the current app's
 * doc AND the user's other live apps for live references to the asset
 * (`walkAssetRefs`). If any carrier still points at it, the tool refuses
 * and names the carrier(s) — deleting a referenced asset would orphan a
 * live reference, which the media validation gate would then reject at
 * upload/compile time with a "not found" error far from where the SA could
 * fix it. Refusing at the source keeps the docs' references and the
 * library in sync.
 *
 * Ownership is enforced by `loadAssetForOwner`, which throws
 * `MediaAssetOwnershipError` for a foreign-owned row; the tool maps both
 * "not yours" and "doesn't exist" to the same "not found" message so a
 * probing caller can't tell them apart.
 *
 * Read-shaped (`kind: "read"`): the deletion is an external side effect on
 * the library, not a doc mutation, so there's no `Mutation` to advance the
 * SA's working doc. Both the SA chat factory and the MCP adapter call this
 * through the shared `ToolExecutionContext`.
 */

import { z } from "zod";
import { listApps, loadApp } from "@/lib/db/apps";
import {
	deleteAsset as deleteAssetRow,
	hasOtherAssetForGcsObjectKey,
	loadAssetForOwner,
	MediaAssetOwnershipError,
} from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { asAssetId } from "@/lib/domain";
import { type AssetRef, walkAssetRefs } from "@/lib/domain/mediaRefs";
import { log } from "@/lib/logger";
import { deleteAsset as deleteGcsObject } from "@/lib/storage/media";
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

		// Ownership-gate + resolve the GCS object key. A foreign-owned row
		// throws `MediaAssetOwnershipError`; collapse it to the same
		// "not found" the missing-row branch returns so a probing caller
		// can't distinguish "isn't yours" from "doesn't exist".
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

		// Reference guard: refuse if any carrier in the current app still
		// points at this asset. Collect the carrier descriptions from the
		// typed walk so the refusal names the exact slots to clear.
		const referencingCarriers: string[] = [];
		for (const ref of walkAssetRefs(doc)) {
			if (ref.assetId === input.assetId) {
				referencingCarriers.push(describeCarrier(ref));
			}
		}
		if (referencingCarriers.length > 0) {
			const unique = [...new Set(referencingCarriers)];
			return {
				kind: "read" as const,
				data: {
					error: `Can't delete media asset "${input.assetId}" — the app still uses it on ${unique.join("; ")}. Clear those references (attach different media or empty the slot) before deleting the asset.`,
				},
			};
		}
		const otherAppReferences = await findOtherAppReferences(ctx, input.assetId);
		if (otherAppReferences.length > 0) {
			return {
				kind: "read" as const,
				data: {
					error: `Can't delete media asset "${input.assetId}" — other apps still use it: ${otherAppReferences.join("; ")}. Clear those references before deleting the asset.`,
				},
			};
		}

		const sharedObject = await hasOtherAssetForGcsObjectKey(
			ctx.userId,
			asset.gcsObjectKey,
			asset.id,
		).catch((err: unknown) => {
			log.error("[remove_media_asset] shared-object check failed", {
				assetId,
				gcsObjectKey: asset.gcsObjectKey,
				err,
			});
			// If we cannot prove the bytes are unshared, retain them.
			return true;
		});
		// No live references — safe to remove from the library. Drop the row
		// first so a storage-cleanup failure can only leave an orphaned blob,
		// never a ready row pointing at missing bytes.
		await deleteAssetRow(assetId);
		if (!sharedObject) {
			await deleteGcsObject(asset.gcsObjectKey);
		}

		return {
			kind: "read" as const,
			data: {
				removed: true,
				message: `Deleted media asset "${input.assetId}" (${asset.originalFilename}).`,
			},
		};
	},
};

const OTHER_APP_SCAN_PAGE_SIZE = 50;
const OTHER_APP_REF_LIMIT = 5;

async function findOtherAppReferences(
	ctx: ToolExecutionContext,
	assetId: string,
): Promise<string[]> {
	const references: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await listApps(ctx.userId, {
			limit: OTHER_APP_SCAN_PAGE_SIZE,
			sort: "updated_desc",
			cursor,
		});
		for (const summary of page.apps) {
			if (summary.id === ctx.appId) continue;
			const app = await loadApp(summary.id);
			if (!app || app.owner !== ctx.userId || app.deleted_at !== null) continue;
			const doc = { ...app.blueprint, fieldParent: {} } as BlueprintDoc;
			const carriers = [...walkAssetRefs(doc)]
				.filter((ref) => ref.assetId === assetId)
				.map(describeCarrier);
			if (carriers.length === 0) continue;
			references.push(
				`"${summary.app_name}" (${summary.id}) on ${[...new Set(carriers)].join(
					"; ",
				)}`,
			);
			if (references.length >= OTHER_APP_REF_LIMIT) return references;
		}
		cursor = page.nextCursor;
	} while (cursor);
	return references;
}

/**
 * Render a media reference's carrier into a human-readable phrase for the
 * refusal message. Each `MediaRefLocation` variant names the slot + the
 * entity it lives on, so the SA knows exactly which attachment to clear.
 * The phrasing avoids wire vocabulary — it speaks the authoring layer's
 * own nouns (module / form / field / option / logo).
 */
function describeCarrier(ref: AssetRef): string {
	const loc = ref.location;
	switch (loc.kind) {
		case "app_logo":
			return "the app logo";
		case "module_icon":
			return `the icon on module "${loc.moduleName}"`;
		case "module_audio_label":
			return `the audio label on module "${loc.moduleName}"`;
		case "case_list_icon":
			return `the case-list icon on module "${loc.moduleName}"`;
		case "case_list_audio_label":
			return `the case-list audio label on module "${loc.moduleName}"`;
		case "form_icon":
			return `the icon on form "${loc.formName}" (module "${loc.moduleName}")`;
		case "form_audio_label":
			return `the audio label on form "${loc.formName}" (module "${loc.moduleName}")`;
		case "field_media_bundle":
			return `the ${ref.slotKind} on field "${loc.fieldId}"'s ${bundleSlotLabel(loc.bundleKey)} (form "${loc.formName}")`;
		case "option_media":
			return `the ${ref.slotKind} on option "${loc.optionValue}" of field "${loc.fieldId}" (form "${loc.formName}")`;
		case "image_map_mapping":
			return `the image-map row "${loc.rowValue}" in column "${loc.columnHeader}" (module "${loc.moduleName}")`;
	}
}

/** Friendly label for a field message-bundle key. */
function bundleSlotLabel(
	bundleKey: "label_media" | "hint_media" | "help_media" | "validate_msg_media",
): string {
	switch (bundleKey) {
		case "label_media":
			return "label";
		case "hint_media":
			return "hint";
		case "help_media":
			return "help";
		case "validate_msg_media":
			return "validation message";
	}
}
