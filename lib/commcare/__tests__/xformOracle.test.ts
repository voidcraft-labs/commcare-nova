import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";

// ── XForm XML Validator ────────────────────────────────────────────

describe("validateXForm — XForm parse-time oracle", () => {
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
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});

	it("catches an element using an undeclared namespace prefix (malformed XML)", () => {
		// `<orx:meta>` with no `xmlns:orx` declaration — the prefix is
		// undefined, so the whole form is malformed XML. fast-xml-parser's
		// well-formedness gate doesn't catch an undeclared prefix; the
		// namespace check does (the regression that silently broke media
		// uploads — CCHQ rejects the form, so no media attaches).
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><orx:meta><orx:instanceID/></orx:meta><name/></data></instance>
      <bind nodeset="/data/name" type="xsd:string"/>
      <itext><translation lang="en" default="">
        <text id="name-label"><value>Name</value></text>
      </translation></itext>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/name"><label ref="jr:itext('name-label')"/></input>
  </h:body>
</h:html>`;
		const errors = validateXForm(xml, "F", "M");
		expect(
			errors.some(
				(e) => e.code === "XFORM_PARSE_ERROR" && e.message.includes("orx"),
			),
		).toBe(true);
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
		const errors = validateXForm(xml, "F", "M");
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
		const errors = validateXForm(xml, "F", "M");
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
		const errors = validateXForm(xml, "F", "M");
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
		const errors = validateXForm(xml, "F", "M");
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
		const errors = validateXForm(xml, "F", "M");
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
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});

	// ── Strict well-formedness gate ────────────────────────────────────

	it("rejects a <value> containing an unescaped < in label text (e.g. weight ranges)", () => {
		// Raw `<` in label text is not a valid XML character outside markup.
		// htmlparser2 silently recovers; fast-xml-parser catches it at the gate.
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><weight/></data></instance>
      <bind nodeset="/data/weight"/>
      <itext><translation lang="en" default="">
        <text id="weight-label"><value>(<2kg, 2-10kg,)</value></text>
      </translation></itext>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/weight"><label ref="jr:itext('weight-label')"/></input>
  </h:body>
</h:html>`;
		const errors = validateXForm(xml, "WeightForm", "M");
		expect(errors.some((e) => e.code === "XFORM_PARSE_ERROR")).toBe(true);
	});

	it("rejects a <value> containing nested tags in label text (e.g. country>number)", () => {
		// Markup like `<country><number>` in a text value is illegal XML — the
		// parser would need to close those tags, but CommCare rejects the form.
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><phone/></data></instance>
      <bind nodeset="/data/phone"/>
      <itext><translation lang="en" default="">
        <text id="phone-label"><value>Enter <country><number></value></text>
      </translation></itext>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/phone"><label ref="jr:itext('phone-label')"/></input>
  </h:body>
</h:html>`;
		const errors = validateXForm(xml, "PhoneForm", "M");
		expect(errors.some((e) => e.code === "XFORM_PARSE_ERROR")).toBe(true);
	});

	it("rejects a <value> containing a bare & in label text (e.g. Tom & Jerry)", () => {
		// Unescaped `&` is illegal XML unless it opens a valid entity reference.
		// It must be written as `&amp;` in well-formed XML.
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><name/></data></instance>
      <bind nodeset="/data/name"/>
      <itext><translation lang="en" default="">
        <text id="name-label"><value>Tom &amp; Jerry</value></text>
      </translation></itext>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/name"><label ref="jr:itext('name-label')"/></input>
  </h:body>
</h:html>`.replace("&amp;", "&");
		const errors = validateXForm(xml, "NamesForm", "M");
		expect(errors.some((e) => e.code === "XFORM_PARSE_ERROR")).toBe(true);
	});

	it("accepts a <value> with a properly pre-escaped &amp; — not a false positive", () => {
		// Generator should always emit escaped text; this verifies the gate
		// passes well-formed XML containing entity references.
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><name/></data></instance>
      <bind nodeset="/data/name"/>
      <itext><translation lang="en" default="">
        <text id="name-label"><value>Tom &amp; Jerry</value></text>
      </translation></itext>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/name"><label ref="jr:itext('name-label')"/></input>
  </h:body>
</h:html>`;
		const errors = validateXForm(xml, "NamesForm", "M");
		expect(errors.some((e) => e.code === "XFORM_PARSE_ERROR")).toBe(false);
	});

	// ── itext duplicate-definition check ──────────────────────────────

	it("rejects two <text> elements with the same id in one translation", () => {
		// JavaRosa (XFormParser.java::parseTextHandle) throws XFormParseException
		// on a duplicate (id, form) key within a translation block.
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><q/></data></instance>
      <bind nodeset="/data/q"/>
      <itext><translation lang="en" default="">
        <text id="dup"><value>First</value></text>
        <text id="dup"><value>Second</value></text>
      </translation></itext>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/q"><label ref="jr:itext('dup')"/></input>
  </h:body>
</h:html>`;
		const errors = validateXForm(xml, "DupForm", "M");
		expect(
			errors.some(
				(e) => e.code === "XFORM_DUPLICATE_ITEXT" && e.message.includes("dup"),
			),
		).toBe(true);
	});

	it("accepts a single <text> with both a default value and a markdown value — not a false positive", () => {
		// Nova legitimately emits both <value> (default) and <value form="markdown">
		// inside the same <text id="x">. These are distinct (id, form) keys per
		// XFormParser.java::parseTextHandle — (x, null) and (x, "markdown") — so
		// they must NOT be flagged as duplicates.
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><q/></data></instance>
      <bind nodeset="/data/q"/>
      <itext><translation lang="en" default="">
        <text id="q-label">
          <value>Plain text</value>
          <value form="markdown">**Bold text**</value>
        </text>
      </translation></itext>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/q"><label ref="jr:itext('q-label')"/></input>
  </h:body>
</h:html>`;
		const errors = validateXForm(xml, "MarkdownForm", "M");
		expect(errors.some((e) => e.code === "XFORM_DUPLICATE_ITEXT")).toBe(false);
		expect(errors).toEqual([]);
	});

	it("accepts the same id in different translations — uniqueness is per-translation", () => {
		// The dedup scope is within a single <translation>, not across the document.
		// The same text id appearing in <translation lang="en"> and <translation lang="fr">
		// is normal multi-locale usage, not a duplicate.
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><q/></data></instance>
      <bind nodeset="/data/q"/>
      <itext>
        <translation lang="en" default="">
          <text id="q-label"><value>Question</value><value form="markdown">Question</value></text>
        </translation>
        <translation lang="fr">
          <text id="q-label"><value>Question (FR)</value><value form="markdown">Question (FR)</value></text>
        </translation>
      </itext>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/q"><label ref="jr:itext('q-label')"/></input>
  </h:body>
</h:html>`;
		const errors = validateXForm(xml, "MultiLangForm", "M");
		expect(errors.some((e) => e.code === "XFORM_DUPLICATE_ITEXT")).toBe(false);
		expect(errors).toEqual([]);
	});

	it("flags a collision when form='' is used alongside the default value under the same id", () => {
		// form="" is normalized to the default (null) by JavaRosa (XFormParser.java::parseTextHandle).
		// Two <value> under the same id — one with form="" and one with no form —
		// produce identical (id, null) keys and must be detected as a duplicate.
		const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data><q/></data></instance>
      <bind nodeset="/data/q"/>
      <itext><translation lang="en" default="">
        <text id="q-label">
          <value>First default</value>
          <value form="">Second default (normalized to default form)</value>
        </text>
      </translation></itext>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/q"><label ref="jr:itext('q-label')"/></input>
  </h:body>
</h:html>`;
		const errors = validateXForm(xml, "EmptyFormAttr", "M");
		expect(
			errors.some(
				(e) =>
					e.code === "XFORM_DUPLICATE_ITEXT" && e.message.includes("q-label"),
			),
		).toBe(true);
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
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
						{ field: "nonexistent_prop", header: "Ghost" },
					]),
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
					e.code === "CASE_LIST_COLUMN_UNKNOWN_FIELD" &&
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
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
						{ field: "date_opened", header: "Opened" },
					]),
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
			errors.some((e) => e.code === "CASE_LIST_COLUMN_UNKNOWN_FIELD"),
		).toBe(false);
	});

	it("allows custom properties defined by forms", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
						{ field: "age", header: "Age" },
					]),
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
		expect(
			errors.some((e) => e.code === "CASE_LIST_COLUMN_UNKNOWN_FIELD"),
		).toBe(false);
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
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
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
		const errors = validateXForm(xml, "Register", "Patients");
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
		const errors = validateXForm(xml, "Survey", "Surveys");
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
		const errors = validateXForm(xml, "F", "M");
		expect(errors).toEqual([]);
	});
});

// ── New parse-time invariants (mapped from XFormParser.java) ────────
//
// Each invariant gets a positive (valid form passes clean) + negative
// (the violation is flagged with its code) pair. Fixtures are minimal,
// hand-built XForms — the smallest shape that exercises the one rule.

/**
 * Wrap a `<model>` body fragment + a `<body>` fragment into a complete,
 * well-formed XForm so each fixture only spells the parts under test.
 */
function wrapXForm(modelInner: string, bodyInner: string): string {
	return `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:jr="http://openrosa.org/javarosa">
  <h:head>
    <model>${modelInner}</model>
  </h:head>
  <h:body>${bodyInner}</h:body>
</h:html>`;
}

const has = (errs: ReturnType<typeof validateXForm>, code: string) =>
	errs.some((e) => e.code === code);

describe("oracle invariant #3 — bind nodeset must be a PATH", () => {
	it("flags a non-path bind nodeset (a function call)", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="count(/data/q)"/>`,
			`<input ref="/data/q"><label>Q</label></input>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_NON_PATH_NODESET")).toBe(
			true,
		);
	});

	it("passes a path bind nodeset", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/>`,
			`<input ref="/data/q"><label>Q</label></input>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_NON_PATH_NODESET")).toBe(
			false,
		);
	});
});

describe("oracle invariant — ANY-expression bind attributes must parse", () => {
	it("flags an unparseable calculate expression", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q" calculate="1 +"/>`,
			`<input ref="/data/q"><label>Q</label></input>`,
		);
		expect(
			has(validateXForm(xml, "F", "M"), "XFORM_INVALID_BIND_EXPRESSION"),
		).toBe(true);
	});

	it("passes a valid relevant expression that is itself a non-path (a comparison)", () => {
		// relevant is ANY-expression: a comparison is valid here even though it
		// would be rejected as a nodeset.
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q" relevant="/data/q &gt; 5"/>`,
			`<input ref="/data/q"><label>Q</label></input>`,
		);
		expect(
			has(validateXForm(xml, "F", "M"), "XFORM_INVALID_BIND_EXPRESSION"),
		).toBe(false);
	});
});

