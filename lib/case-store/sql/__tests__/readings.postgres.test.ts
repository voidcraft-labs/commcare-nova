// What a case row stands for decides how its system dates read. Each test
// sets the session `TimeZone` apart from the viewer's zone, so neither can
// decide a result the other should.
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
	gte,
	ifExpr,
	isIn,
	literal,
	prop,
	relationStep,
	selfPath,
	switchCase,
	switchExpr,
	term,
} from "@/lib/domain/expression/builders";
import {
	CASEDB_READING,
	type CaseReading,
	SEARCH_READING,
} from "@/lib/domain/expression/temporalType";
import { proseText } from "@/lib/domain/prose";
import { PostgresCaseStore } from "../../postgres/store";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import {
	compileExpression,
	type ExpressionCompileContext,
} from "../compileExpression";
import { compilePredicate } from "../compilePredicate";
import { expect, makeCaseRow, test } from "./setup";

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
	reading: CaseReading = "casedb",
): ExpressionCompileContext {
	return {
		reading,
		db,
		appId: APP,
		projectId: PROJECT,
		anchorAlias: "c",
		currentCaseType: "visit",
		caseTypeSchemas: SCHEMAS,
		bindings: { viewerTimeZone: zone },
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

test("each reading gives the system dates the class its runtime holds them in, and closed_on only to search", async ({
	db,
	pgClient,
}) => {
	const caseId = testUuid("reading-row");
	await db
		.insertInto("cases")
		.values(
			makeCaseRow({
				case_id: caseId,
				case_type: "visit",
				app_id: APP,
				project_id: PROJECT,
				opened_on: new Date("2026-01-02T03:00:00Z"),
				modified_on: new Date("2026-01-02T03:00:00Z"),
				closed_on: new Date("2026-01-03T10:00:00Z"),
			}),
		)
		.execute();
	await pgClient.query("SET LOCAL TIME ZONE 'Asia/Kolkata'");
	const opened = term(prop("visit", "date_opened"));
	const modified = term(prop("visit", "last_modified"));
	const read = async (reading: CaseReading) => {
		const ctx = context(db, "America/New_York", reading);
		const openedSql = compileExpression(opened, ctx);
		const modifiedSql = compileExpression(modified, ctx);
		return db
			.selectFrom("cases as c")
			.where("c.case_id", "=", caseId)
			.select([
				sql<string>`${openedSql}::text`.as("opened"),
				sql<string>`pg_typeof(${openedSql})::text`.as("openedType"),
				sql<string>`pg_typeof(${modifiedSql})::text`.as("modifiedType"),
			])
			.executeTakeFirstOrThrow();
	};
	// A device's casedb holds both as the worker's day: 22:00 on 1 January
	// in New York.
	expect(await read("casedb")).toEqual({
		opened: "2026-01-01",
		openedType: "date",
		modifiedType: "date",
	});
	// HQ's results instance writes `date_opened` as the UTC day and
	// `last_modified` as its instant text.
	expect(await read("results")).toEqual({
		opened: "2026-01-02",
		openedType: "date",
		modifiedType: "timestamp with time zone",
	});
	// HQ's search compares both as instants.
	expect((await read("search")).openedType).toBe("timestamp with time zone");
	expect((await read("search")).modifiedType).toBe("timestamp with time zone");

	// Against an instant, a casedb day is its midnight in the viewer's zone:
	// 1 January 00:00 in New York is 05:00 UTC.
	const viewerMidnight = term(datetimeLiteral("2026-01-01T05:00:00Z"));
	const verdicts = await db
		.selectFrom("cases as c")
		.where("c.case_id", "=", caseId)
		.select([
			sql<boolean>`${compilePredicate(
				gte(opened, viewerMidnight),
				context(db, "America/New_York"),
			)}`.as("atOrAfter"),
			sql<boolean>`${compilePredicate(
				gt(opened, viewerMidnight),
				context(db, "America/New_York"),
			)}`.as("after"),
			sql<boolean>`${compilePredicate(
				gt(opened, viewerMidnight),
				context(db, "America/New_York", "search"),
			)}`.as("instantAfter"),
		])
		.executeTakeFirstOrThrow();
	expect(verdicts).toEqual({
		atOrAfter: true,
		after: false,
		instantAfter: true,
	});

	const closed = term(prop("visit", "closed_on"));
	const closedRow = await db
		.selectFrom("cases as c")
		.where("c.case_id", "=", caseId)
		.select(
			compileExpression(closed, context(db, "America/New_York", "search")).as(
				"closed",
			),
		)
		.executeTakeFirstOrThrow();
	expect(closedRow.closed).toEqual(new Date("2026-01-03T10:00:00Z"));
	for (const reading of ["casedb", "results"] as const)
		expect(() =>
			compileExpression(closed, context(db, "America/New_York", reading)),
		).toThrow(/Internal bug: .*`closed_on` reached the `.*` reading/);
});

test("casedb calculations read calendar metadata through self, parent and nested predicates while custom datetimes and search reads keep their clock", async ({
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
				compileExpression(
					formatDate(opened, "%Y-%m-%d %H:%M"),
					context(db, zone, "search"),
				).as("stored"),
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

test("one store read gives its filter and its columns their own readings, in ordinary and grouped Results", async ({
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
	const modified = term(prop("visit", "last_modified"));
	const day = calculatedColumn(
		testUuid("reading-day-column"),
		"Opened",
		formatDate(opened, "%Y-%m-%d"),
	);
	const clock = calculatedColumn(
		testUuid("reading-clock-column"),
		"Modified",
		formatDate(modified, "%Y-%m-%d %H:%M"),
	);
	const byName = {
		kind: "expression" as const,
		expression: term(prop("visit", "case_name")),
		comparator: "text" as const,
		direction: "asc" as const,
		blanks: "first" as const,
	};
	const base = {
		appId: APP,
		caseType: "visit",
		caseTypeSchemas: SCHEMAS,
		bindings: { viewerTimeZone: "America/Los_Angeles" },
		calculated: [day, clock],
		// A plain `date_opened` key sorts by the columns' reading; under
		// casedb both cases opened on the worker's 29 September, so they
		// tie and the name decides (by their instants B opened first).
		sort: [
			{
				kind: "expression" as const,
				expression: opened,
				comparator: "text" as const,
				direction: "asc" as const,
				blanks: "first" as const,
			},
			byName,
		],
	};
	const browse = await store.query({ ...base, reading: CASEDB_READING });
	expect(browse.map((row) => row.case_id)).toEqual([CHILD, SECOND]);
	expect(browse.map((row) => row.calculated[day.uuid])).toEqual([
		"2026-09-29",
		"2026-09-29",
	]);
	expect(browse.map((row) => row.calculated[clock.uuid])).toEqual([
		"2026-09-29 00:00",
		"2026-09-29 00:00",
	]);
	// The stored row keeps its instant.
	expect(browse[0].opened_on).toEqual(INSTANT);

	// An effective Search's columns read the results row: the UTC day, and
	// `last_modified`'s instant shown in the viewer's zone.
	const results = await store.query({ ...base, reading: SEARCH_READING });
	expect(results.map((row) => row.calculated[day.uuid])).toEqual([
		"2026-09-30",
		"2026-09-30",
	]);
	expect(results.map((row) => row.calculated[clock.uuid])).toEqual([
		"2026-09-29 23:57",
		"2026-09-29 23:57",
	]);

	const grouped = await store.queryGrouped({
		...base,
		reading: CASEDB_READING,
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
			.map((row) => row.calculated[day.uuid]),
	).toEqual(["2026-09-29", "2026-09-29"]);

	// The same filter: a casedb day promotes to the viewer's midnight
	// (29 September 07:00 UTC), which is not after 30 September 06:45 UTC;
	// HQ's search compares the stored instants.
	const afterQuarterTo = gt(
		opened,
		term(datetimeLiteral("2026-09-30T06:45:00Z")),
	);
	const browseFiltered = await store.query({
		...base,
		reading: CASEDB_READING,
		predicate: afterQuarterTo,
	});
	expect(browseFiltered).toEqual([]);
	const searchFiltered = await store.query({
		...base,
		reading: SEARCH_READING,
		predicate: afterQuarterTo,
	});
	expect(searchFiltered.map((row) => row.case_id)).toEqual([CHILD]);
	expect(
		await store.count({
			appId: APP,
			caseType: "visit",
			caseTypeSchemas: SCHEMAS,
			bindings: base.bindings,
			reading: SEARCH_READING,
			predicate: afterQuarterTo,
		}),
	).toBe(1);
});

test("mixed temporal branches promote casedb metadata at viewer midnight rather than the database timezone", async ({
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

test("casedb comparisons use viewer midnight in direct and nested predicates independently of the database timezone", async ({
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
					context(db, "America/Los_Angeles", "search"),
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
