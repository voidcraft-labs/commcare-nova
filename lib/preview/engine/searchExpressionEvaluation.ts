// lib/preview/engine/searchExpressionEvaluation.ts
//
// Runtime evaluation for the two case-search ValueExpression surfaces:
// prompt defaults and the excluded-owner expression. The shipped app
// evaluates both with CommCare's on-device XPath evaluator. Preview reuses
// Nova's existing XPath evaluator over the exact emitted expression instead
// of growing a second, subtly different AST interpreter.
//
// The evaluator intentionally has no case-row context. Search prompt defaults
// and hidden query values run against the session/search-input instances, not
// against a selected case. A property/relation read therefore resolves blank
// here, matching a search screen before a case has been selected.

import { emitOnDeviceExpression } from "@/lib/commcare/expression/onDeviceEmitter";
import { emitCaseListFilter } from "@/lib/commcare/predicate/caseListFilterEmitter";
import {
	ownRecordValue,
	type SearchInputDef,
	type SelectSearchInputDef,
	searchInputDefault,
} from "@/lib/domain";
import type {
	Predicate,
	SessionContextField,
	ValueExpression,
} from "@/lib/domain/predicate";
import { toBoolean, xpathToString } from "@/lib/preview/xpath/coerce";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "@/lib/preview/xpath/generatedJavaRosaFunctions";
import type { EvalContext } from "@/lib/preview/xpath/types";
import {
	type PreviewSearchSessionValues,
	previewUserPropertySlugMap,
} from "./identity";
import {
	evaluateLookupChoices,
	expressionLookupsCovered,
	foldTableLookupsInExpression,
	foldTableLookupsInPredicate,
	type LookupChoice,
	lookupOptionsSourceCovered,
	type PreviewLookupData,
} from "./lookupEvaluation";
import type { SearchInputValues } from "./runtimeBindings";
import {
	bindSearchInputValuesInExpression,
	bindSearchInputValuesInPredicate,
	withSearchInputExpressionValues,
} from "./runtimeBindings";

/**
 * Evaluate one search ValueExpression with the same XPath implementation the
 * form preview already uses. Runtime search-input refs are first substituted
 * into the AST because the scalar preview evaluator deliberately does not
 * model XML nodeset predicates such as `field[@name='query']`.
 */
export function evaluatePreviewSearchExpression(
	expression: ValueExpression,
	session: PreviewSearchSessionValues,
	inputValues: SearchInputValues = new Map(),
	searchInputs: readonly SearchInputDef[] = [],
	lookupData?: PreviewLookupData,
): string {
	const bound = bindSearchInputValuesInExpression(
		expression,
		inputValues,
		searchInputs,
	);
	/* Lookup carriers fold AFTER input binding (their row filters may
	 * read Search answers) and BEFORE emission — the on-device emitter
	 * has no naming here, and the scalar evaluator models no fixture
	 * instance. Callers whose slots can carry lookups supply the loaded
	 * snapshot; without one, a carrier-bearing expression throws the
	 * emitter's loud missing-naming error rather than resolving blank. */
	const folded =
		lookupData === undefined
			? bound
			: foldTableLookupsInExpression(bound, lookupData, {
					outer: searchSessionEvalContext(session),
					userPropertySlugs: previewUserPropertySlugMap(session),
				});
	return xpathToString(
		evaluatePreviewSearchXPath(
			emitOnDeviceExpression(folded, "casedb", {
				userPropertySlugs: previewUserPropertySlugMap(session),
			}),
			session,
		),
	);
}

/**
 * Evaluate a search-screen predicate against the same values CommCare exposes
 * while the worker is filling the search form. Input refs read the live draft,
 * including CommCare's scalar projection for a completed date range; session
 * refs read the authenticated preview worker. There is deliberately no selected
 * case on this screen, so property/relation reads resolve blank just as they do
 * for search ValueExpressions before case selection.
 */
export function evaluatePreviewSearchPredicate(
	predicate: Predicate,
	searchInputs: readonly SearchInputDef[],
	session: PreviewSearchSessionValues,
	inputValues: SearchInputValues = new Map(),
	lookupData?: PreviewLookupData,
): boolean {
	return toBoolean(
		evaluatePreviewSearchXPath(
			emitPreviewSearchPredicate(
				predicate,
				searchInputs,
				session,
				inputValues,
				lookupData,
			),
			session,
		),
	);
}

/**
 * The exact on-device XPath a search-screen predicate evaluates as, with
 * the draft's answers bound in and lookup carriers folded, so that a caller
 * with a different evaluator (the XPath worker, for a pattern-bearing
 * constraint) runs the same bytes the scalar path does. Only the session
 * instance remains to be resolved.
 */
export function emitPreviewSearchPredicate(
	predicate: Predicate,
	searchInputs: readonly SearchInputDef[],
	session: PreviewSearchSessionValues,
	inputValues: SearchInputValues = new Map(),
	lookupData?: PreviewLookupData,
): string {
	const expressionValues = withSearchInputExpressionValues(
		searchInputs,
		inputValues,
	);
	const bound = bindSearchInputValuesInPredicate(
		predicate,
		expressionValues,
		new Set(searchInputs.map((input) => input.uuid)),
		searchInputs,
	);
	const folded =
		lookupData === undefined
			? bound
			: foldTableLookupsInPredicate(bound, lookupData, {
					outer: searchSessionEvalContext(session),
					userPropertySlugs: previewUserPropertySlugMap(session),
				});
	return emitCaseListFilter(folded, "casedb", {
		userPropertySlugs: previewUserPropertySlugMap(session),
	});
}

