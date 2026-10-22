import { describe, expect, it } from "vitest";
import { validateXForm } from "../validator/xformOracle";
import { wireForm, xformOracleCases } from "./xformOracleCorpus";

describe("XForm oracle wire corpus", () => {
	it.each(xformOracleCases)("$name", ({ xml, codes, manifest }) => {
		expect(
			validateXForm(
				xml,
				"F",
				"M",
				manifest ? new Set(manifest) : undefined,
			).map((error) => error.code),
		).toEqual(codes);
	});
	const declaration =
		'<instance id="lookup" src="jr://fixture/item-list:lookup"/>';
	const data = "<instance><data><q/></data></instance>";
	const expression = "instance('lookup')/items/item";
	const codes = (xml: string) =>
		validateXForm(xml, "F", "M").map((error) => error.code);
	it.each(["calculate", "relevant", "constraint", "required", "readonly"])(
		"counts a bind's %s expression as an instance read",
		(attribute) => {
			expect(
				codes(
					wireForm(
						`${data}${declaration}<bind nodeset="/data/q" ${attribute}="${expression}"/>`,
					),
				),
			).toEqual([]);
		},
	);
	it("counts initialization and label output reads", () => {
		expect(
			codes(
				wireForm(
					`${data}${declaration}<bind nodeset="/data/q"/><setvalue event="xforms-ready" ref="/data/q" value="${expression}"/>`,
				),
			),
		).toEqual([]);
		expect(
			codes(
				wireForm(
					`${data}${declaration}<bind nodeset="/data/q"/>`,
					`<input ref="/data/q"><label><output value="${expression}"/></label></input>`,
				),
			),
		).toEqual([]);
	});
	it.each([
		`<itemset nodeset="${expression}"><label ref="name"/><value ref="@id"/></itemset>`,
		`<itemset nodeset="/data/q"><label ref="${expression}"/><value ref="@id"/></itemset>`,
		`<itemset nodeset="/data/q"><label ref="name"/><value ref="${expression}"/></itemset>`,
		`<itemset nodeset="/data/q"><label ref="name"/><value ref="@id"/><sort ref="${expression}"/></itemset>`,
	])("counts itemset reads in %s", (itemset) => {
		expect(
			codes(
				wireForm(
					`${data}${declaration}<bind nodeset="/data/q"/>`,
					`<select1 ref="/data/q"><label>Q</label>${itemset}</select1>`,
				),
			),
		).toEqual([]);
	});
	it("counts the repeat count expression without reading saved data as definitions", () => {
		const model = `<instance><data><items jr:template=""><q/></items></data></instance>${declaration}<bind nodeset="/data/items/q"/>`;
		const body = `<repeat nodeset="/data/items" jr:count="count(${expression})"><input ref="/data/items/q"><label>Q</label></input></repeat>`;
		expect(codes(wireForm(model, body))).toEqual([]);
	});
	it("rejects declarations read only in saved data, prose or a Vellum shadow", () => {
		const saved =
			"<instance><data><q/><saved><bind calculate=\"instance('lookup')/items\"/></saved></data></instance>";
		const model = `${saved}${declaration}<bind nodeset="/data/q" calculate="&quot;instance('lookup')&quot;" vellum:calculate="instance('lookup')/items"/>`;
		const form = wireForm(
			model,
			"<input ref=\"/data/q\"><label>instance('lookup')</label></input>",
		).replace(
			"<h:html ",
			'<h:html xmlns:vellum="http://commcarehq.org/xforms/vellum" ',
		);
		expect(codes(form)).toEqual(["XFORM_UNREAD_INSTANCE"]);
	});
	it("does not count an output's ignored value or a prose value's unused ref", () => {
		const model = `${data}${declaration}<bind nodeset="/data/q"/><itext><translation lang="en" default=""><text id="q"><value ref="${expression}">Q</value></text></translation></itext>`;
		const form = wireForm(
			model,
			`<input ref="/data/q"><label><output ref="/data/q" value="${expression}"/></label></input>`,
		);
		expect(codes(form)).toEqual(["XFORM_UNREAD_INSTANCE"]);
	});
	it("owns exact itext media joins independently of XPath symbol resolution", () => {
		const text = (value: string, form = "image") =>
			wireForm(
				`<instance><data><q/></data></instance><bind nodeset="/data/q"/><itext><translation lang="en" default=""><text id="q"><value>Q</value><value form="${form}">${value}</value></text></translation></itext>`,
			);
		expect(
			validateXForm(
				text("jr://file/commcare/a.png"),
				"F",
				"M",
				new Set(["commcare/a.png"]),
			),
		).toEqual([]);
		expect(
			validateXForm(text("jr://file/commcare/a.png"), "F", "M", new Set()).map(
				(error) => error.code,
			),
		).toEqual(["XFORM_DANGLING_MEDIA_REF"]);
		expect(
			validateXForm(
				text("jr://file/commcare/a.png "),
				"F",
				"M",
				new Set(["commcare/a.png"]),
			).map((error) => error.code),
		).toEqual(["XFORM_DANGLING_MEDIA_REF"]);
		expect(validateXForm(text("jr://file/commcare/a.png"), "F", "M")).toEqual(
			[],
		);
		expect(
			validateXForm(
				text("jr://file/commcare/a.png", "markdown"),
				"F",
				"M",
				new Set(),
			),
		).toEqual([]);
	});
});
