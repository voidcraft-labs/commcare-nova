// lib/domain/multimedia.ts
//
// Domain primitives for native multimedia, in the authoring layer's
// own vocabulary. The export-boundary translation to CommCare's wire
// shapes lives exclusively in `lib/commcare/`; nothing here forecasts
// that mapping.
//
// What this module owns:
//
//  - `MediaAssetId` — a branded reference to one stored asset.
//  - `Media` — the slot bundle a carrier (a field message, a select
//    option) attaches. Image/audio/video are independent slots; a
//    carrier can populate any combination. Menu audio carriers and app
//    logo reference `MediaAssetId` directly. Menu icon carriers use the
//    slot-specific uploaded-or-built-in unions in `builtinIcons.ts`.
//  - `ACCEPTED_FORMATS`, the one registry of accepted asset formats, and
//    the MIME-type partitions, extension lookups and aliases derived from
//    it; per-kind size caps; and the GCS object-key derivations — the
//    cross-cutting constants both the storage layer and the upload routes
//    consume.
//
// The stored-record shapes live with their boundaries: the
// `MediaAssetDoc` interface in `lib/db/types.ts`, the client-facing
// wire shape in `lib/db/mediaAssets.ts`.

import { z } from "zod";
import { CANONICAL_UUID_PATTERN, type Uuid } from "./uuid";

/**
 * Branded identifier for a stored media asset. Distinct from any
 * other UUID brand in the codebase (field uuids, app ids, etc.) so
 * the compiler catches accidental cross-domain reference.
 *
 * Uploaded assets share Nova's canonical lowercase RFC UUID syntax, while
 * retaining a distinct brand so an entity UUID cannot satisfy a media slot.
 * Built-in menu icons are a separate closed `BuiltinIconRef` vocabulary in
 * `builtinIcons.ts`; they never pass this parser.
 */
export const mediaAssetIdSchema = z
	.string()
	.regex(
		CANONICAL_UUID_PATTERN,
		"Expected a canonical lowercase uploaded-media UUID.",
	)
	.brand<"MediaAssetId">();
export type MediaAssetId = z.infer<typeof mediaAssetIdSchema>;

/**
 * Parse and narrow untrusted input. This rejects rather than lowercasing or
 * otherwise normalizing; every route, tool, database projection, and carrier
 * therefore sees one spelling.
 */
export function asMediaAssetId(s: string): MediaAssetId {
	return mediaAssetIdSchema.parse(s);
}

/**
 * Kinds that attach to a CommCare carrier (a field message, a select
 * option, a menu tile, the app logo) and emit to the wire. The `Media`
 * bundle below is keyed by exactly these.
 *
 * NOTE the boundary is NOT compile-time: a slot's VALUE is an opaque
 * `MediaAssetId` (the brand doesn't encode the asset's kind), so a document's
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

/** One accepted asset format, as `ACCEPTED_FORMATS` lists it. */
export interface AcceptedFormat {
	/** The canonical MIME type a validated asset stores. */
	readonly mime: string;
	readonly kind: AssetKind;
	/** The extension a validated asset is stored under. */
	readonly extension: string;
	/** Every filename extension a person may upload the format under. */
	readonly declaredExtensions: readonly string[];
	/** Other spellings of the MIME a browser claim or a sniff may use. */
	readonly aliases: readonly string[];
	/** The format's name as a person reads it. */
	readonly label: string;
	/**
	 * The items of `lib/commcare/surface/media-formats.json` the format
	 * admits; empty for a document, which never reaches a CommCare carrier.
	 */
	readonly surfaceKeys: readonly string[];
}

/**
 * Every asset format the upload gate accepts, one entry per canonical MIME.
 *
 * A media format is accepted when every CommCare platform plays it and HQ
 * files its bytes as the same kind: CommCare Android's decoders on Android
 * 6.0, 10 and 15, the browser engines Web Apps runs in, and HQ's bulk upload,
 * which types each file by its bytes (`hqmedia/models.py::
 * CommCareMultimedia.get_class_by_data`), never by its extension. Several
 * formats are accepted only in the variant every reader played: the body
 * checks in `lib/media/validate.ts` hold a BMP to two headers, an M4A to its
 * brand and AAC, an Ogg to Vorbis or Opus, and a WebM to VP8 or 8-bit 4:2:0
 * VP9 with Vorbis or Opus audio (`media-formats.json`'s `executions` record
 * where each was played).
 *
 * SVG is deliberately absent — it's a script container with active
 * content surface (XSS via embedded `<script>` / event handlers),
 * and the wire-side carriers don't render it usefully either way.
 *
 * Text carries no magic-bytes signature, so `file-type` can't sniff it — the
 * validator gives the `text` kind a dedicated arm (extension + UTF-8
 * validity) instead of the magic-bytes gate the other formats pass.
 */