function evaluatePreviewSearchXPath(
	xpath: string,
	session: PreviewSearchSessionValues,
) {
	return evaluate(xpath, searchSessionEvalContext(session));
}

/** The session-only evaluation world of the search surfaces — no case
 *  row, no form instance; session/user instance paths resolve, all
 *  else reads blank. Shared with lookup folding so a row filter's
 *  non-row reads see the same world its containing slot does. */
function searchSessionEvalContext(
	session: PreviewSearchSessionValues,
): EvalContext {
	return {
		contextPath: "",
		position: 1,
		getValue: (path) => sessionInstancePathValue(path, session),
		resolveInstance: (instanceId, path) =>
			instanceId === "commcaresession"
				? { kind: "supported", value: sessionInstancePathValue(path, session) }
				: { kind: "unsupported" },
		resolveHashtag: () => "",
		invokeGeneratedFunction: invokeGeneratedJavaRosaFunction,
	};
}

/**
 * Resolve the session-instance path spellings the on-device emitters
 * print (`instance('commcaresession')/session/...`; the explicit instance
 * resolver receives `/session/...`). Shared with every
 * preview surface that evaluates emitted predicates outside a form
 * context; non-session paths return `undefined` so callers can chain
 * their own resolution.
 */
export function sessionInstancePathValue(
	path: string,
	session: PreviewSearchSessionValues,
): string | undefined {
	const contextPrefix = "/session/context/";
	if (path.startsWith(contextPrefix)) {
		const field = path.slice(contextPrefix.length) as SessionContextField;
		return session.context[field];
	}

	const userPrefix = "/session/user/data/";
	if (path.startsWith(userPrefix)) {
		return ownRecordValue(session.user, path.slice(userPrefix.length));
	}

	return undefined;
}

/**
 * Resolve prompt defaults in displayed order. CommCare evaluates every prompt
 * default against the session context before it constructs the search-input
 * instance, so sibling defaults do not feed one another. Preview mirrors that
 * lifecycle by evaluating each expression with an empty input bag.
 *
 * Date-range inputs stay empty because their final schema has no scalar
 * default slot.
 */
export function resolveSearchInputDefaults(
	searchInputs: readonly SearchInputDef[],
	session: PreviewSearchSessionValues,
	lookupData?: PreviewLookupData,
): SearchInputValues {
	const values = new Map<string, string>();
	for (const input of [...searchInputs]) {
		const inputDefault = searchInputDefault(input);
		if (inputDefault === undefined) continue;
		/* A default whose carriers the held snapshot doesn't COVER (not
		 * loaded yet, or a valid edit the stale-while-revalidate snapshot
		 * predates) contributes nothing THIS resolution; the run-state
		 * reconciler updates untouched prompts when the covering snapshot
		 * lands and the defaults revision moves. */
		if (!expressionLookupsCovered(inputDefault, lookupData)) {
			continue;
		}
		const value = evaluatePreviewSearchExpression(
			inputDefault,
			session,
			undefined,
			undefined,
			lookupData,
		).trim();
		if (value === "") continue;
		values.set(input.name, value);
	}
	return values;
}

/**
 * Resolve every hidden input's system-generated value at the moment the
 * worker searches. CommCare seeds a hidden prompt's `default` into the
 * answers when it builds the query screen and re-evaluates it on every
 * rebuild (`util/screen/QueryScreen.java::init`), so the value a search
 * carries is the one current when the worker pressed Search, never a
 * value typed by the worker. A hidden input reads no sibling answer
 * (the validator refuses `input(...)` in its value), so each expression
 * evaluates over the session alone. A value whose lookup carriers the
 * held snapshot does not cover contributes nothing this resolution; a
 * blank result is omitted, matching an unanswered prompt.
 */
export function resolveSearchHiddenValues(
	searchInputs: readonly SearchInputDef[],
	session: PreviewSearchSessionValues,
	lookupData?: PreviewLookupData,
): SearchInputValues {
	const values = new Map<string, string>();
	for (const input of searchInputs) {
		if (input.kind !== "hidden") continue;
		if (!expressionLookupsCovered(input.value, lookupData)) continue;
		const value = evaluatePreviewSearchExpression(
			input.value,
			session,
			undefined,
			undefined,
			lookupData,
		);
		if (value === "") continue;
		values.set(input.name, value);
	}
	return values;
}

/**
 * The choices a lookup-backed Search prompt offers right now: the source
 * table's rows in authored order, filtered by the authored row filter over
 * table columns and session values (the search screen has no case and the
 * filter admits no sibling answer). `undefined` while the held snapshot
 * does not cover the source, which the widget renders as its loading
 * state; blank or duplicate values stay in the list, exactly as the device
 * fixture would carry them.
 */
export function resolveSearchInputChoices(
	input: SelectSearchInputDef,
	session: PreviewSearchSessionValues,
	lookupData: PreviewLookupData | undefined,
): readonly LookupChoice[] | undefined {
	if (
		lookupData === undefined ||
		!lookupOptionsSourceCovered(input.options, lookupData)
	) {
		return undefined;
	}
	return evaluateLookupChoices(input.options, lookupData, {
		outer: searchSessionEvalContext(session),
		userPropertySlugs: previewUserPropertySlugMap(session),
	});
}

/** CCHQ splits this one niche value on whitespace only; commas remain ids. */
export function parseExcludedOwnerIds(value: string): readonly string[] {
	return [...new Set(value.trim().split(/\s+/).filter(Boolean))];
}
