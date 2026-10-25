/**
 * Rule: every referenced media file plays on every platform the app runs
 * on.
 *
 * A file's variant is stored on its row (`MediaAssetRecord.mediaFormat`, one
 * key of `lib/domain/multimedia.ts::MEDIA_FORMATS`, or `unplayable`), and an
 * app declares Web Apps, Android or both. The commit kernel refuses a
 * reference a declared platform cannot play on every editor
 * (`lockAndValidateMediaReferences`); this rule is defense in depth beside
 * it at the export boundary, for a reference committed before the platforms
 * cutover and for a row changed by hand, and it is what the corpus's publish
 * findings read.
 *
 * Only a reference whose row is ready, of the slot's kind and of a media
 * kind is judged here; a missing, pending or wrong-kind row is its sibling
 * rules'. A ready row with no format reads as `unplayable`, as the kernel
 * reads NULL.
 */

import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";
import {
	isMediaKind,
	mediaFormatLabel,
	UNPLAYABLE_MEDIA_FORMAT,
} from "@/lib/domain/multimedia";
import {
	declaredPlatforms,
	inPlatform,
	PLATFORM_LABELS,
} from "@/lib/domain/platforms";
import { missingFrom, REEXPORT_AS } from "@/lib/media/platformPlayback";
import { type ValidationError, validationError } from "../../errors";
import {
	describeLocation,
	navigabilityDetailsFor,
	scopeFor,
	validationLocationFor,
} from "./shared";

export function mediaFormatPlays(
	doc: BlueprintDoc,
	manifest: ReadonlyMap<string, MediaAssetRecord>,
): ValidationError[] {
	const platforms = declaredPlatforms(doc);
	const errors: ValidationError[] = [];
	for (const ref of walkAssetRefs(doc)) {
		const record = manifest.get(ref.assetId);
		if (
			record?.status !== "ready" ||
			record.kind !== ref.slotKind ||
			!isMediaKind(record.kind)
		) {
			continue;
		}
		const mediaFormat = record.mediaFormat ?? UNPLAYABLE_MEDIA_FORMAT;
		const missing = missingFrom(mediaFormat, platforms);
		if (missing.length === 0) continue;
		const label = mediaFormatLabel(mediaFormat, record.mimeType);
		const where = describeLocation(ref.location);
		const advice = REEXPORT_AS[record.kind];
		const [first] = missing;
		const message =
			mediaFormat === UNPLAYABLE_MEDIA_FORMAT || first === undefined
				? `At ${where}, no CommCare app can play the attached ${ref.slotKind} (${label}). Exporting it again as ${advice}, or clearing the slot, fixes that.`
				: `At ${where}, the attached ${ref.slotKind} is ${label}, which ${PLATFORM_LABELS[first]} can't play, and this app runs ${inPlatform(first)}. Exporting it again as ${advice}, or clearing the slot, fixes that.`;
		errors.push(
			validationError(
				"MEDIA_FORMAT_NOT_PLAYED",
				scopeFor(ref.location),
				message,
				validationLocationFor(ref.location),
				{
					assetId: ref.assetId,
					mediaFormat,
					missingPlatforms: missing.join(","),
					...navigabilityDetailsFor(ref.location),
				},
			),
		);
	}
	return errors;
}