export const ACCEPTED_FORMATS = [
	{
		mime: "image/png",
		kind: "image",
		extension: ".png",
		declaredExtensions: [".png"],
		// Animated PNG is a backward-compatible PNG extension; `file-type`
		// sniffs it as `image/apng`. Treat it as `image/png` so a normal-
		// looking `.png` that happens to be animated isn't rejected with a
		// baffling "your PNG isn't a PNG" — it stores + serves as PNG, and
		// renderers without APNG support fall back to the first frame.
		aliases: ["image/apng"],
		label: "PNG",
		surfaceKeys: ["media-format:image/png"],
	},
	{
		mime: "image/jpeg",
		kind: "image",
		extension: ".jpg",
		declaredExtensions: [".jpg", ".jpeg"],
		aliases: [],
		label: "JPEG",
		surfaceKeys: ["media-format:image/jpeg"],
	},
	{
		mime: "image/gif",
		kind: "image",
		extension: ".gif",
		declaredExtensions: [".gif"],
		aliases: [],
		label: "GIF",
		surfaceKeys: ["media-format:image/gif"],
	},
	{
		mime: "image/webp",
		kind: "image",
		extension: ".webp",
		declaredExtensions: [".webp"],
		aliases: [],
		label: "WebP",
		surfaceKeys: ["media-format:image/webp"],
	},
	{
		mime: "image/bmp",
		kind: "image",
		extension: ".bmp",
		declaredExtensions: [".bmp"],
		aliases: ["image/x-ms-bmp", "image/x-bmp"],
		label: "BMP",
		surfaceKeys: ["media-format:image/bmp"],
	},
	{
		// `audio/mpeg`'s "mpeg" is historical; the MPEG-1 Audio Layer 3
		// container is universally `.mp3` on disk and by every player's
		// extension match.
		mime: "audio/mpeg",
		kind: "audio",
		extension: ".mp3",
		declaredExtensions: [".mp3"],
		aliases: [],
		label: "MP3",
		surfaceKeys: ["media-format:audio/mp3"],
	},
	{
		// The item is the one step 4 narrows acceptance to: step 2 checks no
		// WAV encoding.
		mime: "audio/wav",
		kind: "audio",
		extension: ".wav",
		declaredExtensions: [".wav"],
		aliases: [],
		label: "WAV",
		surfaceKeys: ["media-format:audio/wav-pcm-8-or-16-bit"],
	},
	{
		mime: "audio/mp4",
		kind: "audio",
		extension: ".m4a",
		declaredExtensions: [".m4a"],
		aliases: ["audio/x-m4a", "audio/m4a"],
		label: "M4A",
		surfaceKeys: ["media-format:audio/m4a"],
	},
	{
		mime: "audio/flac",
		kind: "audio",
		extension: ".flac",
		declaredExtensions: [".flac"],
		aliases: ["audio/x-flac"],
		label: "FLAC",
		surfaceKeys: ["media-format:audio/flac"],
	},
	{
		// One entry for Vorbis and Opus: both are `audio/ogg`, and an Opus
		// file is commonly named `.opus`, accepted as `.jpeg` is for `.jpg`.
		mime: "audio/ogg",
		kind: "audio",
		extension: ".ogg",
		declaredExtensions: [".ogg", ".opus"],
		aliases: ["audio/opus", "audio/vorbis", "application/ogg"],
		label: "Ogg",
		surfaceKeys: [
			"media-format:audio/ogg-vorbis",
			"media-format:audio/ogg-opus",
		],
	},
	{
		// The items are the ones step 4 narrows acceptance to: step 2 checks
		// no MP4 codec.
		mime: "video/mp4",
		kind: "video",
		extension: ".mp4",
		declaredExtensions: [".mp4"],
		aliases: [],
		label: "MP4",
		surfaceKeys: [
			"media-format:video/mp4-h264-baseline",
			"media-format:video/mp4-h264-main",
		],
	},
	{
		// One entry for VP8 and VP9, both `video/webm`.
		mime: "video/webm",
		kind: "video",
		extension: ".webm",
		declaredExtensions: [".webm"],
		aliases: [],
		label: "WebM",
		surfaceKeys: ["media-format:video/webm-vp8", "media-format:video/webm-vp9"],
	},
	{
		mime: "application/pdf",
		kind: "pdf",
		extension: ".pdf",
		declaredExtensions: [".pdf"],
		aliases: [],
		label: "PDF",
		surfaceKeys: [],
	},
	{
		mime: "text/plain",
		kind: "text",
		extension: ".txt",
		declaredExtensions: [".txt"],
		aliases: [],
		label: "Text",
		surfaceKeys: [],
	},
	{
		mime: "text/markdown",
		kind: "text",
		extension: ".md",
		declaredExtensions: [".md"],
		aliases: [],
		label: "Markdown",
		surfaceKeys: [],
	},
	{
		mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		kind: "docx",
		extension: ".docx",
		declaredExtensions: [".docx"],
		aliases: [],
		label: "Word",
		surfaceKeys: [],
	},
	{
		mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		kind: "xlsx",
		extension: ".xlsx",
		declaredExtensions: [".xlsx"],
		aliases: [],
		label: "Excel",
		surfaceKeys: [],
	},
] as const satisfies readonly AcceptedFormat[];

