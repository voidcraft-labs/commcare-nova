// Postgres orders and equates stored date-and-time values by the instants
// they name, in every zone, over the operand and pair table Core's
// `InstantOrderingRuntimeTest` and Preview's lowering read. The table holds
// no expected value: as the native reader computes each verdict from
// `java.time`, this test computes it from each operand's instant, in integer
// microseconds.
//
// Not every row of the table can reach this boundary, and each exclusion is
// a property of the row, not of the result:
//
// - `control: "wall-clock"` rows compare `double(coalesce(x, ''))`, a number
//   of a temporal value, which no profile with a Postgres target admits.
// - The seven malformed spellings the device lowering reads as a number
//   (`lib/commcare/xpath/wire/instant.ts`: a space for `T`, an impossible calendar, a bare
//   trailing `+`, `-` or `.`, `T-4:30:00Z`, `04:30:00e5Z`) disagree by design:
//   Postgres reads no instant from them. None is a spelling Nova, HQ or a
//   device writes.
// - The nine-digit fraction is listed as malformed, yet both the lowering
//   and Postgres read it as an instant, so the table's "no instant" is not
//   its meaning here.
// - `now()` cannot be pinned to the table's fixed clock, so the rows of a
//   pair that reads `now` are moved by the transaction's own clock: every
//   operand of such a pair keeps its distance from the fixed clock.
//
// The readings change only `date_opened` and `last_modified`, never a
// custom property, so running the table under all three is an invariance
// check, not three meanings.
import { sql } from "kysely";
import { describe } from "vitest";
import {
	type InstantOperand,
	type InstantOperator,
	type InstantPair,
	instantFixedClock,
	instantOperators,
	instantOrderingPairs,
} from "@/lib/commcare/__tests__/instantOrderingTable";
import type { CaseType, Expression } from "@/lib/domain";
import {
	datetimeCoerce,
	eq,
	gt,
	gte,
	lt,
	lte,
	neq,
	now,
	prop,
	term,
} from "@/lib/domain/expression/builders";
import type { CaseReading } from "@/lib/domain/expression/temporalType";
import { proseText } from "@/lib/domain/prose";
import {
	compilePredicate,
	type PredicateCompileContext,
} from "../compilePredicate";
import { expect, makeCaseRow, test } from "./setup";

const APP = "app-pred-compiler";
const PROJECT = "owner-pred-compiler";
const TYPE = "pair";
const SCHEMAS = new Map<string, CaseType>([
	[
		TYPE,
		{
			name: TYPE,
			properties: [
				{ name: "l", label: proseText("Left"), data_type: "datetime" },
				{ name: "r", label: proseText("Right"), data_type: "datetime" },
				{ name: "ld", label: proseText("Left day"), data_type: "date" },
				{ name: "rd", label: proseText("Right day"), data_type: "date" },
				{ name: "shape", label: proseText("Shape"), data_type: "text" },
			],
		},
	],
]);

const LOWERING_NUMERIC_MALFORMED = new Set([
	"2026-01-02 04:30:00Z",
	"2026-13-45T99:99:99Z",
	"2026-01-02T04:30:00+",
	"2026-01-02T04:30:00-",
	"2026-01-02T04:30:00.",
	"2026-01-02T-4:30:00Z",
	"2026-01-02T04:30:00e5Z",
]);
const NINE_DIGIT_FRACTION = "2026-01-02T04:30:00.123456789Z";

/** Viewer zone and a session zone apart from it, so neither decides. */
const ZONES = [
	["UTC", "Pacific/Kiritimati"],
	["America/New_York", "Asia/Kolkata"],
	["Asia/Kolkata", "UTC"],
	["Pacific/Kiritimati", "America/New_York"],
] as const;
const READINGS: readonly CaseReading[] = ["casedb", "results", "search"];

const COMPARE: Record<
	InstantOperator,
	(left: Expression, right: Expression) => Expression
> = {
	"<": lt,
	"<=": lte,
	">": gt,
	">=": gte,
	"=": eq,
	"!=": neq,
};

function isExcluded(pair: InstantPair): boolean {
	if (pair.control === "wall-clock") return true;
	return [pair.left, pair.right].some(
		(operand) =>
			operand.held === "malformed" &&
			(LOWERING_NUMERIC_MALFORMED.has(operand.value) ||
				operand.value === NINE_DIGIT_FRACTION),
	);
}

