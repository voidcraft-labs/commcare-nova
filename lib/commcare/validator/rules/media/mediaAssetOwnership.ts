/**
 * Rule: every referenced asset's `owner` matches the app's owner.
 *
 * Defense-in-depth against cross-owner leakage at the validate
 * boundary. `loadAssetsByIds` (`lib/db/mediaAssets.ts`) already
 * filters by owner before returning rows, so the production loader
 * never produces a manifest that trips this rule — but the rule is
 * the contract, not the loader. A loader change, a hand-built test
 * fixture, or an MCP tool that resolves a foreign asset directly
 * would all reach a path that this rule catches.
 *
 * Skips the existence check itself: an id missing from the manifest
 * is `mediaAssetExists`'s concern. A foreign-owned row present in
 * the manifest is uniquely this rule's concern.
 */

import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";
import { type ValidationError, validationError } from "../../errors";
import { describeLocation, scopeFor, validationLocationFor } from "./shared";

/**
 * Walk every media reference; for any whose resolved row's `owner`
 * doesn't match the expected app owner, emit
 * MEDIA_ASSET_FOREIGN_OWNER. References whose ids don't resolve at
 * all are silently skipped (left to `mediaAssetExists`).
 */
export function mediaAssetOwnership(
	doc: BlueprintDoc,
	manifest: ReadonlyMap<string, MediaAssetRecord>,
	expectedOwner: string,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const ref of walkAssetRefs(doc)) {
		const record = manifest.get(ref.assetId);
		if (!record) continue;
		if (record.owner === expectedOwner) continue;
		errors.push(
			validationError(
				"MEDIA_ASSET_FOREIGN_OWNER",
				scopeFor(ref.location),
				`The media asset at ${describeLocation(ref.location)} belongs to a different user, so this app can't ship with it. Upload your own copy of the media and attach it to the slot, or clear the slot.`,
				validationLocationFor(ref.location),
				{ assetId: ref.assetId },
			),
		);
	}
	return errors;
}
