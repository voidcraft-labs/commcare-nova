/**
 * Coverage for the validation pipeline. Real bytes flow through
 * every stage:
 *
 *   - sharp generates a tiny PNG so the magic-bytes sniff,
 *     sharp re-parse, and dimensions branch all execute against a
 *     real image.
 *   - A synthesized PCM WAV and a checked-in video-only mp4 fixture
 *     drive the audio/video branch through music-metadata — the path
 *     that had no real-media coverage before, so a broken probe (a
 *     missing binary, a wrong contract) shipped silently.
 *   - Hand-crafted byte arrays simulate magic-mismatch + truncation
 *     rejection paths.
 *
 * No GCS, no Postgres, no HTTP — the pipeline takes a `Buffer`
 * and returns a `ValidationResult`.
 *
 * The audio, video and 8-, 16-, 24- and 32-bit BMP files under `fixtures/`
 * were made once with ffmpeg 7.1.1, from a one-second 440 Hz tone
 * (`T` = `-f lavfi -i sine=frequency=440:duration=1`) and a 64 by 64 test
 * pattern (`V` = `-f lavfi -i testsrc=size=64x64:rate=10:duration=1`), each
 * written with `-fflags +bitexact -flags:a +bitexact -flags:v +bitexact
 * -map_metadata -1`:
 *
 *   tone.m4a                   T -c:a aac -f ipod
 *   tone-m4b.m4a               T -c:a aac -f ipod -brand 'M4B '
 *   tone.flac                  T -c:a flac
 *   tone-vorbis.ogg            T -c:a libvorbis
 *   tone-opus.ogg              T -c:a libopus
 *   pattern-vp8.webm           V -c:v libvpx -f webm
 *   pattern-vp8-vorbis.webm    V T -c:v libvpx -c:a libvorbis -f webm
 *   pattern-vp9.webm           V -c:v libvpx-vp9 -pix_fmt yuv420p -f webm
 *   pattern-vp9-opus.webm      V T -c:v libvpx-vp9 -pix_fmt yuv420p -c:a libopus -f webm
 *   tone-isom.m4a              T -c:a aac -f mp4
 *   tone-alac.m4a              T -c:a alac -f ipod
 *   tone-speex.ogg             T -c:a libspeex
 *   tone-flac.ogg              T -c:a flac -f ogg
 *   pattern-av1.webm           V -c:v libaom-av1 -f webm
 *   pattern-vp9-profile1.webm  V -c:v libvpx-vp9 -f webm
 *   pattern-vp9-profile2.webm  V -c:v libvpx-vp9 -pix_fmt yuv420p10le -f webm
 *   tone.webm                  T -c:a libopus -f webm
 *   pattern-matroska.webm      V -c:v libvpx -f matroska
 *   tone-chapters.m4a          T -i chapters.txt -map 0 -map_chapters 1 -c:a aac -f mp4 -brand 'M4A '
 *                              (without `-map_metadata -1`, which drops the chapters;
 *                              chapters.txt is an FFMETADATA1 file of one chapter, 0 to 1000 ms)
 *   pattern-h264.m4a           V -c:v libx264 -f ipod -brand 'M4A '
 *   pattern-vp8-subtitles.webm V -i subtitles.vtt -map 0 -map 1 -c:v libvpx -c:s webvtt -f webm
 *                              (subtitles.vtt holds one cue, 0 to 1 s)
 *   pattern-8.bmp              V -frames:v 1 -pix_fmt pal8
 *   pattern-16.bmp             V -frames:v 1 -pix_fmt rgb555le
 *   pattern-24.bmp             V -frames:v 1 -pix_fmt bgr24
 *   pattern-32.bmp             V -frames:v 1 -pix_fmt bgra
 *
 * The BMP files ffmpeg does not write come from `bmpFixtures.ts`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { ASSET_SIZE_CAPS_BYTES } from "@/lib/domain/multimedia";
import { validateMediaBytes } from "../validate";
import { BUILT_BMPS, bmpV4Srgb24 } from "./bmpFixtures";

/** A committed fixture's bytes. */
function fixture(name: string): Buffer {
	return readFileSync(join(import.meta.dirname, "fixtures", name));
}

/** Validate bytes as a browser that sent no usable type would upload them. */
function validateNamed(bytes: Buffer, filename: string, claimedMimeType = "") {
	return validateMediaBytes({
		bytes,
		claimedMimeType,
		claimedSizeBytes: bytes.length,
		originalFilename: filename,
	});
}

