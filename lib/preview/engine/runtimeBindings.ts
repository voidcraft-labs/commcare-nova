// lib/preview/engine/runtimeBindings.ts
//
// Runtime-bindings layer for the running-app case list. Translates
// per-input typed values into ONE `Predicate` representing the
// input-driven contribution to the case-list query. AND-composition
// with the unified `caseListConfig.filter` slot happens at the
// helper layer (the case-store binding site) so this module ships
// only the contribution, not the composed query predicate.
//
// Pure module — no I/O, no `import "server-only"`, no `"use client"`
// directive — so server helpers AND client-side widgets can value-
// import one composition site without dragging the case-store's
// Cloud SQL graph through the client bundle.

import type {
	SearchInputDef,
	SearchInputMode,
	SearchInputType,
} from "@/lib/domain";
import type {
	Literal,
	Predicate,
	PropertyRef,
	SwitchCase,
	Term,
	ValueExpression,
} from "@/lib/domain/predicate";
import {
	between,
	dateLiteral,
	eq,
	literal,
	match,
	multiSelectAll,
	multiSelectAny,
	prop,
	reduceAnd,
	unhandledKindMessage,
} from "@/lib/domain/predicate";

/**
 * Search-input value bag. `<name>:from` / `<name>:to` for range
 * bounds; bare `<name>` otherwise. Empty / absent → input
 * contributes nothing.
 */
export type SearchInputValues = ReadonlyMap<string, string>;

/**
 * Compose every contributing search-input's runtime predicate into
 * one Predicate representing the input-driven contribution. Empty /
 * absent input values short-circuit per-input. Zero-input or all-
 * empty input returns `match-all` so the caller can AND-compose
 * unconditionally.
 *
 * `caseType` threads to every `prop(caseType, property, via?)` Term
 * construction so the predicate compiler can resolve the property's
 * `data_type` against the case-type schema map at SQL emission.
 */
export function composeRuntimeFilter(
	searchInputs: ReadonlyArray<SearchInputDef>,
	inputValues: SearchInputValues,
	caseType: string,
): Predicate {
	const clauses: Predicate[] = [];
	for (const input of searchInputs) {
		const clause = clauseForInput(input, inputValues, caseType);
		if (clause !== undefined) clauses.push(clause);
	}
	const reduced = reduceAnd(clauses);
	if (reduced !== undefined) return reduced;
	return { kind: "and", clauses: clauses as [Predicate, ...Predicate[]] };
}

function clauseForInput(
	input: SearchInputDef,
	inputValues: SearchInputValues,
	caseType: string,
): Predicate | undefined {
	switch (input.kind) {
		case "simple":
			return buildSimpleArmClause(input, inputValues, caseType);
		case "advanced":
			return buildAdvancedArmClause(input, inputValues);
		default: {
			const _exhaustive: never = input;
			throw new Error(
				unhandledKindMessage({
					where: "composeRuntimeFilter",
					family: "SearchInputDef",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: ["simple", "advanced"],
				}),
			);
		}
	}
}

/**
 * Simple-arm dispatch: `(property, mode, via)` → per-mode comparison.
 * The full `SearchInputMode` object (not just `kind`) drives the
 * switch so the multi-select arm's `quantifier` slot narrows
 * naturally. Range mode reads `:from` / `:to` keys; every other mode
 * reads the bare `<input.name>` key.
 */
function buildSimpleArmClause(
	input: Extract<SearchInputDef, { kind: "simple" }>,
	inputValues: SearchInputValues,
	caseType: string,
): Predicate | undefined {
	const mode = input.mode ?? defaultModeFor(input.type);
	if (mode.kind === "range") {
		return buildRangeClause(input, inputValues, caseType);
	}

	// Trim once at read so downstream `literal(value)` calls see the
	// normalized value — pasted-from-clipboard padding (`"  alice  "`)
	// must not silently bypass equality against unpadded case data.
	const value = inputValues.get(input.name)?.trim();
	if (value === undefined || value === "") return undefined;

	const property = prop(caseType, input.property, input.via);
	switch (mode.kind) {
		case "exact":
			return eq(property, literal(value));
		case "fuzzy":
			return match(property, literal(value), "fuzzy");
		case "starts-with":
			return match(property, literal(value), "starts-with");
		case "phonetic":
			return match(property, literal(value), "phonetic");
		case "fuzzy-date":
			return match(property, literal(value), "fuzzy-date");
		case "multi-select-contains":
			return buildMultiSelectClause(mode, property, value);
		default: {
			const _exhaustive: never = mode;
			throw new Error(
				unhandledKindMessage({
					where: "buildSimpleArmClause",
					family: "SearchInputMode",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"exact",
						"fuzzy",
						"starts-with",
						"phonetic",
						"fuzzy-date",
						"range",
						"multi-select-contains",
					],
				}),
			);
		}
	}
}

