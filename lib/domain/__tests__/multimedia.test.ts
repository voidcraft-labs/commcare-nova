/**
 * Schema-level coverage for the multimedia domain primitives.
 *
 * These tests don't touch GCS or Firestore — they assert the Zod
 * shapes round-trip cleanly and the helper functions behave per
 * contract. The integration-level coverage (HTTP routes + bytes
 * validation against actual fixtures) lives at
 * `lib/media/__tests__/validate.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
	ALL_MIME_TYPES,
	ASSET_KINDS,
	ASSET_SIZE_CAPS_BYTES,
	AUDIO_MIME_TYPES,
	assetKindForExtension,
	assetKindForFilename,
	assetKindForMimeType,
	DOCUMENT_KINDS,
	EXTENSION_FOR_MIME_TYPE,
	extensionOf,
	gcsObjectKeyFor,
	IMAGE_MIME_TYPES,
	MEDIA_KINDS,
	mediaSchema,
	mimeTypeForExtension,
	mimeTypeForFilename,
	normalizeMimeType,
	resolveUploadMimeType,
	VIDEO_MIME_TYPES,
} from "../multimedia";

describe("assetKindForMimeType", () => {
	it("returns 'image' for every image MIME type", () => {
		for (const mime of IMAGE_MIME_TYPES) {
			expect(assetKindForMimeType(mime)).toBe("image");
		}
	});

	it("returns 'audio' for every audio MIME type", () => {
		for (const mime of AUDIO_MIME_TYPES) {
			expect(assetKindForMimeType(mime)).toBe("audio");
		}
	});

	it("returns 'video' for every video MIME type", () => {
		for (const mime of VIDEO_MIME_TYPES) {
			expect(assetKindForMimeType(mime)).toBe("video");
		}
	});

	it("returns undefined for SVG (deliberately rejected)", () => {
		expect(assetKindForMimeType("image/svg+xml")).toBeUndefined();
	});

	it("returns the document kind for each document MIME type", () => {
		expect(assetKindForMimeType("application/pdf")).toBe("pdf");
		expect(assetKindForMimeType("text/plain")).toBe("text");
		expect(assetKindForMimeType("text/markdown")).toBe("text");
		expect(
			assetKindForMimeType(
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			),
		).toBe("docx");
		expect(
			assetKindForMimeType(
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			),
		).toBe("xlsx");
	});

	it("returns undefined for a genuinely unknown MIME type", () => {
		expect(assetKindForMimeType("application/zip")).toBeUndefined();
		expect(assetKindForMimeType("image/svg+xml")).toBeUndefined();
		expect(assetKindForMimeType("")).toBeUndefined();
	});
});

describe("ASSET_SIZE_CAPS_BYTES", () => {
	it("covers every asset kind", () => {
		for (const kind of ASSET_KINDS) {
			expect(ASSET_SIZE_CAPS_BYTES[kind]).toBeGreaterThan(0);
		}
	});

	it("keeps the documented tight caps (5 MB / 10 MB / 50 MB)", () => {
		expect(ASSET_SIZE_CAPS_BYTES.image).toBe(5 * 1024 * 1024);
		expect(ASSET_SIZE_CAPS_BYTES.audio).toBe(10 * 1024 * 1024);
		expect(ASSET_SIZE_CAPS_BYTES.video).toBe(50 * 1024 * 1024);
	});
});

describe("EXTENSION_FOR_MIME_TYPE", () => {
	it("covers every accepted MIME type", () => {
		for (const mime of ALL_MIME_TYPES) {
			expect(EXTENSION_FOR_MIME_TYPE[mime]).toMatch(/^\.[a-z0-9]+$/);
		}
	});

	it("maps audio/mpeg to .mp3 (historical MIME, modern extension)", () => {
		expect(EXTENSION_FOR_MIME_TYPE["audio/mpeg"]).toBe(".mp3");
	});

	it("maps audio/wav to .wav", () => {
		expect(EXTENSION_FOR_MIME_TYPE["audio/wav"]).toBe(".wav");
	});

	it("maps video/mp4 to .mp4 directly", () => {
		expect(EXTENSION_FOR_MIME_TYPE["video/mp4"]).toBe(".mp4");
	});
});

describe("gcsObjectKeyFor", () => {
	it("namespaces by owner so cross-tenant probing is closed", () => {
		const hash = "a".repeat(64);
		const a = gcsObjectKeyFor("user-1", hash, ".png");
		const b = gcsObjectKeyFor("user-2", hash, ".png");
		expect(a).toBe(`users/user-1/${hash}.png`);
		expect(b).toBe(`users/user-2/${hash}.png`);
		expect(a).not.toBe(b);
	});

	it("dedupes (owner, hash) inside the same namespace", () => {
		const hash = "f".repeat(64);
		const a = gcsObjectKeyFor("user-1", hash, ".png");
		const b = gcsObjectKeyFor("user-1", hash, ".png");
		expect(a).toBe(b);
	});

	it("includes the extension so a single owner can host distinct formats at the same hash", () => {
		// Hash collisions across formats are vanishingly improbable but
		// the path layout doesn't rely on that — it carries the extension
		// explicitly so the bucket layout would survive the impossible.
		const hash = "0".repeat(64);
		expect(gcsObjectKeyFor("u", hash, ".png")).not.toBe(
			gcsObjectKeyFor("u", hash, ".jpg"),
		);
	});
});

describe("mediaSchema", () => {
	it("accepts a fully-populated slot bundle", () => {
		const parsed = mediaSchema.parse({
			image: "asset-1",
			audio: "asset-2",
			video: "asset-3",
		});
		expect(parsed.image).toBe("asset-1");
		expect(parsed.audio).toBe("asset-2");
		expect(parsed.video).toBe("asset-3");
	});

	it("accepts an empty slot bundle (nothing attached yet)", () => {
		expect(mediaSchema.parse({})).toEqual({});
	});

	it("rejects unknown slot keys (strict shape)", () => {
		expect(() => mediaSchema.parse({ pdf: "asset-1" })).toThrow();
	});

	it("rejects empty asset ids", () => {
		expect(() => mediaSchema.parse({ image: "" })).toThrow();
	});
});

describe("kind partitions", () => {
	it("MEDIA_KINDS is exactly the three wire-attachable kinds", () => {
		expect([...MEDIA_KINDS].sort()).toEqual(["audio", "image", "video"]);
	});

	it("DOCUMENT_KINDS is the library-only document set", () => {
		expect([...DOCUMENT_KINDS].sort()).toEqual(["docx", "pdf", "text", "xlsx"]);
	});

	it("ASSET_KINDS is media + documents", () => {
		expect([...ASSET_KINDS].sort()).toEqual([
			"audio",
			"docx",
			"image",
			"pdf",
			"text",
			"video",
			"xlsx",
		]);
	});
});

describe("normalizeMimeType", () => {
	it("returns canonical accepted types unchanged", () => {
		for (const mime of ALL_MIME_TYPES) {
			expect(normalizeMimeType(mime)).toBe(mime);
		}
	});

	it("strips codec parameters to the base type", () => {
		// A parameterized claim (e.g. fragmented MP4) still names an
		// accepted base type once the `; codecs=...` parameter is dropped.
		expect(normalizeMimeType("video/mp4; codecs=avc1.42E01E")).toBe(
			"video/mp4",
		);
	});

	it("rejects m4a/ogg audio — CommCare HQ's mime table can't ingest them", () => {
		// audio/mp4 (.m4a) and audio/ogg (.ogg) are deliberately NOT in the
		// accepted set: HQ's slim-image Python mimetypes table has no entry
		// for those extensions, so the upload would 400. No alias rescues a
		// type that isn't accepted.
		expect(normalizeMimeType("audio/mp4")).toBeUndefined();
		expect(normalizeMimeType("audio/ogg")).toBeUndefined();
		expect(normalizeMimeType("audio/x-m4a")).toBeUndefined();
		expect(normalizeMimeType("audio/ogg; codecs=opus")).toBeUndefined();
	});

	it("maps animated PNG (image/apng) to image/png", () => {
		// `file-type` sniffs animated PNGs as `image/apng`; they're a
		// backward-compatible PNG variant, accepted as image/png.
		expect(normalizeMimeType("image/apng")).toBe("image/png");
	});

	it("is case- and whitespace-insensitive", () => {
		expect(normalizeMimeType("  IMAGE/PNG  ")).toBe("image/png");
	});

	it("returns undefined for SVG and other unaccepted types", () => {
		expect(normalizeMimeType("image/svg+xml")).toBeUndefined();
		expect(normalizeMimeType("application/zip")).toBeUndefined();
		expect(normalizeMimeType("")).toBeUndefined();
	});
});

// The extension-based fallbacks (used when the browser sends no usable
// Content-Type) derive from the single `EXTENSION_FOR_MIME_TYPE` map, so kind
// and MIME for a given extension can't drift. These pin the derivation +
// the `.jpeg`-alias coverage gap that the inverse would otherwise miss.

describe("extensionOf", () => {
	it("lowercases and includes the dot", () => {
		expect(extensionOf("Form.PDF")).toBe(".pdf");
		expect(extensionOf("notes.md")).toBe(".md");
		expect(extensionOf("a.b.docx")).toBe(".docx"); // last segment only
	});

	it("returns undefined for an extension-less name", () => {
		expect(extensionOf("README")).toBeUndefined();
	});
});

const DOCX_MIME =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("mimeTypeForExtension / assetKindForExtension", () => {
	/** The accepted extension → (kind, canonical MIME) spec. */
	const CASES: ReadonlyArray<[string, string, string]> = [
		[".png", "image", "image/png"],
		[".jpg", "image", "image/jpeg"],
		[".jpeg", "image", "image/jpeg"], // alias EXTENSION_FOR_MIME_TYPE collapses
		[".gif", "image", "image/gif"],
		[".webp", "image", "image/webp"],
		[".mp3", "audio", "audio/mpeg"],
		[".wav", "audio", "audio/wav"],
		[".mp4", "video", "video/mp4"],
		[".pdf", "pdf", "application/pdf"],
		[".txt", "text", "text/plain"],
		[".md", "text", "text/markdown"],
		[".docx", "docx", DOCX_MIME],
		[".xlsx", "xlsx", XLSX_MIME],
	];

	it("maps every accepted extension to its kind + canonical MIME", () => {
		for (const [ext, kind, mime] of CASES) {
			expect(mimeTypeForExtension(ext)).toBe(mime);
			expect(assetKindForExtension(ext)).toBe(kind);
		}
	});

	it("is case-insensitive", () => {
		expect(assetKindForExtension(".PDF")).toBe("pdf");
		expect(mimeTypeForExtension(".MD")).toBe("text/markdown");
	});

	it("returns undefined for an unaccepted extension", () => {
		expect(mimeTypeForExtension(".exe")).toBeUndefined();
		expect(assetKindForExtension(".exe")).toBeUndefined();
	});

	it("stays consistent with assetKindForMimeType (single source)", () => {
		// The whole point of deriving through the MIME map: the kind an extension
		// implies equals the kind its MIME implies, for every accepted extension.
		for (const [ext] of CASES) {
			const mime = mimeTypeForExtension(ext);
			expect(mime).toBeDefined();
			expect(assetKindForExtension(ext)).toBe(
				assetKindForMimeType(mime as string),
			);
		}
	});
});

