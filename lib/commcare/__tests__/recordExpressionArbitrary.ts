/**
 * fast-check arbitrary over the workflow corpus (`suiteDocArbitrary`) whose
 * every record slot holds an expression drawn from the whole record rule set:
 * every expression kind, every comparison, arithmetic operator, interval,
 * match mode, quantifier and date preset the domain names, each argument
 * drawn from every kind of value the slot can read (a case property of each
 * type, a read of the parent or a child case, a session, worker or Search
 * value, a literal of each type, a nested call or branch), to depth three.
 *
 * The slots are the ones a document holds whose slot profile
 * (`slotContext`) is of the record rule set (`drawnSlot`): a menu's and a
 * form's display condition, a case list's filter and calculated columns, the
 * Search button's condition, the excluded owners, each Search field's
 * starting value, condition, requirement and validation, a hidden Search
 * value, and each value, condition, name, owner and target of a form's case
 * changes. A draw lists each menu of a child case type after the case of a
 * menu of its parent type where the gate admits that route
 * (`withParentSelections`), so a slot may read the case chosen above, adds
 * the slots a workflow document leaves out (a calculated column, both display
 * conditions, the Search button's condition, a starting value on each
 * simple Search field) and declares a list of choices, a location and a time
 * of day beside the corpus's property pool, then puts in each slot the first
 * drawn expression the slot's checker admits, and keeps the document only
 * where the commit gate admits it whole, dropping each placement it refuses.
 *
 * Expressions are drawn over placeholders (`@@self@@` for the menu's case
 * type, `@@input0@@` for its first Search field, and so on) and bound to each
 * slot's own document, so one drawn tree is tried in every slot and shrinks
 * as a tree. The kinds are a table keyed by `Expression["kind"]`, so a kind
 * the domain adds fails to compile here until it has a builder, and the
 * operator lists are the domain's own constants, so one added there is drawn
 * at once. `RECORD_KIND_COVERAGE` lists the kinds no record slot of this
 * corpus admits, each with its reason; the coverage test
 * (`recordExpressionArbitrary.test.ts`) holds every other kind and choice to
 * being drawn.
 */

import * as fc from "fast-check";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { calculatedColumn } from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import type { SlotContextRef } from "@/lib/domain/expression";
import {
	ARITH_OPS,
	CALL_FUNCTIONS,
	type COMPARISON_KINDS,
	checkExpression,
	DATE_ADD_INTERVALS,
	type Expression,
	FORMAT_DATE_PRESETS,
	type Literal,
	MATCH_MODES,
	MULTI_SELECT_QUANTIFIERS,
	type RelationPath,
	SESSION_CONTEXT_FIELDS,
	slotContext,
	type Term,
} from "@/lib/domain/expression";
import { DISTANCE_UNITS } from "@/lib/domain/expression/distance";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
import { FUNCTION_REGISTRY } from "@/lib/domain/expressionFunctions";
import { proseText } from "@/lib/domain/prose";
import {
	expressionSlotKey,
	expressionSlotValues,
	rewriteExpressionSlotValues,
} from "@/lib/domain/referenceSlots";
import { BUILT_IN_USER_PROPERTY_SLUGS } from "@/lib/domain/users";
import type { Uuid } from "@/lib/domain/uuid";
import { suiteDocArbitrary } from "./suiteDocArbitrary";

// ── Placeholders ──────────────────────────────────────────────────

/** The tokens a drawn tree holds, bound per slot. */
const SELF = "@@self@@";
const PARENT = "@@parent@@";
const CHILD = "@@child@@";
const CHOSEN_MODULE = "@@chosen@@" as Uuid;
const CHOSEN_TYPE = "@@chosentype@@";
const OWN_MODULE = "@@module@@" as Uuid;
const USER_PROPERTY = "@@userprop@@" as Uuid;
const FIELD = "@@field@@" as Uuid;
const OPERATION = "@@op@@" as Uuid;
const TABLE = "@@table@@";
const COLUMN = "@@column@@";
const inputToken = (index: number) => `@@input${index}@@` as Uuid;
/** The Search field whose own slot the tree stands in. */
const OWN_INPUT = "@@owninput@@" as Uuid;
const INPUT_TOKENS = [...[0, 1, 2].map(inputToken), OWN_INPUT];

/** The case a tree's property reads stand on: the menu's, its parent's, or a
 *  child's. */
export type Scope = "self" | "parent" | "child";
const SCOPE_TYPE: Record<Scope, string> = {
	self: SELF,
	parent: PARENT,
	child: CHILD,
};

// ── Requests ──────────────────────────────────────────────────────

/** The types a drawn value gives. */
export const VALUE_TYPES = [
	"text",
	"int",
	"decimal",
	"date",
	"datetime",
	"single_select",
	"multi_select",
	"geopoint",
	"time",
] as const;
export type ValueType = (typeof VALUE_TYPES)[number];
const ORDERED: readonly ValueType[] = ["int", "decimal", "date", "datetime"];
/** The types a value of no expected type is drawn from. */
const ANY_TYPES: readonly ValueType[] = [
	"text",
	"int",
	"decimal",
	"date",
	"datetime",
	"single_select",
];

export type Request =
	| { readonly position: "condition" }
	| { readonly position: "value"; readonly type: ValueType | "any" };
const CONDITION: Request = { position: "condition" };
const value = (type: ValueType | "any"): Request => ({
	position: "value",
	type,
});

// ── Leaves ────────────────────────────────────────────────────────

/** The properties every case type of a draw declares, by type: the workflow
 *  corpus's pool and the three a draw adds. */
const PROPERTIES: Readonly<Record<ValueType, readonly string[]>> = {
	text: ["full_name", "phone_number"],
	int: ["age"],
	decimal: ["weight"],
	date: ["visit_date"],
	datetime: ["last_seen"],
	single_select: ["status_code"],
	multi_select: ["tags"],
	geopoint: ["home"],
	time: ["visit_time"],
};
/** The properties a draw adds to every case type. */
const ADDED_PROPERTIES = [
	{ name: "tags", data_type: "multi_select" },
	{ name: "home", data_type: "geopoint" },
	{ name: "visit_time", data_type: "time" },
] as const;
/** CommCare's standard properties, by the type they read as. */
const STANDARD: Readonly<Partial<Record<ValueType, readonly string[]>>> = {
	text: ["case_name", "case_id", "owner_id", "external_id", "status"],
	datetime: ["date_opened", "last_modified"],
};