type RegisteredFormat = (typeof ACCEPTED_FORMATS)[number];
type MimeOfKind<K extends AssetKind> = Extract<
	RegisteredFormat,
	{ readonly kind: K }
>["mime"];

/** The canonical MIME types of one kind, in registry order. */
function mimesOfKind<K extends AssetKind>(kind: K): readonly MimeOfKind<K>[] {
	return ACCEPTED_FORMATS.filter((format) => format.kind === kind).map(
		(format) => format.mime as MimeOfKind<K>,
	);
}

/**
 * MIME types accepted at the upload validation gate, partitioned by
 * kind and derived from `ACCEPTED_FORMATS`. The sniffed `mimeType` on a
 * `MediaAsset` MUST be one of these — any other value is a
 * validation-pipeline failure (the upload is rejected, the GCS object is
 * deleted, the Postgres row is removed).
 */
export const IMAGE_MIME_TYPES = mimesOfKind("image");
export type ImageMimeType = MimeOfKind<"image">;
export const AUDIO_MIME_TYPES = mimesOfKind("audio");
export type AudioMimeType = MimeOfKind<"audio">;
export const VIDEO_MIME_TYPES = mimesOfKind("video");
export type VideoMimeType = MimeOfKind<"video">;

/**
 * Document MIME types — the library-only asset formats (see
 * `DOCUMENT_KINDS`). Unlike image/audio/video, documents are NEVER
 * attachable to a CommCare carrier and never reach the wire emitter; they
 * live in the user's file library as inputs to attach to the SA chat.
 */
export const PDF_MIME_TYPES = mimesOfKind("pdf");
export const TEXT_MIME_TYPES = mimesOfKind("text");
export const DOCX_MIME_TYPES = mimesOfKind("docx");
export const XLSX_MIME_TYPES = mimesOfKind("xlsx");
export const DOCUMENT_MIME_TYPES = [
	...PDF_MIME_TYPES,
	...TEXT_MIME_TYPES,
	...DOCX_MIME_TYPES,
	...XLSX_MIME_TYPES,
];

export type AssetMimeType = RegisteredFormat["mime"];
export const ALL_MIME_TYPES: readonly AssetMimeType[] = ACCEPTED_FORMATS.map(
	(format) => format.mime,
);

/**
 * The image formats a model provider reads: the four the chat and document
 * extraction send as pixels. An image asset outside it (a BMP) reaches the
 * model as a placeholder, never as its own MIME.
 */
export const MODEL_READABLE_IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const satisfies readonly ImageMimeType[];
export type ModelReadableImageMimeType =
	(typeof MODEL_READABLE_IMAGE_MIME_TYPES)[number];