/**
 * Produce a deterministic 8×13 PNG via sharp. Tests reuse this so
 * the pipeline runs against bytes that pass the magic-bytes sniff,
 * parse cleanly through sharp, and have known dimensions.
 */
async function makeTinyPng(): Promise<Buffer> {
	return sharp({
		create: {
			width: 8,
			height: 13,
			channels: 3,
			background: { r: 12, g: 34, b: 56 },
		},
	})
		.png()
		.toBuffer();
}

let tinyPng: Buffer;
beforeAll(async () => {
	tinyPng = await makeTinyPng();
});

/**
 * Synthesize a minimal valid PCM WAV in-process — no encoder, no
 * checked-in fixture. 8 kHz mono 16-bit, 0.1 s of silence (800
 * samples). `file-type` sniffs the `RIFF…WAVE` signature as audio/wav
 * and music-metadata derives 0.1 s from the data-chunk size, so this
 * drives the real audio branch end to end with a known duration.
 */
function makeTinyWav(): Buffer {
	const sampleRate = 8000;
	const numChannels = 1;
	const bitsPerSample = 16;
	const numSamples = 800; // 0.1 s
	const blockAlign = (numChannels * bitsPerSample) / 8;
	const byteRate = sampleRate * blockAlign;
	const dataSize = numSamples * blockAlign;
	const buf = Buffer.alloc(44 + dataSize);
	buf.write("RIFF", 0, "ascii");
	buf.writeUInt32LE(36 + dataSize, 4);
	buf.write("WAVE", 8, "ascii");
	buf.write("fmt ", 12, "ascii");
	buf.writeUInt32LE(16, 16); // PCM fmt-chunk size
	buf.writeUInt16LE(1, 20); // audioFormat = PCM
	buf.writeUInt16LE(numChannels, 22);
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(byteRate, 28);
	buf.writeUInt16LE(blockAlign, 32);
	buf.writeUInt16LE(bitsPerSample, 34);
	buf.write("data", 36, "ascii");
	buf.writeUInt32LE(dataSize, 40);
	// Data stays zero-filled (silence): the bytes parse cleanly; their
	// content is irrelevant to the duration the header declares.
	return buf;
}

describe("validateMediaBytes — happy path", () => {
	it("validates a real PNG end-to-end", async () => {
		const bytes = tinyPng;
		const result = await validateMediaBytes({
			bytes,
			claimedMimeType: "image/png",
			claimedSizeBytes: bytes.length,
			originalFilename: "Logo.PNG",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.validated.mimeType).toBe("image/png");
			expect(result.validated.extension).toBe(".png");
			expect(result.validated.kind).toBe("image");
			expect(result.validated.dimensions).toEqual({ width: 8, height: 13 });
			expect(result.validated.contentHash).toBe(
				createHash("sha256").update(bytes).digest("hex"),
			);
			expect(result.validated.sizeBytes).toBe(bytes.length);
		}
	});

	it("accepts `.jpg` and `.jpeg` for the same JPEG bytes", async () => {
		const bytes = await sharp({
			create: {
				width: 4,
				height: 4,
				channels: 3,
				background: { r: 200, g: 200, b: 200 },
			},
		})
			.jpeg()
			.toBuffer();

		for (const filename of ["pic.jpg", "pic.jpeg"]) {
			const result = await validateMediaBytes({
				bytes,
				claimedMimeType: "image/jpeg",
				claimedSizeBytes: bytes.length,
				originalFilename: filename,
			});
			expect(result.ok).toBe(true);
		}
	});

	it("verifies the client's hash claim when supplied", async () => {
		const bytes = tinyPng;
		const expectedHash = createHash("sha256").update(bytes).digest("hex");
		const result = await validateMediaBytes({
			bytes,
			claimedMimeType: "image/png",
			claimedSizeBytes: bytes.length,
			claimedContentHash: expectedHash,
			originalFilename: "logo.png",
		});
		expect(result.ok).toBe(true);
	});

	it("accepts identical UTF-8 bytes as txt or markdown with one content hash", async () => {
		const bytes = Buffer.from(
			"# Shared requirements\n\nCollect a name: Jos\u00e9 \u65e5\u672c.",
		);
		const plain = await validateMediaBytes({
			bytes,
			claimedMimeType: "text/plain",
			claimedSizeBytes: bytes.length,
			originalFilename: "requirements.txt",
		});
		const markdown = await validateMediaBytes({
			bytes,
			claimedMimeType: "text/markdown",
			claimedSizeBytes: bytes.length,
			originalFilename: "requirements.md",
		});

		expect(plain.ok).toBe(true);
		expect(markdown.ok).toBe(true);
		if (plain.ok && markdown.ok) {
			expect(plain.validated.extension).toBe(".txt");
			expect(markdown.validated.extension).toBe(".md");
			expect(plain.validated.contentHash).toBe(markdown.validated.contentHash);
		}
	});
});

