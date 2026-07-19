// lib/case-store/sql/__tests__/compilePredicate.relationReads.harness.test.ts
//
// Cross-row regressions for direct relational PropertyRef comparison operands.
// A leaf with one relation scope becomes one existential row envelope. Every
// property in that leaf therefore reads the same related row; mixing the anchor
// with a related scope or two different relation scopes is intentionally
// rejected instead of inventing ambiguous pairwise semantics. An empty relation
// makes every quantified leaf false (including `!=`).

import { describe } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	and,
	anyRelationPath,
	between,
	eq,
	exists,
	gte,
	isBlank,
	isIn,
	isNull,
	literal,
	lte,
	match,
	multiSelectAll,
	neq,
	prop,
	subcasePath,
	within,
} from "@/lib/domain/predicate/builders";
import {
	compilePredicate,
	type PredicateCompileContext,
} from "../compilePredicate";
import { expect, makeCaseRow, test } from "./setup";

const APP_ID = "app-relation-read-normalization";
const PROJECT_ID = "project-relation-read-normalization";
const HOUSEHOLD_ID = "71000000-0000-0000-0000-000000000001";
const NONMATCHING_CHILD_ID = "71000000-0000-0000-0000-000000000002";
const MATCHING_CHILD_ID = "71000000-0000-0000-0000-000000000003";
const NONMATCHING_ANCESTOR_ID = "71000000-0000-0000-0000-000000000004";
const EMPTY_HOUSEHOLD_ID = "71000000-0000-0000-0000-000000000005";

const HOUSEHOLD_SCHEMA: CaseType = {
	name: "household",
	properties: [{ name: "region", label: "Region", data_type: "text" }],
};

const PATIENT_SCHEMA: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "nickname", label: "Nickname", data_type: "text" },
		{ name: "alias", label: "Alias", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "tags", label: "Tags", data_type: "multi_select" },
		{ name: "location", label: "Location", data_type: "geopoint" },
	],
};

const SCHEMAS = new Map<string, CaseType>([
	[HOUSEHOLD_SCHEMA.name, HOUSEHOLD_SCHEMA],
	[PATIENT_SCHEMA.name, PATIENT_SCHEMA],
]);

function makeCtx(db: PredicateCompileContext["db"]): PredicateCompileContext {
	return {
		db,
		appId: APP_ID,
		projectId: PROJECT_ID,
		anchorAlias: "c",
		currentCaseType: "household",
		caseTypeSchemas: SCHEMAS,
		bindings: {},
	};
}

async function executeHouseholdPredicate(
	db: PredicateCompileContext["db"],
	predicate: Parameters<typeof compilePredicate>[0],
): Promise<string[]> {
	const rows = await db
		.selectFrom("cases as c")
		.select("c.case_id")
		.where("c.app_id", "=", APP_ID)
		.where("c.project_id", "=", PROJECT_ID)
		.where("c.case_type", "=", "household")
		.where(compilePredicate(predicate, makeCtx(db)))
		.execute();
	return rows.map((row) => row.case_id);
}

async function seedHouseholdWithTwoChildren(
	db: PredicateCompileContext["db"],
	args: {
		nonmatching: Record<string, unknown>;
		matching: Record<string, unknown>;
	},
): Promise<void> {
	await db
		.insertInto("cases")
		.values([
			makeCaseRow({
				case_id: HOUSEHOLD_ID,
				app_id: APP_ID,
				project_id: PROJECT_ID,
				case_type: "household",
			}),
			makeCaseRow({
				case_id: NONMATCHING_CHILD_ID,
				app_id: APP_ID,
				project_id: PROJECT_ID,
				case_type: "patient",
				properties: JSON.stringify(args.nonmatching),
			}),
			makeCaseRow({
				case_id: MATCHING_CHILD_ID,
				app_id: APP_ID,
				project_id: PROJECT_ID,
				case_type: "patient",
				properties: JSON.stringify(args.matching),
			}),
		])
		.execute();
	await db
		.insertInto("case_indices")
		.values([
			{
				case_id: NONMATCHING_CHILD_ID,
				ancestor_id: HOUSEHOLD_ID,
				identifier: "parent",
				relationship: "child",
				depth: 1,
			},
			{
				case_id: MATCHING_CHILD_ID,
				ancestor_id: HOUSEHOLD_ID,
				identifier: "parent",
				relationship: "child",
				depth: 1,
			},
		])
		.execute();
}

