import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type InstantOperand,
	type InstantOperator,
	type InstantPair,
	instantFixedClock,
	instantOperators,
	instantOrderingPairs,
} from "@/lib/commcare/__tests__/instantOrderingTable";
import {
	type HeldKind,
	instantFixture,
} from "@/lib/commcare/xpath/wire/__tests__/instantFixture";
import { w } from "@/lib/commcare/xpath/wire/builders";
import { instantMicros } from "@/lib/commcare/xpath/wire/instant";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import { type Field, fieldSchema, type Uuid } from "@/lib/domain";
import {
	coalesce,
	datetimeCoerce,
	eq,
	gt,
	gte,
	literal,
	lt,
	lte,
	neq,
	now,
	term,
} from "@/lib/domain/expression/builders";
import { literalInstantText } from "@/lib/domain/expression/instantOperand";
import type { Expression } from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import { instantDatetimeValue } from "@/lib/domain/temporalValues";
import { DataInstance } from "../../engine/dataInstance";
import { buildFieldTree } from "../../engine/fieldTree";
import { evaluate } from "../evaluator";
import type { EvalContext } from "../types";

// Preview evaluates the `preview` print of the same lowered tree a device
// evaluates. Each pair runs in device zones whose offsets differ in sign,
// size and minutes, with DST on both sides of the date line, and every
// expected order is the order of the two moments, computed here from each
// operand's instant, never from the lowering under test.

const ZONES = [
	"UTC",
	"America/New_York",
	"Asia/Kolkata",
	"Pacific/Kiritimati",
	"Australia/Lord_Howe",
	"America/St_Johns",
] as const;

const COMPARISON = {
	"<": lt,
	"<=": lte,
	">": gt,
	">=": gte,
	"=": eq,
	"!=": neq,
} as const;

/** One side of a pair as the device holds it: the field kind its value sits
 * in (none for `now()`), whether it is coerced, its held text in `zone`, and
 * its moment in microseconds (undefined for a value that names none). */
interface Side {
	readonly kind: HeldKind | "now";
	readonly coerced: boolean;
	held(zone: string): string;
	readonly micros: number | undefined;
	/** A date compared as a day, `YYYY-MM-DD`. */
	readonly day?: string;
}

/** Integer microseconds of an ISO instant written with `Z`, read by Date
 * for the milliseconds and by its digits for the rest. */
function oracleMicros(iso: string): number {
	const match = /^(.{19})(?:\.(\d{1,6}))?Z$/.exec(iso);
	if (match === null) throw new Error(`Not a UTC instant: ${iso}`);
	const [, whole, fraction = ""] = match;
	return (
		Date.parse(`${whole}Z`) * 1000 + Number(fraction.padEnd(6, "0") || "0")
	);
}

function side(operand: InstantOperand): Side {
	switch (operand.held) {
		case "datetime":
			return {
				kind: "typed",
				coerced: false,
				held: (zone) => instantDatetimeValue(Date.parse(operand.instant), zone),
				micros: oracleMicros(new Date(operand.instant).toISOString()),
			};
		case "now":
			return {
				kind: "now",
				coerced: false,
				held: () => "",
				micros: oracleMicros(instantFixedClock),
			};
		case "text":
			return {
				kind: "text",
				coerced: false,
				held: () => operand.value,
				micros: oracleMicros(operand.instant),
			};
		case "core-text":
			return {
				kind: "text",
				coerced: false,
				held: () =>
					instantDatetimeValue(Date.parse(operand.instant), operand.writerZone),
				micros: oracleMicros(operand.instant),
			};
		case "date":
		case "date-text":
			return {
				kind: operand.held,
				coerced: operand.datetimeCoerce === true,
				held: () => operand.value,
				micros:
					operand.datetimeCoerce === true
						? oracleMicros(`${operand.value}T00:00:00Z`)
						: undefined,
				day: operand.value,
			};
		case "malformed":
			return {
				kind: "text",
				coerced: false,
				held: () => operand.value,
				micros: undefined,
			};
	}
}

const DATA_KIND: Record<HeldKind, Field["kind"]> = {
	typed: "datetime",
	date: "date",
	text: "text",
	"date-text": "text",
	"clock-lost": "text",
	int: "int",
	// An untyped Hidden Value holds its value as text.
	unknown: "text",
};

const prints = new Map<string, string>();
/** The comparison's `preview` print, over a document whose `left` and
 * `right` hold each side as its kind. */
function printed(
	left: Side,
	right: Side,
	operator: InstantOperator,
	wrap: (expression: Expression) => Expression = (expression) => expression,
): string {
	const key = `${left.kind}${left.coerced}|${operator}|${right.kind}${right.coerced}|${wrap.name}`;
	const known = prints.get(key);
	if (known !== undefined) return known;
	const fields: Record<string, HeldKind> = {};
	if (left.kind !== "now") fields.left = left.kind;
	if (right.kind !== "now") fields.right = right.kind;
	const fx = instantFixture(fields);
	const operand = (name: string, held: Side): Expression => {
		if (held.kind === "now") return now();
		const read = fx.field(name);
		return held.coerced ? datetimeCoerce(read) : read;
	};
	const text = serializeWire(
		fx.lowerForm(
			COMPARISON[operator](
				wrap(operand("left", left)),
				operand("right", right),
			),
			"preview",
		),
		{ target: "preview" },
	).text;
	prints.set(key, text);
	return text;
}

