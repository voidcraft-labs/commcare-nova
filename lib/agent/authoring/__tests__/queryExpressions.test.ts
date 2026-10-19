import fc from "fast-check";
import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	type BlueprintDoc,
	type CaseType,
	calculatedColumn,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	literal,
	recordQueryContext,
	term,
	termSchema,
} from "@/lib/domain/expression";
import {
	chosenCaseId,
	chosenCaseProperty,
} from "@/lib/domain/expression/chosenCase";
import { DISTANCE_UNITS } from "@/lib/domain/expression/distance";
import type { Expression } from "@/lib/domain/expression/types";
import { previewExpressionContext } from "@/lib/preview/engine/expressionContext";
import {
	previewAsMe,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import {
	evaluatePreviewSearchExpression,
	evaluatePreviewSearchPredicate,
} from "@/lib/preview/engine/searchExpressionEvaluation";
import { AuthoringScope } from "../bindings";
import { AuthoringInputError } from "../errors";
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
		currentCaseType: caseType,
		choice: (_field, value) => value,
		typeContext: recordQueryContext({
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
		}),
		identity,
		chosenCaseMenu(name) {
			return { module: asUuid(identity("module", name)), caseType: "Client" };
		},
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
	choiceValues: () => undefined,
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

const previewModule = testUuid("authored-query-preview-module");
const previewColumn = testUuid("authored-query-preview-column");
const age = simpleSearchInputDef(testUuid("age"), "age", "Age", "text", "age");
const previewDoc = buildDoc({
	caseTypes: [
		{
			name: "Client",
			properties: [{ name: "age", data_type: "text", label: "Age" }],
		},
	],
	modules: [
		{
			uuid: previewModule,
			name: "Clients",
			caseType: "Client",
			caseListConfig: {
				...caseListConfig([]),
				columns: [
					calculatedColumn(
						previewColumn,
						"Calculated value",
						term(literal("")),
					),
				],
				listColumnOrder: [previewColumn],
				detailColumnOrder: [previewColumn],
				searchInputs: [age],
			},
		},
	],
});
const previewEnvironment = { doc: previewDoc, moduleUuid: previewModule };
const previewValueContext = previewExpressionContext(previewDoc, {
	entity: "module",
	uuid: previewModule,
	slot: "case_list_column_expression",
	member: { columnUuid: previewColumn },
});
const previewConditionContext = previewExpressionContext(previewDoc, {
	entity: "module",
	uuid: previewModule,
	slot: "search_input_required_when",
	member: { searchInputUuid: age.uuid },
});

it("executes shared blank operations and empty collections without special authoring forms", () => {
	const session = previewSessionValues(
		previewAsMe({ id: "worker", name: "Ada", email: "ada@example.org" }),
	);
	for (const [source, expected] of [
		["is-blank('')", true],
		["is-blank(0)", false],
		["is-blank(false())", false],
		["is-blank(' ')", false],
		["all()", true],
		["any()", false],
	] as const) {
		expect(
			evaluatePreviewSearchPredicate(
				parseQueryPredicate(source, scope),
				previewConditionContext,
				previewEnvironment,
				[],
				session,
				new Map(),
			),
			source,
		).toBe(expected);
	}
	for (const [source, expected] of [
		["concat()", ""],
		["coalesce('', 'fallback')", "fallback"],
		["coalesce(0, 3)", "0"],
		["coalesce(false(), true())", "false"],
	] as const) {
		const value = parseQueryValue(source, scope);
		expect(
			evaluatePreviewSearchExpression(value, previewValueContext, session),
			source,
		).toBe(expected);
		expect(parseQueryValue(printer.value(value), scope)).toEqual(value);
	}
});

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
		expect(
			evaluatePreviewSearchExpression(value, previewValueContext, session),
			source,
		).toBe("2.5");
		expect(parseQueryValue(printer.value(value), scope)).toEqual(value);
	}
	const integerDivision = parseQueryValue("quotient(5, 2)", scope);
	expect(
		evaluatePreviewSearchExpression(
			integerDivision,
			previewValueContext,
			session,
		),
	).toBe("2");
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
			evaluatePreviewSearchPredicate(
				condition,
				previewConditionContext,
				previewEnvironment,
				[age],
				session,
				answers,
			),
		).toBe(allowed);
		expect(
			evaluatePreviewSearchExpression(
				calculation,
				previewValueContext,
				session,
				answers,
				[age],
			),
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
		"here()",
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

it("identifies unsupported record functions without mistaking their arguments for literals", () => {
	for (const [source, name, parse] of [
		["concat(string(2), ' attendees')", "string", parseQueryValue],
		[
			"string-length(external-user('group')) > 0",
			"string-length",
			parseQueryPredicate,
		],
		["contains('Ada', 'A')", "contains", parseQueryPredicate],
	] as const) {
		try {
			parse(source, scope);
			throw new Error("Unsupported function was accepted");
		} catch (error) {
			expect(error).toBeInstanceOf(AuthoringInputError);
			expect((error as Error).message).toContain(`${name}()`);
			expect((error as Error).message).toMatch(
				/form expressions.*not record expressions/,
			);
		}
	}
	// Supported replacements still execute through the production runtime.
	const session = previewSessionValues(
		previewAsMe({ id: "worker", name: "Ada", email: "ada@example.org" }),
	);
	expect(
		evaluatePreviewSearchExpression(
			parseQueryValue("concat(2, ' attendees')", scope),
			previewValueContext,
			session,
		),
	).toBe("2 attendees");
	expect(
		evaluatePreviewSearchPredicate(
			parseQueryPredicate("not(is-blank(session('userid')))", scope),
			previewConditionContext,
			previewEnvironment,
			[],
			session,
			new Map(),
		),
	).toBe(true);
	expect(() => parseQueryValue("nonexistent(1)", scope)).toThrow(
		/Unknown.*nonexistent/,
	);
	expect(() => parseQueryPredicate("today()", scope)).toThrow(
		/today\(\).*condition/,
	);
	// Literal-only arguments retain their own diagnostic rather than a false
	// unsupported-function claim for an admitted expression.
	expect(() =>
		parseQueryValue("format-date(today(), #form/pattern)", scope),
	).toThrow(/literal/);
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
			AuthoringInputError,
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

it("reads back every widened record arm by the call shape it parses from", () => {
	const values = [
		"record-type()",
		"date(19000)",
		"date(-1)",
		"date(#Client/day_count)",
		"datetime(literal(19000.5, 'decimal'))",
	];
	for (const source of values) {
		const parsed = parseQueryValue(source, scope);
		expect(parseQueryValue(printer.value(parsed), scope), source).toEqual(
			parsed,
		);
	}
	const conditions = [
		"record-type() = 'visit'",
		"record-type() != 'visit'",
		"record-type() = literal('visit')",
		"in(record-type(), 'visit', 'referral')",
		"#Client/closed_on >= datetime('2026-01-01')",
		"not(#Client/closed_on < datetime('2026-01-01'))",
		"selected-any(#Client/tags, 'a', #search/tags)",
		"selected-all(#Client/tags, #search/tags)",
		"selected-any(#Client/tags, concat('a', 'b'), concat(#search/tags, ' b'))",
		"within-distance(#Client/location, #search/here, #search/radius, 'meters')",
		"within-distance(#Client/location, '1 2', 10, #search/unit)",
		"within-distance(#Client/location, '1 2', 10, literal('parsecs'))",
		"within-distance(#Client/location, '1 2', literal(10, 'int'), 'yards')",
		...DISTANCE_UNITS.map(
			(unit) => `within-distance(#Client/location, '1 2', 3, '${unit}')`,
		),
		"if(#user/role = 'supervisor', true(), #Client/owner_id = session('userid'))",
		"if(session('username') = 'ada', #Client/age > 1, not(#Client/age > 1))",
		"switch(session('username'), 'ada', #Client/age > 1, 'bo', false(), true())",
	];
	for (const source of conditions) {
		const parsed = parseQueryPredicate(source, scope);
		expect(
			parseQueryPredicate(printer.predicate(parsed), scope),
			source,
		).toEqual(parsed);
	}
});

it("stores a quoted name opposite record-type() as a record type, and keeps lists of values literal", () => {
	expect(parseQueryPredicate("record-type() = 'visit'", scope)).toEqual({
		kind: "eq",
		left: { kind: "term", term: { kind: "case-row-type" } },
		right: { kind: "term", term: { kind: "case-type", caseType: "visit" } },
	});
	expect(parseQueryPredicate("'visit' != record-type()", scope)).toMatchObject({
		left: { kind: "term", term: { kind: "case-type", caseType: "visit" } },
	});
	const text = parseQueryPredicate("record-type() = literal('visit')", scope);
	expect(text).toMatchObject({
		right: { kind: "term", term: { kind: "literal", value: "visit" } },
	});
	expect(printer.predicate(text)).toBe("(record-type() = literal('visit'))");
	expect(
		parseQueryPredicate("in(record-type(), 'visit', 'referral')", scope),
	).toMatchObject({
		values: [
			{ kind: "literal", value: "visit" },
			{ kind: "literal", value: "referral" },
		],
	});
});

it("takes a value as a distance, a unit and a selected choice, and refuses a unit CommCare doesn't know", () => {
	expect(
		parseQueryPredicate(
			"within-distance(#Client/location, '1 2', #search/radius, 'km')",
			scope,
		),
	).toMatchObject({
		distance: { kind: "term", term: { kind: "input" } },
		unit: "kilometers",
	});
	expect(
		parseQueryPredicate("selected-any(#Client/tags, 'a', #search/tags)", scope),
	).toMatchObject({
		values: [
			{ kind: "literal", value: "a" },
			{ kind: "term", term: { kind: "input" } },
		],
	});
	expect(() =>
		parseQueryPredicate(
			"within-distance(#Client/location, '1 2', 10, 'parsecs')",
			scope,
		),
	).toThrow(
		"CommCare doesn't measure distance in parsecs. Use one of miles, yards, feet, inch, kilometers, meters, centimeters, millimeters, nauticalmiles.",
	);
	expect(() => parseQueryPredicate("record-type()", scope)).toThrow(
		/record-type\(\).*condition/,
	);
});

// --- The chosen case -------------------------------------------------------

const householdType: CaseType = {
	name: "Household",
	properties: [
		{ name: "village", label: proseText("Village"), data_type: "text" },
	],
};
const memberType: CaseType = {
	name: "Member",
	parent_type: "Household",
	relationship: "child",
	properties: [{ name: "age", label: proseText("Age"), data_type: "int" }],
};
function menuDoc(): BlueprintDoc {
	return buildDoc({
		caseTypes: [householdType, memberType],
		modules: [
			{ uuid: "menu-households", name: "Households", caseType: "Household" },
			{
				uuid: "menu-members",
				name: "Members",
				caseType: "Member",
				parentCaseModuleUuid: "menu-households",
			},
			{ uuid: "menu-survey", name: "Survey" },
			{
				uuid: "menu-group",
				name: "Group visits",
				caseType: "Household",
				caseListConfig: {
					...caseListConfig([]),
					selection: { kind: "multiple", maximum: 5 },
				},
			},
			{ uuid: "menu-twin-a", name: "Twins", caseType: "Household" },
			{ uuid: "menu-twin-b", name: "Twins", caseType: "Household" },
		],
	});
}
const menus = menuDoc();
const [households, members, , , twinA, twinB] = menus.moduleOrder;
const memberScope = new AuthoringScope({
	doc: menus,
	moduleUuid: members,
	currentCaseType: "Member",
});
const memberPrinter = queryPrinter(memberScope);

it("reads the case chosen in a menu by the menu's name, id or UUID, and prints it by name", () => {
	expect(parseQueryValue("chosen-case('Households')", memberScope)).toEqual(
		chosenCaseId(households),
	);
	const village = parseQueryValue(
		"chosen-case-property('Households', 'village')",
		memberScope,
	);
	expect(village).toEqual(
		chosenCaseProperty(households, "Household", "village"),
	);
	expect(memberPrinter.value(village)).toBe(
		"chosen-case-property('Households', 'village')",
	);
	for (const address of ["households", households]) {
		const parsed = parseQueryValue(`chosen-case('${address}')`, memberScope);
		expect(parsed).toEqual(chosenCaseId(households));
		expect(memberPrinter.value(parsed)).toBe("chosen-case('Households')");
	}
	// A name two menus share prints the stable address, which reads back.
	const twin = parseQueryValue(`chosen-case('${twinA}')`, memberScope);
	expect(memberPrinter.value(twin)).toBe(`chosen-case('${twinA}')`);
	expect(parseQueryValue(memberPrinter.value(twin), memberScope)).toEqual(twin);
	for (const source of [
		"via(ancestor('parent'), #case/case_id) = chosen-case('Households')",
		"#case/age > 0 and chosen-case-property('Households', 'village') = 'North'",
		"in(chosen-case-property('Households', 'village'), 'North', 'South')",
		"#case/closed_on >= datetime('2026-01-01')",
	]) {
		const parsed = parseQueryPredicate(source, memberScope);
		expect(
			parseQueryPredicate(memberPrinter.predicate(parsed), memberScope),
			source,
		).toEqual(parsed);
	}
	expect(
		parseQueryPredicate(
			"#case/closed_on >= datetime('2026-01-01')",
			memberScope,
		),
	).toMatchObject({
		left: {
			kind: "term",
			term: { kind: "prop", caseType: "Member", property: "closed_on" },
		},
	});
});

it("refuses a chosen-case read of a menu that has no one chosen case", () => {
	const refusal = (source: string) => {
		try {
			parseQueryValue(source, memberScope);
		} catch (error) {
			expect(error).toBeInstanceOf(AuthoringInputError);
			return (error as Error).message;
		}
		throw new Error(`${source} was accepted`);
	};
	expect(refusal("chosen-case('Clinics')")).toBe(
		"This app has no menu called Clinics. You can use one of its menus: Households, Members, Survey, Group visits, Twins, Twins.",
	);
	expect(refusal("chosen-case('Twins')")).toBe(
		`More than one menu is called Twins. You can name the one you mean by its ID: ${twinA}, ${twinB}.`,
	);
	expect(refusal("chosen-case('Survey')")).toBe(
		"Survey doesn't ask the worker to choose a case, so there's no chosen case to read. You can use a menu that does, such as Households.",
	);
	expect(refusal("chosen-case-property('Group visits', 'village')")).toBe(
		"In Group visits the worker chooses several cases at once, so there's no one chosen case to read. You can use a menu where one case is chosen.",
	);
	expect(() =>
		parseQueryPredicate("chosen-case('Households')", memberScope),
	).toThrow(/chosen-case\(\).*condition/);
});

/**
 * The record dialect's round trip over drawn trees: every arm this pull
 * request widens, the chosen case drawn only from the menu the Members list's
 * entry passes through (its parent selection, Households).
 */
it("prints and parses back every drawn record condition unchanged", () => {
	const text = fc.constantFrom("North", "it's", 'say "hi"', "");
	const literalValue = fc.oneof(
		text.map((value) => ({ kind: "term", term: { kind: "literal", value } })),
		fc
			.integer({ min: -1000, max: 1000 })
			.map((value) => ({ kind: "term", term: { kind: "literal", value } })),
	) as fc.Arbitrary<Expression>;
	const prop = (property: string): Expression => ({
		kind: "term",
		term: { kind: "prop", caseType: "Member", property },
	});
	const runtime = fc.constantFrom<Expression>(
		{ kind: "term", term: { kind: "session-context", field: "username" } },
		chosenCaseId(households),
		chosenCaseProperty(households, "Household", "village"),
	);
	const value = fc.oneof(
		literalValue,
		runtime,
		fc.constantFrom<Expression>(
			prop("age"),
			prop("case_name"),
			{ kind: "today" },
			{ kind: "date-coerce", value: prop("age") },
			{
				kind: "datetime-coerce",
				value: {
					kind: "term",
					term: { kind: "literal", value: 19000.5, data_type: "decimal" },
				},
			},
			{ kind: "term", term: { kind: "case-row-type" } },
		),
	);
	const { condition } = fc.letrec<{ condition: Expression }>((tie) => ({
		condition: fc.oneof(
			{ depthSize: "small", withCrossShrink: true },
			fc
				.tuple(fc.constantFrom("eq", "neq", "gt", "lte"), value, value)
				.map(([kind, left, right]) => ({ kind, left, right }) as Expression),
			fc.constantFrom("Household", "Member").map(
				(caseType): Expression => ({
					kind: "eq",
					left: { kind: "term", term: { kind: "case-row-type" } },
					right: { kind: "term", term: { kind: "case-type", caseType } },
				}),
			),
			fc
				.tuple(
					fc.constantFrom("any", "all"),
					fc.array(
						fc.oneof(
							fc
								.constantFrom("a", "b")
								.map((value) => ({ kind: "literal", value })),
							runtime,
						),
						{ minLength: 1, maxLength: 3 },
					),
				)
				.map(
					([quantifier, values]) =>
						({
							kind: "multi-select-contains",
							quantifier,
							property: { kind: "prop", caseType: "Member", property: "age" },
							values,
						}) as Expression,
				),
			fc
				.tuple(
					fc.oneof(
						fc.integer({ min: 1, max: 100 }),
						fc.constant<Expression>({ kind: "double", value: prop("age") }),
					),
					fc.oneof(fc.constantFrom(...DISTANCE_UNITS), runtime),
				)
				.map(
					([distance, unit]) =>
						({
							kind: "within-distance",
							property: { kind: "prop", caseType: "Member", property: "age" },
							center: {
								kind: "term",
								term: { kind: "literal", value: "1 2" },
							},
							distance,
							unit,
						}) as Expression,
				),
			fc
				.tuple(tie("condition"), tie("condition"))
				.map(([a, b]) => ({ kind: "and", clauses: [a, b] }) as Expression),
			tie("condition").map((clause) => ({ kind: "not", clause }) as Expression),
			fc
				.tuple(tie("condition"), tie("condition"), tie("condition"))
				.map(
					([cond, then, otherwise]) =>
						({ kind: "if", cond, then, else: otherwise }) as Expression,
				),
			fc.tuple(runtime, tie("condition"), tie("condition")).map(
				([on, then, fallback]) =>
					({
						kind: "switch",
						on,
						cases: [{ when: { kind: "literal", value: "North" }, then }],
						fallback,
					}) as Expression,
			),
		),
	}));
	fc.assert(
		fc.property(condition, (tree) => {
			const printed = memberPrinter.predicate(tree);
			expect(parseQueryPredicate(printed, memberScope), printed).toEqual(tree);
		}),
		{ seed: 20261019, numRuns: 300 },
	);
});
