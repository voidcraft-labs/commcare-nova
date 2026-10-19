import { describe, expect, it } from "vitest";
import {
	between,
	coalesce,
	dateLiteral,
	datetimeCoerce,
	eq,
	gt,
	gte,
	ifExpr,
	isBlank,
	isIn,
	literal,
	lt,
	lte,
	neq,
	now,
	prop,
	qualifiedLiteral,
	switchCase,
	switchExpr,
	term,
	today,
} from "@/lib/domain/expression/builders";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import {
	type CheckError,
	checkExpression,
} from "@/lib/domain/expression/typeChecker";
import type { Expression, Literal } from "@/lib/domain/expression/types";
import type { WireTarget } from "../fromExpression";
import type { WireExpr } from "../tree";
import { instantFixture } from "./instantFixture";
import { parsedLiteralTexts } from "./instantParse";

// The checker and the on-device emitter read one classification of a
// comparison over dates and times (`instantOperand.ts`). Over every leaf
// class (a literal branch among them), operator and slot kind, the checker
// admits a comparison, or a `datetime-coerce` printed as a value, only when
// `toWire` prints it in every target a device evaluates, and every literal an
// instant parse can read is printed in its own date, clock and offset; and
// where the type rules alone admit it (the same slot with no device target),
// the checker refuses it exactly when that print throws. A Search field's
// condition takes each case as the value its server comparison works out on a
// device first, so its print is the `_xpath_query` value's runtime segment.
// The checker is stricter in one documented way: in form logic it refuses a
// branch of another known kind (a number, text, a choice) that the emitter
// would print as itself, reading as no moment (part 03 §3.2's correction); a
// record slot refuses that branch by its type rules already.

const fx = instantFixture(
	{
		dt: "typed",
		copy: "text",
		d: "date",
		dtext: "date-text",
		stamp: "clock-lost",
		n: "int",
		u: "unknown",
	},
	{ search: true },
);
const search = fx.search;
if (search === undefined) throw new Error("The fixture has a Search field.");

const COMPARISONS = { eq, neq, lt, lte, gt, gte } as const;
type Operator = keyof typeof COMPARISONS;
const OPERATORS = Object.keys(COMPARISONS) as Operator[];

/** Every spelling a date-and-time literal admits, a date, and literals no
 * spelling reads. */
const SPELLINGS = [
	"2026-01-02T04:30:00Z",
	"2026-01-02T10:00:00+05:30",
	"2026-01-02 04:30:00z",
	"2026-01-01T23:30:00-0500",
	"2026-01-02T04:30:00.123Z",
	"2026-01-02T04:30:00.123456Z",
	"2026-01-02T04:30",
	"2026-01-02",
	"2026-02-30T10:00:00",
	"tomorrow",
	"",
	// The four-digit years at each end, in offsets whose UTC moment falls past
	// them, and an offset past 23 hours, which Core adds to the clock.
	"9999-12-31T23:59:59.999Z",
	"0000-01-01T00:00:00Z",
	"9999-12-31T23:00:00-05:00",
	"0000-01-01T00:30:00+01:00",
	"2026-01-03T04:30:00+24:00",
] as const;

const formCase = (property: string): Expression =>
	term({ kind: "form-case", caseType: "visit", property });
const record = (property: string): Expression => term(prop("visit", property));

interface Slot {
	readonly name: string;
	readonly ctx: ExpressionContext;
	readonly targets: readonly WireTarget[];
	readonly lower: (expression: Expression, target: WireTarget) => WireExpr;
	/** Where a case sits in the slot: itself, or a Search field's runtime
	 * value. */
	readonly place: (expression: Expression) => Expression;
	/** The slot spells `datetime-coerce` (a record slot), so a case also
	 * prints one as a value. */
	readonly coerces: boolean;
	readonly leaves: ReadonlyMap<string, Expression>;
	/** A literal as the slot spells it: form text is typed by its shape, a
	 * record literal by its `data_type`. */
	readonly literal: (value: string) => Literal;
	/** A wrapper giving a `switch` a value the slot accepts. */
	readonly switchValue: (expression: Expression) => Expression;
	/** A condition of the slot, and a subject with one case, for the
	 * composites' branches. */
	readonly condition: Expression;
	readonly subject: Expression;
	/** The checker refuses a branch of another known kind here, which the
	 * emitter prints as itself. */
	readonly stricter: boolean;
}

