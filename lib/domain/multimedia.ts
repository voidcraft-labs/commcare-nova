// lib/domain/multimedia.ts
//
// Domain primitives for native multimedia, in the authoring layer's
// own vocabulary. The export-boundary translation to CommCare's wire
// shapes lives exclusively in `lib/commcare/`; nothing here forecasts
// that mapping.
//
// What this module owns:
//
//  - `AssetId` — a branded reference to one stored asset.
//  - `Media` — the slot bundle a carrier (a field message, a select
//    option) attaches. Image/audio/video are independent slots; a
//    carrier can populate any combination. Menu carriers (module /
//    form / case-list link) reference `AssetId` directly and carry
//    only image + audio (no video), so they use a narrower shape that
//    rejects a video at compile time rather than at validate.
//  - MIME-type partitions, per-kind size caps, the kind/extension
//    lookups, and the GCS object-key derivations — the cross-cutting
//    constants both the storage layer and the upload routes consume.
//
// The stored-record shapes live with their boundaries: the
// Firestore-shaped doc schema in `lib/db/types.ts`, the client-facing
// wire shape in `lib/db/mediaAssets.ts`.

import { z } from "zod";
import type { Uuid } from "./uuid";

/**
 * Branded identifier for a stored media asset. Distinct from any
 * other UUID brand in the codebase (field uuids, app ids, etc.) so
 * the compiler catches accidental cross-domain reference.
 *
 * The brand is compile-time only — `assetIdSchema.parse(s)` returns
 * `string`, and call sites that need the brand apply `asAssetId`
 * explicitly. We avoided a Zod `.transform()` here because the
 * SA's tool-schema generator serializes per-field schemas (which
 * carry media slots via the field bases + select options) into
 * JSON Schema for the Anthropic structured-output API, and Zod
 * v4 cannot represent transforms in JSON Schema. The brand is
 * still load-bearing at compile time even without the runtime
 * transform.
 */
export type AssetId = string & { readonly __brand: "AssetId" };

/** Narrowing cast from string → AssetId. Prefer over `as AssetId`. */
export function asAssetId(s: string): AssetId {
	return s as AssetId;
}

/**
 * Zod schema for `AssetId`. Plain non-empty string at runtime; the
 * brand is applied at the type system only. Pairs with `asAssetId`
 * for the explicit cast where the brand matters.
 */
export const assetIdSchema = z.string().min(1);

/**
 * MIME types accepted at the upload validation gate, partitioned by
 * kind. The sniffed `mimeType` on a `MediaAsset` MUST be one of
 * these — any other value is a validation-pipeline failure (the
 * upload is rejected, the GCS object is deleted, the Firestore row
 * is removed).
 *
 * SVG is deliberately absent — it's a script container with active
 * content surface (XSS via embedded `<script>` / event handlers),
 * and the wire-side carriers don't render it usefully either way.
 */
export const IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

/**
 * Audio is restricted to the two formats CommCare HQ can actually ingest.
 * HQ's media-upload endpoint validates the file extension against Python's
 * `mimetypes` table (`hqmedia/views.py::BaseProcessFileUploadView.validate_file`),
 * and HQ's deployed image (python3.13-bookworm-slim) ships no `/etc/mime.types`
 * and registers no extra types — so its table is CPython's hardcoded map, which
 * has `.mp3` (audio/mpeg) and `.wav` (audio/wav) but NOT `.m4a` (audio/mp4) or
 * `.ogg` (audio/ogg). Accepting m4a/ogg would let a user attach audio that
 * 400s on every HQ upload — a dead affordance Nova rejects at the source.
 */
export const AUDIO_MIME_TYPES = ["audio/mpeg", "audio/wav"] as const;
export type AudioMimeType = (typeof AUDIO_MIME_TYPES)[number];

export const VIDEO_MIME_TYPES = ["video/mp4"] as const;
export type VideoMimeType = (typeof VIDEO_MIME_TYPES)[number];