function contextFor(
	values: ReadonlyArray<readonly [string, Side]>,
	zone: string,
): EvalContext {
	const root = testUuid("instant-lowering-root");
	const fields: Record<string, Field> = {};
	const order: Record<string, Uuid[]> = { [root]: [] };
	for (const [name, held] of values) {
		if (held.kind === "now") continue;
		const uuid = testUuid(`instant-lowering-${name}`);
		fields[uuid] = fieldSchema.parse({
			uuid,
			id: name,
			kind: DATA_KIND[held.kind],
			label: proseText(name),
		});
		order[root]?.push(uuid);
	}
	const data = new DataInstance();
	data.initFromFields(buildFieldTree(root, fields, order));
	for (const [name, held] of values)
		if (held.kind !== "now") data.set(`/data/${name}`, held.held(zone));
	const mainInstance = data.asXPathInstance();
	const rootNode = mainInstance.root();
	return {
		mainInstance,
		contextNode: rootNode,
		originalContextNode: rootNode,
		contextPath: "/",
		position: undefined,
		getValue: (path) => data.get(path),
	};
}

/** The order of two moments; a side that names none (blank, malformed)
 * orders false both ways and equals nothing. */
function expected(
	left: Side,
	right: Side,
	operator: InstantOperator,
): boolean | undefined {
	if (left.day !== undefined && right.day !== undefined && !left.coerced)
		return compare(
			left.day < right.day ? -1 : left.day > right.day ? 1 : 0,
			operator,
		);
	if (left.micros === undefined || right.micros === undefined) return undefined;
	return compare(Math.sign(left.micros - right.micros), operator);
}
function compare(order: number, operator: InstantOperator): boolean {
	switch (operator) {
		case "<":
			return order < 0;
		case "<=":
			return order <= 0;
		case ">":
			return order > 0;
		case ">=":
			return order >= 0;
		case "=":
			return order === 0;
		case "!=":
			return order !== 0;
	}
}

/** Every pair but most of the microsecond sweep and of the malformed cross
 * product, which repeat the same texts over more values. */
function sampledPairs(): readonly InstantPair[] {
	const index = (id: string) => Number(/-(\d+)$/.exec(id)?.[1] ?? 0);
	return instantOrderingPairs().filter((pair) => {
		if (pair.group.startsWith("microseconds")) return index(pair.left.id) < 20;
		if (pair.group === "malformed-pairs")
			return index(pair.left.id) < 4 || index(pair.right.id) < 4;
		return true;
	});
}

