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
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { ASSET_SIZE_CAPS_BYTES } from "@/lib/domain/multimedia";
import { validateMediaBytes } from "../validate";

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
		const bytes = readFileSync(join(__dirname, "fixtures", "tiny-video.mp4"));
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
