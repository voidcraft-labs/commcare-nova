/**
 * Rule: every referenced asset's MIME kind matches the carrier slot's
 * expected kind.
 *
 * Each carrier slot has a fixed kind: a module icon is image, a form
 * audio label is audio, a question's `label_media.audio` is audio, an
 * image-map row's image is image. Attaching an asset of the wrong
 * kind (e.g. an MP3 to a module's icon slot) produces wire garbage at
 * compile — the icon location locale would carry a `jr://` reference
 * to an audio file CommCare can't render as an icon; the user sees a
 * broken-image placeholder on the device.
 *
 * The schema doesn't constrain kind on the slot side (every
 * `Media.image` is typed `AssetId | undefined`; `AssetId` is opaque),
 * so this is the authoring-time gate that closes the mismatch. Wire
 * emitters don't re-check; they trust the validator.
 */

import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { type MediaSlotKind, walkAssetRefs } from "@/lib/domain/mediaRefs";
import type { AssetMimeType } from "@/lib/domain/multimedia";
import { type ValidationError, validationError } from "../../errors";
import { describeLocation, scopeFor, validationLocationFor } from "./shared";

/**
 * Walk every media reference; for any whose resolved row's kind
 * doesn't match the carrier slot's expected kind, emit
 * MEDIA_KIND_MISMATCH. The record carries `kind` directly (set at
 * upload-confirm from the sniffed MIME, frozen on disk), so the
 * comparison reads two `MediaKind` values without re-deriving from
 * MIME.
 *
 * References whose ids don't resolve at all are silently skipped
 * (left to `mediaAssetExists`).
 */
export function mediaKindMatches(
	doc: BlueprintDoc,
	manifest: ReadonlyMap<string, MediaAssetRecord>,
	// Carried for the uniform `MediaAssetRule` shape; not consulted —
	// kind-match is owner-agnostic.
	_expectedOwner: string,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const ref of walkAssetRefs(doc)) {
		const record = manifest.get(ref.assetId);
		if (!record) continue;
		if (record.kind === ref.slotKind) continue;
		errors.push(
			validationError(
				"MEDIA_KIND_MISMATCH",
				scopeFor(ref.location),
				kindMismatchMessage(ref.slotKind, record.mimeType, ref.location),
				validationLocationFor(ref.location),
				{
					assetId: ref.assetId,
					expectedKind: ref.slotKind,
					actualMimeType: record.mimeType,
					actualKind: record.kind,
				},
			),
		);
	}
	return errors;
}

/**
 * Compose the mismatch error message. Names the slot kind first
 * (what the slot expects), the asset's actual MIME, the location it's
 * attached to, and the fix. The slot kind comes first because that's
 * the load-bearing fact — the slot's contract is fixed; the asset is
 * the thing the user can change.
 */
function kindMismatchMessage(
	expectedKind: MediaSlotKind,
	actualMimeType: AssetMimeType,
	location: Parameters<typeof describeLocation>[0],
): string {
	const article = `a${vowelArticleSuffix(expectedKind)}`;
	return (
		`The ${expectedKind} slot at ${describeLocation(location)} is filled with an asset whose type is ${actualMimeType}, ` +
		`but only ${expectedKind} files belong in ${article} ${expectedKind} slot. ` +
		`Replace the asset with ${article} ${expectedKind} file, or clear the slot.`
	);
}

/** Tiny "a"/"an" picker for the slot-kind noun in the error sentence. */
function vowelArticleSuffix(noun: string): string {
	return /^[aeiou]/i.test(noun) ? "n" : "";
}
