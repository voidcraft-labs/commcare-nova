import { describe, expect, it } from "vitest";
import {
	csqlFixtureContext,
	csqlFunctionFixture,
} from "@/lib/commcare/__tests__/csqlFunctionFixture";
import {
	instantOrderingPairs,
	instantSpellings,
} from "@/lib/commcare/__tests__/instantOrderingTable";
import { emitCsql } from "@/lib/commcare/predicate/csqlEmitter";
import { datetimeCaseValueExpression } from "@/lib/commcare/xform/datetimeCaseValue";
import {
	between,
	coalesce,
	datetimeCoerce,
	datetimeLiteral,
	eq,
	gt,
	gte,
	ifExpr,
	isIn,
	literal,
	lt,
	neq,
	now,
	prop,
	switchCase,
	switchExpr,
	term,
} from "@/lib/domain/expression/builders";
import {
	literalInstantMicros,
	literalInstantText,
} from "@/lib/domain/expression/instantOperand";
import type { Expression } from "@/lib/domain/expression/types";
import { w } from "../builders";
import { instantMicros, typedInstantText } from "../instant";
import { serializeWire } from "../serialize";
import type { WireExpr } from "../tree";
import { instantFixture } from "./instantFixture";
import {
	instantMicrosOperand,
	parsedLiteralTexts,
	wireNodes,
} from "./instantParse";

/** Part 04 §3.1's parse with the lookup spellings widened: `Zz+-` marks an
 * offset, and the offset's minutes are its last two characters. */
const parse = (T: string) =>
	`((floor((number(substr(${T}, 0, 4)) - (number(substr(${T}, 5, 7)) <= 2)) div 400) * 146097 + ((number(substr(${T}, 0, 4)) - (number(substr(${T}, 5, 7)) <= 2) - floor((number(substr(${T}, 0, 4)) - (number(substr(${T}, 5, 7)) <= 2)) div 400) * 400) * 365 + floor((number(substr(${T}, 0, 4)) - (number(substr(${T}, 5, 7)) <= 2) - floor((number(substr(${T}, 0, 4)) - (number(substr(${T}, 5, 7)) <= 2)) div 400) * 400) div 4) - floor((number(substr(${T}, 0, 4)) - (number(substr(${T}, 5, 7)) <= 2) - floor((number(substr(${T}, 0, 4)) - (number(substr(${T}, 5, 7)) <= 2)) div 400) * 400) div 100) + (floor((153 * ((number(substr(${T}, 5, 7)) + 9) mod 12) + 2) div 5) + number(substr(${T}, 8, 10)) - 1)) - 719468) * 86400 + number(substr(${T}, 11, 13)) * 3600 + number(substr(${T}, 14, 16)) * 60 + number(substr(${T}, 17, 19)) - if(if(contains(translate(substr(${T}, 19), 'Zz+-', '||||'), '|'), substring-after(translate(substr(${T}, 19), 'Zz+-', '||||'), '|'), '') = '', 0, if(contains(substr(${T}, 19), '-'), -1, 1) * (number(substr(if(contains(translate(substr(${T}, 19), 'Zz+-', '||||'), '|'), substring-after(translate(substr(${T}, 19), 'Zz+-', '||||'), '|'), ''), 0, 2)) * 3600 + if(string-length(if(contains(translate(substr(${T}, 19), 'Zz+-', '||||'), '|'), substring-after(translate(substr(${T}, 19), 'Zz+-', '||||'), '|'), '')) > 2, number(substr(if(contains(translate(substr(${T}, 19), 'Zz+-', '||||'), '|'), substring-after(translate(substr(${T}, 19), 'Zz+-', '||||'), '|'), ''), string-length(if(contains(translate(substr(${T}, 19), 'Zz+-', '||||'), '|'), substring-after(translate(substr(${T}, 19), 'Zz+-', '||||'), '|'), '')) - 2)) * 60, 0)))) * 1000000 + if(starts-with(substr(${T}, 19), '.'), round(number(concat('0', substring-before(concat(translate(substr(${T}, 19), 'Zz+-', '||||'), '|'), '|'))) * 1000000), 0)`;

