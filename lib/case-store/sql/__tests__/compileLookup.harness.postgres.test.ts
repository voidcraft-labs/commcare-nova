// lib/case-store/sql/__tests__/compileLookup.harness.postgres.test.ts
//
// Execute-against-real-Postgres tests for the lookup-carrier compiler
// arms. The lookup-carrier selection semantics are the contract under test:
// first matching row in authored `(order_key, id)` order; no match is
// SQL NULL (the wire's empty node-set), never manufactured empty
// text; a matched row's absent cell reads NULL while a stored empty
// string reads `''`; cells compare under the column's declared type
// with the same casts case properties use; and every subquery is
// bound to the caller's Project.
//
// Definition rows (`lookup_tables` / `lookup_columns`) seed through
// raw SQL — they are `lib/db` tables outside the case-store `Database`
// type, present in the harness because one Migrator owns every table.
// `lookup_rows` rides the typed handle (the compiler's read view).

import { sql } from "kysely";
import { describe } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	type LookupColumnId,
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	and,
	eq,
	isBlank,
	literal,
	prop,
	tableColumn,
	tableLookup,
} from "@/lib/domain/predicate/builders";
import { proseText } from "@/lib/domain/prose";
import { compileExpression } from "../compileExpression";
import type { LookupTableSchemas } from "../compileLookup";
import {
	compilePredicate,
	expressionContextFor,
	type PredicateCompileContext,
} from "../compilePredicate";
import { expect, makeCaseRow, test } from "./setup";

const APP_ID = "app-lookup-compiler";
const PROJECT_ID = "project-lookup-compiler";
const FOREIGN_PROJECT_ID = "project-lookup-foreign";

const REGIONS = lookupTableIdSchema.parse(
	"01920000-0000-7000-8000-00000000000a",
);
const COL_CODE = lookupColumnIdSchema.parse(
	"01920000-0000-7000-8000-0000000000c1",
);
const COL_LABEL = lookupColumnIdSchema.parse(
	"01920000-0000-7000-8000-0000000000c2",
);
const COL_RANK = lookupColumnIdSchema.parse(
	"01920000-0000-7000-8000-0000000000c3",
);
const COL_SINCE = lookupColumnIdSchema.parse(
	"01920000-0000-7000-8000-0000000000c4",
);

const OTHER_TABLE = lookupTableIdSchema.parse(
	"01920000-0000-7000-8000-00000000000b",
);
const OTHER_COL = lookupColumnIdSchema.parse(
	"01920000-0000-7000-8000-0000000000d1",
);

const PATIENT_SCHEMA: CaseType = {
	name: "patient",
	properties: [
		{ name: "region_code", label: proseText("Region code"), data_type: "text" },
	],
};

const CASE_SCHEMAS = new Map<string, CaseType>([["patient", PATIENT_SCHEMA]]);

const LOOKUP_SCHEMAS: LookupTableSchemas = new Map([
	[
		REGIONS,
		new Map([
			[COL_CODE, "text" as const],
			[COL_LABEL, "text" as const],
			[COL_RANK, "int" as const],
			[COL_SINCE, "date" as const],
		]),
	],
	[OTHER_TABLE, new Map([[OTHER_COL, "text" as const]])],
]);

function makeCtx(
	db: PredicateCompileContext["db"],
	overrides: Partial<PredicateCompileContext> = {},
): PredicateCompileContext {
	return {
		db,
		appId: APP_ID,
		projectId: PROJECT_ID,
		anchorAlias: "c",
		currentCaseType: "patient",
		caseTypeSchemas: CASE_SCHEMAS,
		lookupTableSchemas: LOOKUP_SCHEMAS,
		bindings: {},
		...overrides,
	};
}

/**
 * Seed one definition + rows fixture. Row cells deliberately cover the
 * semantic corners: absent keys, stored empty text, JSON-number cells.
 */
