// lib/domain/mediaRefs.ts
//
// The single walk that enumerates every media `AssetId` a blueprint
// references. One source of truth for "which assets does this app use",
// consumed by:
//   - the compile / upload routes, to load exactly those assets (rows +
//     bytes) into the emission manifest;
//   - the `remove_media_asset` tool, to refuse deleting an asset still
//     referenced (and name the referrers);
//   - the readiness scan script.
//
// Walks the doc by entity maps (order-independent — references don't
// care about position). Every carrier that can hold media is visited
// here; adding a new media carrier means adding it to this walk so the
// loader, the delete guard, and the scan all see it at once.

import type { BlueprintDoc } from "./blueprint";
import type { Media } from "./multimedia";

/** Field-level `Media` bundle slots (each is image/audio/video). The
 *  per-message media keys an input field can carry. */
const FIELD_MEDIA_KEYS = [
	"label_media",
	"hint_media",
	"help_media",
	"validate_msg_media",
] as const;

/** Add every set slot of a `Media` bundle to the sink. */
function addMedia(media: Media | undefined, sink: Set<string>): void {
	if (!media) return;
	if (media.image) sink.add(media.image);
	if (media.audio) sink.add(media.audio);
	if (media.video) sink.add(media.video);
}

/**
 * Collect the de-duplicated set of every media `AssetId` referenced
 * anywhere in the blueprint: the app logo; module / case-list-link /
 * form icons + audio labels; per-question label/hint/help/validation
 * media; and per-select-option media. (Image-map column mappings join
 * this walk when that column kind lands.)
 *
 * Returns plain asset-id strings (the doc carries `AssetId` as a plain
 * string — the brand is compile-time only). The caller re-brands when
 * keying the resolved manifest.
 */
export function collectAssetRefs(doc: BlueprintDoc): Set<string> {
	const ids = new Set<string>();

	if (doc.logo) ids.add(doc.logo);

	for (const mod of Object.values(doc.modules)) {
		if (mod.icon) ids.add(mod.icon);
		if (mod.audioLabel) ids.add(mod.audioLabel);
		const caseList = mod.caseListConfig;
		if (caseList?.icon) ids.add(caseList.icon);
		if (caseList?.audioLabel) ids.add(caseList.audioLabel);
	}

	for (const form of Object.values(doc.forms)) {
		if (form.icon) ids.add(form.icon);
		if (form.audioLabel) ids.add(form.audioLabel);
	}

	for (const field of Object.values(doc.fields)) {
		// Media slots sit on the input/field bases; read generically since
		// not every kind in the union declares every slot.
		const mediaSlots = field as Partial<
			Record<(typeof FIELD_MEDIA_KEYS)[number], Media>
		>;
		for (const key of FIELD_MEDIA_KEYS) addMedia(mediaSlots[key], ids);
		const options = (field as { options?: ReadonlyArray<{ media?: Media }> })
			.options;
		if (options) for (const opt of options) addMedia(opt.media, ids);
	}

	return ids;
}
