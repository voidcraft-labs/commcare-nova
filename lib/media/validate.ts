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
 *      Nova's own header reader for BMP, `bmp.ts`) and audio/video
 *      (music-metadata, plus `webm.ts` for a VP9 profile), each holding
 *      the format to the variant every CommCare platform plays
 *      (`lib/domain/multimedia.ts::ACCEPTED_FORMATS`). pdf/docx/xlsx are
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
	mimeTypeForExtension,
	normalizeMimeType,
} from "@/lib/domain/multimedia";
import { readBmp } from "./bmp";
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
	| "bmp-variant-not-accepted";

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

	// Stage 1: extension whitelist. Reject obvious off-list filenames
	// before spending a magic-bytes sniff. The extension match is
	// case-insensitive (`Foo.PNG` is fine).
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
		if (sniffedMime === "image/bmp") {
			const reading = readBmp(bytes);
			if (reading.kind === "variant") {
				return {
					ok: false,
					reason: "bmp-variant-not-accepted",
					message: BMP_VARIANT_MESSAGE,
				};
			}
			if (reading.kind === "malformed") {
				return {
					ok: false,
					reason: "image-parse-failed",
					message: `Couldn't read \`${args.originalFilename}\` as a BMP image: ${reading.detail}. The file may be truncated or malformed. Try re-exporting from the source.`,
				};
			}
			dimensions = { width: reading.width, height: reading.height };
		} else if (claimedKind === "image") {
			try {
				const meta = await sharp(bytes).metadata();
				if (!meta.width || !meta.height) {
					return {
						ok: false,
						reason: "image-parse-failed",
						message: `\`${args.originalFilename}\` parsed as a \`${sniffedMime}\` image but has no readable dimensions. The file may be truncated or malformed. Try re-exporting from the source.`,
					};
				}
				dimensions = { width: meta.width, height: meta.height };
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				return {
					ok: false,
					reason: "image-parse-failed",
					message: `Couldn't parse \`${args.originalFilename}\` as a \`${sniffedMime}\` image (${detail}). The file may be truncated or malformed.`,
				};
			}
		} else if (claimedKind === "audio" || claimedKind === "video") {
			let metadata: IAudioMetadata;
			try {
				metadata = await parseMediaContainer(bytes, sniffedMime);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				return {
					ok: false,
					reason: "media-parse-failed",
					message: `Couldn't parse \`${args.originalFilename}\` as a \`${sniffedMime}\` ${claimedKind} stream (${detail}). The file may be truncated or in an unsupported codec.`,
				};
			}
			const refusal = encodingRefusal(
				bytes,
				sniffedMime,
				metadata,
				args.originalFilename,
			);
			if (refusal !== undefined) return { ok: false, ...refusal };
			durationMs = durationMsOf(metadata);
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
		},
	};
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
 * video-only mp4 (no audio track) parses cleanly but exposes no duration. A
 * missing duration is therefore NOT a rejection. The value, when present, is
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

/**
 * Why a parsed audio or video file is encoded in a variant some CommCare
 * platform does not play, or `undefined` when it is one every platform
 * played (`lib/commcare/surface/media-formats.json`, `executions`). The
 * container and codec spellings are music-metadata's, as version 12.0.0
 * reports them: `FLAC`; `M4A/isom/iso2` or `M4B/isom/iso2` with `MPEG-4/AAC`
 * or `ALAC`; `Ogg` with `Vorbis I`, `Opus`, `Speex 1.2.1` or `FLAC`;
 * `EBML/webm` with `VP8`, `VP9`, `AV1`, `VORBIS`, `OPUS`. MP3, WAV and MP4
 * have no check here: step 2 checks no MP4 codec and no WAV encoding.
 */
function encodingRefusal(
	bytes: Buffer,
	mime: AssetMimeType,
	metadata: IAudioMetadata,
	filename: string,
): { reason: ValidationFailureReason; message: string } | undefined {
	const { container = "", codec = "" } = metadata.format;
	const tracks = metadata.format.trackInfo;
	switch (mime) {
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
			return undefined;
		}
		case "audio/flac":
			return container === "FLAC"
				? undefined
				: codecRefusal(container || "unnamed", "a FLAC file");
		case "audio/ogg": {
			if (
				container === "Ogg" &&
				(codec.startsWith("Vorbis") || codec === "Opus")
			) {
				return undefined;
			}
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
		case "video/webm":
			return webmRefusal(bytes, container, tracks, filename);
		default:
			return undefined;
	}
}

/** Why a WebM file is one some CommCare platform does not play, or `undefined`. */
function webmRefusal(
	bytes: Buffer,
	container: string,
	tracks: IAudioMetadata["format"]["trackInfo"],
	filename: string,
): { reason: ValidationFailureReason; message: string } | undefined {
	if (container !== "EBML/webm") {
		return codecRefusal(container || "unnamed", "a WebM file");
	}
	const video = tracks.filter((track) => track.video !== undefined);
	const audio = tracks.filter((track) => track.audio !== undefined);
	// A subtitle, button or metadata track is one no reader decoded during
	// planning, so the WebM it rides in is not one every platform played.
	const other = tracks.find(
		(track) => track.video === undefined && track.audio === undefined,
	);
	if (video.length === 0) {
		return {
			reason: "codec-not-accepted",
			message:
				"This WebM holds sound and no picture. CommCare HQ files every WebM as video, so it could never fill an audio slot. Exporting it again as Ogg audio (Vorbis or Opus) fixes that.",
		};
	}
	if (video.length > 1) {
		return {
			reason: "codec-not-accepted",
			message:
				"This WebM holds more than one video track, and CommCare apps play one. Exporting it again with a single video track fixes that.",
		};
	}
	if (other !== undefined) {
		return {
			reason: "codec-not-accepted",
			message: `This WebM holds a track that is neither video nor sound (${other.codecName || "unnamed"}). Exporting it again with only its video and its Vorbis or Opus audio fixes that.`,
		};
	}
	for (const track of audio) {
		if (track.codecName !== "VORBIS" && track.codecName !== "OPUS") {
			return codecRefusal(
				track.codecName || "unnamed",
				"WebM with Vorbis or Opus audio, or with none",
			);
		}
	}
	const videoCodec = video[0]?.codecName ?? "";
	if (videoCodec === "VP8") return undefined;
	if (videoCodec !== "VP9") {
		return codecRefusal(
			videoCodec || "unnamed",
			"WebM with VP8 video, or VP9 in 8-bit 4:2:0 color",
		);
	}
	const profile = readVp9Profile(bytes);
	if (profile.kind === "unreadable") {
		return {
			reason: "media-parse-failed",
			message: `Couldn't read the VP9 video of \`${filename}\`: ${profile.detail}. Exporting it again as WebM with VP8 video, or VP9 in 8-bit 4:2:0 color, fixes that.`,
		};
	}
	if (profile.profile !== 0) {
		return codecRefusal(
			"VP9 in 4:4:4 or 10-bit color",
			"VP8, or VP9 in 8-bit 4:2:0 color (ffmpeg's -pix_fmt yuv420p)",
		);
	}
	return undefined;
}