const untyped = (v: string | number | boolean | null): Literal => ({
	kind: "literal",
	value: v,
});
const typed = (v: string, data_type: ValueType): Literal => ({
	kind: "literal",
	value: v,
	data_type,
});

/** Literals of each type, typed and spelled as text alike. */
const LITERALS: Readonly<Record<ValueType, readonly Literal[]>> = {
	text: [
		untyped("x"),
		untyped(""),
		untyped("2026"),
		untyped("a b"),
		untyped("it's"),
		untyped("open"),
		untyped("2026-01-01"),
		untyped("2026-01-01T00:00:00Z"),
		untyped(true),
		untyped(null),
	],
	int: [untyped(0), untyped(3), untyped(-2)],
	decimal: [untyped(1.5), untyped(0.25)],
	date: [typed("2026-01-01", "date"), typed("2024-02-29", "date")],
	datetime: [
		typed("2026-01-01T00:00:00Z", "datetime"),
		typed("2025-12-31T23:59:59.5Z", "datetime"),
		typed("2026-02-01T10:00:00+01:00", "datetime"),
	],
	single_select: [untyped("a"), untyped("b")],
	multi_select: [untyped("a"), untyped("a b")],
	geopoint: [untyped("1.5 2.5 0 0")],
	time: [typed("10:30", "time")],
};

const term = (t: Term): Expression => ({ kind: "term", term: t });

/** The relation paths from a scope and the scope each reaches. */
function relations(
	scope: Scope,
): readonly { readonly via: RelationPath; readonly to: Scope }[] {
	if (scope !== "self") return [];
	return [
		{
			via: { kind: "ancestor", via: [{ identifier: "parent" }] },
			to: "parent",
		},
		{
			via: {
				kind: "ancestor",
				via: [{ identifier: "parent", throughCaseType: PARENT }],
			},
			to: "parent",
		},
		{
			via: { kind: "subcase", identifier: "parent", ofCaseType: CHILD },
			to: "child",
		},
		{
			via: { kind: "any-relation", identifier: "parent", ofCaseType: PARENT },
			to: "parent",
		},
	];
}

/** Every leaf that gives `type` in `scope`. */
export function leaves(type: ValueType, scope: Scope): Expression[] {
	const out: Expression[] = [];
	const caseType = SCOPE_TYPE[scope];
	for (const property of PROPERTIES[type])
		out.push(term({ kind: "prop", caseType, property }));
	for (const property of STANDARD[type] ?? [])
		out.push(term({ kind: "prop", property }));
	for (const { via, to } of relations(scope))
		for (const property of PROPERTIES[type])
			out.push(term({ kind: "prop", caseType: SCOPE_TYPE[to], property, via }));
	for (const literal of LITERALS[type]) out.push(term(literal));
	if (type === "date") out.push({ kind: "today" });
	if (type === "datetime") out.push({ kind: "now" });
	if (type === "text") {
		for (const field of SESSION_CONTEXT_FIELDS)
			if (field !== "drift" && field !== "window_width")
				out.push(term({ kind: "session-context", field }));
		for (const field of BUILT_IN_USER_PROPERTY_SLUGS)
			out.push(term({ kind: "session-user", field }));
		out.push(
			term({ kind: "session-user-property", userPropertyUuid: USER_PROPERTY }),
			term({
				kind: "session-datum",
				datum: { kind: "selected-case", module: OWN_MODULE },
			}),
			term({
				kind: "session-datum",
				datum: { kind: "selected-case", module: CHOSEN_MODULE },
			}),
		);
		for (const token of INPUT_TOKENS)
			out.push(term({ kind: "input", searchInputUuid: token }));
	}
	if (type === "int")
		for (const field of SESSION_CONTEXT_FIELDS)
			if (field === "drift" || field === "window_width")
				out.push(term({ kind: "session-context", field }));
	return out;
}

// ── Kind builders ─────────────────────────────────────────────────

/** Draws a sub-expression for a request, one level down, in a scope. */
type Sub = (
	request: Request,
	scope?: Scope,
) => fc.Arbitrary<Expression> | undefined;

/** A kind's builder: the arbitrary of trees rooted at that kind that answer
 *  `request` in `scope`, or undefined where the kind gives no such value. */
type Builder = (
	request: Request,
	sub: Sub,
	scope: Scope,
) => fc.Arbitrary<Expression> | undefined;

const isCondition = (request: Request) => request.position === "condition";
const typeOf = (request: Request): ValueType | "any" | undefined =>
	request.position === "value" ? request.type : undefined;
const gives = (request: Request, ...types: ValueType[]): boolean => {
	const type = typeOf(request);
	return type !== undefined && (type === "any" || types.includes(type));
};
/** The types a value request asks for. */
const typesOf = (request: Request): readonly ValueType[] => {
	const type = typeOf(request);
	return type === undefined ? [] : type === "any" ? ANY_TYPES : [type];
};

/** `arbs` with the undefined ones left out, as one arbitrary, or undefined
 *  where none is left. */
function oneOf(
	...arbs: (fc.Arbitrary<Expression> | undefined)[]
): fc.Arbitrary<Expression> | undefined {
	const kept = arbs.filter(
		(arb): arb is fc.Arbitrary<Expression> => arb !== undefined,
	);
	return kept.length === 0 ? undefined : fc.oneof(...kept);
}

/** Two operands of compatible types for a comparison under `kind`. */
function operandPairs(ordered: boolean): readonly [ValueType, ValueType][] {
	const same = (ordered ? ORDERED : VALUE_TYPES).map(
		(type): [ValueType, ValueType] => [type, type],
	);
	return [
		...same,
		["int", "decimal"],
		["date", "datetime"],
		["text", "single_select"],
		["text", "date"],
		["text", "datetime"],
	];
}

