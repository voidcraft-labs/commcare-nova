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
 *   3. Magic-bytes sniff (file-type)
 *   4. Library re-parse (sharp for images, ffprobe for audio/video)
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

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import {
	ALL_MIME_TYPES,
	type AssetMimeType,
	EXTENSION_FOR_MIME_TYPE,
	MEDIA_SIZE_CAPS_BYTES,
	type MediaKind,
	mediaKindForMimeType,
	normalizeMimeType,
} from "@/lib/domain/multimedia";

/**
 * Extensions the upload pre-screen accepts. The post-sniff
 * authoritative extension comes from `EXTENSION_FOR_MIME_TYPE`;
 * this list exists to reject obvious off-list filenames before
 * spending a magic-bytes sniff on them.
 *
 * SVG is deliberately absent — it's a script container with active
 * content surface, and the CommCare renderer doesn't display it
 * usefully on the wire side either way.
 */
export const ACCEPTED_EXTENSIONS = [
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".mp3",
	".m4a",
	".mp4",
	".wav",
	".ogg",
] as const;
export type AcceptedExtension = (typeof ACCEPTED_EXTENSIONS)[number];

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
	kind: MediaKind;
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
	| "claimed-size-mismatch";

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

	// MIME-claim membership is checked BEFORE the size cap so we can
	// pick the right per-kind cap. The claim is normalized first so
	// an alias spelling (a browser sending `audio/x-m4a` for a `.m4a`)
	// reconciles to its canonical form; a claim that doesn't normalize
	// to an accepted type is rejected here.
	const normalizedClaim = normalizeMimeType(claimedMimeType);
	if (!normalizedClaim) {
		return {
			ok: false,
			reason: "mime-claim-mismatch",
			message: `Tried to upload \`${args.originalFilename}\` with MIME type \`${claimedMimeType}\`, but that type isn't accepted. Accepted types are ${ALL_MIME_TYPES.join(", ")}. The file may be in an unsupported format.`,
		};
	}
	const claimedKind = mediaKindForMimeType(normalizedClaim);
	// claimedKind is non-undefined here because `normalizeMimeType`
	// only returns members of ALL_MIME_TYPES, all of which the kind
	// partition covers; the guard satisfies the compiler and surfaces
	// a clear bug message if a MIME is ever added to ALL_MIME_TYPES
	// but not to the kind partition.
	if (!claimedKind) {
		return {
			ok: false,
			reason: "mime-claim-mismatch",
			message: `Compiler bug: MIME type \`${normalizedClaim}\` is in ALL_MIME_TYPES but not partitioned into a kind. Report this — the kind partition in lib/domain/multimedia.ts is incomplete.`,
		};
	}

	const cap = MEDIA_SIZE_CAPS_BYTES[claimedKind];
	if (bytes.length > cap) {
		const capMb = (cap / 1024 / 1024).toFixed(0);
		const actualMb = (bytes.length / 1024 / 1024).toFixed(2);
		return {
			ok: false,
			reason: "size-cap-exceeded",
			message: `\`${args.originalFilename}\` is ${actualMb} MB, but ${claimedKind} uploads are capped at ${capMb} MB. Compress the file (image: re-export at lower quality; audio: re-encode at a lower bitrate; video: shorter clip or smaller resolution) and try again.`,
		};
	}

	// Stage 3: magic-bytes sniff. `file-type` reads the first ~262
	// bytes to identify the format from its container signature. A
	// `.png` extension on bytes that don't carry a PNG magic number
	// is rejected here — that's the primary defense against type
	// spoofing.
	const sniffed = await fileTypeFromBuffer(bytes);
	if (!sniffed) {
		return {
			ok: false,
			reason: "magic-bytes-sniff-failed",
			message: `Couldn't identify the format of \`${args.originalFilename}\` from its bytes. The file may be empty, corrupted, or in a format we don't recognize. Try re-exporting from its original source.`,
		};
	}
	// Normalize the sniff before comparing — `file-type` reports some
	// formats under alias spellings (`audio/x-m4a` for M4A,
	// `audio/ogg; codecs=opus` for Opus) that name an accepted format
	// under a non-canonical string.
	const sniffedMime = normalizeMimeType(sniffed.mime);
	if (!sniffedMime) {
		return {
			ok: false,
			reason: "magic-bytes-sniff-failed",
			message: `\`${args.originalFilename}\` looks like a \`${sniffed.mime}\` file, which isn't an accepted media type. Accepted: ${ALL_MIME_TYPES.join(", ")}.`,
		};
	}

	if (sniffedMime !== normalizedClaim) {
		return {
			ok: false,
			reason: "mime-claim-mismatch",
			message: `\`${args.originalFilename}\` claims to be \`${normalizedClaim}\` but the bytes are actually \`${sniffedMime}\`. This usually means the file was renamed without re-encoding. Either rename it to match its real format or re-export it as \`${normalizedClaim}\`.`,
		};
	}

	const canonicalExtension = EXTENSION_FOR_MIME_TYPE[sniffedMime];
	// The pre-screen extension and the post-sniff canonical extension
	// can legitimately differ for one pair: `.jpg` and `.jpeg` both
	// map to `image/jpeg`. Accept the family match (both extensions
	// are valid for the same canonical MIME); reject everything else.
	const sameJpegFamily =
		canonicalExtension === ".jpg" &&
		(declaredExt === ".jpg" || declaredExt === ".jpeg");
	if (!sameJpegFamily && declaredExt !== canonicalExtension) {
		return {
			ok: false,
			reason: "extension-mime-mismatch",
			message: `\`${args.originalFilename}\` has extension \`${declaredExt}\` but its bytes are \`${sniffedMime}\` (which we'd expect to end in \`${canonicalExtension}\`). Rename the file to match the format, or re-export to the format the extension suggests.`,
		};
	}

	// Stage 4: library re-parse. For images, `sharp` opens the bytes
	// and reads metadata — failure here means the magic-bytes
	// matched but the body is truncated or malformed. For audio/
	// video, ffprobe demuxes the container. Both raise on parse
	// failure; we map that to a clean rejection.
	let dimensions: { width: number; height: number } | undefined;
	let durationMs: number | undefined;

	if (claimedKind === "image") {
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
	} else {
		try {
			durationMs = await probeDurationMs(bytes, canonicalExtension);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				reason: "media-parse-failed",
				message: `Couldn't parse \`${args.originalFilename}\` as a \`${sniffedMime}\` ${claimedKind} stream (${detail}). The file may be truncated or in an unsupported codec.`,
			};
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
 * Demux an audio/video container to read its duration (ms). ffprobe
 * reads a file path, not a buffer, so we write the bytes to a tmp
 * file scoped to the os tmpdir and delete it after the probe. The
 * cost is one fs write per upload — acceptable for an interactive
 * flow; not in the hot read path.
 *
 * The temp filename is built from a fresh random id + the canonical
 * extension only — never from the client's original filename. Two
 * reasons:
 *
 *  - The original filename is unconstrained beyond its extension
 *    suffix, so interpolating it into `join(tmpdir(), ...)` would
 *    let a `../`-laden filename escape the temp directory and have
 *    us write attacker-controlled bytes to an attacker-influenced
 *    path.
 *  - A per-call random id (not the content hash) keeps two
 *    concurrent probes of the *same bytes* — a confirm retry, two
 *    tabs — from colliding on one temp path and racing each other's
 *    write / probe / unlink. A content-hash path would be identical
 *    across those calls precisely because the bytes are identical.
 *
 * The canonical extension is still appended so ffprobe's
 * extension-based format hinting works.
 */
async function probeDurationMs(
	bytes: Buffer,
	canonicalExtension: string,
): Promise<number> {
	const { tmpdir } = await import("node:os");
	const { writeFile, unlink } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const tmpPath = join(
		tmpdir(),
		`nova-media-probe-${randomUUID()}${canonicalExtension}`,
	);
	await writeFile(tmpPath, bytes);
	try {
		const seconds = await probeDurationSeconds(tmpPath);
		if (!Number.isFinite(seconds)) {
			throw new Error(
				"ffprobe returned no duration — the container may be malformed or use a format we can't demux",
			);
		}
		return Math.round(seconds * 1000);
	} finally {
		await unlink(tmpPath).catch(() => {
			/* best-effort cleanup; tmpdir GC handles stragglers */
		});
	}
}

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Spawn ffprobe directly (not through fluent-ffmpeg's static helper)
 * so we hold the `ChildProcess` handle and can SIGKILL it on
 * timeout. The static `ffmpeg.ffprobe(path, cb)` form returns no
 * handle, so a hanging probe — exactly the pathological-container
 * case the timeout defends against — would keep the child alive past
 * the request: a dangling process is the open-handle class the
 * pre-push async-leak gate exists to catch. Killing the child closes
 * that gap. The timer is cleared on settle so it never outlives the
 * call, and `settled` guards against the timeout and the close event
 * both trying to settle the promise.
 *
 * Returns the container duration in seconds (ffprobe's
 * `format.duration`).
 */
function probeDurationSeconds(tmpPath: string): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const child = spawn(ffprobeInstaller.path, [
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"json",
			tmpPath,
		]);
		let settled = false;
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			settled = true;
			child.kill("SIGKILL");
			reject(
				new Error(
					`ffprobe didn't return within ${PROBE_TIMEOUT_MS / 1000}s — the container may be malformed or use a format we can't demux`,
				),
			);
		}, PROBE_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code !== 0) {
				reject(
					new Error(
						`ffprobe exited with code ${code} — the container may be malformed or use a format we can't demux${stderr ? ` (${stderr.trim()})` : ""}`,
					),
				);
				return;
			}
			try {
				const parsed = JSON.parse(stdout) as {
					format?: { duration?: string | number };
				};
				resolve(Number(parsed.format?.duration));
			} catch {
				reject(
					new Error(
						"ffprobe output couldn't be parsed — the container may be malformed or use a format we can't demux",
					),
				);
			}
		});
	});
}
