/**
 * Schema-level coverage for the multimedia domain primitives.
 *
 * These tests don't touch GCS or Postgres — they assert the Zod
 * shapes and helpers directly. Byte validation fixtures live at
 * `lib/media/__tests__/validate.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
	ACCEPTED_EXTENSIONS,
	ACCEPTED_FORMATS,
	ALL_MIME_TYPES,
	AUDIO_MIME_TYPES,
	assetKindForExtension,
	assetKindForFilename,
	assetKindForMimeType,
	EXTENSION_FOR_MIME_TYPE,
	extensionOf,
	gcsObjectKeyFor,
	IMAGE_MIME_TYPES,
	imageFormatNoun,
	isModelReadableImageMimeType,
	MEDIA_FORMAT_KEYS,
	MEDIA_FORMATS,
	MODEL_READABLE_IMAGE_MIME_TYPES,
	mediaFormatLabel,
	mediaFormatPlaysOn,
	mediaFormatValueSchema,
	mediaSchema,
	mimeTypeForExtension,
	mimeTypeForFilename,
	normalizeMimeType,
	resolveUploadMimeType,
	VIDEO_MIME_TYPES,
} from "../multimedia";

describe("assetKindForMimeType", () => {
	it.each([
		["image/png", "image"],
		["image/jpeg", "image"],
		["audio/mpeg", "audio"],
		["audio/wav", "audio"],
		["video/mp4", "video"],
	])("classifies %s as %s", (mime, kind) => {
		expect(assetKindForMimeType(mime)).toBe(kind);
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
	it("derives distinct Project namespaces for the same content hash", () => {
		const hash = "a".repeat(64);
		const a = gcsObjectKeyFor("project-1", hash, ".png");
		const b = gcsObjectKeyFor("project-2", hash, ".png");
		expect(a).toBe(`projects/project-1/${hash}.png`);
		expect(b).toBe(`projects/project-2/${hash}.png`);
		expect(a).not.toBe(b);
	});

	it("includes the extension so a single project can host distinct formats at the same hash", () => {
		// Hash collisions across formats are vanishingly improbable but
		// the path layout doesn't rely on that — it carries the extension
		// explicitly so the bucket layout would survive the impossible.
		const hash = "0".repeat(64);
		expect(gcsObjectKeyFor("p", hash, ".png")).not.toBe(
			gcsObjectKeyFor("p", hash, ".jpg"),
		);
	});
});

describe("mediaSchema", () => {
	it("accepts a fully-populated slot bundle", () => {
		const parsed = mediaSchema.parse({
			image: "00000000-0000-4000-8000-000000000001",
			audio: "00000000-0000-4000-8000-000000000002",
			video: "00000000-0000-4000-8000-000000000003",
		});
		expect(parsed.image).toBe("00000000-0000-4000-8000-000000000001");
		expect(parsed.audio).toBe("00000000-0000-4000-8000-000000000002");
		expect(parsed.video).toBe("00000000-0000-4000-8000-000000000003");
	});

	it("accepts an empty slot bundle (nothing attached yet)", () => {
		expect(mediaSchema.parse({})).toEqual({});
	});

	it("rejects unknown slot keys (strict shape)", () => {
		expect(() =>
			mediaSchema.parse({ pdf: "00000000-0000-4000-8000-000000000001" }),
		).toThrow();
	});

	it("rejects empty asset ids", () => {
		expect(() => mediaSchema.parse({ image: "" })).toThrow();
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

	it("reads a browser's or a sniff's other spellings of a format as its canonical MIME", () => {
		expect(normalizeMimeType("audio/x-m4a")).toBe("audio/mp4");
		expect(normalizeMimeType("audio/m4a")).toBe("audio/mp4");
		expect(normalizeMimeType("audio/x-flac")).toBe("audio/flac");
		expect(normalizeMimeType("audio/opus")).toBe("audio/ogg");
		expect(normalizeMimeType("audio/vorbis")).toBe("audio/ogg");
		expect(normalizeMimeType("application/ogg")).toBe("audio/ogg");
		expect(normalizeMimeType("audio/ogg; codecs=opus")).toBe("audio/ogg");
		expect(normalizeMimeType("image/x-ms-bmp")).toBe("image/bmp");
		expect(normalizeMimeType("image/x-bmp")).toBe("image/bmp");
	});

	it("maps the sniff's spellings of the formats one platform plays", () => {
		expect(normalizeMimeType("video/matroska")).toBe("video/x-matroska");
		expect(normalizeMimeType("image/x-icon")).toBe("image/vnd.microsoft.icon");
		expect(normalizeMimeType("audio/aac")).toBe("audio/aac");
		expect(normalizeMimeType("audio/x-midi")).toBe("audio/midi");
	});

	it("still refuses a format no platform plays, and SVG", () => {
		expect(normalizeMimeType("video/ogg")).toBeUndefined();
		expect(normalizeMimeType("image/svg+xml")).toBeUndefined();
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
		[".bmp", "image", "image/bmp"],
		[".m4a", "audio", "audio/mp4"],
		[".flac", "audio", "audio/flac"],
		[".ogg", "audio", "audio/ogg"],
		[".opus", "audio", "audio/ogg"],
		[".webm", "video", "video/webm"],
		[".pdf", "pdf", "application/pdf"],
		[".txt", "text", "text/plain"],
		[".md", "text", "text/markdown"],
		[".docx", "docx", DOCX_MIME],
		[".xlsx", "xlsx", XLSX_MIME],
	];

	it("maps the authored extension examples to their kind and canonical MIME", () => {
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

describe("untrusted MIME lookup keys", () => {
	it("rejects prototype names instead of returning inherited objects", () => {
		for (const value of ["constructor", "__proto__", "toString"]) {
			expect(normalizeMimeType(value)).toBeUndefined();
			expect(mimeTypeForExtension(value)).toBeUndefined();
		}
		expect(resolveUploadMimeType("constructor", "photo.png")).toBe("image/png");
	});
});

describe("ACCEPTED_FORMATS, the one registry", () => {
	it("holds one entry for each canonical MIME, documents included", () => {
		const mimes = ACCEPTED_FORMATS.map((format) => format.mime);
		expect(new Set(mimes).size).toBe(mimes.length);
		expect(ALL_MIME_TYPES).toEqual(mimes);
		expect(mimes).toContain("application/pdf");
	});

	it("derives the kind partitions and every lookup from its entries", () => {
		for (const format of ACCEPTED_FORMATS) {
			expect(assetKindForMimeType(format.mime)).toBe(format.kind);
			expect(EXTENSION_FOR_MIME_TYPE[format.mime]).toBe(format.extension);
			expect(format.declaredExtensions).toContain(format.extension);
			for (const extension of format.declaredExtensions) {
				expect(ACCEPTED_EXTENSIONS).toContain(extension);
			}
		}
		expect(IMAGE_MIME_TYPES).toEqual([
			"image/png",
			"image/jpeg",
			"image/gif",
			"image/webp",
			"image/bmp",
			"image/vnd.microsoft.icon",
			"image/avif",
		]);
		expect(AUDIO_MIME_TYPES).toEqual([
			"audio/mpeg",
			"audio/wav",
			"audio/mp4",
			"audio/flac",
			"audio/ogg",
			"audio/aac",
			"audio/amr",
			"audio/midi",
		]);
		expect(VIDEO_MIME_TYPES).toEqual([
			"video/mp4",
			"video/webm",
			"video/x-matroska",
		]);
	});

	it("resolves every alias and declared extension only through its own entry", () => {
		const aliasOwners = new Map<string, string>();
		const extensionOwners = new Map<string, string>();
		for (const format of ACCEPTED_FORMATS) {
			for (const alias of format.aliases) {
				expect(aliasOwners.has(alias), alias).toBe(false);
				aliasOwners.set(alias, format.mime);
				expect(normalizeMimeType(alias)).toBe(format.mime);
			}
			for (const extension of format.declaredExtensions) {
				expect(extensionOwners.has(extension), extension).toBe(false);
				extensionOwners.set(extension, format.mime);
				expect(mimeTypeForExtension(extension)).toBe(format.mime);
			}
		}
		for (const key of ["constructor", "__proto__", "hasOwnProperty"]) {
			expect(normalizeMimeType(key)).toBeUndefined();
			expect(mimeTypeForExtension(key)).toBeUndefined();
			expect(assetKindForMimeType(key)).toBeUndefined();
		}
	});

	it("names a variant for every media entry, and none for a document", () => {
		const variantMimes = new Set<string>(
			MEDIA_FORMATS.map((format) => format.mime),
		);
		for (const format of ACCEPTED_FORMATS) {
			const media =
				format.kind === "image" ||
				format.kind === "audio" ||
				format.kind === "video";
			expect(variantMimes.has(format.mime), format.mime).toBe(media);
		}
		for (const variant of MEDIA_FORMATS) {
			expect(assetKindForMimeType(variant.mime)).toBe(variant.kind);
		}
	});
});

describe("MEDIA_FORMATS, the variants beneath a MIME", () => {
	it("lists each key once, in key order, each playing somewhere", () => {
		expect(MEDIA_FORMATS.map((format) => format.key)).toEqual([
			...MEDIA_FORMAT_KEYS,
		]);
		expect(new Set(MEDIA_FORMATS.map((f) => f.surfaceKey)).size).toBe(
			MEDIA_FORMATS.length,
		);
		for (const format of MEDIA_FORMATS) {
			expect(format.playsOn.length, format.key).toBeGreaterThan(0);
		}
	});

	it("reads a stored value's platforms and label, unplayable included", () => {
		expect(mediaFormatPlaysOn("mp4-hevc")).toEqual(["android"]);
		expect(mediaFormatPlaysOn("ico")).toEqual(["web-apps"]);
		expect(mediaFormatPlaysOn("mp4-h264-high")).toEqual([
			"web-apps",
			"android",
		]);
		expect(mediaFormatPlaysOn("unplayable")).toEqual([]);
		expect(mediaFormatLabel("mp4-hevc", "video/mp4")).toBe("MP4 (HEVC)");
		expect(mediaFormatLabel("unplayable", "audio/wav")).toBe("WAV");
		expect(mediaFormatValueSchema.safeParse("mp4-hevc").success).toBe(true);
		expect(mediaFormatValueSchema.safeParse("unplayable").success).toBe(true);
		expect(mediaFormatValueSchema.safeParse("svg").success).toBe(false);
	});

	it("names an image with the article its label takes", () => {
		expect(imageFormatNoun("image/bmp")).toBe("a BMP image");
		expect(imageFormatNoun("image/vnd.microsoft.icon")).toBe("an ICO image");
		expect(imageFormatNoun("image/avif")).toBe("an AVIF image");
	});
});

describe("the model-readable image subset", () => {
	it("is exactly PNG, JPEG, GIF and WebP", () => {
		expect([...MODEL_READABLE_IMAGE_MIME_TYPES]).toEqual([
			"image/png",
			"image/jpeg",
			"image/gif",
			"image/webp",
		]);
		expect(isModelReadableImageMimeType("image/bmp")).toBe(false);
		expect(isModelReadableImageMimeType("image/png")).toBe(true);
	});
});
