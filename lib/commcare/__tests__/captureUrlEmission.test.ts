/**
 * The case property a capture saves, asserted as bytes.
 *
 * What CommCare HQ accepts here is decided in two places, and both are
 * load-bearing:
 *
 *   - `app_manager/xform.py::CaseBlock.add_case_updates` routes a case
 *     update into an `<attachment>` block instead of an `<update>` child
 *     whenever the question path it was given is an `<upload ref>` in the
 *     body (`::is_attachment` collects them). It consults no toggle. So a
 *     URL property must never name the capture question, and the assertion
 *     that it names the sibling address node is the whole point of this
 *     file — getting it wrong emits an attachment block on a stock domain,
 *     where `SqlCaseUpdateStrategy._apply_attachments_action` drops it
 *     without a word.
 *   - The address resolves against
 *     `/a/<domain>/api/form_attachment/v1/<instance id>/<name>`
 *     (`corehq/apps/api/urls.py`, name `api_form_attachment`), where the
 *     instance id is the value `meta/instanceID` carries — seeded
 *     client-side as `uuid()` and taken verbatim as the stored form's id by
 *     `form_processor/utils/xform.py::extract_meta_instance_id` — and the
 *     name is the capture's own answer, which is also the multipart part
 *     name Formplayer sends
 *     (`FormSubmissionHelper::getMultiPartFormBody`).
 *
 * The ordinary `<update>` shape these bytes join is CommCare's own
 * `form_preparation_v2/update_case.xml`.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { buildFormActions } from "@/lib/commcare/formActions";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { buildXForm } from "@/lib/commcare/xform";
import {
	type AttachmentUrlTarget,
	captureUrlNodePath,
} from "@/lib/commcare/xform/captureUrlNode";
import { addCaseBlocks } from "@/lib/commcare/xform/caseBlocks";
import { FormPath } from "@/lib/commcare/xform/formPath";
import { addMetaBlock } from "@/lib/commcare/xform/metaBlock";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const TARGET: AttachmentUrlTarget = {
	origin: "https://www.commcarehq.org",
	domain: "demo-project",
};

/**
 * The exact address expression as it lands in the file, spelled out rather
 * than rebuilt. XPath string literals are single-quoted and the serializer
 * escapes them, so the bytes carry `&apos;` — the assertions below are over
 * the serialized attribute, not over the expression Nova constructed.
 */
const EXPECTED_CALCULATE =
	"if(/data/photo = &apos;&apos;, &apos;&apos;, " +
	"concat(&apos;https://www.commcarehq.org/a/demo-project/api/form_attachment/v1/&apos;, " +
	"/data/meta/instanceID, &apos;/&apos;, /data/photo))";

function captureDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Attachments",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "photo_url", label: proseText("Photo") },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "full_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "image",
								id: "photo",
								label: proseText("Photo"),
								caseWrite: {
									caseType: "patient",
									property: "photo_url",
									mode: "url",
								},
							}),
						],
					},
				],
			},
		],
	});
}

function firstFormUuid(doc: BlueprintDoc) {
	return doc.formOrder[doc.moduleOrder[0]][0];
}

function firstFormXml(hq: ReturnType<typeof expandDoc>): string {
	const first = Object.values(hq._attachments)[0];
	if (typeof first !== "string") {
		throw new Error("expected the first attachment to be the XForm XML");
	}
	return first;
}