/** Every wire node of a tree, depth first. */
/** The two instant texts of a lowered comparison. */
function loweredTexts(wire: WireExpr): readonly [WireExpr, WireExpr] {
	if (wire.k !== "cmp") throw new Error("Expected a comparison.");
	const left = instantMicrosOperand(wire.left),
		right = instantMicrosOperand(wire.right);
	if (left === undefined || right === undefined)
		throw new Error("Expected both sides to read an instant text.");
	return [left, right];
}

/** Integer microseconds of a table instant, `YYYY-MM-DDTHH:MM:SS.ffffffZ`,
 * read by Date's own ISO parser for the milliseconds. */
function tableMicros(instant: string): number {
	return (
		Date.parse(`${instant.slice(0, 23)}Z`) * 1000 +
		Number(instant.slice(23, 26))
	);
}

describe("the instant parse", () => {
	it("prints the planned parse, widened to every spelling a lookup cell admits", () => {
		const t = w.form(["t"]);
		expect(
			serializeWire(instantMicros(t), { target: "xform", constraint: false })
				.text,
		).toBe(parse("/data/t"));
		expect(instantMicrosOperand(instantMicros(t))).toBe(t);
		expect(instantMicrosOperand(w.add(w.num(1), w.num(2)))).toBeUndefined();
	});
});

