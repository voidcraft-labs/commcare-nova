import { COMMCARE_SERVER_IDS, COMMCARE_SERVERS } from "@/lib/commcare/servers";
/**
 * The inline (search-first) suite shape, pinned to CommCare HQ's own
 * oracle `corehq/apps/app_manager/tests/test_suite_inline_search.py`
 * (`InlineSearchSuiteTest`). Each `it` quotes one of that file's inline
 * `assertXmlPartialEqual` partials verbatim, with HQ's local URLs replaced
 * by Nova's URL templates and its `name` prompt spelled `first_name`
 * (`name` is a reserved property spelling in Nova), and compares structurally: element names,
 * attribute maps, and child order, with text and attribute order ignored
 * (the serializer escapes `'` as `&apos;`; the partials use the literal).
 *
 * The negatives are HQ's `assertXmlDoesNotHaveXpath` calls: no
 * `<remote-request>`, no `m0_search_*` details, and no `<action>` on the
 * case list.
 */

import AdmZip from "adm-zip";
import { type ChildNode, type Element, isTag } from "domhandler";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { CASE_FIXTURE_URL_TEMPLATE } from "@/lib/commcare/formLinkProjection";
import { CLAIM_URL_TEMPLATE } from "@/lib/commcare/suite/case-search/claim";
import { SEARCH_URL_TEMPLATE } from "@/lib/commcare/suite/case-search/searchSession";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseListConfig } from "@/lib/domain";
import {
	advancedSearchInputDef,
	calculatedColumn,
	hiddenSearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	eq,
	input,
	prop,
	relationStep,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

// ── Structural comparison ────────────────────────────────────────────

interface Shape {
	readonly name: string;
	readonly attribs: Readonly<Record<string, string>>;
	readonly children: readonly Shape[];
}

function shapeOf(element: Element): Shape {
	return {
		name: element.name,
		attribs: Object.fromEntries(
			Object.entries(element.attribs).sort(([a], [b]) => a.localeCompare(b)),
		),
		children: element.children.filter(isTag).map(shapeOf),
	};
}

function elementsOf(nodes: readonly ChildNode[]): Element[] {
	return nodes.filter(isTag);
}

function parseXml(xml: string): Element[] {
	return elementsOf(parseDocument(xml, { xmlMode: true }).children);
}

/** HQ's partial fixtures use its local URLs; Nova prints its templates. */
function withNovaUrls(partial: string): string {
	return partial
		.replaceAll(
			"http://localhost:8000/a/test_domain/phone/search/123/",
			SEARCH_URL_TEMPLATE,
		)
		.replaceAll(
			"http://localhost:8000/a/test_domain/phone/claim-case/",
			CLAIM_URL_TEMPLATE,
		)
		.replaceAll(
			"http://localhost:8000/a/test_domain/phone/case_fixture/123/",
			CASE_FIXTURE_URL_TEMPLATE,
		);
}

/**
 * `assertXmlPartialEqual(expected, suite, xpath)` over one element. HQ's
 * fixture forms keep HQ's default after-submit workflow (no frame), while
 * Nova's case forms in a search-first module default to the module, so an
 * entry's `<stack>` is compared on its own by `expectModuleStack`.
 */
function expectPartialEqual(actual: Element, expectedPartial: string): void {
	const [partial] = parseXml(withNovaUrls(expectedPartial));
	const [expected] = elementsOf(partial.children);
	const actualShape = shapeOf(actual);
	expect({
		...actualShape,
		children: actualShape.children.filter((child) => child.name !== "stack"),
	}).toEqual(shapeOf(expected));
}

/** The after-submit frame of a search-first module's case form: the
 *  module command alone (HQ `WORKFLOW_MODULE`), so the worker searches again. */
function expectModuleStack(entry: Element): void {
	const [stack] = childrenNamed(entry, "stack");
	expect(shapeOf(stack)).toEqual({
		name: "stack",
		attribs: {},
		children: [
			{
				name: "create",
				attribs: {},
				children: [
					{ name: "command", attribs: { value: "'m0'" }, children: [] },
				],
			},
		],
	});
}

function compileSuite(doc: BlueprintDoc): Element {
	const ccz = compileCcz(expandDoc(doc), "Inline", doc);
	const [suite] = parseXml(new AdmZip(ccz).readAsText("suite.xml"));
	return suite;
}

function childrenNamed(parent: Element, name: string): Element[] {
	return elementsOf(parent.children).filter((child) => child.name === name);
}

function findDetail(suite: Element, id: string): Element | undefined {
	return childrenNamed(suite, "detail").find(
		(detail) => detail.attribs.id === id,
	);
}

// ── The oracle's app ─────────────────────────────────────────────────

const NAME_INPUT = testUuid("00000000-0000-4000-8000-0000000a0001");
const PARENT_COLUMN = testUuid("00000000-0000-4000-8000-0000000a0002");

/**
 * `InlineSearchSuiteTest.setUp`: module "Followup" on case type `case`,
 * one case-requiring form, one prompt `name`, `auto_launch` +
 * `inline_search` — which is what Nova's `searchFirst` lowers to.
 */
function inlineDoc(
	options: {
		readonly caseListOnly?: boolean;
		readonly multiSelect?: boolean;
	} = {},
): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [nameInput()];
	if (options.multiSelect === true) {
		config.selection = { kind: "multiple", maximum: 100 };
		const parentName = calculatedColumn(
			PARENT_COLUMN,
			"parent name",
			term(
				prop(
					"case",
					"first_name",
					ancestorPath(relationStep("parent", "case")),
				),
			),
		);
		config.columns = [...config.columns, parentName];
		config.listColumnOrder = [...config.listColumnOrder, PARENT_COLUMN];
		config.detailColumnOrder = [...config.detailColumnOrder, PARENT_COLUMN];
	}
	return buildDoc({
		appName: "Inline",
		modules: [
			{
				name: "Followup",
				caseType: "case",
				caseListConfig: config,
				caseSearchConfig: { searchFirst: true },
				...(options.caseListOnly === true
					? { caseListOnly: true }
					: {
							forms: [
								{
									name: "Untitled Form",
									type: "followup",
									fields: [
										f({
											kind: "text",
											id: "question1",
											label: proseText("Question 1"),
										}),
									],
								},
							],
						}),
			},
		],
		caseTypes: [
			{
				name: "case",
				parent_type: "case",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "first_name", label: proseText("First name") },
				],
			},
		],
	});
}