async function seedRegions(db: PredicateCompileContext["db"]): Promise<void> {
	for (const projectId of [PROJECT_ID, FOREIGN_PROJECT_ID]) {
		await sql`
			INSERT INTO lookup_tables
				(project_id, id, name, tag, definition_revision, rows_revision,
				 column_count, created_by, updated_by)
			VALUES (${projectId}, ${REGIONS}, 'Regions', 'regions', 1, 1, 4,
				'tester', 'tester')
		`.execute(db);
	}
	await sql`
		INSERT INTO lookup_tables
			(project_id, id, name, tag, definition_revision, rows_revision,
			 column_count, created_by, updated_by)
		VALUES (${PROJECT_ID}, ${OTHER_TABLE}, 'Other', 'other', 1, 1, 1,
			'tester', 'tester')
	`.execute(db);
	const columns: ReadonlyArray<readonly [LookupColumnId, string, string]> = [
		[COL_CODE, "code", "text"],
		[COL_LABEL, "label", "text"],
		[COL_RANK, "rank", "int"],
		[COL_SINCE, "since", "date"],
	];
	for (const [id, wireName, dataType] of columns) {
		await sql`
			INSERT INTO lookup_columns
				(project_id, table_id, id, wire_name, label, data_type, order_key)
			VALUES (${PROJECT_ID}, ${REGIONS}, ${id}, ${wireName}, ${wireName},
				${dataType}, ${`a${columns.findIndex(([cid]) => cid === id) + 1}`})
		`.execute(db);
	}

	// Authored order: east (a1) < west (a2) < north (b1). `north` has an
	// ABSENT label cell; `west` stores an EMPTY-STRING label.
	const rows: ReadonlyArray<{
		id: string;
		orderKey: string;
		values: Record<string, string | number>;
	}> = [
		{
			id: "01920000-0000-7000-8000-0000000000e1",
			orderKey: "a1",
			values: {
				[COL_CODE]: "east",
				[COL_LABEL]: "East",
				[COL_RANK]: 10,
				[COL_SINCE]: "2024-01-15",
			},
		},
		{
			id: "01920000-0000-7000-8000-0000000000e2",
			orderKey: "a2",
			values: {
				[COL_CODE]: "west",
				[COL_LABEL]: "",
				[COL_RANK]: 20,
				[COL_SINCE]: "2025-06-01",
			},
		},
		{
			id: "01920000-0000-7000-8000-0000000000e3",
			orderKey: "b1",
			values: { [COL_CODE]: "north", [COL_RANK]: 20 },
		},
	];
	for (const row of rows.toReversed()) {
		await sql`
			INSERT INTO lookup_rows
				(project_id, table_id, id, order_key, values, created_by, updated_by)
			VALUES (${PROJECT_ID}, ${REGIONS}, ${row.id}, ${row.orderKey},
				${JSON.stringify(row.values)}::jsonb, 'tester', 'tester')
		`.execute(db);
	}
	// The foreign Project carries a row that would win every match if
	// tenancy leaked: order_key sorts FIRST and its label distinguishes it from our row.
	await sql`
		INSERT INTO lookup_rows
			(project_id, table_id, id, order_key, values, created_by, updated_by)
		VALUES (${FOREIGN_PROJECT_ID}, ${REGIONS},
			'01920000-0000-7000-8000-0000000000e9', 'a01',
			${JSON.stringify({ [COL_CODE]: "east", [COL_LABEL]: "Foreign East" })}::jsonb,
			'tester', 'tester'),
			(${PROJECT_ID}, ${OTHER_TABLE},
			'01920000-0000-7000-8000-0000000000e8', 'a01',
			${JSON.stringify({ [COL_CODE]: "east", [COL_LABEL]: "Other table East" })}::jsonb,
			'tester', 'tester')
	`.execute(db);
}

/** SELECT the compiled scalar (no anchor row needed). */
async function selectScalar(
	db: PredicateCompileContext["db"],
	expr: ReturnType<typeof compileExpression>,
): Promise<unknown> {
	const row = await db.selectNoFrom(expr.as("out")).executeTakeFirstOrThrow();
	return row.out;
}

