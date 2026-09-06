import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { stripVellumAttributes } from "@/lib/commcare/xform/deviceForm";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";

function one(elements: Element[]) {
	expect(elements).toHaveLength(1);
	const element = elements[0];
	if (!element) throw new Error("Missing form element");
	return element;
}
function tree(xml: string) {
	new SaxesParser({ xmlns: true }).write(xml).close();
	return parseDocument(xml, { xmlMode: true });
}

it("retains source editor shadows but ships only runtime bind and action attributes", () => {
	const doc = buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Evidence",
						type: "survey",
						fields: [
							f({ kind: "text", id: "answer", default_value: "'initial'" }),
							f({
								kind: "hidden",
								id: "computed",
								calculate: "concat(#form/answer, ' result')",
								relevant: "#form/answer != ''",
							}),
						],
					},
				],
			},
		],
	});
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const hq = expandDoc(doc);
	const source = hq._attachments[`${hq.modules[0].forms[0].unique_id}.xml`];
	if (typeof source !== "string") throw new Error("Missing source form");
	const sourceTree = tree(source);
	expect(
		one(
			findAll(
				(e) => e.name === "bind" && e.attribs.nodeset === "/data/computed",
				sourceTree.children,
			),
		).attribs,
	).toMatchObject({
		"vellum:nodeset": "#form/computed",
		"vellum:calculate": "concat(#form/answer, ' result')",
		"vellum:relevant": "#form/answer != ''",
	});
	const local = tree(
		new AdmZip(compileCcz(hq, doc.appName, doc)).readAsText(
			"modules-0/forms-0.xml",
		),
	);
	expect(
		findAll(
			(e) => Object.keys(e.attribs).some((name) => name.startsWith("vellum:")),
			local.children,
		),
	).toEqual([]);
	expect(
		one(
			findAll(
				(e) => e.name === "bind" && e.attribs.nodeset === "/data/computed",
				local.children,
			),
		).attribs,
	).toEqual({
		nodeset: "/data/computed",
		type: "xsd:string",
		calculate: "concat(/data/answer, ' result')",
		relevant: "/data/answer != ''",
	});
	expect(
		one(
			findAll(
				(e) => e.name === "setvalue" && e.attribs.ref === "/data/answer",
				local.children,
			),
		).attribs,
	).toEqual({ ref: "/data/answer", event: "xforms-ready", value: "'initial'" });
	expect(hq._attachments[`${hq.modules[0].forms[0].unique_id}.xml`]).toBe(
		source,
	);
});

it("removes attributes by namespace identity while respecting nested prefix bindings", () => {
	const input =
		'<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns:v="http://commcarehq.org/xforms/vellum" xmlns="http://www.w3.org/2002/xforms"><h:head><model><instance><data><question/></data></instance><bind v:nodeset="#form/question" nodeset="/data/question" type="xsd:string"/><extension xmlns:v="urn:other"><bind v:nodeset="foreign metadata" nodeset="/data/question"/></extension></model></h:head><h:body><group xmlns:alias="http://commcarehq.org/xforms/vellum" alias:role="Group"><input ref="/data/question"/></group></h:body></h:html>';
	const output = tree(stripVellumAttributes(input));
	expect(
		findAll((e) => e.name === "bind", output.children).map((e) => e.attribs),
	).toEqual([
		{ nodeset: "/data/question", type: "xsd:string" },
		{ "v:nodeset": "foreign metadata", nodeset: "/data/question" },
	]);
	expect(
		one(findAll((e) => e.name === "group", output.children)).attribs,
	).toEqual({ "xmlns:alias": "http://commcarehq.org/xforms/vellum" });
	expect(
		one(findAll((e) => e.name === "input", output.children)).attribs,
	).toEqual({ ref: "/data/question" });
	expect(one(output.children.filter(isTag)).attribs["xmlns:v"]).toBe(
		"http://commcarehq.org/xforms/vellum",
	);
});
