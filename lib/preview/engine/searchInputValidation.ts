/** Running-preview validation that mirrors exported CommCare search prompts. */

import {
	buildRuntimeCsqlPromptValidations,
	type ComposedXPathQuery,
	composeXPathQueryEmission,
} from "@/lib/commcare/suite/case-search/xpathQuery";
import {
	type CaseListConfig,
	searchInputRuntimeValueType,
	searchRuntimeGlobalValidationMessage,
} from "@/lib/domain";
import type { TypeContext } from "@/lib/domain/predicate";
import { toBoolean } from "@/lib/preview/xpath/coerce";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "@/lib/preview/xpath/generatedJavaRosaFunctions";
import { dateRangeInputErrors } from "./dateRangeInputValidation";
import type { PreviewSearchSessionValues } from "./identity";
import type { PreviewLookupData } from "./lookupEvaluation";
import {
	type SearchInputValues,
	withSearchInputExpressionValues,
} from "./runtimeBindings";
import {
	type SearchInputConstraintDeviceOptions,
	searchInputConstraintErrors,
	searchInputConstraintErrorsOnDevice,
} from "./searchInputConstraints";

import {
	commcareSessionXPathInstance,
	searchInputXPathInstance,
} from "./xpathInstances";

const EMPTY_SEARCH_SESSION: PreviewSearchSessionValues = {
	context: {},
	user: {},
	userPropertySlugs: {},
};

interface RuntimeValidationOptions {
	/**
	 * Validate only rejection conditions that do not read authenticated
	 * session data. Server actions use this pass before opening an authorized
	 * case store, then run the full pass with the resolved worker.
	 */
	sessionIndependentOnly?: boolean;
	/**
	 * The lookup rows a required condition or check may fold over. A caller
	 * without them (the server action) leaves lookup-bearing constraints
	 * unjudged rather than guessing.
	 */
	lookupData?: PreviewLookupData;
}

