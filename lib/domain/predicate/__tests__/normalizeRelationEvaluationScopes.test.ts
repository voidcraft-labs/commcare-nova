import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	and,
	anyRelationPath,
	arith,
	between,
	coalesce,
	concat,
	count,
	dateAdd,
	dateCoerce,
	datetimeCoerce,
	double,
	eq,
	exists,
	formatDate,
	ifExpr,
	input,
	isBlank,
	isIn,
	isNull,
	literal,
	match,
	matchAll,
	multiSelectAll,
	not,
	now,
	prop,
	relationStep,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	today,
	unwrapList,
	whenInput,
	within,
} from "@/lib/domain/predicate/builders";
import {
	normalizeRelationEvaluationScopes,
	RelationEvaluationScopeError,
} from "../normalizeRelationEvaluationScopes";
import type { Predicate, RelationPath, ValueExpression } from "../types";
import { walkTerms } from "../walk";

const CASE_TYPES: CaseType[] = [
	{
		name: "household",
		properties: [{ name: "region", label: "Region", data_type: "text" }],
	},
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{ name: "name", label: "Name", data_type: "text" },
			{ name: "nickname", label: "Nickname", data_type: "text" },
			{ name: "age", label: "Age", data_type: "int" },
			{ name: "status", label: "Status", data_type: "text" },
			{ name: "tags", label: "Tags", data_type: "multi_select" },
			{ name: "location", label: "Location", data_type: "geopoint" },
		],
	},
	{
		name: "visit",
		parent_type: "household",
		properties: [{ name: "name", label: "Name", data_type: "text" }],
	},
	{
		name: "encounter",
		parent_type: "patient",
		properties: [{ name: "summary", label: "Summary", data_type: "text" }],
	},
];

const CONTEXT = {
	caseTypes: CASE_TYPES,
	currentCaseType: "household",
} as const;
const PATIENTS = subcasePath("parent", "patient");

function relatedPatient(property: string) {
	return prop("household", property, PATIENTS);
}

function expectOnePatientScope(
	authored: Predicate,
	assertInner?: (inner: Predicate) => void,
): void {
	const normalized = normalizeRelationEvaluationScopes(authored, CONTEXT);
	expect(normalized.kind).toBe("exists");
	if (normalized.kind !== "exists") return;
	expect(normalized.via).toEqual(PATIENTS);
	expect(normalized.where).toBeDefined();
	if (normalized.where === undefined) return;
	const properties: Array<{
		caseType: string;
		property: string;
		via?: RelationPath;
	}> = [];
	walkTerms(normalized.where, (value) => {
		if (value.kind === "prop") properties.push(value);
	});
	expect(properties.length).toBeGreaterThan(0);
	expect(properties).toEqual(
		expect.arrayContaining(
			properties.map((property) =>
				expect.objectContaining({
					caseType: "patient",
					property: property.property,
				}),
			),
		),
	);
	for (const property of properties) expect(property.via).toBeUndefined();
	assertInner?.(normalized.where);
}

