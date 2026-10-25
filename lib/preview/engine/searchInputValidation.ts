/** Running-preview validation that mirrors exported CommCare search prompts. */

import { isSilentRuntimeCsqlRejection } from "@/lib/commcare/csql/segment";
import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import { caseListStepDatumId } from "@/lib/commcare/formLinkProjection";
import {
	buildRuntimeCsqlPromptValidations,
	type ComposedXPathQuery,
	composeXPathQueryEmission,
} from "@/lib/commcare/suite/case-search/xpathQuery";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import {
	type CaseListConfig,
	materializableCaseTypes,
	searchRuntimeGlobalValidationMessage,
} from "@/lib/domain";
import { toBoolean } from "@/lib/preview/xpath/coerce";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "@/lib/preview/xpath/generatedJavaRosaFunctions";
import type { XPathInstance } from "@/lib/preview/xpath/runtimeValues";
import type { PreviewPlatformRules } from "../platform";
import { dateRangeInputErrors } from "./dateRangeInputValidation";
import type { PreviewSearchSessionValues } from "./identity";
import {
	type SearchInputValues,
	withSearchInputExpressionValues,
} from "./runtimeBindings";
import type { PreviewSearchEnvironment } from "./searchExpressionEvaluation";
import {
	type SearchInputConstraintDeviceOptions,
	searchInputConstraintErrors,
	searchInputConstraintErrorsOnDevice,
} from "./searchInputConstraints";
import {
	caseDatabaseXPathInstance,
	commcareSessionXPathInstance,
	locationsXPathInstance,
	lookupXPathInstances,
	searchInputXPathInstance,
} from "./xpathInstances";

const EMPTY_SEARCH_SESSION: PreviewSearchSessionValues = {
	context: {},
	user: {},
	userPropertySlugs: {},
};

interface RuntimeValidationOptions {
	language?: import("@/lib/domain/localization").LanguageTag;
	/**
	 * Validate only rejection conditions that do not read authenticated
	 * session data. Server actions use this pass before opening an authorized
	 * case store, then run the full pass with the resolved worker.
	 */
	sessionIndependentOnly?: boolean;
}

