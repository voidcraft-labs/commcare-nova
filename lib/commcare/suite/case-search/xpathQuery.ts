// lib/commcare/suite/case-search/xpathQuery.ts
//
// Shared `_xpath_query` composer. Two wire surfaces consume the
// composition: the suite-XML emitter at `searchSession.ts` (emits one
// `<data key="_xpath_query">` element per clause on `<query>`) and the
// HQ-JSON emitter at `lib/commcare/hqJson/caseList.ts` (emits one
// `search_config.default_properties[]` row per clause — CCHQ's
// `DefaultCaseSearchProperty` is a `SchemaListProperty`, and CCHQ's own
// suite generator loops every row into its own `<data>` element at
// `commcare-hq/.../suite_xml/post_process/remote_requests.py::_remote_request_query_datums`).
// Both surfaces export the same authored content to CCHQ — keeping the
// composition rule in one place makes drift between them structurally
// impossible.
//
// CCHQ AND-composes every `_xpath_query` value it receives: the client
// sends one query param per `<data>` element
// (`commcare-core .../session/RemoteQuerySessionManager.java::getRawQueryParams`
// returns a `Multimap`, and formplayer forwards it as repeated params),
// Django folds the repeats into a list
// (`commcare-hq/corehq/apps/ota/views.py::app_aware_search` —
// `request.GET.lists()`),
// and the server applies each value as its own AND-composed ES filter —
// `commcare-hq/corehq/apps/case_search/utils.py::_apply_filter`'s
// `CASE_SEARCH_XPATH_QUERY_KEY` arm loops
// `xpaths = criteria.value if criteria.has_multiple_terms else [...]`.
// The composer therefore emits ONE CLAUSE PER CONJUNCT — the unified
// `caseListConfig.filter` (split at its top-level `and` boundaries),
// each advanced-arm `searchInputs[i].predicate`, and each simple-arm
// input whose authored shape cannot ride Core's implicit exact matcher
// (derived through `deriveSimpleArmPredicate`; that covers related
// targets, prompt/target name mismatches, non-exact match modes,
// reserved wire-path aliases, and every exact date input — exact date
// uses an explicit typed half-open day interval a bare prompt cannot
// preserve). Small independent expressions replace one fused
// mega-expression while the server's AND loop preserves the combined
// meaning. A clause never evaluates to the empty string (a blank value
// among several `_xpath_query` params is a server-side parse error);
// an input-gated clause with no answer evaluates to `match-all()`, the
// AND identity.
//
// Non-grammar value expressions (`if`, `switch`, `arith`, `concat`,
// `coalesce`, `format-date`, non-LHS `count`) inline as runtime
// on-device XPath fragments inside the clause wrapper at the
// CSQL emitter — the canonical CCHQ pattern documented in
// `commcare-hq/docs/case_search_query_language.rst`. Only `_xpath_query`
// slots are emitted: CCHQ's `RemoteQuerySessionManager` only threads
// `<prompt>` values into the `search-input:results` instance — a
// synthetic non-`_xpath_query` `<data>` slot would resolve to the empty
// string at evaluation time AND silently filter case data on the
// server, so the inline shape is the only wire-correct option for
// computed values.
import {
	inertLookupWireNaming,
	type LookupWireNaming,
} from "@/lib/commcare/lookup/naming";
import { w } from "@/lib/commcare/xpath/wire/builders";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import type { CaseListConfig } from "@/lib/domain";
import { and, effectiveFilterForEmission } from "@/lib/domain/expression";
import {
	type ExpressionNode,
	expressionChildren,
} from "@/lib/domain/expression/children";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { compilerBugMessage } from "@/lib/domain/expression/errors";
import type { Expression } from "@/lib/domain/expression/types";
import {
	type SearchRuntimeValidationKind,
	searchRuntimeValidationMessage,
} from "@/lib/domain/searchRuntimeValidationMessages";
import {
	checkCsqlRepresentability,
	collectRelatedCaseQueries,
	dedupeRuntimeRejections,
	emitCsql,
	type RuntimeCsqlRejection,
} from "../../predicate";
import {
	combineRuntimeCsqlPromptValidations,
	getAdvancedArmPredicates,
	type RuntimeCsqlPromptValidation,
} from "./searchPrompts";
import {
	deriveSimpleArmPredicate,
	simpleArmNeedsXPathQueryEmission,
} from "./simpleArmDerivation";