describe("a capture saving a link to the attached file", () => {
	it("points the case update at the address node, never at the upload", () => {
		const doc = captureDoc();
		const actions = buildFormActions(
			doc,
			firstFormUuid(doc),
			"patient",
			TARGET,
		);

		expect(actions.update_case.update.photo_url).toEqual({
			question_path: "/data/__nova_url_photo",
			update_mode: "always",
		});
		// The failure this guards is silent: naming `/data/photo` here makes
		// HQ emit an attachment block a stock domain discards.
		expect(actions.update_case.update.photo_url?.question_path).not.toBe(
			"/data/photo",
		);
	});

	it("emits the address node and its calculate beside the capture", () => {
		const doc = captureDoc();
		const xml = firstFormXml(expandDoc(doc, { attachmentTarget: TARGET }));

		expect(xml).toContain("<__nova_url_photo/>");
		expect(xml).toContain(
			`<bind nodeset="/data/__nova_url_photo" type="xsd:string" calculate="${EXPECTED_CALCULATE}"/>`,
		);
		// The capture question itself is untouched: same control, same bind,
		// and no body control over the address node — nobody answers it.
		expect(xml).toContain('<upload ref="/data/photo" mediatype="image/*">');
		expect(xml).toContain(
			'<bind vellum:nodeset="#form/photo" nodeset="/data/photo" type="binary"/>',
		);
		expect(xml).not.toContain('ref="/data/__nova_url_photo"');
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});

	it("writes nothing at all when no deployment target is known", () => {
		const doc = captureDoc();
		const actions = buildFormActions(doc, firstFormUuid(doc), "patient");
		const xml = firstFormXml(expandDoc(doc));

		expect(actions.update_case.update.photo_url).toBeUndefined();
		expect(xml).not.toContain("__nova_url_photo");
		expect(xml).not.toContain("form_attachment");
		// The question still ships. Only the address it has nowhere to
		// resolve against is withheld.
		expect(xml).toContain('<upload ref="/data/photo" mediatype="image/*">');
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});

	it("guards the address so an unanswered capture writes a real blank", () => {
		// The case-update bind carries `relevant="count(<question path>) > 0"`
		// over the address node, which always exists — so the guard, not the
		// relevant, is what keeps an unanswered capture from writing an
		// address ending in a bare slash.
		const doc = captureDoc();
		const formUuid = firstFormUuid(doc);
		const actions = buildFormActions(doc, formUuid, "patient", TARGET);
		const xform = addCaseBlocks(
			buildXForm(doc, formUuid, {
				xmlns: "http://openrosa.org/formdesigner/capture-url-guard",
				moduleCaseType: "patient",
				attachmentTarget: TARGET,
			}),
			actions,
			"patient",
		);

		expect(xform).toContain('relevant="count(/data/__nova_url_photo) &gt; 0"');
		expect(xform).toContain(
			'calculate="if(/data/photo = &apos;&apos;, &apos;&apos;, concat(',
		);
	});

	it("carries the address into the local .ccz case block", () => {
		const doc = captureDoc();
		const formUuid = firstFormUuid(doc);
		const actions = buildFormActions(doc, formUuid, "patient", TARGET);
		const xform = addMetaBlock(
			addCaseBlocks(
				buildXForm(doc, formUuid, {
					xmlns: "http://openrosa.org/formdesigner/capture-url",
					moduleCaseType: "patient",
					attachmentTarget: TARGET,
				}),
				actions,
				"patient",
			),
		);

		// The update child reads the address node, and the meta block the
		// address depends on is present on this path.
		expect(xform).toContain("<update><photo_url/></update>");
		expect(xform).toContain(
			'<bind nodeset="/data/case/update/photo_url" calculate="/data/__nova_url_photo"',
		);
		expect(xform).toContain(
			'<setvalue ref="/data/meta/instanceID" value="uuid()" event="xforms-ready"/>',
		);
		expect(validateXForm(xform, "F", "M")).toEqual([]);
	});

	it("gives each repeat iteration its own address", () => {
		const doc = buildDoc({
			appName: "Attachments in repeats",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: "wound",
					parent_type: "patient",
					properties: [
						{ name: "case_name", label: proseText("Wound") },
						{ name: "photo_url", label: proseText("Photo") },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Assess",
							type: "followup",
							fields: [
								f({
									kind: "repeat",
									id: "wounds",
									repeat_mode: "user_controlled",
									label: proseText("Wounds"),
									children: [
										f({
											kind: "text",
											id: "site",
											label: proseText("Site"),
											caseWrite: { caseType: "wound", property: "case_name" },
										}),
										f({
											kind: "image",
											id: "photo",
											label: proseText("Photo"),
											caseWrite: {
												caseType: "wound",
												property: "photo_url",
												mode: "url",
											},
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const actions = buildFormActions(
			doc,
			firstFormUuid(doc),
			"patient",
			TARGET,
		);
		const xml = firstFormXml(expandDoc(doc, { attachmentTarget: TARGET }));

		// The address node is a SIBLING inside the repeat, so one lands per
		// iteration and rides the same child-create bucket as the capture.
		expect(actions.subcases[0]?.case_properties.photo_url).toEqual({
			question_path: "/data/wounds/__nova_url_photo",
			update_mode: "always",
		});
		expect(xml).toContain(
			'<bind nodeset="/data/wounds/__nova_url_photo" type="xsd:string"',
		);
		expect(xml).toContain(
			"if(/data/wounds/photo = &apos;&apos;, &apos;&apos;, " +
				"concat(&apos;https://www.commcarehq.org/a/demo-project/api/form_attachment/v1/&apos;, " +
				"/data/meta/instanceID, &apos;/&apos;, /data/wounds/photo))",
		);
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});
});

describe("captureUrlNodePath", () => {
	it("names a sibling of the capture, under the same container", () => {
		const capture = FormPath.root().child("wounds").child("photo");
		expect(captureUrlNodePath(capture).toXPath()).toBe(
			"/data/wounds/__nova_url_photo",
		);
	});

	it("keeps two cousins with the same id apart", () => {
		// Field ids are unique among siblings, not across the form, so the
		// address node inherits exactly that scope and nothing more.
		const left = FormPath.root().child("intake").child("photo");
		const right = FormPath.root().child("followup").child("photo");
		expect(captureUrlNodePath(left).toXPath()).not.toBe(
			captureUrlNodePath(right).toXPath(),
		);
	});
});