const formLeaves = new Map<string, Expression>([
	["typed", fx.field("dt")],
	["text", fx.field("copy")],
	["date", fx.field("d")],
	["date-text", fx.field("dtext")],
	["clock-lost", fx.field("stamp")],
	["int", fx.field("n")],
	["unknown", fx.field("u")],
	["now", now()],
	["today", today()],
	["case-datetime", formCase("seen")],
	["case-date", formCase("day")],
	["case-text", formCase("note")],
	["case-date_opened", formCase("date_opened")],
	["case-last_modified", formCase("last_modified")],
	["coerce-date", datetimeCoerce(fx.field("d"))],
	["coerce-date-text", datetimeCoerce(fx.field("dtext"))],
	["coerce-days", datetimeCoerce(fx.field("n"))],
	["coerce-text", datetimeCoerce(formCase("note"))],
	["coerce-today", datetimeCoerce(today())],
	["coerce-opened", datetimeCoerce(formCase("date_opened"))],
	...SPELLINGS.map(
		(value) => [`'${value}'`, term(literal(value))] as [string, Expression],
	),
	["coerce-'2026-01-02'", datetimeCoerce(term(literal("2026-01-02")))],
	["coerce-20455", datetimeCoerce(term(literal(20455)))],
]);

/** Literals a `datetime-coerce` reads, each spelling a date, a date and
 * time, text or no moment. */
const COERCED_LITERALS = new Map<string, Expression>([
	["date '2026-02-30'", term(dateLiteral("2026-02-30"))],
	["date '2026-01-02'", term(dateLiteral("2026-01-02"))],
	["'2026-02-30'", term(literal("2026-02-30"))],
	["'2026-01-02T04:30'", term(literal("2026-01-02T04:30"))],
	["'tomorrow'", term(literal("tomorrow"))],
	["''", term(literal(""))],
	["true", term(literal(true))],
	["20455", term(literal(20455))],
	...SPELLINGS.map(
		(value) =>
			[`datetime '${value}'`, term(qualifiedLiteral(value, "datetime"))] as [
				string,
				Expression,
			],
	),
]);

const recordLeaves = new Map<string, Expression>([
	["datetime", record("seen")],
	["datetime-2", record("due")],
	["date", record("day")],
	["int", record("visits")],
	["text", record("note")],
	["date_opened", record("date_opened")],
	["last_modified", record("last_modified")],
	["now", now()],
	["today", today()],
	["coerce-date", datetimeCoerce(record("day"))],
	["coerce-days", datetimeCoerce(record("visits"))],
	["coerce-text", datetimeCoerce(record("note"))],
	["coerce-today", datetimeCoerce(today())],
	["coerce-opened", datetimeCoerce(record("date_opened"))],
	...SPELLINGS.map(
		(value) =>
			[`datetime '${value}'`, term(qualifiedLiteral(value, "datetime"))] as [
				string,
				Expression,
			],
	),
	["''", term(literal(""))],
	[
		"coerce-'2026-01-02'",
		datetimeCoerce(term(qualifiedLiteral("2026-01-02", "date"))),
	],
	["coerce-20455", datetimeCoerce(term(literal(20455)))],
]);

