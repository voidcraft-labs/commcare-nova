import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { asUuid, proseText, simpleSearchInputDef } from "@/lib/domain";
import { termSchema } from "@/lib/domain/predicate";
import {
	previewAsMe,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import {
	evaluatePreviewSearchExpression,
	evaluatePreviewSearchPredicate,
} from "@/lib/preview/engine/searchExpressionEvaluation";
import {
	parseAuthoringExpression,
	quoteAuthoringLiteral,
} from "../expressionSyntax";
import { type QueryPrintContext, queryPrinter } from "../printQueryExpression";
import {
	parseQueryPredicate,
	parseQueryValue,
	type QueryBindings,
} from "../queryExpressions";

const knownIds = new Set<string>();
const lookupIds = new Map<string, string>();
const identity = (kind: string, name: string) => {
	if (knownIds.has(name)) return name;
	const key = `${kind}/${name}`;
	let uuid: string;
	if (kind === "table" || kind === "column") {
		uuid = lookupIds.get(key) ?? uuidv7();
		lookupIds.set(key, uuid);
	} else uuid = testUuid(name);
	knownIds.add(uuid);
	return uuid;
};
function bindings(caseType = "Client", tableId?: string): QueryBindings {
	return {
		typeContext: {
			knownInputs: [],
			currentCaseType: caseType,
			caseTypes: [
				{
					name: "Client",
					properties: [
						{ name: "age", data_type: "int", label: proseText("Age") },
					],
				},
			],
		},
		identity,
		reference(namespace, path) {
			const name = path.join("/");
			if (namespace === "form")
				return { kind: "field", uuid: asUuid(identity("field", name)) };
			if (namespace === "search")
				return {
					kind: "input",
					searchInputUuid: asUuid(identity("search", name)),
				};
			if (namespace === "user") return { kind: "session-user", field: name };
			if (namespace === "row")
				return termSchema.parse({
					kind: "table-column",
					tableId,
					columnId: identity("column", name),
				});
			return {
				kind: "prop",
				caseType:
					namespace === "case"
						? caseType
						: namespace === "record"
							? path[0]
							: namespace,
				property: namespace === "record" ? path[1] : name,
			};
		},
		forRelation(relation) {
			return bindings(
				relation.kind === "subcase" || relation.kind === "any-relation"
					? (relation.ofCaseType ?? caseType)
					: caseType,
				tableId,
			);
		},
		forTable(id) {
			return bindings(caseType, id);
		},
	};
}
const scope = bindings();
const printContext: QueryPrintContext = {
	typeContext: scope.typeContext,
	forRelation: () => printContext,
	forTable: () => printContext,
	name: (_kind, id) => id,
	reference(term) {
		if (term.kind === "prop" && !term.via)
			return `#${term.caseType}/${term.property}`;
		return undefined;
	},
};
const printer = queryPrinter(printContext);

it("uses real division while preserving explicit integer division in existing expressions", () => {
	const session = previewSessionValues(
		previewAsMe({ id: "worker", name: "Ada", email: "ada@example.org" }),
	);
	for (const source of [
		"5 div 2",
		"5.0 div 2",
		"-5.0 div -2",
		"number(5) div 2",
	]) {
		const value = parseQueryValue(source, scope);
		expect(evaluatePreviewSearchExpression(value, session), source).toBe("2.5");
		expect(parseQueryValue(printer.value(value), scope)).toEqual(value);
	}
	const integerDivision = parseQueryValue("quotient(5, 2)", scope);
	expect(evaluatePreviewSearchExpression(integerDivision, session)).toBe("2");
	expect(printer.value(integerDivision)).toBe("quotient(5, 2)");
	expect(() => parseQueryValue("quotient(5.0, 2)", scope)).toThrow(
		"integer operands",
	);
});

it("preserves operator precedence and switches the record scope for a related-record condition", () => {
	const result = parseQueryPredicate(
		"#case/age >= (12 + 3) * 2 and exists(children('Visit'), #case/completed = true())",
		scope,
	);
	expect(result).toMatchObject({
		kind: "and",
		clauses: [
			{
				kind: "gte",
				left: {
					kind: "term",
					term: { kind: "prop", caseType: "Client", property: "age" },
				},
				right: { kind: "arith", op: "*", left: { kind: "arith", op: "+" } },
			},
			{
				kind: "exists",
				via: { kind: "subcase", ofCaseType: "Visit" },
				where: {
					kind: "eq",
					left: {
						kind: "term",
						term: { caseType: "Visit", property: "completed" },
					},
				},
			},
		],
	});
});

it("runs authored Search calculations and conditions through the production Preview evaluator", () => {
	const age = simpleSearchInputDef(
		testUuid("age"),
		"age",
		"Age",
		"text",
		"age",
	);
	const session = previewSessionValues(
		previewAsMe({ id: "worker", name: "Ada", email: "ada@example.org" }),
	);
	const calculation = parseQueryValue(
		"if(number(#search/age) >= 18, concat('Adult: ', session('username')), 'Child')",
		scope,
	);
	const condition = parseQueryPredicate(
		"number(#search/age) >= 18 and number(#search/age) <= 120",
		scope,
	);
	for (const [answer, label, allowed] of [
		["17", "Child", false],
		["18", "Adult: ada@example.org", true],
		["121", "Adult: ada@example.org", false],
	] as const) {
		const answers = new Map([["age", answer]]);
		expect(
			evaluatePreviewSearchPredicate(condition, [age], session, answers),
		).toBe(allowed);
		expect(
			evaluatePreviewSearchExpression(calculation, session, answers, [age]),
		).toBe(label);
	}
});

it("preserves authored values when a read result is submitted back as an edit", () => {
	const values = [
		"-12",
		"0.00000012",
		"9007199254740991",
		"true()",
		"null()",
		"literal('2026-09-12', 'date')",
		"literal('12:30:00', 'time')",
		"#Client/age + 2",
		"#Client/age - 2",
		"#Client/age * 2",
		"#Client/age div 2",
		"#Client/age mod 2",
		"today()",
		"now()",
		"acting-user()",
		"unowned()",
		"id-of('visit')",
		"date-add(today(), 30, 'day')",
		"date('2026-09-12')",
		"datetime('2026-09-12T00:00:00Z')",
		"number('3.5')",
		"concat('Hello ', 'there')",
		"coalesce(#Client/phone, '')",
		"if(#Client/age >= 18, 'adult', 'child')",
		"switch(#Client/status, 'open', 1, 'closed', 2, 0)",
		"count(children('Visit'), #case/completed = true())",
		"count(ancestor(link('parent', 'Household'), 'host'))",
		"format-date(today(), 'iso')",
		"lookup('districts', 'name', #row/code = 'north')",
		"property('Client', 'case_name', ancestor('parent'))",
		"via(ancestor('parent'), #Household/case_name)",
		"session('userid')",
		"user('region')",
		"location('clinic')",
		"owner-location('district', 'Client')",
		"table-column('districts', 'name')",
	];
	for (const source of values) {
		const parsed = parseQueryValue(source, scope);
		expect(parseQueryValue(printer.value(parsed), scope), source).toEqual(
			parsed,
		);
	}
	const conditions = [
		"#Client/age = 18",
		"#Client/age != 18",
		"#Client/age > 18",
		"#Client/age < 18",
		"#Client/age <= 18",
		"true()",
		"false()",
		"not(false())",
		"all(true(), true(), false())",
		"any(false(), true())",
		"in(#Client/status, 'open', 'closed')",
		"is-blank(#Client/phone)",
		"matches-pattern(#Client/code, '^[0-9]+$')",
		"between(#Client/age, 18, unbounded(), false(), true())",
		"between(#Client/age, unbounded(), 18)",
		"fuzzy(#Client/case_name, 'Ada')",
		"phonetic(#Client/case_name, 'Ada')",
		"fuzzy-date(#Client/birth_date, '2000-01-01')",
		"starts-with(#Client/case_name, 'Ad')",
		"selected-any(#Client/tags, 'urgent', 'new')",
		"selected-all(#Client/tags, 'urgent', 'new')",
		"within-distance(#Client/location, '1.0 2.0', 10, 'km')",
		"exists(children('Visit'))",
		"missing(related('Referral', 'host'), #case/status = 'open')",
		"exists(self(), #Client/age >= 18)",
	];
	for (const source of conditions) {
		const parsed = parseQueryPredicate(source, scope);
		expect(
			parseQueryPredicate(printer.predicate(parsed), scope),
			source,
		).toEqual(parsed);
	}
});

it("keeps literal punctuation and backslashes distinct from executable references", () => {
	for (const text of [
		"Hello #form/name",
		'Ada\'s "hello"',
		"C:\\forms\\#case\\{{name}}",
		"\n\t",
	]) {
		const parsed = parseQueryValue(
			`literal(${quoteAuthoringLiteral(text)})`,
			scope,
		);
		expect(parsed).toEqual({
			kind: "term",
			term: { kind: "literal", value: text },
		});
		expect(parseQueryValue(printer.value(parsed), scope)).toEqual(parsed);
	}
});

it("rejects unresolved paths, incomplete syntax, and unsupported calls instead of storing opaque text", () => {
	for (const source of [
		"age >= 18",
		"../age >= 18",
		"/data/age >= 18",
		"#Client/age >=",
		"# form/age",
	]) {
		expect(() => parseAuthoringExpression(source), source).toThrow();
	}
	for (const source of [
		"today(2)",
		"switch(1, 2, 3)",
		"date-add(today(), 1, 'fortnight')",
		"lookup('a', 'b')",
		"nonexistent(1)",
		"process.exit()",
		"count(children(unbounded('Visit')))",
	]) {
		expect(() => parseQueryValue(source, scope), source).toThrow();
	}
	for (const source of [
		"between(#case/age, unbounded(18), 65)",
		"between(#case/age, 18, unbounded(65))",
	])
		expect(() => parseQueryPredicate(source, scope)).toThrow(
			"expects 0 arguments",
		);
	expect(() =>
		parseQueryPredicate(
			"within-distance(#Client/location, '1 2', -1, 'km')",
			scope,
		),
	).toThrow();
	expect(() =>
		parseQueryPredicate("when-provided(#Client/age, true())", scope),
	).toThrow("Search answer");
});