function skipSessionBackedRejection(
	rejection: RuntimeRejection,
	options: RuntimeValidationOptions | undefined,
): boolean {
	return (
		options?.sessionIndependentOnly === true &&
		rejection.condition.includes("instance('commcaresession')")
	);
}

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
	options?: RuntimeValidationOptions,
): ReadonlyMap<string, string> {
	let emission: ComposedXPathQuery | undefined;
	try {
		emission = composeXPathQueryEmission(
			caseListConfig,
			caseType,
			withSearchInputBindings(caseListConfig, typeContext),
		);
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
		if (skipSessionBackedRejection(rejection, options)) continue;
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
	options?: RuntimeValidationOptions,
): string | undefined {
	let emission: ComposedXPathQuery | undefined;
	try {
		emission = composeXPathQueryEmission(
			caseListConfig,
			caseType,
			withSearchInputBindings(caseListConfig, typeContext),
		);
	} catch {
		return undefined;
	}
	for (const rejection of emission?.runtimeRejections ?? []) {
		if (skipSessionBackedRejection(rejection, options)) continue;
		if ((rejection.inputNames?.length ?? 0) > 0) continue;
		if (!runtimeRejectionApplies(rejection, caseListConfig, values, session)) {
			continue;
		}
		return searchRuntimeGlobalValidationMessage(rejection.kind).message;
	}
	return undefined;
}

/**
 * Runtime validation owns the complete search-input declarations, so it can
 * always project immutable references to their current saved names. Do not
 * rely on a caller to duplicate this identity map: standalone Preview surfaces
 * and scoped tests legitimately have no module-level validator context.
 */
function withSearchInputBindings(
	caseListConfig: CaseListConfig,
	typeContext: TypeContext | undefined,
): TypeContext {
	return {
		...(typeContext ?? { caseTypes: [], knownInputs: [] }),
		knownInputs: caseListConfig.searchInputs.map((input) => ({
			uuid: input.uuid,
			name: input.name,
			label: input.label,
			data_type: searchInputRuntimeValueType(input),
		})),
	};
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
	const expressionValues = withSearchInputExpressionValues(
		caseListConfig.searchInputs,
		values,
	);
	const inputNames = new Set(rejection.inputNames ?? []);
	const answers = new Map(
		caseListConfig.searchInputs.flatMap((input): [string, string][] => {
			const value = expressionValues.get(input.name) ?? "";
			if (value === "") return [];
			return [
				[
					input.name,
					inputNames.has(input.name) &&
					!isValidRuntimeNumericSpelling(rejection.kind, value)
						? "NaN"
						: value,
				],
			];
		}),
	);
	const inputInstance = searchInputXPathInstance(
		answers,
		"search-input:results",
	);
	const sessionInstance = commcareSessionXPathInstance(session);
	return toBoolean(
		evaluate(rejection.condition, {
			contextPath: "",
			position: 1,
			getValue: () => undefined,
			resolveHashtag: () => "",
			resolveXPathInstance: (id) =>
				id === "search-input:results"
					? inputInstance
					: id === "commcaresession"
						? sessionInstance
						: undefined,
			invokeGeneratedFunction: invokeGeneratedJavaRosaFunction,
		}),
	);
}

const UNSIGNED_CSQL_NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const SIGNED_CSQL_NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const NEGATIVE_ZERO = /^-0(?:\.0*)?$/;

/**
 * One submission gate for every search-value constraint the running app
 * enforces before a query is sent.
 *
 * Quote safety is derived from the exact exported CSQL expression. Daterange
 * pair/order validation mirrors CommCare's indivisible range answer. The
 * authored required condition and check are the prompt's `<required>` /
 * `<validation>`, evaluated over the draft with its siblings. Keeping all of
 * them in one map gives the form one error location per prompt without
 * duplicating any setting or semantic rule in the component; an authored
 * message wins over a system one on the same prompt, because the worker can
 * act on it directly.
 */
export function searchInputSubmissionErrors(
	caseListConfig: CaseListConfig,
	caseType: string | undefined,
	values: SearchInputValues,
	session: PreviewSearchSessionValues = EMPTY_SEARCH_SESSION,
	typeContext?: TypeContext,
	options?: RuntimeValidationOptions,
): ReadonlyMap<string, string> {
	const errors = new Map(
		searchInputRuntimeQuoteErrors(
			caseListConfig,
			caseType,
			values,
			session,
			typeContext,
			options,
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
	for (const [name, message] of searchInputConstraintErrors(
		caseListConfig.searchInputs,
		values,
		session,
		options?.lookupData,
		options,
	)) {
		errors.set(name, message);
	}
	return errors;
}

/**
 * The same gate for the running Search screen, which can reach the XPath
 * worker: a pattern-bearing required condition or check is judged there
 * instead of being left unjudged. Every other constraint is decided exactly
 * as in `searchInputSubmissionErrors`, so the two gates differ only in what
 * a Pattern engine adds.
 */
export async function searchInputSubmissionErrorsOnDevice(
	caseListConfig: CaseListConfig,
	caseType: string | undefined,
	values: SearchInputValues,
	session: PreviewSearchSessionValues = EMPTY_SEARCH_SESSION,
	typeContext: TypeContext | undefined,
	options: RuntimeValidationOptions &
		Pick<SearchInputConstraintDeviceOptions, "evaluateOnDevice">,
): Promise<ReadonlyMap<string, string>> {
	const errors = new Map(
		searchInputRuntimeQuoteErrors(
			caseListConfig,
			caseType,
			values,
			session,
			typeContext,
			options,
		),
	);
	for (const [name, message] of dateRangeInputErrors(
		caseListConfig.searchInputs,
		values,
	)) {
		errors.set(name, message);
	}
	for (const [name, message] of await searchInputConstraintErrorsOnDevice(
		caseListConfig.searchInputs,
		values,
		session,
		options.lookupData,
		options,
	)) {
		errors.set(name, message);
	}
	return errors;
}

/** CSQL numeric tokens are stricter than an XPath numeric value. Preserve the
 * emitted guard's vocabulary, including canonicalized negative zero. */
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
