import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { makeCanonicalGenesisDoc } from "@/lib/agent/__tests__/fixtures";
import { parseAuthoredXPath } from "@/lib/doc/expressionText";
import { type CaseType, proseText } from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { checkPredicate, checkValueExpression } from "@/lib/domain/predicate";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { AuthoringScope } from "../bindings";
import { parseAuthoringMessage, printAuthoringMessage } from "../messages";
import { authoringEncoders } from "../output";
import { queryPrinter } from "../printQueryExpression";
import { parseQueryPredicate, parseQueryValue } from "../queryExpressions";
import { normalizeText, printAuthoringText } from "../text";

const household: CaseType = {
	name: "Household",
	properties: [
		{ name: "region", label: proseText("Region"), data_type: "text" },
	],
};
const patient: CaseType = {
	name: "Patient",
	parent_type: "Household",
	relationship: "child",
	properties: [{ name: "age", label: proseText("Age"), data_type: "int" }],
};

it("binds related names on their destination while preserving the canonical origin", () => {
	const doc = { ...makeCanonicalGenesisDoc(), caseTypes: [household, patient] };
	const scope = new AuthoringScope({ doc, currentCaseType: "Patient" });
	const printer = queryPrinter(scope);
	expect(() => parseQueryValue("#record/Patient/age/typo", scope)).toThrow(
		"exactly one",
	);
	const value = parseQueryValue("via(ancestor('parent'), #case/region)", scope);
	expect(value).toEqual({
		kind: "term",
		term: {
			kind: "prop",
			caseType: "Patient",
			property: "region",
			via: { kind: "ancestor", via: [{ identifier: "parent" }] },
		},
	});
	expect(checkValueExpression(value, scope.typeContext)).toEqual({ ok: true });
	expect(parseQueryValue(printer.value(value), scope)).toEqual(value);
	expect(() =>
		parseQueryValue("via(ancestor('parent'), #case/age)", scope),
	).toThrow("Household has no property age");
	expect(() => parseQueryValue("#Household/region", scope)).toThrow(
		"use a relationship",
	);
	const householdScope = new AuthoringScope({
		doc,
		currentCaseType: "Household",
	});
	const condition = parseQueryPredicate(
		"exists(children('Patient'), #case/age >= 18)",
		householdScope,
	);
	expect(checkPredicate(condition, householdScope.typeContext)).toEqual({
		ok: true,
	});
	expect(
		parseQueryPredicate(
			queryPrinter(householdScope).predicate(condition),
			householdScope,
		),
	).toEqual(condition);
});

it("resolves identically named columns within the requested table and preserves nested lookup scope", () => {
	const doc = makeCanonicalGenesisDoc();
	const tables = ["Districts", "Clinics"].map((name) => ({
		id: lookupTableIdSchema.parse(uuidv7()),
		name,
		tag: name.toLowerCase(),
		definitionRevision: parseLookupRevision("0"),
		columns: ["code", "name"].map((wireName) => ({
			id: lookupColumnIdSchema.parse(uuidv7()),
			wireName,
			label: wireName,
			dataType: "text" as const,
		})),
	}));
	const scope = new AuthoringScope({ doc, tables });
	for (const table of tables) {
		const source = `lookup('${table.name}', 'name', #row/code = 'north')`;
		const value = parseQueryValue(source, scope);
		expect(value).toMatchObject({
			kind: "table-lookup",
			tableId: table.id,
			where: {
				left: { term: { tableId: table.id, columnId: table.columns[0].id } },
			},
		});
		expect(checkValueExpression(value, scope.typeContext)).toEqual({
			ok: true,
		});
		expect(parseQueryValue(queryPrinter(scope).value(value), scope)).toEqual(
			value,
		);
	}
	const initial = parseQueryValue(
		"lookup('Districts', 'name', #row/code = 'north')",
		scope,
	);
	const collisionTables = tables.map((table) => ({
		...table,
		columns: table.columns.map((column, index) =>
			index === 1 ? { ...column, label: "code" } : column,
		),
	}));
	const collisionScope = new AuthoringScope({ doc, tables: collisionTables });
	expect(() =>
		collisionScope.forTable(tables[0].id).reference("row", ["code"]),
	).toThrow("ambiguous");
	const printed = queryPrinter(collisionScope).value(initial);
	expect(printed).toContain(tables[0].columns[0].id);
	expect(parseQueryValue(printed, collisionScope)).toEqual(initial);
	expect(() => parseQueryValue("#row/code", scope)).toThrow("data-table scope");
	expect(() =>
		parseQueryValue("lookup('Missing', 'name', true())", scope),
	).toThrow("not in this scope");
	const numericTable = {
		...tables[0],
		columns: tables[0].columns.map((column) => ({
			...column,
			dataType: "int" as const,
		})),
	};
	const scoped = new AuthoringScope({
		doc,
		tables: [numericTable],
		tableId: numericTable.id,
	});
	const filter = parseQueryPredicate("quotient(#row/code, 2) >= 1", scoped);
	const source = { optionsSource: { tableId: numericTable.id, filter } };
	const printedFilter = authoringEncoders(
		{ doc, tables: [numericTable] },
		source,
	).condition(filter, ["optionsSource", "filter"]);
	expect(printedFilter).toContain("#row/code");
	expect(parseQueryPredicate(String(printedFilter), scoped)).toEqual(filter);
});

