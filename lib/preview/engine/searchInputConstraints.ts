// lib/preview/engine/searchInputConstraints.ts
//
// The two author-facing constraints a Search prompt carries, evaluated over
// the worker's draft exactly as CommCare's query screen evaluates them
// (`RemoteQuerySessionManager.validateUserAnswers`):
//
//   - REQUIRED fires only when the answer is blank. An unconditional
//     requirement always fires on blank; a conditional one fires on blank
//     when its `when` predicate holds against the sibling answers.
//   - VALIDATION (the check) is skipped when the answer is blank and fires
//     when its rule evaluates false against the answer and its siblings.
//
// Both predicates read the search-input instance, so a bare `input(...)` of
// any sibling is meaningful here; an unanswered sibling holds no node there
// and reads blank. There is no case row on this screen, and the validator
// has already refused every case read in these slots.
//
// A predicate is judged by whichever evaluator can run it. The scalar
// evaluator on the calling thread runs everything except a pattern match:
// user-authored Java patterns execute only in the XPath worker
// (`lib/preview/CLAUDE.md`), so a pattern-bearing constraint is judged
// through the caller-supplied `evaluateOnDevice` and, without one, is left
// unjudged: it neither fires nor clears on that pass.
//
// The server action re-runs this gate before opening a case store so a
// request built by hand cannot skip a required prompt Preview enforced. It
// holds no Pattern engine, so a pattern-bearing constraint is Preview's to
// enforce, the same standing a lookup-bearing one has there.

import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import {
	type SearchInputDef,
	searchInputRequiredMessage,
	type Uuid,
	type VisibleSearchInputDef,
} from "@/lib/domain";
import {
	type Expression,
	expressionUsesPattern,
	walkExpressionTerms,
} from "@/lib/domain/expression";
import type { PreviewPlatformRules } from "../platform";
import type { PreviewSearchSessionValues } from "./identity";
import {
	type PreviewLookupData,
	predicateLookupsCovered,
} from "./lookupEvaluation";
import {
	type SearchInputValues,
	withSearchInputExpressionValues,
} from "./runtimeBindings";
import {
	emitPreviewSearchPredicate,
	evaluatePreviewSearchPredicate,
	type PreviewSearchEnvironment,
	type SearchScreenXPath,
} from "./searchExpressionEvaluation";

/** The platform's rule for a Search field's required condition and checks:
 *  Web Apps enforces them (manifest `case-search/required-test-text`,
 *  `validations-0-test-text`); Android searches whatever the answers, so
 *  every function here returns no errors and no marks there. */
type SearchFieldCheckRules = Pick<PreviewPlatformRules, "searchFieldChecks">;

export interface SearchInputConstraintOptions {
	/**
	 * Evaluate only constraints whose predicates read no authenticated session
	 * data. The server action uses this pass before it has resolved the worker,
	 * then runs the full pass with the resolved session.
	 */
	readonly sessionIndependentOnly?: boolean;
}

export interface SearchInputConstraintDeviceOptions
	extends SearchInputConstraintOptions {
	/**
	 * Run one printed Search screen XPath over the instances it reads where a
	 * Java Pattern engine is available, and answer its boolean. Only a
	 * pattern-bearing predicate takes this path; everything else stays on the
	 * calling thread's evaluator, over the same text and instances, so the two
	 * paths cannot disagree on plain rules.
	 */
	readonly evaluateOnDevice: (xpath: SearchScreenXPath) => Promise<boolean>;
}

/**
 * Per-prompt required / check errors over the draft, keyed by the prompt's
 * wire name. At most one message per prompt: required wins over the check,
 * because the check never runs on a blank answer. Pattern-bearing
 * constraints are left unjudged here.
 */
export function searchInputConstraintErrors(
	rules: SearchFieldCheckRules,
	searchInputs: readonly SearchInputDef[],
	values: SearchInputValues,
	session: PreviewSearchSessionValues,
	environment: PreviewSearchEnvironment,
	options?: SearchInputConstraintOptions,
): ReadonlyMap<string, string> {
	if (!rules.searchFieldChecks) return new Map();
	const judge = constraintJudge(
		searchInputs,
		values,
		session,
		environment,
		options,
	);
	const errors = new Map<string, string>();
	for (const check of constraintChecks(searchInputs, values)) {
		if (errors.has(check.name)) continue;
		if (
			check.fires(judge(check.predicate, check.searchInputUuid, check.slot))
		) {
			errors.set(check.name, check.message);
		}
	}
	return errors;
}