function buildMultiSelectClause(
	mode: Extract<SearchInputMode, { kind: "multi-select-contains" }>,
	property: PropertyRef,
	rawValue: string,
): Predicate | undefined {
	const tokens = rawValue
		.split(",")
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return undefined;
	// Explicit arrow defends against `Array.prototype.map`'s
	// `(value, index, array)` callback contract: `tokens.map(literal)`
	// would silently bind the per-token index to any second parameter
	// `literal` ever grows.
	const [first, ...rest] = tokens.map((token) => literal(token));
	if (mode.quantifier === "all") {
		return multiSelectAll(property, first, ...rest);
	}
	return multiSelectAny(property, first, ...rest);
}

function buildRangeClause(
	input: Extract<SearchInputDef, { kind: "simple" }>,
	inputValues: SearchInputValues,
	caseType: string,
): Predicate | undefined {
	const lower = parseDateBound(inputValues.get(`${input.name}:from`));
	const upper = parseDateBound(inputValues.get(`${input.name}:to`));
	if (lower === undefined && upper === undefined) return undefined;
	return between(prop(caseType, input.property, input.via), { lower, upper });
}

/**
 * Calendar validity is enforced at SQL emission via the `date` cast
 * in `compileLiteral`; this gate filters mid-edit shapes that would
 * crash the cast. Returns a bare `Literal` so `between(...)` lifts
 * it via `toValueExpression`.
 */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
function parseDateBound(raw: string | undefined): Literal | undefined {
	if (raw === undefined || raw === "") return undefined;
	if (!ISO_DATE_PATTERN.test(raw)) return undefined;
	return dateLiteral(raw);
}

/**
 * `multi-select-contains` is structurally excluded from the
 * default-mode table because its arm requires a `quantifier` slot
 * the table can't supply, and no `APPLICABLE_SEARCH_MODES` row
 * lists it first anyway.
 */
type DefaultableModeKind = Exclude<
	SearchInputMode["kind"],
	"multi-select-contains"
>;

const DEFAULT_SEARCH_MODE_KIND: Readonly<
	Record<SearchInputType, DefaultableModeKind>
> = {
	text: "exact",
	select: "exact",
	date: "exact",
	"date-range": "range",
	barcode: "exact",
};

function defaultModeFor(type: SearchInputType): SearchInputMode {
	return { kind: DEFAULT_SEARCH_MODE_KIND[type] };
}

/**
 * Advanced-arm dispatch: when the value is non-empty, recurse into
 * `substituteInputInPredicate` to bind the input ref at every value-
 * position match. The walker functions below are the authoritative
 * site for arm-by-arm substitution semantics.
 */
function buildAdvancedArmClause(
	input: Extract<SearchInputDef, { kind: "advanced" }>,
	inputValues: SearchInputValues,
): Predicate | undefined {
	// Trim once at read so the value substituted into every
	// `term(input(name))` slot is the normalized form — symmetric
	// with `buildSimpleArmClause`'s trim-once contract.
	const value = inputValues.get(input.name)?.trim();
	if (value === undefined || value === "") return undefined;
	return substituteInputInPredicate(input.predicate, input.name, value);
}

// Recursive substitution over `Predicate` / `ValueExpression` /
// `Term`. The rewriter rebuilds every operator envelope fresh and
// shares only literal-only / discriminator-only / non-substituting
// Term slots by reference. It never mutates a shared reference, so
// the input AST stays observable to its other consumers (Firestore
// persistence, zundo history) unchanged.