describe("compileLookup — round-trip — first-match selection", () => {
	test("resolves the first matching row in authored (order_key, id) order", async ({
		db,
	}) => {
		await seedRegions(db);
		// rank = 20 matches BOTH west (a2) and north (b1); west wins on
		// order_key. The result column is `code`, proving the match and
		// the extraction address different columns.
		const expr = compileExpression(
			tableLookup(
				REGIONS,
				COL_CODE,
				eq(tableColumn(REGIONS, COL_RANK), literal(20)),
			),
			expressionContextFor(makeCtx(db)),
		);
		expect(await selectScalar(db, expr)).toBe("west");
		await db
			.updateTable("lookup_rows")
			.set({ order_key: "a2" })
			.where("project_id", "=", PROJECT_ID)
			.where("table_id", "=", REGIONS)
			.where(
				"id",
				"=",
				lookupRowIdSchema.parse("01920000-0000-7000-8000-0000000000e3"),
			)
			.execute();
		// The tied row was inserted first; the lower id still wins.
		expect(await selectScalar(db, expr)).toBe("west");
	});

	test("the where filters BEFORE the positional first-match", async ({
		db,
	}) => {
		await seedRegions(db);
		// Only the LAST authored row matches; the first-match must be the
		// first row of the FILTERED set, not require the first table row
		// to match.
		const expr = compileExpression(
			tableLookup(
				REGIONS,
				COL_CODE,
				eq(tableColumn(REGIONS, COL_CODE), literal("north")),
			),
			expressionContextFor(makeCtx(db)),
		);
		expect(await selectScalar(db, expr)).toBe("north");
	});

	test("no matching row resolves to SQL NULL, never empty text", async ({
		db,
	}) => {
		await seedRegions(db);
		const expr = compileExpression(
			tableLookup(
				REGIONS,
				COL_LABEL,
				eq(tableColumn(REGIONS, COL_CODE), literal("nowhere")),
			),
			expressionContextFor(makeCtx(db)),
		);
		expect(await selectScalar(db, expr)).toBeNull();
	});

	test("a matched row's absent cell reads NULL; stored empty text reads ''", async ({
		db,
	}) => {
		await seedRegions(db);
		const absent = compileExpression(
			tableLookup(
				REGIONS,
				COL_LABEL,
				eq(tableColumn(REGIONS, COL_CODE), literal("north")),
			),
			expressionContextFor(makeCtx(db)),
		);
		expect(await selectScalar(db, absent)).toBeNull();
		const storedEmpty = compileExpression(
			tableLookup(
				REGIONS,
				COL_LABEL,
				eq(tableColumn(REGIONS, COL_CODE), literal("west")),
			),
			expressionContextFor(makeCtx(db)),
		);
		expect(await selectScalar(db, storedEmpty)).toBe("");
	});

	test("int and date cells extract under their declared casts", async ({
		db,
	}) => {
		await seedRegions(db);
		const rank = compileExpression(
			tableLookup(
				REGIONS,
				COL_RANK,
				eq(tableColumn(REGIONS, COL_CODE), literal("east")),
			),
			expressionContextFor(makeCtx(db)),
		);
		const rankRows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<boolean>`${rank} + 5 = 15`.as("matches"))
			.execute();
		expect(rankRows).toEqual([{ matches: true }]);

		const since = compileExpression(
			tableLookup(
				REGIONS,
				COL_SINCE,
				eq(tableColumn(REGIONS, COL_CODE), literal("east")),
			),
			expressionContextFor(makeCtx(db)),
		);
		const sinceRows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<boolean>`${since} < date '2024-02-01'`.as("matches"))
			.execute();
		expect(sinceRows).toEqual([{ matches: true }]);
	});

	test("foreign Project and other-table rows cannot win the lookup", async ({
		db,
	}) => {
		await seedRegions(db);
		// The foreign 'east' row sorts first and carries label 'Foreign
		// East'; the bound Project must resolve its OWN 'east' row.
		const expr = compileExpression(
			tableLookup(
				REGIONS,
				COL_LABEL,
				eq(tableColumn(REGIONS, COL_CODE), literal("east")),
			),
			expressionContextFor(makeCtx(db)),
		);
		expect(await selectScalar(db, expr)).toBe("East");
	});
});

