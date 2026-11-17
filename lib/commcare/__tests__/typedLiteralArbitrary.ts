/**
 * fast-check arbitrary over the workflow corpus (`suiteDocArbitrary`) whose
 * documents also hold a typed date or date-and-time literal (or a
 * `datetime-coerce` of a literal, which prints the text the typed literal of
 * that text prints) at a position of a record slot a device reads: a
 * function's argument (`format-date`'s and `date-add`'s date, the value of
 * `date()` and `datetime()`), a comparison's operand (against a property, the
 * clock, another literal or a branch node), a `between`'s bounds, an `in`'s
 * values, a `switch`'s cases and results, an `if`'s and a `coalesce`'s
 * branches at any depth, a `concat`'s parts, the condition of a row read of
 * a parent case, and a slot's whole value. The slots are a calculated
 * column, a case list's filter where the menu has no search, a form's display
 * condition where every form of the menu loads its case, a menu's display
 * condition, and the starting value of a date Search field.
 *
 * Every module's case type declares the workflow corpus's property pool:
 * `visit_date` a date, `last_seen` a date and time and `full_name` text. Each
 * draw takes one shape of each family and places it in every slot of its
 * family the gate admits beside the others; a document the gate refuses
 * after a placement is drawn without it, so the corpus stays admitted
 * documents. The shape tables are exported so a test can read every shape in
 * one fixed document and name each position that does not read back.
 */

import * as fc from "fast-check";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { calculatedColumn, simpleSearchInputDef } from "@/lib/domain";
import {
	ancestorPath,
	between,
	coalesce,
	concat,
	dateAdd,
	dateCoerce,
	datetimeCoerce,
	type Expression,
	eq,
	exists,
	formatDate,
	gt,
	ifExpr,
	isBlank,
	isIn,
	type Literal,
	literal,
	lt,
	neq,
	now,
	prop,
	relationStep,
	switchCase,
	switchExpr,
	term,
	today,
} from "@/lib/domain/expression";
import type { Uuid } from "@/lib/domain/uuid";
import { suiteDocArbitrary } from "./suiteDocArbitrary";

/** The literals a draw's shapes hold: two dates and two dates and times. */
export interface TypedLiterals {
	readonly day: string;
	readonly otherDay: string;
	readonly moment: string;
	readonly otherMoment: string;
}

/** What a shape is built over: the menu's case type, the type its cases
 *  are children of where there is one, and the literals of the draw. */
export interface ShapeScope {
	readonly caseType: string;
	readonly parentType?: string;
	readonly literals: TypedLiterals;
}

/** One position: its name, and its tree over a scope, or none where the
 *  scope cannot hold it (no parent type to read). */
export interface TypedLiteralShape {
	readonly name: string;
	readonly build: (scope: ShapeScope) => Expression | undefined;
}

const dayLiteral = (value: string): Literal => ({
	kind: "literal",
	value,
	data_type: "date",
});
const D = (scope: ShapeScope) => term(dayLiteral(scope.literals.day));
const D2 = (scope: ShapeScope) => term(dayLiteral(scope.literals.otherDay));
const T = (scope: ShapeScope) =>
	term({
		kind: "literal",
		value: scope.literals.moment,
		data_type: "datetime",
	});
const T2 = (scope: ShapeScope) =>
	term({
		kind: "literal",
		value: scope.literals.otherMoment,
		data_type: "datetime",
	});
const C = (scope: ShapeScope) =>
	datetimeCoerce(term(literal(scope.literals.day)));
const DAY = (scope: ShapeScope) => term(prop(scope.caseType, "visit_date"));
const SEEN = (scope: ShapeScope) => term(prop(scope.caseType, "last_seen"));
const NAME = (scope: ShapeScope) => term(prop(scope.caseType, "full_name"));
const ONE = term(literal(1));
const YEAR = "%Y";
const text = (value: string) => term(literal(value));

const shape = (
	name: string,
	build: (scope: ShapeScope) => Expression | undefined,
): TypedLiteralShape => ({ name, build });