function comparison(
	kind: (typeof COMPARISON_KINDS)[number],
	sub: Sub,
): fc.Arbitrary<Expression> | undefined {
	const ordered = kind !== "eq" && kind !== "neq";
	return oneOf(
		...operandPairs(ordered).map(([a, b]) => {
			const left = sub(value(a));
			const right = sub(value(b));
			return left === undefined || right === undefined
				? undefined
				: fc
						.tuple(left, right, fc.boolean())
						.map(
							([l, r, swap]): Expression =>
								swap
									? { kind, left: r, right: l }
									: { kind, left: l, right: r },
						);
		}),
	);
}

const comparisonBuilder =
	(kind: (typeof COMPARISON_KINDS)[number]): Builder =>
	(request, sub) =>
		isCondition(request) ? comparison(kind, sub) : undefined;

/** Literal values of `type`, one to three, for `in` and a switch's cases. */
const literalsOf = (type: ValueType) =>
	fc.uniqueArray(fc.constantFrom(...LITERALS[type]), {
		minLength: 1,
		maxLength: 3,
	});

/** A branch node's values of the request's type. */
function branchValues(
	request: Request,
	sub: Sub,
): fc.Arbitrary<Expression> | undefined {
	return isCondition(request)
		? sub(CONDITION)
		: oneOf(...typesOf(request).map((type) => sub(value(type))));
}

/** Fixed `format-date` patterns, and the presets the domain names. */
const FORMAT_PATTERNS = ["%Y", "%Y-%m-%d", "%d/%m/%Y %H:%M", "%e %B %Y"];

/** The arbitrary of a relation path from `scope`, with the scope it reaches. */
const relationArb = (scope: Scope) => {
	const all = relations(scope);
	return all.length === 0 ? undefined : fc.constantFrom(...all);
};

