import { sql } from "kysely";
import { testUuid } from "@/__tests__/helpers/uuid";
import { type CaseType, calculatedColumn } from "@/lib/domain";
import {
	ancestorPath,
	arith,
	between,
	coalesce,
	count,
	dateAdd,
	datetimeLiteral,
	eq,
	formatDate,
	gt,
	ifExpr,
	isIn,
	literal,
	prop,
	relationStep,
	selfPath,
	switchCase,
	switchExpr,
	term,
} from "@/lib/domain/predicate/builders";
import { proseText } from "@/lib/domain/prose";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { expect, makeCaseRow, test } from "../../sql/__tests__/setup";
import {
	compileExpression,
	type ExpressionCompileContext,
} from "../../sql/compileExpression";
import { compilePredicate } from "../../sql/compilePredicate";
import { PostgresCaseStore } from "../store";

const APP = "app-expression-compiler";
const PROJECT = "owner-expression-compiler";
const CHILD = "30000000-0000-0000-0000-000000000001";
const PARENT = "30000000-0000-0000-0000-000000000002";
const SECOND = "30000000-0000-0000-0000-000000000003";
const INSTANT = new Date("2026-09-30T06:57:00.123Z");
const SCHEMAS = new Map<string, CaseType>([
	[
		"visit",
		{
			name: "visit",
			parent_type: "household",
			properties: [
				{ name: "attempt_at", label: proseText("When"), data_type: "datetime" },
			],
		},
	],
	["household", { name: "household", properties: [] }],
]);

function context(
	db: ExpressionCompileContext["db"],
	zone: string,
): ExpressionCompileContext {
	return {
		db,
		appId: APP,
		projectId: PROJECT,
		anchorAlias: "c",
		currentCaseType: "visit",
		caseTypeSchemas: SCHEMAS,
		bindings: { viewerTimeZone: zone },
		portableCaseDates: true,
		compilePredicate: (predicate, ctx) => compilePredicate(predicate, ctx),
	};
}

async function seed(db: ExpressionCompileContext["db"]) {
	await db
		.insertInto("cases")
		.values([
			makeCaseRow({
				case_id: CHILD,
				case_type: "visit",
				case_name: "A",
				app_id: APP,
				project_id: PROJECT,
				opened_on: INSTANT,
				modified_on: INSTANT,
				properties: JSON.stringify({
					attempt_at: "2026-09-29T23:57:00.123-07:00",
				}),
			}),
			makeCaseRow({
				case_id: SECOND,
				case_type: "visit",
				case_name: "B",
				app_id: APP,
				project_id: PROJECT,
				opened_on: new Date("2026-09-30T06:30:00.123Z"),
				modified_on: INSTANT,
			}),
			makeCaseRow({
				case_id: PARENT,
				case_type: "household",
				app_id: APP,
				project_id: PROJECT,
				opened_on: INSTANT,
				modified_on: INSTANT,
			}),
		])
		.execute();
	await db
		.insertInto("case_indices")
		.values(
			[CHILD, SECOND].map((case_id) => ({
				case_id,
				ancestor_id: PARENT,
				target_case_type: "household",
				identifier: "parent",
				relationship: "child" as const,
				depth: 1,
			})),
		)
		.execute();
}

