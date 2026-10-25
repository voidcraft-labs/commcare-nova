/**
 * Media validation pipeline.
 *
 * One module, two entry points: the HTTP confirm route reads bytes
 * from GCS, the MCP `upload_media_asset` tool decodes base64 inline.
 * Both pass through this same gauntlet so the rejection contract is
 * uniform.
 *
 * The pipeline is defense-in-depth — five stages, each rejecting
 * different classes of bad input:
 *
 *   1. Extension whitelist
 *   2. Size cap per kind
 *   3. Format check — a magic-bytes sniff (file-type) for everything that
 *      carries a container signature; a UTF-8 check for text, which has
 *      none
 *   4. Body checks, dispatched on the sniffed MIME: image (sharp, or
 *      Nova's own readers for BMP and ICO, `bmp.ts` and `ico.ts`) and
 *      audio/video (music-metadata, plus Nova's own readers where it
 *      cannot tell a variant: `mp4.ts`, `wav.ts`, `amr.ts`, `midi.ts`, and
 *      `webm.ts` for a VP9 profile), each naming the variant the bytes are
 *      (`lib/domain/multimedia.ts::MEDIA_FORMATS`) or refusing bytes no
 *      CommCare platform plays. pdf/docx/xlsx are
 *      validated by the sniff ALONE — the server never parses an untrusted
 *      office/PDF body (that's a real parser-CVE surface); the preview
 *      parses them client-side, on the owner's own file, instead
 *   5. SHA-256 computed from the validated bytes
 *
 * Trust nothing the client says about the bytes; verify everything.
 * MIME-from-header and file-extension are advisory only. The sniffed
 * MIME after the magic-bytes check is what becomes the asset's
 * canonical `mimeType`; the extension is derived from that, not from
 * the client's filename.
 *
 * SVG is refused before the allow-list, with its own sentence: CommCare HQ
 * types it as an image and cannot store it.
 *
 * Every rejection carries an Elm-shape message: what was tried + the
 * specific mismatch + what the user can do about it.
 */

import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { type IAudioMetadata, parseBuffer } from "music-metadata";
import sharp from "sharp";
import {
	ACCEPTED_EXTENSIONS,
	ALL_MIME_TYPES,
	ASSET_SIZE_CAPS_BYTES,
	type AssetKind,
	type AssetMimeType,
	acceptedFormatFor,
	assetKindForExtension,
	assetKindForMimeType,
	EXTENSION_FOR_MIME_TYPE,
	type MediaFormatKey,
	type MediaFormatValue,
	mimeTypeForExtension,
	normalizeMimeType,
	UNPLAYABLE_MEDIA_FORMAT,
} from "@/lib/domain/multimedia";
import { readAmr } from "./amr";
import { readBmp } from "./bmp";
import { readIco } from "./ico";
import { readMidi } from "./midi";
import { MP4_VIDEO_ADVICE, readMp4 } from "./mp4";
import { namesSvg, SVG_REFUSAL_MESSAGE } from "./svg";
import { readWav } from "./wav";
import { readVp9Profile } from "./webm";

/**
 * Extensions the upload pre-screen accepts: every accepted format's declared
 * extensions (`lib/domain/multimedia.ts::ACCEPTED_EXTENSIONS`). The post-sniff
 * authoritative extension comes from `EXTENSION_FOR_MIME_TYPE`; the list
 * exists to reject obvious off-list filenames before spending a magic-bytes
 * sniff on them.
 */
export type { AcceptedExtension } from "@/lib/domain/multimedia";

/**
 * Discriminated result of the validation pipeline. Callers branch
 * on `ok` and either commit (`ready` state, write metadata) or
 * reject (return a 400 with the Elm-shape message).
 */
export type ValidationResult =
	| { ok: true; validated: ValidatedMediaMetadata }
	| { ok: false; reason: ValidationFailureReason; message: string };

export interface ValidatedMediaMetadata {
	contentHash: string;
	mimeType: AssetMimeType;
	extension: string;
	sizeBytes: number;
	kind: AssetKind;
	dimensions?: { width: number; height: number };
	durationMs?: number;
	/** The variant the bytes are, present exactly when `kind` is a media kind. */
	mediaFormat?: MediaFormatKey;
}

/**
 * Coarse-grained failure categories. The Elm-shape `message`
 * carries the specifics; this enum exists for log filtering and
 * for tests that assert which gate caught a particular fixture.
 */
export type ValidationFailureReason =
	| "extension-not-accepted"
	| "size-cap-exceeded"
	| "magic-bytes-sniff-failed"
	| "mime-claim-mismatch"
	| "extension-mime-mismatch"
	| "hash-claim-mismatch"
	| "image-parse-failed"
	| "media-parse-failed"
	| "text-not-utf8"
	| "claimed-size-mismatch"
	| "container-brand-not-accepted"
	| "codec-not-accepted"
	| "bmp-variant-not-accepted"
	| "svg-not-accepted"
	| "ico-variant-not-accepted";

