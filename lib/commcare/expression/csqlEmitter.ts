// lib/commcare/expression/csqlEmitter.ts
//
// Per-dialect value-expression emitter for the CSQL grammar. Produces
// `CsqlSegment[]` output — the same segment-list IR the predicate-side
// CSQL emitter returns — so the wire-emission consumer composes both
// surfaces into one `concat(...)` wrapper without parsing constants
// out of an intermediate string.
//
// Emission policy: emit the eight `ValueExpression` arms that ARE in
// CCHQ's CSQL value-function whitelist
// (`commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`).
// The remaining ten arms (`arith`, `concat`, `coalesce`, `if`,
// `switch`, `count`, `format-date`, `id-of`, `acting-user`, `unowned`)
// inline as on-device XPath
// fragments. At predicate-operand boundaries that happens in
// `lib/commcare/predicate/csqlEmitter.ts::inlineAsRuntimeOperand`;
// when one is nested below a native value function, this file's
// `emitCsqlFunctionArgumentSegments` evaluates it on-device and safely
// quotes the resolved scalar inside the surrounding native call.
//
// If the bypass path ever surfaced one of the ten non-whitelist
// arms, the emitter throws a defensive error rather than emit
// broken CSQL. The local `_exhaustive: never` default catches new
// ValueExpression kinds at compile time.
//
// File ownership: this file owns operator dispatch for the CSQL
// value-expression surface. Term emission and shared lexical helpers
// flow through the shared `../predicate/termEmitter` /
// `../predicate/stringQuoting` modules; the segment-list IR lives in
// `../predicate/csqlSegment` and is the single shape both predicate
// and expression emitters return.
//
// Coverage of the eight whitelist arms (per CCHQ's
// `XPATH_VALUE_FUNCTIONS` registry):
//
//   - `today` / `now` — discriminator-only. Emit `today()` / `now()`
//     constant segments. CCHQ registrations at the `today` and `now`
//     entries on `XPATH_VALUE_FUNCTIONS`.
//   - `date-coerce(value)` → `date(<value>)`; `datetime-coerce(value)`
//     → `datetime(<value>)`. AST kind names diverge from wire function
//     names; emitter performs the rename. Registrations at the `date`
//     and `datetime` entries.
//   - `double(value)` → `double(<value>)`. Forced numeric coercion.
//     Registration at the `double` entry.
//   - `date-add(value, interval, quantity)` → `date-add(<value>,
//     '<interval>', <quantity>)` for a date result, or
//     `datetime-add(...)` for a datetime result. CCHQ wire signatures per
//     `commcare-hq/corehq/apps/case_search/xpath_functions/value_functions.py::date_add`
//     (`date-add('2022-01-01', 'days', -1) => '2021-12-31'`) — three
//     separate arguments. Whitelist registrations at the `date-add` and
//     `datetime-add` entries cover both wire forms; the canonical type
//     context (or an unambiguous structural type) selects the wire name.
//   - `unwrap-list(value)` → `unwrap-list(<value>)`. Sequence-source
//     value function. Registration at the `unwrap-list` entry.
//   - `term(t)` → delegate to the shared CSQL term-segment emitter at
//     `../predicate/termEmitter:emitTermSegment`. Property refs and
//     literals emit as constant segments; runtime refs emit through
//     `quoteRuntimeCsqlValue`, which chooses a safe CSQL string delimiter
//     from the resolved value and rejects values containing both quote
//     kinds instead of producing malformed CSQL.

import {
	asTemporalType,
	inferStructuralTemporalType,
	type TemporalType,
} from "@/lib/domain/predicate/temporalType";
import {
	type CheckError,
	checkExpression,
	type TypeContext,
} from "@/lib/domain/predicate/typeChecker";
import type { ValueExpression } from "@/lib/domain/predicate/types";
import type { CsqlSegment } from "../predicate/csqlSegment";
import {
	classifyCalendarDateAddQuantity,
	invalidWholeNumberXPath,
} from "../predicate/runtimeCsqlNumericSafety";
import { collectRuntimeCsqlStringExpressionInputNames } from "../predicate/runtimeCsqlQuoteSafety";
import { quoteLiteral } from "../predicate/stringQuoting";
import {
	emitTermSegment,
	quoteRuntimeCsqlValue,
	type RuntimeCsqlQuoteStyle,
} from "../predicate/termEmitter";
import { emitOnDeviceExpression } from "./onDeviceEmitter";

