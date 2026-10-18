/**
 * Shared instant inputs, not expected results. The native reader computes its
 * own calendar/instant oracle; no result comes from the emitter under test.
 */
export type InstantOperand = { id: string } & (
	| { held: "datetime" | "now"; instant: string }
	| { held: "text"; instant: string; value: string }
	| { held: "core-text"; instant: string; writerZone: string }
	| { held: "date" | "date-text"; value: string; datetimeCoerce?: true }
	| { held: "malformed"; value: string }
);

export const instantOperators = ["<", "<=", ">", ">=", "=", "!="] as const;
export type InstantOperator = (typeof instantOperators)[number];
export type InstantPair = {
	id: string;
	group: string;
	left: InstantOperand;
	right: InstantOperand;
	operator: InstantOperator;
	control: "bare" | "wall-clock";
};

export const instantFixedClock = "2026-01-02T04:30:00.000Z";
const baseMicros = BigInt(Date.parse(instantFixedClock)) * 1_000n;
type Spelling = {
	id: string;
	minutes: number;
	suffix: string;
	fraction: 0 | 3 | 6;
};
export const instantSpellings: readonly Spelling[] = [
	{ id: "z0", minutes: 0, suffix: "Z", fraction: 0 },
	{ id: "z3", minutes: 0, suffix: "Z", fraction: 3 },
	{ id: "z6", minutes: 0, suffix: "Z", fraction: 6 },
	{ id: "plus5", minutes: 300, suffix: "+05", fraction: 3 },
	{ id: "plus530", minutes: 330, suffix: "+05:30", fraction: 3 },
	{ id: "plus545", minutes: 345, suffix: "+05:45", fraction: 3 },
	{ id: "minus500", minutes: -300, suffix: "-05:00", fraction: 3 },
	{ id: "minus5", minutes: -300, suffix: "-05", fraction: 3 },
	{ id: "minus330", minutes: -210, suffix: "-03:30", fraction: 6 },
	{ id: "plus14", minutes: 840, suffix: "+14", fraction: 3 },
	{ id: "minus1100", minutes: -660, suffix: "-11:00", fraction: 0 },
	{ id: "naive3", minutes: 0, suffix: "", fraction: 3 },
	{ id: "naive0", minutes: 0, suffix: "", fraction: 0 },
];

/** The original planning probe's 28 inputs, including its permissive shapes. */
export const instantMalformedTexts = [
	"",
	" ",
	"nope",
	"2026-01-02",
	"2026-01-02T04:30Z",
	"2026-01-02T04:30",
	"2026-01-02 04:30:00Z",
	"2026-13-45T99:99:99Z",
	"2026-01-02T04:30:00+5",
	"2026-01-02T04:30:00+",
	"2026-01-02T04:30:00-",
	"2026-01-02T04:30:00.",
	"2026-01-02T04:30:00..1Z",
	"2026-01-02T04:30:00+05:3",
	"2026-01-02T04:30:00Zjunk",
	" 2026-01-02T04:30:00Z",
	"2026-01-02T04:30:00Z ",
	"1-01-01T00:00:00Z",
	"10-1-1T00:00:00Z",
	"1-1-1T1-1-1Z",
	"----------------------",
	"2026-01-02T-4:30:00Z",
	"2026-01-02T04:30:00e5Z",
	"2026-01-02T04:30:00-1-1",
	"٢٠٢٦-01-02T04:30:00Z",
	"2026-01-02T04:30:00.123456789Z",
	"NaN",
	"Infinity",
] as const;

function spell(micros: bigint, style: Spelling): string {
	const wall = micros + BigInt(style.minutes) * 60_000_000n;
	const whole = new Date(Number(wall / 1_000_000n) * 1_000)
		.toISOString()
		.slice(0, 19);
	const fraction = (wall % 1_000_000n).toString().padStart(6, "0");
	return `${whole}${style.fraction ? `.${fraction.slice(0, style.fraction)}` : ""}${style.suffix}`;
}
const utcSix: Spelling = { id: "z6", minutes: 0, suffix: "Z", fraction: 6 };
function textOperand(
	id: string,
	micros: bigint,
	style: Spelling,
): Extract<InstantOperand, { held: "text" }> {
	return {
		id,
		held: "text",
		instant: spell(micros, utcSix),
		value: spell(micros, style),
	};
}