describe("oracle invariant #4 — repeat may not bind the form root", () => {
	it("flags a repeat bound to /data", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/>`,
			`<repeat nodeset="/data"><input ref="/data/q"><label>Q</label></input></repeat>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_REPEAT_BINDS_ROOT")).toBe(
			true,
		);
	});
});

describe("oracle invariant #6 — control ref must be a PATH", () => {
	it("flags a control ref that is a function call", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/>`,
			`<input ref="string(/data/q)"><label>Q</label></input>`,
		);
		expect(
			has(validateXForm(xml, "F", "M"), "XFORM_NON_PATH_CONTROL_REF"),
		).toBe(true);
	});
});

describe("oracle invariant #7/#9 — selects need ≥1 item; items need label+value", () => {
	it("flags a select1 with no items", () => {
		const xml = wrapXForm(
			`<instance><data><c/></data></instance><bind nodeset="/data/c"/>`,
			`<select1 ref="/data/c"><label>C</label></select1>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_SELECT_NO_ITEMS")).toBe(
			true,
		);
	});

	it("flags an item missing its value", () => {
		const xml = wrapXForm(
			`<instance><data><c/></data></instance><bind nodeset="/data/c"/>`,
			`<select1 ref="/data/c"><label>C</label><item><label>Red</label></item></select1>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_ITEM_INCOMPLETE")).toBe(
			true,
		);
	});

	it("passes a select1 with a complete item", () => {
		const xml = wrapXForm(
			`<instance><data><c/></data></instance><bind nodeset="/data/c"/>`,
			`<select1 ref="/data/c"><label>C</label><item><label>Red</label><value>red</value></item></select1>`,
		);
		const errs = validateXForm(xml, "F", "M");
		expect(has(errs, "XFORM_SELECT_NO_ITEMS")).toBe(false);
		expect(has(errs, "XFORM_ITEM_INCOMPLETE")).toBe(false);
	});
});

describe("oracle invariant #11 — <text> needs an id and only <value> children", () => {
	it("flags a <text> with no id", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/><itext><translation lang="en" default=""><text><value>Q</value></text></translation></itext>`,
			`<input ref="/data/q"><label>Q</label></input>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_TEXT_NO_ID")).toBe(true);
	});

	it("flags a <text> with a non-<value> child", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/><itext><translation lang="en" default=""><text id="q-label"><note>Q</note></text></translation></itext>`,
			`<input ref="/data/q"><label ref="jr:itext('q-label')"/></input>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_TEXT_BAD_CHILD")).toBe(
			true,
		);
	});
});

describe("oracle invariant #12 — translation structure", () => {
	it("flags a translation with no lang", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/><itext><translation default=""><text id="q-label"><value>Q</value></text></translation></itext>`,
			`<input ref="/data/q"><label ref="jr:itext('q-label')"/></input>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_TRANSLATION_NO_LANG")).toBe(
			true,
		);
	});

	it("flags two translations for the same lang", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/><itext><translation lang="en" default=""><text id="q-label"><value>A</value></text></translation><translation lang="en"><text id="q-label"><value>B</value></text></translation></itext>`,
			`<input ref="/data/q"><label ref="jr:itext('q-label')"/></input>`,
		);
		expect(
			has(validateXForm(xml, "F", "M"), "XFORM_TRANSLATION_DUPLICATE_LANG"),
		).toBe(true);
	});

	it("flags two default translations", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/><itext><translation lang="en" default=""><text id="q-label"><value>A</value></text></translation><translation lang="fr" default=""><text id="q-label"><value>B</value></text></translation></itext>`,
			`<input ref="/data/q"><label ref="jr:itext('q-label')"/></input>`,
		);
		expect(
			has(validateXForm(xml, "F", "M"), "XFORM_TRANSLATION_MULTIPLE_DEFAULT"),
		).toBe(true);
	});
});

describe("oracle invariant #14/#15 — setvalue ref PATH, value parse, event", () => {
	it("flags a non-path setvalue ref", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/><setvalue event="xforms-ready" ref="count(/data/q)" value="'x'"/>`,
			`<input ref="/data/q"><label>Q</label></input>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_INVALID_SETVALUE")).toBe(
			true,
		);
	});

	it("flags an unparseable setvalue value", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/><setvalue event="xforms-ready" ref="/data/q" value="1 +"/>`,
			`<input ref="/data/q"><label>Q</label></input>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_INVALID_SETVALUE")).toBe(
			true,
		);
	});

	it("flags an unrecognized action event", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/><setvalue event="on-load" ref="/data/q" value="'x'"/>`,
			`<input ref="/data/q"><label>Q</label></input>`,
		);
		expect(
			has(validateXForm(xml, "F", "M"), "XFORM_INVALID_ACTION_EVENT"),
		).toBe(true);
	});

	it("passes a valid xforms-ready setvalue", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/><setvalue event="xforms-ready" ref="/data/q" value="'x'"/>`,
			`<input ref="/data/q"><label>Q</label></input>`,
		);
		const errs = validateXForm(xml, "F", "M");
		expect(has(errs, "XFORM_INVALID_SETVALUE")).toBe(false);
		expect(has(errs, "XFORM_INVALID_ACTION_EVENT")).toBe(false);
	});
});

describe("oracle invariant #16 — ≤1 jr:template per repeated set", () => {
	it("flags two sibling templates of the same name", () => {
		const xml = wrapXForm(
			`<instance><data><rep jr:template=""><a/></rep><rep jr:template=""><a/></rep></data></instance><bind nodeset="/data/rep/a"/>`,
			`<repeat nodeset="/data/rep"><input ref="/data/rep/a"><label>A</label></input></repeat>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_DUPLICATE_TEMPLATE")).toBe(
			true,
		);
	});
});

