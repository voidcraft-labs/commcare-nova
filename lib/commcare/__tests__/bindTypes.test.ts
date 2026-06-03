/**
 * XForm `<bind>` `type` attribute per field kind — the value that decides
 * how CommCare HQ reads an uploaded question back.
 *
 * HQ infers each question's editor type from the
 * `(control-tag, bind-type, media-type, appearance)` tuple
 * (`commcare-hq/corehq/apps/app_manager/xform.py::_infer_vellum_type` against
 * the `VELLUM_TYPES` table). A geopoint emitted as `<input>` + `xsd:string`
 * is indistinguishable from a plain text box, so HQ shows it as a Text
 * question — the bug these tests guard against. The expected types mirror the
 * `VELLUM_TYPES` rows:
 *   - Geopoint: `input` + `geopoint`   (HQ fixture `gps_with_question.xml`)
 *   - Barcode:  `input` + `barcode`
 *   - Image/Audio/Video: `upload` + `binary` (signature is an Image variant)
 *
 * `geopoint` / `barcode` / `binary` are bare ODK types, not XSD types
 * (`commcare-hq/.../xform_builder.py::ODK_TYPES` lists them outside
 * `XSD_TYPES`) — so the assertions check the bare token, not an `xsd:` prefix.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";

/** Pull the single form's XForm XML out of the expanded HQ application. */
function firstFormXml(doc: ReturnType<typeof buildDoc>): string {
	const first = Object.values(expandDoc(doc)._attachments)[0];
	if (typeof first !== "string") {
		throw new Error("expected the first attachment to be the XForm XML");
	}
	return first;
}

/**
 * Assert the `<bind>` for `/data/<id>` carries `type="<expected>"`. Matches on
 * the `nodeset`+`type` attribute pair (the serializer emits them in
 * `vellum:nodeset`, `nodeset`, `type` order, so this pins the right bind
 * without over-fitting on the leading `vellum:nodeset`).
 */
function expectBindType(xml: string, id: string, expected: string): void {
	expect(xml).toMatch(
		new RegExp(`nodeset="/data/${id}"\\s+type="${expected}"`),
	);
}

describe("XForm bind types — HQ question-type classification", () => {
	// One survey form holding every kind whose bind type is load-bearing for
	// HQ classification, plus text/int as untouched baselines.
	const doc = buildDoc({
		appName: "Bind types",
		modules: [
			{
				name: "M",
				forms: [
					{
						name: "F",
						type: "survey",
						fields: [
							f({ kind: "text", id: "note", label: "Note" }),
							f({ kind: "int", id: "count", label: "Count" }),
							f({
								kind: "geopoint",
								id: "gps_location",
								label: "GPS location",
							}),
							f({ kind: "barcode", id: "sample_code", label: "Sample code" }),
							f({ kind: "image", id: "photo", label: "Photo" }),
							f({ kind: "audio", id: "recording", label: "Recording" }),
							f({ kind: "video", id: "clip", label: "Clip" }),
							f({ kind: "signature", id: "sign", label: "Signature" }),
						],
					},
				],
			},
		],
	});
	const xml = firstFormXml(doc);

	it("emits geopoint as type=geopoint, not xsd:string (the reported GPS-as-Text bug)", () => {
		expectBindType(xml, "gps_location", "geopoint");
		// The control stays a plain <input> — HQ's Geopoint row is input+geopoint.
		expect(xml).toContain('<input ref="/data/gps_location">');
	});

	it("emits barcode as type=barcode (same misclassification class as geopoint)", () => {
		expectBindType(xml, "sample_code", "barcode");
	});

	it("emits media kinds as type=binary (HQ upload rows key on binary)", () => {
		expectBindType(xml, "photo", "binary");
		expectBindType(xml, "recording", "binary");
		expectBindType(xml, "clip", "binary");
		// Signature is an Image variant — binary bind + signature appearance.
		expectBindType(xml, "sign", "binary");
		expect(xml).toContain('appearance="signature"');
	});

	it("leaves text/int bind types untouched (regression baseline)", () => {
		expectBindType(xml, "note", "xsd:string");
		expectBindType(xml, "count", "xsd:int");
	});

	it("still passes Nova's XForm oracle with the ODK bind types", () => {
		// The oracle mirrors JavaRosa's parse contract; geopoint/barcode/binary
		// are valid ODK types, so changing the bind type must not regress it.
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});
});
