import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { validateBindingResolution } from "@/lib/commcare/validator/bindingResolutionOracle";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";

function form(data: string, markup: string, body: string): string {
	return `<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
	<h:head><model><instance><data>${data}</data></instance>${markup}</model></h:head>
	<h:body>${body}</h:body></h:html>`;
}

describe("XForm definitions and instance data have separate scopes", () => {
	it("exports answer IDs that coincide with control, action, and localization names", () => {
		const doc = buildDoc({
			appName: "Observation vocabulary",
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
									id: "model",
									children: [
										f({
											kind: "group",
											id: "instance",
											children: [
												...[
													"input",
													"select",
													"select1",
													"secret",
													"upload",
													"trigger",
													"repeat",
													"group",
													"bind",
													"setvalue",
													"output",
													"itext",
													"translation",
													"text",
													"value",
													"body",
												].map((id) => f({ kind: "text", id })),
											],
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
		const xml = zip.readAsText("modules-0/forms-0.xml");
		expect(xml).not.toBe("");
		expect(validateXForm(xml, "Observations", "Survey")).toEqual([]);
		expect(
			validateBindingResolution(xml, "Observations", "Survey", new Set()),
		).toEqual([]);
	});

	it("does not resolve a real expression against a declaration embedded in answer data", () => {
		const markup = `<bind nodeset="/data/x" calculate="instance('ghost')/items/value"/>`;
		const data = `<x/><model><instance id="ghost"><items><value>decoy</value></items></instance></model>`;
		const unresolved = form(data, markup, "");
		expect(
			validateBindingResolution(unresolved, "F", "M", new Set()).map(
				(e) => e.code,
			),
		).toEqual(["BINDING_RESOLUTION_INSTANCE_UNDECLARED"]);
		const resolved = form(
			data,
			`<instance id="ghost" src="jr://fixture/ghost"/>${markup}`,
			"",
		);
		expect(validateBindingResolution(resolved, "F", "M", new Set())).toEqual(
			[],
		);
	});

	it.each([
		"",
		`<itext><translation lang="en" default=""><text id="existing"><value>Existing</value></text></translation></itext>`,
	])(
		"requires a declared label even when the localization catalog is %s",
		(catalog) => {
			const data = `<x/><translation><text id="missing"><value>Decoy</value></text></translation>`;
			const body = `<input ref="/data/x"><label ref="jr:itext('missing')"/></input>`;
			const xml = form(data, catalog, body);
			expect(validateXForm(xml, "F", "M").map((e) => e.code)).toEqual([
				"XFORM_MISSING_ITEXT",
			]);
			const declared = `<itext><translation lang="en" default=""><text id="missing"><value>Declared</value></text></translation></itext>`;
			expect(validateXForm(form(data, declared, body), "F", "M")).toEqual([]);
		},
	);

	it("still diagnoses malformed definitions while identical names remain valid answers", () => {
		const data = `<input/><bind/><setvalue/><output/>`;
		const invalid = form(data, `<bind/><setvalue/>`, `<input/><output/>`);
		expect(validateXForm(invalid, "F", "M").map((e) => e.code)).toEqual([
			"XFORM_BIND_NO_NODESET",
			"XFORM_CONTROL_NO_REF",
			"XFORM_SETVALUE_NO_TARGET",
			"XFORM_INVALID_OUTPUT",
		]);
		const valid = form(
			data,
			`<bind nodeset="/data/input"/><setvalue ref="/data/input" value="'answer'"/>`,
			`<input ref="/data/input"><label>Answer <output value="/data/output"/></label></input>`,
		);
		expect(validateXForm(valid, "F", "M")).toEqual([]);
	});
});
