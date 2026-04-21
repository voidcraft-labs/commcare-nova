import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";

// The compiler consumes the domain doc directly — we build the fixture
// via the shared DSL, expand it to HQ JSON with `expandDoc`, and feed
// both into `compileCcz`. Tests below assert archive-level invariants
// (present files, case-block injection, suite.xml structure).
const doc = buildDoc({
	appName: "CHW App",
	modules: [
		{
			name: "Patients",
			caseType: "patient",
			caseListColumns: [{ field: "age", header: "Age" }],
			forms: [
				{
					name: "Register",
					type: "registration",
					fields: [
						f({
							kind: "text",
							id: "case_name",
							label: "Name",
							case_property: "patient",
						}),
						f({
							kind: "int",
							id: "age",
							label: "Age",
							case_property: "patient",
						}),
					],
				},
				{
					name: "Visit",
					type: "followup",
					fields: [
						f({
							kind: "hidden",
							id: "total_visits",
							calculate: "#case/total_visits + 1",
							case_property: "patient",
						}),
						f({ kind: "text", id: "notes", label: "Notes" }),
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
				{ name: "total_visits", label: "Total Visits" },
			],
		},
	],
});

describe("compileCcz", () => {
	it("produces a valid zip with expected files", () => {
		const hq = expandDoc(doc);
		const buf = compileCcz(hq, "CHW App", doc);
		const zip = new AdmZip(buf);
		const entries = zip
			.getEntries()
			.map((e) => e.entryName)
			.sort();

		expect(entries).toContain("suite.xml");
		expect(entries).toContain("profile.ccpr");
		expect(entries).toContain("default/app_strings.txt");
		// One XForm per form
		expect(
			entries.filter((e) => e.match(/modules-\d+\/forms-\d+\.xml/)),
		).toHaveLength(2);
	});

	it("injects case create block into registration XForms", () => {
		const hq = expandDoc(doc);
		const buf = compileCcz(hq, "CHW App", doc);
		const zip = new AdmZip(buf);
		const regXform = zip.readAsText("modules-0/forms-0.xml");

		expect(regXform).toContain("<create>");
		expect(regXform).toContain("<case_type/>");
		expect(regXform).toContain("<case_name/>");
		expect(regXform).toContain("calculate=\"'patient'\""); // case type bind
	});

	it("injects case update block into followup XForms", () => {
		const hq = expandDoc(doc);
		const buf = compileCcz(hq, "CHW App", doc);
		const zip = new AdmZip(buf);
		const followupXform = zip.readAsText("modules-0/forms-1.xml");

		expect(followupXform).toContain("<update>");
		expect(followupXform).toContain("<total_visits/>");
		expect(followupXform).not.toContain("<create>"); // followup should not create
	});

	it("post-injection validation catches orphaned binds", () => {
		const hq = expandDoc(doc);

		// Sabotage: inject a bind that points to a node we never create.
		const formId = hq.modules[0].forms[0].unique_id;
		const xml = hq._attachments[`${formId}.xml`];
		hq._attachments[`${formId}.xml`] = xml.replace(
			"</model>",
			'      <bind nodeset="/data/meta/location" type="xsd:geopoint"/>\n    </model>',
		);

		expect(() => compileCcz(hq, "CHW App", doc)).toThrow(
			/XForm validation failed[\s\S]*\/data\/meta\/location/,
		);
	});

	it("generates suite.xml with case detail and menu entries", () => {
		const hq = expandDoc(doc);
		const buf = compileCcz(hq, "CHW App", doc);
		const zip = new AdmZip(buf);
		const suite = zip.readAsText("suite.xml");

		expect(suite).toContain('<menu id="m0">');
		expect(suite).toContain('<command id="m0-f0"/>');
		expect(suite).toContain('<command id="m0-f1"/>');
		expect(suite).toContain('<detail id="m0_case_short">');
		expect(suite).toContain("@case_type='patient'");
	});

	// The compiler must still package a valid archive when a form carries
	// zero fields — this shape appears while the SA is mid-scaffold and a
	// dropped archive would crash the preview + upload path. No case blocks
	// are injected because the form is a survey; only the shell + suite
	// references should appear.
	it("compiles a survey module whose form has zero fields", () => {
		const emptyDoc = buildDoc({
			appName: "Stub",
			modules: [
				{ name: "M", forms: [{ name: "F", type: "survey", fields: [] }] },
			],
		});
		const hq = expandDoc(emptyDoc);
		const buf = compileCcz(hq, "Stub", emptyDoc);
		const zip = new AdmZip(buf);

		// Archive shell is present.
		expect(zip.readAsText("profile.ccpr")).toContain("Stub");
		// Single menu entry with one empty-form command — suite.xml still
		// wires the form even though the XForm body is empty.
		const suite = zip.readAsText("suite.xml");
		expect(suite).toContain('<menu id="m0">');
		expect(suite).toContain('<command id="m0-f0"/>');
		// The form XML is present and structurally empty.
		const xform = zip.readAsText("modules-0/forms-0.xml");
		expect(xform).toContain("<h:body>");
		expect(xform).not.toMatch(/<bind[^/]*\/>/);
	});
});