describe("folding a literal", () => {
	it("agrees with Date's ISO reading for each of the native run's 13 spellings", () => {
		const spelled = new Map<string, { value: string; instant: string }>();
		for (const pair of instantOrderingPairs())
			if (pair.group === "spellings-same" && pair.left.held === "text")
				spelled.set(pair.left.id, pair.left);
		expect(spelled.size).toBe(instantSpellings.length);
		for (const { value, instant } of spelled.values())
			expect(literalInstantMicros(value), value).toBe(tableMicros(instant));
	});

	it("names the planned integers", () => {
		expect(literalInstantMicros("2026-01-01T00:00:00Z")).toBe(1767225600000000);
		expect(literalInstantMicros("2026-01-02T10:00:00.000+05:30")).toBe(
			1767328200000000,
		);
		expect(literalInstantMicros("2026-01-02T04:30:00.000000Z")).toBe(
			1767328200000000,
		);
	});

	it("reads minutes, dates, lowercase marks, a space and every offset shape", () => {
		const base = Date.UTC(2026, 0, 2, 4, 30) * 1000;
		for (const [text, micros] of [
			["2026-01-02T04:30Z", base],
			["2026-01-02T10:00+05:30", base],
			["2026-01-02 10:00:00+0530", base],
			["2026-01-02t04:30:00z", base],
			["2026-01-02T04:30:00", base],
			["2026-01-01T23:30:00-05", base],
			["2026-01-02T04:30:00.123456789Z", base + 123457],
			["2026-01-02T04:30:00.0000005Z", base + 1],
			["2026-01-02", Date.UTC(2026, 0, 2) * 1000],
			["1969-12-31T23:59:59.999999Z", -1],
			["2024-02-29T00:00:00Z", Date.UTC(2024, 1, 29) * 1000],
			["9999-12-31T23:59:59Z", Date.UTC(9999, 11, 31, 23, 59, 59) * 1000],
			// Core reads an offset's hours and minutes as integers and adds them
			// to the clock (`DateUtils.parseTimeAndStore`).
			["2026-01-03T04:30:00+24:00", base],
			["2026-01-02T10:45:00+05:75", base],
		] as const)
			expect(literalInstantMicros(text), text).toBe(micros);
	});

	it("names no moment for text no instant spelling reads", () => {
		for (const text of [
			"",
			"nope",
			"2026-13-01T00:00:00Z",
			"2025-02-29",
			"2026-01-02T24:00:00Z",
			"2026-01-02T04:30:00+5",
			"2026-01-02T04:30:00Zjunk",
			" 2026-01-02T04:30:00Z",
		])
			expect(literalInstantMicros(text), text).toBeUndefined();
	});

	it("names the moment of every literal with a four-digit year, whatever its offset", () => {
		const yearZero = new Date(Date.UTC(2000, 0, 1));
		yearZero.setUTCFullYear(0);
		const zero = yearZero.getTime() * 1000;
		expect(literalInstantMicros("0000-01-01T00:00:00Z")).toBe(zero);
		expect(literalInstantMicros("0000-01-01")).toBe(zero);
		expect(literalInstantMicros("9999-12-31T23:59:59.999Z")).toBe(
			Date.UTC(9999, 11, 31, 23, 59, 59, 999) * 1000,
		);
		// Their UTC moments fall in the years 10000 and -1.
		expect(literalInstantMicros("9999-12-31T23:59:59-05:00")).toBe(
			Date.UTC(10000, 0, 1, 4, 59, 59) * 1000,
		);
		expect(literalInstantMicros("0000-01-01T00:00:00+01:00")).toBe(
			zero - 3_600_000_000,
		);
		for (const text of ["10000-01-01T00:00:00Z", "-0001-01-01", "999-01-01"])
			expect(literalInstantMicros(text), text).toBeUndefined();
	});

	it("prints a literal in its own date, clock and offset", () => {
		for (const [text, printed] of [
			["2026-01-02T04:30:00Z", "2026-01-02T04:30:00.000Z"],
			["2026-01-02", "2026-01-02T00:00:00.000Z"],
			["2026-01-02T04:30", "2026-01-02T04:30:00.000Z"],
			["2026-01-02 10:00+0530", "2026-01-02T10:00:00.000+05:30"],
			["2026-01-01T23:30:00-05", "2026-01-01T23:30:00.000-05:00"],
			["2026-01-02T04:30:00-00:00", "2026-01-02T04:30:00.000Z"],
			["2026-01-02t04:30:00.5z", "2026-01-02T04:30:00.500Z"],
			["2026-01-02T04:30:00.0000005Z", "2026-01-02T04:30:00.0000005Z"],
			["2026-01-02T10:45:00+05:75", "2026-01-02T10:45:00.000+05:75"],
			[
				"9999-12-31T23:59:59.9999996-05:00",
				"9999-12-31T23:59:59.9999996-05:00",
			],
			["0000-01-01T00:00:00+01:00", "0000-01-01T00:00:00.000+01:00"],
		] as const)
			expect(literalInstantText(text), text).toBe(printed);
		for (const text of ["2026-02-30", "nope", "10000-01-01T00:00:00Z"])
			expect(literalInstantText(text), text).toBeUndefined();
	});
});