function substituteInputInPredicate(
	predicate: Predicate,
	targetName: string,
	value: string,
): Predicate {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
			return predicate;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return {
				kind: predicate.kind,
				left: substituteInputInExpression(predicate.left, targetName, value),
				right: substituteInputInExpression(predicate.right, targetName, value),
			};
		case "in":
			return {
				kind: "in",
				left: substituteInputInExpression(predicate.left, targetName, value),
				values: predicate.values,
			};
		case "within-distance":
			return {
				kind: "within-distance",
				property: predicate.property,
				center: substituteInputInExpression(
					predicate.center,
					targetName,
					value,
				),
				distance: predicate.distance,
				unit: predicate.unit,
			};
		case "match":
			return {
				kind: "match",
				property: predicate.property,
				value: substituteInputInExpression(predicate.value, targetName, value),
				mode: predicate.mode,
			};
		case "multi-select-contains":
			return {
				kind: "multi-select-contains",
				property: predicate.property,
				values: predicate.values,
				quantifier: predicate.quantifier,
			};
		case "between": {
			// Conditional-property-add preserves absent-not-undefined
			// (Zod's `.optional()` strips absent keys on parse).
			const next: Extract<Predicate, { kind: "between" }> = {
				kind: "between",
				left: substituteInputInExpression(predicate.left, targetName, value),
				lowerInclusive: predicate.lowerInclusive,
				upperInclusive: predicate.upperInclusive,
			};
			if (predicate.lower !== undefined) {
				next.lower = substituteInputInExpression(
					predicate.lower,
					targetName,
					value,
				);
			}
			if (predicate.upper !== undefined) {
				next.upper = substituteInputInExpression(
					predicate.upper,
					targetName,
					value,
				);
			}
			return next;
		}
		case "is-null":
			return {
				kind: "is-null",
				left: substituteInputInExpression(predicate.left, targetName, value),
			};
		case "is-blank":
			return {
				kind: "is-blank",
				left: substituteInputInExpression(predicate.left, targetName, value),
			};
		case "and":
			return {
				kind: "and",
				clauses: predicate.clauses.map((c) =>
					substituteInputInPredicate(c, targetName, value),
				) as [Predicate, ...Predicate[]],
			};
		case "or":
			return {
				kind: "or",
				clauses: predicate.clauses.map((c) =>
					substituteInputInPredicate(c, targetName, value),
				) as [Predicate, ...Predicate[]],
			};
		case "not":
			return {
				kind: "not",
				clause: substituteInputInPredicate(predicate.clause, targetName, value),
			};
		case "when-input-present":
			// The trigger slot is a `SearchInputRef` discriminator, not
			// a value-position term — substituting a literal would
			// violate the schema's `input: searchInputRefSchema` shape.
			// `buildAdvancedArmClause`'s empty-value short-circuit
			// already gates the entire advanced-arm contribution on the
			// trigger's runtime presence, so the wrap stays even when
			// the trigger's name matches the target.
			return {
				kind: "when-input-present",
				input: predicate.input,
				clause: substituteInputInPredicate(predicate.clause, targetName, value),
			};
		case "exists":
			return predicate.where === undefined
				? { kind: "exists", via: predicate.via }
				: {
						kind: "exists",
						via: predicate.via,
						where: substituteInputInPredicate(
							predicate.where,
							targetName,
							value,
						),
					};
		case "missing":
			return predicate.where === undefined
				? { kind: "missing", via: predicate.via }
				: {
						kind: "missing",
						via: predicate.via,
						where: substituteInputInPredicate(
							predicate.where,
							targetName,
							value,
						),
					};
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				unhandledKindMessage({
					where: "substituteInputInPredicate",
					family: "Predicate",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"match-all",
						"match-none",
						"and",
						"or",
						"not",
						"eq",
						"neq",
						"gt",
						"gte",
						"lt",
						"lte",
						"in",
						"between",
						"multi-select-contains",
						"match",
						"within-distance",
						"is-null",
						"is-blank",
						"when-input-present",
						"exists",
						"missing",
					],
				}),
			);
		}
	}
}