function inEachZone(run: (zone: string) => void): void {
	const originalTimeZone = process.env.TZ;
	vi.useFakeTimers();
	try {
		for (const zone of ZONES) {
			// Node re-reads the zone on assignment; every value is built after.
			process.env.TZ = zone;
			vi.setSystemTime(new Date(instantFixedClock));
			run(zone);
		}
	} finally {
		vi.useRealTimers();
		if (originalTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = originalTimeZone;
	}
}

const BLANK_TEXT: Side = {
	kind: "text",
	coerced: false,
	held: () => "",
	micros: undefined,
};
const BLANK_TYPED: Side = { ...BLANK_TEXT, kind: "typed" };
const TYPED: Side = side({
	id: "typed",
	held: "datetime",
	instant: instantFixedClock,
});
const text = (value: string, micros: number): Side => ({
	kind: "text",
	coerced: false,
	held: () => value,
	micros,
});
const base = Date.parse(instantFixedClock) * 1000;

describe("Preview orders the lowered comparisons as moments in every zone", () => {
	// Six zones over the sampled table: seconds of evaluation, so it carries
	// its own budget rather than the default five.
	it("evaluates each table pair to the order of its two moments", () => {
		const pairs = sampledPairs();
		inEachZone((zone) => {
			for (const pair of pairs) {
				const left = side(pair.left),
					right = side(pair.right);
				const xpath = printed(left, right, pair.operator);
				const label = `${zone}: ${pair.id}`;
				const result = evaluate(
					xpath,
					contextFor(
						[
							["left", left],
							["right", right],
						],
						zone,
					),
				);
				expect(typeof result, label).toBe("boolean");
				const answer = expected(left, right, pair.operator);
				if (pair.group.startsWith("malformed")) continue;
				expect(answer, label).toBeDefined();
				expect(result, label).toBe(answer);
			}
		});
	}, 20_000);

	it("treats a blank side as no moment, including a coalesce's blank date", () => {
		inEachZone((zone) => {
			for (const blank of [BLANK_TEXT, BLANK_TYPED])
				for (const operator of instantOperators) {
					for (const [left, right] of [
						[blank, TYPED],
						[TYPED, blank],
						[blank, blank],
					] as const) {
						const result = evaluate(
							printed(left, right, operator),
							contextFor(
								[
									["left", left],
									["right", right],
								],
								zone,
							),
						);
						expect(result, `${zone}: blank ${operator}`).toBe(
							operator === "!=",
						);
					}
				}
			// coalesce(datetime-coerce(<blank date>), now()) falls through to now().
			const blankDate: Side = {
				kind: "date",
				coerced: true,
				held: () => "",
				micros: undefined,
			};
			const nowSide: Side = side({
				id: "now",
				held: "now",
				instant: instantFixedClock,
			});
			for (const operator of instantOperators) {
				const xpath = printed(
					blankDate,
					TYPED,
					operator,
					function coalesced(expression) {
						return coalesce(expression, now());
					},
				);
				expect(
					evaluate(
						xpath,
						contextFor(
							[
								["left", blankDate],
								["right", TYPED],
							],
							zone,
						),
					),
					`${zone}: coalesce ${operator}`,
				).toBe(expected(nowSide, TYPED, operator));
			}
		});
	});

	it("reads the spellings a lookup cell admits", () => {
		const spellings: ReadonlyArray<readonly [string, number]> = [
			["2026-01-02 10:00:00+0530", base],
			["2026-01-02t04:30:00z", base],
			["2026-01-01T23:30:00-0500", base],
			["2026-01-02T04:30:00.123456789Z", base + 123457],
			["2026-01-02T04:30:00.5z", base + 500000],
		];
		inEachZone((zone) => {
			for (const [value, micros] of spellings)
				for (const operator of instantOperators) {
					const left = text(value, micros);
					expect(
						evaluate(
							printed(left, TYPED, operator),
							contextFor(
								[
									["left", left],
									["right", TYPED],
								],
								zone,
							),
						),
						`${zone}: ${value} ${operator}`,
					).toBe(expected(left, TYPED, operator));
				}
		});
	});

	it("compares a value of unknown type holding now()'s moment, in any spelling, as that moment", () => {
		const nowSide: Side = side({
			id: "now",
			held: "now",
			instant: instantFixedClock,
		});
		const spellings = [
			"2026-01-02T10:00:00+05:30",
			"2026-01-02 04:30:00z",
			"2026-01-01T23:30:00.000-05:00",
		];
		inEachZone((zone) => {
			for (const value of spellings)
				for (const operator of instantOperators) {
					const left: Side = {
						kind: "unknown",
						coerced: false,
						held: () => value,
						micros: base,
					};
					expect(
						evaluate(
							printed(left, nowSide, operator),
							contextFor([["left", left]], zone),
						),
						`${zone}: ${value} ${operator} now()`,
					).toBe(expected(left, nowSide, operator));
				}
		});
	});

	it("reads a literal at either end of the four-digit years, printed in its own offset", () => {
		const yearZero = new Date(Date.UTC(2000, 0, 1));
		yearZero.setUTCFullYear(0);
		// The first two UTC moments fall in the years 10000 and -1; the last two
		// offsets run past 23 hours and 59 minutes, which Core adds to the clock.
		const literals: ReadonlyArray<readonly [string, number]> = [
			["9999-12-31T23:59:59-05:00", Date.UTC(10000, 0, 1, 4, 59, 59) * 1000],
			["0000-01-01T00:00:00+01:00", (yearZero.getTime() - 3_600_000) * 1000],
			["2026-01-03T04:30:00+24:00", base],
			["2026-01-02T10:45:00+05:75", base],
		];
		inEachZone((zone) => {
			for (const [value, micros] of literals) {
				const text = literalInstantText(value);
				if (text === undefined) throw new Error(`No text for ${value}.`);
				const parse = serializeWire(instantMicros(w.str(text)), {
					target: "preview",
				}).text;
				expect(evaluate(parse, contextFor([], zone)), `${zone}: ${value}`).toBe(
					micros,
				);
				// A sentinel in a branch, chosen when the text side is blank.
				const sentinel: Side = {
					kind: "text",
					coerced: false,
					held: () => "",
					micros,
				};
				const branch = Object.defineProperty(
					(expression: Expression) =>
						coalesce(expression, term(literal(value))),
					"name",
					{ value: `sentinel ${value}` },
				);
				for (const operator of instantOperators) {
					const xpath = printed(BLANK_TEXT, TYPED, operator, branch);
					expect(xpath, value).toContain(`'${text}'`);
					expect(
						evaluate(
							xpath,
							contextFor(
								[
									["left", BLANK_TEXT],
									["right", TYPED],
								],
								zone,
							),
						),
						`${zone}: coalesce(blank, '${value}') ${operator}`,
					).toBe(expected(sentinel, TYPED, operator));
				}
			}
		});
	});

	it("rounds one argument as Core does", () => {
		const ctx = contextFor([], "UTC");
		expect(evaluate("round(0.49999999999999994)", ctx)).toBe(1);
		expect(evaluate("round(2.5)", ctx)).toBe(3);
		expect(evaluate("round(-2.5)", ctx)).toBe(-2);
	});
});
