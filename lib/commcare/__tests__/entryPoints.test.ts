import { readFileSync } from "node:fs";
import type { SyntaxNode } from "@lezer/common";
import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { parser } from "@/lib/commcare/xpath";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import { compileCcz } from "../compiler";
import {
	entryPointProjectionIssue,
	projectEntryPoint,
} from "../entryPointProjection";
import {
	endpointSignaturesMatch,
	endpointSuiteSignature,
} from "../entryPointSignature";
import {
	buildEntryPointSuite,
	entryPointClaimRequest,
} from "../entryPointSuite";
import { expandDoc } from "../expander";
import { formLinkProjectionContext } from "../formLinkProjection";
import { runValidation } from "../validator/runner";
import { validateSuite } from "../validator/suiteOracle";
import {
	endpointScenarios,
	endpointWireFixture,
	ENDPOINT_FORM as F,
	ENDPOINT_MODULE as M,
} from "./endpointWireFixture";
import preWireSignature from "./fixtures/session-endpoints/pre-wire-signature.json";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

function fixture(multiple = false) {
	return endpointWireFixture(multiple ? "multiple" : "single");
}
function admitted(doc: ReturnType<typeof fixture>) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
}
function normalized(xml: string): unknown {
	// Compare the upstream fixture's expression structure independently of the
	// production serializer. Whitespace and quote choice are not wire meaning.
	const xpath = (source: string): unknown => {
		const tree = parser.parse(source);
		const node = (part: SyntaxNode): unknown => {
			if (part.type.isError)
				throw new Error(`Invalid fixture XPath: ${source}`);
			const children: unknown[] = [];
			for (let child = part.firstChild; child; child = child.nextSibling) {
				if (!["(", ")", ","].includes(child.name)) children.push(node(child));
			}
			const text = source.slice(part.from, part.to);
			return {
				kind: part.name,
				...(part.firstChild !== null
					? { children }
					: {
							value: part.name === "StringLiteral" ? text.slice(1, -1) : text,
						}),
			};
		};
		return node(tree.topNode);
	};
	const xpathAttribute = (element: Element, name: string): boolean =>
		["relevant", "ref", "nodeset", "function", "exclude", "if"].includes(
			name,
		) ||
		(name === "value" &&
			[
				"datum",
				"instance-datum",
				"command",
				"create",
				"push",
				"clear",
				"rewind",
			].includes(element.name));
	const node = (e: Element): unknown => ({
		tag: e.name,
		text: e.children.some(isTag) ? "" : textContent(e),
		attrs: Object.fromEntries(
			Object.entries(e.attribs)
				.sort()
				.map(([name, value]) => [
					name,
					xpathAttribute(e, name) ? xpath(value) : value,
				]),
		),
		children: e.children.filter(isTag).map(node),
	});
	return parseDocument(xml, { xmlMode: true, decodeEntities: true })
		.children.filter(isTag)
		.map(node);
}
describe("entry points", () => {
	for (const multiple of [false, true])
		it(`matches the historical HQ ${multiple ? "multiple" : "single"} claim fixture`, () => {
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
			expect(normalized(`<partial>${serializeXml(emitted)}</partial>`)).toEqual(
				normalized(expected),
			);
			const declarations = emitted.children
				.filter(isTag)
				.filter((e) => e.name === "instance");
			expect(declarations.map((e) => e.attribs.id)).toEqual([
				"casedb",
				"commcaresession",
				...(multiple ? [argumentId] : []),
			]);
			const suite = () => `<suite version="1">${serializeXml(emitted)}</suite>`;
			expect(validateSuite(suite(), new Set())).toEqual([]);
			emitted.children = emitted.children.filter(
				(child) => child !== declarations[0],
			);
			expect(
				validateSuite(suite(), new Set()).map((error) => error.code),
			).toContain("SUITE_MISSING_INSTANCE");
		});
	it("emits the HQ follow-up endpoint with claim then navigation push", () => {
		const doc = fixture();
		const result = buildEntryPointSuite(doc, formLinkProjectionContext(doc));
		expect(normalized(serializeXml(result.endpoints[0]))).toEqual(
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
	it("keeps collection declarations scoped to reads and refuses an old extra declaration", () => {
		const doc = fixture(true);
		const suite = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		).readAsText("suite.xml");
		const root = parseDocument(suite, { xmlMode: true }).children.filter(
			isTag,
		)[0];
		const entry = root.children
			.filter(isTag)
			.find((element) => element.name === "entry");
		const claim = root.children
			.filter(isTag)
			.find((element) => element.name === "remote-request");
		if (!entry || !claim)
			throw new Error("Missing collection endpoint fixture scopes");
		const declarations = (element: Element) =>
			element.children
				.filter(isTag)
				.filter((child) => child.name === "instance")
				.map((child) => child.attribs.id);
		// Pinned HQ's InstancesHelper adds declarations from expressions, not
		// from an instance-datum's id. Selection produces the collection; only
		// the claim's post/data nodeset reads its virtual selected_cases instance.
		expect(declarations(entry)).toEqual(["casedb"]);
		expect(declarations(claim)).toEqual([
			"casedb",
			"commcaresession",
			"selected_cases",
		]);
		const published = endpointSuiteSignature(suite, "visit");
		if (published === undefined)
			throw new Error("Missing collection endpoint signature");
		const oldExtra = parseDocument(
			'<instance id="selected_cases" src="jr://instance/selected-entities/selected_cases"/>',
			{ xmlMode: true },
		).children.filter(isTag)[0];
		const sessionIndex = entry.children.findIndex(
			(child) => isTag(child) && child.name === "session",
		);
		entry.children.splice(sessionIndex, 0, oldExtra);
		expect(
			endpointSignaturesMatch(
				endpointSuiteSignature(serializeXml(root), "visit"),
				published,
			),
		).toBe(false);
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
		for (const uuid of doc.fieldOrder[F]) delete doc.fields[uuid];
		delete doc.fieldOrder[F];
		delete doc.forms[F];
		doc.formOrder[M] = [];
		doc.modules[M].caseListOnly = true;
		admitted(doc);
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
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
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
		const doc = endpointWireFixture("inline");
		const result = buildEntryPointSuite(doc, formLinkProjectionContext(doc));
		const xml = serializeXml(result.endpoints[0]);
		expect(result.remoteRequests).toHaveLength(0);
		expect(xml).toContain('ref="$case_id"');
		expect(xml).toContain("/phone/case_fixture/");
		expect(
			entryPointProjectionIssue(doc, { kind: "case-list", moduleUuid: M }),
		).toContain("unbound");
		const suite = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		).readAsText("suite.xml");
		expect(endpointSuiteSignature(suite, "visit")).toBeDefined();
	});
	it("keeps registration computed datums runtime owned and form bypass explicit", () => {
		const doc = endpointWireFixture("registration");
		const result = buildEntryPointSuite(doc, formLinkProjectionContext(doc));
		const xml = serializeXml(result.endpoints[0]);
		expect(xml).toContain('respect-relevancy="false"');
		expect(xml).not.toContain("<argument");
		expect(xml).not.toContain("<datum");
		expect(expandDoc(doc).modules[0].forms[0].respect_relevancy).toBe(false);
	});
	it("refuses no-matches registration regardless of display bypass", () => {
		const doc = endpointWireFixture("registration");
		doc.forms[F].entry = { kind: "search-no-matches" };
		expect(
			entryPointProjectionIssue(doc, {
				kind: "form",
				moduleUuid: M,
				formUuid: F,
			}),
		).toContain("empty search");
	});
	it.each(endpointScenarios)(
		"compiles the admitted %s fixture used by native HQ and Core proofs",
		(scenario) => {
			const doc = endpointWireFixture(scenario);
			const suite = new AdmZip(
				compileCcz(expandDoc(doc), doc.appName, doc, {
					runtimeTarget: TEST_RUNTIME_TARGET,
				}),
			).readAsText("suite.xml");
			expect(endpointSuiteSignature(suite, "visit")).toBeDefined();
		},
	);
	it.each([
		"endpoint",
		"claim",
		"entry",
		"form-namespace",
		"claim-filter",
		"selection-filter",
	])("released closure detects %s corruption", (corruption) => {
		const doc = fixture();
		const suite = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		).readAsText("suite.xml");
		const root = parseDocument(suite, { xmlMode: true }).children.filter(
			isTag,
		)[0];
		const children = (e: Element) => e.children.filter(isTag);
		const endpoint = children(root).find((e) => e.name === "endpoint"),
			claim = children(root).find((e) => e.name === "remote-request"),
			entry = children(root).find((e) => e.name === "entry");
		if (!endpoint || !claim || !entry) throw new Error("Missing fixture wire");
		if (corruption === "endpoint") root.children.push(endpoint);
		else if (corruption === "claim")
			root.children = root.children.filter((e) => e !== claim);
		else if (corruption === "entry")
			root.children = root.children.filter((e) => e !== entry);
		else if (corruption === "form-namespace") {
			const form = children(entry).find((e) => e.name === "form");
			if (!form) throw new Error("Missing form");
			form.children = parseDocument("different-namespace", {
				xmlMode: true,
			}).children;
		} else if (corruption === "claim-filter") {
			const post = children(claim).find((e) => e.name === "post");
			if (!post) throw new Error("Missing claim post");
			post.attribs.relevant = "false()";
		} else {
			const session = children(entry).find((e) => e.name === "session"),
				datum = session && children(session).find((e) => e.name === "datum");
			if (!datum) throw new Error("Missing selection");
			datum.attribs.nodeset = "instance('casedb')/casedb/case[false()]";
		}
		const changed = endpointSuiteSignature(serializeXml(root), "visit");
		if (["endpoint", "claim", "entry"].includes(corruption))
			expect(changed).toBeUndefined();
		else {
			expect(changed).toBeDefined();
			expect(changed).not.toBe(endpointSuiteSignature(suite, "visit"));
		}
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

	it.each([
		["intake_", "edge", "intake"],
		["-intake", "edge", "intake"],
		["in--take", "doubled-hyphen", "in-take"],
	])(
		"refuses the ID %j CommCare HQ won't save, offering a free one",
		(id, problem, free) => {
			const doc = fixture();
			doc.modules[M].entryPoint = { uuid: testUuid("module-endpoint"), id };
			const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
			expect(findings).toHaveLength(1);
			expect(findings[0]).toMatchObject({
				code: "ENTRY_POINT_INVALID",
				details: {
					entryPointUuid: testUuid("module-endpoint"),
					reason: "id-format",
					problem,
					suggestedId: free,
				},
			});
			expect(findings[0]?.message).toContain(`"${free}" is free here.`);
			doc.modules[M].entryPoint = {
				uuid: testUuid("module-endpoint"),
				id: free,
			};
			admitted(doc);
		},
	);

	it("matches the HQ nested child form partial and binds both selections", () => {
		const doc = endpointWireFixture("child");
		const result = buildEntryPointSuite(doc, formLinkProjectionContext(doc));
		expect(normalized(serializeXml(result.endpoints[0]))).toEqual(
			normalized(
				`<endpoint id="visit"><argument id="parent_id"/><argument id="case_id"/><stack><push><datum id="parent_id" value="$parent_id"/><command value="'claim_command.visit.parent_id'"/></push><push><datum id="case_id" value="$case_id"/><command value="'claim_command.visit.case_id'"/></push><push><command value="'m0'"/><command value="'m1'"/><datum id="parent_id" value="$parent_id"/><datum id="case_id" value="$case_id"/><command value="'m1-f0'"/></push></stack></endpoint>`,
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
		const published = endpointSuiteSignature(suite, "visit");
		if (published === undefined)
			throw new Error("Missing published fixture signature");
		expect(
			endpointSignaturesMatch(
				endpointSuiteSignature(serializeXml(root), "visit"),
				published,
			),
		).toBe(true);
	});
	it("normalizes only approved app identities in runtime URLs, preserving server and domain", () => {
		const doc = endpointWireFixture("inline");
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
	it("compares a persisted pre-wire signature with the canonical current suite", () => {
		const doc = fixture();
		const suite = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: {
					server: "production",
					domain: "nova-proof",
					appId: "working",
				},
			}),
		).readAsText("suite.xml");
		const current = endpointSuiteSignature(suite, "visit");
		expect(current).not.toBe(preWireSignature.signature);
		expect(endpointSignaturesMatch(current, preWireSignature.signature)).toBe(
			true,
		);
		for (const corrupted of [
			suite.replaceAll("&apos;patient&apos;", "&apos;patient &apos;"),
			suite.replace("]) = 0", "]) != 0"),
			suite.replaceAll("/nova-proof/", "/another-space/"),
			suite.replace('id="claim_command.visit.case_id"', 'id="missing-claim"'),
		]) {
			expect(corrupted).not.toBe(suite);
			expect(
				endpointSignaturesMatch(
					endpointSuiteSignature(corrupted, "visit"),
					preWireSignature.signature,
				),
			).toBe(false);
		}
	});
	it("ignores XPath spelling whitespace and quote choice while retaining operand grouping", () => {
		const published = preWireSignature.signature;
		const spaced = published.replace(
			"count(instance('casedb')",
			"count ( instance ( 'casedb' ) ",
		);
		const quoted = published.replaceAll("'casedb'", '\\"casedb\\"');
		expect(endpointSignaturesMatch(spaced, published)).toBe(true);
		expect(endpointSignaturesMatch(quoted, published)).toBe(true);
		const left = published.replace("]) = 0", "]) = 1 + 2 * 3");
		const right = published.replace("]) = 0", "]) = (1 + 2) * 3");
		expect(endpointSignaturesMatch(left, right)).toBe(false);
	});
	it("refuses malformed and unknown stored signature shapes even when both sides agree", () => {
		const signature = preWireSignature.signature;
		for (const invalid of [
			"not-json",
			"{}",
			signature.replace('"endpoint":{', '"unknown":true,"endpoint":{'),
			signature.replace('"tag":"endpoint"', '"tag":"unknown"'),
			signature.replace('"attributes":{}', '"attributes":[]'),
			signature.replace("count(instance", "count[instance"),
		]) {
			expect(invalid).not.toBe(signature);
			expect(endpointSignaturesMatch(invalid, invalid)).toBe(false);
		}
		expect(endpointSignaturesMatch(undefined, signature)).toBe(false);
	});
	it("accepts historical inline entry bytes and optional presentation omission", () => {
		const doc = endpointWireFixture("inline");
		doc.forms[F].postSubmit = "app_home";
		admitted(doc);
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
		if (expected === undefined)
			throw new Error("Missing published fixture signature");
		expect(
			endpointSignaturesMatch(
				endpointSuiteSignature(serializeXml(root), "visit", options),
				expected,
			),
		).toBe(true);
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
			endpointSignaturesMatch(
				endpointSuiteSignature(serializeXml(root), "visit", options),
				expected,
			),
		).toBe(true);
		query.attribs.url = query.attribs.url.replace(
			"test-domain",
			"other-domain",
		);
		expect(
			endpointSuiteSignature(serializeXml(root), "visit", options),
		).not.toBe(expected);
	});
});
