import { readFileSync } from "node:fs";
import AdmZip from "adm-zip";
import render from "dom-serializer";
import { type Element, isTag } from "domhandler";
import { textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { simpleSearchInputDef } from "@/lib/domain";
import { compileCcz } from "../compiler";
import { RENDER_OPTS } from "../elementBuilders";
import {
	entryPointProjectionIssue,
	projectEntryPoint,
} from "../entryPointProjection";
import { endpointSuiteSignature } from "../entryPointSignature";
import {
	buildEntryPointSuite,
	entryPointClaimRequest,
} from "../entryPointSuite";
import { expandDoc } from "../expander";
import { formLinkProjectionContext } from "../formLinkProjection";
import { runValidation } from "../validator/runner";
import { validateSuite } from "../validator/suiteOracle";

const M = testUuid("module"),
	F = testUuid("form");
function fixture(multiple = false) {
	const doc = buildDoc({
		appName: "Links",
		modules: [
			{
				uuid: "module",
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "form",
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "notes" })],
					},
				],
			},
		],
	});
	if (multiple && doc.modules[M].caseListConfig)
		doc.modules[M].caseListConfig.selection = { kind: "multiple", maximum: 5 };
	doc.forms[F].entryPoint = { uuid: testUuid("endpoint"), id: "visit" };
	return doc;
}
function normalized(xml: string): unknown {
	const node = (e: Element): unknown => ({
		tag: e.name,
		attrs: Object.fromEntries(Object.entries(e.attribs).sort()),
		children: e.children.filter(isTag).map(node),
	});
	return parseDocument(xml, { xmlMode: true, decodeEntities: true })
		.children.filter(isTag)
		.map(node);
}
describe("entry points", () => {
	for (const multiple of [false, true])
		it(`matches the HQ ${multiple ? "multiple" : "single"} claim fixture`, () => {
			const argumentId = multiple ? "selected_cases" : "case_id";
			const expected = readFileSync(
				new URL(
					`./fixtures/session-endpoints/session_endpoint_remote_request${multiple ? "_multi_select" : ""}.xml`,
					import.meta.url,
				),
				"utf8",
			)
				.replaceAll("{endpoint_id}", "visit")
				.replaceAll("{datum_id}", argumentId);
			const emitted = entryPointClaimRequest(
				"visit",
				{
					moduleUuid: M,
					caseType: "patient",
					cardinality: multiple ? "multiple" : "one",
					maximum: multiple ? 5 : 1,
					argumentId,
				},
				"https://www.example.com/a/test-domain/phone/claim-case/",
			);
			expect(
				normalized(`<partial>${render(emitted, RENDER_OPTS)}</partial>`),
			).toEqual(normalized(expected));
		});
	it("emits the HQ follow-up endpoint with claim then navigation push", () => {
		const doc = fixture();
		const result = buildEntryPointSuite(doc, formLinkProjectionContext(doc));
		expect(normalized(render(result.endpoints[0], RENDER_OPTS))).toEqual(
			normalized(
				`<endpoint id="visit"><argument id="case_id"/><stack><push><datum id="case_id" value="$case_id"/><command value="'claim_command.visit.case_id'"/></push><push><command value="'m0'"/><datum id="case_id" value="$case_id"/><command value="'m0-f0'"/></push></stack></endpoint>`,
			),
		);
		expect(expandDoc(doc).modules[0].forms[0].session_endpoint_id).toBe(
			"visit",
		);
	});
	it("preserves multiple selection cardinality and maximum", () => {
		const p = projectEntryPoint(fixture(true), {
			kind: "form",
			moduleUuid: M,
			formUuid: F,
		});
		expect(p.requiredSelections).toEqual([
			{
				moduleUuid: M,
				caseType: "patient",
				cardinality: "multiple",
				maximum: 5,
				argumentId: "selected_cases",
			},
		]);
	});
	it("omits the final selection for a case list, and retains it for a module", () => {
		const doc = fixture();
		expect(
			projectEntryPoint(doc, { kind: "case-list", moduleUuid: M })
				.requiredSelections,
		).toEqual([]);
		expect(
			projectEntryPoint(doc, { kind: "module", moduleUuid: M })
				.requiredSelections,
		).toHaveLength(1);
	});
	it("refuses a bare case-list promise and preserves its module command", () => {
		const doc = fixture();
		delete doc.forms[F];
		doc.formOrder[M] = [];
		doc.modules[M].caseListOnly = true;
		expect(
			entryPointProjectionIssue(doc, { kind: "case-list", moduleUuid: M }),
		).toContain("module menu");
		expect(
			projectEntryPoint(doc, { kind: "module", moduleUuid: M }).frame,
		).toEqual([{ type: "command", id: "m0" }]);
	});
	it("compiles an oracle-clean endpoint and fingerprints its destination", () => {
		const doc = fixture();
		const suite = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc),
		).readAsText("suite.xml");
		expect(validateSuite(suite, new Set())).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "SUITE_ENDPOINT_INVALID" }),
			]),
		);
		const signature = endpointSuiteSignature(suite, "visit");
		expect(signature).toBeDefined();
		expect(
			endpointSuiteSignature(suite.replace('id="visit"', 'id="gone"'), "visit"),
		).toBeUndefined();
		expect(
			endpointSuiteSignature(
				suite.replace('value="$case_id"', "value=\"'different'\""),
				"visit",
			),
		).not.toBe(signature);
	});
	it("hydrates an inline known case with the HQ variable and no separate claim", () => {
		const doc = fixture();
		doc.modules[M].caseSearchConfig = { searchFirst: true };
		const config = doc.modules[M].caseListConfig;
		if (!config) throw new Error("Missing fixture config");
		config.searchInputs = [
			simpleSearchInputDef(
				testUuid("search"),
				"case_name",
				"Name",
				"text",
				"case_name",
			),
		];
		const result = buildEntryPointSuite(doc, formLinkProjectionContext(doc));
		const xml = render(result.endpoints[0], RENDER_OPTS);
		expect(result.remoteRequests).toHaveLength(0);
		expect(xml).toContain('ref="$case_id"');
		expect(xml).toContain("/phone/case_fixture/");
		expect(
			entryPointProjectionIssue(doc, { kind: "case-list", moduleUuid: M }),
		).toContain("unbound");
		const suite = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc),
		).readAsText("suite.xml");
		expect(endpointSuiteSignature(suite, "visit")).toBeDefined();
	});
	it("keeps registration computed datums runtime owned and form bypass explicit", () => {
		const doc = fixture();
		doc.forms[F].type = "registration";
		const field = doc.fields[doc.fieldOrder[F][0]];
		if (field.kind !== "text")
			throw new Error("Expected the text fixture field");
		field.caseWrite = { caseType: "patient", property: "case_name" };
		doc.forms[F].entryPoint = {
			uuid: testUuid("endpoint"),
			id: "visit",
			ignoreDisplayConditions: true,
		};
		const result = buildEntryPointSuite(doc, formLinkProjectionContext(doc));
		const xml = render(result.endpoints[0], RENDER_OPTS);
		expect(xml).toContain('respect-relevancy="false"');
		expect(xml).not.toContain("<argument");
		expect(xml).not.toContain("<datum");
		expect(expandDoc(doc).modules[0].forms[0].respect_relevancy).toBe(false);
	});
	it("refuses no-matches registration regardless of display bypass", () => {
		const doc = fixture();
		doc.forms[F].type = "registration";
		doc.forms[F].entry = { kind: "search-no-matches" };
		expect(
			entryPointProjectionIssue(doc, {
				kind: "form",
				moduleUuid: M,
				formUuid: F,
			}),
		).toContain("empty search");
	});
	it("rejects malformed or multiply rooted released suites", () => {
		expect(
			endpointSuiteSignature('<suite><endpoint id="visit"></suite>', "visit"),
		).toBeUndefined();
		expect(endpointSuiteSignature("<suite/><suite/>", "visit")).toBeUndefined();
	});
	it("gate rejects duplicate external IDs", () => {
		const doc = fixture();
		doc.modules[M].entryPoint = {
			uuid: testUuid("module-endpoint"),
			id: "visit",
		};
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((e) => e.code),
		).toContain("ENTRY_POINT_INVALID");
	});

	it("matches the HQ nested child form partial and binds both selections", () => {
		const doc = buildDoc({
			appName: "Families",
			caseTypes: [
				{ name: "mother", properties: [] },
				{ name: "baby", parent_type: "mother", properties: [] },
			],
			modules: [
				{
					uuid: "mother-module",
					name: "Mothers",
					caseType: "mother",
					forms: [
						{
							uuid: "mother-form",
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									caseWrite: { caseType: "mother", property: "case_name" },
								}),
							],
						},
					],
				},
				{
					uuid: "baby-module",
					name: "Babies",
					caseType: "baby",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "baby-form",
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "notes" })],
						},
					],
				},
			],
		});
		const mother = testUuid("mother-module"),
			baby = testUuid("baby-module"),
			form = testUuid("baby-form");
		doc.modules[baby].parentModuleUuid = mother;
		doc.forms[form].entryPoint = { uuid: testUuid("baby-link"), id: "my_form" };
		const result = buildEntryPointSuite(doc, formLinkProjectionContext(doc));
		expect(normalized(render(result.endpoints[0], RENDER_OPTS))).toEqual(
			normalized(
				`<endpoint id="my_form"><argument id="parent_id"/><argument id="case_id"/><stack><push><datum id="parent_id" value="$parent_id"/><command value="'claim_command.my_form.parent_id'"/></push><push><datum id="case_id" value="$case_id"/><command value="'claim_command.my_form.case_id'"/></push><push><command value="'m0'"/><command value="'m1'"/><datum id="parent_id" value="$parent_id"/><datum id="case_id" value="$case_id"/><command value="'m1-f0'"/></push></stack></endpoint>`,
			),
		);
	});
	it("accepts HQ claim fixture bytes in the same released navigation closure", () => {
		const doc = fixture();
		const target = {
			server: "production" as const,
			domain: "test-domain",
			appId: "working",
		};
		const suite = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, { runtimeTarget: target }),
		).readAsText("suite.xml");
		const tree = parseDocument(suite, { xmlMode: true });
		const root = tree.children.filter(isTag)[0];
		const hqXml = readFileSync(
			new URL(
				"./fixtures/session-endpoints/session_endpoint_remote_request.xml",
				import.meta.url,
			),
			"utf8",
		)
			.replaceAll("{endpoint_id}", "visit")
			.replaceAll("{datum_id}", "case_id")
			.replaceAll("https://www.example.com", "https://www.commcarehq.org");
		const partial = parseDocument(hqXml, { xmlMode: true }).children.filter(
			isTag,
		)[0];
		const request = partial.children.filter(isTag)[0];
		const old = root.children.findIndex(
			(node) => isTag(node) && node.name === "remote-request",
		);
		root.children[old] = request;
		expect(endpointSuiteSignature(render(root, RENDER_OPTS), "visit")).toBe(
			endpointSuiteSignature(suite, "visit"),
		);
	});
	it("normalizes only approved app identities in runtime URLs, preserving server and domain", () => {
		const doc = fixture();
		doc.modules[M].caseSearchConfig = { searchFirst: true };
		const config = doc.modules[M].caseListConfig;
		if (!config) throw new Error("Missing fixture config");
		config.searchInputs = [
			simpleSearchInputDef(
				testUuid("search"),
				"case_name",
				"Name",
				"text",
				"case_name",
			),
		];
		const suite = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: {
					server: "production",
					domain: "test-domain",
					appId: "working",
				},
			}),
		).readAsText("suite.xml");
		const released = suite.replaceAll("/working/", "/released/");
		const expected = endpointSuiteSignature(suite, "visit", {
			appIds: ["working"],
		});
		expect(
			endpointSuiteSignature(released, "visit", { appIds: ["released"] }),
		).toBe(expected);
		expect(
			endpointSuiteSignature(released, "visit", { appIds: ["other"] }),
		).not.toBe(expected);
		expect(
			endpointSuiteSignature(
				released.replaceAll("www.commcarehq.org", "india.commcarehq.org"),
				"visit",
				{ appIds: ["released"] },
			),
		).not.toBe(expected);
	});
	it("accepts the upstream inline entry and optional HQ search-title omission", () => {
		const doc = fixture();
		doc.forms[F].postSubmit = "app_home";
		doc.modules[M].caseSearchConfig = { searchFirst: true };
		const config = doc.modules[M].caseListConfig;
		if (!config) throw new Error("Missing fixture config");
		config.searchInputs = [
			simpleSearchInputDef(
				testUuid("search"),
				"case_name",
				"Name",
				"text",
				"case_name",
			),
		];
		const suite = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: {
					server: "production",
					domain: "test-domain",
					appId: "working",
				},
			}),
		).readAsText("suite.xml");
		const tree = parseDocument(suite, { xmlMode: true });
		const root = tree.children.filter(isTag)[0];
		const oldIndex = root.children.findIndex(
			(node) => isTag(node) && node.name === "entry",
		);
		const old = root.children[oldIndex];
		if (!isTag(old)) throw new Error("Missing entry");
		const form = old.children
			.filter(isTag)
			.find((node) => node.name === "form");
		if (!form) throw new Error("Missing form");
		const upstream = readFileSync(
			new URL("./fixtures/session-endpoints/inline-entry.xml", import.meta.url),
			"utf8",
		).replace("{form_xmlns}", textContent(form));
		const actual = parseDocument(upstream, { xmlMode: true }).children.filter(
			isTag,
		)[0];
		root.children[oldIndex] = actual;
		const options = { appIds: ["working", "released"] };
		const expected = endpointSuiteSignature(suite, "visit", options);
		expect(
			endpointSuiteSignature(render(root, RENDER_OPTS), "visit", options),
		).toBe(expected);
		const session = actual.children
			.filter(isTag)
			.find((node) => node.name === "session");
		const query = session?.children
			.filter(isTag)
			.find((node) => node.name === "query");
		if (!query) throw new Error("Missing query");
		query.children = query.children.filter(
			(node) => !isTag(node) || node.name !== "title",
		);
		expect(
			endpointSuiteSignature(render(root, RENDER_OPTS), "visit", options),
		).toBe(expected);
		query.attribs.url = query.attribs.url.replace(
			"test-domain",
			"other-domain",
		);
		expect(
			endpointSuiteSignature(render(root, RENDER_OPTS), "visit", options),
		).not.toBe(expected);
	});
});
