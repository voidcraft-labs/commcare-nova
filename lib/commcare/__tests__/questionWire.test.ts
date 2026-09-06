import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll, textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { proseText } from "@/lib/domain/prose";

// Independent wire expectations: HQ xform.py::VELLUM_TYPES and
// xform_builder.py::ODK_TYPES; Core XFormParser::parseUpload; cloudcare
// entries.js::getEntry (image + signature appearance). The canonical upload
// shape is form_preparation_v2/attachment.xml. Do not import emitter tables.
const questions = [
	{ kind: "text", type: "xsd:string", tag: "input" },
	{ kind: "int", type: "xsd:int", tag: "input" },
	{ kind: "decimal", type: "xsd:double", tag: "input" },
	{ kind: "date", type: "xsd:date", tag: "input" },
	{ kind: "time", type: "xsd:time", tag: "input" },
	{ kind: "datetime", type: "xsd:dateTime", tag: "input" },
	{ kind: "geopoint", type: "geopoint", tag: "input" },
	{ kind: "barcode", type: "barcode", tag: "input" },
	{ kind: "secret", type: "xsd:string", tag: "secret" },
	{ kind: "image", type: "binary", tag: "upload", mediatype: "image/*" },
	{ kind: "audio", type: "binary", tag: "upload", mediatype: "audio/*" },
	{ kind: "video", type: "binary", tag: "upload", mediatype: "video/*" },
	{
		kind: "signature",
		type: "binary",
		tag: "upload",
		mediatype: "image/*",
		appearance: "signature",
	},
	{
		kind: "file",
		type: "binary",
		tag: "upload",
		mediatype: "application/*,text/*",
	},
] as const;

function one(elements: Element[]): Element {
	expect(elements).toHaveLength(1);
	const element = elements[0];
	if (!element) throw new Error("Missing XML element");
	return element;
}

describe("question types and labels in delivered XForms", () => {
	it.each(["hq-source", "ccz"])(
		"joins each %s control to its typed answer and translated label",
		(delivery) => {
			const doc = buildDoc({
				appName: "Field observations",
				modules: [
					{
						name: "Survey",
						forms: [
							{
								name: "Observations",
								type: "survey",
								fields: [
									f({
										kind: "group",
										id: "evidence",
										label: proseText("Evidence"),
										children: questions.map(({ kind }) =>
											f({
												kind,
												id: kind,
												label: proseText(`${kind}: 'A&B' <example>`),
											}),
										),
									}),
								],
							},
						],
					},
				],
			});
			const hq = expandDoc(doc);
			const xml =
				delivery === "ccz"
					? new AdmZip(compileCcz(hq, doc.appName, doc)).readAsText(
							"modules-0/forms-0.xml",
						)
					: Object.values(hq._attachments)[0];
			if (typeof xml !== "string") throw new Error("Missing delivered form");
			// htmlparser2 recovers malformed XML, so prove strict syntax first.
			new SaxesParser({ xmlns: true }).write(xml).close();
			const parsed = parseDocument(xml, { xmlMode: true });
			const model = one(findAll((e) => e.name === "model", parsed.children));
			const body = one(findAll((e) => e.name === "h:body", parsed.children));
			const group = one(body.children.filter(isTag));
			expect({ name: group.name, attributes: group.attribs }).toEqual({
				name: "group",
				attributes: { ref: "/data/evidence", appearance: "field-list" },
			});
			const controls = group.children
				.filter(isTag)
				.filter((e) => e.name !== "label");
			expect(
				controls.map((e) => ({ tag: e.name, attributes: e.attribs })),
			).toEqual(
				questions.map(({ kind, tag, ...wire }) => ({
					tag,
					attributes: {
						ref: `/data/evidence/${kind}`,
						...("mediatype" in wire ? { mediatype: wire.mediatype } : {}),
						...("appearance" in wire ? { appearance: wire.appearance } : {}),
					},
				})),
			);
			const instance = one(
				model.children
					.filter(isTag)
					.filter((e) => e.name === "instance" && !e.attribs.src),
			);
			const data = one(instance.children.filter(isTag));
			const evidence = one(
				data.children.filter(isTag).filter((e) => e.name === "evidence"),
			);
			expect(evidence.children.filter(isTag).map((e) => e.name)).toEqual(
				questions.map((q) => q.kind),
			);
			const translation = one(
				findAll((e) => e.name === "translation", model.children),
			);
			for (const [index, question] of questions.entries()) {
				const path = `/data/evidence/${question.kind}`;
				const binds = findAll(
					(e) => e.name === "bind" && e.attribs.nodeset === path,
					model.children,
				);
				expect(
					binds.map((e) => e.attribs.type),
					path,
				).toEqual([question.type]);
				const label = one(controls[index].children.filter(isTag));
				const id = `evidence-${question.kind}-label`;
				expect({ name: label.name, attributes: label.attribs }).toEqual({
					name: "label",
					attributes: { ref: `jr:itext('${id}')` },
				});
				const entry = one(
					translation.children.filter(isTag).filter((e) => e.attribs.id === id),
				);
				const value = one(
					entry.children
						.filter(isTag)
						.filter((e) => e.name === "value" && !e.attribs.form),
				);
				expect(textContent(value)).toBe(`${question.kind}: 'A&B' <example>`);
			}
		},
	);
});
