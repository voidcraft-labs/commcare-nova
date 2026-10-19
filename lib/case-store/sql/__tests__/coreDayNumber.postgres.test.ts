// `date(n)` of a number, compiled by reading, against Core's own answers.
// The device rows' expected days come from the Core date parity fixture,
// which `CoreDateParityRuntimeTest` holds to Core in each zone, so no
// TypeScript reimplementation of Core decides them here.
import { sql } from "kysely";
import { dateCoerce, literal, term } from "@/lib/domain/expression/builders";
import {
	CORE_DATE_PARITY,
	CORE_DATE_PARITY_ZONES,
	type CoreDateParityZone,
} from "@/lib/preview/xpath/__tests__/fixtures/coreDateParity";
import {
	compileExpression,
	type ExpressionCompileContext,
} from "../compileExpression";
import { compilePredicate } from "../compilePredicate";
import { expect, test } from "./setup";

/** The fixture rows this test reads, with the number each one converts. */
const DAY_ROWS = [
	{ id: "core-day-20453", days: 20453 },
	{ id: "core-day-20453.7", days: 20453.7 },
] as const;

/** Two zones apart from every viewer zone below, so the session never
 *  decides a day. */
const SESSION_ZONE_FOR: Readonly<Record<CoreDateParityZone, string>> = {
	utc: "Asia/Kolkata",
	"new-york": "Pacific/Kiritimati",
	kolkata: "America/New_York",
	kiritimati: "UTC",
};

function context(
	db: ExpressionCompileContext["db"],
	reading: ExpressionCompileContext["reading"],
	viewerTimeZone: string,
): ExpressionCompileContext {
	return {
		reading,
		db,
		appId: "app-expression-compiler",
		projectId: "owner-expression-compiler",
		anchorAlias: "c",
		caseTypeSchemas: new Map(),
		bindings: { viewerTimeZone },
		compilePredicate: (predicate, ctx) => compilePredicate(predicate, ctx),
	};
}

async function dayOf(
	db: ExpressionCompileContext["db"],
	days: number,
	ctx: ExpressionCompileContext,
): Promise<string> {
	const compiled = compileExpression(dateCoerce(term(literal(days))), ctx);
	const row = await db
		.selectFrom(sql`(values (1))`.as("v"))
		.select([
			sql<string>`${compiled}::text`.as("day"),
			sql<string>`pg_typeof(${compiled})::text`.as("type"),
		])
		.executeTakeFirstOrThrow();
	expect(row.type).toBe("date");
	return row.day;
}

test("a device's day number is Core's: fixed days from its local 1970 midnight, truncated toward zero", async ({
	db,
	pgClient,
}) => {
	for (const { id, days } of DAY_ROWS) {
		const row = CORE_DATE_PARITY.rows.find((candidate) => candidate.id === id);
		if (row === undefined)
			throw new Error(`The Core date parity fixture has no row '${id}'.`);
		for (const zone of Object.keys(
			CORE_DATE_PARITY_ZONES,
		) as CoreDateParityZone[]) {
			await pgClient.query(`SET LOCAL TIME ZONE '${SESSION_ZONE_FOR[zone]}'`);
			for (const reading of ["casedb", "results"] as const)
				expect(
					await dayOf(
						db,
						days,
						context(db, reading, CORE_DATE_PARITY_ZONES[zone]),
					),
					`${id} ${zone} ${reading}`,
				).toBe(row.expect[zone]);
		}
	}
});

test("HQ's search counts calendar days from 1970-01-01, which no zone moves", async ({
	db,
	pgClient,
}) => {
	// `corehq/apps/case_search/xpath_functions/value_functions.py::value_to_date`.
	// In Kiritimati the device and HQ disagree by a day; each reading shows
	// its own runtime's answer.
	for (const zone of Object.values(CORE_DATE_PARITY_ZONES)) {
		await pgClient.query(`SET LOCAL TIME ZONE '${zone}'`);
		for (const { days } of DAY_ROWS)
			expect(
				await dayOf(db, days, context(db, "search", zone)),
				`${zone} ${days}`,
			).toBe("2025-12-31");
	}
});