/** Values a calculated column holds. */
export const VALUE_SHAPES: readonly TypedLiteralShape[] = [
	shape("T", T),
	shape("D", D),
	shape("datetime-coerce(day)", C),
	shape("format-date(T)", (s) => formatDate(T(s), YEAR)),
	shape("format-date(D)", (s) => formatDate(D(s), YEAR)),
	shape("format-date(datetime-coerce(day))", (s) => formatDate(C(s), YEAR)),
	shape("date-add(D)", (s) => dateAdd(D(s), "days", ONE)),
	shape("date-add(coalesce(D, D2))", (s) =>
		dateAdd(coalesce(D(s), D2(s)), "days", ONE),
	),
	shape("date-add(if(blank(full_name), D, D2))", (s) =>
		dateAdd(ifExpr(isBlank(NAME(s)), D(s), D2(s)), "days", ONE),
	),
	shape("format-date(coalesce(T, T2))", (s) =>
		formatDate(coalesce(T(s), T2(s)), YEAR),
	),
	shape("format-date(date-add(D))", (s) =>
		formatDate(dateAdd(D(s), "days", ONE), YEAR),
	),
	shape("coalesce(D, D2)", (s) => coalesce(D(s), D2(s))),
	shape("coalesce(coalesce(D, D2), D)", (s) =>
		coalesce(coalesce(D(s), D2(s)), D(s)),
	),
	shape("if(blank(full_name), T, T2)", (s) =>
		ifExpr(isBlank(NAME(s)), T(s), T2(s)),
	),
	shape("switch(full_name, 'a': D, D2)", (s) =>
		switchExpr(NAME(s), [switchCase(literal("a"), D(s))], D2(s)),
	),
	shape("coalesce(date-add(D), D2)", (s) =>
		coalesce(dateAdd(D(s), "days", ONE), D2(s)),
	),
	shape("coalesce(last_seen, T)", (s) => coalesce(SEEN(s), T(s))),
	shape("coalesce(visit_date, D)", (s) => coalesce(DAY(s), D(s))),
	shape("concat(D, 'x')", (s) => concat(D(s), text("x"))),
	shape("concat(format-date(D))", (s) => concat(formatDate(D(s), YEAR))),
	shape("date-coerce(D)", (s) => dateCoerce(D(s))),
	shape("datetime-coerce(T)", (s) => datetimeCoerce(T(s))),
	shape("datetime-coerce(D)", (s) => datetimeCoerce(D(s))),
];

/** Conditions that read the menu's case: a case list's filter and a form's
 *  display condition. */
export const CONDITION_SHAPES: readonly TypedLiteralShape[] = [
	shape("T > last_seen", (s) => gt(T(s), SEEN(s))),
	shape("last_seen < T", (s) => lt(SEEN(s), T(s))),
	shape("last_seen = T", (s) => eq(SEEN(s), T(s))),
	shape("T != last_seen", (s) => neq(T(s), SEEN(s))),
	shape("D > visit_date", (s) => gt(D(s), DAY(s))),
	shape("visit_date between D and D2", (s) =>
		between(DAY(s), { lower: D(s), upper: D2(s) }),
	),
	shape("visit_date in (D, D2)", (s) =>
		isIn(DAY(s), dayLiteral(s.literals.day), dayLiteral(s.literals.otherDay)),
	),
	shape("switch(visit_date, D: 'a', 'b') = 'a'", (s) =>
		eq(
			switchExpr(
				DAY(s),
				[switchCase(dayLiteral(s.literals.day), text("a"))],
				text("b"),
			),
			text("a"),
		),
	),
	shape("coalesce(D, D2) > visit_date", (s) =>
		gt(coalesce(D(s), D2(s)), DAY(s)),
	),
	shape("date-add(D) > visit_date", (s) =>
		gt(dateAdd(D(s), "days", ONE), DAY(s)),
	),
	shape("visit_date > date-add(D)", (s) =>
		gt(DAY(s), dateAdd(D(s), "days", ONE)),
	),
	shape("if(blank(full_name), D, visit_date) > today()", (s) =>
		gt(ifExpr(isBlank(NAME(s)), D(s), DAY(s)), today()),
	),
	shape("datetime-coerce(D) > last_seen", (s) =>
		gt(datetimeCoerce(D(s)), SEEN(s)),
	),
	shape("date_opened > datetime-coerce(D)", (s) =>
		gt(term(prop(s.caseType, "date_opened")), datetimeCoerce(D(s))),
	),
	shape("date_opened > datetime-coerce(day)", (s) =>
		gt(term(prop(s.caseType, "date_opened")), C(s)),
	),
	shape("T > coalesce(last_seen, now())", (s) =>
		gt(T(s), coalesce(SEEN(s), now())),
	),
	shape("coalesce(D, D2) = coalesce(visit_date, today())", (s) =>
		eq(coalesce(D(s), D2(s)), coalesce(DAY(s), today())),
	),
	shape("the parent's visit_date > D", (s) =>
		s.parentType === undefined
			? undefined
			: exists(
					ancestorPath(relationStep("parent")),
					gt(term(prop(s.parentType, "visit_date")), D(s)),
				),
	),
];

