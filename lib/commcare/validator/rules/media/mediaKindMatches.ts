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
import {
	type MediaRefLocation,
	type MediaSlotKind,
	walkAssetRefs,
} from "@/lib/domain/mediaRefs";
import type { AssetMimeType } from "@/lib/domain/multimedia";
import { type ValidationError, validationError } from "../../errors";
import {
	describeLocation,
	navigabilityDetailsFor,
	scopeFor,
	validationLocationFor,
} from "./shared";

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
					...navigabilityDetailsFor(ref.location),
				},
			),
		);
	}
	return errors;
}

/**
 * Compose the mismatch sentence. Leads with the location (what the
 * user clicks to fix) and names the kind contract + the asset's
 * actual MIME inside one clause; the fix sentence follows. The
 * "a/an" picker handles the audio-kind vowel.
 */
function kindMismatchMessage(
	expectedKind: MediaSlotKind,
	actualMimeType: AssetMimeType,
	location: MediaRefLocation,
): string {
	const article = `a${vowelArticleSuffix(expectedKind)}`;
	return (
		`At ${describeLocation(location)}, the slot expects ${article} ${expectedKind} but the attached asset is ${actualMimeType}. ` +
		`Replace it with ${article} ${expectedKind} file, or clear the slot.`
	);
}

/** Tiny "a"/"an" picker for the slot-kind noun in the error sentence. */
function vowelArticleSuffix(noun: string): string {
	return /^[aeiou]/i.test(noun) ? "n" : "";
}
