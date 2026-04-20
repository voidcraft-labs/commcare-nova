import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import type { AppBlueprint } from "@/lib/doc/legacyTypes";
import { CczCompiler } from "../cczCompiler";
import { expandBlueprint } from "../hqJsonExpander";
import { q } from "./wireFixtures";

const blueprint: AppBlueprint = {
	app_name: "CHW App",
	modules: [
		{
			uuid: "module-1-uuid",
			name: "Patients",
			case_type: "patient",
			forms: [
				{
					uuid: "form-1-uuid",
					name: "Register",
					type: "registration",
					questions: [
						q({
							id: "case_name",
							type: "text",
							label: "Name",
							case_property_on: "patient",
						}),
						q({
							id: "age",
							type: "int",
							label: "Age",
							case_property_on: "patient",
						}),
					],
				},
				{
					uuid: "form-2-uuid",
					name: "Visit",
					type: "followup",
					questions: [
						q({
							id: "total_visits",
							type: "hidden",
							calculate: "#case/total_visits + 1",
							case_property_on: "patient",
						}),
						q({ id: "notes", type: "text", label: "Notes" }),
					],
				},
			],
			case_list_columns: [{ field: "age", header: "Age" }],
		},
	],
	case_types: [
		{
			name: "patient",
			properties: [
				{ name: "case_name", label: "Name" },
				{ name: "age", label: "Age" },
				{ name: "total_visits", label: "Total Visits" },
			],
		},
	],
};

describe("CczCompiler", () => {
	it("produces a valid zip with expected files", async () => {
		const hq = expandBlueprint(blueprint);
		const buf = await new CczCompiler().compile(hq, "CHW App", blueprint);
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

	it("injects case create block into registration XForms", async () => {
		const hq = expandBlueprint(blueprint);
		const buf = await new CczCompiler().compile(hq, "CHW App", blueprint);
		const zip = new AdmZip(buf);
		const regXform = zip.readAsText("modules-0/forms-0.xml");

		expect(regXform).toContain("<create>");
		expect(regXform).toContain("<case_type/>");
		expect(regXform).toContain("<case_name/>");
		expect(regXform).toContain("calculate=\"'patient'\""); // case type bind
	});

	it("injects case update block into followup XForms", async () => {
		const hq = expandBlueprint(blueprint);
		const buf = await new CczCompiler().compile(hq, "CHW App", blueprint);
		const zip = new AdmZip(buf);
		const followupXform = zip.readAsText("modules-0/forms-1.xml");

		expect(followupXform).toContain("<update>");
		expect(followupXform).toContain("<total_visits/>");
		expect(followupXform).not.toContain("<create>"); // followup should not create
	});

	it("post-injection validation catches orphaned binds", async () => {
		const hq = expandBlueprint(blueprint);

		// Sabotage: inject a bind that points to a node we never create
		const formId = hq.modules[0].forms[0].unique_id;
		hq._attachments[`${formId}.xml`] += ""; // ensure it exists
		const xml = hq._attachments[`${formId}.xml`] as string;
		hq._attachments[`${formId}.xml`] = xml.replace(
			"</model>",
			'      <bind nodeset="/data/meta/location" type="xsd:geopoint"/>\n    </model>',
		);

		const err = await new CczCompiler()
			.compile(hq, "CHW App", blueprint)
			.catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toContain("/data/meta/location");
		expect(err.message).toContain("XForm validation failed");
	});

	it("generates suite.xml with case detail and menu entries", async () => {
		const hq = expandBlueprint(blueprint);
		const buf = await new CczCompiler().compile(hq, "CHW App", blueprint);
		const zip = new AdmZip(buf);
		const suite = zip.readAsText("suite.xml");

		expect(suite).toContain('<menu id="m0">');
		expect(suite).toContain('<command id="m0-f0"/>');
		expect(suite).toContain('<command id="m0-f1"/>');
		expect(suite).toContain('<detail id="m0_case_short">');
		expect(suite).toContain("@case_type='patient'");
	});
});
