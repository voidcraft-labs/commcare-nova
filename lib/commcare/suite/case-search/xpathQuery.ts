// lib/commcare/suite/case-search/xpathQuery.ts
//
// Shared `_xpath_query` composer. Two wire surfaces consume the
// composition: the suite-XML emitter at `searchSession.ts` (slots
// the result into a `<data key="_xpath_query">` element on
// `<query>`) and the HQ-JSON emitter at `lib/commcare/hqJson/caseList.ts`
// (slots the same result into
// `module.search_config.default_properties[]` per CCHQ's
// `DefaultCaseSearchProperty` shape). Both surfaces export the
// same authored content to CCHQ — keeping the AND-composition rule
// in one place makes drift between them structurally impossible.
//
// CCHQ accepts at most one `_xpath_query` per `<query>` (the
// runtime CSQL parser treats it as a single source); the AST-level
// `and(...)` reducer folds the unified `caseListConfig.filter`,
// every advanced-arm `searchInputs[i].predicate`, AND every simple-arm
// input whose authored shape cannot ride Core's implicit exact matcher
// (derived through `deriveSimpleArmPredicate`) into ONE Predicate before
// the CSQL emitter walks the result. That includes related targets,
// prompt/target name mismatches, non-exact match modes, reserved wire-path
// aliases, and every exact date input. Exact date uses an explicit typed
// half-open day interval; a bare prompt cannot preserve that meaning.
//
// Non-grammar value expressions (`if`, `switch`, `arith`, `concat`,
// `coalesce`, `format-date`, non-LHS `count`) inline as runtime
// on-device XPath fragments inside the `concat(...)` wrapper at the
// CSQL emitter — the canonical CCHQ pattern documented in
// `commcare-hq/docs/case_search_query_language.rst`. Both surfaces
// therefore carry exactly one slot per module: the `_xpath_query`
// slot. CCHQ's `RemoteQuerySessionManager` only threads `<prompt>`
// values into the `search-input:results` instance — sibling
// `<data>` slots would resolve to the empty string at evaluation
// time AND silently filter case data on the server, so the inline
// shape is the only wire-correct option.

import type { CaseListConfig } from "@/lib/domain";
import { and, effectiveFilterForEmission } from "@/lib/domain/predicate";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";
import { normalizeRelationEvaluationScopes } from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";
import type { TypeContext } from "@/lib/domain/predicate/typeChecker";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate/types";
import {
	type CsqlEmissionResult,
	checkCsqlRepresentability,
	emitCsql,
	normalizeCsqlPredicate,
} from "../../predicate";
import {
	combineRuntimeCsqlPromptValidations,
	getAdvancedArmPredicates,
	RUNTIME_CSQL_QUOTE_VALIDATION_MESSAGE,
	type RuntimeCsqlPromptValidation,
} from "./searchPrompts";
import {
	deriveSimpleArmPredicate,
	simpleArmNeedsXPathQueryEmission,
} from "./simpleArmDerivation";

/**
 * Emission output. `wrapper` is the on-device XPath expression that
 * runtime-evaluates to the CSQL query string interpolated into the
 * `_xpath_query` slot. The shape mirrors `CsqlEmissionResult`
 * exactly; the type alias keeps the contract symmetric across both
 * consumers.
 */
export interface ComposedXPathQuery extends CsqlEmissionResult {
	/** The exact effective predicate after emission simplification and CSQL's
	 * reversible operand normalization. Derived consumers (prompt validation,
	 * Preview parity) inspect this same tree rather than reconstructing a subtly
	 * different query from the authored slots. */
	readonly predicate: Predicate;
}

/**
 * Derive the one prompt assertion that mirrors the emitted wrapper's exact
 * runtime-representability guard. A computed output can combine multiple
 * individually safe prompt values into one string containing both quote
 * delimiters, so validation must evaluate the complete rejection condition —
 * checking each raw answer independently is unsound.
 *
 * Attach the shared assertion to every prompt whose bytes can reach the
 * computed CSQL output. Presence gates and other control-only references are
 * deliberately excluded: they can activate a branch but do not themselves
 * introduce the unrepresentable quote combination, so blaming that field would
 * be misleading. Fixed session/computed failures with no value-contributing
 * prompt remain observable through the wrapper's explicit invalid sentinel
 * because a worker has no search answer capable of repairing them.
 */