/** The builder of every expression kind, keyed by the domain's union. */
export const KIND_BUILDERS: { readonly [K in Expression["kind"]]: Builder } = {
	eq: comparisonBuilder("eq"),
	neq: comparisonBuilder("neq"),
	gt: comparisonBuilder("gt"),
	gte: comparisonBuilder("gte"),
	lt: comparisonBuilder("lt"),
	lte: comparisonBuilder("lte"),
	in: (request, sub) =>
		isCondition(request)
			? oneOf(
					...VALUE_TYPES.map((type) => {
						const left = sub(value(type));
						return left === undefined
							? undefined
							: fc.tuple(left, literalsOf(type)).map(
									([l, values]): Expression => ({
										kind: "in",
										left: l,
										values: values as [Literal, ...Literal[]],
									}),
								);
					}),
				)
			: undefined,
	"within-distance": (request, sub, scope) => {
		if (!isCondition(request)) return undefined;
		const center = sub(value("geopoint"));
		if (center === undefined) return undefined;
		return fc
			.tuple(
				center,
				fc.oneof(
					fc.constantFrom(1, 2.5),
					sub(value("decimal")) ?? fc.constant(1),
				),
				fc.constantFrom(...DISTANCE_UNITS),
			)
			.map(
				([c, distance, unit]): Expression => ({
					kind: "within-distance",
					property: {
						kind: "prop",
						caseType: SCOPE_TYPE[scope],
						property: "home",
					},
					center: c,
					distance,
					unit,
				}),
			);
	},
	match: (request, sub, scope) => {
		if (!isCondition(request)) return undefined;
		const v = sub(value("text"));
		if (v === undefined) return undefined;
		return fc
			.tuple(
				fc.constantFrom(...PROPERTIES.text, ...PROPERTIES.date),
				v,
				fc.constantFrom(...MATCH_MODES),
			)
			.map(
				([property, val, mode]): Expression => ({
					kind: "match",
					property: { kind: "prop", caseType: SCOPE_TYPE[scope], property },
					value: val,
					mode,
				}),
			);
	},
	"multi-select-contains": (request, sub, scope) => {
		if (!isCondition(request)) return undefined;
		const computed = sub(value("text"));
		return fc
			.tuple(
				fc.array(
					fc.oneof(
						fc.constantFrom(...LITERALS.multi_select),
						// A literal stands in the list as itself, never wrapped.
						(computed ?? fc.constantFrom(...LITERALS.text)).map(
							(value): Literal | Expression =>
								"kind" in value &&
								value.kind === "term" &&
								value.term.kind === "literal"
									? value.term
									: value,
						),
					),
					{ minLength: 1, maxLength: 2 },
				),
				fc.constantFrom(...MULTI_SELECT_QUANTIFIERS),
			)
			.map(
				([values, quantifier]): Expression => ({
					kind: "multi-select-contains",
					property: {
						kind: "prop",
						caseType: SCOPE_TYPE[scope],
						property: "tags",
					},
					values: values as [Literal, ...Literal[]],
					quantifier,
				}),
			);
	},
	"match-all": (request) =>
		isCondition(request) ? fc.constant({ kind: "match-all" }) : undefined,
	"match-none": (request) =>
		isCondition(request) ? fc.constant({ kind: "match-none" }) : undefined,
	"is-blank": (request, sub) => {
		const left = isCondition(request) ? sub(value("any")) : undefined;
		return left?.map((l): Expression => ({ kind: "is-blank", left: l }));
	},
	"matches-pattern": (request, sub) => {
		const left = isCondition(request) ? sub(value("text")) : undefined;
		return left?.map(
			(l): Expression => ({
				kind: "matches-pattern",
				left: l,
				pattern: "^[a-z ]+$",
			}),
		);
	},
	between: (request, sub) =>
		isCondition(request)
			? oneOf(
					...ORDERED.map((type) => {
						const left = sub(value(type));
						const bound = sub(value(type));
						return left === undefined || bound === undefined
							? undefined
							: fc
									.tuple(
										left,
										fc.option(bound, { nil: undefined }),
										fc.option(bound, { nil: undefined }),
										fc.boolean(),
										fc.boolean(),
									)
									.filter(
										([, lower, upper]) =>
											lower !== undefined || upper !== undefined,
									)
									.map(
										([
											l,
											lower,
											upper,
											lowerInclusive,
											upperInclusive,
										]): Expression => ({
											kind: "between",
											left: l,
											...(lower === undefined ? {} : { lower }),
											...(upper === undefined ? {} : { upper }),
											lowerInclusive,
											upperInclusive,
										}),
									);
					}),
				)
			: undefined,
	and: (request, sub) => {
		const clause = isCondition(request) ? sub(CONDITION) : undefined;
		return clause === undefined
			? undefined
			: fc.array(clause, { minLength: 2, maxLength: 3 }).map(
					(clauses): Expression => ({
						kind: "and",
						clauses: clauses as [Expression, ...Expression[]],
					}),
				);
	},
	or: (request, sub) => {
		const clause = isCondition(request) ? sub(CONDITION) : undefined;
		return clause === undefined
			? undefined
			: fc.array(clause, { minLength: 2, maxLength: 3 }).map(
					(clauses): Expression => ({
						kind: "or",
						clauses: clauses as [Expression, ...Expression[]],
					}),
				);
	},
	not: (request, sub) => {
		const clause = isCondition(request) ? sub(CONDITION) : undefined;
		return clause?.map((c): Expression => ({ kind: "not", clause: c }));
	},
	"when-input-present": (request, sub) => {
		const clause = isCondition(request) ? sub(CONDITION) : undefined;
		return clause === undefined
			? undefined
			: fc.tuple(fc.constantFrom(...INPUT_TOKENS), clause).map(
					([token, c]): Expression => ({
						kind: "when-input-present",
						input: { kind: "input", searchInputUuid: token },
						clause: c,
					}),
				);
	},
	exists: (request, sub, scope) =>
		relationQuantifier("exists", request, sub, scope),
	missing: (request, sub, scope) =>
		relationQuantifier("missing", request, sub, scope),
	term: () => undefined,
	today: (request) =>
		gives(request, "date") ? fc.constant({ kind: "today" }) : undefined,
	now: (request) =>
		gives(request, "datetime") ? fc.constant({ kind: "now" }) : undefined,
	"id-of": (request) =>
		gives(request, "text")
			? fc.constant({ kind: "id-of", opUuid: OPERATION })
			: undefined,
	"acting-user": (request) =>
		gives(request, "text") ? fc.constant({ kind: "acting-user" }) : undefined,
	unowned: (request) =>
		gives(request, "text") ? fc.constant({ kind: "unowned" }) : undefined,
	"table-lookup": (request, sub) => {
		const where = typeOf(request) === undefined ? undefined : sub(CONDITION);
		return where?.map(
			(w): Expression => ({
				kind: "table-lookup",
				tableId: TABLE as never,
				resultColumnId: COLUMN as never,
				where: w,
			}),
		);
	},
	"date-add": (request, sub) =>
		oneOf(
			...(["date", "datetime"] as const)
				.filter((type) => gives(request, type))
				.map((type) => {
					const date = sub(value(type));
					const quantity = oneOf(sub(value("int")), sub(value("decimal")));
					return date === undefined || quantity === undefined
						? undefined
						: fc
								.tuple(date, fc.constantFrom(...DATE_ADD_INTERVALS), quantity)
								.map(
									([d, interval, q]): Expression => ({
										kind: "date-add",
										date: d,
										interval,
										quantity: q,
									}),
								);
				}),
		),
	"date-coerce": (request, sub) => {
		const inner = gives(request, "date")
			? oneOf(sub(value("text")), sub(value("date")), sub(value("datetime")))
			: undefined;
		return inner?.map((v): Expression => ({ kind: "date-coerce", value: v }));
	},
	"datetime-coerce": (request, sub) => {
		const inner = gives(request, "datetime")
			? oneOf(sub(value("text")), sub(value("date")), sub(value("datetime")))
			: undefined;
		return inner?.map(
			(v): Expression => ({ kind: "datetime-coerce", value: v }),
		);
	},
	double: (request, sub) => {
		const inner = gives(request, "decimal")
			? oneOf(sub(value("int")), sub(value("text")), sub(value("decimal")))
			: undefined;
		return inner?.map((v): Expression => ({ kind: "double", value: v }));
	},
	arith: (request, sub) => {
		if (!gives(request, "int", "decimal")) return undefined;
		// A whole number is asked for where only one fits (`quotient`'s
		// operands), so its operands are whole numbers too.
		const whole = sub(value("int"));
		const operand =
			typeOf(request) === "int"
				? whole
				: oneOf(sub(value("int")), sub(value("decimal")));
		if (operand === undefined || whole === undefined) return undefined;
		// `quotient` divides whole numbers alone (the checker refuses a
		// decimal operand, as the record dialect does), so it is drawn over
		// whole numbers.
		return fc
			.constantFrom(...ARITH_OPS)
			.chain((op) =>
				fc
					.tuple(
						op === "quotient" ? whole : operand,
						op === "quotient" ? whole : operand,
					)
					.map(
						([left, right]): Expression => ({ kind: "arith", op, left, right }),
					),
			);
	},
	concat: (request, sub) => {
		const part = gives(request, "text") ? sub(value("any")) : undefined;
		return part === undefined
			? undefined
			: fc.array(part, { minLength: 1, maxLength: 3 }).map(
					(parts): Expression => ({
						kind: "concat",
						parts: parts as [Expression, ...Expression[]],
					}),
				);
	},
	coalesce: (request, sub) => {
		const branch =
			typeOf(request) === undefined ? undefined : branchValues(request, sub);
		return branch === undefined
			? undefined
			: fc.array(branch, { minLength: 1, maxLength: 3 }).map(
					(values): Expression => ({
						kind: "coalesce",
						values: values as [Expression, ...Expression[]],
					}),
				);
	},
	if: (request, sub) => {
		const branch = branchValues(request, sub);
		const cond = sub(CONDITION);
		return branch === undefined || cond === undefined
			? undefined
			: fc.tuple(cond, branch, branch).map(
					([c, then, otherwise]): Expression => ({
						kind: "if",
						cond: c,
						then,
						else: otherwise,
					}),
				);
	},
	switch: (request, sub) => {
		const branch = branchValues(request, sub);
		if (branch === undefined) return undefined;
		return oneOf(
			...ANY_TYPES.map((type) => {
				const on = sub(value(type));
				return on === undefined
					? undefined
					: fc
							.tuple(
								on,
								literalsOf(type),
								fc.array(branch, { minLength: 4, maxLength: 4 }),
							)
							.map(
								([o, whens, thens]): Expression => ({
									kind: "switch",
									on: o,
									cases: whens.map((when, index) => ({
										when,
										// biome-ignore lint/suspicious/noThenProperty: a case's value, never awaited.
										then: thens[index] as Expression,
									})) as [
										{ when: Literal; then: Expression },
										...{ when: Literal; then: Expression }[],
									],
									fallback: thens[3] as Expression,
								}),
							);
			}),
		);
	},
	count: (request, sub, scope) => {
		const relation = gives(request, "int") ? relationArb(scope) : undefined;
		return relation?.chain(({ via, to }) => {
			const where = sub(CONDITION, to);
			return fc.option(where ?? fc.constant(undefined), { nil: undefined }).map(
				(w): Expression => ({
					kind: "count",
					via,
					...(w === undefined ? {} : { where: w }),
				}),
			);
		});
	},
	"format-date": (request, sub) => {
		const date = gives(request, "text")
			? oneOf(sub(value("date")), sub(value("datetime")))
			: undefined;
		return date === undefined
			? undefined
			: fc
					.tuple(
						date,
						fc.constantFrom(...FORMAT_PATTERNS, ...FORMAT_DATE_PRESETS),
					)
					.map(
						([d, pattern]): Expression => ({
							kind: "format-date",
							date: d,
							pattern,
						}),
					);
	},
	negate: (request, sub) => {
		const inner =
			typeOf(request) === "int"
				? sub(value("int"))
				: gives(request, "int", "decimal")
					? oneOf(sub(value("int")), sub(value("decimal")))
					: undefined;
		return inner?.map((v): Expression => ({ kind: "negate", value: v }));
	},
	call: (request, sub) => {
		if (typeOf(request) === undefined) return undefined;
		const argument = sub(value("any"));
		if (argument === undefined) return undefined;
		return fc.constantFrom(...CALL_FUNCTIONS).chain((fn) => {
			const spec = FUNCTION_REGISTRY.get(fn);
			const count = spec === undefined ? 1 : Math.max(spec.minArgs, 0);
			return fc
				.array(argument, { minLength: count, maxLength: count })
				.map((args): Expression => ({ kind: "call", fn, args }));
		});
	},
	itext: (request) =>
		gives(request, "text")
			? fc.constant({
					kind: "itext",
					unit: { field: FIELD, role: "field-label" },
				} as Expression)
			: undefined,
	"choice-name": (request, sub) => {
		const inner = gives(request, "text") ? sub(value("text")) : undefined;
		return inner?.map(
			(v): Expression => ({ kind: "choice-name", field: FIELD, value: v }),
		);
	},
	here: (request) =>
		gives(request, "geopoint", "text")
			? fc.constant({ kind: "here" })
			: undefined,
	"case-list-search-text": (request) =>
		gives(request, "text")
			? fc.constant({ kind: "case-list-search-text" })
			: undefined,
	// A translated text names one piece of its own calculated column, which
	// no drawn tree has.
	"case-text": () => undefined,
	"value-list": (request, sub) => {
		const item = gives(request, "text") ? sub(value("text")) : undefined;
		return item === undefined
			? undefined
			: fc.array(item, { minLength: 1, maxLength: 3 }).map(
					(items): Expression => ({
						kind: "value-list",
						items: items as [Expression, ...Expression[]],
					}),
				);
	},
	cases: () => undefined,
	"table-rows": () => undefined,
	"worker-groups": () => undefined,
	locations: () => undefined,
	"selected-cases": () => undefined,
	project: (request) =>
		oneOf(
			...typesOf(request).flatMap((type) =>
				PROPERTIES[type].map((property) =>
					fc.constant<Expression>({
						kind: "project",
						of: {
							kind: "cases",
							source: "casedb",
							where: [
								{
									kind: "eq",
									left: term({
										kind: "prop",
										caseType: CHOSEN_TYPE,
										property: "case_id",
									}),
									right: term({
										kind: "session-datum",
										datum: { kind: "selected-case", module: CHOSEN_MODULE },
									}),
								},
							],
						},
						value: { kind: "prop", caseType: CHOSEN_TYPE, property },
					}),
				),
			),
		),
};