function substituteInputInExpression(
	expr: ValueExpression,
	targetName: string,
	value: string,
): ValueExpression {
	switch (expr.kind) {
		case "term":
			return substituteInputInTerm(expr.term, targetName, value);
		case "today":
		case "now":
			return expr;
		case "date-add":
			return {
				kind: "date-add",
				date: substituteInputInExpression(expr.date, targetName, value),
				interval: expr.interval,
				quantity: substituteInputInExpression(expr.quantity, targetName, value),
			};
		case "date-coerce":
			return {
				kind: "date-coerce",
				value: substituteInputInExpression(expr.value, targetName, value),
			};
		case "datetime-coerce":
			return {
				kind: "datetime-coerce",
				value: substituteInputInExpression(expr.value, targetName, value),
			};
		case "double":
			return {
				kind: "double",
				value: substituteInputInExpression(expr.value, targetName, value),
			};
		case "arith":
			return {
				kind: "arith",
				op: expr.op,
				left: substituteInputInExpression(expr.left, targetName, value),
				right: substituteInputInExpression(expr.right, targetName, value),
			};
		case "concat": {
			const parts = expr.parts.map((part) =>
				substituteInputInExpression(part, targetName, value),
			) as [ValueExpression, ...ValueExpression[]];
			return { kind: "concat", parts };
		}
		case "coalesce": {
			const values = expr.values.map((v) =>
				substituteInputInExpression(v, targetName, value),
			) as [ValueExpression, ...ValueExpression[]];
			return { kind: "coalesce", values };
		}
		case "if":
			return {
				kind: "if",
				cond: substituteInputInPredicate(expr.cond, targetName, value),
				// biome-ignore lint/suspicious/noThenProperty: AST shape mirrors `ifSchema`; `then` holds a ValueExpression object, never a callable. Full thenable-hazard analysis lives on `ifSchema` in `lib/domain/predicate/types.ts`.
				then: substituteInputInExpression(expr.then, targetName, value),
				else: substituteInputInExpression(expr.else, targetName, value),
			};
		case "switch": {
			const cases = expr.cases.map((c) => ({
				when: c.when,
				// biome-ignore lint/suspicious/noThenProperty: AST shape mirrors `switchCaseSchema`; `then` holds a ValueExpression object, never a callable.
				then: substituteInputInExpression(c.then, targetName, value),
			})) as [SwitchCase, ...SwitchCase[]];
			return {
				kind: "switch",
				on: substituteInputInExpression(expr.on, targetName, value),
				cases,
				fallback: substituteInputInExpression(expr.fallback, targetName, value),
			};
		}
		case "count":
			return expr.where === undefined
				? { kind: "count", via: expr.via }
				: {
						kind: "count",
						via: expr.via,
						where: substituteInputInPredicate(expr.where, targetName, value),
					};
		case "unwrap-list":
			return {
				kind: "unwrap-list",
				value: substituteInputInExpression(expr.value, targetName, value),
			};
		case "format-date":
			return {
				kind: "format-date",
				date: substituteInputInExpression(expr.date, targetName, value),
				pattern: expr.pattern,
			};
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				unhandledKindMessage({
					where: "substituteInputInExpression",
					family: "ValueExpression",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"term",
						"today",
						"now",
						"date-add",
						"date-coerce",
						"datetime-coerce",
						"double",
						"arith",
						"concat",
						"coalesce",
						"if",
						"switch",
						"count",
						"unwrap-list",
						"format-date",
					],
				}),
			);
		}
	}
}

function substituteInputInTerm(
	node: Term,
	targetName: string,
	value: string,
): ValueExpression {
	switch (node.kind) {
		case "input":
			if (node.name === targetName) {
				return { kind: "term", term: { kind: "literal", value } };
			}
			return { kind: "term", term: node };
		case "prop":
		case "session-user":
		case "session-context":
		case "literal":
			return { kind: "term", term: node };
		default: {
			const _exhaustive: never = node;
			throw new Error(
				unhandledKindMessage({
					where: "substituteInputInTerm",
					family: "Term",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"prop",
						"input",
						"session-user",
						"session-context",
						"literal",
					],
				}),
			);
		}
	}
}
