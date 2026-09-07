/** Nova capture filename policy and committed document path derivation.
 * Native browser/HQ acceptance and GCS lifecycle enforcement are separate
 * boundaries; comparing local constants cannot establish those contracts. */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	captureAcceptAttribute,
	captureAttachmentName,
	captureContentType,
	captureExtensionFor,
	captureInstancePathMatchesTemplate,
	captureObjectKeyFor,
	committedCapturePath,
	STAGED_CAPTURE_PREFIX,
	stagedCaptureObjectKeyFor,
} from "../captureFormats";

describe("accepted capture formats", () => {
	it("accepts image filenames and isolates signature PDF policy", () => {
		for (const filename of ["photo.jpg", "photo.jpeg", "photo.png"])
			expect(captureExtensionFor("image", filename)).toBeDefined();
		for (const filename of ["photo.gif", "photo.webp", "photo.pdf"])
			expect(captureExtensionFor("image", filename)).toBeUndefined();
		expect(captureExtensionFor("signature", "signed.pdf")).toBe(".pdf");
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

	it("builds an accept attribute from the extension list", () => {
		expect(captureAcceptAttribute("image")).toBe(".jpg,.jpeg,.png");
	});

	it("falls back to octet-stream for an unmapped extension", () => {
		// A normal outcome, not a gap: it is what CommCare itself sends when
		// it cannot sniff, and what HQ's receiver accepts.
		expect(captureContentType(".3ga")).toBe("application/octet-stream");
		expect(captureContentType(".png")).toBe("image/png");
		expect(captureContentType("constructor")).toBe("application/octet-stream");
	});
});

describe("attachment naming", () => {
	it("combines a minted attachment identity and admitted extension", () => {
		expect(captureAttachmentName("abc-123", ".jpg")).toBe("abc-123.jpg");
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

	it("derives the durable namespace outside the staging prefix", () => {
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

const FORM = testUuid("capture-path-form");
const PHOTO = testUuid("capture-path-photo");
const NOTE = testUuid("capture-path-note");
function captureDoc() {
	return toPersistableDoc(
		expectAdmittedDoc(
			buildDoc({
				modules: [
					{
						name: "Survey",
						forms: [
							{
								uuid: FORM,
								name: "Visits",
								type: "survey",
								fields: [
									f({
										id: "visits",
										kind: "repeat",
										label: "Visits",
										repeat_mode: "count_bound",
										repeat_count: xp("2"),
										children: [
											f({
												id: "details",
												kind: "group",
												label: "Details",
												children: [
													f({
														uuid: PHOTO,
														id: "photo",
														kind: "image",
														label: "Photo",
													}),
													f({
														uuid: NOTE,
														id: "note",
														kind: "text",
														label: "Note",
													}),
												],
											}),
										],
									}),
								],
							},
						],
					},
				],
			}),
		),
	);
}

describe("committed capture paths", () => {
	it("derives repeat and group path segments from an admitted document", () => {
		const doc = captureDoc();
		const before = structuredClone(doc);
		expect(committedCapturePath(doc, PHOTO)).toEqual({
			formUuid: FORM,
			instancePathTemplate: "/data/visits[0]/details/photo",
		});
		expect(committedCapturePath(doc, NOTE)).toBeUndefined();
		expect(
			committedCapturePath(doc, testUuid("missing-capture")),
		).toBeUndefined();
		expect(doc).toEqual(before);
	});

	it("matches each concrete repeat index and keeps literal group and field names exact", () => {
		const template = "/data/visits[0]/details/samples[0]/photo";
		for (const actual of [
			"/data/visits[0]/details/samples[0]/photo",
			"/data/visits[12]/details/samples[3]/photo",
		])
			expect(captureInstancePathMatchesTemplate(actual, template)).toBe(true);
		for (const actual of [
			"/data/visits[-1]/details/samples[0]/photo",
			"/data/visits[01]/details/samples[0]/photo",
			"/data/visits[x]/details/samples[0]/photo",
			"/data/visits[0]/details/samples[0]/other",
			"/data/visits[0]/details/samples[0]/photo/extra",
			"/data/visits[0]/other/samples[0]/photo",
			"/data/visits[0]/details/samples/photo",
		])
			expect(captureInstancePathMatchesTemplate(actual, template)).toBe(false);
	});
});
