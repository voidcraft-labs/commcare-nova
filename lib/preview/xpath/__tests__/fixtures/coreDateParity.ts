/**
 * Core's date behaviour in four device zones, one table held on both sides:
 * `coreDateParity.test.ts` evaluates each row with Preview's evaluator under
 * each zone, and `proof/native/core/CoreDateParityRuntimeTest.java` evaluates
 * the same rows with CommCare Core in a test JVM started in each zone (the
 * producer `proof/native/producers/emit-expression-evidence.ts` writes this
 * table as `/expression/core-date-parity.json`). Every expected value is
 * Core's, read from Core's code at the pin: `DateUtils.java`
 * (`daysSinceEpoch`, `dateAdd`, `fractionalDaysSinceEpoch`, `roundDate`,
 * `parseDateTime`, `format`, `formatTimeISO8601`), `FunctionUtils.java`
 * (`toDate`, `expandDateSafe`, `toDouble`, `toNumeric`), the `XPath*Func`
 * date functions and `XpathCoalesceFunc`, with the JDK's wall-clock rule (a
 * repeated hour resolves to its later occurrence, a skipped one forward by the
 * gap).
 *
 * The clock is fixed at 01:15 EDT on 1 November 2026, inside New York's
 * repeated hour. Each value is a string; a result that is a number is
 * compared numerically within 1e-9, any other result as text.
 *
 * Node storage, by how the device holds the value:
 * - `datetime`: an answer entered through the widget, `DateTimeData` of the
 *   instant `value` names.
 * - `date`: a date answer, `DateData` of the local midnight of `value`.
 * - `text`: `StringData` of `value`; an empty `value` is a blank node.
 * - `setvalue-datetime`: text a setvalue writes into a datetime bind, held as
 *   Core's cast holds it (`DateTimeData.cast`, `DateUtils.parseDateTime`).
 */

export type CoreDateParityZone = "utc" | "new-york" | "kolkata" | "kiritimati";

/** Each zone label's IANA zone, as `proof/native/families.py::ZONES` names it. */
export const CORE_DATE_PARITY_ZONES: Readonly<
	Record<CoreDateParityZone, string>
> = {
	utc: "UTC",
	"new-york": "America/New_York",
	kolkata: "Asia/Kolkata",
	kiritimati: "Pacific/Kiritimati",
};

export interface CoreDateParityNode {
	readonly name: string;
	readonly held: "datetime" | "date" | "text" | "setvalue-datetime";
	readonly value: string;
}

export interface CoreDateParityRow {
	readonly id: string;
	readonly xpath: string;
	readonly nodes?: readonly CoreDateParityNode[];
	readonly expect: Readonly<Record<CoreDateParityZone, string>>;
}

export interface CoreDateParityTable {
	readonly schemaVersion: 1;
	readonly fixedClock: string;
	readonly rows: readonly CoreDateParityRow[];
}

const same = (value: string): Record<CoreDateParityZone, string> => ({
	utc: value,
	"new-york": value,
	kolkata: value,
	kiritimati: value,
});

/** A datetime answer away from every transition: 15:45Z on 10 March 2026 is
 * 11:45 EDT, 21:15 IST and 05:45 on 11 March in Kiritimati. */
const answer = {
	name: "dt",
	held: "datetime",
	value: "2026-03-10T15:45:00.000Z",
} as const;
/** A date answer on the first day of 2026, calendar day 20454. */
const day = { name: "day", held: "date", value: "2026-01-01" } as const;
/** Two widget answers in New York's repeated hour: 01:45 EDT and the later
 * 01:15 EST. */
const earlierAnswer = {
	name: "fa",
	held: "datetime",
	value: "2026-11-01T05:45:00.000Z",
} as const;
const laterAnswer = {
	name: "fb",
	held: "datetime",
	value: "2026-11-01T06:15:00.000Z",
} as const;
const blank = { name: "blank", held: "text", value: "" } as const;
const castOf = (value: string) =>
	[{ name: "cast", held: "setvalue-datetime", value }] as const;
const CAST_TEXT = "format-date(coalesce(/data/cast, ''), '%Y-%m-%dT%H:%M%Z')";