function relationQuantifier(
	kind: "exists" | "missing",
	request: Request,
	sub: Sub,
	scope: Scope,
): fc.Arbitrary<Expression> | undefined {
	const relation = isCondition(request) ? relationArb(scope) : undefined;
	return relation?.chain(({ via, to }) => {
		const where = sub(CONDITION, to);
		return fc.option(where ?? fc.constant(undefined), { nil: undefined }).map(
			(w): Expression => ({
				kind,
				via,
				...(w === undefined ? {} : { where: w }),
			}),
		);
	});
}

/**
 * The kinds the instance arms stand for, which a builder above cannot root a
 * tree at alone: each is drawn inside the kind named beside it.
 */
const DRAWN_INSIDE: Partial<Record<Expression["kind"], Expression["kind"]>> = {
	cases: "project",
};

/**
 * Kinds no record slot of this corpus admits, with why. The coverage test
 * holds every other kind, and every choice of each operator list, to being
 * drawn.
 */
export const RECORD_KIND_COVERAGE: Partial<Record<Expression["kind"], string>> =
	{
		"id-of":
			"Only a case change after a create in its form reads it, and no workflow document's form holds a create before another change.",
		"acting-user":
			"Only a case change's owner reads it, and no workflow document's change states an owner.",
		unowned:
			"Only a case change's owner reads it, and no workflow document's change states an owner.",
		"table-lookup": "The corpus holds no lookup table.",
		"table-rows": "The corpus holds no lookup table.",
		"worker-groups": "Worker group row queries need the device fixture.",
		locations: "No record slot reads places.",
		"selected-cases": "Only form logic reads the cases a worker chose.",
		call: "The record rule set has no function call.",
		itext: "Only form logic reads a form's text.",
		"choice-name": "Only form logic reads a choice's name.",
		"case-list-search-text": "The record dialect has no spelling for it.",
		"case-text":
			"Only a calculated column with translated text reads one of its pieces.",
	};

