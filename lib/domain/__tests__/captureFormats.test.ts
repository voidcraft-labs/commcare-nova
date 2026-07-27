/**
 * The accepted-format gate, and the object keys the lifecycle rules depend
 * on.
 *
 * The accepted sets are Nova constraints whose size comes from
 * `couchforms/const.py::VALID_ATTACHMENT_FILE_EXTENSION_MAP`, published to
 * the browser and enforced by `entries.js::FileEntry`. HQ's receiver check
 * is disjunctive and its MIME arm accepts `application/octet-stream` —
 * which is Formplayer's own default when it cannot sniff a type — so the
 * accept list is effectively the ONLY gate. That makes these assertions
 * about what a real worker can and cannot pick, not decoration.
 */

import { describe, expect, it } from "vitest";
import type { PersistableDoc } from "../blueprint";
import {
	CAPTURE_EXTENSIONS_BY_KIND,
	captureAcceptAttribute,
	captureAttachmentName,
	captureContentType,
	captureExtensionFor,
	captureInstancePathMatchesTemplate,
	captureObjectKeyFor,
	committedCapturePath,
	MAX_CAPTURE_BYTES,
	STAGED_CAPTURE_PREFIX,
	stagedCaptureObjectKeyFor,
} from "../captureFormats";
import { captureFieldKinds } from "../fields";

describe("accepted capture formats", () => {
	it("declares an accept set for every capture kind", () => {
		for (const kind of captureFieldKinds) {
			expect(CAPTURE_EXTENSIONS_BY_KIND[kind].length).toBeGreaterThan(0);
		}
	});

	it("matches HQ's map for image — jpg/jpeg/png, and NOT gif or webp", () => {
		// The exact trap PR 1's self-review caught in the SA docs: Nova's
		// authoring library accepts GIF and WebP for menu icons, and the
		// capture path does not.
		expect(CAPTURE_EXTENSIONS_BY_KIND.image).toEqual([".jpg", ".jpeg", ".png"]);
		expect(captureExtensionFor("image", "photo.gif")).toBeUndefined();
		expect(captureExtensionFor("image", "photo.webp")).toBeUndefined();
	});

	it("gives signature image/* plus pdf, per SignatureEntry's accept", () => {
		expect(CAPTURE_EXTENSIONS_BY_KIND.signature).toContain(".pdf");
		expect(CAPTURE_EXTENSIONS_BY_KIND.image).not.toContain(".pdf");
	});

	it("accepts the document set for file, and rejects an image there", () => {
		expect(captureExtensionFor("file", "consent.pdf")).toBe(".pdf");
		expect(captureExtensionFor("file", "sheet.xlsx")).toBe(".xlsx");
		expect(captureExtensionFor("file", "note.msg")).toBe(".msg");
		expect(captureExtensionFor("file", "photo.png")).toBeUndefined();
	});

	it("is case-insensitive on the extension", () => {
		expect(captureExtensionFor("image", "PHOTO.JPG")).toBe(".jpg");
		expect(captureExtensionFor("file", "Report.PDF")).toBe(".pdf");
	});

	it("derives the extension by LAST dot, like the browser does", () => {
		// `entries.js` uses `lastIndexOf(".")`. Formplayer's own
		// `MediaValidator` instead suffix-matches the whole filename, which is
		// why `reportmp3` passes there — the browser's stricter behavior is
		// what a worker actually meets, so it is what Nova matches.
		expect(captureExtensionFor("audio", "my.holiday.recording.mp3")).toBe(
			".mp3",
		);
		expect(captureExtensionFor("audio", "reportmp3")).toBeUndefined();
		expect(captureExtensionFor("audio", "noextension")).toBeUndefined();
	});

	it("rejects a name that is only an extension-looking suffix", () => {
		expect(captureExtensionFor("image", "jpg")).toBeUndefined();
	});

	it("quotes the browser's decimal cap, not Formplayer's larger one", () => {
		// `entries.js` refuses at `> 4000000` decimal; Formplayer's
		// MAX_BYTES_PER_ATTACHMENT is 4*1048576-1024 = 4,193,280. Quoting the
		// smaller one is what makes "4 MB" honest.
		expect(MAX_CAPTURE_BYTES).toBe(4_000_000);
		expect(MAX_CAPTURE_BYTES).toBeLessThan(4 * 1048576 - 1024);
	});

	it("builds an accept attribute from the extension list", () => {
		expect(captureAcceptAttribute("image")).toBe(".jpg,.jpeg,.png");
	});

	it("falls back to octet-stream for an unmapped extension", () => {
		// A normal outcome, not a gap: it is what CommCare itself sends when
		// it cannot sniff, and what HQ's receiver accepts.
		expect(captureContentType(".3ga")).toBe("application/octet-stream");
		expect(captureContentType(".png")).toBe("image/png");
	});
});