describe("each operand takes the instant text of how its device holds it", () => {
	const fx = instantFixture({
		dt: "typed",
		dt2: "typed",
		copy: "text",
		copy2: "text",
		d: "date",
		d2: "date",
		dtext: "date-text",
		n: "int",
		u: "unknown",
		u2: "unknown",
	});
	const seen = term(prop("visit", "seen"));
	const due = term(prop("visit", "due"));
	const value = (expression: Expression) => fx.lowerForm(expression);

	it("reads a typed answer through its own formatted text and text as itself", () => {
		const [left, right] = loweredTexts(
			fx.lowerForm(lt(fx.field("dt"), fx.field("copy"))),
		);
		expect(left).toEqual(typedInstantText(value(fx.field("dt"))));
		expect(right).toEqual(value(fx.field("copy")));
		const [clock] = loweredTexts(fx.lowerForm(gt(now(), fx.field("copy"))));
		expect(clock).toEqual(typedInstantText(w.call("now")));
	});

	it("never takes date() of now() or of a typed answer", () => {
		const wire = fx.lowerForm(lt(now(), fx.field("dt")));
		expect(
			wireNodes(wire).filter((node) => node.k === "call" && node.fn === "date"),
		).toEqual([]);
	});

	it("keeps a date against a date as written", () => {
		expect(fx.lowerForm(lt(fx.field("d"), fx.field("d2")))).toEqual(
			w.lt(value(fx.field("d")), value(fx.field("d2"))),
		);
		expect(fx.lowerForm(lt(fx.field("d"), literal("2026-01-01")))).toEqual(
			w.lt(value(fx.field("d")), w.str("2026-01-01")),
		);
	});

	it("keeps the blank test as written and lowers an equality of two moments", () => {
		expect(fx.lowerForm(eq(fx.field("dt"), literal("")))).toEqual(
			w.eq(value(fx.field("dt")), w.str("")),
		);
		expect(fx.lowerForm(neq(fx.field("copy"), literal("")))).toEqual(
			w.ne(value(fx.field("copy")), w.str("")),
		);
		expect(fx.lowerRecord(eq(seen, literal("")))).toEqual(
			w.eq(fx.lowerRecord(seen), w.str("")),
		);
		const [left, right] = loweredTexts(
			fx.lowerForm(eq(fx.field("dt"), fx.field("dt2"))),
		);
		expect(left).toEqual(typedInstantText(value(fx.field("dt"))));
		expect(right).toEqual(typedInstantText(value(fx.field("dt2"))));
	});

	it("lowers an equality of a value of unknown type with a moment by its held text", () => {
		for (const comparison of [eq, neq, lt] as const) {
			const [left, right] = loweredTexts(
				fx.lowerForm(comparison(fx.field("u"), now())),
			);
			expect(left).toEqual(value(fx.field("u")));
			expect(right).toEqual(typedInstantText(w.call("now")));
		}
		const member = wireNodes(
			fx.lowerForm(
				isIn(fx.field("u"), datetimeLiteral("2026-01-02T04:30:00Z")),
			),
		).find((node) => node.k === "cmp");
		expect(member).toEqual(
			w.eq(instantMicros(value(fx.field("u"))), w.num(1767328200000000)),
		);
		// Two values of unknown type, and one against a blank, stay as written.
		expect(fx.lowerForm(eq(fx.field("u"), fx.field("u2")))).toEqual(
			w.eq(value(fx.field("u")), value(fx.field("u2"))),
		);
		expect(fx.lowerForm(eq(fx.field("u"), literal("")))).toEqual(
			w.eq(value(fx.field("u")), w.str("")),
		);
	});

	it("folds a form literal its comparison types as a date and time", () => {
		for (const comparison of [lt, eq] as const) {
			const wire = fx.lowerForm(
				comparison(fx.field("dt"), literal("2026-01-02T10:00:00.000+05:30")),
			);
			if (wire.k !== "cmp") throw new Error("Expected a comparison.");
			expect(instantMicrosOperand(wire.left)).toEqual(
				typedInstantText(value(fx.field("dt"))),
			);
			expect(wire.right).toEqual(w.num(1767328200000000));
		}
		const record = fx.lowerRecord(
			lt(seen, datetimeLiteral("2026-01-01T00:00:00Z")),
		);
		expect(record).toEqual(
			w.lt(instantMicros(fx.lowerRecord(seen)), w.num(1767225600000000)),
		);
	});

	it("gives each branch its own row, inside one parse", () => {
		const choose = eq(fx.field("n"), literal(1));
		const [left] = loweredTexts(
			fx.lowerForm(lt(ifExpr(choose, now(), fx.field("copy")), fx.field("dt"))),
		);
		expect(left).toEqual(
			w.call("if", [
				value(choose),
				typedInstantText(w.call("now")),
				value(fx.field("copy")),
			]),
		);
		const [chosen] = loweredTexts(
			fx.lowerForm(
				lt(ifExpr(choose, now(), term(literal(""))), fx.field("dt")),
			),
		);
		expect(chosen).toEqual(
			w.call("if", [value(choose), typedInstantText(w.call("now")), w.str("")]),
		);
	});

	it("starts a coerced date at its UTC midnight, blank inside a coalesce", () => {
		const d = value(fx.field("d"));
		const midnight = w.call("concat", [
			w.call("format-date", [
				w.call("coalesce", [d, w.str("")]),
				w.str("%Y-%m-%d"),
			]),
			w.str("T00:00:00Z"),
		]);
		const [plain] = loweredTexts(
			fx.lowerForm(lt(datetimeCoerce(fx.field("d")), fx.field("dt"))),
		);
		expect(plain).toEqual(midnight);
		const [first] = loweredTexts(
			fx.lowerForm(
				lt(coalesce(datetimeCoerce(fx.field("d")), fx.field("dt")), now()),
			),
		);
		expect(first).toEqual(
			w.call("coalesce", [
				w.call("if", [w.eq(d, w.str("")), w.str(""), midnight]),
				typedInstantText(value(fx.field("dt"))),
			]),
		);
		const text = value(fx.field("dtext"));
		const [dayText] = loweredTexts(
			fx.lowerForm(lt(datetimeCoerce(fx.field("dtext")), fx.field("copy"))),
		);
		expect(dayText).toEqual(w.call("concat", [text, w.str("T00:00:00Z")]));
	});

	it("lowers each in member, between bound and switch case on one shared operand", () => {
		const a = "2026-01-02T04:30:00Z",
			b = "2026-01-03T04:30:00Z";
		const member = fx.lowerRecord(
			isIn(seen, datetimeLiteral(a), datetimeLiteral(b), literal("")),
		);
		if (member.k !== "or") throw new Error("Expected a disjunction.");
		const [first, second, blank] = member.items;
		if (first?.k !== "cmp" || second?.k !== "cmp" || blank === undefined)
			throw new Error("Expected three equalities.");
		expect(first).toEqual(
			w.eq(
				instantMicros(fx.lowerRecord(seen)),
				w.num(literalInstantMicros(a) ?? Number.NaN),
			),
		);
		expect(second.left).toBe(first.left);
		expect(blank).toEqual(w.eq(fx.lowerRecord(seen), w.str("")));

		const range = fx.lowerRecord(
			between(seen, { lower: due, upper: datetimeLiteral(b) }),
		);
		if (range.k !== "and") throw new Error("Expected a conjunction.");
		const [lower, upper] = range.items;
		if (lower.k !== "cmp" || upper.k !== "cmp")
			throw new Error("Expected two comparisons.");
		expect(lower).toEqual(
			w.gte(
				instantMicros(fx.lowerRecord(seen)),
				instantMicros(fx.lowerRecord(due)),
			),
		);
		expect(upper.left).toBe(lower.left);
		expect(upper.right).toEqual(w.num(literalInstantMicros(b) ?? Number.NaN));

		expect(
			fx.lowerRecord(
				switchExpr(
					seen,
					[switchCase(datetimeLiteral(a), term(literal("x")))],
					term(literal("y")),
				),
			),
		).toEqual(
			w.call("if", [
				w.eq(
					instantMicros(fx.lowerRecord(seen)),
					w.num(literalInstantMicros(a) ?? Number.NaN),
				),
				w.str("x"),
				w.str("y"),
			]),
		);
	});

	it("compares a system date with a day by its day, with today's bytes", () => {
		const opened = term(prop("visit", "date_opened"));
		const print = (expression: Expression) =>
			serializeWire(fx.lowerRecord(expression), { target: "suite" }).text;
		expect(
			print(gte(opened, datetimeCoerce(term(literal("2026-01-01"))))),
		).toBe("date_opened >= date('2026-01-01')");
		expect(print(gt(term(prop("visit", "last_modified")), opened))).toBe(
			"last_modified > date_opened",
		);
	});

	it("scales a day number to microseconds", () => {
		const visits = term(prop("visit", "visits"));
		expect(fx.lowerRecord(lt(datetimeCoerce(visits), seen))).toEqual(
			w.lt(
				w.mul(fx.lowerRecord(visits), w.num(86400000000)),
				instantMicros(fx.lowerRecord(seen)),
			),
		);
	});

	it("prints a coerced value as its moment's text outside a comparison", () => {
		const d = value(fx.field("d"));
		expect(fx.lowerForm(datetimeCoerce(fx.field("d")))).toEqual(
			w.call("if", [
				w.eq(d, w.str("")),
				w.str(""),
				w.call("concat", [
					w.call("format-date", [
						w.call("coalesce", [d, w.str("")]),
						w.str("%Y-%m-%d"),
					]),
					w.str("T00:00:00.000Z"),
				]),
			]),
		);
		expect(fx.lowerForm(datetimeCoerce(fx.field("dt")))).toEqual(
			datetimeCaseValueExpression(value(fx.field("dt"))),
		);
		expect(fx.lowerForm(datetimeCoerce(fx.field("copy")))).toEqual(
			value(fx.field("copy")),
		);
		expect(fx.lowerRecord(datetimeCoerce(term(literal("2026-01-01"))))).toEqual(
			w.str("2026-01-01T00:00:00.000Z"),
		);
		const note = fx.lowerRecord(term(prop("visit", "note")));
		expect(fx.lowerRecord(datetimeCoerce(term(prop("visit", "note"))))).toEqual(
			w.call("if", [
				w.eq(w.call("string-length", [note]), w.num(10)),
				w.call("concat", [note, w.str("T00:00:00.000Z")]),
				note,
			]),
		);
	});

	it("keeps date() for a coerced value that names no moment", () => {
		for (const value of [literal(""), literal(true)])
			expect(fx.lowerRecord(datetimeCoerce(term(value)))).toEqual(
				w.call("date", [fx.lowerRecord(term(value))]),
			);
	});

	it("prints a form literal branch its comparison types as a date and time in its own offset", () => {
		const n1 = eq(fx.field("n"), term(literal(1)));
		expect(
			parsedLiteralTexts(
				fx.lowerForm(
					lt(
						fx.field("dt"),
						ifExpr(n1, term(literal("2026-01-02T10:00+05:30")), now()),
					),
				),
			),
		).toEqual(["2026-01-02T10:00:00.000+05:30"]);
		// An end-of-time sentinel keeps its own year, whose UTC moment is in
		// the year 10000.
		expect(
			parsedLiteralTexts(
				fx.lowerForm(
					lt(
						fx.field("dt"),
						ifExpr(n1, term(literal("9999-12-31T23:59:59-05:00")), now()),
					),
				),
			),
		).toEqual(["9999-12-31T23:59:59.000-05:00"]);
		expect(
			parsedLiteralTexts(
				fx.lowerForm(
					gt(
						coalesce(fx.field("dt"), term(literal("2030-01-01T09:00"))),
						now(),
					),
				),
			),
		).toEqual(["2030-01-01T09:00:00.000Z"]);
		// A literal no comparison could read as a moment is no instant text.
		expect(() =>
			fx.lowerForm(
				lt(fx.field("dt"), ifExpr(n1, term(literal("nope")), now())),
			),
		).toThrow(/literal of another kind \('nope'\)/);
	});
});

describe("CSQL text holds no device lowering", () => {
	it("prints a date-and-time comparison in a query without the instant parse", () => {
		const doc = csqlFunctionFixture();
		const filter = doc.modules[doc.moduleOrder[0]].caseListConfig?.filter;
		if (filter === undefined) throw new Error("The CSQL fixture has a filter.");
		const ctx = csqlFixtureContext(doc);
		for (const predicate of [
			filter,
			lt(prop("patient", "last_seen"), datetimeLiteral("2026-01-02T04:30:00Z")),
		]) {
			const { wrapper } = emitCsql(predicate, ctx);
			expect(
				wireNodes(wrapper).filter(
					(node) => instantMicrosOperand(node) !== undefined,
				),
			).toEqual([]);
		}
	});
});
