import AdmZip from "adm-zip";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	actingUser,
	arith,
	coalesce,
	concat,
	count,
	dateAdd,
	dateCoerce,
	dateLiteral,
	datetimeCoerce,
	double,
	formatDate,
	idOf,
	ifExpr,
	input,
	literal,
	matchAll,
	now,
	prop,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	today,
	unowned,
} from "@/lib/domain/predicate/builders";
import type { ValueExpression } from "@/lib/domain/predicate/types";
import {
	csqlArgumentFixture,
	csqlFunctionFixture,
	functionLookupFixtures,
	functionLookupNaming,
} from "../../__tests__/csqlFunctionFixture";
import {
	onlyXml,
	readXmlEvidence,
	xmlChildren,
} from "../../__tests__/xmlEvidence";
import { compileCcz } from "../../compiler";
import { expandDoc } from "../../expander";
import { emitCsqlExpressionSegments } from "../csqlEmitter";

// These checks own the private segment IR. Native execution consumes complete
// accepted exports in CsqlFunctionRuntimeTest and the HQ Search payload proof.
it.each<[ValueExpression, string[]]>([
	[today(), ["today()"]],
	[now(), ["now()"]],
	[term(literal("Ada")), ["'Ada'"]],
	[term(literal(42)), ["42"]],
	[term(prop("patient", "score")), ["score"]],
	[dateCoerce(term(literal("2024-02-28"))), ["date(", "'2024-02-28'", ")"]],
	[
		datetimeCoerce(term(literal("2024-02-28T10:30:00Z"))),
		["datetime(", "'2024-02-28T10:30:00Z'", ")"],
	],
	[double(term(literal("19.5"))), ["double(", "'19.5'", ")"]],
	[
		dateAdd(today(), "months", term(literal(3))),
		["date-add(", "today()", ", 'months', ", "3", ")"],
	],
	[
		dateAdd(term(dateLiteral("2024-02-28")), "days", term(literal(-1))),
		["date-add(", "'2024-02-28'", ", 'days', ", "-1", ")"],
	],
	[
		dateAdd(
			dateAdd(now(), "hours", term(literal(2))),
			"minutes",
			term(literal(30)),
		),
		[
			"datetime-add(",
			"datetime-add(",
			"now()",
			", 'hours', ",
			"2",
			")",
			", 'minutes', ",
			"30",
			")",
		],
	],
])(
	"leaves constants separate for the surrounding clause composer: %j",
	(expression, texts) => {
		expect(emitCsqlExpressionSegments(expression)).toEqual(
			texts.map((text) => ({ kind: "constant", text })),
		);
	},
);

it("resolves the renamed date input by identity and emits its quote-free argument", () => {
	const uuid = testUuid("date-input");
	expect(
		emitCsqlExpressionSegments(
			dateAdd(term(input(uuid)), "days", term(literal(7))),
			{
				caseTypes: [],
				knownInputs: [{ uuid, name: "renamed_date", data_type: "date" }],
				searchInputInstanceId: "search-input:custom",
			},
		),
	).toEqual([
		{ kind: "constant", text: "date-add(" },
		{ kind: "constant", text: '"' },
		{
			kind: "runtime",
			xpath:
				"instance('search-input:custom')/input/field[@name='renamed_date']",
		},
		{ kind: "constant", text: '"' },
		{ kind: "constant", text: ", 'days', " },
		{ kind: "constant", text: "7" },
		{ kind: "constant", text: ")" },
	]);
});

it("refuses to guess a temporal function for an unresolved read", () => {
	for (const value of [input(testUuid("date")), prop("patient", "date")]) {
		expect(() =>
			emitCsqlExpressionSegments(
				dateAdd(term(value), "days", term(literal(1))),
			),
		).toThrow(/cannot choose between CCHQ's date-add\(\) and datetime-add\(\)/);
	}
});

it("rejects direct dispatch of runtime-only values at this private native-call boundary", () => {
	const expressions = [
		arith("+", term(literal(1)), term(literal(2))),
		concat(term(literal("a")), term(literal("b"))),
		coalesce(term(literal(null)), term(literal("fallback"))),
		ifExpr(matchAll(), term(literal("a")), term(literal("b"))),
		switchExpr(
			term(literal("x")),
			[switchCase(literal("x"), term(literal(1)))],
			term(literal(0)),
		),
		count(subcasePath("parent")),
		formatDate(term(dateLiteral("2024-02-28")), "iso"),
		idOf(testUuid("operation")),
		actingUser(),
		unowned(),
	];
	for (const expression of expressions)
		expect(() => emitCsqlExpressionSegments(expression)).toThrow(
			`tried to emit a value-expression of kind '${expression.kind}' as native CSQL`,
		);
});

it.each([
	["lookup values", csqlFunctionFixture, 5],
	["later arguments", csqlArgumentFixture, 6],
] as const)(
	"exports an admitted app with nested CSQL %s",
	(_label, fixture, count) => {
		const doc = fixture();
		const runtimeTarget = {
			server: "production",
			domain: "nova-search-evidence",
			appId: "search-evidence",
		} as const;
		const hq = expandDoc(doc, {
			runtimeTarget,
			lookupNaming: functionLookupNaming,
		});
		const archive = new AdmZip(
			compileCcz(hq, doc.appName, doc, {
				runtimeTarget,
				lookup: {
					naming: functionLookupNaming,
					fixtures: functionLookupFixtures,
				},
			}),
		);
		const suite = readXmlEvidence(archive.readAsText("suite.xml"));
		const request = onlyXml(xmlChildren(suite, "remote-request"));
		const query = onlyXml(
			xmlChildren(onlyXml(xmlChildren(request, "session")), "query"),
		);
		const clauses = xmlChildren(query, "data").filter(
			(node) => node.attributes.key === "_xpath_query",
		);
		expect(clauses).toHaveLength(count);
		expect(clauses.map((node) => node.attributes.ref)).toEqual(
			hq.modules[0].search_config.default_properties.map(
				(property) => property.defaultValue,
			),
		);
		if (count === 5) {
			expect(
				xmlChildren(request, "instance").map((node) => node.attributes),
			).toContainEqual({
				id: "item-list:search_values",
				src: "jr://fixture/item-list:search_values",
			});
		}
		expect(xmlChildren(query, "prompt")).toHaveLength(count === 5 ? 0 : 1);
	},
);