/**
 * The same gate with a Pattern engine in reach: pattern-bearing constraints
 * are judged through `evaluateOnDevice`, one request per constraint, so the
 * running Search screen enforces a pattern check exactly as the device does.
 */
export async function searchInputConstraintErrorsOnDevice(
	rules: SearchFieldCheckRules,
	searchInputs: readonly SearchInputDef[],
	values: SearchInputValues,
	session: PreviewSearchSessionValues,
	environment: PreviewSearchEnvironment,
	options: SearchInputConstraintDeviceOptions,
): Promise<ReadonlyMap<string, string>> {
	if (!rules.searchFieldChecks) return new Map();
	const judge = constraintJudge(
		searchInputs,
		values,
		session,
		environment,
		options,
	);
	const errors = new Map<string, string>();
	for (const check of constraintChecks(searchInputs, values)) {
		if (errors.has(check.name)) continue;
		let holds: boolean | undefined;
		if (
			check.predicate !== undefined &&
			expressionUsesPattern(check.predicate)
		) {
			holds = judgeable(check.predicate, environment.lookup, options)
				? await options.evaluateOnDevice(
						emitPreviewSearchPredicate(
							check.predicate,
							moduleExpressionContexts(
								environment.doc,
								environment.moduleUuid,
								environment.lookup?.naming,
							)({
								slot: check.slot,
								member: { searchInputUuid: check.searchInputUuid },
							}),
							environment,
							searchInputs,
							session,
							values,
						),
					)
				: undefined;
		} else {
			holds = judge(check.predicate, check.searchInputUuid, check.slot);
		}
		if (check.fires(holds)) errors.set(check.name, check.message);
	}
	return errors;
}

/**
 * Whether each visible prompt is required at this moment, keyed by the
 * prompt's wire name: `true` for an unconditional requirement, the
 * condition's verdict over the draft for a conditional one, and
 * `undefined` where this thread cannot judge the condition (a pattern, or
 * a lookup carrier whose rows the caller does not hold). The device
 * evaluates the same test on every answer change
 * (`RemoteQuerySessionManager.java::refreshInputDependentState`), and the
 * Search screen's required mark follows it.
 */
export function searchInputRequiredMarks(
	rules: SearchFieldCheckRules,
	searchInputs: readonly SearchInputDef[],
	values: SearchInputValues,
	session: PreviewSearchSessionValues,
	environment: PreviewSearchEnvironment,
): ReadonlyMap<string, boolean | undefined> {
	if (!rules.searchFieldChecks) return new Map();
	const judge = constraintJudge(
		searchInputs,
		values,
		session,
		environment,
		undefined,
	);
	const marks = new Map<string, boolean | undefined>();
	for (const input of searchInputs) {
		if (input.kind === "hidden" || input.required === undefined) continue;
		marks.set(
			input.name,
			input.required.when === undefined
				? true
				: judge(input.required.when, input.uuid, "search_input_required_when"),
		);
	}
	return marks;
}

/**
 * The marks {@link searchInputRequiredMarks} leaves unjudged for want of a
 * Pattern engine, judged on the device: one request per pattern-bearing
 * condition. Conditions left unjudged for another reason (uncovered lookup
 * rows) stay absent.
 */
export async function searchInputRequiredMarksOnDevice(
	rules: SearchFieldCheckRules,
	searchInputs: readonly SearchInputDef[],
	values: SearchInputValues,
	session: PreviewSearchSessionValues,
	environment: PreviewSearchEnvironment,
	options: SearchInputConstraintDeviceOptions,
): Promise<ReadonlyMap<string, boolean>> {
	const marks = new Map<string, boolean>();
	if (!rules.searchFieldChecks) return marks;
	for (const input of searchInputs) {
		if (input.kind === "hidden") continue;
		const when = input.required?.when;
		if (when === undefined || !expressionUsesPattern(when)) continue;
		if (!judgeable(when, environment.lookup, options)) continue;
		marks.set(
			input.name,
			await options.evaluateOnDevice(
				emitPreviewSearchPredicate(
					when,
					moduleExpressionContexts(
						environment.doc,
						environment.moduleUuid,
						environment.lookup?.naming,
					)({
						slot: "search_input_required_when",
						member: { searchInputUuid: input.uuid },
					}),
					environment,
					searchInputs,
					session,
					values,
				),
			),
		);
	}
	return marks;
}

