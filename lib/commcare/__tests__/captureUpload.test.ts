/**
 * The `<upload>` control every capture kind emits, asserted as bytes.
 *
 * The fixture is
 * `commcare-hq/corehq/apps/app_manager/tests/data/form_preparation_v2/attachment.xml`,
 * whose whole capture contract is two elements:
 *
 *   <bind nodeset="/data/thepicture" type="binary" />
 *   <upload ref="/data/thepicture" mediatype="image/*"><label>…</label></upload>
 *
 * — no suite entry, no app-level declaration. `bindTypes.test.ts` covers the
 * bind half; this file covers the control tag and the `mediatype` value,
 * because that value is matched by literal `String.equals` against exactly
 * four strings in `XFormParser::parseUpload`. An unmatched value is NOT an
 * error: the control stays at `CONTROL_UPLOAD`, `entries.js::getEntry` falls
 * through to `UnsupportedEntry`, and that constructor SETS the answer to the
 * literal string `Not Supported by Web Entry`, which then submits. So the
 * failure mode is silent bad data, and these assertions are byte-exact —
 * including the comma with no space in `application/*,text/*`.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import {
	UPLOAD_MEDIATYPE_BY_CAPTURE_KIND,
	UPLOAD_MEDIATYPES,
} from "@/lib/commcare/xform/captureUpload";
import { captureFieldKinds } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

function firstFormXml(doc: ReturnType<typeof buildDoc>): string {
	const first = Object.values(expandDoc(doc)._attachments)[0];
	if (typeof first !== "string") {
		throw new Error("expected the first attachment to be the XForm XML");
	}
	return first;
}

const doc = buildDoc({
	appName: "Captures",
	modules: [
		{
			name: "M",
			forms: [
				{
					name: "F",
					type: "survey",
					fields: [
						f({ kind: "image", id: "photo", label: proseText("Photo") }),
						f({ kind: "audio", id: "clip_audio", label: proseText("Audio") }),
						f({ kind: "video", id: "clip_video", label: proseText("Video") }),
						f({ kind: "signature", id: "sign", label: proseText("Signature") }),
						f({
							kind: "file",
							id: "consent_doc",
							label: proseText("Consent form"),
						}),
					],
				},
			],
		},
	],
});
const xml = firstFormXml(doc);

describe("capture questions emit <upload mediatype>", () => {
	it("emits the four recognized mediatype literals, byte for byte", () => {
		expect(xml).toContain('<upload ref="/data/photo" mediatype="image/*">');
		expect(xml).toContain(
			'<upload ref="/data/clip_audio" mediatype="audio/*">',
		);
		expect(xml).toContain(
			'<upload ref="/data/clip_video" mediatype="video/*">',
		);
		// The comma carries no space. `String.equals` gives no tolerance.
		expect(xml).toContain(
			'<upload ref="/data/consent_doc" mediatype="application/*,text/*">',
		);
	});

	it("emits signature as image/* plus appearance=signature", () => {
		// The wire collapses signature onto the image control; the appearance
		// is the only thing that tells `entries.js::getEntry` (and Android's
		// `WidgetFactory::createWidgetFromPrompt`) to render a drawing pad.
		expect(xml).toContain(
			'<upload ref="/data/sign" mediatype="image/*" appearance="signature">',
		);
	});

	it("emits no appearance on the kinds that carry none", () => {
		// `appearance="face"` is inert on both runtimes Nova targets, so
		// nothing but signature decorates an upload.
		expect(xml.match(/appearance="signature"/g)).toHaveLength(1);
		expect(xml).not.toContain('appearance="face"');
	});

	it("emits <upload>, never <input>, for every capture kind", () => {
		for (const id of [
			"photo",
			"clip_audio",
			"clip_video",
			"sign",
			"consent_doc",
		]) {
			expect(xml).not.toContain(`<input ref="/data/${id}"`);
		}
	});

	it("carries the label inside the upload, matching the fixture", () => {
		// The fixture wraps a plain <label> child; Nova's is an itext ref, and
		// the serializer escapes its quotes as `&apos;` (it is the sole
		// escaping authority, so nothing pre-escapes them).
		expect(xml).toContain(
			`<upload ref="/data/photo" mediatype="image/*"><label ref="jr:itext(&apos;photo-label&apos;)"/></upload>`,
		);
	});

	it("passes Nova's XForm oracle", () => {
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});
});

describe("the mediatype table is closed", () => {
	it("maps every capture kind to one of the four recognized literals", () => {
		for (const kind of captureFieldKinds) {
			expect(UPLOAD_MEDIATYPES).toContain(
				UPLOAD_MEDIATYPE_BY_CAPTURE_KIND[kind],
			);
		}
	});

	it("covers every capture kind, so a new one cannot emit an unmatched value", () => {
		expect(Object.keys(UPLOAD_MEDIATYPE_BY_CAPTURE_KIND).sort()).toEqual(
			[...captureFieldKinds].sort(),
		);
	});
});