// ── The expression arbitrary ──────────────────────────────────────

/** The greatest depth of a drawn tree. */
const MAX_DEPTH = 3;

const cache = new Map<string, fc.Arbitrary<Expression> | undefined>();

/** Trees answering `request` in `scope`, at most `depth` levels deep. */
export function expressionArbitrary(
	request: Request,
	depth: number = MAX_DEPTH,
	scope: Scope = "self",
): fc.Arbitrary<Expression> | undefined {
	const key = JSON.stringify([request, depth, scope]);
	if (cache.has(key)) return cache.get(key);
	const leafArbs = typesOf(request).flatMap((type) => {
		const all = leaves(type, scope);
		return all.length === 0 ? [] : [fc.constantFrom(...all)];
	});
	const sub: Sub = (next, nextScope = scope) =>
		depth <= 0 ? undefined : expressionArbitrary(next, depth - 1, nextScope);
	const kinds = (Object.keys(KIND_BUILDERS) as Expression["kind"][]).flatMap(
		(kind) => {
			if (depth <= 0) return [];
			const arb = KIND_BUILDERS[kind](request, sub, scope);
			return arb === undefined ? [] : [arb];
		},
	);
	// Leaves and kinds share the draw evenly at the bottom and kinds take
	// twice the leaves' share above it, so trees reach the depth they may.
	const kindShare = depth >= 2 ? 2 : 1;
	const options = [
		...leafArbs.map((arbitrary) => ({ arbitrary, weight: kinds.length || 1 })),
		...kinds.map((arbitrary) => ({
			arbitrary,
			weight: kindShare * (leafArbs.length || 1),
		})),
	];
	const arb =
		options.length === 0
			? undefined
			: fc.oneof({ depthSize: "small", withCrossShrink: true }, ...options);
	cache.set(key, arb);
	return arb;
}

/** Trees for every request a slot can make, as a pool each slot draws from. */
export interface ExpressionPool {
	readonly condition: readonly Expression[];
	readonly values: Readonly<Record<ValueType | "any", readonly Expression[]>>;
}

const POOL_SIZE = 12;
const poolOf = (request: Request) =>
	fc.array(expressionArbitrary(request) as fc.Arbitrary<Expression>, {
		minLength: POOL_SIZE,
		maxLength: POOL_SIZE,
	});

export const expressionPoolArbitrary: fc.Arbitrary<ExpressionPool> = fc.record({
	condition: poolOf(CONDITION),
	values: fc.record(
		Object.fromEntries(
			[...VALUE_TYPES, "any" as const].map((type) => [
				type,
				poolOf(value(type)),
			]),
		) as Record<ValueType | "any", fc.Arbitrary<Expression[]>>,
	),
});

// ── Binding a tree to a slot ──────────────────────────────────────

/** What each placeholder names for one slot, where it names anything. */
type Bindings = Readonly<Record<string, string | undefined>>;

/** `tree` with each placeholder replaced by what it names, or undefined
 *  where one names nothing in this slot. */
export function bindTree(
	tree: Expression,
	bindings: Bindings,
): Expression | undefined {
	let unbound = false;
	const bound = JSON.parse(JSON.stringify(tree), (_key, held: unknown) => {
		if (typeof held !== "string" || !held.startsWith("@@")) return held;
		const named = bindings[held];
		if (named === undefined) unbound = true;
		return named ?? held;
	}) as Expression;
	return unbound ? undefined : bound;
}

/** The placeholder bindings of a slot of `doc` owned by `moduleUuid`. */
function bindingsFor(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid | undefined,
	ref?: SlotContextRef,
): Bindings {
	const own =
		ref !== undefined && "member" in ref && "searchInputUuid" in ref.member
			? ref.member.searchInputUuid
			: undefined;
	const module = doc.modules[moduleUuid];
	const caseType = module?.caseType;
	const types = doc.caseTypes ?? [];
	const parent = types.find((type) => type.name === caseType)?.parent_type;
	const child = types.find((type) => type.parent_type === caseType)?.name;
	const chosenUuid = module?.parentCaseModuleUuid ?? module?.parentModuleUuid;
	const chosen = chosenUuid === undefined ? undefined : doc.modules[chosenUuid];
	const inputs = module?.caseListConfig?.searchInputs ?? [];
	const form = formUuid === undefined ? undefined : doc.forms[formUuid];
	const create = form?.caseOperations?.find(
		(operation) => operation.action === "create",
	);
	const field =
		formUuid === undefined ? undefined : doc.fieldOrder[formUuid]?.[0];
	return {
		[SELF]: caseType,
		[PARENT]: parent,
		[CHILD]: child,
		[CHOSEN_MODULE]: chosen?.caseType === undefined ? undefined : chosenUuid,
		[CHOSEN_TYPE]: chosen?.caseType,
		[OWN_MODULE]: moduleUuid,
		[USER_PROPERTY]: doc.userPropertyOrder?.[0],
		[FIELD]: field,
		[OPERATION]: create?.uuid,
		[TABLE]: undefined,
		[COLUMN]: undefined,
		...Object.fromEntries(
			[0, 1, 2].map((index) => [inputToken(index), inputs[index]?.uuid]),
		),
		[OWN_INPUT]: own,
	};
}

// ── Placing a pool in a document ──────────────────────────────────

/** The uuid of the calculated column a draw adds to a module. */
const addedColumnUuid = (moduleUuid: Uuid) =>
	`${moduleUuid.slice(0, -4)}cafe` as Uuid;

/** A stand-in in each slot a draw adds, which a placement replaces or the
 *  draw removes again. */
const PENDING: Expression = Object.freeze({ kind: "match-none" });

/** `doc` with the slots a draw adds, each holding `PENDING`, and the
 *  properties it adds declared on every case type. */
