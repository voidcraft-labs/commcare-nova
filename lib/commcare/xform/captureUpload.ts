// lib/commcare/xform/captureUpload.ts
//
// The `<upload mediatype>` vocabulary — a CLOSED four-literal enum with
// no fallback, and the total map from Nova's capture kinds onto it.
//
// ## Why this is a table and not a conditional
//
// `commcare-core`'s `XFormParser::parseUpload` matches `mediatype` with
// literal `String.equals` against exactly four strings — no trimming, no
// case folding, no normalization — remapping the control from
// `CONTROL_UPLOAD` to `CONTROL_IMAGE_CHOOSE` / `CONTROL_AUDIO_CAPTURE` /
// `CONTROL_VIDEO_CAPTURE` / `CONTROL_DOCUMENT_UPLOAD`. Any other value
// leaves the control at `CONTROL_UPLOAD`, `entries.js::getEntry` falls
// through to `UnsupportedEntry`, and `UnsupportedEntry`'s constructor
// SETS THE ANSWER to the literal string `Not Supported by Web Entry`.
// That string then submits, and through the case-attachment seam it
// would be copied into an attachment `@src`.
//
// So an unmatched mediatype is not a visible error — it is silent bad
// data. The emitter therefore makes the state unrepresentable rather
// than checking for it: `UploadMediatype` admits only the four literals,
// and `UPLOAD_MEDIATYPE_BY_CAPTURE_KIND` is a total `Record` over
// `CaptureFieldKind`, so a new capture kind fails `tsc` until it names
// one of them.
//
// Note the fourth literal's exact bytes: `application/*,text/*` — a
// comma with NO space. `String.equals` gives no tolerance for either.

import type { CaptureFieldKind } from "@/lib/domain";

/**
 * Every `mediatype` value CommCare's parser recognizes. Exhaustive: the
 * four arms of `XFormParser::parseUpload`, in its own order.
 */
export const UPLOAD_MEDIATYPES = [
	"image/*",
	"audio/*",
	"video/*",
	"application/*,text/*",
] as const;

export type UploadMediatype = (typeof UPLOAD_MEDIATYPES)[number];

/**
 * Nova capture kind → the wire mediatype it emits.
 *
 * `signature` shares `image/*` with `image`; the two are told apart on
 * the wire by `appearance="signature"`, which
 * `entries.js::getEntry` checks inside its `CONTROL_IMAGE_CHOOSE` case
 * (and `WidgetFactory::createWidgetFromPrompt` checks the same way on
 * Android). There is no distinct signature mediatype to emit.
 */
export const UPLOAD_MEDIATYPE_BY_CAPTURE_KIND: Record<
	CaptureFieldKind,
	UploadMediatype
> = {
	image: "image/*",
	signature: "image/*",
	audio: "audio/*",
	video: "video/*",
	file: "application/*,text/*",
};

/**
 * The `appearance` a capture kind carries, or `undefined` for the kinds
 * that carry none.
 *
 * `signature` is the only one. `face` is deliberately absent: Vellum
 * authors it (`mugs/types/media.js::FaceCapture`) but it is inert on
 * both runtimes Nova targets — Android's `WidgetFactory` has no `face`
 * branch and falls to `ImageWidget`, and the string appears nowhere in
 * cloudcare's entry code — so emitting it would decorate the wire with a
 * value nothing reads.
 */
export const UPLOAD_APPEARANCE_BY_CAPTURE_KIND: Record<
	CaptureFieldKind,
	string | undefined
> = {
	image: undefined,
	signature: "signature",
	audio: undefined,
	video: undefined,
	file: undefined,
};