const FOLLOWUP_MODULE = testUuid("00000000-0000-4000-8000-0000000a0010");
const FOLLOWUP_FORM = testUuid("00000000-0000-4000-8000-0000000a0011");

function nameInput() {
	return simpleSearchInputDef(
		NAME_INPUT,
		"first_name",
		"Name",
		"text",
		"first_name",
	);
}

function question1() {
	return f({ kind: "text", id: "question1", label: proseText("Question 1") });
}

/**
 * The oracle's second module: "Registration" on the same case type, whose
 * registration form links to the search-first module's form
 * (`test_form_linking_to_inline_search_module_from_registration_form`).
 */
function registrationLinkDoc(
	options: {
		readonly searchInputs?: CaseListConfig["searchInputs"];
		readonly datums?: Array<{ name: string; xpath: string }>;
	} = {},
): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = options.searchInputs ?? [nameInput()];
	return buildDoc({
		appName: "Inline",
		modules: [
			{
				uuid: FOLLOWUP_MODULE,
				name: "Followup",
				caseType: "case",
				caseListConfig: config,
				caseSearchConfig: { searchFirst: true },
				forms: [
					{
						uuid: FOLLOWUP_FORM,
						name: "Untitled Form",
						type: "followup",
						fields: [question1()],
					},
				],
			},
			{
				name: "Registration",
				caseType: "case",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Untitled Form",
						type: "registration",
						formLinks: [
							{
								target: {
									type: "form",
									moduleUuid: FOLLOWUP_MODULE,
									formUuid: FOLLOWUP_FORM,
								},
								datums: options.datums,
							},
						],
						fields: [
							f({
								kind: "text",
								id: "question1",
								label: proseText("Question 1"),
								caseWrite: { caseType: "case", property: "case_name" },
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "case",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "first_name", label: proseText("First name") },
				],
			},
		],
	});
}