/**
 * Emission output. Each entry of `clauseWrappers` is one on-device
 * XPath expression that runtime-evaluates to one CSQL query string —
 * one `<data key="_xpath_query">` element in local suite XML, one
 * `default_properties[]` row in HQ JSON, in the same order on both
 * surfaces. The server ANDs the resulting values
 * (`commcare-hq/corehq/apps/case_search/utils.py::_apply_filter`).
 *
 * `runtimeRejections` is the deduplicated union of every clause's
 * fail-closed obligations; prompt validation and Preview consume it so
 * every surface rejects the identical runtime state before dispatch
 * when a worker can repair it.
 */
export interface ComposedXPathQuery {
	readonly clauseWrappers: readonly WireExpr[];
	readonly runtimeRejections?: readonly RuntimeCsqlRejection[];
}

/**
 * The `_xpath_query` value a search with no inputs and no composed clause
 * sends. CCHQ builds no search for a module with neither prompts nor default
 * properties (`app_manager/util.py::module_offers_search`), so Nova's
 * zero-input, unfiltered Search carries one default property: `match-all()`,
 * CCHQ's CSQL identity function, quoted so the datum's XPath evaluates to
 * the query string. Both export paths send it, so a worker's request is the
 * same on HQ's build and the local archive.
 */
export const ZERO_INPUT_SEARCH_SENTINEL = w.str("match-all()");

/**
 * Every `_xpath_query` value the search request carries, in order: one per
 * composed clause, or the zero-input sentinel when the search has no input
 * and no clause. The local suite writes one `<data>` per value and the HQ
 * JSON one `default_properties[]` row per value, so the two paths read this
 * one decision.
 */
