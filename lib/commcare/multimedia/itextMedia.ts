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
import type { Media, MediaKind } from "@/lib/domain/multimedia";
import { type AssetManifest, requireAssetRef } from "./assetWirePath";

/**
 * The `Media` slot kinds in the order their `<value form="...">`
 * elements emit. CommCare keys each media value by its `form`
 * attribute, so order is not semantically load-bearing — but a fixed
 * order keeps emitted bytes deterministic (and matches the
 * image-before-audio order the CCHQ fixtures show).
 */
const MEDIA_VALUE_ORDER: readonly MediaKind[] = ["image", "audio", "video"];

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
	media: Media | undefined,
	manifest: AssetManifest | undefined,
	where: string,
): Element[] {
	if (!media || !manifest) return [];
	const values: Element[] = [];
	for (const kind of MEDIA_VALUE_ORDER) {
		const assetId = media[kind];
		if (!assetId) continue;
		const ref = requireAssetRef(assetId, manifest, where);
		// `form="image" | "audio" | "video"` — the same tokens CommCare's
		// `VALID_VALUE_FORMS` accepts; the `MediaKind` literal IS the wire
		// `form` value, so no translation table is needed.
		values.push(el("value", { form: kind }, [text(ref)]));
	}
	return values;
}