test("portable calculations read calendar metadata through self, parent and nested predicates while custom datetimes and stored reads keep their clock", async ({
	db,
	pgClient,
}) => {
	await seed(db);
	// SQL session timezone must never decide the worker's calendar date.
	await pgClient.query("SET LOCAL TIME ZONE 'Asia/Kolkata'");
	for (const [zone, day, rawClock] of [
		["America/Los_Angeles", "2026-09-29", "2026-09-29 23:57"],
		["UTC", "2026-09-30", "2026-09-30 06:57"],
	]) {
		const ctx = context(db, zone);
		const opened = term(prop("visit", "date_opened"));
		const parent = term(
			prop(
				"visit",
				"last_modified",
				ancestorPath(relationStep("parent", "household")),
			),
		);
		const inCalendarDay = eq(
			formatDate(opened, "%Y-%m-%d %H:%M"),
			term(literal(`${day} 00:00`)),
		);
		const columns = {
			opened: formatDate(opened, "%Y-%m-%d %H:%M"),
			parent: formatDate(parent, "%Y-%m-%d %H:%M"),
			branch: ifExpr(
				inCalendarDay,
				formatDate(parent, "%Y-%m-%d"),
				term(literal("wrong day")),
			),
			count: arith("+", count(selfPath(), inCalendarDay), term(literal(1))),
			tomorrow: formatDate(
				dateAdd(opened, "days", term(literal(1))),
				"%Y-%m-%d %H:%M",
			),
			custom: formatDate(term(prop("visit", "attempt_at")), "%Y-%m-%d %H:%M"),
		};
		const row = await db
			.selectFrom("cases as c")
			.where("c.case_id", "=", CHILD)
			.select([
				...Object.entries(columns).map(([name, expression]) =>
					compileExpression(expression, ctx).as(name),
				),
				compileExpression(formatDate(opened, "%Y-%m-%d %H:%M"), {
					...ctx,
					portableCaseDates: undefined,
				}).as("stored"),
				sql<string>`pg_typeof(${compileExpression(opened, ctx)})::text`.as(
					"type",
				),
			])
			.executeTakeFirstOrThrow();
		expect(row.opened).toBe(`${day} 00:00`);
		expect(row.parent).toBe(`${day} 00:00`);
		expect(row.branch).toBe(day);
		expect(Number(row.count)).toBe(2);
		expect(row.tomorrow).toBe(
			`${zone === "UTC" ? "2026-10-01" : "2026-09-30"} 00:00`,
		);
		expect(row.custom).toBe(rawClock);
		expect(row.stored).toBe(rawClock);
		expect(row.type).toBe("date");
	}
});

test("case-store calculations and calculated ordering share portable reads in ordinary and grouped Results without changing filters or stored rows", async ({
	db,
}) => {
	await seed(db);
	const store = new PostgresCaseStore({
		db,
		projectId: PROJECT,
		actorUserId: "actor",
		ownerId: "owner",
		sampleGenerator: new HeuristicCaseGenerator(),
	});
	const opened = term(prop("visit", "date_opened"));
	const expression = formatDate(opened, "%H:%M");
	const column = calculatedColumn(
		testUuid("portable-column"),
		"When",
		expression,
	);
	const args = {
		appId: APP,
		caseType: "visit",
		caseTypeSchemas: SCHEMAS,
		bindings: { viewerTimeZone: "America/Los_Angeles" },
		calculated: [column],
		sort: [
			{
				expression,
				direction: "asc" as const,
				portableCaseDates: true as const,
			},
			{
				expression: term(prop("visit", "case_name")),
				direction: "asc" as const,
			},
		],
	};
	const rows = await store.query(args);
	expect(rows.map((row) => row.case_id)).toEqual([CHILD, SECOND]);
	expect(rows.map((row) => row.calculated[column.uuid])).toEqual([
		"00:00",
		"00:00",
	]);
	expect(rows[0].opened_on).toEqual(INSTANT);
	const grouped = await store.queryGrouped({
		...args,
		indexIdentifier: "parent",
		groupOffset: 0,
		groupLimit: 10,
	});
	expect(
		grouped.groups.flatMap((group) => group.rows).map((row) => row.case_id),
	).toEqual([CHILD, SECOND]);
	expect(
		grouped.groups
			.flatMap((group) => group.rows)
			.map((row) => row.calculated[column.uuid]),
	).toEqual(["00:00", "00:00"]);
	const filtered = await store.query({
		...args,
		predicate: gt(opened, term(datetimeLiteral("2026-09-30T06:45:00Z"))),
	});
	expect(filtered.map((row) => row.case_id)).toEqual([CHILD]);
	const storedSort = await store.query({
		...args,
		sort: [{ expression: opened, direction: "asc" }],
	});
	expect(storedSort.map((row) => row.case_id)).toEqual([SECOND, CHILD]);
});