describe("compileLookup — round-trip — case-list predicate integration", () => {
	test("a filter comparing a correlated lookup result to a literal selects the right cases", async ({
		db,
	}) => {
		await seedRegions(db);
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: "40000000-0000-0000-0000-000000000001",
					case_type: "patient",
					app_id: APP_ID,
					project_id: PROJECT_ID,
					properties: JSON.stringify({ region_code: "east" }),
				}),
				makeCaseRow({
					case_id: "40000000-0000-0000-0000-000000000002",
					case_type: "patient",
					app_id: APP_ID,
					project_id: PROJECT_ID,
					properties: JSON.stringify({ region_code: "north" }),
				}),
			])
			.execute();
		// label-of(region_code) = 'East' — the lookup's where reads the
		// ANCHOR case row (correlation) beside the fixture row's column.
		const pred = eq(
			tableLookup(
				REGIONS,
				COL_LABEL,
				eq(tableColumn(REGIONS, COL_CODE), prop("patient", "region_code")),
			),
			literal("East"),
		);
		const rows = await db
			.selectFrom("cases as c")
			.where(compilePredicate(pred, makeCtx(db)))
			.where("c.app_id", "=", APP_ID)
			.where("c.project_id", "=", PROJECT_ID)
			.select("c.case_id")
			.execute();
		expect(rows).toEqual([{ case_id: "40000000-0000-0000-0000-000000000001" }]);
	});

	test("is-blank over a lookup result covers both no-match and the absent cell", async ({
		db,
	}) => {
		await seedRegions(db);
		const noMatch = compilePredicate(
			isBlank(
				tableLookup(
					REGIONS,
					COL_LABEL,
					eq(tableColumn(REGIONS, COL_CODE), literal("nowhere")),
				),
			),
			makeCtx(db),
		);
		const absentCell = compilePredicate(
			isBlank(
				tableLookup(
					REGIONS,
					COL_LABEL,
					eq(tableColumn(REGIONS, COL_CODE), literal("north")),
				),
			),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<boolean>`${noMatch}`.as("no_match"))
			.select(sql<boolean>`${absentCell}`.as("absent_cell"))
			.execute();
		expect(rows).toEqual([{ no_match: true, absent_cell: true }]);
	});

	test("a compound where (same-table column AND anchor read) stays row-relative", async ({
		db,
	}) => {
		await seedRegions(db);
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: "40000000-0000-0000-0000-000000000003",
					case_type: "patient",
					app_id: APP_ID,
					project_id: PROJECT_ID,
					properties: JSON.stringify({ region_code: "north" }),
				}),
				makeCaseRow({
					case_id: "40000000-0000-0000-0000-000000000004",
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "patient",
					properties: JSON.stringify({ region_code: "east" }),
				}),
			])
			.execute();
		// rank = 20 alone would match west AND north; ANDing the anchor
		// read pins the row to the case's own region.
		const expr = compileExpression(
			tableLookup(
				REGIONS,
				COL_CODE,
				and(
					eq(tableColumn(REGIONS, COL_RANK), literal(20)),
					eq(tableColumn(REGIONS, COL_CODE), prop("patient", "region_code")),
				),
			),
			expressionContextFor(makeCtx(db)),
		);
		const rows = await db
			.selectFrom("cases as c")
			.where("c.app_id", "=", APP_ID)
			.orderBy("c.case_id")
			.select(expr.as("out"))
			.execute();
		expect(rows).toEqual([{ out: "north" }, { out: null }]);
	});
});