describe("normalizeRelationEvaluationScopes — one row per scalar leaf", () => {
	it("uses one exists envelope for two properties read through the same relation", () => {
		const authored = eq(relatedPatient("name"), relatedPatient("nickname"));
		expect(normalizeRelationEvaluationScopes(authored, CONTEXT)).toEqual(
			exists(
				PATIENTS,
				eq(prop("patient", "name"), prop("patient", "nickname")),
			),
		);
	});

	it("keeps separate boolean leaves independently quantified", () => {
		const authored = and(
			eq(relatedPatient("name"), literal("Alice")),
			eq(relatedPatient("status"), literal("open")),
		);
		expect(normalizeRelationEvaluationScopes(authored, CONTEXT)).toEqual(
			and(
				exists(PATIENTS, eq(prop("patient", "name"), literal("Alice"))),
				exists(PATIENTS, eq(prop("patient", "status"), literal("open"))),
			),
		);
	});

	it("gives each generic between bound its own related-row quantifier", () => {
		const authored = between(relatedPatient("age"), {
			lower: literal(18),
			upper: literal(65),
			upperInclusive: false,
		});
		expect(normalizeRelationEvaluationScopes(authored, CONTEXT)).toEqual({
			kind: "and",
			clauses: [
				exists(PATIENTS, {
					kind: "gte",
					left: term(prop("patient", "age")),
					right: term(literal(18)),
				}),
				exists(PATIENTS, {
					kind: "lt",
					left: term(prop("patient", "age")),
					right: term(literal(65)),
				}),
			],
		});
	});

	it.each([
		["in", isIn(relatedPatient("name"), literal("Alice"))],
		["is blank", isBlank(relatedPatient("name"))],
		["is null", isNull(relatedPatient("name"))],
		["match", match(relatedPatient("name"), literal("Ali"), "starts-with")],
		[
			"multi-select",
			multiSelectAll(
				relatedPatient("tags"),
				literal("urgent"),
				literal("review"),
			),
		],
		[
			"within distance",
			within(relatedPatient("location"), literal("42 -71"), 5, "miles"),
		],
	] satisfies ReadonlyArray<
		readonly [string, Predicate]
	>)("normalizes the %s operator's dedicated property/value slots", (_name, authored) =>
		expectOnePatientScope(authored));

	it.each([
		[
			"date-add",
			dateAdd(
				dateCoerce(term(relatedPatient("status"))),
				"days",
				term(literal(1)),
			),
		],
		["date-coerce", dateCoerce(term(relatedPatient("status")))],
		["datetime-coerce", datetimeCoerce(term(relatedPatient("status")))],
		["double", double(term(relatedPatient("age")))],
		["arith", arith("+", term(relatedPatient("age")), term(literal(1)))],
		["concat", concat(term(relatedPatient("name")), term(literal("!")))],
		[
			"coalesce",
			coalesce(term(relatedPatient("nickname")), term(literal("Unknown"))),
		],
		[
			"if branch",
			ifExpr(matchAll(), term(relatedPatient("name")), term(literal("none"))),
		],
		[
			"switch discriminator",
			switchExpr(
				term(relatedPatient("status")),
				[switchCase(literal("open"), term(literal("yes")))],
				term(literal("no")),
			),
		],
		["unwrap-list", unwrapList(term(relatedPatient("tags")))],
		[
			"format-date",
			formatDate(dateCoerce(term(relatedPatient("status"))), "iso"),
		],
	] satisfies ReadonlyArray<
		readonly [string, ValueExpression]
	>)("finds and rebases relation reads nested in %s expressions", (_name, expression) =>
		expectOnePatientScope(eq(expression, term(literal("result")))));

	it("leaves via-free predicates unchanged by identity", () => {
		const authored = eq(prop("household", "region"), literal("north"));
		expect(normalizeRelationEvaluationScopes(authored, CONTEXT)).toBe(authored);
	});

	it("is idempotent", () => {
		const authored = eq(relatedPatient("name"), literal("Alice"));
		const once = normalizeRelationEvaluationScopes(authored, CONTEXT);
		expect(normalizeRelationEvaluationScopes(once, CONTEXT)).toEqual(once);
	});
});