function withAddedSlots(doc: BlueprintDoc): BlueprintDoc {
	const { refIndex: _derived, ...persisted } = doc;
	const next = structuredClone(persisted) as BlueprintDoc;
	for (const type of next.caseTypes ?? [])
		for (const added of ADDED_PROPERTIES)
			if (!type.properties.some((property) => property.name === added.name))
				type.properties.push({
					name: added.name,
					label: proseText(added.name),
					data_type: added.data_type,
				} as (typeof type.properties)[number]);
	for (const moduleUuid of next.moduleOrder) {
		const module = next.modules[moduleUuid];
		if (module === undefined) continue;
		if (module.displayCondition === undefined)
			module.displayCondition = PENDING;
		const config = module.caseListConfig;
		if (config !== undefined && module.caseType !== undefined) {
			const column = calculatedColumn(
				addedColumnUuid(moduleUuid),
				"Drawn",
				PENDING,
			);
			config.columns.push(column);
			config.listColumnOrder.push(column.uuid);
			config.detailColumnOrder.push(column.uuid);
			for (const input of config.searchInputs)
				if (
					input.kind === "simple" &&
					(input.type === "text" ||
						input.type === "date" ||
						input.type === "barcode") &&
					!("default" in input && input.default !== undefined)
				)
					(input as { default?: Expression }).default = PENDING;
		}
		const search = module.caseSearchConfig as
			| {
					searchActionEnabled?: boolean;
					searchButtonDisplayCondition?: Expression;
			  }
			| undefined;
		if (
			search !== undefined &&
			search.searchActionEnabled !== false &&
			search.searchButtonDisplayCondition === undefined
		)
			search.searchButtonDisplayCondition = PENDING;
		for (const formUuid of next.formOrder[moduleUuid] ?? []) {
			const form = next.forms[formUuid];
			if (form !== undefined && form.displayCondition === undefined)
				form.displayCondition = PENDING;
		}
	}
	return next;
}

/** `doc` with every slot still `PENDING` removed: a column, a starting value,
 *  a condition. */
function withoutPending(doc: BlueprintDoc): BlueprintDoc {
	for (const module of Object.values(doc.modules)) {
		if (module.displayCondition === PENDING) delete module.displayCondition;
		const config = module.caseListConfig;
		if (config !== undefined) {
			const pending = new Set(
				config.columns
					.filter(
						(column) =>
							column.kind === "calculated" && column.expression === PENDING,
					)
					.map((column) => column.uuid),
			);
			config.columns = config.columns.filter(
				(column) => !pending.has(column.uuid),
			);
			config.listColumnOrder = config.listColumnOrder.filter(
				(uuid) => !pending.has(uuid),
			);
			config.detailColumnOrder = config.detailColumnOrder.filter(
				(uuid) => !pending.has(uuid),
			);
			for (const input of config.searchInputs)
				if ("default" in input && input.default === PENDING)
					delete (input as { default?: Expression }).default;
		}
		const search = module.caseSearchConfig as
			| { searchButtonDisplayCondition?: Expression }
			| undefined;
		if (search?.searchButtonDisplayCondition === PENDING)
			delete search.searchButtonDisplayCondition;
	}
	for (const form of Object.values(doc.forms))
		if (form.displayCondition === PENDING) delete form.displayCondition;
	return doc;
}

/** The request a record slot's expectation makes. */
export function requestOf(
	expectation: ReturnType<typeof slotContext> extends infer C
		? C extends { profile: { expectation: infer E } }
			? E
			: never
		: never,
): Request | undefined {
	switch (expectation.kind) {
		case "condition":
			return CONDITION;
		case "value":
			return value(
				expectation.many === true ? "text" : (expectation.type ?? "any"),
			);
		case "assignment":
			return value(
				expectation.destinations.length === 1
					? (expectation.destinations[0] as ValueType)
					: "any",
			);
		default:
			return undefined;
	}
}

/** The owners whose slots a draw rewrites: every module, then every form. */
function owners(doc: BlueprintDoc): {
	readonly owner: { entity: "module" | "form"; uuid: Uuid };
	readonly module: Uuid;
	readonly form?: Uuid;
}[] {
	return doc.moduleOrder.flatMap((moduleUuid) => [
		{
			owner: { entity: "module" as const, uuid: moduleUuid },
			module: moduleUuid,
		},
		...(doc.formOrder[moduleUuid] ?? []).map((formUuid) => ({
			owner: { entity: "form" as const, uuid: formUuid },
			module: moduleUuid,
			form: formUuid,
		})),
	]);
}

/**
 * Whether a draw puts a tree in a slot: a record slot a menu, a list, a
 * search, a form's entry or a form's case change evaluates.
 */
function drawnSlot(
	ctx: ReturnType<typeof slotContext>,
): ctx is NonNullable<ReturnType<typeof slotContext>> {
	return ctx !== undefined && ctx.profile.ruleSet === "record";
}

/** One record slot's placement: its key and the tree it takes. */
interface Placement {
	readonly key: string;
	readonly tree: Expression;
}

/** Every record slot of `doc` with the first tree of the pool its checker
 *  admits, starting each slot at its own offset in the pool. */
function placementsOf(doc: BlueprintDoc, pool: ExpressionPool): Placement[] {
	const out: Placement[] = [];
	let offset = 0;
	for (const { owner, module, form } of owners(doc)) {
		for (const { ref } of expressionSlotValues(doc, owner)) {
			if (ref.entity === "field") continue;
			const bindings = bindingsFor(doc, module, form, ref);
			const ctx = slotContext(doc, ref, new Map());
			if (!drawnSlot(ctx)) continue;
			const request = requestOf(ctx.profile.expectation);
			if (request === undefined) continue;
			const trees =
				request.position === "condition"
					? pool.condition
					: pool.values[request.type];
			// The largest tree the slot's checker admits, the first of equals
			// from the slot's own offset, so each slot reaches as deep as its
			// rules let it.
			offset += 1;
			let chosen: { tree: Expression; size: number } | undefined;
			for (let index = 0; index < trees.length; index += 1) {
				const drawn = trees[(index + offset) % trees.length] as Expression;
				const tree = bindTree(drawn, bindings);
				if (tree === undefined) continue;
				const size = JSON.stringify(tree).length;
				if (chosen !== undefined && size <= chosen.size) continue;
				if (checkExpression(tree, ctx).errors.length > 0) continue;
				chosen = { tree, size };
			}
			if (chosen !== undefined)
				out.push({ key: expressionSlotKey(ref), tree: chosen.tree });
		}
	}
	return out;
}