/** Integer microseconds of a UTC ISO instant with 0 to 6 fraction digits. */
function micros(iso: string): bigint {
	const match = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/.exec(iso);
	if (match === null) throw new Error(`'${iso}' is no UTC instant.`);
	const seconds = BigInt(Date.parse(`${match[1]}Z`)) * BigInt(1_000);
	return seconds + BigInt((match[2] ?? "").padEnd(6, "0"));
}

/** `yyyy-MM-ddTHH:mm:ss.ffffffZ`. */
function utcText(value: bigint): string {
	const whole = new Date(Number(value / BigInt(1_000_000)) * 1_000)
		.toISOString()
		.slice(0, 19);
	const fraction = (value % BigInt(1_000_000)).toString().padStart(6, "0");
	return `${whole}.${fraction}Z`;
}

/** Core's datetime text written in a zone: `yyyy-MM-ddTHH:mm:ss.SSS±HH:MM`. */
function coreText(value: bigint, zone: string): string {
	const millis = Number(value / BigInt(1_000));
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		})
			.formatToParts(new Date(millis))
			.map((part) => [part.type, part.value]),
	);
	const wall = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour),
		Number(parts.minute),
		Number(parts.second),
	);
	const offset = Math.round((wall - Math.floor(millis / 1000) * 1000) / 60_000);
	const sign = offset < 0 ? "-" : "+";
	const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
	const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
	const ms = String(millis % 1000).padStart(3, "0");
	return `${new Date(wall).toISOString().slice(0, 19)}.${ms}${sign}${hours}:${minutes}`;
}

type Side = "left" | "right";
type SideKind = "datetime" | "date" | "date-coerced" | "now";

function sideKind(operand: InstantOperand): SideKind {
	if (operand.held === "now") return "now";
	if (operand.held === "date" || operand.held === "date-text")
		return operand.datetimeCoerce ? "date-coerced" : "date";
	return "datetime";
}

/** The operand as its runtime holds it: stored text and its instant (none
 *  for text that names no instant). `shift` moves a `now` pair onto the
 *  transaction's clock. */
function resolve(
	operand: InstantOperand,
	shift: bigint,
): { readonly text?: string; readonly instant?: bigint } {
	switch (operand.held) {
		case "datetime":
		case "now": {
			const instant = micros(operand.instant) + shift;
			return { text: utcText(instant), instant };
		}
		case "text": {
			const instant = micros(operand.instant) + shift;
			return {
				text: shift === BigInt(0) ? operand.value : utcText(instant),
				instant,
			};
		}
		case "core-text": {
			const instant = micros(operand.instant);
			return { text: coreText(instant, operand.writerZone), instant };
		}
		case "date":
		case "date-text":
			// A day orders as its UTC midnight; a coerced day is that instant.
			return {
				text: operand.value,
				instant: micros(`${operand.value}T00:00:00Z`),
			};
		case "malformed":
			return { text: operand.value };
	}
}

function verdict(
	operator: InstantOperator,
	left: bigint | undefined,
	right: bigint | undefined,
): boolean {
	// No instant on either side: no ordering holds, `=` is false and `!=`
	// is its negation, as the device lowering's NaN gives.
	if (left === undefined || right === undefined) return operator === "!=";
	switch (operator) {
		case "<":
			return left < right;
		case "<=":
			return left <= right;
		case ">":
			return left > right;
		case ">=":
			return left >= right;
		case "=":
			return left === right;
		case "!=":
			return left !== right;
	}
}

function operandExpression(kind: SideKind, side: Side): Expression {
	const name = side === "left" ? "l" : "r";
	switch (kind) {
		case "now":
			return now();
		case "datetime":
			return term(prop(TYPE, name));
		case "date":
			return term(prop(TYPE, `${name}d`));
		case "date-coerced":
			return datetimeCoerce(term(prop(TYPE, `${name}d`)));
	}
}

interface SeededPair {
	readonly id: string;
	readonly caseId: string;
	readonly shape: string;
	readonly left: SideKind;
	readonly right: SideKind;
	readonly expected: Readonly<Record<InstantOperator, boolean>>;
}

