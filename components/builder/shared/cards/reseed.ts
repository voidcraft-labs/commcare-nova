// components/builder/shared/cards/reseed.ts
//
// Cascade-reseed helpers for the valid-by-construction card editor.
// When a subject choice (a comparison's left, a switch's `on`, a
// between's anchor) changes and tightens what a dependent value slot
// may hold, the editing card reseeds the dependent slot IN THE SAME
// onChange so the committed AST is never transiently type-incorrect.
//
// The reseed CARRIES the typed content where the new accept-set can
// hold it (an int `5` becomes the text `"5"`; a "42" string becomes
// the number `42`) and otherwise drops to an empty typed literal of an
// accepted type — never a value the new constraint would reject. The
// accept-set itself comes from the same checker rule the slot's picker
// gates on (`compatibleTypesFor` → `typesCompatible`), so a reseed can
// never land outside what the editor would have offered.
//
// `resolveExpressionType` is the imperative twin of the
// `editorContext` hook `useResolvedType`: a card resolves the type of
// a value it just BUILT (the new subject) inside its onChange handler,
// where a hook can't run, to decide whether the dependent slot's
// existing value still fits.

import {
	type CaseProperty,
	type CaseType,
	effectiveDataType,
} from "@/lib/domain";
import {
	checkExpression,
	checkPredicate,
	compatibleTypesFor,
	dateLiteral,
	datetimeLiteral,
	type Literal,
	literal,
	matchAll,
	type Predicate,
	type RelationPath,
	type ResolvedType,
	type SearchInputDecl,
	term,
	timeLiteral,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { resolveRelationDestination } from "../relationDestination";

/** The editor context shape a card already holds via
 *  `usePredicateEditContext()` — enough to drive a checker pass. */
interface ResolveContext {
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly SearchInputDecl[];
}

/**
 * Resolve a value expression's type against the editor scope, the same
 * way `useResolvedType` does, but callable from inside an event
 * handler (where hooks can't run). Returns `undefined` for an absent
 * or unresolved expression — the constraint factories read that as
 * "no narrowing", so an incomplete subject never forces a reseed.
 */
export function resolveExpressionType(
	expr: ValueExpression | undefined,
	ctx: ResolveContext,
): ResolvedType | undefined {
	if (expr === undefined) return undefined;
	return checkExpression(
		expr,
		{
			caseTypes: [...ctx.caseTypes],
			knownInputs: [...ctx.knownInputs],
			currentCaseType: ctx.currentCaseType,
		},
		[],
		[],
	);
}

// The literal types the editor can construct an EMPTY typed value for,
// in the order a reseed prefers them. `geopoint` has no literal widget
// (a coordinate is authored as text or read from a property), and the
// sentinels (`_any` / `_sequence`) never carry user content — a slot
// that admits only those falls through to the universally-compatible
// `null` literal.
const BUILDABLE_TYPES: readonly ResolvedType[] = [
	"text",
	"int",
	"decimal",
	"date",
	"datetime",
	"time",
];

const TEXT_SHAPED: readonly ResolvedType[] = [
	"text",
	"single_select",
	"multi_select",
];

function setHasAny(
	accepts: ReadonlySet<ResolvedType>,
	types: readonly ResolvedType[],
): boolean {
	return types.some((t) => accepts.has(t));
}

/** An empty literal whose resolved type IS `t` — the seed for a slot
 *  whose old value can't carry into the new accept-set. */
function emptyLiteralForType(t: ResolvedType): Literal {
	switch (t) {
		case "int":
		case "decimal":
			return literal(0);
		case "date":
			return dateLiteral("");
		case "datetime":
			return datetimeLiteral("");
		case "time":
			return timeLiteral("");
		default:
			// text / single_select / multi_select all author as a plain
			// string; the select kinds compare-widen to text.
			return literal("");
	}
}

/**
 * Build a `Literal` valid for `accepts`, carrying `old`'s primitive
 * content where a target type can hold it:
 *   - a text-shaped target keeps the printed form verbatim (int `5` →
 *     text `"5"`);
 *   - a numeric target parses a non-empty value (`"42"` → `42`);
 *   - otherwise an empty typed literal of the first buildable accepted
 *     type, or `null` (universally compatible) when nothing is
 *     buildable (a geopoint-only slot).
 */
export function reseedLiteralForConstraint(
	old: Literal,
	accepts: ReadonlySet<ResolvedType>,
): Literal {
	const value = old.value;
	const carriable =
		(typeof value === "string" && value !== "") || typeof value === "number";
	if (carriable) {
		if (setHasAny(accepts, TEXT_SHAPED)) {
			return literal(String(value));
		}
		if (accepts.has("int") || accepts.has("decimal")) {
			const asNumber = typeof value === "number" ? value : Number(value);
			if (Number.isFinite(asNumber)) return literal(asNumber);
		}
	}
	for (const t of BUILDABLE_TYPES) {
		if (accepts.has(t)) return emptyLiteralForType(t);
	}
	return literal(null);
}

/**
 * Build a `ValueExpression` valid for `accepts`. A bare literal term
 * carries its content through `reseedLiteralForConstraint`; any other
 * shape (a now type-incompatible computed expression) drops to a fresh
 * compatible literal. The result is always a `term`-arm value.
 */
export function reseedValueForConstraint(
	old: ValueExpression,
	accepts: ReadonlySet<ResolvedType>,
): ValueExpression {
	const sourceLiteral =
		old.kind === "term" && old.term.kind === "literal" ? old.term : literal("");
	return term(reseedLiteralForConstraint(sourceLiteral, accepts));
}

/**
 * A type-valid EMPTY seed literal for a property slot — an empty value
 * of the property's OWN type (text `""`, numeric `0`, date / datetime /
 * time empty-string, geopoint `null`). A default-built comparison /
 * membership / range pairs this with the property so the seed lands
 * type-correct rather than the bug class where a text `literal("")` sits
 * opposite an ordered or non-text property. An absent property (no
 * resolvable type) seeds plain text — the unresolved property surfaces
 * its own completeness error, and the value is never type-checked
 * against an unresolved left.
 */
export function seedLiteralForProperty(
	property: CaseProperty | undefined,
): Literal {
	const accepts = compatibleTypesFor(
		property === undefined ? undefined : effectiveDataType(property),
	);
	return reseedLiteralForConstraint(literal(""), accepts);
}

/**
 * The `where` clause a relational quantifier (`exists` / `missing` /
 * `count`) should carry after its `via` walk changes destination. A
 * where-clause's property refs resolve against the walk's DESTINATION
 * scope; when the destination changes, refs anchored on the old
 * destination no longer resolve, so the clause resets to `matchAll()`
 * (the canonical always-true starting point) in the SAME onChange. An
 * absent clause stays absent; an unresolvable new walk keeps the
 * clause untouched (the editor surfaces "pick a valid connection"
 * rather than discarding the author's work over a transient walk).
 */
export function rescopeWhereForVia(
	where: Predicate | undefined,
	via: RelationPath,
	ctx: ResolveContext,
): Predicate | undefined {
	if (where === undefined) return undefined;
	const destination = resolveRelationDestination(via, ctx.currentCaseType, [
		...ctx.caseTypes,
	]);
	if (destination === undefined) return where;
	const result = checkPredicate(where, {
		caseTypes: [...ctx.caseTypes],
		knownInputs: [...ctx.knownInputs],
		currentCaseType: destination,
	});
	return result.ok ? where : matchAll();
}
