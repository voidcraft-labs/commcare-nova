import { describe, expect, it } from "vitest";
import {
	between,
	coalesce,
	datetimeCoerce,
	eq,
	gt,
	gte,
	ifExpr,
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

// The checker and the on-device emitter read one classification of a
// comparison over dates and times (`instantOperand.ts`). Over every leaf
// class, operator and slot kind, the checker admits a comparison only when
// `toWire` prints it in every target a device evaluates; and where the type
// rules alone admit it (the same slot with no device target), the checker
// refuses it exactly when that print throws. The checker is stricter in one
// documented way: in form logic it refuses a branch of another known kind (a
// number, text, a choice) that the emitter would print as itself, reading as
// no moment (part 03 §3.2's correction); a record slot refuses that branch by
// its type rules already.

const fx = instantFixture({
	dt: "typed",
	copy: "text",
	d: "date",
	dtext: "date-text",
	stamp: "clock-lost",
	n: "int",
	u: "unknown",
});

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
] as const;

const formCase = (property: string): Expression =>
	term({ kind: "form-case", caseType: "visit", property });
const record = (property: string): Expression => term(prop("visit", property));

interface Slot {
	readonly name: string;
	readonly ctx: ExpressionContext;
	readonly targets: readonly WireTarget[];
	readonly lower: (expression: Expression, target: WireTarget) => WireExpr;
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
	return found;
}

const verdict = (errors: readonly CheckError[]) =>
	errors.map((error) =>
		error.reason === undefined ? error.code : `${error.code}:${error.reason}`,
	);

/** The slot as one no device evaluates: every type rule, no lowering. */
const offDevice = (ctx: ExpressionContext): ExpressionContext => ({
	...ctx,
	profile: { ...ctx.profile, targets: new Set() },
});

describe("the checker admits a comparison of moments exactly when a device can print it", () => {
	for (const slot of SLOTS)
		it(`agrees in ${slot.name}`, () => {
			const disagreements: string[] = [];
			const seen = { lowered: 0, refused: 0, stricter: 0 };
			const baseline = offDevice(slot.ctx);
			for (const { label, expression } of cases(slot)) {
				const errors = verdict(checkExpression(expression, slot.ctx).errors);
				const typeErrors = checkExpression(expression, baseline).errors;
				const thrown = slot.targets.flatMap((target) => {
					try {
						slot.lower(expression, target);
						return [];
					} catch (error) {
						return [`${target}: ${(error as Error).message}`];
					}
				});
				const printed = thrown.length === 0;
				if (errors.length === 0 && !printed)
					disagreements.push(`admitted, not printed: ${label}: ${thrown[0]}`);
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