/** `added` with `placements` written into their slots and every slot still
 *  pending removed. */
function placed(
	added: BlueprintDoc,
	placements: readonly Placement[],
): BlueprintDoc {
	const next = structuredClone(added);
	const byKey = new Map(placements.map((one) => [one.key, one.tree]));
	for (const { owner } of owners(next))
		rewriteExpressionSlotValues(next, owner, (held, ref) => {
			const tree = byKey.get(expressionSlotKey(ref));
			return tree === undefined
				? isPending(held)
					? PENDING
					: held
				: structuredClone(tree);
		});
	return withoutPending(next);
}

/** Whether a slot holds the stand-in (by shape: a clone of the document
 *  holds a copy of it). */
function isPending(held: unknown): boolean {
	return (
		typeof held === "object" &&
		held !== null &&
		(held as { kind?: unknown }).kind === "match-none" &&
		Object.keys(held).length === 1
	);
}

/** Whether the commit gate admits `doc`: the stored schema, then every rule. */
const admitted = (doc: BlueprintDoc) =>
	blueprintDocSchema.safeParse(toPersistableDoc(doc)).success &&
	runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).length === 0;

/** `doc` with the pool placed in every record slot: every placement at once
 *  where the gate admits that, else each in turn that the gate admits beside
 *  those kept before it. */
export function withPool(
	doc: BlueprintDoc,
	pool: ExpressionPool,
): BlueprintDoc {
	const added = withAddedSlots(doc);
	// The stand-in is a condition a removed slot never prints; the copy the
	// placement writes back is matched by shape, so swap it for the frozen one.
	for (const { owner } of owners(added))
		rewriteExpressionSlotValues(added, owner, (held) =>
			isPending(held) ? PENDING : held,
		);
	const all = placementsOf(added, pool);
	const whole = placed(added, all);
	if (admitted(whole)) return whole;
	const kept: Placement[] = [];
	for (const one of all)
		if (admitted(placed(added, [...kept, one]))) kept.push(one);
	return placed(added, kept);
}

/**
 * `doc` with each menu that lists cases of a child type chosen after the case
 * of another menu that lists its parent type (`parentCaseModuleUuid`), each
 * route kept where the gate admits it: the route a read of the case a menu
 * above chose (`project`) needs, which a case list's filter, a Search field's
 * condition and a form's display condition then hold.
 */
export function withParentSelections(doc: BlueprintDoc): BlueprintDoc {
	const { refIndex: _derived, ...persisted } = doc;
	let current = persisted as BlueprintDoc;
	for (const moduleUuid of current.moduleOrder) {
		const module = current.modules[moduleUuid];
		if (
			module?.caseType === undefined ||
			module.parentCaseModuleUuid !== undefined
		)
			continue;
		const parentType = (current.caseTypes ?? []).find(
			(type) => type.name === module.caseType,
		)?.parent_type;
		if (parentType === undefined) continue;
		for (const chooser of current.moduleOrder) {
			if (
				chooser === moduleUuid ||
				current.modules[chooser]?.caseType !== parentType
			)
				continue;
			const next = structuredClone(current);
			const routed = next.modules[moduleUuid];
			if (routed === undefined) continue;
			routed.parentCaseModuleUuid = chooser;
			if (admitted(next)) {
				current = next;
				break;
			}
		}
	}
	return current;
}

export const recordExpressionDocArbitrary: fc.Arbitrary<BlueprintDoc> = fc
	.tuple(suiteDocArbitrary, expressionPoolArbitrary)
	.map(([doc, pool]) => withPool(withParentSelections(doc), pool));

// ── Coverage ──────────────────────────────────────────────────────

/** Every kind, operator, interval, mode, quantifier and preset a tree holds,
 *  as `kind` or `kind:choice`. */
export function drawnVocabulary(tree: Expression): Set<string> {
	const out = new Set<string>();
	walkExpressionNodes(tree, (node) => {
		out.add(node.kind);
		if (node.kind === "arith") out.add(`arith:${node.op}`);
		if (node.kind === "date-add") out.add(`date-add:${node.interval}`);
		if (node.kind === "match") out.add(`match:${node.mode}`);
		if (node.kind === "multi-select-contains")
			out.add(`multi-select-contains:${node.quantifier}`);
		if (node.kind === "format-date" && typeof node.pattern === "string")
			out.add(`format-date:${node.pattern}`);
		if (node.kind === "call") out.add(`call:${node.fn}`);
	});
	return out;
}

/** The vocabulary the domain names: every kind but those drawn only inside
 *  another, and every choice of each operator list. */
export function domainVocabulary(): Set<string> {
	return new Set(
		[
			...(Object.keys(KIND_BUILDERS) as Expression["kind"][]).filter(
				(kind) => DRAWN_INSIDE[kind] === undefined,
			),
			...ARITH_OPS.map((op) => `arith:${op}`),
			...DATE_ADD_INTERVALS.map((interval) => `date-add:${interval}`),
			...MATCH_MODES.map((mode) => `match:${mode}`),
			...MULTI_SELECT_QUANTIFIERS.map((q) => `multi-select-contains:${q}`),
			...FORMAT_DATE_PRESETS.map((preset) => `format-date:${preset}`),
			...CALL_FUNCTIONS.map((fn) => `call:${fn}`),
		].filter(
			(entry) =>
				RECORD_KIND_COVERAGE[entry.split(":")[0] as Expression["kind"]] ===
				undefined,
		),
	);
}

/** The record slots of `doc`, each with its tree and context. */
export function recordSlotsOf(doc: BlueprintDoc) {
	return owners(doc).flatMap(({ owner, module, form }) =>
		expressionSlotValues(doc, owner).flatMap(({ ref, expression }) => {
			if (ref.entity === "field") return [];
			const ctx = slotContext(doc, ref, new Map());
			return !drawnSlot(ctx)
				? []
				: [
						{
							ref,
							expression,
							ctx,
							bindings: bindingsFor(doc, module, form, ref),
						},
					];
		}),
	);
}