export function buildRuntimeCsqlPromptValidations(
	emission: ComposedXPathQuery | undefined,
): ReadonlyMap<string, RuntimeCsqlPromptValidation> {
	if (emission === undefined) return new Map();
	const obligations = new Map<
		string,
		Array<RuntimeCsqlPromptValidation & { readonly kind: string }>
	>();
	for (const rejection of emission.runtimeRejections ?? []) {
		const message = (() => {
			switch (rejection.kind) {
				case "quote":
					return RUNTIME_CSQL_QUOTE_VALIDATION_MESSAGE;
				case "geopoint":
					return "Enter a location as latitude and longitude";
				case "whole-number":
					return "Enter a whole number";
				case "nonnegative-whole-number":
					return "Enter a whole number that is zero or greater";
				default: {
					const _exhaustive: never = rejection.kind;
					return String(_exhaustive);
				}
			}
		})();
		for (const name of rejection.inputNames ?? []) {
			const entries = obligations.get(name) ?? [];
			const test = `not(${rejection.condition})`;
			if (!entries.some((entry) => entry.test === test)) {
				entries.push({ kind: rejection.kind, test, message });
				obligations.set(name, entries);
			}
		}
	}
	const result = new Map<string, RuntimeCsqlPromptValidation>();

	for (const [name, entries] of obligations) {
		const validations = entries.map(({ test, message }) => ({ test, message }));
		const kinds = new Set(entries.map(({ kind }) => kind));
		const combined = combineRuntimeCsqlPromptValidations(
			validations,
			(() => {
				const instructions: string[] = [];
				if (kinds.has("geopoint")) {
					instructions.push("Enter a location as latitude and longitude");
				}
				if (
					kinds.has("whole-number") ||
					kinds.has("nonnegative-whole-number")
				) {
					instructions.push(
						kinds.has("nonnegative-whole-number")
							? "enter a whole number that is zero or greater"
							: "enter a whole number",
					);
				}
				if (kinds.has("quote")) {
					instructions.push("don’t use both kinds of quotation mark");
				}
				return instructions.join(", and ");
			})(),
		);
		if (combined !== undefined) result.set(name, combined);
	}
	return result;
}

/**
 * Compose the unified `_xpath_query`. Returns `undefined` when
 * nothing narrows the case list (no filter authored, no advanced-arm
 * predicates, no cross-walk simple inputs, OR every clause is a
 * `match-all` identity) — consumers omit the slot entirely rather
 * than emitting `_xpath_query = "true()"`, which CCHQ accepts but
 * reads as noise.
 *
 * Composition policy: collect the filter + advanced-arm predicates +
 * derived simple-arm predicates, AND-compose them, then run
 * `simplifyForEmission` so boolean identities never reach the wire
 * (see the body comment for why the normalize lives here, not in the
 * shared `and(...)` reducer). A composition that reduces to `match-all`
 * (nothing narrows) returns `undefined` and the consumer omits the
 * slot.
 *
 * `caseType` is the module's `caseType`; it threads to every
 * derived `prop(...)` reference for simple-arm inputs that need
 * `_xpath_query` routing. The validator rule
 * `caseSearchConfigRequiresCaseType` makes a `caseSearchConfig`
 * without a case type a structural validation error, so reaching
 * this helper with `caseType === undefined` is only possible from
 * call sites that compose without a `caseSearchConfig` (the HQ JSON
 * `default_properties` projection runs on every module with a
 * `caseListConfig`, regardless of search-config presence). The
 * defensive guard keeps the simple-arm derivation skipped in that
 * arm — the bare prompt slot still emits, and the filter alone (if
 * authored) still composes — without inventing a fictional case-type
 * qualifier for the lifted `prop(...)` references.
 */
export function composeXPathQueryEmission(
	caseListConfig: CaseListConfig,
	caseType: string | undefined,
	typeContext?: TypeContext,
): ComposedXPathQuery | undefined {
	const composed = composeXPathQueryPredicate(
		caseListConfig,
		caseType,
		typeContext,
	);
	if (composed === undefined) return undefined;

	// Defense in depth — the validator rule
	// `searchInputRefUsesWhenInputPresent` rejects every bare
	// `input(...)` ref outside a `when-input-present` envelope at
	// authoring time. CCHQ's CSQL runtime resolves an unset input
	// ref to the empty string, so a bare ref would silently match
	// cases whose property equals "" until the user types. This
	// walker throws if a bare ref survived to the wire boundary —
	// the validator should have caught it, and reaching this throw
	// means the validator was bypassed (an AST built at runtime, an
	// `as any` cast, or a partial discriminated-union widening).
	// Same shape as the defensive throw at
	// `lib/commcare/predicate/csqlEmitter.ts::emitComparisonOperandSegments`
	// for `count` arms the hoist pass should have lifted.
	assertNoBareSearchInputRefs(composed);
	assertCsqlRepresentable(composed);

	return {
		...emitCsql(composed, typeContext),
		predicate: normalizeRelationEvaluationScopes(
			normalizeCsqlPredicate(composed),
			typeContext ?? {},
		),
	};
}

