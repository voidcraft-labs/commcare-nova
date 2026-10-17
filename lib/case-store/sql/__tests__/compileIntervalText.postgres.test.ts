// The interval column's sort key (`compileIntervalText`) is the text the
// column shows: compared, row by row, with the text Preview's cell shows
// for the same stored value (`lib/preview/columnDisplay.ts::formatIntervalForPreview`),
// for both displays, over values the query must never fail on. Both sides
// read the same instant: the statement's `now()` is handed to Preview's
// formatter, in the viewer's zone, which is this process's zone.

import { sql } from "kysely";
import { describe } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type CaseType,
	type Column,
	intervalColumn,
	TIME_SINCE_UNIT_DAYS,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { formatIntervalForPreview } from "@/lib/preview/columnDisplay";
import type { ExpressionCompileContext } from "../compileExpression";
import { compileIntervalText } from "../compileIntervalText";
import { compilePredicate } from "../compilePredicate";
import { expect, makeCaseRow, test } from "./setup";

const APP_ID = "app-expression-compiler";
const PROJECT_ID = "owner-expression-compiler";
const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const VISIT: CaseType = {
	name: "visit",
	properties: [{ name: "seen", label: proseText("Seen"), data_type: "date" }],
};

type IntervalColumn = Extract<Column, { kind: "interval" }>;

const COLUMNS: readonly IntervalColumn[] = [
	intervalColumn(
		testUuid("interval-days"),
		"seen",
		"Days",
		30,
		"days",
		"always",
		"Overdue",
	),
	intervalColumn(
		testUuid("interval-weeks"),
		"seen",
		"Weeks",
		3,
		"weeks",
		"always",
		"Late",
	),
	intervalColumn(
		testUuid("interval-flag"),
		"seen",
		"Flag",
		2,
		"days",
		"flag",
		"Due",
	),
];

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** A local calendar day `daysAgo` before now, `YYYY-MM-DD`. */
function localDay(daysAgo: number): string {
	const date = new Date();
	date.setDate(date.getDate() - daysAgo);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A local wall time on the day `daysAgo` before now, written with this
 *  zone's own offset at that instant, so it is the instant the viewer saw. */
function localInstantWithOffset(
	daysAgo: number,
	hours: number,
	minutes: number,
): string {
	const date = new Date();
	date.setDate(date.getDate() - daysAgo);
	date.setHours(hours, minutes, 0, 0);
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const whole = Math.abs(offset);
	return `${localDay(daysAgo)}T${pad(hours)}:${pad(minutes)}:00${sign}${pad(Math.floor(whole / 60))}:${pad(whole % 60)}`;
}

/** Each stored value the key must read, `undefined` for a missing property. */
const VALUES: readonly (string | undefined)[] = [
	"",
	undefined,
	localDay(0),
	localDay(1),
	localDay(3),
	localDay(20),
	localDay(31),
	localDay(400),
	`${localDay(5)}T10:15:00`,
	localInstantWithOffset(1, 23, 30),
	localInstantWithOffset(0, 0, 30),
	"not a date",
	"2026-02-31",
	// Words Postgres reads as an instant and a device reads as text; an
	// infinite date must not reach the date arithmetic.
	"infinity",
	"-infinity",
	"epoch",
	"now",
	"today",
	"tomorrow",
	"yesterday",
	// A time after a space, which Postgres reads and a device does not.
	`${localDay(2)} 10:15:00`,
];

describe("compileIntervalText", () => {
	test("gives each value the text Preview shows, for both displays", async ({
		db,
	}) => {
		const caseIds: string[] = VALUES.map((_, index) =>
			testUuid(`interval-row-${index}`),
		);
		await db
			.insertInto("cases")
			.values(
				VALUES.map((value, index) =>
					makeCaseRow({
						case_id: caseIds[index],
						case_type: "visit",
						app_id: APP_ID,
						project_id: PROJECT_ID,
						properties: JSON.stringify(
							value === undefined ? {} : { seen: value },
						),
					}),
				),
			)
			.execute();
		const ctx: ExpressionCompileContext = {
			db,
			appId: APP_ID,
			projectId: PROJECT_ID,
			anchorAlias: "c",
			currentCaseType: "visit",
			caseTypeSchemas: new Map([["visit", VISIT]]),
			bindings: { viewerTimeZone: VIEWER_ZONE },
			compilePredicate: (predicate, context) =>
				compilePredicate(predicate, context),
		};
		const rows = await db
			.selectFrom("cases as c")
			.where("c.app_id", "=", APP_ID)
			.where("c.project_id", "=", PROJECT_ID)
			.where("c.case_type", "=", "visit")
			.select([
				"c.case_id",
				sql<Date>`now()`.as("now"),
				...COLUMNS.map((column, index) =>
					compileIntervalText(
						{
							caseType: "visit",
							property: "seen",
							display: column.display,
							thresholdDays:
								column.threshold * TIME_SINCE_UNIT_DAYS[column.unit],
							divisorDays: TIME_SINCE_UNIT_DAYS[column.unit],
							text: column.text,
						},
						ctx,
					).as(`text_${index}`),
				),
			])
			.execute();
		expect(rows).toHaveLength(VALUES.length);
		for (const row of rows) {
			const value = VALUES[caseIds.indexOf(row.case_id)];
			const now = new Date(row.now);
			const record = row as unknown as Record<string, unknown>;
			COLUMNS.forEach((column, index) => {
				expect(
					record[`text_${index}`],
					`${column.header} over ${JSON.stringify(value)}`,
				).toBe(formatIntervalForPreview(value ?? "", column, now).text);
			});
		}
	});
});
