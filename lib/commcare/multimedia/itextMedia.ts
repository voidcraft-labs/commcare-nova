// lib/commcare/multimedia/itextMedia.ts
//
// The media `<value form="...">` siblings inside an itext `<text>`
// entry. CommCare renders a question's label/hint/help/constraint
// media from extra `<value>` children of the same `<text id>` entry
// that carries the displayed text:
//
//   <text id="q1-label">
//     <value>Patient name</value>
//     <value form="markdown">Patient name</value>
//     <value form="image">jr://file/commcare/<hash>.png</value>
//     <value form="audio">jr://file/commcare/<hash>.mp3</value>
//   </text>
//
// The plain `<value>` (and Nova's markdown duplicate) come first; the
// media values follow, one per present `Media` slot. Verified against
// `commcare-hq/.../app_manager/xform.py::VALID_VALUE_FORMS`
// (`'image','audio','video','video-inline','markdown'`) and the fixture
// `tests/data/suite/form_with_media_refs.xml`. A media-only entry (media
// with no text) still emits an empty `<value></value>` for the text slot
// — the fixture `tests/data/duplicate_text_questions.xml` shows exactly
// this shape for an audio-only help entry — so the caller always emits
// the text values and appends these media values after them.

import type { Element } from "domhandler";
import { el, text } from "@/lib/commcare/elementBuilders";
import type { MediaRole, MediaValues } from "@/lib/domain/multimedia";
import { type AssetManifest, requireAssetRef } from "./assetWirePath";

/**
 * The `form` each `Media` role writes, in the order the values emit.
 * CommCare keys each media value by its `form` attribute, so order is not
 * semantically load-bearing — but a fixed order keeps emitted bytes
 * deterministic (and matches the image-before-audio order the CCHQ
 * fixtures show). An inline video is HQ's `video-inline` form, which
 * `xform.py::video_references` collects beside `video`, so its file ships
 * with the app; commcare-android plays it inside a question's label
 * (`QuestionWidget.java`, `MediaLayout.setupInlineVideoView`).
 */
const MEDIA_VALUE_FORMS: readonly (readonly [MediaRole, string])[] = [
	["image", "image"],
	["audio", "audio"],
	["video", "video"],
	["videoInline", "video-inline"],
];

/**
 * Build the media `<value form="...">` elements for one `Media` bundle,
 * to append after the text `<value>` children of an itext `<text>`
 * entry. Returns `[]` when media emission is off (`manifest`
 * undefined) or the bundle has no slots set, so the caller can
 * unconditionally spread the result.
 *
 * `where` names the calling emit site for the compiler-bug message if a
 * referenced asset is missing from the manifest.
 */
export function itextMediaValues(
	media: MediaValues | undefined,
	manifest: AssetManifest | undefined,
	where: string,
): Element[] {
	if (!media || !manifest) return [];
	const values: Element[] = [];
	for (const [role, form] of MEDIA_VALUE_FORMS) {
		const assetId = media[role];
		if (!assetId) continue;
		const ref = requireAssetRef(assetId, manifest, where);
		values.push(el("value", { form }, [text(ref)]));
	}
	return values;
}