describe("assetKindForFilename / mimeTypeForFilename", () => {
	it("resolves through the filename's extension", () => {
		expect(assetKindForFilename("requirements.md")).toBe("text");
		expect(mimeTypeForFilename("requirements.md")).toBe("text/markdown");
		expect(assetKindForFilename("photo.JPEG")).toBe("image");
	});

	it("returns undefined for an unknown/absent extension", () => {
		expect(assetKindForFilename("mystery")).toBeUndefined();
		expect(mimeTypeForFilename("archive.zip")).toBeUndefined();
	});
});

describe("resolveUploadMimeType (client upload claim)", () => {
	it("keeps the browser's claim when it's an accepted type", () => {
		expect(resolveUploadMimeType("image/png", "logo.png")).toBe("image/png");
		// A `.md` the browser typed as text/plain: claim wins (accepted); confirm
		// re-derives text/markdown from the filename later.
		expect(resolveUploadMimeType("text/plain", "notes.md")).toBe("text/plain");
	});

	it("normalizes a browser alias to its canonical form", () => {
		expect(resolveUploadMimeType("image/apng", "anim.png")).toBe("image/png");
	});

	it("falls back to the extension when the browser sends no usable type", () => {
		// The bug F5 fixes: empty / octet-stream for `.md` and office files.
		expect(resolveUploadMimeType("", "notes.md")).toBe("text/markdown");
		expect(resolveUploadMimeType("application/octet-stream", "notes.md")).toBe(
			"text/markdown",
		);
		expect(resolveUploadMimeType("", "sheet.xlsx")).toBe(XLSX_MIME);
	});

	it("returns the raw claim as a last resort (server then rejects clearly)", () => {
		// No usable browser type AND an unknown extension → pass the raw value so
		// the initiate route produces a clear rejection rather than an empty string.
		expect(resolveUploadMimeType("application/x-weird", "mystery.zip")).toBe(
			"application/x-weird",
		);
	});
});
