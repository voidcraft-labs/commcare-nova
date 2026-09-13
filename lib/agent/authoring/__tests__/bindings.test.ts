import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { makeCanonicalGenesisDoc } from "@/lib/agent/__tests__/fixtures";
import { type CaseType, proseText } from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { checkPredicate, checkValueExpression } from "@/lib/domain/predicate";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { AuthoringScope } from "../bindings";
import { parseAuthoringMessage, printAuthoringMessage } from "../messages";
import { queryPrinter } from "../printQueryExpression";
import { parseQueryPredicate, parseQueryValue } from "../queryExpressions";

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
	expect(() => parseQueryValue("#row/code", scope)).toThrow("data-table scope");
	expect(() =>
		parseQueryValue("lookup('Missing', 'name', true())", scope),
	).toThrow("not in this scope");
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
	expect(printAuthoringMessage(message)).toBe(source);
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