describe("oracle invariant #18 — output needs ref/value, value parses", () => {
	it("flags an output with neither ref nor value", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/><itext><translation lang="en" default=""><text id="q-label"><value>Hi <output/></value></text></translation></itext>`,
			`<input ref="/data/q"><label ref="jr:itext('q-label')"/></input>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_INVALID_OUTPUT")).toBe(
			true,
		);
	});

	it("flags an output with an unparseable value", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/><itext><translation lang="en" default=""><text id="q-label"><value>Hi <output value="1 +"/></value></text></translation></itext>`,
			`<input ref="/data/q"><label ref="jr:itext('q-label')"/></input>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_INVALID_OUTPUT")).toBe(
			true,
		);
	});
});

describe("oracle invariant #22 — repeat member binding scope", () => {
	it("flags a control inside a repeat bound outside the repeated node", () => {
		// <repeat nodeset="/data/rep"> with a child <input ref="/data/other">:
		// /data/other is not a descendant of /data/rep.
		const xml = wrapXForm(
			`<instance><data><rep jr:template=""><a/></rep><other/></data></instance><bind nodeset="/data/rep/a"/><bind nodeset="/data/other"/>`,
			`<repeat nodeset="/data/rep"><input ref="/data/other"><label>O</label></input></repeat>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_REPEAT_MEMBER_SCOPE")).toBe(
			true,
		);
	});

	it("flags a nested repeat bound to the same node as its parent", () => {
		const xml = wrapXForm(
			`<instance><data><rep jr:template=""><a/></rep></data></instance><bind nodeset="/data/rep/a"/>`,
			`<repeat nodeset="/data/rep"><repeat nodeset="/data/rep"><input ref="/data/rep/a"><label>A</label></input></repeat></repeat>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_REPEAT_MEMBER_SCOPE")).toBe(
			true,
		);
	});

	it("passes a control properly nested under its repeat", () => {
		const xml = wrapXForm(
			`<instance><data><rep jr:template=""><a/></rep></data></instance><bind nodeset="/data/rep/a"/>`,
			`<repeat nodeset="/data/rep"><input ref="/data/rep/a"><label>A</label></input></repeat>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_REPEAT_MEMBER_SCOPE")).toBe(
			false,
		);
	});

	it("flags a member that skips an intervening repeatable ancestor", () => {
		// Outer repeat /data/outer; member /data/outer/inner/leaf where
		// /data/outer/inner is ALSO repeatable — the member's closest repeat is
		// inner, not outer, so binding it under outer skips inner.
		const xml = wrapXForm(
			`<instance><data><outer jr:template=""><inner jr:template=""><leaf/></inner></outer></data></instance><bind nodeset="/data/outer/inner/leaf"/>`,
			`<repeat nodeset="/data/outer"><input ref="/data/outer/inner/leaf"><label>L</label></input></repeat>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_REPEAT_MEMBER_SCOPE")).toBe(
			true,
		);
	});

	it("passes the canonical Vellum wrapper-group shape (collapseRepeatGroups) — THE subtle case", () => {
		// Nova emits a repeat as `<group ref="/data/X"><label/><repeat
		// nodeset="/data/X">…`: the wrapper group carries the SAME ref as the
		// repeat it wraps and holds the repeat's label. Core's
		// `collapseRepeatGroups` (XFormParser.java) collapses such a wrapper into
		// the repeat BEFORE `verifyRepeatMemberBindings`, so the wrapper group is
		// not a member binding to the repeatable node. The oracle mirrors that
		// pre-pass; without it, the group would be read as skipping the repeat and
		// falsely flagged. This is the highest-risk #22 logic — lock it directly,
		// not only via the fuzzer. (The data `<visits>` carries jr:template, i.e.
		// it IS repeatable, which is exactly what would trip a naive check.)
		const xml = wrapXForm(
			`<instance><data><visits jr:template=""><visit_date/></visits></data></instance><bind nodeset="/data/visits/visit_date"/>`,
			`<group ref="/data/visits"><label>Visits</label><repeat nodeset="/data/visits"><input ref="/data/visits/visit_date"><label>Date</label></input></repeat></group>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_REPEAT_MEMBER_SCOPE")).toBe(
			false,
		);
	});
});

// ── Defensive "Nova never emits this" branches ─────────────────────
//
// Nova's emitter structurally never produces these shapes, but the oracle
// guards them anyway (a future emitter change could regress into one). Each
// gets a minimal hand-built fixture that trips exactly its code, so every
// oracle branch is locked by a unit test — matching the positive+negative
// coverage the load-bearing invariants already carry.

describe("oracle defensive branches — every guarded code fires on its shape", () => {
	it("flags a <bind> with no nodeset (XFORM_BIND_NO_NODESET)", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind type="xsd:string"/>`,
			`<input ref="/data/q"><label>Q</label></input>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_BIND_NO_NODESET")).toBe(
			true,
		);
	});

	it("flags a non-trigger control with no ref (XFORM_CONTROL_NO_REF)", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/>`,
			`<input><label>Q</label></input>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_CONTROL_NO_REF")).toBe(
			true,
		);
	});

	it("flags a model with no main <instance> (XFORM_NO_INSTANCE)", () => {
		// A main instance is the one without `src`; a model carrying only a
		// secondary (src) instance has no data tree to resolve against.
		const xml = wrapXForm(
			`<instance src="jr://instance/casedb" id="casedb"/><bind nodeset="/data/q"/>`,
			`<input ref="/data/q"><label>Q</label></input>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_NO_INSTANCE")).toBe(true);
	});

	it("flags a select declaring both inline items and an itemset (XFORM_SELECT_ITEMS_AND_ITEMSET)", () => {
		const xml = wrapXForm(
			`<instance><data><c/></data></instance><bind nodeset="/data/c"/>`,
			`<select1 ref="/data/c"><label>C</label><item><label>A</label><value>a</value></item><itemset nodeset="instance('x')/x/item"><label ref="name"/><value ref="id"/></itemset></select1>`,
		);
		expect(
			has(validateXForm(xml, "F", "M"), "XFORM_SELECT_ITEMS_AND_ITEMSET"),
		).toBe(true);
	});

	it("flags a <setvalue> with no target ref (XFORM_SETVALUE_NO_TARGET)", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/><setvalue event="xforms-ready" value="'x'"/>`,
			`<input ref="/data/q"><label>Q</label></input>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_SETVALUE_NO_TARGET")).toBe(
			true,
		);
	});

	it("flags an <itext> block with no <translation> (XFORM_TRANSLATION_NONE)", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance><bind nodeset="/data/q"/><itext></itext>`,
			`<input ref="/data/q"><label>Q</label></input>`,
		);
		expect(has(validateXForm(xml, "F", "M"), "XFORM_TRANSLATION_NONE")).toBe(
			true,
		);
	});

	// ── #21 (extended) — `jr:constraintMsg` itext reference resolution ──
	//
	// The body-element scan (`<label ref="jr:itext(...)">`, `<hint ref>`,
	// `<help ref>`) caught every ref-borne itext lookup, but JavaRosa also
	// resolves the bind-borne `jr:constraintMsg="jr:itext('X')"` attribute
	// against the same itext table (`commcare-core .../xform/parse/
	// XFormParser.java::parseBindAttributes`). A dangling ref there parses
	// clean here while detonating at form-init — exactly the gap that
	// caused a media-only `validate_msg_media` whose registration gate
	// drifted from the bind-attribute gate to escape oracle detection.
	it("flags a <bind jr:constraintMsg> pointing at a missing itext id (XFORM_MISSING_ITEXT)", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance>` +
				`<bind nodeset="/data/q" constraint=". != ''" jr:constraintMsg="jr:itext('q-constraintMsg')"/>` +
				`<itext><translation lang="en" default=""><text id="q-label"><value>Q</value></text></translation></itext>`,
			`<input ref="/data/q"><label ref="jr:itext('q-label')"/></input>`,
		);
		const errors = validateXForm(xml, "F", "M");
		expect(
			errors.some(
				(e) =>
					e.code === "XFORM_MISSING_ITEXT" &&
					e.message.includes("q-constraintMsg"),
			),
		).toBe(true);
	});

	it("passes when <bind jr:constraintMsg> points at a registered itext id", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance>` +
				`<bind nodeset="/data/q" constraint=". != ''" jr:constraintMsg="jr:itext('q-constraintMsg')"/>` +
				`<itext><translation lang="en" default="">` +
				`<text id="q-label"><value>Q</value></text>` +
				`<text id="q-constraintMsg"><value>Required</value></text>` +
				`</translation></itext>`,
			`<input ref="/data/q"><label ref="jr:itext('q-label')"/></input>`,
		);
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});

	// ── Media-value resolution against the manifest ──────────────────
	//
	// With a manifest supplied, every `<value form="image|audio|video">jr://...`
	// itext sibling must resolve into the manifest's wire-path set, or
	// CommCare's runtime would resolve the reference to a missing bundled
	// resource and render a broken icon. Mirrors the same install-time
	// totality the manifest-aware fuzz tests assert.
	it("flags a <value form=image> jr:// path with no manifest entry (XFORM_DANGLING_MEDIA_REF)", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance>` +
				`<bind nodeset="/data/q"/>` +
				`<itext><translation lang="en" default=""><text id="q-label">` +
				`<value>Q</value>` +
				`<value form="image">jr://file/commcare/missing.png</value>` +
				`</text></translation></itext>`,
			`<input ref="/data/q"><label ref="jr:itext('q-label')"/></input>`,
		);
		// Empty manifest — the reference can't resolve.
		const errors = validateXForm(xml, "F", "M", new Set<string>());
		expect(
			errors.some(
				(e) =>
					e.code === "XFORM_DANGLING_MEDIA_REF" &&
					e.message.includes("missing.png"),
			),
		).toBe(true);
	});

	it("passes when every media <value> jr:// path resolves to a manifest entry", () => {
		const xml = wrapXForm(
			`<instance><data><q/></data></instance>` +
				`<bind nodeset="/data/q"/>` +
				`<itext><translation lang="en" default=""><text id="q-label">` +
				`<value>Q</value>` +
				`<value form="image">jr://file/commcare/abc.png</value>` +
				`<value form="audio">jr://file/commcare/def.mp3</value>` +
				`</text></translation></itext>`,
			`<input ref="/data/q"><label ref="jr:itext('q-label')"/></input>`,
		);
		const manifest = new Set(["commcare/abc.png", "commcare/def.mp3"]);
		expect(validateXForm(xml, "F", "M", manifest)).toEqual([]);
	});

	it("skips media-value resolution entirely when no manifest is supplied (media OFF)", () => {
		// A bare expanded form that carries no media-form `<value>` siblings
		// still produces no media findings — the media-OFF gate short-circuits.
		const xml = wrapXForm(
			`<instance><data><q/></data></instance>` +
				`<bind nodeset="/data/q"/>` +
				`<itext><translation lang="en" default=""><text id="q-label">` +
				`<value>Q</value>` +
				// A jr:// in a plain (non-media) `<value>` is text content, not
				// a media reference — the form attribute is what marks media.
				`</text></translation></itext>`,
			`<input ref="/data/q"><label ref="jr:itext('q-label')"/></input>`,
		);
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});
});
