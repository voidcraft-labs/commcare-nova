/** Entry and stack XML is the session boundary; complete export and native
 * execution remain in compiler, nested-menu and Core evidence suites. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	and,
	concat,
	eq,
	input,
	literal,
	matchNone,
	prop,
	sessionUser,
	term,
} from "@/lib/domain/predicate";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate/types";
import type { MatchedChild, ProjectedFormLinks } from "../formLinkProjection";
import { alwaysCondition, emptyFormActions } from "../hqShells";
import { serializeXml } from "../serializeXml";
import {
	buildEntryElement,
	buildStackElement,
	deriveCaseListEntryDefinition,
	deriveEntryDefinition,
	derivePostSubmitStack,
	type EntryDefinitionInput,
	newCaseIdDatumId,
	toHqWorkflow,
} from "../session";
import { w } from "../xpath/wire/builders";
import { toWire } from "../xpath/wire/fromExpression";
import { caseDbInstance, sessionInstance } from "../xpath/wire/instances";
import { serializeWire } from "../xpath/wire/serialize";
import type { WireExpr } from "../xpath/wire/tree";
import { onlyXml, readXmlEvidence, xmlChildren } from "./xmlEvidence";

const base: EntryDefinitionInput = {
	formXmlns: "urn:nova:projection",
	moduleIndex: 2,
	formIndex: 3,
	formType: "followup",
	caseType: "patient",
	postSubmit: "app_home",
};
const expectedCaseInstance = { id: "casedb", src: "jr://instance/casedb" };
const expectedSessionInstance = {
	id: "commcaresession",
	src: "jr://instance/session",
};
const region = sessionUser("region");
const filter = eq(prop("patient", "region"), region);
const display = eq(region, literal("North"));
const column = concat(
	term(region),
	term(literal(": ")),
	term(prop("patient", "case_name")),
);
function printedInstances(expression: Predicate | ValueExpression) {
	return [
		...serializeWire(toWire(expression, { target: "suite", types: {} }), {
			target: "suite",
		}).instances,
	];
}
function entryXml(options: Partial<EntryDefinitionInput> = {}) {
	return readXmlEvidence(
		serializeXml(
			buildEntryElement(deriveEntryDefinition({ ...base, ...options })),
		),
	);
}

it("mints a registration datum with the identity in-form reads use", () => {
	const actions = emptyFormActions();
	actions.open_case.condition = alwaysCondition();
	const entry = entryXml({ formType: "registration", actions });
	const datums = onlyXml(xmlChildren(entry, "session")).children;
	expect(datums.map((datum) => datum.attributes)).toEqual([
		{ id: newCaseIdDatumId("patient"), function: "uuid()" },
	]);
	expect(newCaseIdDatumId("patient")).toBe("case_id_new_patient_0");
	expect(xmlChildren(entry, "instance")).toEqual([]);
});

describe("entry instance dependencies", () => {
	it.each([
		{ caseListFilter: filter },
		{ excludedOwnerIds: term(region) },
		{ additionalInstances: printedInstances(display) },
	] satisfies Partial<EntryDefinitionInput>[])(
		"declares each rendered input's dependency %j",
		(slot) => {
			expect(
				xmlChildren(entryXml(slot), "instance").map((node) => node.attributes),
			).toEqual([expectedCaseInstance, expectedSessionInstance]);
		},
	);
	it("keeps a condition's printed read even when its other operand is false", () => {
		const entry = entryXml({
			caseType: undefined,
			formType: "survey",
			additionalInstances: printedInstances(and(display, matchNone())),
		});
		expect(
			xmlChildren(entry, "instance").map((node) => node.attributes),
		).toEqual([expectedSessionInstance]);
	});
	it("deduplicates dependencies shared by case selection and rendered details", () => {
		const additionalInstances = [
			...printedInstances(display),
			...printedInstances(column),
		];
		const form = entryXml({
			caseListFilter: filter,
			excludedOwnerIds: term(region),
			additionalInstances,
		});
		const browse = readXmlEvidence(
			serializeXml(
				buildEntryElement(
					deriveCaseListEntryDefinition(
						2,
						"patient",
						filter,
						false,
						term(region),
						{},
						undefined,
						undefined,
						undefined,
						additionalInstances,
					),
				),
			),
		);
		for (const entry of [form, browse]) {
			expect(
				xmlChildren(entry, "instance").map((node) => node.attributes),
			).toEqual([expectedCaseInstance, expectedSessionInstance]);
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
	it("substitutes unanswered search inputs before declaring ordinary-list dependencies", () => {
		const entry = entryXml({
			caseListFilter: eq(prop("patient", "city"), input(testUuid("city"))),
		});
		expect(
			xmlChildren(entry, "instance").map((node) => node.attributes),
		).toEqual([expectedCaseInstance]);
		const datum = onlyXml(onlyXml(xmlChildren(entry, "session")).children);
		expect(datum.attributes.nodeset).toBe(
			"instance('casedb')/casedb/case[@case_type = 'patient'][@status = 'open'][city = '']",
		);
	});
});

const selected = w.instance(sessionInstance(), [
	w.step("session"),
	w.step("data"),
	w.step("case_id"),
]);
const selectedText = "instance('commcaresession')/session/data/case_id";
const previous: MatchedChild[] = [
	{ type: "command", id: "m1" },
	{ type: "datum", id: "case_id", value: selected },
];
const previousChildren = [
	["command", { value: "'m1'" }],
	["datum", { id: "case_id", value: selectedText }],
];
const query: MatchedChild = {
	type: "query",
	id: "results:inline",
	value: "https://example.test/fixture",
	data: [
		{ key: "case_type", ref: w.str("patient") },
		{
			key: "ids",
			ref: w.context([w.attr("case_id")]),
			nodeset: w.instance(caseDbInstance(), [w.step("casedb"), w.step("case")]),
			exclude: w.eq(
				w.instance(sessionInstance(), [
					w.step("session"),
					w.step("user"),
					w.step("data"),
					w.step("skip"),
				]),
				w.str("yes"),
			),
		},
	],
};
function links(guard?: WireExpr): ProjectedFormLinks {
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
				: { kind: "guarded", guard: w.not(guard) },
	};
}
function stackXml(...args: Parameters<typeof derivePostSubmitStack>) {
	const element = buildStackElement(derivePostSubmitStack(...args));
	return element === null
		? []
		: readXmlEvidence(serializeXml(element)).children.map((operation) =>
				operation.children.map((child) => [child.name, child.attributes]),
			);
}

describe("projected navigation frames", () => {
	it("maps destinations and renders the supplied module and previous frames", () => {
		expect([
			toHqWorkflow("app_home"),
			toHqWorkflow("firstMenu"),
			toHqWorkflow("module"),
			toHqWorkflow("parentMenu"),
			toHqWorkflow("previous"),
		]).toEqual([
			"default",
			"root",
			"module",
			"parent_module",
			"previous_screen",
		]);
		expect(stackXml("app_home", 2, previous)).toEqual([]);
		expect(stackXml("firstMenu", 2, previous)).toEqual([[]]);
		expect(stackXml("parentMenu", 2, previous)).toEqual([]);
		expect(stackXml("parentMenu", 2, [], undefined, previous)).toEqual([
			previousChildren,
		]);
		expect(stackXml("previous", 2, [])).toEqual([]);
		expect(stackXml("previous", 2, previous)).toEqual([previousChildren]);
		expect(stackXml("module", 2, [])).toEqual([
			[["command", { value: "'m2'" }]],
		]);
		expect(stackXml("module", 2, [], previous)).toEqual([previousChildren]);
	});
	it.each([
		"app_home",
		"firstMenu",
		"module",
		"parentMenu",
		"previous",
	] as const)("preserves query data and the %s fallback", (destination) => {
		const guard = w.eq(
			w.instance(sessionInstance(), [
				w.step("session"),
				w.step("user"),
				w.step("data"),
				w.step("role"),
			]),
			w.str("supervisor"),
		);
		const guardText =
			"instance('commcaresession')/session/user/data/role = 'supervisor'";
		const entry = entryXml({
			formLinks: links(guard),
			postSubmit: destination,
			previousFrame: previous,
			parentFrame: previous,
		});
		expect(
			xmlChildren(entry, "instance").map((node) => node.attributes),
		).toEqual([expectedCaseInstance, expectedSessionInstance]);
		const stack = onlyXml(xmlChildren(entry, "stack"));
		expect(stack.children.map((node) => node.attributes)).toEqual([
			{ if: guardText },
			...(destination === "app_home" ? [] : [{ if: `not(${guardText})` }]),
		]);
		const emittedQuery = onlyXml(xmlChildren(stack.children[0], "query"));
		expect(emittedQuery.attributes).toEqual({
			id: "results:inline",
			value: "https://example.test/fixture",
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
					exclude: "instance('commcaresession')/session/user/data/skip = 'yes'",
				},
			],
		]);
		if (destination !== "app_home")
			expect(
				stack.children[1].children.map((node) => [node.name, node.attributes]),
			).toEqual(
				destination === "firstMenu"
					? []
					: destination === "module"
						? [["command", { value: "'m2'" }]]
						: previousChildren,
			);
	});
	it("omits an unconditional guard and suppresses fallback", () => {
		const entry = entryXml({ formLinks: links(), postSubmit: "module" });
		const operation = onlyXml(onlyXml(xmlChildren(entry, "stack")).children);
		expect(operation.name).toBe("create");
		expect(operation.attributes).toEqual({});
	});
	it("keeps no stack distinct from the first menu's one empty frame", () => {
		expect(buildStackElement([])).toBeNull();
		expect(xmlChildren(entryXml(), "stack")).toEqual([]);
		expect(
			onlyXml(xmlChildren(entryXml({ postSubmit: "firstMenu" }), "stack"))
				.children,
		).toEqual([
			{ name: "create", uri: "", attributes: {}, children: [], text: "" },
		]);
	});
});