function skipSessionBackedRejection(
	rejection: RuntimeRejection,
	options: RuntimeValidationOptions | undefined,
): boolean {
	return (
		options?.sessionIndependentOnly === true &&
		[...serializeWire(rejection.condition, { target: "suite" }).instances].some(
			(instance) => instance.id === "commcaresession",
		)
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
	environment: PreviewSearchEnvironment,
	options?: RuntimeValidationOptions,
): ReadonlyMap<string, string> {
	const emission = composedSearch(caseListConfig, caseType, environment);
	if (emission === null) return new Map();

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
			environment,
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
	environment: PreviewSearchEnvironment,
	options?: RuntimeValidationOptions,
): string | undefined {
	const emission = composedSearch(caseListConfig, caseType, environment);
	if (emission === null) return undefined;
	for (const rejection of emission?.runtimeRejections ?? []) {
		const kind = rejection.kind;
		if (isSilentRuntimeCsqlRejection(kind)) continue;
		if (skipSessionBackedRejection(rejection, options)) continue;
		if ((rejection.inputNames?.length ?? 0) > 0) continue;
		if (
			!runtimeRejectionApplies(
				rejection,
				caseListConfig,
				values,
				session,
				environment,
			)
		)
			continue;
		return searchRuntimeGlobalValidationMessage(kind).message;
	}
	return undefined;
}

/**
 * Whether the exported search finds nothing for this state with no message:
 * a blank value compared where CommCare's search cannot compare one
 * (`lib/commcare/csql/runtimeCsqlDateSafety.ts`), or a list item that would
 * break its list, which the exported `_xpath_query` wrapper answers with
 * `match-none()`. Preview answers the search with no rows, before it reaches
 * the case store.
 */
export function searchFindsNothing(
	caseListConfig: CaseListConfig,
	caseType: string | undefined,
	values: SearchInputValues,
	session: PreviewSearchSessionValues = EMPTY_SEARCH_SESSION,
	environment: PreviewSearchEnvironment,
	options?: RuntimeValidationOptions,
): boolean {
	const emission = composedSearch(caseListConfig, caseType, environment);
	if (emission === null) return false;
	return (emission?.runtimeRejections ?? []).some(
		(rejection) =>
			isSilentRuntimeCsqlRejection(rejection.kind) &&
			!skipSessionBackedRejection(rejection, options) &&
			runtimeRejectionApplies(
				rejection,
				caseListConfig,
				values,
				session,
				environment,
			),
	);
}

type RuntimeRejection = NonNullable<
	ComposedXPathQuery["runtimeRejections"]
>[number];

/**
 * The module's composed search as the export writes it: each source in its
 * own slot's context, and each case chosen before the module's case list
 * step printed under the id the step holds. `null` when a temporarily
 * invalid or legacy config cannot be composed: the document validator stays
 * the authoring gate, so the running preview adds no error of its own.
 */
function composedSearch(
	caseListConfig: CaseListConfig,
	caseType: string | undefined,
	environment: PreviewSearchEnvironment,
): ComposedXPathQuery | undefined | null {
	try {
		return composeXPathQueryEmission(
			caseListConfig,
			caseType,
			moduleExpressionContexts(
				environment.doc,
				environment.moduleUuid,
				environment.lookup?.naming,
			),
			environment.lookup?.naming,
			undefined,
			caseListStepDatumId(environment.doc, environment.moduleUuid),
		);
	} catch {
		return null;
	}
}

/**
 * Whether an obligation holds over the Search screen's world: the answers,
 * the session with the datums supplied before the list, and, where the
 * environment holds them, the device's cases, places and lookup tables.
 *
 * An obligation that reads part of that world the environment does not hold
 * (the server holds no device snapshot) is not judged here: the browser,
 * which holds it, judges it with the search's runtime values
 * (`searchCsqlRuntime.ts`), and a row it finds rejected finds nothing.
 */
function runtimeRejectionApplies(
	rejection: RuntimeRejection,
	caseListConfig: CaseListConfig,
	values: SearchInputValues,
	session: PreviewSearchSessionValues,
	environment: PreviewSearchEnvironment,
): boolean {
	const printed = serializeWire(rejection.condition, { target: "suite" });
	const held = (id: string) =>
		id === "search-input:results" ||
		id === "commcaresession" ||
		((id === "casedb" || id === "locations") &&
			environment.caseDatabase !== undefined) ||
		(environment.lookup !== undefined &&
			lookupInstanceIds(environment).has(id));
	if (![...printed.instances].every((instance) => held(instance.id)))
		return false;
	if (
		environment.sessionData === undefined &&
		readsSessionData(rejection.condition)
	)
		return false;
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
	const instances = new Map<string, XPathInstance>([
		[
			"search-input:results",
			searchInputXPathInstance(answers, "search-input:results"),
		],
		[
			"commcaresession",
			commcareSessionXPathInstance(session, environment.sessionData),
		],
		...(environment.lookup === undefined
			? []
			: lookupXPathInstances(environment.lookup, {
					includeFixtureAliases: true,
				})),
	]);
	if (environment.caseDatabase !== undefined) {
		instances.set(
			"casedb",
			caseDatabaseXPathInstance(
				environment.caseDatabase,
				materializableCaseTypes(environment.doc),
			),
		);
		const locations = environment.caseDatabase?.locations;
		if (locations !== undefined)
			instances.set(
				"locations",
				locationsXPathInstance(locations, environment.doc),
			);
	}
	return toBoolean(
		evaluate(printed.text, {
			contextPath: "",
			position: 1,
			getValue: () => undefined,
			resolveXPathInstance: (id) => instances.get(id),
			invokeGeneratedFunction: invokeGeneratedJavaRosaFunction,
		}),
	);
}

function lookupInstanceIds(
	environment: PreviewSearchEnvironment,
): ReadonlySet<string> {
	return new Set(
		lookupXPathInstances(environment.lookup ?? null, {
			includeFixtureAliases: true,
		}).keys(),
	);
}

/** Whether a condition reads a session datum, `session/data/<id>`. */
function readsSessionData(wire: WireExpr): boolean {
	switch (wire.k) {
		case "path":
			return (
				(wire.root.k === "instance" &&
					wire.root.decl.id === "commcaresession" &&
					wire.steps[0]?.name === "session" &&
					wire.steps[1]?.name === "data") ||
				wire.steps.some((step) => step.predicates.some(readsSessionData))
			);
		case "cmp":
		case "arith":
			return readsSessionData(wire.left) || readsSessionData(wire.right);
		case "and":
		case "or":
			return wire.items.some(readsSessionData);
		case "neg":
			return readsSessionData(wire.value);
		case "call":
			return wire.args.some(readsSessionData);
		case "expansion":
			return readsSessionData(wire.expr);
		default:
			return false;
	}
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
	rules: Pick<PreviewPlatformRules, "searchFieldChecks">,
	caseListConfig: CaseListConfig,
	caseType: string | undefined,
	values: SearchInputValues,
	session: PreviewSearchSessionValues = EMPTY_SEARCH_SESSION,
	environment: PreviewSearchEnvironment,
	options?: RuntimeValidationOptions,
): ReadonlyMap<string, string> {
	const errors = new Map(
		searchInputRuntimeQuoteErrors(
			caseListConfig,
			caseType,
			values,
			session,
			environment,
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
		rules,
		caseListConfig.searchInputs,
		values,
		session,
		environment,
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
	rules: Pick<PreviewPlatformRules, "searchFieldChecks">,
	caseListConfig: CaseListConfig,
	caseType: string | undefined,
	values: SearchInputValues,
	session: PreviewSearchSessionValues = EMPTY_SEARCH_SESSION,
	environment: PreviewSearchEnvironment,
	options: RuntimeValidationOptions &
		Pick<SearchInputConstraintDeviceOptions, "evaluateOnDevice">,
): Promise<ReadonlyMap<string, string>> {
	const errors = new Map(
		searchInputRuntimeQuoteErrors(
			caseListConfig,
			caseType,
			values,
			session,
			environment,
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
		rules,
		caseListConfig.searchInputs,
		values,
		session,
		environment,
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