export function xpathQueryRequestValues(
	caseListConfig: CaseListConfig,
	emission: ComposedXPathQuery | undefined,
): readonly WireExpr[] {
	const clauses = emission?.clauseWrappers ?? [];
	if (clauses.length > 0 || caseListConfig.searchInputs.length > 0) {
		return clauses;
	}
	return [ZERO_INPUT_SEARCH_SENTINEL];
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
 * be misleading. A fixed session or computed value with no value-contributing
 * prompt gets no assertion, because no search answer can repair it: the
 * wrapper sends `match-none()` for it, and the search finds nothing.
 */
export function buildRuntimeCsqlPromptValidations(
	emission: ComposedXPathQuery | undefined,
): ReadonlyMap<string, RuntimeCsqlPromptValidation> {
	if (emission === undefined) return new Map();
	const obligations = new Map<
		string,
		Array<
			RuntimeCsqlPromptValidation & {
				readonly kind: SearchRuntimeValidationKind;
			}
		>
	>();
	for (const rejection of emission.runtimeRejections ?? []) {
		// A blank comparand names no prompt and has no message for a worker:
		// the search finds nothing (`runtimeCsqlDateSafety.ts`).
		if (rejection.kind === "blank-comparand") continue;
		const message = searchRuntimeValidationMessage(new Set([rejection.kind]));
		if (message === undefined) continue;
		for (const name of rejection.inputNames ?? []) {
			const entries = obligations.get(name) ?? [];
			const test = w.not(rejection.condition);
			const text = serializeWire(test, { target: "suite" }).text;
			if (
				!entries.some(
					(entry) =>
						serializeWire(entry.test, { target: "suite" }).text === text,
				)
			) {
				entries.push({
					kind: rejection.kind,
					test,
					message: message.message,
					messageKey: message.key,
				});
				obligations.set(name, entries);
			}
		}
	}
	const result = new Map<string, RuntimeCsqlPromptValidation>();

	for (const [name, entries] of obligations) {
		const validations = entries.map(({ test, message, messageKey }) => ({
			test,
			message,
			messageKey,
		}));
		const kinds = new Set(entries.map(({ kind }) => kind));
		const combinedMessage = searchRuntimeValidationMessage(kinds);
		if (combinedMessage === undefined) continue;
		const combined = combineRuntimeCsqlPromptValidations(
			validations,
			combinedMessage.message,
			combinedMessage.key,
		);
		if (combined !== undefined) result.set(name, combined);
	}
	return result;
}

/**
 * Compose the `_xpath_query` clause list. Returns `undefined` when
 * nothing narrows the case list (no filter authored, no advanced-arm
 * predicates, no cross-walk simple inputs, OR every clause is a
 * `match-all` identity) — consumers emit no `_xpath_query` slots at
 * all rather than `_xpath_query = "true()"`, which CCHQ accepts but
 * reads as noise.
 *
 * Composition policy: collect the filter + advanced-arm predicates +
 * derived simple-arm predicates, AND-compose them, run
 * `effectiveFilterForEmission` so boolean identities never reach the
 * wire (see the body comment for why the normalize lives here, not in
 * the shared `and(...)` reducer), then emit ONE WRAPPER PER top-level
 * conjunct. The server AND-composes the values back together
 * (`utils.py::_apply_filter` — see the file header for the end-to-end
 * citation chain), so N small clause expressions and one fused
 * expression filter identically; the split is what keeps each emitted
 * expression readable and each input's presence gate / value guard
 * scoped to its own clause.
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
	typeContext: ExpressionContext,
	lookupNaming?: LookupWireNaming,
	searchInputInstanceId?: `search-input:${string}`,
): ComposedXPathQuery | undefined {
	const composed = composeXPathQueryPredicate(
		caseListConfig,
		caseType,
		typeContext,
	);
	if (composed === undefined) return undefined;
	const csqlContext = {
		types: typeContext,
		bindings: {
			searchInputInstanceId,
			...(lookupNaming === undefined
				? {}
				: {
						lookup: { naming: lookupNaming, instanceScope: "suite" as const },
					}),
		},
	};

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
	assertCsqlRepresentable(composed, typeContext);

	// One clause per top-level conjunct. `composeXPathQueryPredicate`
	// AND-composes the sources and `effectiveFilterForEmission` already
	// dropped boolean identities at every depth, so a top-level `and`
	// root's clause list IS the conjunct list; any other root is one
	// clause. Each conjunct emits independently — its own presence
	// gate, its own value guards — and the server's AND loop restores
	// the combined meaning.
	const clauses = composed.kind === "and" ? composed.clauses : [composed];
	const emissions = clauses.map((clause) => emitCsql(clause, csqlContext));
	const runtimeRejections = dedupeRuntimeRejections(
		emissions.flatMap((emission) => emission.runtimeRejections ?? []),
	);
	return {
		clauseWrappers: emissions.map((emission) => emission.wrapper),
		...(runtimeRejections.length === 0 ? {} : { runtimeRejections }),
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
	typeContext: ExpressionContext,
): Expression | undefined {
	const clauses: Expression[] = [];
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
	// `simpleArmNeedsXPathQueryEmission` is the single contract. Simple
	// properties are structurally nonblank before this boundary.
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
function assertCsqlRepresentable(
	predicate: Expression,
	context: ExpressionContext,
): void {
	const issues = checkCsqlRepresentability(predicate, context);
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
				"the composed _xpath_query predicate is not representable in CCHQ's server query language",
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
function assertNoBareSearchInputRefs(expression: Expression): void {
	const visit = (node: ExpressionNode, gated: ReadonlySet<string>): void => {
		if (node.kind === "input" && !gated.has(node.searchInputUuid)) {
			throw new Error(
				compilerBugMessage({
					where: "composeXPathQueryEmission",
					invariant: `the composed query carries the search-input reference ${node.searchInputUuid} outside its when-input-present envelope`,
					detail:
						"The expression checker should have rejected this reference before emission.",
				}),
			);
		}
		const next =
			node.kind === "when-input-present"
				? new Set([...gated, node.input.searchInputUuid])
				: gated;
		for (const child of expressionChildren(node)) {
			if (child.kind !== "relation") visit(child.value, next);
		}
	};
	visit(expression, new Set());
}

/**
 * Whether a search's own filter reads related cases, which HQ's case search
 * refuses outright without `CASE_SEARCH_RELATED_LOOKUPS`
 * (`case_search/filter_dsl.py::build_filter_from_ast` sends `subcase-exists`,
 * `subcase-count` and `ancestor-exists` to `_require_related_lookups_flag`).
 * It runs the composition the suite and the HQ JSON both write and asks the
 * CSQL emitter which of those functions it wrote, so the answer is the wire's
 * own: an ancestor case-id comparison, which the emitter writes as
 * `ancestor-exists`, needs the flag, and a `count` the emitter inlines as an
 * on-device number does not. Lookup names never decide a function call, so
 * the inert naming stands in for the definitions snapshot.
 */
export function xpathQueryUsesRelatedLookup(
	caseListConfig: CaseListConfig,
	caseType: string | undefined,
	typeContext: ExpressionContext,
): boolean {
	return (
		collectRelatedCaseQueries(() =>
			composeXPathQueryEmission(
				caseListConfig,
				caseType,
				typeContext,
				inertLookupWireNaming(),
			),
		).written.size > 0
	);
}
