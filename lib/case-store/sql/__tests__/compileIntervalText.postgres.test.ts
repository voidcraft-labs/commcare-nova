// The interval column's sort key (`compileIntervalText`) is the text the
// column shows: compared, row by row, with the text Preview's cell shows
// for the same stored value (`lib/preview/columnDisplay.ts::formatIntervalForPreview`),
// for both displays, over values the query must never fail on. Both sides
// read the same instant: the statement's `now()` is handed to Preview's
// formatter, in the viewer's zone, which is this process's zone.

import { sql } from "kysely";
import { describe } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseRowWithCalculated } from "@/lib/case-store";
import {
	type CaseType,
	type Column,
	intervalColumn,
	plainColumn,
	TIME_SINCE_UNIT_DAYS,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import {
	formatIntervalForPreview,
	projectColumnDisplay,
} from "@/lib/preview/columnDisplay";
import {
	compileDeviceTextExpression,
	type ExpressionCompileContext,
} from "../compileExpression";
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
	// Offsets whose instant falls on another day than the one written, in
	// every zone but the offset's own: the device keeps the written day.
	`${localDay(3)}T00:30:00+14:00`,
	`${localDay(3)}T23:30:00-12:00`,
	`${localDay(3)}T23:59:59.250Z`,
	`${localDay(3)}T00:00:00Z`,
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
			// A browse list's interval column reads the casedb row.
			reading: "casedb",
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

	test("reads a results row's last modified as the text HQ's results carry, for its order and both displays", async ({
		db,
	}) => {
		// The session's zone spells a stored instant's own text; HQ's results
		// text is UTC whatever it is.
		await sql`SET LOCAL TimeZone = 'America/New_York'`.execute(db);
		const DAY = 24 * 60 * 60 * 1000;
		const started = Date.now();
		// The first and last moment of a local day: whatever the hour and in
		// every zone but UTC, one of them is on another day in HQ's UTC text,
		// whose written day the device keeps.
		const edgeOfDay = (hours: number, minutes: number, seconds: number) => {
			const date = new Date(started);
			date.setDate(date.getDate() - 5);
			date.setHours(hours, minutes, seconds, 3);
			return date;
		};
		// Milliseconds only, the precision Preview's row holds. Each count is
		// at least a day clear of the flag's threshold either way, so the
		// written day and an hour of daylight saving leave its verdict.
		const modified = [
			...[6, 0.25, 40, 0.75, 0].map(
				(daysAgo, index) => new Date(started - daysAgo * DAY - index * 7),
			),
			edgeOfDay(0, 0, 0),
			edgeOfDay(23, 59, 59),
		];
		const caseIds = modified.map((_, index) =>
			testUuid(`results-modified-${index}`),
		);
		await db
			.insertInto("cases")
			.values(
				modified.map((instant, index) =>
					makeCaseRow({
						case_id: caseIds[index],
						case_type: "visit",
						app_id: APP_ID,
						project_id: PROJECT_ID,
						modified_on: instant,
					}),
				),
			)
			.execute();
		const ctx: ExpressionCompileContext = {
			// An effective Search's results list reads HQ's results instance.
			reading: "results",
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
		const columns = [
			intervalColumn(
				testUuid("modified-days"),
				"last_modified",
				"Days",
				30,
				"days",
				"always",
				"Stale",
			),
			intervalColumn(
				testUuid("modified-flag"),
				"last_modified",
				"Flag",
				2,
				"days",
				"flag",
				"Quiet",
			),
		];
		const shown = compileDeviceTextExpression(
			term(prop("visit", "last_modified")),
			ctx,
		);
		const rows = await db
			.selectFrom("cases as c")
			.selectAll("c")
			.where("c.app_id", "=", APP_ID)
			.where("c.project_id", "=", PROJECT_ID)
			.where("c.case_type", "=", "visit")
			.select([
				sql<Date>`now()`.as("now"),
				shown.as("shown"),
				...columns.map((column, index) =>
					compileIntervalText(
						{
							caseType: "visit",
							property: "last_modified",
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
			.orderBy(sql`(${shown})::text`)
			.execute();
		expect(rows.map((row) => row.case_id)).toEqual(
			caseIds
				.map((caseId, index) => ({ caseId, at: modified[index].getTime() }))
				.sort((a, b) => a.at - b.at)
				.map((entry) => entry.caseId),
		);
		const plain = plainColumn(
			testUuid("modified-plain"),
			"last_modified",
			"Modified",
		);
		for (const row of rows) {
			const record = row as unknown as Record<string, unknown>;
			const display = {
				caseProperties: [],
				calculatedTemporalTypes: new Map(),
				today: new Date(row.now),
				reading: "results" as const,
				projectProse: () => "",
			};
			const previewRow = {
				...row,
				calculated: {},
			} as unknown as CaseRowWithCalculated;
			expect(record.shown).toBe(
				projectColumnDisplay(plain, previewRow, display).text,
			);
			columns.forEach((column, index) => {
				expect(record[`text_${index}`], column.header).toBe(
					projectColumnDisplay(column, previewRow, display).text,
				);
			});
		}
		expect(
			rows.map((row) => (row as unknown as Record<string, unknown>).text_1),
		).toEqual(["Quiet", "Quiet", "Quiet", "Quiet", "", "", ""]);
	});
});
