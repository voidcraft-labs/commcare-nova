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

import {
	type CasePropertyDataType,
	type CaseType,
	DEFAULT_SEARCH_MODE_KIND,
	type SearchInputDef,
	type SearchInputMode,
	type SearchInputType,
	searchInputRuntimeValueType,
	type Uuid,
} from "@/lib/domain";
import type {
	AstMapHooks,
	Predicate,
	ValueExpression,
} from "@/lib/domain/predicate";
import {
	dateLiteral,
	dateRangeSearchPredicate,
	eq,
	exactDateSearchPredicate,
	isIn,
	literal,
	mapExpressionAst,
	mapPredicateAst,
	match,
	prop,
	qualifiedLiteral,
	reduceAnd,
	term,
	unhandledKindMessage,
} from "@/lib/domain/predicate";
import { walkExpressionTerms, walkTerms } from "@/lib/domain/predicate/walk";
import {
	dateRangeInputErrors,
	ISO_DATE_PATTERN,
	isValidCalendarDate,
	SearchInputValuesError,
} from "./dateRangeInputValidation";

/**
 * Wire-form date shape — the ISO `YYYY-MM-DD` pattern this module
 * gates against before handing values to date-coercing builders.
 * Exported so the running-app `SearchInputForm` widget gates date
 * values through the same pattern before handing them to
 * `parseISO`, keeping both surfaces honoring one definition rather
 * than maintaining a parallel regex by comment.
 */
export { ISO_DATE_PATTERN };

/**
 * Search-input value bag. `<name>:from` / `<name>:to` for range
 * bounds; bare `<name>` otherwise. Empty / absent → input
 * contributes nothing.
 */
export type SearchInputValues = ReadonlyMap<string, string>;

type SearchInputRuntimeValueType = CasePropertyDataType;

interface RuntimeInputBinding {
	readonly uuid: Uuid;
	readonly name: string;
	readonly runtimeValueType?: SearchInputRuntimeValueType;
}

/**
 * Wire form of {@link SearchInputValues} — a plain object, NOT a `Map`.
 *
 * The case-list search action carries this bag from client to server.
 * React encodes a Server Action call as `multipart/form-data` the moment
 * any argument holds a non-plain-JSON value (a `Map`, `Set`, `File`, …),
 * and a multipart envelope trips the edge WAF's CRS protocol-attack rule
 * (the `\r\nContent-Disposition: form-data; name=` part-header reads as
 * header injection). A plain object keeps the whole call a `text/plain`
 * JSON body, so the value bag crosses as an object and rehydrates to a
 * `Map` on each side.
 */
export type SearchInputValuesWire = Record<string, string>;

/** {@link SearchInputValues} → {@link SearchInputValuesWire} for the wire. */
export function searchInputValuesToWire(
	values: SearchInputValues,
): SearchInputValuesWire {
	return Object.fromEntries(values);
}

/** {@link SearchInputValuesWire} → {@link SearchInputValues} after the wire. */
export function searchInputValuesFromWire(
	values: SearchInputValuesWire,
): SearchInputValues {
	return new Map(Object.entries(values));
}

/**
 * Add the scalar value CommCare exposes for a completed `daterange` prompt to
 * expression-driven bindings. Nova keeps two independent UI/SQL keys
 * (`<name>:from` / `<name>:to`), while CommCare's search-input instance stores
 * one bare `<name>` value encoded as `__range__<from>__<to>`. Advanced input
 * predicates and sibling expressions such as excluded-owner ids read that bare
 * key, so they need the device-form projection in addition to the split bounds.
 *
 * A one-sided Nova range has no equivalent device scalar — CommCare's range
 * picker commits a pair — so the bare key stays absent until both valid bounds
 * exist. Delete any caller-supplied bare value first so stale state cannot make
 * a partial range look complete.
 */
export function withSearchInputExpressionValues(
	searchInputs: readonly SearchInputDef[],
	inputValues: SearchInputValues,
): SearchInputValues {
	const expressionValues = new Map(inputValues);
	for (const input of searchInputs) {
		if (input.kind === "hidden" || input.type !== "date-range") continue;
		expressionValues.delete(input.name);
		const from = validDateBound(inputValues.get(`${input.name}:from`));
		const to = validDateBound(inputValues.get(`${input.name}:to`));
		if (from !== undefined && to !== undefined && from <= to) {
			expressionValues.set(input.name, `__range__${from}__${to}`);
		}
	}
	return expressionValues;
}

/**
 * Bind every `input(name)` leaf in a ValueExpression to the current running
 * search value. The preview XPath evaluator is scalar and intentionally does
 * not model the search-input XML nodeset, so substitution happens while the
 * expression is still a typed AST. Missing inputs become the empty string —
 * the same value CommCare's virtual search-input instance exposes for an
 * unanswered prompt.
 */