/**
 * Compose the exact effective Predicate that owns `_xpath_query` before it is
 * serialized. Keeping this step public lets every derived surface inspect the
 * same simplified clause set: filters, advanced predicates, and derived simple
 * inputs are combined once, with boolean absorption applied before any prompt
 * restriction is inferred.
 */
export function composeXPathQueryPredicate(
	caseListConfig: CaseListConfig,
	caseType: string | undefined,
	typeContext?: TypeContext,
): Predicate | undefined {
	const clauses: Predicate[] = [];
	if (caseListConfig.filter !== undefined) {
		clauses.push(caseListConfig.filter);
	}
	for (const entry of getAdvancedArmPredicates(caseListConfig.searchInputs)) {
		clauses.push(entry.predicate);
	}
	// Simple-arm inputs whose authored semantics cannot ride Core's
	// implicit exact matcher derive an advanced-style predicate at the
	// wire boundary. A plain non-date exact self target can stay on the
	// bare prompt; date exact always contributes its typed whole-day
	// interval, even on self. The gate at
	// `simpleArmNeedsXPathQueryEmission` is the single contract; it
	// also returns `false` for blank-property inputs (transient editor
	// state), so the compile path stays clean while the validator's
	// `CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY` surfaces the authoring
	// error to the user.
	if (caseType !== undefined) {
		for (const input of caseListConfig.searchInputs) {
			if (input.kind !== "simple") continue;
			if (!simpleArmNeedsXPathQueryEmission(input)) continue;
			clauses.push(deriveSimpleArmPredicate(input, caseType, typeContext));
		}
	}
	if (clauses.length === 0) {
		return undefined;
	}

	// AND-compose, then normalize via `effectiveFilterForEmission`: it
	// drops boolean identities at every depth and folds an all-true
	// result to `undefined`. Without it a `match-all` conjunct would
	// emit a literal `concat('match-all() and ', …)` prefix (the
	// reported bug) — usually from a `caseListConfig.filter` the builder
	// seeded with `matchAll()` on "Add a Filter" and left untouched, or
	// a `match-all` nested inside an authored `and` filter. `undefined`
	// means nothing narrows, so omit the slot (CCHQ matches every case
	// by default); a `match-none` composition rides through and emits
	// `match-none()` (the author asked for "match nothing").
	const composed = effectiveFilterForEmission(
		clauses.length === 1
			? clauses[0]
			: and(clauses[0], clauses[1], ...clauses.slice(2)),
	);
	if (composed === undefined) {
		return undefined;
	}

	return composed;
}

/**
 * Defense in depth for the CCHQ server-query boundary.
 *
 * The validator reports these issues against the authored module, where the
 * builder can identify the exact card and offer a repair. Reaching this helper
 * means that authoring gate was bypassed. Throwing here is still essential:
 * emitting a wider Nova predicate as CSQL would otherwise create a package
 * that Preview accepts but CCHQ rejects (or, worse, interprets differently).
 */
function assertCsqlRepresentable(predicate: Predicate): void {
	const issues = checkCsqlRepresentability(predicate);
	if (issues.length === 0) return;

	const detail = issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "root";
			return `- ${path}: ${issue.message}`;
		})
		.join("\n");
	throw new Error(
		compilerBugMessage({
			where: "composeXPathQueryEmission",
			invariant:
				"the composed _xpath_query predicate is representable in CCHQ's server query language",
			detail: [
				"The validator rule `csqlPredicateRepresentability` should have rejected this authored shape before compilation. Reaching this throw means validation was bypassed.",
				"",
				detail,
			].join("\n"),
		}),
	);
}

/**
 * Walk the composed predicate and throw if a search-input Term
 * appears outside a `when-input-present` envelope keyed to the same
 * input name. The walker maintains a set of input names "currently
 * gated" by an enclosing `when-input-present` and only flags refs
 * whose name is not in that set. Mirrors the validator rule
 * `searchInputRefUsesWhenInputPresent`'s walker contract; the throw
 * shape is a `compilerBugMessage` because reaching it means the
 * validator was bypassed at authoring time.
 */
function assertNoBareSearchInputRefs(predicate: Predicate): void {
	visitPredicate(predicate, new Set<string>());
}

