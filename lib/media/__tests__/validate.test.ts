/**
 * Coverage for the validation pipeline. Real bytes flow through
 * every stage:
 *
 *   - sharp generates a tiny PNG so the magic-bytes sniff,
 *     sharp re-parse, and dimensions branch all execute against a
 *     real image.
 *   - Hand-crafted byte arrays simulate magic-mismatch + truncation
 *     rejection paths.
 *
 * No GCS, no Firestore, no HTTP — the pipeline takes a `Buffer`
 * and returns a `ValidationResult`.
 */

import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { validateMediaBytes } from "../validate";

/**
 * Produce a deterministic 8×8 PNG via sharp. Tests reuse this so
 * the pipeline runs against bytes that pass the magic-bytes sniff,
 * parse cleanly through sharp, and have known dimensions.
 */
async function makeTinyPng(): Promise<Buffer> {
	return sharp({
		create: {
			width: 8,
			height: 8,
			channels: 3,
			background: { r: 12, g: 34, b: 56 },
		},
	})
		.png()
		.toBuffer();
}

describe("validateMediaBytes — happy path", () => {
	it("validates a real PNG end-to-end", async () => {
		const bytes = await makeTinyPng();
		const result = await validateMediaBytes({
			bytes,
			claimedMimeType: "image/png",
			claimedSizeBytes: bytes.length,
			originalFilename: "logo.png",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.validated.mimeType).toBe("image/png");
			expect(result.validated.extension).toBe(".png");
			expect(result.validated.kind).toBe("image");
			expect(result.validated.dimensions).toEqual({ width: 8, height: 8 });
			expect(result.validated.contentHash).toMatch(/^[a-f0-9]{64}$/);
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
		const bytes = await makeTinyPng();
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
});

describe("validateMediaBytes — rejection paths", () => {
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
		// 6 MB of zeros — the image cap is 5 MB.
		const bytes = Buffer.alloc(6 * 1024 * 1024);
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
		const bytes = await makeTinyPng();
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

	it("rejects a MIME claim outside the accepted set", async () => {
		const bytes = await makeTinyPng();
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
		const pngBytes = await makeTinyPng();
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
		const bytes = await makeTinyPng();
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
		const pngBytes = await makeTinyPng();
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
			expect(["mime-claim-mismatch", "extension-mime-mismatch"]).toContain(
				result.reason,
			);
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
		const garbage = Buffer.alloc(64, 0xff);
		const bytes = Buffer.concat([pngHeader, garbage]);
		const result = await validateMediaBytes({
			bytes,
			claimedMimeType: "image/png",
			claimedSizeBytes: bytes.length,
			originalFilename: "broken.png",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// `file-type` may or may not accept the truncated header
			// — both reasons indicate the same class of rejection.
			expect(["magic-bytes-sniff-failed", "image-parse-failed"]).toContain(
				result.reason,
			);
		}
	});
});
