// A Search field named with a hyphen. The plausible failure is a key and its
// read disagreeing: the prompt's `key`, the query's read of the answer, the
// locale id of its label and a form's `#search/` read each spelling the name
// on their own. The compiled app passes every oracle, and each place is read
// from the archive.

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { checkCompilerEvidence } from "@/lib/commcare/__tests__/compilerEvidence";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
import {
	readXmlEvidence,
	type XmlEvidence,
} from "@/lib/commcare/__tests__/xmlEvidence";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import {
	NEW_APP_SETTINGS,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, input, literal, term } from "@/lib/domain/expression";

const FIRST_NAME = testUuid("hyphenated-search-first-name");
const CARRIED = testUuid("hyphenated-search-carried");

function hyphenatedSearchDoc() {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [
		simpleSearchInputDef(
			FIRST_NAME,
			"first-name",
			"First name",
			"text",
			"first-name",
		),
		{
			...simpleSearchInputDef(
				testUuid("hyphenated-search-case-name"),
				"case_name",
				"Name",
				"text",
				"case_name",
			),
			// Required while the first name is blank: the prompt's own test
			// reads the hyphenated answer back by its key.
			required: { when: eq(input(FIRST_NAME), literal("")) },
		},
	];
	return buildDoc({
		appName: "Hyphenated search",
		// A menu whose forms read the search runs in Web Apps alone.
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "first-name", label: proseText("First name") },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				caseSearchConfig: { formsReadSearch: true },
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								uuid: CARRIED,
								id: "searched_name",
								calculate: term(input(FIRST_NAME)),
							}),
						],
					},
				],
			},
		],
	});
}

/** Every element under `node` named `name`, in document order. */
function descendants(node: XmlEvidence, name: string): XmlEvidence[] {
	return node.children.flatMap((child) => [
		...(child.name === name ? [child] : []),
		...descendants(child, name),
	]);
}

describe("a Search field named with a hyphen", () => {
	it("passes every oracle, and its key, its reads and its locale id hold the name", () => {
		const doc = hyphenatedSearchDoc();
		checkCompilerEvidence(doc);

		const hq = expandDoc(doc);
		const zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		);
		const read = (path: string) => {
			const entry = zip.getEntry(path);
			if (!entry) throw new Error(`The archive has no ${path}.`);
			return entry.getData().toString("utf8");
		};
		const suiteXml = read("suite.xml");
		const suite = readXmlEvidence(suiteXml);

		const prompts = descendants(suite, "prompt");
		expect(prompts.map((prompt) => prompt.attributes.key)).toEqual([
			"first-name",
			"case_name",
		]);
		const [prompt] = prompts;
		const localeIds = descendants(prompt, "locale").map(
			(locale) => locale.attributes.id,
		);
		expect(localeIds).toContain("search_property.m0.first-name");
		expect(read("default/app_strings.txt")).toContain(
			"search_property.m0.first-name=First name",
		);

		// The search runs inline (the menu's forms read it), so its answers
		// sit in the inline search's input instance.
		const answerRead =
			"instance('search-input:results:inline')/input/field[@name = 'first-name']";
		const requiredTests = descendants(prompts[1], "required").map(
			(required) => required.attributes.test,
		);
		expect(requiredTests.join(" ")).toContain(answerRead);

		const visit = Object.entries(hq._attachments).find(([path]) =>
			path.endsWith(".xml"),
		)?.[1];
		if (typeof visit !== "string") throw new Error("No source for Visit.");
		const calculates = descendants(readXmlEvidence(visit), "bind").map(
			(bind) => bind.attributes.calculate ?? "",
		);
		expect(calculates.join(" ")).toContain(answerRead);
	});
});
