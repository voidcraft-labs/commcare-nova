/** Running-preview validation that mirrors exported CommCare search prompts. */

import { quoteLiteral } from "@/lib/commcare/predicate";
import {
	buildRuntimeCsqlPromptValidations,
	type ComposedXPathQuery,
	composeXPathQueryEmission,
} from "@/lib/commcare/suite/case-search/xpathQuery";
import type { CaseListConfig } from "@/lib/domain";
import type { TypeContext } from "@/lib/domain/predicate";
import { toBoolean } from "@/lib/preview/xpath/coerce";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import { dateRangeInputErrors } from "./dateRangeInputValidation";
import type { PreviewSearchSessionValues } from "./identity";
import {
	type SearchInputValues,
	withSearchInputExpressionValues,
} from "./runtimeBindings";

const EMPTY_SEARCH_SESSION: PreviewSearchSessionValues = {
	context: {},
	user: {},
};

/**
 * Return per-prompt errors for the exact runtime state that the exported
 * `_xpath_query` wrapper rejects. The CSQL emitter owns the rejection
 * condition; suite XML, HQ JSON, and Preview all consume that same expression
 * instead of reconstructing quote rules from individual raw answers.
 *
 * A temporarily invalid or legacy config must not crash the running preview.
 * The document validator remains the authoritative authoring gate; this helper
 * simply declines to add a secondary runtime error when exact emission cannot
 * be composed yet.
 */
export function searchInputRuntimeQuoteErrors(
	caseListConfig: CaseListConfig,
	caseType: string | undefined,
	values: SearchInputValues,
	session: PreviewSearchSessionValues = EMPTY_SEARCH_SESSION,
	typeContext?: TypeContext,
): ReadonlyMap<string, string> {
	let emission: ComposedXPathQuery | undefined;
	try {
		emission = composeXPathQueryEmission(caseListConfig, caseType, typeContext);
	} catch {
		return new Map();
	}

	const validations = buildRuntimeCsqlPromptValidations(emission);
	if (
		emission === undefined ||
		(emission.runtimeRejections?.length ?? 0) === 0 ||
		validations.size === 0
	) {
		return new Map();
	}
	const errors = new Map<string, string>();
	for (const rejection of emission.runtimeRejections ?? []) {
		const rejected = runtimeRejectionApplies(
			rejection,
			caseListConfig,
			values,
			session,
		);
		if (!rejected) continue;
		for (const name of rejection.inputNames ?? []) {
			const validation = validations.get(name);
			if (validation !== undefined) errors.set(name, validation.message);
		}
	}
	return errors;
}

/**
 * A runtime value sourced only from session/computed data has no prompt where
 * the worker can repair it. Preview must stop before Postgres in the same state
 * where the exported CSQL wrapper fail-closes; otherwise Preview can show rows
 * that the installed app can never return.
 */
export function searchInputRuntimeGlobalError(
	caseListConfig: CaseListConfig,
	caseType: string | undefined,
	values: SearchInputValues,
	session: PreviewSearchSessionValues = EMPTY_SEARCH_SESSION,
	typeContext?: TypeContext,
): string | undefined {
	let emission: ComposedXPathQuery | undefined;
	try {
		emission = composeXPathQueryEmission(caseListConfig, caseType, typeContext);
	} catch {
		return undefined;
	}
	for (const rejection of emission?.runtimeRejections ?? []) {
		if ((rejection.inputNames?.length ?? 0) > 0) continue;
		if (!runtimeRejectionApplies(rejection, caseListConfig, values, session)) {
			continue;
		}
		switch (rejection.kind) {
			case "quote":
				return "This search can't use the current value because it contains both single and double quotation marks";
			case "geopoint":
				return "This search's current location value needs a valid latitude and longitude";
			case "whole-number":
				return "This search's current value needs to be a whole number";
			case "nonnegative-whole-number":
				return "This search's current value needs to be a whole number that is zero or greater";
			default: {
				const _exhaustive: never = rejection.kind;
				return String(_exhaustive);
			}
		}
	}
	return undefined;
}

type RuntimeRejection = NonNullable<
	ComposedXPathQuery["runtimeRejections"]
>[number];

function runtimeRejectionApplies(
	rejection: RuntimeRejection,
	caseListConfig: CaseListConfig,
	values: SearchInputValues,
	session: PreviewSearchSessionValues,
): boolean {
	const boundCondition = bindRuntimeRejectionCondition(
		rejection.condition,
		caseListConfig,
		values,
		session,
		rejection.kind,
		new Set(rejection.inputNames ?? []),
	);
	return toBoolean(
		evaluate(boundCondition, {
			contextPath: "",
			position: 1,
			size: 1,
			getValue: () => undefined,
			resolveHashtag: () => "",
		}),
	);
}