export const ALL_MIME_TYPES = [
	...IMAGE_MIME_TYPES,
	...AUDIO_MIME_TYPES,
	...VIDEO_MIME_TYPES,
] as const;
export type AssetMimeType = (typeof ALL_MIME_TYPES)[number];

/**
 * The slot kind paired with a MIME type at the validation boundary.
 * Used by the upload route to pick the right size cap and by the
 * library list endpoint to filter by kind.
 */
export const MEDIA_KINDS = ["image", "audio", "video"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * Per-kind upload size caps. Tight by design: forces sane originals.
 * Cellular-deployment-friendly. Server-enforced; client-side `accept`
 * is just for UX feedback.
 */
export const MEDIA_SIZE_CAPS_BYTES: Record<MediaKind, number> = {
	image: 5 * 1024 * 1024,
	audio: 10 * 1024 * 1024,
	video: 50 * 1024 * 1024,
};

/**
 * Resolve a canonical MIME type to its kind. Returns `undefined` for
 * any MIME outside the accepted set — the caller treats that as a
 * validation rejection. Expects an already-canonical MIME; run
 * `normalizeMimeType` first if the input is a raw browser claim or a
 * `file-type` sniff result.
 */
export function mediaKindForMimeType(mimeType: string): MediaKind | undefined {
	if ((IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
		return "image";
	}
	if ((AUDIO_MIME_TYPES as readonly string[]).includes(mimeType)) {
		return "audio";
	}
	if ((VIDEO_MIME_TYPES as readonly string[]).includes(mimeType)) {
		return "video";
	}
	return undefined;
}

/**
 * Aliases a raw MIME string can take for an accepted format, when a
 * `file-type` sniff or a browser `Content-Type` uses a non-canonical
 * spelling. Only genuinely different spellings need an entry — codec
 * parameters (`; codecs=...`) are stripped to the base type by
 * `normalizeMimeType` before lookup.
 */
const MIME_ALIASES: Record<string, AssetMimeType> = {
	// Animated PNG is a backward-compatible PNG extension; `file-type`
	// sniffs it as `image/apng`. Treat it as `image/png` so a normal-
	// looking `.png` that happens to be animated isn't rejected with a
	// baffling "your PNG isn't a PNG" — it stores + serves as PNG, and
	// renderers without APNG support fall back to the first frame.
	"image/apng": "image/png",
};

/**
 * Normalize a raw MIME string — a browser `Content-Type` claim or a
 * `file-type` sniff result — to its canonical accepted form, or
 * `undefined` if it isn't an accepted media type.
 *
 *  - strips codec parameters (`video/mp4; codecs=avc1` → `video/mp4`)
 *  - maps known aliases (`image/apng` → `image/png`)
 *  - returns canonical entries unchanged
 *
 * Both the claimed and the sniffed MIME flow through this before the
 * validator compares them, so a file whose browser claim and `file-type`
 * sniff spell the same format differently reconciles to one canonical
 * value on both sides.
 */
export function normalizeMimeType(raw: string): AssetMimeType | undefined {
	const lower = raw.trim().toLowerCase();
	const base = lower.split(";")[0]?.trim() ?? lower;
	if ((ALL_MIME_TYPES as readonly string[]).includes(base)) {
		return base as AssetMimeType;
	}
	return MIME_ALIASES[base];
}

/**
 * Canonical file extension for each accepted MIME type. The
 * validator picks an extension from this map after the magic-bytes
 * sniff confirms the real type, regardless of what the client's
 * original filename claimed. Used to construct the GCS object key.
 *
 * One slightly-tricky case: `audio/mpeg` → `.mp3` (the MIME's "mpeg"
 * is historical; the MPEG-1 Audio Layer 3 container is universally
 * `.mp3` on disk and by every player's extension match).
 */
export const EXTENSION_FOR_MIME_TYPE: Record<AssetMimeType, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"audio/mpeg": ".mp3",
	"audio/wav": ".wav",
	"video/mp4": ".mp4",
};

/**
 * Carrier-side slot bundle. Each slot is independent: a question
 * can have image+audio+video simultaneously, or any subset, or
 * none. Slot key encodes the kind; the value is the asset id, full
 * stop.
 *
 * Menu-style carriers (module/form/case-list link, app logo) use
 * `AssetId` slots directly on the parent (`module.icon`,
 * `module.audioLabel`, `blueprintDoc.logo`) rather than this
 * bundle, because their slot count is small + asymmetric (image +
 * audio, no video — or just image for the logo). Forcing those
 * onto `Media` would either add a wire-rejected `video` slot or
 * require a separate sibling type for "image + audio without
 * video"; the direct `AssetId` slots are clearer at the carrier.
 */
export const mediaSchema = z
	.object({
		image: assetIdSchema.optional(),
		audio: assetIdSchema.optional(),
		video: assetIdSchema.optional(),
	})
	.strict();
export type Media = z.infer<typeof mediaSchema>;

/**
 * Lifecycle status of a stored media asset. Two states only:
 *
 *  - `pending` — the Firestore row exists; the GCS object may or
 *    may not be in flight; bytes have NOT been validated. The
 *    upload-confirm step flips this to `ready` once the validator
 *    runs against the stored bytes. Pending assets must never
 *    appear in a shipped (CCHQ-uploaded) app — the validator gate
 *    rejects them.
 *  - `ready` — the GCS object exists, bytes have been validated,
 *    sniffed `mimeType` / `extension` / `dimensions` / `durationMs`
 *    are written.
 *
 * `failed` is not a state — the confirm step deletes the Firestore
 * row and, when unshared, the pending GCS object on validation failure.
 * A `pending` row left dangling by a client that never confirms is
 * filtered out of the library list and rejected by the validator gate;
 * it is harmless until cleanup removes it.
 *
 * The stored-record shapes live with their respective boundaries:
 * `mediaAssetDocSchema` (Firestore-shaped, `Timestamp`-typed) in
 * `lib/db/types.ts`, and `WireMediaAsset` (client-facing, ISO
 * strings, internals stripped) in `lib/db/mediaAssets.ts`. This
 * domain module owns only the cross-cutting primitives both
 * consume.
 */
export const MEDIA_ASSET_STATUSES = ["pending", "ready"] as const;
export type MediaAssetStatus = (typeof MEDIA_ASSET_STATUSES)[number];

/**
 * Final GCS object key derivation. Per-owner namespace gives us
 * (owner, hash) dedup at the storage layer once bytes have been
 * validated — same blob uploaded by two apps of the same user shares
 * one object, while two users keep separate copies (closing the
 * cross-tenant probe vector). The trailing extension is the canonical
 * extension for the sniffed MIME (not the client's original filename
 * extension).
 */
export function gcsObjectKeyFor(
	owner: string,
	contentHash: string,
	extension: string,
): string {
	return `users/${owner}/${contentHash}${extension}`;
}

/**
 * Pending GCS object key derivation for browser signed-PUT uploads.
 *
 * The browser's signed URL is minted BEFORE the server has validated the
 * bytes. It must therefore land at a per-attempt key, not the final
 * content-hash key: a stale leaked URL can only overwrite its own pending
 * object, never a ready asset another row already serves. Confirm-time
 * validation promotes clean bytes to `gcsObjectKeyFor(...)`; rejection
 * deletes this pending object and row.
 */
export function pendingGcsObjectKeyFor(
	owner: string,
	assetId: AssetId,
	extension: string,
): string {
	return `users/${owner}/pending/${assetId}${extension}`;
}

/**
 * Re-export of the `Uuid` brand for callers that need to type a
 * field uuid alongside an `AssetId`. The domain field schemas use
 * `uuidSchema` directly for field identity; media uses the distinct
 * `AssetId` brand.
 */
export type { Uuid };