/**
 * `test_inline_search_with_parent_relationship_parent_select`: the
 * search-first module's cases are children of `parent_case`, selected in
 * a second module first. HQ numbers that module m2; Nova's is m1.
 */
function parentSelectDoc(): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [nameInput()];
	return buildDoc({
		appName: "Inline",
		modules: [
			{
				name: "Followup",
				caseType: "case",
				caseListConfig: config,
				caseSearchConfig: { searchFirst: true },
				forms: [
					{ name: "Untitled Form", type: "followup", fields: [question1()] },
				],
			},
			{
				name: "Followup2",
				caseType: "parent_case",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{ name: "Untitled Form", type: "followup", fields: [question1()] },
				],
			},
		],
		caseTypes: [
			{
				name: "parent_case",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "case",
				parent_type: "parent_case",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "first_name", label: proseText("First name") },
				],
			},
		],
	});
}

describe("search-first modules lower to HQ's inline search shape", () => {
	it("test_form_linking_to_inline_search_module_from_registration_form: the link frame fetches the new case through the case_fixture query", () => {
		const suite = compileSuite(registrationLinkDoc());
		const [, registration] = childrenNamed(suite, "entry");
		const [stack] = childrenNamed(registration, "stack");
		const [create] = childrenNamed(stack, "create");
		// HQ's partial carries a second `case_type` row from
		// `additional_case_types`, which Nova does not author.
		expectPartialEqual(
			create,
			`
        <partial>
          <create>
            <command value="'m0'"/>
            <query id="results:inline" value="http://localhost:8000/a/test_domain/phone/case_fixture/123/">
              <data key="case_type" ref="'case'"/>
              <data key="case_id" ref="instance('commcaresession')/session/data/case_id_new_case_0"/>
            </query>
            <datum id="case_id" value="instance('commcaresession')/session/data/case_id_new_case_0"/>
            <command value="'m0-f0'"/>
          </create>
        </partial>`,
		);
	});

	it("a hidden-only search is still a prompted query for frames: HQ counts every prompt in requires_selection", () => {
		// `WorkflowQueryMeta.requires_selection` is `not query.prompts and
		// default_search`, and `build_query_prompts` skips only groups, so a
		// module whose only input is hidden runs `default_search` yet is NOT
		// a selecting step. A manual-datum link that names the case datum
		// therefore passes the query through (HQ's
		// `_get_datums_matched_to_manual_values`), and Nova admits it too.
		const hiddenOnly = [
			hiddenSearchInputDef(
				testUuid("00000000-0000-4000-8000-000000000042"),
				"search_time",
				"Search time",
				term({ kind: "literal", value: "now" }),
			),
		];
		const doc = registrationLinkDoc({
			searchInputs: hiddenOnly,
			datums: [
				{
					name: "case_id",
					xpath: "instance('commcaresession')/session/data/case_id_new_case_0",
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((e) => e.code),
		).not.toContain("FORM_LINK_DATUMS_INCOMPLETE");
		const suite = compileSuite(doc);
		const [followup, registration] = childrenNamed(suite, "entry");
		const [session] = childrenNamed(followup, "session");
		const [query] = childrenNamed(session, "query");
		expect(query.attribs.default_search).toBe("true");
		const [stack] = childrenNamed(registration, "stack");
		const [create] = childrenNamed(stack, "create");
		expect(childrenNamed(create, "query")).toHaveLength(1);
		expect(childrenNamed(create, "datum")).toHaveLength(1);
	});

	it("test_inline_search_with_parent_relationship_parent_select: the parent datum leads, the query filters by ancestor, and the post offers both cases", () => {
		const suite = compileSuite(parentSelectDoc());
		const [entry] = childrenNamed(suite, "entry");
		expectPartialEqual(
			entry,
			`
        <partial>
          <entry>
            <form>xmlns1.0</form>
            <post url="http://localhost:8000/a/test_domain/phone/claim-case/"
                relevant="$case_id != ''">
              <data exclude="count(instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]) != 0"
                key="case_id" ref="instance('commcaresession')/session/data/case_id"/>
              <data exclude="count(instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/parent_id]) != 0"
                key="case_id" ref="instance('commcaresession')/session/data/parent_id"/>
            </post>
            <command id="m0-f0">
              <text>
                <locale id="forms.m0f0"/>
              </text>
            </command>
            <instance id="casedb" src="jr://instance/casedb"/>
            <instance id="commcaresession" src="jr://instance/session"/>
            <instance id="results:inline" src="jr://instance/remote/results:inline"/>
            <session>
              <datum id="parent_id" nodeset="instance('casedb')/casedb/case[@case_type='parent_case'][@status='open']"
                value="./@case_id" detail-select="m1_case_short"/>
              <query url="http://localhost:8000/a/test_domain/phone/search/123/"
                storage-instance="results:inline" template="case" default_search="false">
                <title>
                  <text>
                      <locale id="case_search.m0.inputs"/>
                  </text>
                </title>
                <data key="case_type" ref="'case'"/>
                <data key="_xpath_query" ref="&quot;ancestor-exists(parent, @case_type='parent_case')&quot;"/>
                <prompt key="first_name">
                  <display>
                    <text>
                      <locale id="search_property.m0.first_name"/>
                    </text>
                  </display>
                </prompt>
              </query>
              <datum id="case_id"
                nodeset="instance('results:inline')/results/case[@case_type='case'][@status='open'][not(commcare_is_related_case=true())][index/*[not(@relationship='extension')]=instance('commcaresession')/session/data/parent_id]"
                value="./@case_id" detail-select="m0_case_short" detail-confirm="m0_case_long"/>
            </session>
          </entry>
        </partial>`,
		);
		expectModuleStack(entry);
	});

	it("test_inline_search: the form entry carries the claim post, the query, and the results:inline datum", () => {
		const suite = compileSuite(inlineDoc());
		const [entry] = childrenNamed(suite, "entry");
		expectPartialEqual(
			entry,
			`
        <partial>
          <entry>
            <form>xmlns1.0</form>
            <post url="http://localhost:8000/a/test_domain/phone/claim-case/"
                relevant="count(instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]) = 0">
             <data key="case_id" ref="instance('commcaresession')/session/data/case_id"/>
            </post>
            <command id="m0-f0">
              <text>
                <locale id="forms.m0f0"/>
              </text>
            </command>
            <instance id="casedb" src="jr://instance/casedb"/>
            <instance id="commcaresession" src="jr://instance/session"/>
            <instance id="results:inline" src="jr://instance/remote/results:inline"/>
            <session>
                <query url="http://localhost:8000/a/test_domain/phone/search/123/"
                    storage-instance="results:inline" template="case" default_search="false">
                  <title>
                    <text>
                      <locale id="case_search.m0.inputs"/>
                    </text>
                  </title>
                  <data key="case_type" ref="'case'"/>
                  <prompt key="first_name">
                    <display>
                      <text>
                        <locale id="search_property.m0.first_name"/>
                      </text>
                    </display>
                  </prompt>
                </query>
                <datum id="case_id" nodeset="instance('results:inline')/results/case[@case_type='case'][@status='open'][not(commcare_is_related_case=true())]"
                    value="./@case_id" detail-select="m0_case_short" detail-confirm="m0_case_long"/>
            </session>
          </entry>
        </partial>`,
		);

		expectModuleStack(entry);

		// assertXmlDoesNotHaveXpath
		expect(childrenNamed(suite, "remote-request")).toEqual([]);
		expect(findDetail(suite, "m0_search_short")).toBeUndefined();
		expect(findDetail(suite, "m0_search_long")).toBeUndefined();
		const caseShort = findDetail(suite, "m0_case_short");
		expect(caseShort).toBeDefined();
		expect(childrenNamed(caseShort as Element, "action")).toEqual([]);
	});

	it("test_inline_search_case_list_item: the browse entry carries the query and no post", () => {
		const suite = compileSuite(inlineDoc({ caseListOnly: true }));
		const [entry] = childrenNamed(suite, "entry");
		expectPartialEqual(
			entry,
			`
        <partial>
          <entry>
            <command id="m0-case-list">
              <text>
                <locale id="case_lists.m0"/>
              </text>
            </command>
            <instance id="results:inline" src="jr://instance/remote/results:inline"/>
            <session>
                <query url="http://localhost:8000/a/test_domain/phone/search/123/"
                    storage-instance="results:inline" template="case" default_search="false">
                  <title>
                    <text>
                        <locale id="case_search.m0.inputs"/>
                    </text>
                  </title>
                  <data key="case_type" ref="'case'"/>
                  <prompt key="first_name">
                    <display>
                      <text>
                        <locale id="search_property.m0.first_name"/>
                      </text>
                    </display>
                  </prompt>
                </query>
                <datum id="case_id" nodeset="instance('results:inline')/results/case[@case_type='case'][@status='open'][not(commcare_is_related_case=true())]"
                    value="./@case_id" detail-select="m0_case_short" detail-confirm="m0_case_long"/>
            </session>
          </entry>
        </partial>`,
		);
	});

	it("test_inline_search_multi_select: the selection datum, the claim post, and the detail's related read root at results:inline", () => {
		// One deliberate addition to HQ's partial: the parent-name column
		// reads `current()/index/parent` against the results instance, so
		// Nova asks the search to carry the parents
		// (`x_commcare_include_all_related_cases`); HQ's fixture leaves that
		// read to resolve blank.
		const suite = compileSuite(inlineDoc({ multiSelect: true }));
		const [entry] = childrenNamed(suite, "entry");
		expectPartialEqual(
			entry,
			`
        <partial>
          <entry>
            <form>xmlns1.0</form>
            <post url="http://localhost:8000/a/test_domain/phone/claim-case/"
                relevant="$case_id != ''">
             <data exclude="count(instance('casedb')/casedb/case[@case_id=current()/.]) = 1"
                key="case_id" nodeset="instance('selected_cases')/results/value" ref="."/>
            </post>
            <command id="m0-f0">
              <text>
                <locale id="forms.m0f0"/>
              </text>
            </command>
            <instance id="casedb" src="jr://instance/casedb"/>
            <instance id="results:inline" src="jr://instance/remote/results:inline"/>
            <instance id="selected_cases" src="jr://instance/selected-entities/selected_cases"/>
            <session>
                <query url="http://localhost:8000/a/test_domain/phone/search/123/"
                    storage-instance="results:inline"
                    template="case" default_search="false">
                  <title>
                    <text>
                        <locale id="case_search.m0.inputs"/>
                    </text>
                  </title>
                  <data key="case_type" ref="'case'"/>
                  <data key="x_commcare_include_all_related_cases" ref="'true'"/>
                  <prompt key="first_name">
                    <display>
                      <text>
                        <locale id="search_property.m0.first_name"/>
                      </text>
                    </display>
                  </prompt>
                </query>
                <instance-datum id="selected_cases" nodeset="instance('results:inline')/results/case[@case_type='case'][@status='open'][not(commcare_is_related_case=true())]"
                    value="./@case_id" detail-select="m0_case_short" detail-confirm="m0_case_long" max-select-value="100"/>
            </session>
          </entry>
        </partial>`,
		);

		expectModuleStack(entry);

		// The parent read is a calculated column, so it rides the
		// `<variable name="calculated_property">` template rather than the
		// bare `<xpath function>` HQ's `parent/name` field format prints, and
		// Nova's typed relation keeps its `@case_type` qualifier. The root is
		// the partial's: `instance('results:inline')/results/case[...]`.
		const caseShort = findDetail(suite, "m0_case_short") as Element;
		const xpaths = childrenNamed(caseShort, "field").map((field) => {
			const [template] = childrenNamed(field, "template");
			const [text] = childrenNamed(template, "text");
			const [xpath] = childrenNamed(text, "xpath");
			const [variable] = childrenNamed(xpath, "variable");
			if (variable === undefined) return xpath.attribs.function;
			const [inner] = childrenNamed(variable, "xpath");
			return inner.attribs.function;
		});
		expect(xpaths).toEqual([
			"case_name",
			"instance('results:inline')/results/case[@case_id=current()/index/parent and @case_type='case']/first_name",
		]);
	});

	it("HQ JSON carries the same shape: inline_search + auto_launch, default_search only without visible inputs, and the inline answer instance in every _xpath_query", () => {
		const doc = inlineDoc();
		const mod = doc.modules[doc.moduleOrder[0]];
		const config = mod.caseListConfig;
		if (config === undefined) throw new Error("fixture has a case list");
		// An advanced input whose predicate reads its own answer prints the
		// answer instance; on the inline shape that is `search-input:results:inline`.
		const NOTE_INPUT = testUuid("00000000-0000-4000-8000-0000000a0003");
		config.searchInputs = [
			...config.searchInputs,
			advancedSearchInputDef(
				NOTE_INPUT,
				"note",
				"Note",
				"text",
				whenInput(
					input(NOTE_INPUT),
					eq(prop("case", "first_name"), input(NOTE_INPUT)),
				),
			),
		];
		const hq = expandDoc(doc);
		const search = hq.modules[0].search_config;
		expect(search.inline_search).toBe(true);
		expect(search.auto_launch).toBe(true);
		expect(search.default_search).toBe(false);
		const xpathQueries = search.default_properties.map(
			(property) => property.property,
		);
		expect(xpathQueries).toEqual(["_xpath_query"]);
		expect(search.default_properties[0].defaultValue).toContain(
			"instance('search-input:results:inline')/input/field[@name='note']",
		);
		expect(search.default_properties[0].defaultValue).not.toContain(
			"instance('search-input:results')/",
		);

		// The local suite spells the same instance on the entry.
		const suite = compileSuite(doc);
		const [entry] = childrenNamed(suite, "entry");
		expect(
			childrenNamed(entry, "instance").map((instance) => instance.attribs.id),
		).toEqual([
			"casedb",
			"commcaresession",
			"results:inline",
			"search-input:results:inline",
		]);
	});

	it("a search-first module with no visible input runs its search on its own (default_search)", () => {
		const doc = inlineDoc();
		const mod = doc.modules[doc.moduleOrder[0]];
		if (mod.caseListConfig === undefined)
			throw new Error("fixture has a case list");
		mod.caseListConfig.searchInputs = [];
		const hq = expandDoc(doc);
		expect(hq.modules[0].search_config.default_search).toBe(true);
		const suite = compileSuite(doc);
		const [entry] = childrenNamed(suite, "entry");
		const [session] = childrenNamed(entry, "session");
		const [query] = childrenNamed(session, "query");
		expect(query.attribs.default_search).toBe("true");
	});
});

describe("selected runtime server", () => {
	it.each(COMMCARE_SERVER_IDS)(
		"uses %s for inline search, claim and after-submit case hydration",
		(server) => {
			const doc = registrationLinkDoc();
			const runtimeTarget = { server, domain: "clinic", appId: "released-app" };
			const zip = compileCcz(
				expandDoc(doc, { runtimeTarget }),
				doc.appName,
				doc,
				{ runtimeTarget },
			);
			const xml = new AdmZip(zip).readAsText("suite.xml");
			const base = COMMCARE_SERVERS[server].baseUrl;
			expect(xml).toContain(`${base}/a/clinic/phone/search/released-app/`);
			expect(xml).toContain(`${base}/a/clinic/phone/claim-case/`);
			expect(xml).toContain(
				`${base}/a/clinic/phone/case_fixture/released-app/`,
			);
			expect(xml).not.toContain("__COMMCARE_HOST__");
			if (server !== "production")
				expect(xml).not.toContain("www.commcarehq.org");
		},
	);
});
