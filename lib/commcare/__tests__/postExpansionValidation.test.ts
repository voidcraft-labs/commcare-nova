import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { validateXFormXml } from "@/lib/commcare/validator/xformValidator";

// ── XForm XML Validator ────────────────────────────────────────────

describe("validateXFormXml", () => {
	it("passes for well-formed XForm with matching refs", () => {
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><name/><age/></data></instance>
      <bind nodeset="/data/name" type="xsd:string"/>
      <bind nodeset="/data/age" type="xsd:int"/>
      <itext><translation lang="en" default="">
        <text id="name-label"><value>Name</value></text>
        <text id="age-label"><value>Age</value></text>
      </translation></itext>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/name"><label ref="jr:itext('name-label')"/></input>
    <input ref="/data/age"><label ref="jr:itext('age-label')"/></input>
  </h:body>
</h:html>`;
		expect(validateXFormXml(xml, "F", "M")).toEqual([]);
	});

	it("catches bind pointing to nonexistent instance node", () => {
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><name/></data></instance>
      <bind nodeset="/data/name" type="xsd:string"/>
      <bind nodeset="/data/ghost" type="xsd:string"/>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/name"><label>Name</label></input>
  </h:body>
</h:html>`;
		const errors = validateXFormXml(xml, "F", "M");
		expect(
			errors.some(
				(e) =>
					e.code === "XFORM_DANGLING_BIND" && e.message.includes("/data/ghost"),
			),
		).toBe(true);
	});

	it("catches control ref pointing to nonexistent node", () => {
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><name/></data></instance>
      <bind nodeset="/data/name"/>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/missing"><label>Missing</label></input>
  </h:body>
</h:html>`;
		const errors = validateXFormXml(xml, "F", "M");
		expect(
			errors.some(
				(e) =>
					e.code === "XFORM_DANGLING_REF" &&
					e.message.includes("/data/missing"),
			),
		).toBe(true);
	});

	it("catches setvalue targeting nonexistent node", () => {
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><name/></data></instance>
      <bind nodeset="/data/name"/>
      <setvalue event="xforms-ready" ref="/data/phantom" value="'hello'"/>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/name"><label>Name</label></input>
  </h:body>
</h:html>`;
		const errors = validateXFormXml(xml, "F", "M");
		expect(
			errors.some(
				(e) =>
					e.code === "XFORM_DANGLING_REF" &&
					e.message.includes("/data/phantom"),
			),
		).toBe(true);
	});

	it("catches itext reference to undefined text ID", () => {
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><name/></data></instance>
      <bind nodeset="/data/name"/>
      <itext><translation lang="en" default="">
        <text id="name-label"><value>Name</value></text>
      </translation></itext>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/name"><label ref="jr:itext('missing-label')"/></input>
  </h:body>
</h:html>`;
		const errors = validateXFormXml(xml, "F", "M");
		expect(
			errors.some(
				(e) =>
					e.code === "XFORM_MISSING_ITEXT" &&
					e.message.includes("missing-label"),
			),
		).toBe(true);
	});

	it("allows binds to secondary instance paths (not validated against main instance)", () => {
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><name/></data></instance>
      <instance src="jr://instance/casedb" id="casedb"/>
      <bind nodeset="/data/name"/>
      <bind nodeset="instance('casedb')/casedb/case" calculate="something"/>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/name"><label>Name</label></input>
  </h:body>
</h:html>`;
		const errors = validateXFormXml(xml, "F", "M");
		expect(errors.some((e) => e.code === "XFORM_DANGLING_BIND")).toBe(false);
	});

	it("validates nested instance paths inside groups", () => {
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><grp><child/></grp></data></instance>
      <bind nodeset="/data/grp"/>
      <bind nodeset="/data/grp/child"/>
    </model>
  </h:head>
  <h:body>
    <group ref="/data/grp">
      <input ref="/data/grp/child"><label>Child</label></input>
    </group>
  </h:body>
</h:html>`;
		expect(validateXFormXml(xml, "F", "M")).toEqual([]);
	});
});

// ── Case list column validation ────────────────────────────────────

describe("case list column validation", () => {
	it("catches column field not matching any case property", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListColumns: [
						{ field: "case_name", header: "Name" },
						{ field: "nonexistent_prop", header: "Ghost" },
					],
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
		});
		const errors = runValidation(doc);
		expect(
			errors.some(
				(e) =>
					e.code === "INVALID_COLUMN_FIELD" &&
					e.message.includes("nonexistent_prop"),
			),
		).toBe(true);
	});

	it("allows standard properties like date_opened", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListColumns: [
						{ field: "case_name", header: "Name" },
						{ field: "date_opened", header: "Opened" },
					],
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "INVALID_COLUMN_FIELD")).toBe(false);
	});

	it("allows custom properties defined by forms", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListColumns: [
						{ field: "case_name", header: "Name" },
						{ field: "age", header: "Age" },
					],
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									kind: "int",
									id: "age",
									label: "Age",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "age", label: "Age" },
					],
				},
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "INVALID_COLUMN_FIELD")).toBe(false);
	});
});

// ── End-to-end: expansion + XForm validation ───────────────────────

describe("expanded XForm validation", () => {
	it("our generator produces valid XForms for a standard blueprint", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListColumns: [{ field: "case_name", header: "Name" }],
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Full Name",
									case_property_on: "patient",
								}),
								f({
									kind: "int",
									id: "age",
									label: "Age",
									case_property_on: "patient",
								}),
								f({
									kind: "hidden",
									id: "risk",
									calculate: "if(/data/age > 65, 'high', 'low')",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
		});

		const hqJson = expandDoc(doc);
		const xmlKey = Object.keys(hqJson._attachments).find((k) =>
			k.endsWith(".xml"),
		);
		if (!xmlKey) throw new Error("expected XML attachment");
		const xml = hqJson._attachments[xmlKey] as string;
		const errors = validateXFormXml(xml, "Register", "Patients");
		expect(errors).toEqual([]);
	});

	it("our generator produces valid XForms with groups and repeats", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Surveys",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [
								f({ kind: "text", id: "intro", label: "Intro" }),
								f({
									kind: "group",
									id: "details",
									label: "Details",
									children: [f({ kind: "text", id: "item", label: "Item" })],
								}),
								f({
									kind: "repeat",
									id: "visits",
									label: "Visits",
									children: [
										f({ kind: "date", id: "visit_date", label: "Date" }),
										f({ kind: "text", id: "notes", label: "Notes" }),
									],
								}),
							],
						},
					],
				},
			],
		});

		const hqJson = expandDoc(doc);
		const xmlKey = Object.keys(hqJson._attachments).find((k) =>
			k.endsWith(".xml"),
		);
		if (!xmlKey) throw new Error("expected XML attachment");
		const xml = hqJson._attachments[xmlKey] as string;
		const errors = validateXFormXml(xml, "Survey", "Surveys");
		expect(errors).toEqual([]);
	});

	it("our generator produces valid XForms with select fields", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "color",
									label: "Color",
									options: [
										{ value: "red", label: "Red" },
										{ value: "blue", label: "Blue" },
									],
								}),
								f({
									kind: "multi_select",
									id: "tags",
									label: "Tags",
									options: [
										{ value: "a", label: "A" },
										{ value: "b", label: "B" },
									],
								}),
							],
						},
					],
				},
			],
		});

		const hqJson = expandDoc(doc);
		const xmlKey = Object.keys(hqJson._attachments).find((k) =>
			k.endsWith(".xml"),
		);
		if (!xmlKey) throw new Error("expected XML attachment");
		const xml = hqJson._attachments[xmlKey] as string;
		const errors = validateXFormXml(xml, "F", "M");
		expect(errors).toEqual([]);
	});
});