export function bindSearchInputValuesInExpression(
	expression: ValueExpression,
	inputValues: SearchInputValues,
	searchInputs: readonly SearchInputDef[] = [],
): ValueExpression {
	const runtimeBindings = searchInputRuntimeBindings(searchInputs);
	const uuids = new Set<Uuid>();
	walkExpressionTerms(expression, (term) => {
		if (term.kind === "input") uuids.add(term.searchInputUuid);
	});

	let bound = expression;
	for (const uuid of uuids) {
		const input = runtimeBindings.get(uuid);
		if (input === undefined) continue;
		bound = substituteInputInExpression(
			bound,
			input,
			inputValues.get(input.name) ?? "",
			true,
		);
	}
	return bound;
}

/**
 * Bind declared search-input refs in an authored Predicate and resolve each
 * matching `when-input-present` gate from that input's own submitted value.
 * Unknown refs deliberately stay structural: validation rejects them, and a
 * bypassed invalid ref should not be silently rewritten as an empty answer.
 *
 * Callers must pass expression-projected values (see
 * {@link withSearchInputExpressionValues}) so completed date ranges expose the
 * same bare scalar that CommCare's search-input instance does.
 *
 * Values bind RAW — never trimmed or normalized. CommCare stores the typed
 * answer byte-for-byte (`commcare-core
 * RemoteQuerySessionManager.answerUserPrompt` → the `search-input` virtual
 * instance) and interpolates it verbatim into `_xpath_query`, so a
 * whitespace-padded answer matches nothing on the deployed app; Preview must
 * agree rather than quietly matching the trimmed spelling. The sibling
 * expression binder above binds the same raw value.
 */
export function bindSearchInputValuesInPredicate(
	predicate: Predicate,
	inputValues: SearchInputValues,
	knownInputUuids: ReadonlySet<Uuid>,
	searchInputs: readonly SearchInputDef[] = [],
): Predicate {
	const runtimeBindings = searchInputRuntimeBindings(searchInputs);
	const referencedUuids = new Set<Uuid>();
	walkTerms(predicate, (term) => {
		if (term.kind === "input") referencedUuids.add(term.searchInputUuid);
	});

	let bound = predicate;
	for (const uuid of referencedUuids) {
		if (!knownInputUuids.has(uuid)) continue;
		const input = runtimeBindings.get(uuid);
		if (input === undefined) continue;
		bound = substituteInputInPredicate(
			bound,
			input,
			inputValues.get(input.name) ?? "",
			true,
		);
	}
	return bound;
}

/**
 * Compose every contributing search-input's runtime predicate into
 * one Predicate representing the input-driven contribution. Empty /
 * absent simple inputs short-circuit per-input. Advanced predicates
 * always contribute: their authored `when-input-present` nodes are
 * the sole source of input-presence gating, matching wire emission.
 * Zero-input or all-empty simple input returns `match-all` so the
 * caller can AND-compose unconditionally.
 *
 * `caseType` threads to every `prop(caseType, property, via?)` Term
 * construction so the predicate compiler can resolve the property's
 * `data_type` against the case-type schema map at SQL emission.
 */