export { namesSvg, SVG_REFUSAL_MESSAGE } from "./svg";

/**
 * Validate a byte payload + metadata claims.
 *
 * `claimedSizeBytes` is checked against `bytes.length` — a mismatch
 * means either the client lied or the bytes were truncated in
 * transit; either way we reject.
 *
 * `claimedContentHash` is optional. The HTTP confirm route passes
 * it (so we catch any GCS-side tampering between PUT and confirm);
 * the MCP base64-inline path skips it (the bytes never left the
 * server's memory).
 *
 * `originalFilename` drives the extension pre-screen and is
 * preserved on the validated metadata for library display.
 */
export async function validateMediaBytes(args: {
	bytes: Buffer;
	claimedMimeType: string;
	claimedSizeBytes: number;
	claimedContentHash?: string;
	originalFilename: string;
}): Promise<ValidationResult> {
	const { bytes, claimedMimeType, claimedSizeBytes, claimedContentHash } = args;

	// Stage 1: SVG first, then the extension whitelist. An SVG claim under an
	// accepted extension (bytes named `x.png`) gets the SVG sentence rather
	// than falling through to the sniff. Then reject obvious off-list
	// filenames before spending a magic-bytes sniff. The extension match is
	// case-insensitive (`Foo.PNG` is fine).
	if (namesSvg(args.originalFilename, claimedMimeType)) {
		return {
			ok: false,
			reason: "svg-not-accepted",
			message: SVG_REFUSAL_MESSAGE,
		};
	}
	const lowerName = args.originalFilename.toLowerCase();
	const declaredExt = ACCEPTED_EXTENSIONS.find((ext) =>
		lowerName.endsWith(ext),
	);
	if (!declaredExt) {
		return {
			ok: false,
			reason: "extension-not-accepted",
			message: `Tried to upload \`${args.originalFilename}\` but its extension isn't an accepted media type. We accept ${ACCEPTED_EXTENSIONS.join(", ")}. Rename the file to one of those extensions, or pick a different file.`,
		};
	}

	// Stage 2: claimed-size sanity + per-kind size cap. Run the
	// claimed-vs-actual check first because a mismatch is a clearer
	// error than "MIME size cap exceeded" when the size itself is
	// wrong.
	if (bytes.length !== claimedSizeBytes) {
		return {
			ok: false,
			reason: "claimed-size-mismatch",
			message: `The file's actual size (${bytes.length} bytes) doesn't match the size your upload claimed (${claimedSizeBytes} bytes). The bytes may have been truncated or modified in transit. Try uploading again.`,
		};
	}

	// The kind is resolved BEFORE the size cap so we can pick the right
	// per-kind cap + validation arm. Prefer the claimed MIME (normalized
	// so an alias like `image/apng` reconciles); fall back to the declared
	// extension when the browser sent no usable Content-Type — empty or
	// `application/octet-stream`, common for `.md` and some office files.
	// `declaredExt` passed the whitelist in stage 1, so the fallback always
	// resolves a kind; the sniff (or the UTF-8 check) below is the
	// authoritative format gate regardless of which source named the kind.
	const normalizedClaim = normalizeMimeType(claimedMimeType);
	const claimedKind =
		(normalizedClaim ? assetKindForMimeType(normalizedClaim) : undefined) ??
		assetKindForExtension(declaredExt);
	if (!claimedKind) {
		return {
			ok: false,
			reason: "mime-claim-mismatch",
			message: `Tried to upload \`${args.originalFilename}\`, but neither its type (\`${claimedMimeType || "none"}\`) nor its \`${declaredExt}\` extension maps to an accepted format. Accepted types are ${ALL_MIME_TYPES.join(", ")}.`,
		};
	}

	const cap = ASSET_SIZE_CAPS_BYTES[claimedKind];
	if (bytes.length > cap) {
		const capMb = (cap / 1024 / 1024).toFixed(0);
		const actualMb = (bytes.length / 1024 / 1024).toFixed(2);
		return {
			ok: false,
			reason: "size-cap-exceeded",
			message: `\`${args.originalFilename}\` is ${actualMb} MB, but ${claimedKind} uploads are capped at ${capMb} MB. Compress the file (image: re-export at lower quality; audio: re-encode at a lower bitrate; video: shorter clip or smaller resolution) and try again.`,
		};
	}

	// Per-kind format check + body validation. Text carries no magic-bytes
	// signature, so it can't go through the `file-type` sniff — it's
	// validated as UTF-8 by extension instead. Everything else
	// (image/audio/video/pdf/docx/xlsx) carries a container signature
	// `file-type` detects.
	let sniffedMime: AssetMimeType;
	let canonicalExtension: string;
	let dimensions: { width: number; height: number } | undefined;
	let durationMs: number | undefined;
	let mediaFormat: MediaFormatKey | undefined;

	if (claimedKind === "text") {
		// No sniff possible. Reject a binary file mislabeled `.txt`/`.md`:
		// the bytes must decode as valid UTF-8 with no NUL byte. The
		// canonical MIME + extension come from the declared extension
		// (`.md` → markdown, else plain) since there's nothing to sniff.
		if (!isUtf8Text(bytes)) {
			return {
				ok: false,
				reason: "text-not-utf8",
				message: `\`${args.originalFilename}\` doesn't read as a text file, it has bytes that aren't valid UTF-8 text. If it's really a document, upload it in its original format (PDF, Word, or Excel) rather than as text.`,
			};
		}
		sniffedMime = declaredExt === ".md" ? "text/markdown" : "text/plain";
		canonicalExtension = declaredExt === ".md" ? ".md" : ".txt";
	} else {
		// Stage 3: magic-bytes sniff. `file-type` reads the leading bytes to
		// identify the format from its container signature — including the
		// ZIP + `[Content_Types].xml` inspection that tells docx/xlsx from a
		// bare archive. A `.png` on non-PNG bytes, or a `.docx` that's just
		// a renamed ZIP, is rejected here: the primary anti-spoof defense.
		const sniffed = await fileTypeFromBuffer(bytes);
		if (!sniffed) {
			return {
				ok: false,
				reason: "magic-bytes-sniff-failed",
				message: `Couldn't identify the format of \`${args.originalFilename}\` from its bytes. The file may be empty, corrupted, or in a format we don't recognize. Try re-exporting from its original source.`,
			};
		}
		// Normalize the sniff before comparing — `file-type` reports some
		// formats under alias spellings (`image/apng`) or with codec
		// parameters (`video/mp4; codecs=...`).
		const normalizedSniff = normalizeMimeType(sniffed.mime);
		if (!normalizedSniff) {
			return {
				ok: false,
				reason: "magic-bytes-sniff-failed",
				message: `\`${args.originalFilename}\` looks like a \`${sniffed.mime}\` file, which isn't an accepted type. Accepted: ${ALL_MIME_TYPES.join(", ")}.`,
			};
		}
		// An `.m4a` HQ would file as video: the sniff reads an MP4 whose
		// `ftyp` brand is not `M4A ` or `M4B ` (`isom`, `mp42`, `mp41`,
		// `dash`) as `video/mp4`, and so does HQ's bulk upload, which types
		// each file by its bytes, so an audio slot would never receive it.
		// It gets its own refusal before the claim and extension checks,
		// which would only say the file was renamed.
		if (
			normalizedSniff === "video/mp4" &&
			mimeTypeForExtension(declaredExt) === "audio/mp4"
		) {
			return {
				ok: false,
				reason: "container-brand-not-accepted",
				message: M4A_BRAND_MESSAGE,
			};
		}
		// Cross-check the sniff against the claimed MIME WHEN the browser
		// sent a usable one. A missing/unusable claim (the extension named
		// the kind) has nothing to cross-check — the sniff plus the
		// extension-vs-sniff check below are the gates in that case.
		if (normalizedClaim && normalizedSniff !== normalizedClaim) {
			return {
				ok: false,
				reason: "mime-claim-mismatch",
				message: `\`${args.originalFilename}\` claims to be \`${normalizedClaim}\` but the bytes are actually \`${normalizedSniff}\`. This usually means the file was renamed without re-encoding. Either rename it to match its real format or re-export it as \`${normalizedClaim}\`.`,
			};
		}
		sniffedMime = normalizedSniff;
		canonicalExtension = EXTENSION_FOR_MIME_TYPE[sniffedMime];
		// The pre-screen extension and the post-sniff canonical extension
		// can legitimately differ within one format's family: `.jpeg` beside
		// `.jpg`, `.opus` beside `.ogg` (each format's `declaredExtensions`).
		// Accept the family match; reject the rest — which also catches a
		// renamed file whose real format (the sniff) doesn't match its
		// extension (a PNG renamed `.docx`).
		const declaredFamily: readonly string[] =
			acceptedFormatFor(sniffedMime)?.declaredExtensions ?? [];
		if (!declaredFamily.includes(declaredExt)) {
			return {
				ok: false,
				reason: "extension-mime-mismatch",
				message: `\`${args.originalFilename}\` has extension \`${declaredExt}\` but its bytes are \`${sniffedMime}\` (which we'd expect to end in \`${canonicalExtension}\`). Rename the file to match the format, or re-export to the format the extension suggests.`,
			};
		}

		// Stage 4: body checks, dispatched on the sniffed MIME — image
		// (sharp, or `bmp.ts` for a BMP, which sharp cannot read) and
		// audio/video (music-metadata, one parse shared with the duration
		// read, plus `webm.ts` for a VP9 profile). pdf/docx/xlsx are
		// validated by the sniff ALONE: the server deliberately doesn't parse
		// an untrusted office / PDF body (a real parser memory-safety +
		// prototype-pollution surface). The preview parses them client-side,
		// on the owner's own file, where any parser bug is confined to their
		// own browser.
		if (claimedKind === "image") {
			const verdict = await imageVerdict(
				bytes,
				sniffedMime,
				args.originalFilename,
			);
			if (!verdict.ok) return verdict;
			dimensions = verdict.dimensions;
			mediaFormat = verdict.key;
		} else if (claimedKind === "audio" || claimedKind === "video") {
			const verdict = await streamVerdict(
				bytes,
				sniffedMime,
				claimedKind,
				args.originalFilename,
			);
			if (!verdict.ok) return verdict;
			durationMs = verdict.durationMs;
			mediaFormat = verdict.key;
		}
	}

	// Stage 5: SHA-256 over the validated bytes. Used as the GCS
	// object key tail (per-owner content dedup) and stored on the
	// asset record. If the client claimed a hash (HTTP confirm
	// path), assert it matches what we just computed.
	const contentHash = createHash("sha256").update(bytes).digest("hex");
	if (claimedContentHash && contentHash !== claimedContentHash) {
		return {
			ok: false,
			reason: "hash-claim-mismatch",
			message: `The uploaded bytes have a different SHA-256 hash than the one your upload claimed. The file may have been modified between initiating the upload and confirming it. Try uploading again.`,
		};
	}

	return {
		ok: true,
		validated: {
			contentHash,
			mimeType: sniffedMime,
			extension: canonicalExtension,
			sizeBytes: bytes.length,
			kind: claimedKind,
			dimensions,
			durationMs,
			...(mediaFormat === undefined ? {} : { mediaFormat }),
		},
	};
}