const SLOTS: readonly Slot[] = [
	{
		name: "form logic",
		ctx: fx.form,
		targets: ["xform", "preview"],
		lower: (expression, target) => fx.lowerForm(expression, target),
		leaves: formLeaves,
		literal: (value) => literal(value),
		switchValue: (expression) => expression,
		condition: eq(fx.field("n"), term(literal(1))),
		subject: fx.field("n"),
		stricter: true,
		place: (expression) => expression,
		coerces: false,
	},
	{
		name: "a case list filter",
		ctx: fx.record,
		targets: ["suite", "hq-json", "preview"],
		lower: (expression, target) => fx.lowerRecord(expression, target),
		leaves: recordLeaves,
		literal: (value) => qualifiedLiteral(value, "datetime"),
		switchValue: (expression) => eq(expression, term(literal("a"))),
		condition: eq(record("visits"), term(literal(1))),
		subject: record("visits"),
		// A record branch of another kind is already `branch-values`.
		stricter: false,
		place: (expression) => expression,
		coerces: true,
	},
	{
		name: "a Search field's condition, in a value a device works out",
		ctx: search.ctx,
		targets: ["csql-runtime"],
		lower: (expression) => search.lower(expression),
		// One leaf of each class, since a CSQL print is the costlier one.
		leaves: new Map(
			[
				"datetime",
				"date",
				"int",
				"date_opened",
				"now",
				"today",
				"coerce-date",
				"coerce-days",
				"coerce-opened",
				"datetime '2026-01-02T10:00:00+05:30'",
				"datetime '2026-02-30T10:00:00'",
				"datetime '9999-12-31T23:00:00-05:00'",
				"''",
			].map((name) => {
				const leaf = recordLeaves.get(name);
				if (leaf === undefined) throw new Error(`No record leaf '${name}'.`);
				return [name, leaf] as const;
			}),
		),
		literal: (value) => qualifiedLiteral(value, "datetime"),
		switchValue: (expression) => eq(expression, term(literal("a"))),
		condition: eq(record("visits"), term(literal(1))),
		subject: record("visits"),
		stricter: false,
		// The server compares `note` with the value an `if` chooses, and the
		// `if` is no value the server works out itself.
		place: (expression) =>
			eq(
				record("note"),
				ifExpr(expression, term(literal("a")), term(literal("b"))),
			),
		coerces: true,
	},
];

/** The refusals the checker makes where the emitter prints the operand as
 * itself: a branch of another known kind compared as a moment. */
const STRICTER = new Set([
	"incompatible-values:datetime-ordering",
	"incompatible-values:datetime-equality",
]);

/** Operands built from the leaves: each leaf, and `if`, `coalesce` and
 * `switch` composites pairing each leaf with another. */
function operands(slot: Slot): ReadonlyMap<string, Expression> {
	const entries = [...slot.leaves];
	const all = new Map(entries);
	entries.forEach(([name, value], index) => {
		const [otherName, other] = entries[(index * 7 + 3) % entries.length] ?? [
			name,
			value,
		];
		all.set(`if(${name}, ${otherName})`, ifExpr(slot.condition, value, other));
		all.set(`coalesce(${name}, ${otherName})`, coalesce(value, other));
		all.set(
			`switch(${name}, ${otherName})`,
			switchExpr(slot.subject, [switchCase(literal(1), value)], other),
		);
	});
	// Each spelling as a literal branch beside a moment.
	const moment = slot.leaves.get("now") ?? now();
	for (const value of SPELLINGS) {
		const branch = term(slot.literal(value));
		all.set(`if('${value}', now)`, ifExpr(slot.condition, branch, moment));
		all.set(`coalesce(now, '${value}')`, coalesce(moment, branch));
	}
	return all;
}

interface Case {
	readonly label: string;
	readonly expression: Expression;
}