describe("attachment naming", () => {
	it("produces the <uuid>.<ext> shape the runtime produces", () => {
		expect(captureAttachmentName("abc-123", ".jpg")).toBe("abc-123.jpg");
	});

	it("never produces the runtime's trailing-dot edge", () => {
		// `FileUtils::getExtension` returns "" for a dotless filename and
		// Kotlin's `?.let` runs on it, so the real runtime can store
		// `<uuid>.`. Nova cannot reach that state because an unrecognized
		// extension is rejected before an id is minted — but a consumer must
		// still not assume the answer splits on a dot, since a submission
		// that went through Formplayer can carry it.
		const name = captureAttachmentName("abc-123", ".jpg");
		expect(name.endsWith(".")).toBe(false);
	});
});

describe("object keys", () => {
	it("stages under a top-level prefix so one lifecycle rule can match", () => {
		const key = stagedCaptureObjectKeyFor("proj-1", "att-1", ".jpg");
		expect(key.startsWith(STAGED_CAPTURE_PREFIX)).toBe(true);
		// The Project segment comes AFTER the prefix: GCS lifecycle matching
		// anchors at the object-name start, so a Project-nested prefix could
		// not be expressed as one rule.
		expect(key).toBe("captures-staged/proj-1/att-1.jpg");
	});

	it("prepares outside the staging prefix, where no TTL can reach it", () => {
		const durable = captureObjectKeyFor("proj-1", "att-1", ".jpg");
		expect(durable.startsWith(STAGED_CAPTURE_PREFIX)).toBe(false);
		expect(durable).toBe("projects/proj-1/captures/att-1.jpg");
	});

	it("gives preparation a destination distinct from its source", () => {
		// Preparation copies staging -> durable before the row can be accepted.
		// If these two ever collided, the staging lifecycle could destroy an
		// accepted attachment.
		const staged = stagedCaptureObjectKeyFor("p", "att", ".jpg");
		const durable = captureObjectKeyFor("p", "att", ".jpg");
		expect(staged).not.toBe(durable);
	});

	it("keys on the attachment id, never the content hash", () => {
		// Two workers who attach identical bytes made two independent
		// observations with independent lifecycles; sharing one object would
		// let one submission's cleanup destroy another's evidence.
		const a = captureObjectKeyFor("proj-1", "att-a", ".jpg");
		const b = captureObjectKeyFor("proj-1", "att-b", ".jpg");
		expect(a).not.toBe(b);
	});

	it("separates Projects in both prefixes", () => {
		expect(stagedCaptureObjectKeyFor("p1", "a", ".png")).not.toBe(
			stagedCaptureObjectKeyFor("p2", "a", ".png"),
		);
		expect(captureObjectKeyFor("p1", "a", ".png")).not.toBe(
			captureObjectKeyFor("p2", "a", ".png"),
		);
	});
});

describe("committed capture paths", () => {
	it("derives a repeat template and accepts only concrete non-negative indices", () => {
		const doc = {
			forms: { form: { uuid: "form" } },
			fields: {
				repeat: { uuid: "repeat", id: "visits", kind: "repeat" },
				photo: { uuid: "photo", id: "photo", kind: "image" },
			},
			fieldOrder: {
				form: ["repeat"],
				repeat: ["photo"],
			},
		} as unknown as PersistableDoc;

		expect(committedCapturePath(doc, "photo")).toEqual({
			formUuid: "form",
			instancePathTemplate: "/data/visits[0]/photo",
		});
		expect(
			captureInstancePathMatchesTemplate(
				"/data/visits[12]/photo",
				"/data/visits[0]/photo",
			),
		).toBe(true);
		for (const forged of [
			"/data/visits[-1]/photo",
			"/data/visits[01]/photo",
			"/data/visits[x]/photo",
			"/data/visits[0]/other",
			"/data/visits[0]/photo/extra",
		]) {
			expect(
				captureInstancePathMatchesTemplate(forged, "/data/visits[0]/photo"),
			).toBe(false);
		}
	});

	it("does not resolve non-capture fields as preparation authority", () => {
		const doc = {
			forms: { form: { uuid: "form" } },
			fields: {
				note: { uuid: "note", id: "note", kind: "text" },
			},
			fieldOrder: { form: ["note"] },
		} as unknown as PersistableDoc;
		expect(committedCapturePath(doc, "note")).toBeUndefined();
	});
});