/** Whether a MIME type is one a model provider reads as an image. */
export function isModelReadableImageMimeType(
	mimeType: string,
): mimeType is ModelReadableImageMimeType {
	return (MODEL_READABLE_IMAGE_MIME_TYPES as readonly string[]).includes(
		mimeType,
	);
}

/** "a BMP image": an image format, as a person names it in a sentence. */
export function imageFormatNoun(mimeType: string): string {
	const label = FORMAT_BY_MIME.get(mimeType)?.label;
	return label === undefined ? "an image" : `a ${label} image`;
}

/**
 * Every filename extension the upload pre-screen accepts: each format's
 * declared extensions, in registry order. The post-sniff authoritative
 * extension comes from `EXTENSION_FOR_MIME_TYPE`.
 */
export const ACCEPTED_EXTENSIONS = ACCEPTED_FORMATS.flatMap(
	(format) => format.declaredExtensions,
);
export type AcceptedExtension = RegisteredFormat["declaredExtensions"][number];

const FORMAT_BY_MIME: ReadonlyMap<string, RegisteredFormat> = new Map(
	ACCEPTED_FORMATS.map((format) => [format.mime, format]),
);

/** The registry entry of a canonical MIME type, or `undefined`. */
export function acceptedFormatFor(
	mimeType: string,
): RegisteredFormat | undefined {
	return FORMAT_BY_MIME.get(mimeType);
}

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
	return FORMAT_BY_MIME.get(mimeType)?.kind;
}

// The extension → kind / extension → MIME fallbacks (used when the browser sends
// no usable Content-Type) are defined below, AFTER `EXTENSION_FOR_MIME_TYPE` —
// they derive from it so there's one source of truth for the extension↔MIME map.

/**
 * Aliases a raw MIME string can take for an accepted format, when a
 * `file-type` sniff or a browser `Content-Type` uses a non-canonical
 * spelling, derived from each registry entry's `aliases`. Only genuinely
 * different spellings need an entry — codec parameters (`; codecs=...`) are
 * stripped to the base type by `normalizeMimeType` before lookup.
 */
const MIME_ALIASES: ReadonlyMap<string, AssetMimeType> = new Map(
	ACCEPTED_FORMATS.flatMap((format) =>
		format.aliases.map((alias) => [alias, format.mime] as const),
	),
);

/**
 * Normalize a raw MIME string — a browser `Content-Type` claim or a
 * `file-type` sniff result — to its canonical accepted form, or
 * `undefined` if it isn't an accepted media type.
 *
 *  - strips codec parameters (`video/mp4; codecs=avc1` → `video/mp4`)
 *  - maps known aliases (`image/apng` → `image/png`, `audio/x-m4a` →
 *    `audio/mp4`)
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
	return FORMAT_BY_MIME.get(base)?.mime ?? MIME_ALIASES.get(base);
}

/**
 * Canonical file extension for each accepted MIME type, from the registry.
 * The validator picks an extension from this map after the magic-bytes
 * sniff confirms the real type, regardless of what the client's original
 * filename claimed. Used to construct the GCS object key.
 */
export const EXTENSION_FOR_MIME_TYPE = Object.fromEntries(
	ACCEPTED_FORMATS.map((format) => [format.mime, format.extension]),
) as Record<AssetMimeType, string>;

/**
 * Canonical accepted MIME type for a (lowercased) file extension: each
 * format's declared extensions (`.jpeg` beside `.jpg`, `.opus` beside
 * `.ogg`). Derived from the registry so the extension↔MIME pairing has a
 * single source and the two directions can't drift.
 *
 * The fallback for when the browser sends no usable `Content-Type` — empty or
 * `application/octet-stream`, common for `.md`, `.flac`, `.opus` and some
 * office files: the client upload path picks the MIME to claim from the
 * filename, and the validator picks the kind. The extension is only a routing
 * HINT; the magic-bytes sniff (or the UTF-8 check for text) is still the
 * authoritative format gate at confirm time.
 */
const MIME_FOR_EXTENSION: ReadonlyMap<string, AssetMimeType> = new Map(
	ACCEPTED_FORMATS.flatMap((format) =>
		format.declaredExtensions.map(
			(extension) => [extension, format.mime] as const,
		),
	),
);

/** Canonical accepted MIME for a (lowercased) file extension, or `undefined`. */
export function mimeTypeForExtension(ext: string): AssetMimeType | undefined {
	return MIME_FOR_EXTENSION.get(ext.toLowerCase());
}