export const CORE_DATE_PARITY: CoreDateParityTable = {
	schemaVersion: 1,
	fixedClock: "2026-11-01T05:15:00.000Z",
	rows: [
		// Core's day number (`daysSinceEpoch`) and its inverse (`dateAdd` from
		// the local 1970 epoch): Kiritimati's offset grew by 24h40m since 1970, so
		// both shift by a day there and still round-trip.
		{
			id: "core-day-20453",
			xpath: "string(date(20453))",
			expect: { ...same("2025-12-31"), kiritimati: "2026-01-01" },
		},
		{
			id: "core-day-20453.7",
			xpath: "string(date(20453.7))",
			expect: { ...same("2025-12-31"), kiritimati: "2026-01-01" },
		},
		{
			id: "core-days-2026-01-01",
			xpath: "number(date('2026-01-01'))",
			expect: { ...same("20454"), kiritimati: "20453" },
		},
		{
			id: "core-day-round-trip",
			xpath: "string(date(number(date('2026-01-01'))))",
			expect: same("2026-01-01"),
		},
		{
			id: "core-days-text",
			xpath: "number('2026-01-01')",
			expect: { ...same("20454"), kiritimati: "20453" },
		},
		{
			id: "r10",
			xpath: "number(/data/day)",
			nodes: [day],
			expect: { ...same("20454"), kiritimati: "20453" },
		},
		{ id: "today", xpath: "string(today())", expect: same("2026-11-01") },
		{
			id: "today-plus-one",
			xpath: "string(today() + 1)",
			expect: { ...same("20759"), kiritimati: "20758" },
		},
		{
			id: "today-plus-one-date",
			xpath: "string(date(today() + 1))",
			expect: same("2026-11-02"),
		},
		// The wire's date-add lowering, as `toWire` prints it.
		{
			id: "date-add-days",
			xpath: "string(date(floor(date('2026-01-01') + 30)))",
			expect: same("2026-01-31"),
		},
		{
			id: "date-add-hours",
			xpath: "string(date(floor(date('2026-01-01') + 36 div 24)))",
			expect: same("2026-01-02"),
		},
		// A node holding a Date is rounded by `toDate` and `expandDateSafe`; a
		// direct Date (through `coalesce`, which unpacks) keeps its clock.
		{
			id: "o2a",
			xpath: "format-date(/data/dt, '%H')",
			nodes: [answer],
			expect: same("00"),
		},
		{
			id: "o2b",
			xpath: "format-date(date(/data/dt), '%H')",
			nodes: [answer],
			expect: same("00"),
		},
		{
			id: "o2c",
			xpath: "double(date(/data/dt))",
			nodes: [answer],
			expect: { ...same("20522"), kiritimati: "20523" },
		},
		{
			id: "o2d",
			xpath: "format-date(coalesce(/data/dt, ''), '%H')",
			nodes: [answer],
			expect: { utc: "15", "new-york": "11", kolkata: "21", kiritimati: "05" },
		},
		{
			id: "string-datetime-node",
			xpath: "string(/data/dt)",
			nodes: [answer],
			expect: { ...same("2026-03-10"), kiritimati: "2026-03-11" },
		},
		// `double` of a node goes through `toNumeric`: Kiritimati's local day is
		// 20523 and Core's day number for it 20522.
		{
			id: "r3",
			xpath: "double(/data/dt)",
			nodes: [answer],
			expect: same("20522"),
		},
		// `double` of a direct Date is `fractionalDaysSinceEpoch`, the wall clock.
		{
			id: "r4",
			xpath: "double(now())",
			expect: {
				utc: "20758.21875",
				"new-york": "20758.052083333332",
				kolkata: "20758.447916666668",
				kiritimati: "20758.802083333332",
			},
		},
		{
			id: "now-format",
			xpath: "format-date(now(), '%H:%M%Z')",
			expect: {
				utc: "05:15Z",
				"new-york": "01:15-04",
				kolkata: "10:45+05:30",
				kiritimati: "19:15+14",
			},
		},
		{
			id: "date-node-midnight",
			xpath: "format-date(/data/day, '%H%Z')",
			nodes: [day],
			expect: {
				utc: "00Z",
				"new-york": "00-05",
				kolkata: "00+05:30",
				kiritimati: "00+14",
			},
		},
		{
			id: "calendar-nepali-midnight",
			xpath: "format-date-for-calendar(/data/dtm, 'nepali', '%Y-%m-%d')",
			nodes: [
				{ name: "dtm", held: "datetime", value: "2017-07-15T23:30:00.000Z" },
			],
			expect: {
				utc: "2074-03-31",
				"new-york": "2074-03-31",
				kolkata: "2074-04-01",
				kiritimati: "2074-04-01",
			},
		},
		// A widget answer at 01:15 EST is held at its own instant, after the
		// 01:45 EDT answer, with the offset of its own side of the transition.
		{
			id: "d5",
			xpath: "format-date(coalesce(/data/fb, ''), '%H:%M%Z')",
			nodes: [laterAnswer],
			expect: {
				utc: "06:15Z",
				"new-york": "01:15-05",
				kolkata: "11:45+05:30",
				kiritimati: "20:15+14",
			},
		},
		{
			id: "d7",
			xpath:
				"string(double(coalesce(/data/fb, '')) > double(coalesce(/data/fa, '')))",
			nodes: [earlierAnswer, laterAnswer],
			expect: { ...same("true"), "new-york": "false" },
		},
		{
			id: "d8",
			xpath: "double(coalesce(/data/fb, '')) - double(coalesce(/data/fa, ''))",
			nodes: [earlierAnswer, laterAnswer],
			expect: {
				...same("0.020833333333333332"),
				"new-york": "-0.020833333333333332",
			},
		},
		// Text a setvalue writes into a datetime bind: an explicit offset is
		// converted to the device's clock, the written date is kept, and the
		// wall clock is resolved as `java.util.Calendar` resolves it.
		{
			id: "cast-repeated-hour",
			xpath: CAST_TEXT,
			nodes: castOf("2026-11-01T01:45:00.000-04:00"),
			expect: {
				utc: "2026-11-01T05:45Z",
				"new-york": "2026-11-01T01:45-05",
				kolkata: "2026-11-01T11:15+05:30",
				kiritimati: "2026-11-01T19:45+14",
			},
		},
		{
			id: "cast-z-day-late",
			xpath: CAST_TEXT,
			nodes: castOf("2026-01-02T04:30:00.000Z"),
			expect: {
				utc: "2026-01-02T04:30Z",
				"new-york": "2026-01-02T23:30-05",
				kolkata: "2026-01-02T10:00+05:30",
				kiritimati: "2026-01-02T18:30+14",
			},
		},
		{
			id: "cast-skipped-hour",
			xpath: CAST_TEXT,
			nodes: castOf("2026-03-08T02:30:00"),
			expect: {
				utc: "2026-03-08T02:30Z",
				"new-york": "2026-03-08T03:30-04",
				kolkata: "2026-03-08T02:30+05:30",
				kiritimati: "2026-03-08T02:30+14",
			},
		},
		// What a `now()` default writes in New York at the fixed clock: Core's
		// `DateTimeData.uncast` of 01:15 EDT, stamped with the offset at that
		// day's midnight. The cast then moves it to 01:15 EST. The native class
		// checks this text against Core's own uncast in New York.
		{
			id: "cast-now-default-repeated-hour",
			xpath: CAST_TEXT,
			nodes: castOf("2026-11-01T01:15:00.000-04"),
			expect: {
				utc: "2026-11-01T05:15Z",
				"new-york": "2026-11-01T01:15-05",
				kolkata: "2026-11-01T10:45+05:30",
				kiritimati: "2026-11-01T19:15+14",
			},
		},
		// Java's calendar (`Calendar.getInstance()`, a GregorianCalendar): fields
		// before 1582-10-15 are Julian both ways, so Julian 1500-01-01 is day
		// -171655 (proleptic Gregorian 1500-01-10). Every zone's local mean time
		// sits within twelve hours of its 1970 offset, so no day shifts there.
		{
			id: "julian-days",
			xpath: "number(date('1500-01-01'))",
			expect: same("-171655"),
		},
		{
			id: "julian-text",
			xpath: "string(date('1500-01-01'))",
			expect: same("1500-01-01"),
		},
		{
			id: "julian-weekday",
			xpath: "format-date(date('1500-03-01'), '%Y-%m-%d %a')",
			expect: same("1500-03-01 Sun"),
		},
		{
			id: "julian-day-number",
			xpath: "string(date(-200000))",
			expect: same("1422-05-25"),
		},
		{
			id: "julian-day-number-round-trip",
			xpath: "number(date(-200000))",
			expect: same("-200000"),
		},
		// A date in the cutover's gap is read as Julian, ten days on.
		{
			id: "cutover-gap",
			xpath: "string(date('1582-10-10'))",
			expect: same("1582-10-20"),
		},
		{
			id: "cutover-next-day",
			xpath: "string(date(number(date('1582-10-04')) + 1))",
			expect: same("1582-10-15"),
		},
		// `formatDateISO8601` prints the year unpadded.
		{
			id: "year-50-text",
			xpath: "string(date('0050-01-01'))",
			expect: same("50-01-01"),
		},
		// Day numbers past JavaScript's Date range, inside Java's: Core adds them
		// in long milliseconds. Kiritimati's +1 from `dateAdd` and -1 from
		// `daysSinceEpoch` still cancel.
		{
			id: "far-day-number",
			xpath: "number(date(200000000))",
			expect: same("200000000"),
		},
		{
			id: "far-day-text",
			xpath: "string(date(200000000))",
			expect: { ...same("549551-05-28"), kiritimati: "549551-05-29" },
		},
		{
			id: "max-int-day-text",
			xpath: "string(date(2147483647))",
			expect: { ...same("5881580-07-11"), kiritimati: "5881580-07-12" },
		},
		{
			id: "max-int-day-number",
			xpath: "number(date(2147483647))",
			expect: same("2147483647"),
		},
		// A blank node is `""` after unpacking: `toDate` returns it, and
		// `expandDateSafe` then gives no date, which formats as `""`.
		{
			id: "blank-date",
			xpath: "string(date(/data/blank))",
			nodes: [blank],
			expect: same(""),
		},
		{
			id: "blank-format-date",
			xpath: "format-date(/data/blank, '%Y')",
			nodes: [blank],
			expect: same(""),
		},
		{
			id: "blank-format-date-for-calendar",
			xpath: "format-date-for-calendar(/data/blank, 'nepali')",
			nodes: [blank],
			expect: same(""),
		},
	],
};