/** The variant stored bytes are, or `unplayable` where no variant admits them. */
export async function classifyStoredMediaBytes(
	bytes: Buffer,
	stored: { readonly mimeType: AssetMimeType; readonly extension: string },
): Promise<MediaFormatValue> {
	const result = await validateMediaBytes({
		bytes,
		claimedMimeType: stored.mimeType,
		claimedSizeBytes: bytes.length,
		originalFilename: `asset${stored.extension}`,
	});
	return result.ok
		? (result.validated.mediaFormat ?? UNPLAYABLE_MEDIA_FORMAT)
		: UNPLAYABLE_MEDIA_FORMAT;
}

type Refusal = {
	readonly ok: false;
	readonly reason: ValidationFailureReason;
	readonly message: string;
};

function refused(refusal: {
	reason: ValidationFailureReason;
	message: string;
}): Refusal {
	return { ok: false, ...refusal };
}

const SHARP_IMAGE_KEYS: Readonly<Record<string, MediaFormatKey>> = {
	"image/png": "png",
	"image/jpeg": "jpeg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** The image body checks: the variant and its dimensions, or a refusal. */
async function imageVerdict(
	bytes: Buffer,
	mime: AssetMimeType,
	filename: string,
): Promise<
	| {
			readonly ok: true;
			readonly key: MediaFormatKey;
			readonly dimensions: { width: number; height: number };
	  }
	| Refusal
> {
	if (mime === "image/bmp") {
		const reading = readBmp(bytes);
		if (reading.kind === "variant") {
			return refused({
				reason: "bmp-variant-not-accepted",
				message: BMP_VARIANT_MESSAGE,
			});
		}
		if (reading.kind === "malformed") {
			return refused({
				reason: "image-parse-failed",
				message: `Couldn't read \`${filename}\` as a BMP image: ${reading.detail}. The file may be truncated or malformed. Try re-exporting from the source.`,
			});
		}
		return {
			ok: true,
			key: "bmp",
			dimensions: { width: reading.width, height: reading.height },
		};
	}
	if (mime === "image/vnd.microsoft.icon") {
		const reading = await readIco(bytes);
		switch (reading.kind) {
			case "icon":
				return {
					ok: true,
					key: "ico",
					dimensions: { width: reading.width, height: reading.height },
				};
			case "cursor":
				return refused({
					reason: "image-parse-failed",
					message: `\`${filename}\` is a cursor rather than an icon. Saving the image as a PNG fixes that.`,
				});
			case "variant":
				return refused({
					reason: "ico-variant-not-accepted",
					message: ICO_VARIANT_MESSAGE,
				});
			case "unreadable":
				return refused({
					reason: "image-parse-failed",
					message: `Couldn't read \`${filename}\` as an ICO image: ${reading.detail}. Saving the image as a PNG fixes that.`,
				});
		}
	}
	try {
		const meta = await sharp(bytes).metadata();
		if (!meta.width || !meta.height) {
			return refused({
				reason: "image-parse-failed",
				message: `\`${filename}\` parsed as a \`${mime}\` image but has no readable dimensions. The file may be truncated or malformed. Try re-exporting from the source.`,
			});
		}
		const dimensions = { width: meta.width, height: meta.height };
		if (mime === "image/avif") {
			if (meta.format !== "heif" || meta.compression !== "av1") {
				return refused({
					reason: "image-parse-failed",
					message: `\`${filename}\` holds HEIF images that are not AV1. Saving it as a PNG fixes that.`,
				});
			}
			return { ok: true, key: "avif", dimensions };
		}
		const key = SHARP_IMAGE_KEYS[mime];
		if (key === undefined) {
			throw new Error(
				`The upload gate read a ${mime} image with no variant to name. Each image MIME in ACCEPTED_FORMATS needs its MEDIA_FORMATS key here.`,
			);
		}
		return { ok: true, key, dimensions };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return refused({
			reason: "image-parse-failed",
			message: `Couldn't parse \`${filename}\` as a \`${mime}\` image (${detail}). The file may be truncated or malformed.`,
		});
	}
}

/** The audio and video body checks: the variant and its duration, or a refusal. */
async function streamVerdict(
	bytes: Buffer,
	mime: AssetMimeType,
	kind: "audio" | "video",
	filename: string,
): Promise<
	| {
			readonly ok: true;
			readonly key: MediaFormatKey;
			readonly durationMs: number | undefined;
	  }
	| Refusal
> {
	// AMR and MIDI have no music-metadata parser: their headers are the check,
	// and they carry no duration.
	if (mime === "audio/amr") {
		const reading = readAmr(bytes);
		if (reading.kind === "amr") {
			return { ok: true, key: "amr", durationMs: undefined };
		}
		if (reading.kind === "multichannel") {
			return refused(
				codecRefusal("multichannel AMR", "AMR or M4A (AAC) audio"),
			);
		}
		return refused({
			reason: "media-parse-failed",
			message: `\`${filename}\` holds no audio after its header. Exporting it again as AMR or M4A (AAC) audio fixes that.`,
		});
	}
	if (mime === "audio/midi") {
		const reading = readMidi(bytes);
		if (reading.kind === "midi") {
			return { ok: true, key: "midi", durationMs: undefined };
		}
		return refused({
			reason: "media-parse-failed",
			message: `Couldn't read \`${filename}\` as a MIDI file: ${reading.detail}. Exporting it again as a standard MIDI file fixes that.`,
		});
	}
	// WAV and MP4 are read by Nova's own readers first, then parsed by
	// music-metadata for their duration.
	let readerKey: MediaFormatKey | undefined;
	if (mime === "audio/wav") {
		const reading = readWav(bytes);
		if (reading.kind === "codec") {
			return refused(codecRefusal(reading.codec, "WAV with 16-bit PCM audio"));
		}
		if (reading.kind === "unreadable") {
			return refused({
				reason: "media-parse-failed",
				message: `Couldn't read the WAV header of \`${filename}\`: ${reading.detail}. Exporting it again as WAV with 16-bit PCM audio fixes that.`,
			});
		}
		readerKey = "wav-pcm";
	}
	if (mime === "video/mp4") {
		const reading = readMp4(bytes);
		const refusal = mp4Refusal(reading, filename);
		if (refusal !== undefined) return refused(refusal);
		if (reading.kind === "variant") readerKey = reading.key;
	}
	let metadata: IAudioMetadata;
	try {
		metadata = await parseMediaContainer(bytes, mime);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return refused({
			reason: "media-parse-failed",
			message: `Couldn't parse \`${filename}\` as a \`${mime}\` ${kind} stream (${detail}). The file may be truncated or in an unsupported codec.`,
		});
	}
	const verdict =
		readerKey === undefined
			? encodingRefusal(bytes, mime, metadata, filename)
			: { key: readerKey };
	if ("reason" in verdict) return refused(verdict);
	return { ok: true, key: verdict.key, durationMs: durationMsOf(metadata) };
}

/** Why an MP4 is one no CommCare platform plays, or `undefined` for a variant. */
function mp4Refusal(
	reading: ReturnType<typeof readMp4>,
	filename: string,
): { reason: ValidationFailureReason; message: string } | undefined {
	switch (reading.kind) {
		case "variant":
			return undefined;
		case "no-video":
			return {
				reason: "codec-not-accepted",
				message:
					"This MP4 holds sound and no picture. CommCare HQ files it as video, so it could never fill an audio slot. Exporting it again as M4A (AAC) audio fixes that.",
			};
		case "several-videos":
			return {
				reason: "codec-not-accepted",
				message:
					"This MP4 holds more than one video track, and CommCare apps play one. Exporting it again with a single video track fixes that.",
			};
		case "other-track":
			return {
				reason: "codec-not-accepted",
				message: `This MP4 holds a track that is neither video nor sound (${reading.handler}). Exporting it again with only its video and its AAC audio fixes that.`,
			};
		case "codec":
			return codecRefusal(reading.codec, reading.accepted);
		case "unreadable":
			return {
				reason: "media-parse-failed",
				message: `Couldn't read the video of \`${filename}\`: ${reading.detail}. Exporting it again as ${MP4_VIDEO_ADVICE} fixes that.`,
			};
	}
}

/**
 * Does this buffer read as plain UTF-8 text? The `text` kind carries no
 * magic-bytes signature to sniff, so this is its format gate. A NUL byte
 * (never present in real text) is an immediate reject, and the bytes must
 * decode as UTF-8 with no invalid sequence — the `fatal` decoder throws on
 * one. Catches a binary file mislabeled `.txt`/`.md`.
 */
function isUtf8Text(bytes: Buffer): boolean {
	if (bytes.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

/**
 * Wall-clock ceiling for the in-process container parse. music-metadata
 * runs on this event loop (not a child process), so a container
 * engineered to make the box/frame walk pathologically expensive can't
 * be SIGKILL'd from outside the way a subprocess can. The per-kind size
 * cap already bounds the work in MAGNITUDE; this bounds it in TIME, so
 * one hostile confirm can't stall the request indefinitely. The losing
 * parse promise keeps running until it settles on its own — bounded by
 * the size cap — but the caller is freed to reject. A real media file
 * parses in well under this.
 */
const MEDIA_PARSE_TIMEOUT_MS = 10_000;

/**
 * The two ways the timed parse can land: the container finished parsing,
 * or the wall-clock guard fired first. Modeled as a RESOLVABLE sentinel
 * rather than a rejecting `Promise<never>` so the guard side of the race
 * can be SETTLED in `finally` whichever side won — an unsettled guard
 * promise dangles past the call, the permanent-leak shape the async-leak
 * gate exists to catch (clearing the timer alone leaves the promise
 * pending forever).
 */
type ParseOutcome =
	| { kind: "parsed"; metadata: IAudioMetadata }
	| { kind: "timed-out" };

/**
 * Parse an audio/video container in-process with music-metadata — no
 * subprocess, no temp file, no native binary — for the encoding checks and
 * the duration read, which share this one parse. The in-process parser is
 * deliberate: a bundled demuxer binary doesn't survive the Alpine +
 * Next-standalone deploy (it isn't traced into the runtime image and may not
 * be musl-linked), and a native demuxer carries a memory-safety CVE surface
 * on untrusted input that a JS parser avoids.
 *
 * The parse reads container STRUCTURE (atoms / pages / EBML elements) and
 * each track's codec id, not the encoded payload or the AAC object type: a
 * malformed container throws — which the caller maps to a clean rejection —
 * but a structurally-valid file whose stream bytes are otherwise arbitrary
 * still passes. That is the structural-not-semantic guarantee: the format and
 * the codec a track names are verified, the payload isn't decoded; proving
 * the media actually decodes would need a full decode pass we deliberately
 * don't run on the upload path.
 */
async function parseMediaContainer(
	bytes: Buffer,
	sniffedMime: AssetMimeType,
): Promise<IAudioMetadata> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let settleGuard: ((outcome: ParseOutcome) => void) | undefined;
	const guard = new Promise<ParseOutcome>((resolve) => {
		settleGuard = resolve;
		timer = setTimeout(
			() => resolve({ kind: "timed-out" }),
			MEDIA_PARSE_TIMEOUT_MS,
		);
	});
	try {
		// `skipCovers` avoids decoding embedded cover art we never use.
		// We don't force `duration: true` (a full-file scan): the size
		// cap already bounds magnitude, and reading less of an untrusted
		// file is the safer default — header-derivable duration covers
		// the common case, and a missing one is acceptable (`durationMsOf`).
		const outcome = await Promise.race([
			parseBuffer(
				bytes,
				{ mimeType: sniffedMime, size: bytes.length },
				{ skipCovers: true },
			).then<ParseOutcome>((metadata) => ({ kind: "parsed", metadata })),
			guard,
		]);
		if (outcome.kind === "timed-out") {
			throw new Error(
				`took longer than ${MEDIA_PARSE_TIMEOUT_MS / 1000}s to read, the container may be malformed or use a format we can't parse`,
			);
		}
		return outcome.metadata;
	} finally {
		if (timer) clearTimeout(timer);
		// Settle the guard so it can't outlive the call once the race is
		// decided. A no-op if the timer already resolved it.
		settleGuard?.({ kind: "timed-out" });
	}
}

/**
 * A parsed container's duration in ms. BEST-EFFORT and may be absent: a
 * container may not expose duration in its headers. A missing duration is
 * therefore NOT a rejection. The value, when present, is
 * stored as informational metadata that no validation gate reads.
 */
function durationMsOf(metadata: IAudioMetadata): number | undefined {
	const seconds = metadata.format.duration;
	if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
	// The asset schema types `durationMs` as a POSITIVE int. A degenerate
	// 0-duration container — or a sub-millisecond clip that rounds to 0 — is
	// stored as absent rather than a schema-violating 0.
	const ms = Math.round(seconds * 1000);
	return ms > 0 ? ms : undefined;
}

const M4A_BRAND_MESSAGE =
	"This M4A is one CommCare HQ would file as video, so an audio slot would never receive it. Exporting it again as M4A (AAC) audio fixes that.";
const BMP_VARIANT_MESSAGE =
	"This BMP is saved in a way some CommCare apps can't show. Saving it again as a PNG fixes that.";
const ICO_VARIANT_MESSAGE =
	"This ICO holds an image saved in a way some CommCare apps can't show. Saving it again as a PNG fixes that.";

/** The refusal of a file whose audio or video some CommCare apps can't play. */
function codecRefusal(
	codec: string,
	accepted: string,
): { reason: ValidationFailureReason; message: string } {
	return {
		reason: "codec-not-accepted",
		message: `This file's audio or video is encoded in a way some CommCare apps can't play (${codec}). Exporting it again as ${accepted} fixes that.`,
	};
}

type EncodingVerdict =
	| { readonly key: MediaFormatKey }
	| { readonly reason: ValidationFailureReason; readonly message: string };

/**
 * The variant a parsed audio or video file is, or why it is one no CommCare
 * platform plays, for every MIME but WAV and MP4 (whose own readers name
 * theirs), AMR and MIDI (which music-metadata does not parse). The container
 * and codec spellings are music-metadata's, as version 12.2.0 reports them:
 * `MPEG`; `FLAC`; `M4A/isom/iso2` or `M4B/isom/iso2` with `MPEG-4/AAC` or
 * `ALAC`; `Ogg` with `Vorbis I`, `Opus`, `Speex 1.2.1` or `FLAC`;
 * `ADTS/MPEG-4` or `ADTS/MPEG-2` with `AAC`; `EBML/webm` or `EBML/matroska`
 * with `VP8`, `VP9`, `AV1`, `VORBIS`, `OPUS`.
 */
function encodingRefusal(
	bytes: Buffer,
	mime: AssetMimeType,
	metadata: IAudioMetadata,
	filename: string,
): EncodingVerdict {
	const { container = "", codec = "" } = metadata.format;
	const tracks = metadata.format.trackInfo;
	switch (mime) {
		case "audio/mpeg":
			return { key: "mp3" };
		case "audio/mp4": {
			// The `ftyp` major brand, read from the bytes themselves: HQ files an
			// MP4 as audio only for `M4A ` or `M4B `.
			const brand =
				bytes.toString("latin1", 4, 8) === "ftyp"
					? bytes.toString("latin1", 8, 12)
					: "";
			if (brand !== "M4A " && brand !== "M4B ") {
				return {
					reason: "container-brand-not-accepted",
					message: M4A_BRAND_MESSAGE,
				};
			}
			// music-metadata gives a track `audio` only when its sample entry
			// carries a sample rate, so a video, chapter or text track has none.
			const audio = tracks.filter((track) => track.audio !== undefined);
			if (audio.length === 0) {
				return {
					reason: "codec-not-accepted",
					message:
						"This M4A holds no audio track Nova can find. Exporting it again as M4A (AAC) audio fixes that.",
				};
			}
			if (tracks.length !== 1) {
				return {
					reason: "codec-not-accepted",
					message:
						"This M4A holds more than its one audio track. Exporting it again as audio only fixes that.",
				};
			}
			const trackCodec = audio[0]?.codecName ?? codec;
			if (trackCodec !== "MPEG-4/AAC") {
				return codecRefusal(
					trackCodec === "ALAC" ? "Apple Lossless" : trackCodec || "unnamed",
					"M4A with AAC audio",
				);
			}
			return { key: "m4a" };
		}
		case "audio/flac":
			return container === "FLAC"
				? { key: "flac" }
				: codecRefusal(container || "unnamed", "a FLAC file");
		case "audio/ogg": {
			if (container === "Ogg" && codec.startsWith("Vorbis")) {
				return { key: "ogg-vorbis" };
			}
			if (container === "Ogg" && codec === "Opus") return { key: "ogg-opus" };
			if (codec === "FLAC") {
				return codecRefusal(
					"FLAC inside Ogg",
					"a FLAC file, or Ogg with Vorbis or Opus audio",
				);
			}
			return codecRefusal(
				codec.startsWith("Speex") ? "Speex" : codec || "unnamed",
				"Ogg with Vorbis or Opus audio",
			);
		}
		case "audio/aac":
			// The AAC object type is not read, for ADTS as for M4A.
			return container.startsWith("ADTS/") && codec === "AAC"
				? { key: "aac-adts" }
				: codecRefusal(
						codec || container || "unnamed",
						"AAC (ADTS) or M4A (AAC) audio",
					);
		case "video/webm":
			return matroskaRefusal(bytes, container, tracks, filename, "webm");
		case "video/x-matroska":
			return matroskaRefusal(bytes, container, tracks, filename, "mkv");
		default:
			throw new Error(
				`The upload gate parsed a ${mime} file with no variant to name. Each audio and video MIME in ACCEPTED_FORMATS needs its MEDIA_FORMATS key in encodingRefusal or a reader of its own.`,
			);
	}
}

/**
 * The variant a WebM or MKV file is, or why it is one no CommCare platform
 * plays. Both take the same track rules: one VP8 or VP9 profile 0 video
 * track and Vorbis or Opus audio or none, the codecs Android pairs with
 * Matroska; the container is `EBML/webm` for a WebM and `EBML/matroska` for
 * an MKV.
 */
function matroskaRefusal(
	bytes: Buffer,
	container: string,
	tracks: IAudioMetadata["format"]["trackInfo"],
	filename: string,
	family: "webm" | "mkv",
): EncodingVerdict {
	const noun = family === "webm" ? "WebM" : "MKV";
	const expected = family === "webm" ? "EBML/webm" : "EBML/matroska";
	if (container !== expected) {
		return codecRefusal(
			container || "unnamed",
			family === "webm" ? "a WebM file" : "an MKV file",
		);
	}
	const video = tracks.filter((track) => track.video !== undefined);
	const audio = tracks.filter((track) => track.audio !== undefined);
	// A subtitle, button or metadata track is one no reader decoded during
	// planning, so the file it rides in is not one a platform played.
	const other = tracks.find(
		(track) => track.video === undefined && track.audio === undefined,
	);
	if (video.length === 0) {
		return {
			reason: "codec-not-accepted",
			message: `This ${noun} holds sound and no picture. CommCare HQ files every ${noun} as video, so it could never fill an audio slot. Exporting it again as Ogg audio (Vorbis or Opus) fixes that.`,
		};
	}
	if (video.length > 1) {
		return {
			reason: "codec-not-accepted",
			message: `This ${noun} holds more than one video track, and CommCare apps play one. Exporting it again with a single video track fixes that.`,
		};
	}
	if (other !== undefined) {
		return {
			reason: "codec-not-accepted",
			message: `This ${noun} holds a track that is neither video nor sound (${other.codecName || "unnamed"}). Exporting it again with only its video and its Vorbis or Opus audio fixes that.`,
		};
	}
	for (const track of audio) {
		if (track.codecName !== "VORBIS" && track.codecName !== "OPUS") {
			return codecRefusal(
				track.codecName || "unnamed",
				`${noun} with Vorbis or Opus audio, or with none`,
			);
		}
	}
	const videoCodec = video[0]?.codecName ?? "";
	const vp8 = family === "webm" ? "webm-vp8" : "mkv";
	const vp9 = family === "webm" ? "webm-vp9" : "mkv";
	if (videoCodec === "VP8") return { key: vp8 };
	if (videoCodec !== "VP9") {
		if (family === "mkv" && videoCodec === "MPEG4/ISO/AVC") {
			return codecRefusal("H.264 in MKV", MP4_VIDEO_ADVICE);
		}
		return codecRefusal(
			videoCodec || "unnamed",
			`${noun} with VP8 video, or VP9 in 8-bit 4:2:0 color`,
		);
	}
	const profile = readVp9Profile(bytes);
	if (profile.kind === "unreadable") {
		return {
			reason: "media-parse-failed",
			message: `Couldn't read the VP9 video of \`${filename}\`: ${profile.detail}. Exporting it again as ${noun} with VP8 video, or VP9 in 8-bit 4:2:0 color, fixes that.`,
		};
	}
	if (profile.profile !== 0) {
		return codecRefusal(
			"VP9 in 4:4:4 or 10-bit color",
			"VP8, or VP9 in 8-bit 4:2:0 color (ffmpeg's -pix_fmt yuv420p)",
		);
	}
	return { key: vp9 };
}