/**
 * Asset kind for a (lowercased) file extension, derived THROUGH the MIME map +
 * `assetKindForMimeType` so the kind and the MIME a given extension implies stay
 * consistent (no second hand-maintained extension→kind table to drift). The
 * fallback the validator uses when the browser sends no usable `Content-Type`.
 */
export function assetKindForExtension(ext: string): AssetKind | undefined {
	const mime = mimeTypeForExtension(ext);
	return mime ? assetKindForMimeType(mime) : undefined;
}

/** The lowercased extension (including the dot) of a filename, or `undefined`
 *  when it has none. `"Form.PDF"` → `".pdf"`. */
export function extensionOf(filename: string): string | undefined {
	const dot = filename.lastIndexOf(".");
	return dot === -1 ? undefined : filename.slice(dot).toLowerCase();
}

/** Asset kind implied by a filename's extension — the routing fallback the
 *  upload preflight uses when the browser's `File.type` isn't a recognized
 *  media type. */
export function assetKindForFilename(filename: string): AssetKind | undefined {
	const ext = extensionOf(filename);
	return ext ? assetKindForExtension(ext) : undefined;
}

/** Canonical accepted MIME implied by a filename's extension, or `undefined`. */
export function mimeTypeForFilename(
	filename: string,
): AssetMimeType | undefined {
	const ext = extensionOf(filename);
	return ext ? mimeTypeForExtension(ext) : undefined;
}

/**
 * The MIME type the client should CLAIM when initiating an upload. Browsers set
 * `File.type` unreliably — empty or `application/octet-stream` for `.md` and some
 * office files — and the initiate route validates the claim, so a bad claim is
 * rejected before the bytes ever flow. Prefer the browser's claim when it
 * normalizes to an accepted type; otherwise fall back to the filename extension's
 * canonical MIME; as a last resort return the raw claim so the server produces a
 * clear rejection rather than a silent empty string. The confirm-time validator
 * re-derives the authoritative MIME/extension from the bytes + filename
 * regardless, so this only needs to be good enough to pass initiate + bind the
 * signed PUT URL's `Content-Type`.
 */
export function resolveUploadMimeType(
	rawType: string,
	filename: string,
): string {
	return normalizeMimeType(rawType) ?? mimeTypeForFilename(filename) ?? rawType;
}

/**
 * Carrier-side slot bundle. Each slot is independent: a question
 * can have image+audio+video simultaneously, or any subset, or
 * none. Slot key encodes the kind; the value is the asset id, full
 * stop.
 *
 * Menu-style carriers and the app logo use direct parent slots rather than
 * this bundle because their slot count is small + asymmetric (image + audio,
 * no video — or just image for the logo). Audio labels and the logo are strict
 * `MediaAssetId`s; menu icons use the slot-specific `ModuleIconRef` /
 * `FormIconRef` unions in `builtinIcons.ts`.
 */
export const mediaSchema = z.strictObject({
	image: mediaAssetIdSchema.optional(),
	audio: mediaAssetIdSchema.optional(),
	video: mediaAssetIdSchema.optional(),
});
export type Media = z.infer<typeof mediaSchema>;

/**
 * Lifecycle status of a stored media asset. Two states only:
 *
 *  - `pending` — the Postgres row exists; the GCS object may or
 *    may not be in flight; bytes have NOT been validated. The
 *    upload-confirm step flips this to `ready` once the validator
 *    runs against the stored bytes. Pending assets must never
 *    appear in a shipped (CCHQ-uploaded) app — the validator gate
 *    rejects them.
 *  - `ready` — the GCS object exists, bytes have been validated,
 *    sniffed `mimeType` / `extension` / `dimensions` / `durationMs`
 *    are written.
 *
 * `failed` is not a state — the confirm step deletes the Postgres
 * row and, when unshared, the pending GCS object on validation failure.
 * A `pending` row left dangling by a client that never confirms is
 * filtered out of the library list and rejected by the validator gate;
 * its abandoned GCS object is reaped by the bucket's `pending/` lifecycle
 * rule (1-day TTL), and the dangling Postgres row stays harmless (it
 * never surfaces in the library or a shipped app — there is no row reaper
 * today, only the object-side lifecycle rule).
 *
 * The stored-record shapes live with their respective boundaries:
 * `MediaAssetDoc` (the `media_assets` row shape, `Date`-typed) in
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
 * Final GCS object key derivation. Per-PROJECT namespace gives us
 * (project, hash) dedup at the storage layer once bytes have been validated —
 * same blob attached to two apps in the same Project shares one object, while
 * two Projects keep separate copies. Project-scoped (not per-owner) so the
 * bytes belong to the tenant: a member's deletion can later purge their
 * personal-Project bytes without touching shared-Project media. The trailing
 * extension is the canonical extension for the sniffed MIME (not the client's
 * original filename extension).
 */