function visitPredicate(p: Predicate, gated: Set<string>): void {
	switch (p.kind) {
		case "match-all":
		case "match-none":
			return;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			visitExpression(p.left, gated);
			visitExpression(p.right, gated);
			return;
		case "in":
			visitExpression(p.left, gated);
			// `in.values` are Literals — they cannot syntactically carry
			// a search-input ref.
			return;
		case "between":
			visitExpression(p.left, gated);
			if (p.lower !== undefined) visitExpression(p.lower, gated);
			if (p.upper !== undefined) visitExpression(p.upper, gated);
			return;
		case "is-null":
		case "is-blank":
			visitExpression(p.left, gated);
			return;
		case "match":
			// `match.value` is a `ValueExpression` (per `matchSchema`),
			// not a bare literal — the type checker admits term-arm
			// shapes including `term(input(...))` / `term(session-*(...))`,
			// and the simple-arm derivation pipeline at
			// `simpleArmDerivation.ts` produces exactly that shape for
			// every non-`exact` mode. Walk the value to catch every
			// reachable input ref.
			visitExpression(p.value, gated);
			return;
		case "multi-select-contains":
			// `property` is a `PropertyRef`; `values` is `[Literal, ...]`.
			// No search-input refs reachable through this arm.
			return;
		case "within-distance":
			// `property` is a `PropertyRef`; `center` is a
			// `ValueExpression` that can carry a `term(input(...))` ref.
			visitExpression(p.center, gated);
			return;
		case "and":
		case "or":
			for (const clause of p.clauses) {
				visitPredicate(clause, gated);
			}
			return;
		case "not":
			visitPredicate(p.clause, gated);
			return;
		case "exists":
		case "missing":
			// The relation walk's outer context is the casedb root; the
			// optional inner `where` predicate's input refs gate against
			// the same enclosing envelope set.
			if (p.where !== undefined) visitPredicate(p.where, gated);
			return;
		case "when-input-present": {
			// Push the gate, recurse, pop — but ONLY pop if this
			// envelope was the one that added it. An outer envelope
			// that already gated the same input name still expects the
			// gate after the inner envelope exits; unconditionally
			// deleting would break a `whenInput("x", and(whenInput("x",
			// …), eq(other, input("x"))))` shape by removing the
			// outer's gate when the inner exits. Mirrors the validator
			// walker's `wasAlreadyGated` preserve at
			// `searchInputRefUsesWhenInputPresent.ts::visitPredicate`.
			const triggerName = p.input.name;
			const wasAlreadyGated = gated.has(triggerName);
			gated.add(triggerName);
			visitPredicate(p.clause, gated);
			if (!wasAlreadyGated) gated.delete(triggerName);
			return;
		}
		default: {
			const _exhaustive: never = p;
			throw new Error(
				`composeXPathQueryEmission.assertNoBareSearchInputRefs: unhandled Predicate kind ${String(_exhaustive)}`,
			);
		}
	}
}

function visitExpression(expr: ValueExpression, gated: Set<string>): void {
	switch (expr.kind) {
		case "term":
			if (expr.term.kind === "input" && !gated.has(expr.term.name)) {
				throw new Error(
					compilerBugMessage({
						where: "composeXPathQueryEmission",
						invariant: `the composed _xpath_query predicate carries a bare search-input reference (\`input("${expr.term.name}")\`) outside any when-input-present envelope`,
						detail:
							"The validator rule `searchInputRefUsesWhenInputPresent` rejects this shape at authoring time. Reaching this throw means the validator was bypassed — typically through an AST constructed at runtime, an `as any` cast, or a partial discriminated-union widening. Run validation before invoking the compile pipeline; the validator surfaces the offending slot so the author can wrap the subtree in a `when-input-present` envelope or remove the input reference.",
					}),
				);
			}
			return;
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			visitExpression(expr.value, gated);
			return;
		case "arith":
			visitExpression(expr.left, gated);
			visitExpression(expr.right, gated);
			return;
		case "concat":
			for (const part of expr.parts) visitExpression(part, gated);
			return;
		case "coalesce":
			for (const value of expr.values) visitExpression(value, gated);
			return;
		case "if":
			visitPredicate(expr.cond, gated);
			visitExpression(expr.then, gated);
			visitExpression(expr.else, gated);
			return;
		case "switch":
			visitExpression(expr.on, gated);
			for (const c of expr.cases) {
				// `c.when` is a `Literal` per `switchCaseSchema` — no
				// search-input ref can reach this slot. Only the `then`
				// branch recurses into the value-expression walker.
				visitExpression(c.then, gated);
			}
			visitExpression(expr.fallback, gated);
			return;
		case "format-date":
			visitExpression(expr.date, gated);
			return;
		case "count":
			if (expr.where !== undefined) visitPredicate(expr.where, gated);
			return;
		case "date-add":
			visitExpression(expr.date, gated);
			visitExpression(expr.quantity, gated);
			return;
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`composeXPathQueryEmission.assertNoBareSearchInputRefs: unhandled ValueExpression kind ${String(_exhaustive)}`,
			);
		}
	}
}