export function composeRuntimeFilter(
	searchInputs: ReadonlyArray<SearchInputDef>,
	inputValues: SearchInputValues,
	caseType: string,
	caseTypeSchemas?: ReadonlyMap<string, CaseType>,
): Predicate {
	const rangeErrors = dateRangeInputErrors(searchInputs, inputValues);
	if (rangeErrors.size > 0) throw new SearchInputValuesError(rangeErrors);

	const expressionValues = withSearchInputExpressionValues(
		searchInputs,
		inputValues,
	);
	const knownInputUuids = new Set(searchInputs.map((input) => input.uuid));
	const clauses: Predicate[] = [];
	for (const input of searchInputs) {
		const clause = clauseForInput(
			input,
			expressionValues,
			caseType,
			knownInputUuids,
			searchInputs,
			caseTypeSchemas,
		);
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
	knownInputUuids: ReadonlySet<Uuid>,
	searchInputs: readonly SearchInputDef[],
	caseTypeSchemas?: ReadonlyMap<string, CaseType>,
): Predicate | undefined {
	switch (input.kind) {
		// A hidden input seeds the search-input instance for `input(...)`
		// reads; it never matches a case property of its own.
		case "hidden":
			return undefined;
		case "simple":
			return buildSimpleArmClause(
				input,
				inputValues,
				caseType,
				caseTypeSchemas,
			);
		case "advanced":
			return buildAdvancedArmClause(
				input,
				inputValues,
				knownInputUuids,
				searchInputs,
			);
		default: {
			const _exhaustive: never = input;
			throw new Error(
				unhandledKindMessage({
					where: "composeRuntimeFilter",
					family: "SearchInputDef",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: ["simple", "advanced", "hidden"],
				}),
			);
		}
	}
}

/**
 * Simple-arm dispatch: `(property, mode, via)` → per-mode comparison.
 * Range mode reads `:from` / `:to` keys; every other mode reads the bare
 * `<input.name>` key.
 */
function buildSimpleArmClause(
	input: Extract<SearchInputDef, { kind: "simple" }>,
	inputValues: SearchInputValues,
	caseType: string,
	caseTypeSchemas?: ReadonlyMap<string, CaseType>,
): Predicate | undefined {
	const mode = input.mode ?? defaultModeFor(input.type);
	if (mode.kind === "range") {
		return buildRangeClause(input, inputValues, caseType, caseTypeSchemas);
	}

	// The typed value binds RAW. CommCare sends a prompt's answer
	// byte-for-byte (web-apps `query.js::encodeValue` → formplayer →
	// `RemoteQuerySessionManager`), and the runtime's auto-match / CSQL
	// comparison uses it verbatim — so a whitespace-padded answer matches
	// nothing on the deployed app, and Preview must agree rather than
	// quietly matching the trimmed spelling.
	const value = inputValues.get(input.name);
	if (value === undefined || value === "") return undefined;

	const property = prop(caseType, input.property, input.via);
	switch (mode.kind) {
		case "exact": {
			if (input.type === "date") {
				const day = validDateBound(value);
				if (day === undefined) return undefined;
				if (caseTypeSchemas === undefined) {
					throw new Error(
						`Cannot bind the exact calendar-day search input "${input.name}" without case-type schemas. Date and datetime targets use different half-open boundary types; pass the live blueprint schema map instead of guessing from the widget alone.`,
					);
				}
				return exactDateSearchPredicate({
					caseType,
					property: input.property,
					via: input.via,
					day: term(dateLiteral(day)),
					typeContext: {
						caseTypes: [...caseTypeSchemas.values()],
						currentCaseType: caseType,
						knownInputs: [],
					},
				});
			}
			if (input.type === "multi-select") {
				// CommCare stores several chosen values as one space-separated
				// answer and splits it into repeated query parameters
				// (`RemoteQuerySessionManager.extractMultipleChoices`), which
				// the search endpoint matches as any-of. Preview mirrors that
				// with one `in` over the chosen values.
				const [first, ...rest] = value
					.split(" ")
					.filter((token) => token !== "")
					.map((token) => literal(token));
				if (first === undefined) return undefined;
				return isIn(property, first, ...rest);
			}
			return eq(property, literal(value));
		}
		case "fuzzy":
			return match(property, literal(value), "fuzzy");
		case "starts-with":
			return match(property, literal(value), "starts-with");
		case "phonetic":
			return match(property, literal(value), "phonetic");
		case "fuzzy-date":
			return match(property, literal(value), "fuzzy-date");
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
					],
				}),
			);
		}
	}
}

function buildRangeClause(
	input: Extract<SearchInputDef, { kind: "simple" }>,
	inputValues: SearchInputValues,
	caseType: string,
	caseTypeSchemas?: ReadonlyMap<string, CaseType>,
): Predicate | undefined {
	const lower = validDateBound(inputValues.get(`${input.name}:from`));
	const upper = validDateBound(inputValues.get(`${input.name}:to`));
	if (lower === undefined && upper === undefined) return undefined;
	// `composeRuntimeFilter` validates the complete pair before dispatch. Keep
	// this private helper defensive so a future direct caller cannot silently
	// resurrect Preview-only one-sided daterange semantics.
	if (lower === undefined || upper === undefined) {
		throw new Error(
			`Cannot bind date-range input "${input.name}" without both bounds. CommCare serializes daterange as one start/end pair; validate the submitted values before composing the runtime predicate.`,
		);
	}
	if (caseTypeSchemas === undefined) {
		throw new Error(
			`Cannot bind date-range input "${input.name}" without case-type schemas. Date and datetime targets use different final-day boundaries; pass the live blueprint schema map instead of guessing from the widget.`,
		);
	}
	return dateRangeSearchPredicate({
		caseType,
		property: input.property,
		via: input.via,
		lowerDay: term(dateLiteral(lower)),
		upperDay: term(dateLiteral(upper)),
		typeContext: {
			caseTypes: [...caseTypeSchemas.values()],
			currentCaseType: caseType,
			knownInputs: [],
		},
	});
}

