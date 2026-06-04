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

/**
 * Document MIME types — the library-only asset formats (see
 * `DOCUMENT_KINDS` below). Unlike image/audio/video, documents are NEVER
 * attachable to a CommCare carrier and never reach the wire emitter; they
 * live in the user's file library as inputs to attach to the SA chat.
 *
 * `text/plain` (and `text/markdown`) carry NO magic-bytes signature, so
 * `file-type` can't sniff them — the validator gives the `text` kind a
 * dedicated arm (extension + UTF-8 validity) instead of the magic-bytes
 * gate the other formats pass.
 */
export const PDF_MIME_TYPES = ["application/pdf"] as const;
export const TEXT_MIME_TYPES = ["text/plain", "text/markdown"] as const;
export const DOCX_MIME_TYPES = [
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;
export const XLSX_MIME_TYPES = [
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;
export const DOCUMENT_MIME_TYPES = [
	...PDF_MIME_TYPES,
	...TEXT_MIME_TYPES,
	...DOCX_MIME_TYPES,
	...XLSX_MIME_TYPES,
] as const;

export const ALL_MIME_TYPES = [
	...IMAGE_MIME_TYPES,
	...AUDIO_MIME_TYPES,
	...VIDEO_MIME_TYPES,
	...DOCUMENT_MIME_TYPES,
] as const;
export type AssetMimeType = (typeof ALL_MIME_TYPES)[number];

/**
 * Kinds that attach to a CommCare carrier (a field message, a select
 * option, a menu tile, the app logo) and emit to the wire. The `Media`
 * bundle below is keyed by exactly these.
 *
 * NOTE the boundary is NOT compile-time: a slot's VALUE is an opaque
 * `AssetId` (the brand doesn't encode the asset's kind), so a document's
 * id is type-indistinguishable from a media id in a slot. The wire/library
 * split — a document never reaching a carrier or the emitter — is enforced
 * at RUNTIME, fail-closed, in three places: the SA media tools gate kind
 * at attach time; the validator's `mediaKindMatches` rule rejects a
 * document id sitting in a media slot before compile; and
 * `resolveMediaManifest` filters on `isMediaKind` before emission. Each is
 * load-bearing — none is redundant.
 */
export const MEDIA_KINDS = ["image", "audio", "video"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * Kinds that live ONLY in the user's file library — never attachable to
 * a CommCare carrier, never wire-emitted. Per-format (not a single coarse
 * "document") so preview, validation, and the library type-filter each
 * dispatch cleanly on the kind.
 */
export const DOCUMENT_KINDS = ["pdf", "text", "docx", "xlsx"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * Every stored-asset kind. The asset row's `kind` is one of these; the
 * library lists them all. The wire/library split is enforced at the
 * carrier boundary (carriers accept only `MediaKind`), not here.
 */
export const ASSET_KINDS = [...MEDIA_KINDS, ...DOCUMENT_KINDS] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** Narrow an `AssetKind` to the library-only document set. */
export function isDocumentKind(kind: AssetKind): kind is DocumentKind {
	return (DOCUMENT_KINDS as readonly string[]).includes(kind);
}

/** Narrow an `AssetKind` to the wire-attachable media set. */
export function isMediaKind(kind: AssetKind): kind is MediaKind {
	return (MEDIA_KINDS as readonly string[]).includes(kind);
}

/**
 * Per-kind upload size caps. Tight by design: forces sane originals.
 * Cellular-deployment-friendly. Server-enforced; client-side `accept`
 * is just for UX feedback. Documents skew larger than the media caps
 * (a PDF report dwarfs a menu icon) but text stays small — it's plain
 * UTF-8, and a multi-MB "text" file is almost always a mislabeled binary.
 */
export const ASSET_SIZE_CAPS_BYTES: Record<AssetKind, number> = {
	image: 5 * 1024 * 1024,
	audio: 10 * 1024 * 1024,
	video: 50 * 1024 * 1024,
	pdf: 20 * 1024 * 1024,
	text: 1 * 1024 * 1024,
	docx: 10 * 1024 * 1024,
	xlsx: 10 * 1024 * 1024,
};

/**
 * Aggregate export budget for a single compile / HQ upload. The media-ON
 * paths load EVERY referenced ready asset's bytes into memory at once —
 * the `.ccz` bundles them in one ZIP buffer, the HQ path POSTs them
 * per-file from the same manifest — so the cost scales with the SUM of
 * referenced media, which the per-asset caps above don't bound. Without
 * an aggregate ceiling an app that references hundreds of distinct owned
 * assets could balloon a shared worker's heap (CWE-770). These bound the
 * whole export: the media validator sums the referenced ready assets and
 * rejects an over-budget app before `resolveMediaManifest` downloads a
 * single object.
 *
 * Set generously — a real media-rich app never approaches them (200 MB /
 * 500 attachments is already far past any sane CommCare deployment) — so
 * the only thing they catch is the pathological case.
 */
export const MAX_MEDIA_EXPORT_ASSETS = 500;
export const MAX_MEDIA_EXPORT_BYTES = 200 * 1024 * 1024;

/**
 * Resolve a canonical MIME type to its asset kind. Returns `undefined`
 * for any MIME outside the accepted set — the caller treats that as a
 * validation rejection. Expects an already-canonical MIME; run
 * `normalizeMimeType` first if the input is a raw browser claim or a
 * `file-type` sniff result.
 *
 * Returns document kinds too, but a carrier-scoped caller (a field/menu
 * picker) passes only `MediaKind`s in its allowed set and rejects any
 * kind outside it — so a document resolved here still can't attach to a
 * carrier.
 */
export function assetKindForMimeType(mimeType: string): AssetKind | undefined {
	if ((IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
		return "image";
	}
	if ((AUDIO_MIME_TYPES as readonly string[]).includes(mimeType)) {
		return "audio";
	}
	if ((VIDEO_MIME_TYPES as readonly string[]).includes(mimeType)) {
		return "video";
	}
	if ((PDF_MIME_TYPES as readonly string[]).includes(mimeType)) {
		return "pdf";
	}
	if ((TEXT_MIME_TYPES as readonly string[]).includes(mimeType)) {
		return "text";
	}
	if ((DOCX_MIME_TYPES as readonly string[]).includes(mimeType)) {
		return "docx";
	}
	if ((XLSX_MIME_TYPES as readonly string[]).includes(mimeType)) {
		return "xlsx";
	}
	return undefined;
}

/**
 * Asset kind for a (lowercased) file extension. The fallback the
 * validator uses when the browser sends no usable `Content-Type` — empty
 * or `application/octet-stream`, common for `.md` and sometimes office
 * files — to pick the size cap + the per-kind validation arm. The
 * extension is only a HINT for routing; the magic-bytes sniff (or the
 * UTF-8 check for text) is still the authoritative format gate.
 */
const KIND_FOR_EXTENSION: Record<string, AssetKind> = {
	".png": "image",
	".jpg": "image",
	".jpeg": "image",
	".gif": "image",
	".webp": "image",
	".mp3": "audio",
	".wav": "audio",
	".mp4": "video",
	".pdf": "pdf",
	".txt": "text",
	".md": "text",
	".docx": "docx",
	".xlsx": "xlsx",
};
export function assetKindForExtension(ext: string): AssetKind | undefined {
	return KIND_FOR_EXTENSION[ext.toLowerCase()];
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
	"application/pdf": ".pdf",
	"text/plain": ".txt",
	"text/markdown": ".md",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		".docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
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
 * its abandoned GCS object is reaped by the bucket's `pending/` lifecycle
 * rule (1-day TTL), and the dangling Firestore row stays harmless (it
 * never surfaces in the library or a shipped app — there is no row reaper
 * today, only the object-side lifecycle rule).
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
 * Lifecycle of a DOCUMENT's requirements extract — the condensed text the
 * Solutions Architect actually reads in place of the raw file (images carry
 * no extract; they reach the model as pixels). Independent of the asset's own
 * `status`: an asset can be `ready` (bytes validated, in the library) while
 * its extract is still `extracting`. The chat resolve step waits on a
 * referenced document's extract, and the file manager surfaces this state so
 * the user can see that feature extraction is happening.
 *
 *  - `extracting` — the extract job is in flight (set before the model call,
 *    so a concurrent library read reflects it).
 *  - `ready`      — the extract text lives at `extractGcsObjectKeyFor(...)`
 *    and `charCount` / `truncated` are recorded.
 *  - `failed`     — extraction threw; `failureReason` records why. Unlike the
 *    asset's own pipeline (which deletes the row on failure), a failed extract
 *    keeps the asset — the bytes are valid, only the condense failed, and the
 *    chat resolve step has a raw-inline fallback.
 */
export const MEDIA_EXTRACT_STATUSES = [
	"extracting",
	"ready",
	"failed",
] as const;
export type MediaExtractStatus = (typeof MEDIA_EXTRACT_STATUSES)[number];

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
 * GCS object key for a document's requirements extract — a sibling of the
 * bytes object under the same per-owner namespace. Keyed by the content hash
 * AND the extractor `version`, so:
 *
 *  - the extract dedups exactly like the bytes (same document re-uploaded by
 *    the same owner resolves to one extract), and
 *  - bumping `EXTRACTOR_VERSION` (a prompt/model change) lands a NEW key, so
 *    every stale extract is invalidated without a migration — the old object
 *    simply stops being read and ages out, and the next reference re-extracts
 *    at the current version.
 *
 * `.md` because the extractor emits GitHub-flavored markdown (tables for
 * spreadsheets, bullet structure for prose).
 */
export function extractGcsObjectKeyFor(
	owner: string,
	contentHash: string,
	version: number,
): string {
	return `users/${owner}/${contentHash}.extract.v${version}.md`;
}

/**
 * Current extractor version. Bump on ANY change that alters the extract a given
 * document produces — the extraction prompt, the summarizer model, or the
 * office→markdown conversion (all in `lib/agent/documentExtraction`). The GCS
 * extract key embeds this (`extractGcsObjectKeyFor`) and the asset doc records
 * the version it was produced at, so a bump invalidates every stored extract
 * with no migration: the old key stops being read and the next reference
 * re-extracts at the new version.
 *
 * It lives here — beside the key + status it versions — rather than in the
 * extraction module, so that computing an extract's storage key
 * (`extractObjectKeyForAsset`) stays a pure domain operation. Importing that key
 * helper must never drag the office-parsing libraries (mammoth/xlsx) into a
 * caller's import graph; keeping the constant here is what makes that possible.
 */
export const EXTRACTOR_VERSION = 1;

/**
 * The GCS object key of a document's stored extract at the current version, or
 * `null` for a media kind (image/audio/video), which has no extract. Asset
 * deletion uses this to purge the extract sibling alongside the bytes. Pure — no
 * I/O, no heavy imports — so any layer (the delete route, the SA tool) can call
 * it without pulling in the extraction machinery.
 */
export function extractObjectKeyForAsset(asset: {
	kind: AssetKind;
	owner: string;
	contentHash: string;
}): string | null {
	return isDocumentKind(asset.kind)
		? extractGcsObjectKeyFor(asset.owner, asset.contentHash, EXTRACTOR_VERSION)
		: null;
}

/**
 * Top-level prefix every signed-PUT pending object lives under. Shared so
 * the bucket lifecycle rule that reaps abandoned / oversized pending
 * uploads (`applyPendingObjectLifecycle` in `lib/storage/media`) matches
 * the exact prefix `pendingGcsObjectKeyFor` writes — the rule and the key
 * builder can't drift to different prefixes.
 */
export const PENDING_OBJECT_PREFIX = "pending/";

/**
 * Pending GCS object key derivation for browser signed-PUT uploads.
 *
 * The browser's signed URL is minted BEFORE the server has validated the
 * bytes, so it lands at a per-attempt key under a top-level `pending/`
 * prefix — never the final content-hash key. A stale leaked URL can only
 * overwrite its own pending object; the key still embeds the owner, so it
 * also can't reach another user's space. Confirm-time validation promotes
 * clean bytes to `gcsObjectKeyFor(...)`; rejection deletes this pending
 * object and row.
 *
 * The prefix is top-level (not nested under `users/<owner>/`) so one bucket
 * lifecycle rule — delete objects under it past a short TTL — reaps uploads
 * that were initiated but never confirmed. GCS lifecycle prefix matching
 * anchors at the object-name start, so a per-owner-nested pending path could
 * not be expressed as a single rule.
 */
export function pendingGcsObjectKeyFor(
	owner: string,
	assetId: AssetId,
	extension: string,
): string {
	return `${PENDING_OBJECT_PREFIX}${owner}/${assetId}${extension}`;
}

/**
 * Re-export of the `Uuid` brand for callers that need to type a
 * field uuid alongside an `AssetId`. The domain field schemas use
 * `uuidSchema` directly for field identity; media uses the distinct
 * `AssetId` brand.
 */
export type { Uuid };