/** One constraint to judge: which prompt, what it says, and how the
 *  predicate's verdict decides it. `predicate` is absent for an
 *  unconditional requirement, which fires on a blank answer outright. */
interface ConstraintCheck {
	readonly searchInputUuid: Uuid;
	readonly slot: "search_input_required_when" | "search_input_validation_rule";
	readonly name: string;
	readonly message: string;
	readonly predicate: Expression | undefined;
	readonly fires: (holds: boolean | undefined) => boolean;
}

/** The checks the draft raises, in prompt order: at most one per prompt,
 *  the required side on a blank answer and the check on a nonblank one. */
function constraintChecks(
	searchInputs: readonly SearchInputDef[],
	values: SearchInputValues,
): readonly ConstraintCheck[] {
	const expressionValues = withSearchInputExpressionValues(
		searchInputs,
		values,
	);
	const checks: ConstraintCheck[] = [];
	for (const input of searchInputs) {
		if (input.kind === "hidden") continue;
		const answer = expressionValues.get(input.name) ?? "";
		if (answer === "") {
			const required = requiredCheck(input);
			if (required !== undefined) checks.push(required);
			continue;
		}
		if (input.validation === undefined) continue;
		checks.push({
			searchInputUuid: input.uuid,
			slot: "search_input_validation_rule",
			name: input.name,
			message: input.validation.message,
			predicate: input.validation.rule,
			fires: (holds) => holds === false,
		});
	}
	return checks;
}

function requiredCheck(
	input: VisibleSearchInputDef,
): ConstraintCheck | undefined {
	const message = searchInputRequiredMessage(input);
	if (message === undefined || input.required === undefined) return undefined;
	const when = input.required.when;
	return when === undefined
		? {
				searchInputUuid: input.uuid,
				slot: "search_input_required_when",
				name: input.name,
				message,
				predicate: undefined,
				fires: () => true,
			}
		: {
				searchInputUuid: input.uuid,
				slot: "search_input_required_when",
				name: input.name,
				message,
				predicate: when,
				fires: (holds) => holds === true,
			};
}

/**
 * The scalar-thread verdict. `undefined` means "cannot be judged here": a
 * session read before the worker is resolved, a lookup carrier whose rows
 * this caller does not hold, or a pattern this thread has no engine for.
 */
function constraintJudge(
	searchInputs: readonly SearchInputDef[],
	values: SearchInputValues,
	session: PreviewSearchSessionValues,
	environment: PreviewSearchEnvironment,
	options: SearchInputConstraintOptions | undefined,
): (
	predicate: Expression | undefined,
	inputUuid: Uuid,
	slot: ConstraintCheck["slot"],
) => boolean | undefined {
	const contexts = moduleExpressionContexts(
		environment.doc,
		environment.moduleUuid,
		environment.lookup?.naming,
	);
	return (predicate, inputUuid, slot) => {
		if (predicate === undefined) return undefined;
		if (!judgeable(predicate, environment.lookup, options)) return undefined;
		if (expressionUsesPattern(predicate)) return undefined;
		return evaluatePreviewSearchPredicate(
			predicate,
			contexts({ slot, member: { searchInputUuid: inputUuid } }),
			environment,
			searchInputs,
			session,
			values,
		);
	};
}

function judgeable(
	predicate: Expression,
	lookupData: PreviewLookupData | undefined,
	options: SearchInputConstraintOptions | undefined,
): boolean {
	if (
		options?.sessionIndependentOnly === true &&
		predicateReadsSession(predicate)
	) {
		return false;
	}
	return predicateLookupsCovered(predicate, lookupData);
}

function predicateReadsSession(predicate: Expression): boolean {
	let reads = false;
	walkExpressionTerms(predicate, (term) => {
		if (
			term.kind === "session-user" ||
			term.kind === "session-user-property" ||
			term.kind === "session-context"
		) {
			reads = true;
		}
	});
	return reads;
}
