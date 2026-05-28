/**
 * Rule: every referenced asset is in `status: "ready"` — its bytes
 * have been validated and stored.
 *
 * Fires when a manifest row's `status` isn't `"ready"`. The user
 * sees: "the media isn't fully uploaded yet, the app can't ship."
 * The fix: wait for the upload to finish, or clear the slot if the
 * upload was abandoned.
 *
 * An id missing from the manifest is `mediaAssetExists`'s concern;
 * this rule only judges rows the manifest does carry.
 */

import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";
import { type ValidationError, validationError } from "../../errors";
import {
	describeLocation,
	navigabilityDetailsFor,
	scopeFor,
	validationLocationFor,
} from "./shared";

/**
 * Walk every media reference; for any whose resolved row's `status`
 * isn't `"ready"`, emit MEDIA_ASSET_NOT_READY. References whose ids
 * don't resolve at all are silently skipped (left to
 * `mediaAssetExists`).
 */
export function mediaAssetReady(
	doc: BlueprintDoc,
	manifest: ReadonlyMap<string, MediaAssetRecord>,
	// Carried for the uniform `MediaAssetRule` shape; not consulted —
	// readiness is owner-agnostic.
	_expectedOwner: string,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const ref of walkAssetRefs(doc)) {
		const record = manifest.get(ref.assetId);
		if (!record) continue;
		if (record.status === "ready") continue;
		errors.push(
			validationError(
				"MEDIA_ASSET_NOT_READY",
				scopeFor(ref.location),
				`The media asset at ${describeLocation(ref.location)} hasn't finished uploading yet. Wait for the upload to complete (the asset chip shows a spinner during upload), or remove the reference if the upload was abandoned.`,
				validationLocationFor(ref.location),
				{
					assetId: ref.assetId,
					status: record.status,
					...navigabilityDetailsFor(ref.location),
				},
			),
		);
	}
	return errors;
}