describe("normalizeRelationEvaluationScopes — relation identity", () => {
	it("coalesces inferred and explicit equivalent child paths", () => {
		const singleChildContext = {
			caseTypes: CASE_TYPES.filter((caseType) => caseType.name !== "visit"),
		};
		const inferred = prop("household", "name", subcasePath("parent"));
		const explicit = prop(
			"household",
			"nickname",
			subcasePath("parent", "patient"),
		);
		expect(
			normalizeRelationEvaluationScopes(
				eq(inferred, explicit),
				singleChildContext,
			),
		).toEqual(
			exists(
				subcasePath("parent", "patient"),
				eq(prop("patient", "name"), prop("patient", "nickname")),
			),
		);
	});

	it("canonicalizes every hop of an inferred multi-hop ancestor path", () => {
		const inferred = ancestorPath(
			relationStep("parent"),
			relationStep("parent"),
		);
		const explicit = ancestorPath(
			relationStep("parent", "patient"),
			relationStep("parent", "household"),
		);
		const authored = eq(
			prop("encounter", "region", inferred),
			prop("encounter", "region", explicit),
		);
		expect(normalizeRelationEvaluationScopes(authored, CONTEXT)).toEqual(
			exists(
				explicit,
				eq(prop("household", "region"), prop("household", "region")),
			),
		);
	});

	it("canonicalizes explicit quantifier and count paths from their current scope", () => {
		const context = {
			caseTypes: CASE_TYPES.filter((caseType) => caseType.name !== "visit"),
			currentCaseType: "household",
		} as const;
		const unqualifiedChild = subcasePath("parent");
		const qualifiedChild = subcasePath("parent", "patient");
		expect(
			normalizeRelationEvaluationScopes(
				exists(unqualifiedChild, eq(prop("patient", "name"), literal("A"))),
				context,
			),
		).toEqual(
			exists(qualifiedChild, eq(prop("patient", "name"), literal("A"))),
		);
		expect(
			normalizeRelationEvaluationScopes(
				eq(count(unqualifiedChild), literal(1)),
				context,
			),
		).toEqual(eq(count(qualifiedChild), literal(1)));
	});

	it("canonicalizes every hop of explicit multi-hop quantifiers and counts", () => {
		const context = {
			caseTypes: CASE_TYPES,
			currentCaseType: "encounter",
		} as const;
		const unqualified = ancestorPath(
			relationStep("parent"),
			relationStep("parent"),
		);
		const qualified = ancestorPath(
			relationStep("parent", "patient"),
			relationStep("parent", "household"),
		);
		const where = eq(prop("household", "region"), literal("north"));
		expect(
			normalizeRelationEvaluationScopes(exists(unqualified, where), context),
		).toEqual(exists(qualified, where));
		expect(
			normalizeRelationEvaluationScopes(
				eq(count(unqualified, where), literal(1)),
				context,
			),
		).toEqual(eq(count(qualified, where), literal(1)));
	});

	it("narrows an either-direction parent walk to its only graph-valid direction", () => {
		const context = {
			caseTypes: CASE_TYPES,
			currentCaseType: "encounter",
		} as const;
		const unqualified = anyRelationPath("parent");
		const qualified = ancestorPath(relationStep("parent", "patient"));
		const where = eq(prop("patient", "name"), literal("Alice"));
		expect(
			normalizeRelationEvaluationScopes(exists(unqualified, where), context),
		).toEqual(exists(qualified, where));
		expect(
			normalizeRelationEvaluationScopes(
				eq(count(unqualified, where), literal(1)),
				context,
			),
		).toEqual(eq(count(qualified, where), literal(1)));
	});

	it("narrows an either-direction parent walk to a child when that is the only graph-valid direction", () => {
		const context = {
			caseTypes: CASE_TYPES,
			currentCaseType: "patient",
		} as const;
		const where = eq(prop("encounter", "summary"), literal("Follow-up"));
		expect(
			normalizeRelationEvaluationScopes(
				exists(anyRelationPath("parent", "encounter"), where),
				context,
			),
		).toEqual(exists(subcasePath("parent", "encounter"), where));
	});

	it("keeps either-direction semantics for a recursive parent graph", () => {
		const recursiveTypes: CaseType[] = [
			{
				name: "node",
				parent_type: "node",
				properties: [{ name: "case_name", label: "Name", data_type: "text" }],
			},
		];
		const path = anyRelationPath("parent");
		const authored = exists(path, matchAll());
		expect(
			normalizeRelationEvaluationScopes(authored, {
				caseTypes: recursiveTypes,
				currentCaseType: "node",
			}),
		).toEqual(exists(anyRelationPath("parent", "node"), matchAll()));
	});

	it("keeps an explicit custom index either-directional", () => {
		const authored = exists(
			anyRelationPath("guardian_link", "household"),
			matchAll(),
		);
		expect(normalizeRelationEvaluationScopes(authored, CONTEXT)).toBe(authored);
	});

	it("does not guess a destination for an unqualified custom index", () => {
		const custom = subcasePath("guardian_link");
		const authored = exists(custom, matchAll());
		expect(normalizeRelationEvaluationScopes(authored, CONTEXT)).toBe(authored);
	});

	it("preserves an explicit custom-index destination outside the parent graph", () => {
		const custom = subcasePath("guardian_link", "household");
		const authored = exists(
			custom,
			eq(prop("household", "region"), literal("north")),
		);
		expect(normalizeRelationEvaluationScopes(authored, CONTEXT)).toBe(authored);
	});

	it("rebinds the source type before canonicalizing a nested ancestor path", () => {
		const context = {
			caseTypes: CASE_TYPES.filter((caseType) => caseType.name !== "visit"),
			currentCaseType: "household",
		} as const;
		const child = subcasePath("parent", "patient");
		const parent = ancestorPath(relationStep("parent", "household"));
		const authored = exists(
			subcasePath("parent"),
			exists(
				ancestorPath(relationStep("parent")),
				eq(prop("household", "region"), literal("north")),
			),
		);
		expect(normalizeRelationEvaluationScopes(authored, context)).toEqual(
			exists(
				child,
				exists(parent, eq(prop("household", "region"), literal("north"))),
			),
		);
	});

	it("does not conflate same-identifier paths to different child types", () => {
		const authored = eq(
			prop("household", "name", subcasePath("parent", "patient")),
			prop("household", "name", subcasePath("parent", "visit")),
		);
		expect(() =>
			normalizeRelationEvaluationScopes(authored, CONTEXT),
		).toThrowError(
			expect.objectContaining({
				name: "RelationEvaluationScopeError",
				reason: "mixed-property-scopes",
			}),
		);
	});
});