test("mixed temporal branches promote metadata at viewer midnight rather than the database timezone", async ({
	db,
	pgClient,
}) => {
	await seed(db);
	await pgClient.query("SET LOCAL TIME ZONE 'Asia/Kolkata'");
	const ctx = context(db, "America/Los_Angeles");
	const opened = term(prop("visit", "date_opened"));
	const custom = term(prop("visit", "attempt_at"));
	const yes = eq(term(literal(1)), term(literal(1)));
	for (const [expression, clock, instant] of [
		[ifExpr(yes, opened, custom), "00:00", "2026-09-29T07:00:00.000Z"],
		[coalesce(opened, custom), "00:00", "2026-09-29T07:00:00.000Z"],
		[
			switchExpr(term(literal(1)), [switchCase(literal(1), opened)], custom),
			"00:00",
			"2026-09-29T07:00:00.000Z",
		],
		[ifExpr(yes, custom, opened), "23:57", "2026-09-30T06:57:00.123Z"],
	] as const) {
		const row = await db
			.selectFrom("cases as c")
			.where("c.case_id", "=", CHILD)
			.select([
				compileExpression(expression, ctx).as("value"),
				compileExpression(formatDate(expression, "%Y-%m-%d %H:%M"), ctx).as(
					"formatted",
				),
				compileExpression(
					formatDate(
						dateAdd(expression, "days", term(literal(1))),
						"%Y-%m-%d %H:%M",
					),
					ctx,
				).as("tomorrow"),
			])
			.executeTakeFirstOrThrow();
		expect(row.value).toEqual(new Date(instant));
		expect(row.formatted).toBe(`2026-09-29 ${clock}`);
		expect(row.tomorrow).toBe(`2026-09-30 ${clock}`);
	}
});

test("portable typed SQL comparisons use viewer midnight in direct and nested predicates independently of the database timezone", async ({
	db,
}) => {
	await seed(db);
	await db
		.updateTable("cases")
		.set({
			properties: JSON.stringify({ attempt_at: "2026-09-29T00:00:00-07:00" }),
		})
		.where("case_id", "=", CHILD)
		.execute();
	const ctx = context(db, "America/Los_Angeles");
	const opened = term(prop("visit", "date_opened"));
	const custom = term(prop("visit", "attempt_at"));
	const midnight = datetimeLiteral("2026-09-29T07:00:00Z");
	for (const zone of ["UTC", "Asia/Kolkata"]) {
		await sql`select set_config('TimeZone', ${zone}, true)`.execute(db);
		const row = await db
			.selectFrom("cases as c")
			.where("c.case_id", "=", CHILD)
			.select([
				sql<boolean>`${compilePredicate(eq(opened, custom), ctx)}`.as(
					"customEquality",
				),
				sql<boolean>`${compilePredicate(eq(opened, term(midnight)), ctx)}`.as(
					"literalEquality",
				),
				sql<boolean>`${compilePredicate(isIn(opened, midnight), ctx)}`.as(
					"membership",
				),
				sql<boolean>`${compilePredicate(
					between(opened, { lower: midnight, upper: midnight }),
					ctx,
				)}`.as("range"),
				compileExpression(count(selfPath(), eq(opened, custom)), ctx).as(
					"selfCount",
				),
				compileExpression(
					switchExpr(
						opened,
						[switchCase(midnight, term(literal("midnight")))],
						term(literal("other")),
					),
					ctx,
				).as("selected"),
				sql<boolean>`${compilePredicate(
					eq(opened, term(datetimeLiteral(INSTANT.toISOString()))),
					{ ...ctx, portableCaseDates: undefined },
				)}`.as("storedEquality"),
			])
			.executeTakeFirstOrThrow();
		expect(row).toEqual({
			customEquality: true,
			literalEquality: true,
			membership: true,
			range: true,
			selfCount: 1,
			selected: "midnight",
			storedEquality: true,
		});
	}
	// This pins Nova's typed SQL semantics. Native raw DateData-vs-string
	// generalized equality has a separate, retained upstream boundary.
});
