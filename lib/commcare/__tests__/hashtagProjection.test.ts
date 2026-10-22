import { findAll } from "domutils";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { buildXForm } from "@/lib/commcare/xform/builder";
import { escapeRegex } from "@/lib/commcare/xml";
import { parseXml } from "@/lib/commcare/xmlParse";
import { w } from "@/lib/commcare/xpath/wire/builders";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import { term } from "@/lib/domain/expression/builders";

describe("typed form-case projection", () => {
	it("emits complete parent selectors with a caller-owned starting case and an attribute ID leaf", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					parent_type: "mother",
					properties: [{ name: "grandparent", label: "Grandparent" }],
				},
				{ name: "mother", parent_type: "household", properties: [] },
				{
					name: "household",
					properties: [{ name: "address", label: "Address" }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "text", id: "selected", label: "Selected record" }),
								...[
									["own_value", "patient", "grandparent"],
									["parent_id", "mother", "case_id"],
									["ancestor_value", "household", "address"],
								].map(([id, caseType, property]) =>
									f({
										kind: "hidden",
										id,
										calculate: term({ kind: "form-case", caseType, property }),
									}),
								),
							],
						},
					],
				},
			],
		});
		blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const xml = buildXForm(doc, formUuid, {
			xmlns: "urn:form-case-projection",
			moduleCaseType: "patient",
			selectedCaseIdRef: w.form(["selected"]),
		});
		const roots = parseXml(xml).children;
		expect(
			findAll((element) => element.name === "bind", roots)
				.filter((bind) => bind.attribs.calculate !== undefined)
				.map((bind) => [bind.attribs.nodeset, bind.attribs.calculate]),
		).toEqual([
			[
				"/data/own_value",
				"instance('casedb')/casedb/case[@case_id = /data/selected]/grandparent",
			],
			[
				"/data/parent_id",
				"instance('casedb')/casedb/case[@case_id = instance('casedb')/casedb/case[@case_id = /data/selected]/index/parent]/@case_id",
			],
			[
				"/data/ancestor_value",
				"instance('casedb')/casedb/case[@case_id = instance('casedb')/casedb/case[@case_id = instance('casedb')/casedb/case[@case_id = /data/selected]/index/parent]/index/parent]/address",
			],
		]);
		expect(
			findAll((element) => element.name === "instance", roots).map(
				(instance) => instance.attribs,
			),
		).toEqual([{}, { src: "jr://instance/casedb", id: "casedb" }]);
	});

	it("makes enum values literal regex matches, including every regex metacharacter", () => {
		const value = String.raw`a.b+c*d?e^f$g{2}(h)|[i]\j`;
		const expression = new RegExp(`^${escapeRegex(value)}$`);
		expect(expression.test(value)).toBe(true);
		expect(expression.test(value.replace(".", "x"))).toBe(false);
		expect(expression.test(`${value}suffix`)).toBe(false);
	});
});