describe("validateMediaBytes — rejection paths", () => {
	it.each([
		{ name: "invalid UTF-8", bytes: Buffer.from([0xc3, 0x28]) },
		{
			name: "NUL in otherwise valid text",
			bytes: Buffer.from("before\0after"),
		},
	])("rejects $name in text uploads", async ({ bytes }) => {
		await expect(
			validateMediaBytes({
				bytes,
				claimedMimeType: "text/plain",
				claimedSizeBytes: bytes.length,
				originalFilename: "document.txt",
			}),
		).resolves.toMatchObject({ ok: false, reason: "text-not-utf8" });
	});
	it("rejects an unaccepted file extension before reading bytes", async () => {
		const result = await validateMediaBytes({
			bytes: Buffer.from([0x00, 0x00]),
			claimedMimeType: "image/png",
			claimedSizeBytes: 2,
			originalFilename: "malware.exe",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("extension-not-accepted");
		}
	});

	it("rejects SVG explicitly (the extension whitelist excludes it)", async () => {
		const svg = Buffer.from('<?xml version="1.0"?><svg/>');
		const result = await validateMediaBytes({
			bytes: svg,
			claimedMimeType: "image/png",
			claimedSizeBytes: svg.length,
			originalFilename: "bad.svg",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("extension-not-accepted");
		}
	});

	it("rejects an oversized image", async () => {
		// Cross the actual image byte boundary by exactly one byte.
		const bytes = Buffer.alloc(ASSET_SIZE_CAPS_BYTES.image + 1);
		const result = await validateMediaBytes({
			bytes,
			claimedMimeType: "image/png",
			claimedSizeBytes: bytes.length,
			originalFilename: "big.png",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("size-cap-exceeded");
		}
	});

	it("rejects when actual byte length disagrees with the claim", async () => {
		const bytes = tinyPng;
		const result = await validateMediaBytes({
			bytes,
			claimedMimeType: "image/png",
			claimedSizeBytes: bytes.length + 100,
			originalFilename: "logo.png",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("claimed-size-mismatch");
		}
	});

	it("rejects a document MIME claim for image bytes", async () => {
		const bytes = tinyPng;
		const result = await validateMediaBytes({
			bytes,
			claimedMimeType: "application/pdf",
			claimedSizeBytes: bytes.length,
			originalFilename: "logo.png",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("mime-claim-mismatch");
		}
	});

	it("rejects a MIME spoof (PNG bytes claimed as JPEG)", async () => {
		const pngBytes = tinyPng;
		const result = await validateMediaBytes({
			bytes: pngBytes,
			claimedMimeType: "image/jpeg",
			claimedSizeBytes: pngBytes.length,
			originalFilename: "photo.jpg",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("mime-claim-mismatch");
		}
	});

	it("rejects a hash mismatch when the client's claim is supplied", async () => {
		const bytes = tinyPng;
		const result = await validateMediaBytes({
			bytes,
			claimedMimeType: "image/png",
			claimedSizeBytes: bytes.length,
			// Pre-computed for some OTHER bytes — the validator must catch.
			claimedContentHash: "0".repeat(64),
			originalFilename: "logo.png",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("hash-claim-mismatch");
		}
	});

	it("rejects bytes that don't sniff as any known format", async () => {
		// Random bytes with no signature — file-type returns undefined.
		const bytes = Buffer.from([0x42, 0x43, 0x44, 0x45]);
		const result = await validateMediaBytes({
			bytes,
			claimedMimeType: "image/png",
			claimedSizeBytes: bytes.length,
			originalFilename: "mystery.png",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("magic-bytes-sniff-failed");
		}
	});

	it("rejects bytes where the extension and the sniffed MIME disagree", async () => {
		const pngBytes = tinyPng;
		const result = await validateMediaBytes({
			bytes: pngBytes,
			claimedMimeType: "image/png",
			claimedSizeBytes: pngBytes.length,
			// Name claims gif, bytes are png — extension/MIME mismatch.
			// Pre-screen accepts `.gif`; sniff returns image/png;
			// claim says image/png — the claim matches sniff but the
			// declared extension is wrong, which the extension-vs-sniff
			// check catches.
			originalFilename: "logo.gif",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("extension-mime-mismatch");
		}
	});
});

describe("validateMediaBytes — sharp parse failure", () => {
	it("rejects PNG-headered bytes whose body sharp can't parse", async () => {
		// PNG magic header followed by garbage. file-type will sniff
		// as image/png; sharp will fail on the malformed body.
		const pngHeader = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		// An IDAT marker is enough for the sniffer, but the missing IHDR
		// makes the image body invalid to sharp. Prove we reached that gate.
		const bytes = Buffer.concat([
			pngHeader,
			Buffer.from([0, 0, 0, 0]),
			Buffer.from("IDAT"),
			Buffer.alloc(4),
		]);
		expect(await fileTypeFromBuffer(bytes)).toMatchObject({
			mime: "image/png",
		});
		const result = await validateMediaBytes({
			bytes,
			claimedMimeType: "image/png",
			claimedSizeBytes: bytes.length,
			originalFilename: "broken.png",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("image-parse-failed");
		}
	});
});

describe("validateMediaBytes — audio & video (music-metadata)", () => {
	it("validates a real WAV and reads its duration", async () => {
		const bytes = makeTinyWav();
		const result = await validateMediaBytes({
			bytes,
			claimedMimeType: "audio/wav",
			claimedSizeBytes: bytes.length,
			originalFilename: "clip.wav",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.validated.kind).toBe("audio");
			expect(result.validated.mimeType).toBe("audio/wav");
			expect(result.validated.extension).toBe(".wav");
			// 800 samples at 8 kHz is exactly 100 ms.
			expect(result.validated.durationMs).toBe(100);
			expect(result.validated.dimensions).toBeUndefined();
		}
	});

	it("accepts a video-only mp4 that exposes NO duration (regression guard)", async () => {
		// A video-only mp4 (no audio track) parses cleanly but yields no
		// duration. The validator MUST accept it with `durationMs` absent —
		// rejecting on a missing duration would block every video-only
		// upload. The fixture is a 32×32 single-frame H.264 clip, no audio.
		const bytes = readFileSync(
			join(import.meta.dirname, "fixtures", "tiny-video.mp4"),
		);
		const result = await validateMediaBytes({
			bytes,
			claimedMimeType: "video/mp4",
			claimedSizeBytes: bytes.length,
			originalFilename: "clip.mp4",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.validated.kind).toBe("video");
			expect(result.validated.mimeType).toBe("video/mp4");
			expect(result.validated.extension).toBe(".mp4");
			expect(result.validated.durationMs).toBeUndefined();
		}
	});
});

describe("validateMediaBytes — the formats every platform plays", () => {
	it.each([
		{ file: "tone.m4a", kind: "audio", mime: "audio/mp4", extension: ".m4a" },
		{
			file: "tone-m4b.m4a",
			kind: "audio",
			mime: "audio/mp4",
			extension: ".m4a",
		},
		{
			file: "tone.flac",
			kind: "audio",
			mime: "audio/flac",
			extension: ".flac",
		},
		{
			file: "tone-vorbis.ogg",
			kind: "audio",
			mime: "audio/ogg",
			extension: ".ogg",
		},
		{
			file: "tone-opus.ogg",
			kind: "audio",
			mime: "audio/ogg",
			extension: ".ogg",
		},
		{
			file: "pattern-vp8.webm",
			kind: "video",
			mime: "video/webm",
			extension: ".webm",
		},
		{
			file: "pattern-vp8-vorbis.webm",
			kind: "video",
			mime: "video/webm",
			extension: ".webm",
		},
		{
			file: "pattern-vp9.webm",
			kind: "video",
			mime: "video/webm",
			extension: ".webm",
		},
		{
			file: "pattern-vp9-opus.webm",
			kind: "video",
			mime: "video/webm",
			extension: ".webm",
		},
	])(
		"accepts $file with its kind, MIME, extension and duration",
		async ({ file, kind, mime, extension }) => {
			const result = await validateNamed(fixture(file), file);
			expect(result).toMatchObject({
				ok: true,
				validated: { kind, mimeType: mime, extension },
			});
			if (result.ok) {
				expect(result.validated.durationMs).toBeGreaterThanOrEqual(900);
				expect(result.validated.durationMs).toBeLessThanOrEqual(1100);
			}
		},
	);

	it("accepts an Opus file declared `.opus` and stores it as `.ogg`", async () => {
		const result = await validateNamed(
			fixture("tone-opus.ogg"),
			"tone.opus",
			"audio/opus",
		);
		expect(result).toMatchObject({
			ok: true,
			validated: { mimeType: "audio/ogg", extension: ".ogg" },
		});
	});

	it("takes a browser's other spellings of a format as the same claim", async () => {
		for (const [file, claim] of [
			["tone.m4a", "audio/x-m4a"],
			["tone.m4a", "audio/m4a"],
			["tone.flac", "audio/x-flac"],
			["tone-vorbis.ogg", "application/ogg"],
			["pattern-24.bmp", "image/x-ms-bmp"],
			["pattern-24.bmp", "image/x-bmp"],
		] as const) {
			expect(
				(await validateNamed(fixture(file), file, claim)).ok,
				`${file} as ${claim}`,
			).toBe(true);
		}
	});

	it.each([
		"pattern-8.bmp",
		"pattern-16.bmp",
		"pattern-24.bmp",
		"pattern-32.bmp",
	])(
		"accepts %s, a BITMAPINFOHEADER BMP ffmpeg wrote, with its dimensions",
		async (file) => {
			expect(await validateNamed(fixture(file), file)).toMatchObject({
				ok: true,
				validated: {
					kind: "image",
					mimeType: "image/bmp",
					extension: ".bmp",
					dimensions: { width: 64, height: 64 },
				},
			});
		},
	);

	it.each(BUILT_BMPS.filter((built) => built.accepted))(
		"accepts the built $name with its dimensions",
		async ({ name, build }) => {
			expect(await validateNamed(build(), name)).toMatchObject({
				ok: true,
				validated: {
					mimeType: "image/bmp",
					dimensions: { width: 8, height: 8 },
				},
			});
		},
	);
});

describe("validateMediaBytes — near misses some CommCare platform refuses", () => {
	it.each([
		{
			file: "tone-isom.m4a",
			reason: "container-brand-not-accepted",
			says: "file as video",
		},
		{
			file: "tone-alac.m4a",
			reason: "codec-not-accepted",
			says: "(Apple Lossless)",
		},
		{ file: "tone-speex.ogg", reason: "codec-not-accepted", says: "(Speex)" },
		{
			file: "tone-flac.ogg",
			reason: "codec-not-accepted",
			says: "(FLAC inside Ogg)",
		},
		{ file: "pattern-av1.webm", reason: "codec-not-accepted", says: "(AV1)" },
		{
			file: "pattern-vp9-profile1.webm",
			reason: "codec-not-accepted",
			says: "(VP9 in 4:4:4 or 10-bit color)",
		},
		{
			file: "pattern-vp9-profile2.webm",
			reason: "codec-not-accepted",
			says: "(VP9 in 4:4:4 or 10-bit color)",
		},
		{
			file: "tone.webm",
			reason: "codec-not-accepted",
			says: "sound and no picture",
		},
		{
			// ffmpeg writes the chapters as a text track beside the sound.
			file: "tone-chapters.m4a",
			reason: "codec-not-accepted",
			says: "more than its one audio track",
		},
		{
			file: "pattern-h264.m4a",
			reason: "codec-not-accepted",
			says: "no audio track",
		},
		{
			file: "pattern-vp8-subtitles.webm",
			reason: "codec-not-accepted",
			says: "neither video nor sound (D_WEBVTT/SUBTITLES)",
		},
		{
			file: "pattern-matroska.webm",
			reason: "magic-bytes-sniff-failed",
			says: "video/matroska",
		},
	])("refuses $file at its own check", async ({ file, reason, says }) => {
		// Every earlier gate passes: the claim a browser makes for the
		// extension, the size and the sniff, so the refusal is the check named.
		const bytes = fixture(file);
		const result = await validateNamed(bytes, file);
		expect(result).toMatchObject({ ok: false, reason });
		if (!result.ok) expect(result.message).toContain(says);
	});

	it.each(BUILT_BMPS.filter((built) => !built.accepted))(
		"refuses the built $name as a BMP variant Nova does not accept",
		async ({ name, build }) => {
			expect(await validateNamed(build(), name)).toMatchObject({
				ok: false,
				reason: "bmp-variant-not-accepted",
				message:
					"This BMP is saved in a way some CommCare apps can't show. Saving it again as a PNG fixes that.",
			});
		},
	);

	it("refuses a BITMAPV4HEADER though it parses as a BMP", async () => {
		const bytes = bmpV4Srgb24();
		expect((await fileTypeFromBuffer(bytes))?.mime).toBe("image/bmp");
		expect((await validateNamed(bytes, "v4.bmp")).ok).toBe(false);
	});

	it("refuses a truncated BMP as malformed", async () => {
		const bytes = fixture("pattern-24.bmp");
		expect(
			await validateNamed(bytes.subarray(0, bytes.length - 100), "cut.bmp"),
		).toMatchObject({ ok: false, reason: "image-parse-failed" });
	});
});
