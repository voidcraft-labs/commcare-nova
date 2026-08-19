/**
 * The deprecated `MM_CASE_PROPERTIES` attachment mode, asserted as bytes.
 *
 * The oracle is CommCare's own
 * `app_manager/tests/data/form_preparation_v2/update_attachment_case.xml`
 * (and its `form_preparation_v2_advanced/` twin for the child-create
 * bucket): an empty `<update/>`, then a sibling `<attachment>` whose child
 * is named by the CASE PROPERTY and carries `src="" from="local"`, plus a
 * `relevant="count(<question>) = 1"` bind on the element and a
 * `calculate="<question>"` bind on its `@src`.
 *
 * Two spellings in there look like slips and are not:
 *
 *   - the `<attachment>` child is the case property while `@src` names the
 *     question, so the two are different names in the general case and
 *     swapping them fails silently;
 *   - the guard is `count(...) = 1`, where every scalar case-update bind
 *     Nova emits uses `count(...) > 0`. That is CCHQ's spelling for these
 *     binds and it stays theirs.
 *
 * What routes a write here is purely structural and is HQ's rule, not a
 * flag Nova sets: `CaseBlock.add_case_updates` sends a write into an
 * attachment block when its question path is an `<upload ref>` in the body
 * (`::is_attachment`), consulting no toggle. So the mode is expressed by
 * WHICH node the case write names — the capture question for `attachment`,
 * the sibling address node for `url` — and the last test here pins that
 * equivalence, because it is the only thing keeping the local `.ccz` and
 * an HQ-built app from disagreeing.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { buildFormActions } from "@/lib/commcare/formActions";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { buildXForm } from "@/lib/commcare/xform";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import {
	addCaseBlocks,
	attachmentQuestionPaths,
} from "@/lib/commcare/xform/caseBlocks";
import { parseXForm } from "@/lib/commcare/xform/domSplice";
import { addMetaBlock } from "@/lib/commcare/xform/metaBlock";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const TARGET: AttachmentUrlTarget = {
	origin: "https://www.commcarehq.org",
	domain: "demo-project",
};

/** One registration form whose photo saves the FILE, not a link to it. */
function attachmentDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Attachments",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "photo", label: proseText("Photo") },
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
								id: "thepicture",
								label: proseText("Photo"),
								caseWrite: {
									caseType: "patient",
									property: "photo",
									mode: "attachment",
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

/** The `.ccz` render: source, then case blocks, then the meta block. */
function localXForm(doc: BlueprintDoc, target?: AttachmentUrlTarget): string {
	const formUuid = firstFormUuid(doc);
	return addMetaBlock(
		addCaseBlocks(
			buildXForm(doc, formUuid, {
				xmlns: "http://openrosa.org/formdesigner/attachment-mode",
				moduleCaseType: "patient",
				attachmentTarget: target,
			}),
			buildFormActions(doc, formUuid, "patient", target),
			"patient",
		),
	);
}

describe("a capture saving the file itself to the case", () => {
	it("names the capture question, where HQ's structural rule can read it", () => {
		const doc = attachmentDoc();
		const actions = buildFormActions(doc, firstFormUuid(doc), "patient");

		// The inverse of URL mode, and deliberately so: this path WANTS the
		// attachment routing that `captureUrlEmission.test.ts` exists to
		// avoid.
		expect(actions.update_case.update.photo).toEqual({
			question_path: "/data/thepicture",
			update_mode: "always",
		});
	});

	it("needs no deployment target, because the file rides the submission", () => {
		const doc = attachmentDoc();
		const withTarget = buildFormActions(
			doc,
			firstFormUuid(doc),
			"patient",
			TARGET,
		);
		const without = buildFormActions(doc, firstFormUuid(doc), "patient");

		expect(without.update_case.update.photo).toEqual(
			withTarget.update_case.update.photo,
		);
		// No address is built, so no address node is emitted either.
		expect(
			firstFormXml(expandDoc(doc, { attachmentTarget: TARGET })),
		).not.toContain("__nova_url_");
	});

	it("emits the attachment block and its two binds", () => {
		const xform = localXForm(attachmentDoc());

		// `case_name` rides `<create>` on a registration form, so `<update/>`
		// is empty here — which is exactly the oracle's own shape.
		expect(xform).toContain(
			'<update/><attachment><photo src="" from="local"/></attachment>',
		);
		expect(xform).toContain(
			'<bind nodeset="/data/case/attachment/photo" relevant="count(/data/thepicture) = 1"/>',
		);
		expect(xform).toContain(
			'<bind nodeset="/data/case/attachment/photo/@src" calculate="/data/thepicture"/>',
		);
		expect(validateXForm(xform, "F", "M")).toEqual([]);
	});

	it("keeps the property out of <update>, so nothing writes the file name", () => {
		const xform = localXForm(attachmentDoc());

		// A `<photo/>` under `<update>` would be a scalar the receiver fills
		// with the file NAME, sitting beside the attachment carrying the
		// file — two case properties' worth of confusion from one write.
		expect(xform).not.toContain("<photo/>");
		expect(xform).not.toContain('nodeset="/data/case/update/photo"');
	});

	it("splits a form that uses both modes", () => {
		const doc = buildDoc({
			appName: "Both modes",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "photo", label: proseText("Photo") },
						{ name: "scan_url", label: proseText("Scan") },
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
									id: "thepicture",
									label: proseText("Photo"),
									caseWrite: {
										caseType: "patient",
										property: "photo",
										mode: "attachment",
									},
								}),
								f({
									kind: "file",
									id: "scan",
									label: proseText("Scan"),
									caseWrite: {
										caseType: "patient",
										property: "scan_url",
										mode: "url",
									},
								}),
							],
						},
					],
				},
			],
		});
		const xform = localXForm(doc, TARGET);

		// The URL writer is a scalar `<update>` child reading its address
		// node; the attachment writer is not in `<update>` at all.
		expect(xform).toContain(
			'<update><scan_url/></update><attachment><photo src="" from="local"/></attachment>',
		);
		expect(xform).toContain(
			'<bind nodeset="/data/case/update/scan_url" calculate="/data/__nova_url_scan"',
		);
		expect(xform).toContain(
			'<bind nodeset="/data/case/attachment/photo/@src" calculate="/data/thepicture"/>',
		);
		expect(validateXForm(xform, "F", "M")).toEqual([]);
	});

	it("gives a child-create bucket its own attachment block", () => {
		const doc = buildDoc({
			appName: "Attachments on children",
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
						{ name: "photo", label: proseText("Photo") },
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
											id: "thepicture",
											label: proseText("Photo"),
											caseWrite: {
												caseType: "wound",
												property: "photo",
												mode: "attachment",
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
		const formUuid = firstFormUuid(doc);
		const actions = buildFormActions(doc, formUuid, "patient");
		const xform = addCaseBlocks(
			buildXForm(doc, formUuid, {
				xmlns: "http://openrosa.org/formdesigner/attachment-subcase",
				moduleCaseType: "patient",
			}),
			actions,
			"patient",
		);

		expect(actions.subcases[0]?.case_properties.photo).toEqual({
			question_path: "/data/wounds/thepicture",
			update_mode: "always",
		});
		expect(xform).toContain(
			'<attachment><photo src="" from="local"/></attachment>',
		);
		expect(xform).toContain('relevant="count(/data/wounds/thepicture) = 1"');
		expect(xform).toContain('calculate="/data/wounds/thepicture"/>');
		expect(validateXForm(xform, "F", "M")).toEqual([]);
	});
});

describe("attachmentQuestionPaths", () => {
	it("is HQ's is_attachment: every <upload ref> in the body, and only those", () => {
		const doc = attachmentDoc();
		const source = buildXForm(doc, firstFormUuid(doc), {
			xmlns: "http://openrosa.org/formdesigner/upload-scan",
			moduleCaseType: "patient",
		});

		expect([...attachmentQuestionPaths(parseXForm(source))]).toEqual([
			"/data/thepicture",
		]);
	});

	it("puts an attachment write inside the set and a URL write outside it", () => {
		// The whole mode mechanism in one assertion. Nova never tells the
		// emitter which mode a field chose; it chooses the question path, and
		// membership in this set is what both Nova and HQ read back off it.
		const doc = attachmentDoc();
		const formUuid = firstFormUuid(doc);
		const source = buildXForm(doc, formUuid, {
			xmlns: "http://openrosa.org/formdesigner/mode-equivalence",
			moduleCaseType: "patient",
			attachmentTarget: TARGET,
		});
		const uploads = attachmentQuestionPaths(parseXForm(source));

		const attachmentWrite = buildFormActions(doc, formUuid, "patient")
			.update_case.update.photo;
		expect(attachmentWrite).toBeDefined();
		expect(uploads.has(attachmentWrite?.question_path ?? "")).toBe(true);

		// And the URL-mode form's write, over the same capture question, is
		// deliberately NOT in it.
		const urlDoc = buildDoc({
			appName: "URL mode",
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
									id: "thepicture",
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
		const urlWrite = buildFormActions(
			urlDoc,
			firstFormUuid(urlDoc),
			"patient",
			TARGET,
		).update_case.update.photo_url;
		expect(urlWrite).toBeDefined();
		expect(uploads.has(urlWrite?.question_path ?? "")).toBe(false);
	});
});
