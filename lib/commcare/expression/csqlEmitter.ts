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
// (`commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:27-36`).
// The remaining seven arms (`arith`, `concat`, `coalesce`, `if`,
// `switch`, `count`, `format-date`) lift in the predicate-side hoist
// pass at `lib/commcare/predicate/csqlHoist.ts` before this emitter
// ever sees them — by the time a `ValueExpression` reaches this
// surface, every non-whitelist shape has been replaced with a
// synthetic `term`-arm input ref and the original expression lives on
// the wrapper-expression list.
//
// If the bypass path ever surfaced one of the seven non-whitelist
// arms, the emitter throws with a "should have been hoisted" message
// rather than emit broken CSQL. Same exhaustive-defense pattern as
// `lib/commcare/predicate/csqlEmitter.ts`'s `unwrapTermFromExpression`.
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
//     constant segments. CCHQ registrations at lines 33-34 of the
//     whitelist.
//   - `date-coerce(value)` → `date(<value>)`; `datetime-coerce(value)`
//     → `datetime(<value>)`. AST kind names diverge from wire function
//     names; emitter performs the rename. Registrations at lines 28
//     and 30.
//   - `double(value)` → `double(<value>)`. Forced numeric coercion.
//     Registration at line 32.
//   - `date-add(value, interval, quantity)` → `date-add(<value>,
//     '<interval>', <quantity>)`. CCHQ wire signature per
//     `commcare-hq/corehq/apps/case_search/xpath_functions/value_functions.py:115`
//     (`date-add('2022-01-01', 'days', -1) => '2021-12-31'`) — three
//     separate arguments. Whitelist registrations at lines 29 and 31
//     cover both `date-add` and `datetime-add`; the AST `date-add`
//     kind covers both wire forms via the `interval` discriminator.
//   - `unwrap-list(value)` → `unwrap-list(<value>)`. Sequence-source
//     value function. Registration at line 35.
//   - `term(t)` → delegate to the shared CSQL term-segment emitter at
//     `../predicate/termEmitter:emitTermSegment`. Property refs and
//     literals emit as constant segments; runtime refs emit as
//     `runtime` segments wrapped in CSQL double-quote brackets.

import type { ValueExpression } from "@/lib/domain/predicate/types";
import type { CsqlSegment } from "../predicate/csqlSegment";
import { quoteLiteral } from "../predicate/stringQuoting";
import { emitTermSegment } from "../predicate/termEmitter";

/**
 * Compile a `ValueExpression` AST to its CSQL `CsqlSegment[]` IR. The
 * caller composes the segments with surrounding constants (operator
 * tokens, comparison operators, etc.) and routes the final list
 * through the predicate-side wrap layer (`wrapInConcat` in
 * `../predicate/csqlEmitter.ts`) to produce the on-device XPath
 * `concat(...)` wrapper.
 *
 * The emitter is total over CSQL's value-function whitelist arms;
 * the seven non-whitelist arms throw a defensive error because the
 * predicate-side hoist pass should have lifted them before this
 * emitter ran.
 */
export function emitCsqlExpressionSegments(
	expr: ValueExpression,
): CsqlSegment[] {
	switch (expr.kind) {
		case "term": {
			// Structural lifter: any `Term` flows through the shared
			// CSQL term-segment emitter. The expression emitter
			// emits in function-call-argument position — the wire form
			// inside a CSQL value function (`date(<value>)`,
			// `double(<value>)`, etc.) accepts the runtime XPath result
			// as a raw value, NOT wrapped in CSQL double-quote brackets.
			// The predicate-side comparison-operand caller wraps the
			// outermost runtime ref via `wrapTermAsSegmentList` because
			// CSQL value-position equality (`<prop> = "<value>"`)
			// requires the double-quote brackets per the canonical
			// pattern at
			// `commcare-hq/docs/case_search_query_language.rst:403-407`.
			//
			// Constant arms (property refs, literals) emit as one
			// constant segment regardless of position.
			const inner = emitTermSegment(expr.term);
			if (inner.kind === "constant") {
				return [{ kind: "constant", text: inner.text }];
			}
			return [{ kind: "runtime", xpath: inner.xpath }];
		}
		case "today":
			// CCHQ value function at
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:33`.
			return [{ kind: "constant", text: "today()" }];
		case "now":
			// CCHQ value function at
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:34`.
			return [{ kind: "constant", text: "now()" }];
		case "date-coerce":
			// AST `date-coerce(value)` → wire `date(<value>)`. CCHQ
			// registration at line 28.
			return emitFunctionCallSegments(
				"date",
				emitCsqlExpressionSegments(expr.value),
			);
		case "datetime-coerce":
			// AST `datetime-coerce(value)` → wire `datetime(<value>)`.
			// CCHQ registration at line 30.
			return emitFunctionCallSegments(
				"datetime",
				emitCsqlExpressionSegments(expr.value),
			);
		case "double":
			// CCHQ value function at line 32.
			return emitFunctionCallSegments(
				"double",
				emitCsqlExpressionSegments(expr.value),
			);
		case "date-add":
			// CCHQ wire signature: `date-add(date, interval, quantity)`
			// — three separate arguments. Source citation:
			// `commcare-hq/corehq/apps/case_search/xpath_functions/value_functions.py:115`
			// (`date-add('2022-01-01', 'days', -1) => '2021-12-31'`).
			// Interval flows through `quoteLiteral(..., "csql")` because
			// it is a CSQL string literal at the wire layer; the
			// schema's `DATE_ADD_INTERVALS` enum already constrains the
			// value space, but routing through the shared lexical helper
			// keeps the escape rule centralised.
			return emitDateAddSegments(expr);
		case "unwrap-list":
			// CCHQ value function at line 35.
			return emitFunctionCallSegments(
				"unwrap-list",
				emitCsqlExpressionSegments(expr.value),
			);
		case "arith":
		case "concat":
		case "coalesce":
		case "if":
		case "switch":
		case "count":
		case "format-date":
			// These seven arms are absent from CSQL's value-function
			// whitelist. The predicate-side hoist pass at
			// `lib/commcare/predicate/csqlHoist.ts` lifts every non-
			// whitelist arm into an on-device wrapper expression before
			// the predicate emitter calls into this surface, replacing
			// the lifted node with a synthetic `term`-arm input ref. If
			// the bypass path ever surfaced one of these arms here, the
			// throw defends against emitting broken CSQL.
			throw new Error(
				`csqlExpressionEmitter: ValueExpression arm '${expr.kind}' should have been hoisted before this emitter ran. The CSQL value-function whitelist (commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:27-36) does not include this arm; the predicate-side hoist pass at lib/commcare/predicate/csqlHoist.ts is the wire-encoding solution.`,
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

/**
 * Emit `date-add(<date>, '<interval>', <quantity>)` as a segment list.
 * CCHQ's `_date_or_datetime_add` calls `confirm_args_count(node, 3)`
 * at `commcare-hq/corehq/apps/case_search/xpath_functions/value_functions.py:135`,
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
): CsqlSegment[] {
	const dateSegments = emitCsqlExpressionSegments(expr.date);
	const intervalLiteral = quoteLiteral(expr.interval, "csql");
	const quantitySegments = emitCsqlExpressionSegments(expr.quantity);
	return [
		{ kind: "constant", text: "date-add(" },
		...dateSegments,
		{ kind: "constant", text: `, ${intervalLiteral}, ` },
		...quantitySegments,
		{ kind: "constant", text: ")" },
	];
}