/**
 * Calendar validity is enforced here, not at the SQL boundary. The
 * Postgres `date` cast in `compileLiteral` rejects calendar-invalid
 * values (`"2024-13-45"`) at query-execution time — surfaced to the
 * running-app surface as an opaque SQL error rather than the
 * widget's "no bound contributed" no-op. The regex gate filters
 * shape ("digits and dashes"); the `isValid(parseISO(raw))` gate
 * filters calendar correctness (month ≤ 12, day ≤ days-in-month).
 * Either failure drops the bound entirely so the binding layer
 * AND-composes only valid clauses.
 */
function validDateBound(raw: string | undefined): string | undefined {
	const value = raw?.trim();
	if (value === undefined || value === "") return undefined;
	return isValidCalendarDate(value) ? value : undefined;
}

function defaultModeFor(type: SearchInputType): SearchInputMode {
	return { kind: DEFAULT_SEARCH_MODE_KIND[type] };
}

/**
 * Advanced-arm dispatch: bind every declared input ref the predicate reads
 * and resolve its matching presence gate. The input whose metadata owns this
 * predicate is not an implicit gate: an advanced predicate may be constant,
 * may depend only on sibling inputs, or may describe its own presence behavior
 * explicitly with `when-input-present`. This mirrors the emitted `_xpath_query`,
 * which always includes the authored predicate.
 */
function buildAdvancedArmClause(
	input: Extract<SearchInputDef, { kind: "advanced" }>,
	inputValues: SearchInputValues,
	knownInputUuids: ReadonlySet<Uuid>,
	searchInputs: readonly SearchInputDef[],
): Predicate {
	return bindSearchInputValuesInPredicate(
		input.predicate,
		inputValues,
		knownInputUuids,
		searchInputs,
	);
}

/**
 * Resolve the semantic scalar a prompt contributes when an `input(name)` leaf
 * is replaced with its submitted value. The widget is the authority: a date
 * prompt still binds a date when its simple arm targets a datetime property,
 * while a date-range prompt binds CCHQ's encoded range string. Keeping this
 * projection beside substitution prevents the SQL compiler from having to
 * guess a temporal type from a string after the input leaf has disappeared.
 */
function searchInputRuntimeBindings(
	searchInputs: readonly SearchInputDef[],
): ReadonlyMap<Uuid, RuntimeInputBinding> {
	return new Map(
		searchInputs.map((input) => [
			input.uuid,
			{
				uuid: input.uuid,
				name: input.name,
				runtimeValueType: searchInputRuntimeValueType(input),
			},
		]),
	);
}

// Input substitution over `Predicate` / `ValueExpression`. Implemented
// as hooks over the shared structure-preserving mapper
// (`lib/domain/predicate/mapAst.ts`): an `input` term matching the
// target becomes a typed literal, and a matching `when-input-present`
// gate resolves to the same two wire outcomes the search-input
// instance produces (answered -> inner clause, unanswered -> match-all
// no-op). The mapper shares untouched subtrees by reference and
// descends through every recursive slot — including a
// `table-lookup`'s row-filter `where`, whose `table-column` terms
// simply pass through — so the input AST stays observable to its
// other consumers (Postgres persistence, the undo history) unchanged.

function substitutionHooks(
	target: RuntimeInputBinding,
	value: string,
	resolvePresence: boolean,
): AstMapHooks {
	const hooks: AstMapHooks = {
		mapTerm: (node) => {
			if (node.kind !== "input" || node.searchInputUuid !== target.uuid) {
				return undefined;
			}
			const replacement =
				target.runtimeValueType === undefined ||
				target.runtimeValueType === "text"
					? literal(value)
					: qualifiedLiteral(value, target.runtimeValueType);
			return { kind: "term", term: replacement };
		},
		mapPredicate: (predicate) => {
			if (
				!resolvePresence ||
				predicate.kind !== "when-input-present" ||
				predicate.input.searchInputUuid !== target.uuid
			) {
				// A gate for another input stays structural during this pass. The
				// binding pass for that declared name resolves it from its own
				// value; an unknown name remains intact for validation to reject.
				return undefined;
			}
			/* Preview has no search-input XML instance at query/evaluation time.
			 * Resolve the structural gate directly to the same two wire outcomes:
			 * answered -> inner clause; unanswered -> match-all no-op. */
			return value === ""
				? { kind: "match-all" }
				: mapPredicateAst(predicate.clause, hooks);
		},
	};
	return hooks;
}

function substituteInputInPredicate(
	predicate: Predicate,
	target: RuntimeInputBinding,
	value: string,
	resolvePresence = false,
): Predicate {
	return mapPredicateAst(
		predicate,
		substitutionHooks(target, value, resolvePresence),
	);
}

function substituteInputInExpression(
	expr: ValueExpression,
	target: RuntimeInputBinding,
	value: string,
	resolvePresence = false,
): ValueExpression {
	return mapExpressionAst(
		expr,
		substitutionHooks(target, value, resolvePresence),
	);
}