/**
 * Compile a `ValueExpression` AST to its CSQL `CsqlSegment[]` IR. The
 * caller composes the segments with surrounding constants (operator
 * tokens, comparison operators, etc.) and routes the final list
 * through the predicate-side wrap layer (`wrapInConcat` in
 * `../predicate/csqlEmitter.ts`) to produce the on-device XPath
 * `concat(...)` wrapper.
 *
 * The emitter is total over CSQL's value-function whitelist arms.
 * A non-whitelist arm passed directly to this public entry throws a
 * defensive error; nested non-whitelist function arguments route through
 * `emitCsqlFunctionArgumentSegments` and inline as quoted runtime XPath.
 */
export function emitCsqlExpressionSegments(
	expr: ValueExpression,
	typeContext?: TypeContext,
	runtimeQuoteStyle: RuntimeCsqlQuoteStyle = "double",
): CsqlSegment[] {
	switch (expr.kind) {
		case "term": {
			// Structural lifter: any `Term` flows through the shared
			// CSQL term-segment emitter. The expression emitter
			// emits in function-call-argument position. A runtime XPath
			// read must still land as a quoted CSQL scalar: after the
			// outer XPath `concat(...)` resolves, CCHQ parses the result
			// as a fresh CSQL expression. Without the quote brackets,
			// `date(input("dob"))` with a value of `2024-01-02` becomes
			// `date(2024-01-02)` — an arithmetic AST, not a string value —
			// and `unwrap_value` rejects or misinterprets it. This is the
			// same scalar-string contract the predicate-side direct-term
			// path enforces via `wrapTermAsSegmentList`.
			//
			// Constant arms (property refs, literals) emit as one
			// constant segment regardless of position.
			const inner = emitTermSegment(expr.term);
			if (inner.kind === "constant") {
				return [{ kind: "constant", text: inner.text }];
			}
			return quoteRuntimeCsqlValue(
				inner.xpath,
				runtimeQuoteStyle,
				inner.inputNames,
			);
		}
		case "today":
			// CCHQ value function registered on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`
			// (the `today` entry).
			return [{ kind: "constant", text: "today()" }];
		case "now":
			// CCHQ value function registered on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`
			// (the `now` entry).
			return [{ kind: "constant", text: "now()" }];
		case "date-coerce":
			// AST `date-coerce(value)` → wire `date(<value>)`. CCHQ
			// registration at the `date` entry on `XPATH_VALUE_FUNCTIONS`.
			return emitFunctionCallSegments(
				"date",
				emitCsqlFunctionArgumentSegments(expr.value, typeContext, "double"),
			);
		case "datetime-coerce":
			// AST `datetime-coerce(value)` → wire `datetime(<value>)`.
			// CCHQ registration at the `datetime` entry on
			// `XPATH_VALUE_FUNCTIONS`.
			return emitFunctionCallSegments(
				"datetime",
				emitCsqlFunctionArgumentSegments(expr.value, typeContext, "double"),
			);
		case "double":
			// CCHQ value function at the `double` entry on
			// `XPATH_VALUE_FUNCTIONS`.
			return emitFunctionCallSegments(
				"double",
				emitCsqlFunctionArgumentSegments(expr.value, typeContext, "double"),
			);
		case "date-add":
			// CCHQ wire signature: `date-add(date, interval, quantity)`
			// — three separate arguments. Source citation:
			// `commcare-hq/corehq/apps/case_search/xpath_functions/value_functions.py::date_add`
			// (`date-add('2022-01-01', 'days', -1) => '2021-12-31'`).
			// Interval flows through `quoteLiteral(..., "csql")` because
			// it is a CSQL string literal at the wire layer; the
			// schema's `DATE_ADD_INTERVALS` enum already constrains the
			// value space, but routing through the shared lexical helper
			// keeps the escape rule centralised.
			return emitDateAddSegments(expr, typeContext);
		case "unwrap-list":
			// CCHQ value function at the `unwrap-list` entry on
			// `XPATH_VALUE_FUNCTIONS`.
			return emitFunctionCallSegments(
				"unwrap-list",
				// CCHQ's own list-value wire path emits
				// `unwrap-list('${json.dumps(value)}')`: JSON necessarily
				// contains double quotes, so a double-quoted wrapper would
				// produce invalid CSQL (`unwrap-list("["a"]")`).
				emitCsqlFunctionArgumentSegments(expr.value, typeContext, "single"),
			);
		case "arith":
		case "concat":
		case "coalesce":
		case "if":
		case "switch":
		case "count":
		case "format-date":
		case "id-of":
		case "acting-user":
		case "unowned":
			// These arms are absent from CSQL's value-function
			// whitelist. Callers must route them through either the
			// predicate-side inline-runtime path or this file's native-call
			// argument helper. A direct call cannot supply the surrounding
			// CSQL position, so throwing here defends against broken wire.
			throw new Error(
				`csqlExpressionEmitter: tried to emit a value-expression of kind '${expr.kind}' as native CSQL, but CCHQ's CSQL value-function whitelist (commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS) does not include this arm. The predicate-side emitter at lib/commcare/predicate/csqlEmitter.ts should have inlined it as an on-device XPath fragment via emitOnDeviceExpression. Look at the operand dispatch in emitOperandSegments; a new ValueExpression kind needs to route through inlineAsRuntimeOperand.`,
			);
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`csqlExpressionEmitter: unhandled ValueExpression kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Wrap a single argument's segment list in a function-call shell.
 * Builds `<fn>(<arg-segments>)` as a segment list. Constant runs in
 * the argument splice into the surrounding `<fn>(` / `)` constants
 * naturally via the wrap layer's `mergeAdjacentConstants` pass — when
 * the argument is itself a constant segment, the three pieces collapse
 * to one (e.g. `[const "double(", const "age", const ")"]` becomes
 * `[const "double(age)"]`).
 *
 * The helper exists so each whitelist arm's emission stays a single
 * line; without it, every arm would repeat the spread-prefix-and-
 * suffix pattern.
 */
function emitFunctionCallSegments(
	fnName: string,
	argSegments: readonly CsqlSegment[],
): CsqlSegment[] {
	return [
		{ kind: "constant", text: `${fnName}(` },
		...argSegments,
		{ kind: "constant", text: ")" },
	];
}

function emitCsqlFunctionArgumentSegments(
	expr: ValueExpression,
	typeContext: TypeContext | undefined,
	runtimeQuoteStyle: RuntimeCsqlQuoteStyle,
): CsqlSegment[] {
	if (isNativeCsqlValueExpression(expr)) {
		return emitCsqlExpressionSegments(expr, typeContext, runtimeQuoteStyle);
	}
	return quoteRuntimeCsqlValue(
		emitOnDeviceExpression(expr, undefined, typeContext ?? {}),
		runtimeQuoteStyle,
		[...collectRuntimeCsqlStringExpressionInputNames(expr)],
	);
}

/** Single source of truth for CCHQ's native CSQL value-expression grammar. */
export function isNativeCsqlValueExpression(expr: ValueExpression): boolean {
	switch (expr.kind) {
		case "term":
		case "today":
		case "now":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "date-add":
		case "unwrap-list":
			return true;
		case "arith":
		case "concat":
		case "coalesce":
		case "if":
		case "switch":
		case "count":
		case "format-date":
		case "id-of":
		case "acting-user":
		case "unowned":
			return false;
		default: {
			const _exhaustive: never = expr;
			return _exhaustive;
		}
	}
}

/**
 * Emit `date-add(<date>, '<interval>', <quantity>)` as a segment list.
 * CCHQ's `_date_or_datetime_add` calls `confirm_args_count(node, 3)`
 * at `commcare-hq/corehq/apps/case_search/xpath_functions/value_functions.py::_date_or_datetime_add`,
 * so the three-argument shape is mandatory.
 *
 * The interval is one of `DATE_ADD_INTERVALS` (a closed enum at
 * `lib/domain/predicate/types.ts`), so the literal is always one of
 * `seconds` / `minutes` / `hours` / `days` / `weeks` / `months` /
 * `years` and the `quoteLiteral` call always lands on the no-quote-
 * embedded branch — but routing through the shared helper keeps the
 * escape rule centralised even though a closed enum guarantees the
 * happy path here.
 */
function emitDateAddSegments(
	expr: Extract<ValueExpression, { kind: "date-add" }>,
	typeContext?: TypeContext,
): CsqlSegment[] {
	const functionName = dateAddFunctionName(expr.date, typeContext);
	const dateSegments = emitCsqlFunctionArgumentSegments(
		expr.date,
		typeContext,
		"double",
	);
	const intervalLiteral = quoteLiteral(expr.interval, "csql");
	const quantitySegments = emitDateAddQuantitySegments(expr, typeContext);
	return [
		{ kind: "constant", text: `${functionName}(` },
		...dateSegments,
		{ kind: "constant", text: `, ${intervalLiteral}, ` },
		...quantitySegments,
		{ kind: "constant", text: ")" },
	];
}

function emitDateAddQuantitySegments(
	expr: Extract<ValueExpression, { kind: "date-add" }>,
	typeContext: TypeContext | undefined,
): CsqlSegment[] {
	const segments = emitCsqlFunctionArgumentSegments(
		expr.quantity,
		typeContext,
		"double",
	);
	if (expr.interval !== "months" && expr.interval !== "years") return segments;

	const classification = classifyCalendarDateAddQuantity(expr.quantity);
	if (classification.kind === "static-valid") return segments;
	if (classification.kind === "runtime-input") {
		return [
			...segments,
			{
				kind: "runtime",
				// Guard carrier only. Its empty value leaves the CSQL function call
				// unchanged while the outer wrapper fail-closes fractional input.
				xpath: "''",
				rejectWhen: invalidWholeNumberXPath(classification.inputXPath),
				rejectionKind: "whole-number",
				rejectionInputNames: [classification.inputName],
			},
		];
	}

	throw new Error(
		"csqlExpressionEmitter: calendar-relative date-add quantities must be a fixed whole number or one Number-converted search input. CCHQ rejects fractional months/years, and emitting an unconstrained runtime calculation would make Preview and the exported search disagree. The CSQL representability validator should have rejected this expression before compilation.",
	);
}

/**
 * Select CCHQ's two distinct temporal-add functions from the semantic type of
 * the authored date operand. `date-add` truncates to a date, while
 * `datetime-add` preserves the time component; choosing one from the interval
 * or from a string's spelling would silently change valid predicates.
 *
 * Production compilation supplies the same canonical `TypeContext` used by
 * the predicate validator, so typed property/input reads resolve here without
 * a second type table. Standalone emitter callers may omit it only when the
 * AST itself proves the result (`today`, `now`, explicit coercions, typed
 * temporal literals, or wrappers whose branches agree). Ambiguous reads throw
 * instead of guessing.
 */
function dateAddFunctionName(
	date: ValueExpression,
	typeContext?: TypeContext,
): "date-add" | "datetime-add" {
	const temporalType =
		resolveTemporalTypeFromContext(date, typeContext) ??
		inferStructuralTemporalType(date);
	if (temporalType === "date") return "date-add";
	if (temporalType === "datetime") return "datetime-add";

	throw new Error(
		[
			"csqlExpressionEmitter: cannot choose between CCHQ's date-add() and datetime-add() for this date-add expression.",
			"The wire functions have different result semantics, so the emitter will not guess from a property name, input name, interval, or runtime string.",
			typeContext === undefined
				? "Supply the canonical predicate TypeContext to emitCsql(), or make the date operand explicit with dateCoerce(...), datetimeCoerce(...), today(), now(), or a typed temporal literal."
				: "The supplied predicate TypeContext did not resolve the date operand to date or datetime. The validator should reject this expression before wire compilation.",
		].join(" "),
	);
}

function resolveTemporalTypeFromContext(
	expr: ValueExpression,
	typeContext: TypeContext | undefined,
): TemporalType | undefined {
	if (typeContext === undefined) return undefined;
	const errors: CheckError[] = [];
	const resolved = checkExpression(expr, typeContext, errors, []);
	if (errors.length > 0) return undefined;
	return asTemporalType(resolved);
}
