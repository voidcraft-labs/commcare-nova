/** Internal projection contracts. Complete exports and native execution live in
 * compiler, nested-menu, case-write, capture, repeat and tile evidence suites. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	concat,
	eq,
	input,
	literal,
	prop,
	sessionUser,
	term,
} from "@/lib/domain/predicate";
import type { MatchedChild, ProjectedFormLinks } from "../formLinkProjection";
import { serializeXml } from "../serializeXml";
import {
	buildEntryElement,
	buildStackElement,
	deriveCaseListEntryDefinition,
	deriveEntryDefinition,
	deriveFormLinkStack,
	derivePostSubmitStack,
	type EntryDefinitionInput,
	toHqWorkflow,
} from "../session";
import { onlyXml, readXmlEvidence, xmlChildren } from "./xmlEvidence";

const base: EntryDefinitionInput = {
	formXmlns: "urn:nova:projection",
	moduleIndex: 2,
	formIndex: 3,
	formType: "followup",
	caseType: "patient",
	postSubmit: "app_home",
};
const sessionInstance = { id: "commcaresession", src: "jr://instance/session" };
const caseInstance = { id: "casedb", src: "jr://instance/casedb" };
const region = sessionUser("region");
const filter = eq(prop("patient", "region"), region);
const display = eq(region, literal("North"));
const column = concat(
	term(region),
	term(literal(": ")),
	term(prop("patient", "case_name")),
);

function entryXml(options: Partial<EntryDefinitionInput> = {}) {
	return readXmlEvidence(
		serializeXml(
			buildEntryElement(deriveEntryDefinition({ ...base, ...options })),
		),
	);
}

describe("entry instance dependencies", () => {
	it.each([
		{ caseListFilter: filter },
		{ excludedOwnerIds: term(region) },
		{ searchButtonDisplayCondition: display },
		{ caseListColumnExpressions: [column] },
		{ formDisplayCondition: eq(prop("patient", "status"), literal("open")) },
	] satisfies Partial<EntryDefinitionInput>[])(
		"declares the dependency of the individual slot %j",
		(slot) => {
			expect(
				xmlChildren(entryXml(slot), "instance").map((node) => node.attributes),
			).toEqual([caseInstance, sessionInstance]);
		},
	);
	it("deduplicates shared dependencies for both form and browse entries", () => {
		const form = entryXml({
			caseListFilter: filter,
			excludedOwnerIds: term(region),
			searchButtonDisplayCondition: display,
			caseListColumnExpressions: [column],
		});
		const browse = readXmlEvidence(
			serializeXml(
				buildEntryElement(
					deriveCaseListEntryDefinition(
						2,
						"patient",
						filter,
						display,
						[column],
						false,
						term(region),
					),
				),
			),
		);
		for (const entry of [form, browse]) {
			expect(
				xmlChildren(entry, "instance").map((node) => node.attributes),
			).toEqual([caseInstance, sessionInstance]);
			const datum = onlyXml(onlyXml(xmlChildren(entry, "session")).children);
			expect(datum.attributes["detail-select"]).toBe("m2_case_short");
			expect(datum.attributes["detail-confirm"]).toBeUndefined();
		}
		expect(xmlChildren(form, "form").map((node) => node.text)).toEqual([
			"urn:nova:projection",
		]);
		expect(xmlChildren(browse, "form")).toEqual([]);
		expect(onlyXml(xmlChildren(browse, "command")).attributes).toEqual({
			id: "m2-case-list",
		});
	});
	it("substitutes unanswered Search input before declaring ordinary-list dependencies", () => {
		const xml = entryXml({
			caseListFilter: eq(prop("patient", "city"), input(testUuid("city"))),
		});
		expect(xmlChildren(xml, "instance").map((node) => node.attributes)).toEqual(
			[caseInstance],
		);
		const datum = onlyXml(onlyXml(xmlChildren(xml, "session")).children);
		expect(datum.attributes.nodeset).toBe(
			"instance('casedb')/casedb/case[@case_type='patient'][@status='open'][city = '']",
		);
	});
});

const selected = "instance('commcaresession')/session/data/case_id";
const previous: MatchedChild[] = [
	{ type: "command", id: "m1" },
	{ type: "datum", id: "case_id", value: selected },
];
const previousChildren = [
	{ type: "command", value: "'m1'" },
	{ type: "datum", id: "case_id", value: selected },
];
const query: MatchedChild = {
	type: "query",
	id: "results:inline",
	value: "'m4'",
	data: [
		{ key: "case_type", ref: "'patient'" },
		{
			key: "ids",
			ref: "@case_id",
			nodeset: "instance('casedb')/casedb/case",
			exclude: "instance('commcaresession')/session/user/data/skip = 'yes'",
		},
	],
};
function links(guard?: string): ProjectedFormLinks {
	return {
		links: [
			{
				uuid: testUuid("link"),
				target: { type: "module", moduleUuid: testUuid("target") },
				...(guard === undefined ? {} : { guard }),
				children: [{ type: "command", id: "m4" }, query],
				datums: [],
				unmatched: [],
				missing: [],
				unused: [],
			},
		],
		fallback:
			guard === undefined
				? { kind: "suppressed-by-else" }
				: { kind: "guarded", guard: `not(${guard})` },
	};
}

describe("projected navigation frames", () => {
	it("maps destinations while preserving the supplied module or previous frame", () => {
		expect([
			toHqWorkflow("app_home"),
			toHqWorkflow("module"),
			toHqWorkflow("previous"),
		]).toEqual(["default", "module", "previous_screen"]);
		expect(derivePostSubmitStack("app_home", 2, previous)).toEqual([]);
		expect(derivePostSubmitStack("previous", 2, [])).toEqual([]);
		expect(derivePostSubmitStack("previous", 2, previous)).toEqual([
			{ op: "create", children: previousChildren },
		]);
		expect(derivePostSubmitStack("module", 2, [])).toEqual([
			{ op: "create", children: [{ type: "command", value: "'m2'" }] },
		]);
		expect(derivePostSubmitStack("module", 2, [], previous)).toEqual([
			{ op: "create", children: previousChildren },
		]);
	});
	it.each(["app_home", "module", "previous"] as const)(
		"preserves query data and the %s fallback",
		(destination) => {
			const guard =
				"instance('commcaresession')/session/user/data/role = 'supervisor'";
			const operations = deriveFormLinkStack(
				links(guard),
				destination,
				2,
				previous,
			);
			const fallback =
				destination === "app_home"
					? []
					: [
							{
								op: "create",
								ifClause: `not(${guard})`,
								children:
									destination === "module"
										? [{ type: "command", value: "'m2'" }]
										: previousChildren,
							},
						];
			expect(operations).toEqual([
				{
					op: "create",
					ifClause: guard,
					children: [{ type: "command", value: "'m4'" }, query],
				},
				...fallback,
			]);
			const xml = entryXml({
				formLinks: links(guard),
				postSubmit: destination,
				previousFrame: previous,
			});
			expect(
				xmlChildren(xml, "instance").map((node) => node.attributes),
			).toEqual([caseInstance, sessionInstance]);
			const stack = onlyXml(xmlChildren(xml, "stack"));
			expect(stack.children.map((node) => node.attributes)).toEqual([
				{ if: guard },
				...fallback.map(() => ({ if: `not(${guard})` })),
			]);
			const emittedQuery = onlyXml(xmlChildren(stack.children[0], "query"));
			expect(emittedQuery.attributes).toEqual({
				id: "results:inline",
				value: "'m4'",
			});
			expect(
				emittedQuery.children.map((node) => [node.name, node.attributes]),
			).toEqual([
				["data", { key: "case_type", ref: "'patient'" }],
				[
					"data",
					{
						key: "ids",
						ref: "@case_id",
						nodeset: "instance('casedb')/casedb/case",
						exclude:
							"instance('commcaresession')/session/user/data/skip = 'yes'",
					},
				],
			]);
		},
	);
	it("omits an unconditional guard and suppresses fallback", () => {
		const xml = entryXml({ formLinks: links(), postSubmit: "module" });
		const operation = onlyXml(onlyXml(xmlChildren(xml, "stack")).children);
		expect(operation.name).toBe("create");
		expect(operation.attributes).toEqual({});
	});
	it("keeps no stack distinct from an explicit reset and lets reset override returns", () => {
		expect(buildStackElement([])).toBeNull();
		expect(xmlChildren(entryXml(), "stack")).toEqual([]);
		const reset = entryXml({
			resetToAppHome: true,
			formLinks: links(),
			returnFrame: { ifClause: "true()", children: previous },
		});
		expect(onlyXml(xmlChildren(reset, "stack")).children).toEqual([
			{ name: "create", uri: "", attributes: {}, children: [], text: "" },
		]);
	});
});