const UNSIGNED_CSQL_NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const SIGNED_CSQL_NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const NEGATIVE_ZERO = /^-0(?:\.0*)?$/;

/**
 * Preview's scalar evaluator uses JavaScript numeric coercion, which accepts
 * spellings JavaRosa deliberately rejects (`+1`, `1e3`). Check the raw prompt
 * against CCHQ's numeric-token vocabulary before using the shared XPath guard;
 * The emitter canonicalizes negative-zero spellings to the bare token `0`
 * before a raw `subcase-count` bound reaches the server parser, so that one
 * signed spelling remains valid even though other negative values do not.
 */
/**
 * One submission gate for every runtime-only search-value constraint.
 *
 * Quote safety is derived from the exact exported CSQL expression. Daterange
 * pair/order validation mirrors CommCare's indivisible range answer. Keeping
 * both in one map gives the form one error location per prompt without
 * duplicating either setting or semantic rule in the component.
 */
export function searchInputSubmissionErrors(
	caseListConfig: CaseListConfig,
	caseType: string | undefined,
	values: SearchInputValues,
	session: PreviewSearchSessionValues = EMPTY_SEARCH_SESSION,
	typeContext?: TypeContext,
): ReadonlyMap<string, string> {
	const errors = new Map(
		searchInputRuntimeQuoteErrors(
			caseListConfig,
			caseType,
			values,
			session,
			typeContext,
		),
	);
	// A malformed/incomplete range prevents the query from being represented at
	// all, so its actionable range message takes precedence over any secondary
	// CSQL value error attached to the same prompt.
	for (const [name, message] of dateRangeInputErrors(
		caseListConfig.searchInputs,
		values,
	)) {
		errors.set(name, message);
	}
	return errors;
}

/**
 * Replace the two CommCare runtime instance families used by a rejection
 * condition with ordinary XPath literals before handing it to Preview's scalar
 * evaluator. Input presence is special: Core's `count(nodeset)` tests whether
 * the answer exists, while replacing the nodeset with a scalar would make the
 * lightweight evaluator treat every count as zero. Resolve those count calls
 * first, then substitute the value reads.
 */
function bindRuntimeRejectionCondition(
	condition: string,
	caseListConfig: CaseListConfig,
	values: SearchInputValues,
	session: PreviewSearchSessionValues,
	rejectionKind: NonNullable<
		ComposedXPathQuery["runtimeRejections"]
	>[number]["kind"],
	rejectionInputNames: ReadonlySet<string>,
): string {
	let bound = condition;
	const expressionValues = withSearchInputExpressionValues(
		caseListConfig.searchInputs,
		values,
	);

	for (const input of caseListConfig.searchInputs) {
		const path = searchInputXPath(input.name);
		const value = expressionValues.get(input.name) ?? "";
		bound = bound.replaceAll(
			`count(${path})`,
			value === "" ? "false()" : "true()",
		);
		const boundValue =
			rejectionInputNames.has(input.name) &&
			!isValidRuntimeNumericSpelling(rejectionKind, value)
				? "NaN"
				: value;
		// Function replacement: a string replacement would expand `$$`/`$&`/
		// `` $` ``/`$'` inside the worker-typed value and garble the quoted
		// literal before evaluation.
		bound = bound.replaceAll(path, () =>
			quoteLiteral(boundValue, "case-list-filter"),
		);
	}

	bound = bound.replace(
		/instance\('commcaresession'\)\/session\/context\/([A-Za-z_][A-Za-z0-9_.-]*)/g,
		(_match, field: string) =>
			quoteLiteral(
				session.context[field as keyof PreviewSearchSessionValues["context"]] ??
					"",
				"case-list-filter",
			),
	);
	bound = bound.replace(
		/instance\('commcaresession'\)\/session\/user\/data\/([A-Za-z_][A-Za-z0-9_.-]*)/g,
		(_match, field: string) =>
			quoteLiteral(session.user[field] ?? "", "case-list-filter"),
	);
	return bound;
}

function isValidRuntimeNumericSpelling(
	kind: NonNullable<ComposedXPathQuery["runtimeRejections"]>[number]["kind"],
	value: string,
): boolean {
	if (kind === "whole-number") return SIGNED_CSQL_NUMBER.test(value.trim());
	if (kind === "nonnegative-whole-number") {
		const trimmed = value.trim();
		return UNSIGNED_CSQL_NUMBER.test(trimmed) || NEGATIVE_ZERO.test(trimmed);
	}
	return true;
}

function searchInputXPath(name: string): string {
	return `instance('search-input:results')/input/field[@name='${name}']`;
}