/** Conditions that read no case: every slot of the condition families, a
 *  menu's display condition too. */
export const GLOBAL_CONDITION_SHAPES: readonly TypedLiteralShape[] = [
	shape("D > today()", (s) => gt(D(s), today())),
	shape("T > now()", (s) => gt(T(s), now())),
	shape("D = today()", (s) => eq(D(s), today())),
	shape("format-date(T) = '2026'", (s) =>
		eq(formatDate(T(s), YEAR), text("2026")),
	),
	shape("format-date(D) = '2026'", (s) =>
		eq(formatDate(D(s), YEAR), text("2026")),
	),
	shape("format-date(coalesce(T, T2)) = '2026'", (s) =>
		eq(formatDate(coalesce(T(s), T2(s)), YEAR), text("2026")),
	),
	shape("concat(D) = 'x'", (s) => eq(concat(D(s)), text("x"))),
	shape("date-add(coalesce(D, D2)) > today()", (s) =>
		gt(dateAdd(coalesce(D(s), D2(s)), "days", ONE), today()),
	),
	shape("coalesce(D, D2) > today()", (s) => gt(coalesce(D(s), D2(s)), today())),
	shape("date-add(D) > today()", (s) =>
		gt(dateAdd(D(s), "days", ONE), today()),
	),
	shape("T = T2", (s) => eq(T(s), T2(s))),
	shape("T > T2", (s) => gt(T(s), T2(s))),
	shape("D > D2", (s) => gt(D(s), D2(s))),
];

/** Starting values of a date Search field, which reads no case. */
export const DATE_DEFAULT_SHAPES: readonly TypedLiteralShape[] = [
	shape("D", D),
	shape("coalesce(D, D2)", (s) => coalesce(D(s), D2(s))),
	shape("coalesce(today(), D)", (s) => coalesce(today(), D(s))),
	shape("date-add(D)", (s) => dateAdd(D(s), "days", ONE)),
	shape("date-add(coalesce(D, D2))", (s) =>
		dateAdd(coalesce(D(s), D2(s)), "days", ONE),
	),
	shape("if(today() > D, D, D2)", (s) =>
		ifExpr(gt(today(), D(s)), D(s), D2(s)),
	),
	shape("date-coerce(D)", (s) => dateCoerce(D(s))),
];

/** The literals a draw holds: dates in two years, and dates and times with
 *  and without an offset and a fraction. */
const literalsArbitrary: fc.Arbitrary<TypedLiterals> = fc.record({
	day: fc.constantFrom("2026-01-01", "2025-12-31"),
	otherDay: fc.constantFrom("2026-02-01", "2024-02-29"),
	moment: fc.constantFrom("2026-01-01T00:00:00Z", "2025-12-31T23:59:59.5Z"),
	otherMoment: fc.constantFrom(
		"2026-02-01T10:00:00+01:00",
		"2026-03-01T08:30:00-05:30",
	),
});

/** The shape of each family one draw places. */
interface Draw {
	readonly value: TypedLiteralShape;
	readonly condition: TypedLiteralShape;
	readonly global: TypedLiteralShape;
	readonly dateDefault: TypedLiteralShape;
	readonly literals: TypedLiterals;
}

/** The name of the Search field a draw adds for its starting value. */
const DEFAULT_INPUT_NAME = "nova_starting_day";