export function instantOrderingPairs(): InstantPair[] {
	const pairs: InstantPair[] = [];
	function pair(
		group: string,
		left: InstantOperand,
		right: InstantOperand,
		control: InstantPair["control"] = "bare",
	) {
		for (const operator of instantOperators)
			pairs.push({
				id: `${group}/${left.id}/${right.id}/${operator}`,
				group,
				left,
				right,
				operator,
				control,
			});
	}
	const typed: InstantOperand = {
		id: "typed",
		held: "datetime",
		instant: instantFixedClock,
	};
	const later: InstantOperand = {
		id: "typed-hour-later",
		held: "datetime",
		instant: "2026-01-02T05:30:00Z",
	};
	const millisecond: InstantOperand = {
		id: "typed-millisecond-later",
		held: "datetime",
		instant: "2026-01-02T04:30:00.001Z",
	};
	for (const left of instantSpellings) {
		const first = textOperand(`first-${left.id}`, baseMicros, left);
		pair("typed-text", typed, first);
		pair(
			"typed-text-hour",
			typed,
			textOperand(`later-${left.id}`, baseMicros + 3_600_000_000n, left),
		);
		for (const right of instantSpellings) {
			pair(
				"spellings-same",
				first,
				textOperand(`first-${right.id}`, baseMicros, right),
			);
			pair(
				"spellings-hour",
				first,
				textOperand(`later-${right.id}`, baseMicros + 3_600_000_000n, right),
			);
		}
	}
	for (const right of [typed, later, millisecond]) pair("typed", typed, right);
	for (const writerZone of ["Asia/Kathmandu", "America/Los_Angeles"]) {
		const written: InstantOperand = {
			id: `writer-${writerZone}`,
			held: "core-text",
			instant: instantFixedClock,
			writerZone,
		};
		pair("writers", typed, written);
		pair("writers-hour", written, later);
		for (const style of instantSpellings)
			pair("writers-text", written, textOperand(style.id, baseMicros, style));
	}
	// Reproducible six-digit sweep: 300 instants across 1990..2040, five
	// spellings each, with a second set exactly one microsecond later.
	const six = [
		utcSix,
		...instantSpellings
			.filter((s) => ["plus530", "plus14", "minus330", "naive3"].includes(s.id))
			.map((s): Spelling => ({ ...s, fraction: 6 })),
	];
	let seed = 20261017n;
	for (let index = 0; index < 300; index++) {
		seed = BigInt.asUintN(
			64,
			seed * 6364136223846793005n + 1442695040888963407n,
		);
		const micros = 631152000000000n + ((seed >> 7n) % 1_577_836_800_000_000n);
		const left = textOperand(`micro-${index}`, micros, utcSix);
		for (const style of six) {
			pair(
				"microseconds-same",
				left,
				textOperand(`micro-${index}-${style.id}`, micros, style),
			);
			pair(
				"microseconds-next",
				left,
				textOperand(`next-${index}-${style.id}`, micros + 1n, style),
			);
		}
	}
	for (const [name, first, second] of [
		[
			"fall-back",
			"2026-11-01T01:30:00.000-04:00",
			"2026-11-01T01:30:00.000-05:00",
		],
		[
			"spring-forward",
			"2026-03-08T01:59:00.000-05:00",
			"2026-03-08T03:00:00.000-04:00",
		],
	] as const) {
		const left: InstantOperand = {
			id: `${name}-first`,
			held: "datetime",
			instant: new Date(first).toISOString(),
		};
		const right: InstantOperand = {
			id: `${name}-second`,
			held: "datetime",
			instant: new Date(second).toISOString(),
		};
		pair("dst-typed", left, right);
		pair(
			"dst-text",
			{ ...left, held: "text", value: first },
			{ ...right, held: "text", value: second },
		);
		pair("dst-wall-clock", left, right, "wall-clock");
	}
	for (const held of ["date", "date-text"] as const) {
		const date: InstantOperand = { id: held, held, value: "2026-01-02" };
		pair("dates-same", date, { ...date, id: `${held}-same` });
		pair("dates-next", date, {
			...date,
			id: `${held}-next`,
			value: "2026-01-03",
		});
		pair("date-coerced", { ...date, datetimeCoerce: true }, typed);
	}
	const now: InstantOperand = {
		id: "now",
		held: "now",
		instant: instantFixedClock,
	};
	for (const delta of [-1_000n, 0n, 1_000n]) {
		const text = textOperand(`clock-${delta}`, baseMicros + delta, utcSix);
		pair("now-text", text, now);
		pair(
			"now-typed",
			{ id: `typed-${delta}`, held: "datetime", instant: text.instant },
			now,
		);
	}
	const malformed = instantMalformedTexts.map(
		(value, index): InstantOperand => ({
			id: `malformed-${index}`,
			held: "malformed",
			value,
		}),
	);
	for (const left of malformed) {
		pair("malformed-typed", left, typed);
		for (const right of malformed) pair("malformed-pairs", left, right);
	}
	return pairs;
}