export function gcsObjectKeyFor(
	projectId: string,
	contentHash: string,
	extension: string,
): string {
	return `projects/${projectId}/${contentHash}${extension}`;
}

/**
 * GCS object key for a document's requirements extract — a sibling of the
 * bytes object under the same per-Project namespace. Keyed by the content hash
 * AND the extractor `version`, so:
 *
 *  - the extract dedups exactly like the bytes (same document re-attached in
 *    the same Project resolves to one extract), and
 *  - bumping `EXTRACTOR_VERSION` (a prompt/model change) lands a NEW key, so
 *    every stale extract is invalidated without a migration — the old object
 *    simply stops being read and ages out, and the next reference re-extracts
 *    at the current version.
 *
 * `.md` because the extractor emits GitHub-flavored markdown (tables for
 * spreadsheets, bullet structure for prose).
 */
export function extractGcsObjectKeyFor(
	projectId: string,
	contentHash: string,
	version: number,
): string {
	return `projects/${projectId}/${contentHash}.extract.v${version}.md`;
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
export const EXTRACTOR_VERSION = 8;

/**
 * The GCS object key of a document's stored extract, or `null` for a media kind
 * (image/audio/video), which has no extract. Asset deletion uses this to purge
 * the extract sibling alongside the bytes. Pure — no I/O, no heavy imports — so
 * any layer (the delete route, the SA tool) can call it without pulling in the
 * extraction machinery.
 *
 * Keyed off the version the extract was ACTUALLY produced at (`extract.version`),
 * NOT the current `EXTRACTOR_VERSION`. After a version bump, a document extracted
 * at the prior version still has its real object at the prior key; computing the
 * current key would purge a key that was never written and orphan the live object
 * in GCS forever (no lifecycle rule reaps `…extract.v*.md`). Falls back to the
 * current version only when no extract has been recorded yet — then there is no
 * stored object and the purge is a harmless no-op.
 */
export function extractObjectKeyForAsset(asset: {
	kind: AssetKind;
	project_id: string;
	contentHash: string;
	extract?: { version: number } | null;
}): string | null {
	if (!isDocumentKind(asset.kind)) return null;
	const version = asset.extract?.version ?? EXTRACTOR_VERSION;
	return extractGcsObjectKeyFor(asset.project_id, asset.contentHash, version);
}

/**
 * Top-level prefix every signed-PUT pending object lives under. Shared so
 * the bucket storage policy that reaps abandoned / oversized pending
 * uploads (`applyMediaBucketStoragePolicy` in `lib/storage/media`) matches
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
 * overwrite its own pending object (the key embeds the random `assetId`).
 * Confirm-time validation promotes clean bytes to `gcsObjectKeyFor(...)`;
 * rejection deletes this pending object and row.
 *
 * The prefix is top-level (not nested under `projects/<id>/`) so one bucket
 * lifecycle rule — delete objects under it past a short TTL — reaps uploads
 * that were initiated but never confirmed. GCS lifecycle prefix matching
 * anchors at the object-name start, so a per-Project-nested pending path could
 * not be expressed as a single rule; the Project segment sits AFTER the
 * `pending/` prefix so the one rule still matches.
 */
export function pendingGcsObjectKeyFor(
	projectId: string,
	assetId: MediaAssetId,
	extension: string,
): string {
	return `${PENDING_OBJECT_PREFIX}${projectId}/${assetId}${extension}`;
}

/**
 * Re-export of the `Uuid` brand for callers that need to type a
 * field uuid alongside a `MediaAssetId`. The domain field schemas use
 * `uuidSchema` directly for field identity; media uses the distinct
 * `MediaAssetId` brand.
 */
export type { Uuid };