async function seedEmptyHousehold(
	db: PredicateCompileContext["db"],
): Promise<void> {
	await db
		.insertInto("cases")
		.values(
			makeCaseRow({
				case_id: EMPTY_HOUSEHOLD_ID,
				app_id: APP_ID,
				project_id: PROJECT_ID,
				case_type: "household",
			}),
		)
		.execute();
}

describe("compilePredicate — normalized relation property reads", () => {
	test("subcase comparison considers every related row, not an arbitrary first row", async ({
		db,
	}) => {
		await seedHouseholdWithTwoChildren(db, {
			nonmatching: { nickname: "Not Alice" },
			matching: { nickname: "Alice" },
		});

		const predicate = eq(
			prop("household", "nickname", subcasePath("parent", "patient")),
			literal("Alice"),
		);

		expect(await executeHouseholdPredicate(db, predicate)).toEqual([
			HOUSEHOLD_ID,
		]);
	});

	test("an inferred child type excludes a different case type using the same index name", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: HOUSEHOLD_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "household",
				}),
				makeCaseRow({
					case_id: NONMATCHING_CHILD_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "patient",
					properties: JSON.stringify({ nickname: "Not Alice" }),
				}),
				makeCaseRow({
					case_id: MATCHING_CHILD_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "visit",
					properties: JSON.stringify({ nickname: "Alice" }),
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values([
				{
					case_id: NONMATCHING_CHILD_ID,
					ancestor_id: HOUSEHOLD_ID,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: MATCHING_CHILD_ID,
					ancestor_id: HOUSEHOLD_ID,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
			])
			.execute();

		const predicate = eq(
			prop("household", "nickname", subcasePath("parent")),
			literal("Alice"),
		);
		expect(await executeHouseholdPredicate(db, predicate)).toEqual([]);
	});

	test("between evaluates both bounded comparisons across later related rows", async ({
		db,
	}) => {
		await seedHouseholdWithTwoChildren(db, {
			nonmatching: { age: 10 },
			matching: { age: 22 },
		});

		const predicate = between(
			prop("household", "age", subcasePath("parent", "patient")),
			{ lower: literal(20), upper: literal(25) },
		);

		expect(await executeHouseholdPredicate(db, predicate)).toEqual([
			HOUSEHOLD_ID,
		]);
	});

	test("in checks every related row for both single and multiple values", async ({
		db,
	}) => {
		await seedHouseholdWithTwoChildren(db, {
			nonmatching: { nickname: "Nobody" },
			matching: { nickname: "Alice" },
		});
		await seedEmptyHousehold(db);

		const relatedName = prop(
			"household",
			"nickname",
			subcasePath("parent", "patient"),
		);
		expect(
			await executeHouseholdPredicate(db, isIn(relatedName, literal("Alice"))),
		).toEqual([HOUSEHOLD_ID]);
		expect(
			await executeHouseholdPredicate(
				db,
				isIn(relatedName, literal("Bob"), literal("Alice")),
			),
		).toEqual([HOUSEHOLD_ID]);
	});

	test("related match checks later rows and an empty relation stays false", async ({
		db,
	}) => {
		await seedHouseholdWithTwoChildren(db, {
			nonmatching: { nickname: "Bob" },
			matching: { nickname: "Alice" },
		});
		await seedEmptyHousehold(db);
		const predicate = match(
			prop("household", "nickname", subcasePath("parent", "patient")),
			"Ali",
			"starts-with",
		);
		expect(await executeHouseholdPredicate(db, predicate)).toEqual([
			HOUSEHOLD_ID,
		]);
	});

	test("related multi-select all keeps every token on one later row", async ({
		db,
	}) => {
		await seedHouseholdWithTwoChildren(db, {
			nonmatching: { tags: ["urgent"] },
			matching: { tags: ["urgent", "review"] },
		});
		await seedEmptyHousehold(db);
		const predicate = multiSelectAll(
			prop("household", "tags", subcasePath("parent", "patient")),
			literal("urgent"),
			literal("review"),
		);
		expect(await executeHouseholdPredicate(db, predicate)).toEqual([
			HOUSEHOLD_ID,
		]);
	});

	test("related multi-select all does not split tokens across rows", async ({
		db,
	}) => {
		await seedHouseholdWithTwoChildren(db, {
			nonmatching: { tags: ["urgent"] },
			matching: { tags: ["review"] },
		});
		const predicate = multiSelectAll(
			prop("household", "tags", subcasePath("parent", "patient")),
			literal("urgent"),
			literal("review"),
		);
		expect(await executeHouseholdPredicate(db, predicate)).toEqual([]);
	});

	test("related within-distance checks later rows and no related row is false", async ({
		db,
	}) => {
		await seedHouseholdWithTwoChildren(db, {
			nonmatching: { location: "40.7128 -74.0060 0 0" },
			matching: { location: "42.3736 -71.1097 0 0" },
		});
		await seedEmptyHousehold(db);
		const predicate = within(
			prop("household", "location", subcasePath("parent", "patient")),
			literal("42.3601 -71.0589 0 0"),
			10,
			"miles",
		);
		expect(await executeHouseholdPredicate(db, predicate)).toEqual([
			HOUSEHOLD_ID,
		]);
	});

	test("generic between keeps XPath's independent existential bounds", async ({
		db,
	}) => {
		await seedHouseholdWithTwoChildren(db, {
			nonmatching: { age: 10 },
			matching: { age: 30 },
		});

		// No child has age 20. XPath still matches: age 30 satisfies >= 20 and
		// age 10 independently satisfies <= 20.
		const predicate = between(
			prop("household", "age", subcasePath("parent", "patient")),
			{ lower: literal(20), upper: literal(20) },
		);
		expect(await executeHouseholdPredicate(db, predicate)).toEqual([
			HOUSEHOLD_ID,
		]);
	});

	test("explicit exists keeps both between bounds on one related row", async ({
		db,
	}) => {
		await seedHouseholdWithTwoChildren(db, {
			nonmatching: { age: 10 },
			matching: { age: 30 },
		});
		const via = subcasePath("parent", "patient");
		const predicate = exists(
			via,
			and(
				gte(prop("patient", "age"), literal(20)),
				lte(prop("patient", "age"), literal(20)),
			),
		);
		expect(await executeHouseholdPredicate(db, predicate)).toEqual([]);
	});

	test("self-vs-related and related-vs-self comparisons fail closed as mixed scopes", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: HOUSEHOLD_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "household",
					properties: JSON.stringify({ region: "south" }),
				}),
				makeCaseRow({
					case_id: NONMATCHING_CHILD_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "patient",
					properties: JSON.stringify({ nickname: "north" }),
				}),
				makeCaseRow({
					case_id: MATCHING_CHILD_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "patient",
					properties: JSON.stringify({ nickname: "south" }),
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values([
				{
					case_id: NONMATCHING_CHILD_ID,
					ancestor_id: HOUSEHOLD_ID,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: MATCHING_CHILD_ID,
					ancestor_id: HOUSEHOLD_ID,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
			])
			.execute();

		const related = prop(
			"household",
			"nickname",
			subcasePath("parent", "patient"),
		);
		const self = prop("household", "region");
		await expect(
			executeHouseholdPredicate(db, eq(self, related)),
		).rejects.toThrow(/mixed-property-scopes/);
		await expect(
			executeHouseholdPredicate(db, eq(related, self)),
		).rejects.toThrow(/mixed-property-scopes/);
	});

	test("two properties on the same relation compare within one related row", async ({
		db,
	}) => {
		await seedHouseholdWithTwoChildren(db, {
			nonmatching: { nickname: "Alice", alias: "x" },
			matching: { nickname: "y", alias: "Alice" },
		});
		const via = subcasePath("parent", "patient");
		const nickname = prop("household", "nickname", via);
		const alias = prop("household", "alias", via);

		// The equal values occur on different children, so no one child satisfies
		// the equality. Both children do satisfy the inequality on their own row.
		expect(await executeHouseholdPredicate(db, eq(nickname, alias))).toEqual(
			[],
		);
		expect(await executeHouseholdPredicate(db, neq(nickname, alias))).toEqual([
			HOUSEHOLD_ID,
		]);
	});

	test("two independent relation scopes fail closed instead of cross-joining", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: HOUSEHOLD_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "household",
				}),
				makeCaseRow({
					case_id: NONMATCHING_CHILD_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "patient",
					properties: JSON.stringify({ nickname: "Alice" }),
				}),
				makeCaseRow({
					case_id: MATCHING_CHILD_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "patient",
					properties: JSON.stringify({ alias: "Alice" }),
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values([
				{
					case_id: NONMATCHING_CHILD_ID,
					ancestor_id: HOUSEHOLD_ID,
					identifier: "primary",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: MATCHING_CHILD_ID,
					ancestor_id: HOUSEHOLD_ID,
					identifier: "secondary",
					relationship: "child",
					depth: 1,
				},
			])
			.execute();

		const predicate = eq(
			prop("household", "nickname", subcasePath("primary", "patient")),
			prop("household", "alias", subcasePath("secondary", "patient")),
		);
		await expect(executeHouseholdPredicate(db, predicate)).rejects.toThrow(
			/mixed-property-scopes/,
		);
	});

	test("any-relation considers both directions instead of taking the first UNION row", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: HOUSEHOLD_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "household",
				}),
				makeCaseRow({
					case_id: NONMATCHING_ANCESTOR_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "patient",
					properties: JSON.stringify({ nickname: "Not Alice" }),
				}),
				makeCaseRow({
					case_id: MATCHING_CHILD_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "patient",
					properties: JSON.stringify({ nickname: "Alice" }),
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values([
				{
					case_id: HOUSEHOLD_ID,
					ancestor_id: NONMATCHING_ANCESTOR_ID,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: MATCHING_CHILD_ID,
					ancestor_id: HOUSEHOLD_ID,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
			])
			.execute();

		const predicate = eq(
			prop("household", "nickname", anyRelationPath("parent", "patient")),
			literal("Alice"),
		);

		expect(await executeHouseholdPredicate(db, predicate)).toEqual([
			HOUSEHOLD_ID,
		]);
	});

	test("is-null does not invent a related row when no relation exists", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: HOUSEHOLD_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "household",
				}),
			)
			.execute();

		const predicate = isNull(
			prop("household", "nickname", subcasePath("parent", "patient")),
		);

		expect(await executeHouseholdPredicate(db, predicate)).toEqual([]);
	});

	test("related null/blank checks quantify real rows and preserve strict absence", async ({
		db,
	}) => {
		await seedHouseholdWithTwoChildren(db, {
			nonmatching: {},
			matching: { nickname: "" },
		});
		const related = prop(
			"household",
			"nickname",
			subcasePath("parent", "patient"),
		);
		expect(await executeHouseholdPredicate(db, isNull(related))).toEqual([
			HOUSEHOLD_ID,
		]);
		expect(await executeHouseholdPredicate(db, isBlank(related))).toEqual([
			HOUSEHOLD_ID,
		]);
	});

	test("related inequality is false for an empty relation", async ({ db }) => {
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: HOUSEHOLD_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "household",
				}),
			)
			.execute();
		const predicate = neq(
			prop("household", "nickname", subcasePath("parent", "patient")),
			literal("Alice"),
		);
		expect(await executeHouseholdPredicate(db, predicate)).toEqual([]);
	});
});