describe("normalizeRelationEvaluationScopes — independent boundaries", () => {
	it("normalizes an if condition independently instead of coupling it to an outer row", () => {
		const condition = eq(relatedPatient("status"), literal("open"));
		const authored = eq(
			ifExpr(condition, term(literal("OPEN")), term(literal("CLOSED"))),
			literal("CLOSED"),
		);
		expect(normalizeRelationEvaluationScopes(authored, CONTEXT)).toEqual(
			eq(
				ifExpr(
					exists(PATIENTS, eq(prop("patient", "status"), literal("open"))),
					term(literal("OPEN")),
					term(literal("CLOSED")),
				),
				literal("CLOSED"),
			),
		);
	});

	it("normalizes count.where in its destination scope", () => {
		const parent = ancestorPath(relationStep("parent", "household"));
		const authored = eq(
			count(PATIENTS, eq(prop("patient", "region", parent), literal("north"))),
			literal(1),
		);
		expect(normalizeRelationEvaluationScopes(authored, CONTEXT)).toEqual(
			eq(
				count(
					PATIENTS,
					exists(parent, eq(prop("household", "region"), literal("north"))),
				),
				literal(1),
			),
		);
	});

	it("normalizes nested relations inside an authored exists boundary", () => {
		const parent = ancestorPath(relationStep("parent", "household"));
		const authored = exists(
			PATIENTS,
			eq(prop("patient", "region", parent), literal("north")),
		);
		expect(normalizeRelationEvaluationScopes(authored, CONTEXT)).toEqual(
			exists(
				PATIENTS,
				exists(parent, eq(prop("household", "region"), literal("north"))),
			),
		);
	});

	it("keeps logical wrappers while normalizing their leaves", () => {
		const authored = not(
			whenInput(input("name"), eq(relatedPatient("name"), literal("Alice"))),
		);
		expect(normalizeRelationEvaluationScopes(authored, CONTEXT)).toEqual(
			not(
				whenInput(
					input("name"),
					exists(PATIENTS, eq(prop("patient", "name"), literal("Alice"))),
				),
			),
		);
	});
});

describe("normalizeRelationEvaluationScopes — fail-closed shapes", () => {
	it("rejects a scalar leaf that mixes this case and a related case", () => {
		const authored = eq(prop("household", "region"), relatedPatient("name"));
		expect(() =>
			normalizeRelationEvaluationScopes(authored, CONTEXT),
		).toThrowError(RelationEvaluationScopeError);
		try {
			normalizeRelationEvaluationScopes(authored, CONTEXT);
		} catch (error) {
			expect(error).toMatchObject({ reason: "mixed-property-scopes" });
		}
	});

	it("rejects a related scalar read combined with an anchor-sensitive count", () => {
		const authored = eq(
			arith("+", term(relatedPatient("age")), count(PATIENTS)),
			literal(3),
		);
		try {
			normalizeRelationEvaluationScopes(authored, CONTEXT);
			expect.unreachable("expected normalization to fail closed");
		} catch (error) {
			expect(error).toMatchObject({
				name: "RelationEvaluationScopeError",
				reason: "unrebasable-relation-scope",
			});
		}
	});

	it("rejects a related branch combined with an explicit quantifier boundary", () => {
		const authored = eq(
			ifExpr(
				exists(PATIENTS, eq(prop("patient", "status"), literal("open"))),
				term(relatedPatient("name")),
				term(literal("none")),
			),
			literal("Alice"),
		);
		try {
			normalizeRelationEvaluationScopes(authored, CONTEXT);
			expect.unreachable("expected normalization to fail closed");
		} catch (error) {
			expect(error).toMatchObject({
				name: "RelationEvaluationScopeError",
				reason: "unrebasable-relation-scope",
			});
		}
	});

	it("does not mistake runtime-only constants for additional case scopes", () => {
		const authored = eq(
			concat(
				term(relatedPatient("name")),
				today(),
				now(),
				term(input("suffix")),
			),
			literal("Alice"),
		);
		expectOnePatientScope(authored);
	});
});