/** Every placement of a draw in `doc`: each slot a family can stand in. */
function placements(
	doc: BlueprintDoc,
	draw: Draw,
): ((draft: BlueprintDoc) => void)[] {
	const out: ((draft: BlueprintDoc) => void)[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		const caseType = module?.caseType;
		if (module === undefined || caseType === undefined) continue;
		const parentType = doc.caseTypes?.find(
			(type) => type.name === caseType,
		)?.parent_type;
		const scope: ShapeScope = {
			caseType,
			literals: draw.literals,
			...(parentType === undefined ? {} : { parentType }),
		};
		const condition = draw.condition.build(scope) ?? draw.global.build(scope);
		const global = draw.global.build(scope);
		const value = draw.value.build(scope);
		const dateDefault = draw.dateDefault.build(scope);
		if (
			condition !== undefined &&
			module.caseListConfig !== undefined &&
			module.caseSearchConfig === undefined
		)
			out.push((draft) => {
				const config = draft.modules[moduleUuid]?.caseListConfig;
				if (config !== undefined) config.filter = condition;
			});
		const forms = doc.formOrder[moduleUuid] ?? [];
		if (
			condition !== undefined &&
			forms.length > 0 &&
			forms.every((formUuid) => {
				const type = doc.forms[formUuid]?.type;
				return type === "followup" || type === "close";
			})
		)
			out.push((draft) => {
				const form = draft.forms[forms[0] as Uuid];
				if (form !== undefined) form.displayCondition = condition;
			});
		if (global !== undefined)
			out.push((draft) => {
				const target = draft.modules[moduleUuid];
				if (target !== undefined) target.displayCondition = global;
			});
		if (value !== undefined && module.caseListConfig !== undefined)
			out.push((draft) => {
				const config = draft.modules[moduleUuid]?.caseListConfig;
				if (config === undefined) return;
				const column = calculatedColumn(
					`${moduleUuid.slice(0, -4)}beef` as Uuid,
					"Typed",
					value,
				);
				config.columns.push(column);
				config.listColumnOrder.push(column.uuid);
				config.detailColumnOrder.push(column.uuid);
			});
		if (
			dateDefault !== undefined &&
			module.caseListConfig !== undefined &&
			module.caseSearchConfig !== undefined
		)
			out.push((draft) => {
				const config = draft.modules[moduleUuid]?.caseListConfig;
				if (config === undefined) return;
				config.searchInputs.push(
					simpleSearchInputDef(
						`${moduleUuid.slice(0, -4)}dade` as Uuid,
						DEFAULT_INPUT_NAME,
						"Starting day",
						"date",
						"visit_date",
						{ default: dateDefault },
					),
				);
			});
	}
	return out;
}

/** `doc`, a fresh copy, with `places` applied and its derived reference
 *  index left to be built again. */
function placed(
	doc: BlueprintDoc,
	places: readonly ((draft: BlueprintDoc) => void)[],
): BlueprintDoc {
	const { refIndex: _derived, ...persisted } = doc;
	const next = structuredClone(persisted) as BlueprintDoc;
	for (const place of places) place(next);
	return next;
}

/** `doc` with the draw in each slot it can hold it: every placement at once
 *  where the gate admits that, else each placement in turn that the gate
 *  admits beside those kept before it. */
function withDraw(doc: BlueprintDoc, draw: Draw): BlueprintDoc {
	const admitted = (next: BlueprintDoc) =>
		runValidation(next, LOOKUP_CONTEXT_UNAVAILABLE).length === 0;
	const all = placements(doc, draw);
	const whole = placed(doc, all);
	if (admitted(whole)) return whole;
	const kept: ((draft: BlueprintDoc) => void)[] = [];
	for (const place of all)
		if (admitted(placed(doc, [...kept, place]))) kept.push(place);
	return placed(doc, kept);
}

export const typedLiteralDocArbitrary: fc.Arbitrary<BlueprintDoc> = fc
	.tuple(
		suiteDocArbitrary,
		fc.record({
			value: fc.constantFrom(...VALUE_SHAPES),
			condition: fc.constantFrom(
				...CONDITION_SHAPES,
				...GLOBAL_CONDITION_SHAPES,
			),
			global: fc.constantFrom(...GLOBAL_CONDITION_SHAPES),
			dateDefault: fc.constantFrom(...DATE_DEFAULT_SHAPES),
			literals: literalsArbitrary,
		}),
	)
	.map(([doc, draw]) => withDraw(doc, draw));