it("rejects ambiguous field names and binds authored worker information by stable identity", () => {
	const uuid = testUuid("region");
	const doc = {
		...makeCanonicalGenesisDoc(),
		userProperties: { [uuid]: { uuid, slug: "region", label: "Region" } },
	};
	const a = testUuid("a"),
		b = testUuid("b");
	const scope = new AuthoringScope({
		doc,
		fields: [
			{ uuid: a, path: "age", kind: "int" },
			{ uuid: b, path: "age", kind: "int" },
			{ uuid: a, path: "demographics/age", kind: "int" },
		],
	});
	expect(() => parseQueryValue("#form/age", scope)).toThrow("ambiguous");
	expect(parseQueryValue("#form/demographics/age", scope)).toMatchObject({
		term: { kind: "field", uuid: a },
	});
	const value = parseQueryValue("user('region')", scope);
	const external = parseQueryValue("external-user('region')", scope);
	expect(external).toEqual({
		kind: "term",
		term: { kind: "session-user", field: "region" },
	});
	expect(parseQueryValue(queryPrinter(scope).value(external), scope)).toEqual(
		external,
	);
	expect(value).toEqual({
		kind: "term",
		term: { kind: "session-user-property", userPropertyUuid: uuid },
	});
	expect(() => parseQueryValue("user('Region')", scope)).toThrow(
		"capitalization",
	);
	doc.userProperties = {
		[uuid]: { ...doc.userProperties[uuid], slug: "district" },
	};
	const renamed = new AuthoringScope({ doc });
	expect(queryPrinter(renamed).value(value)).toBe("user('district')");
	expect(parseQueryValue(queryPrinter(renamed).value(value), renamed)).toEqual(
		value,
	);
	expect(parseQueryValue("user('external')", renamed)).toMatchObject({
		term: { kind: "session-user", field: "external" },
	});
});

it("roundtrips message text and binds parent versus host references without changing literal braces", () => {
	const source =
		"Hi {{#recipient/first_name}}: {{#parent/region}}. Literal \\{{#case/age}} and C:\\\\data.";
	const message = parseAuthoringMessage(source, "Patient", [
		patient,
		household,
	]);
	expect(message.parts).toContainEqual({
		kind: "case-property",
		scope: "parent",
		caseType: "Household",
		property: "region",
	});
	expect(printAuthoringMessage(message)).toBe(source.replace("\\{{", "\\{\\{"));
	expect(
		parseAuthoringMessage(printAuthoringMessage(message), "Patient", [
			patient,
			household,
		]),
	).toEqual(message);
	expect(() =>
		parseAuthoringMessage("{{#host/region}}", "Patient", [patient, household]),
	).toThrow("no host");
	const extension: CaseType = { ...patient, relationship: "extension" };
	expect(
		parseAuthoringMessage("{{#host/region}}", "Patient", [extension, household])
			.parts,
	).toContainEqual({
		kind: "case-property",
		scope: "host",
		caseType: "Household",
		property: "region",
	});
	expect(() =>
		parseAuthoringMessage("{{#parent/region}}", "Patient", [
			extension,
			household,
		]),
	).toThrow("no parent");
});

it("keeps literal opening braces separate from an adjacent prose or message reference", () => {
	const uuid = testUuid("region");
	const doc = {
		...makeCanonicalGenesisDoc(),
		userProperties: { [uuid]: { uuid, slug: "region", label: "Region" } },
	};
	for (const text of ["{", "{{", "\\{", "{{prefix"]) {
		const prose = {
			parts: [
				{ kind: "text" as const, text },
				{ kind: "user-property-ref" as const, userPropertyUuid: uuid },
				{ kind: "text" as const, text: "}" },
			],
		};
		const printed = printAuthoringText(prose, doc);
		expect(
			normalizeText(printed, (source) =>
				parseAuthoredXPath(doc, undefined, () => undefined, source),
			),
		).toEqual(prose);
		const message = {
			parts: [
				{ kind: "text" as const, text },
				{
					kind: "case-property" as const,
					caseType: "Patient",
					scope: "case" as const,
					property: "age",
				},
				{ kind: "text" as const, text: "}" },
			],
		};
		expect(
			parseAuthoringMessage(printAuthoringMessage(message), "Patient", [
				patient,
			]),
		).toEqual(message);
	}
});