function cases(slot: Slot): readonly Case[] {
	const found: Case[] = [];
	const leafEntries = [...slot.leaves];
	for (const [leftName, left] of operands(slot))
		for (const [rightName, right] of leafEntries)
			for (const operator of OPERATORS)
				found.push({
					label: `${leftName} ${operator} ${rightName}`,
					expression: COMPARISONS[operator](left, right),
				});
	for (const [leftName, left] of leafEntries) {
		for (const value of SPELLINGS) {
			found.push({
				label: `${leftName} in '${value}'`,
				expression: isIn(left, slot.literal(value), slot.literal(SPELLINGS[0])),
			});
			found.push({
				label: `switch ${leftName} on '${value}'`,
				expression: slot.switchValue(
					switchExpr(
						left,
						[switchCase(slot.literal(value), term(literal("a")))],
						term(literal("b")),
					),
				),
			});
		}
		for (const [lowerName, lower] of leafEntries)
			found.push({
				label: `${leftName} between ${lowerName} and now`,
				expression: between(left, { lower, upper: now() }),
			});
	}
	// A `datetime-coerce` printed as a value, of each operand and literal.
	if (slot.coerces)
		for (const [name, value] of [...operands(slot), ...COERCED_LITERALS])
			found.push({
				label: `is-blank(datetime-coerce(${name}))`,
				expression: isBlank(datetimeCoerce(value)),
			});
	return found.map(({ label, expression }) => ({
		label,
		expression: slot.place(expression),
	}));
}

/** A literal's text as `instantOperand.ts::literalInstantText` prints it:
 * its own date and clock with seconds and a fraction, then `Z` or `±HH:MM`. */
const CANONICAL =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,}(?:Z|[+-]\d{2}:\d{2})$/;

const verdict = (errors: readonly CheckError[]) =>
	errors.map((error) =>
		error.reason === undefined ? error.code : `${error.code}:${error.reason}`,
	);

/** The slot as one no device evaluates: every type rule, no lowering. */
const offDevice = (ctx: ExpressionContext): ExpressionContext => ({
	...ctx,
	profile: { ...ctx.profile, targets: new Set() },
});

// Tens of thousands of comparisons per slot, each checked and printed in
// every device target: seconds of work, so each slot carries its own budget.
describe("the checker admits a comparison of moments exactly when a device can print it", {
	timeout: 30_000,
}, () => {
	for (const slot of SLOTS)
		it(`agrees in ${slot.name}`, () => {
			const disagreements: string[] = [];
			const seen = { lowered: 0, refused: 0, stricter: 0 };
			const baseline = offDevice(slot.ctx);
			for (const { label, expression } of cases(slot)) {
				const errors = verdict(checkExpression(expression, slot.ctx).errors);
				const typeErrors = checkExpression(expression, baseline).errors;
				const raw: string[] = [];
				const thrown = slot.targets.flatMap((target) => {
					try {
						const wire = slot.lower(expression, target);
						raw.push(
							...parsedLiteralTexts(wire).filter(
								(text) => text !== "" && !CANONICAL.test(text),
							),
						);
						return [];
					} catch (error) {
						return [`${target}: ${(error as Error).message}`];
					}
				});
				const printed = thrown.length === 0;
				if (errors.length === 0 && !printed)
					disagreements.push(`admitted, not printed: ${label}: ${thrown[0]}`);
				if (errors.length === 0 && raw.length > 0)
					disagreements.push(
						`admitted, a literal parsed as written: ${label}: '${raw[0]}'`,
					);
				if (typeErrors.length > 0 && errors.length === 0)
					disagreements.push(`admitted on a device only: ${label}`);
				// Where the type rules admit it, the device verdict is the print's.
				if (typeErrors.length > 0) continue;
				if (errors.length === 0) seen.lowered++;
				else if (!printed) seen.refused++;
				else if (errors.every((error) => STRICTER.has(error))) seen.stricter++;
				else
					disagreements.push(
						`printed, refused: ${label}: ${errors.join(", ")}`,
					);
			}
			expect(disagreements).toEqual([]);
			expect(seen.lowered).toBeGreaterThan(0);
			expect(seen.refused).toBeGreaterThan(0);
			if (slot.stricter) expect(seen.stricter).toBeGreaterThan(0);
		});
});