async function seedPairs(
	db: PredicateCompileContext["db"],
): Promise<SeededPair[]> {
	const { nowMicros } = await sql<{
		nowMicros: string;
	}>`select (extract(epoch from now()) * 1000000)::bigint::text as "nowMicros"`
		.execute(db)
		.then((result) => result.rows[0]);
	const shift = BigInt(nowMicros) - micros(instantFixedClock);
	const byPair = new Map<string, InstantPair[]>();
	for (const pair of instantOrderingPairs()) {
		if (isExcluded(pair)) continue;
		const key = `${pair.group}/${pair.left.id}/${pair.right.id}`;
		byPair.set(key, [...(byPair.get(key) ?? []), pair]);
	}
	const seeded: SeededPair[] = [];
	const rows = [...byPair.entries()].map(([key, pairs], index) => {
		const [{ left, right }] = pairs;
		const pairShift =
			left.held === "now" || right.held === "now" ? shift : BigInt(0);
		const l = resolve(left, pairShift);
		const r = resolve(right, pairShift);
		const leftKind = sideKind(left);
		const rightKind = sideKind(right);
		const shape = `${leftKind}|${rightKind}`;
		const caseId = `pair-${index}`;
		const expected = Object.fromEntries(
			instantOperators.map((operator) => [
				operator,
				verdict(operator, l.instant, r.instant),
			]),
		) as Record<InstantOperator, boolean>;
		if (pairs.length !== instantOperators.length)
			throw new Error(`Pair '${key}' does not carry all six operators.`);
		seeded.push({
			id: key,
			caseId,
			shape,
			left: leftKind,
			right: rightKind,
			expected,
		});
		const properties: Record<string, string> = { shape };
		const store = (kind: SideKind, side: Side, text: string | undefined) => {
			if (kind === "now" || text === undefined) return;
			const name = side === "left" ? "l" : "r";
			properties[kind === "datetime" ? name : `${name}d`] = text;
		};
		store(leftKind, "left", l.text);
		store(rightKind, "right", r.text);
		return makeCaseRow({
			case_id: caseId,
			case_type: TYPE,
			app_id: APP,
			project_id: PROJECT,
			properties: JSON.stringify(properties),
		});
	});
	for (let start = 0; start < rows.length; start += 500)
		await db
			.insertInto("cases")
			.values(rows.slice(start, start + 500))
			.execute();
	return seeded;
}

describe("instant ordering over the shared operand table", () => {
	test.for(ZONES)(
		"viewer %s, session %s: every pair orders and equates by its instants under every reading",
		// About 4,200 pairs, seeded once per zone, then 12 statements.
		{ timeout: 60_000 },
		async ([viewerZone, sessionZone], { db }) => {
			const seeded = await seedPairs(db);
			await sql`select set_config('TimeZone', ${sessionZone}, true)`.execute(
				db,
			);
			const shapes = new Map<string, SeededPair[]>();
			for (const pair of seeded)
				shapes.set(pair.shape, [...(shapes.get(pair.shape) ?? []), pair]);
			for (const reading of READINGS) {
				const ctx: PredicateCompileContext = {
					reading,
					db,
					appId: APP,
					projectId: PROJECT,
					anchorAlias: "c",
					currentCaseType: TYPE,
					caseTypeSchemas: SCHEMAS,
					bindings: { viewerTimeZone: viewerZone },
				};
				for (const [shape, pairs] of shapes) {
					const [{ left, right }] = pairs;
					const leftExpr = operandExpression(left, "left");
					const rightExpr = operandExpression(right, "right");
					// Each verdict as a WHERE clause decides it: unknown is false.
					const rows = await db
						.selectFrom("cases as c")
						.where("c.app_id", "=", APP)
						.where("c.project_id", "=", PROJECT)
						.where("c.case_type", "=", TYPE)
						.where(sql<boolean>`c.properties->>'shape' = ${shape}`)
						.select([
							"c.case_id",
							...instantOperators.map((operator, index) =>
								sql<boolean>`coalesce((${compilePredicate(
									COMPARE[operator](leftExpr, rightExpr),
									ctx,
								)}), false)`.as(`v${index}`),
							),
						])
						.execute();
					const actual = new Map(
						rows.map((row) => [
							row.case_id,
							Object.fromEntries(
								instantOperators.map((operator, index) => [
									operator,
									(row as Record<string, unknown>)[`v${index}`],
								]),
							),
						]),
					);
					const mismatches = pairs.flatMap((pair) =>
						instantOperators
							.filter(
								(operator) =>
									actual.get(pair.caseId)?.[operator] !==
									pair.expected[operator],
							)
							.map((operator) => `${pair.id} ${operator}`),
					);
					expect(mismatches, `${reading} ${shape}`).toEqual([]);
				}
			}
		},
	);
});
