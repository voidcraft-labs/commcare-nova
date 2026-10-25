import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	type Uuid,
} from "@/lib/domain";
import { effectiveFilterForEmission } from "@/lib/domain/expression";
import type { LanguageTag } from "@/lib/domain/localization";
import { resolveAppLanguage } from "@/lib/domain/localization";
import { automaticallyLaunchesSearch } from "../caseListPhase";
import { previewPlatformRules } from "../platform";
import { projectWorkerModule } from "../workerModule";
import { toBoolean } from "../xpath/coerce";
import { createInProcessXPathWorkerFactory } from "../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../xpath/workerProjection";
import type { FormEvaluationContext } from "./formEvaluationTypes";
import { FormEvaluationInputError } from "./formEvaluationTypes";
import { previewSessionValues } from "./identity";
import { previewLookupData } from "./lookupEvaluation";
import { withSearchInputExpressionValues } from "./runtimeBindings";
import {
	evaluatePreviewSearchExpression,
	evaluatePreviewSearchPredicate,
	parseExcludedOwnerIds,
	searchScreenWorkerInstances,
} from "./searchExpressionEvaluation";
import { searchInputSubmissionErrorsOnDevice } from "./searchInputValidation";
import {
	buildSearchRunState,
	changeSearchRunDraft,
	restoreSearchRun,
	withHiddenValues,
} from "./searchRunState";

export interface SearchEvaluationInput {
	language?: LanguageTag;
	moduleUuid: Uuid;
	/** A previous completed search, including its system-generated values. */
	submitted?: readonly { name: string; value: string }[];
	/** The current screen's draft and validation survive separate tool calls. */
	entry?: {
		draft: readonly { name: string; value: string }[];
		errors: Readonly<Record<string, string>>;
	};
	/** Omitted observes the screen; an empty array presses Search with defaults. */
	answers?: readonly { name: string; value: string }[];
}

/** Runs the authored Search screen in the same bounded worker as FormEngine.
 * The caller supplies answers, never an expression or a replacement condition. */
export async function evaluateSearchSnapshot(
	doc: BlueprintDoc,
	input: SearchEvaluationInput,
	context: FormEvaluationContext,
) {
	const language = resolveAppLanguage(doc.localization, input.language);
	const mod = projectWorkerModule(doc, language, input.moduleUuid);
	if (!mod) throw new FormEvaluationInputError("Menu not found.");
	const config = mod.caseListConfig;
	const inputs = config?.searchInputs ?? [];
	const search = effectiveCaseSearchConfig(mod);
	const session = previewSessionValues(context.identity, context.device);
	const rules = previewPlatformRules(context.device.platform);
	const lookup = previewLookupData(context.lookup);
	const environment = {
		doc,
		moduleUuid: input.moduleUuid,
		lookup,
		caseDatabase: context.cases,
	};
	const expressions = moduleExpressionContexts(
		doc,
		input.moduleUuid,
		lookup.naming,
	);
	const relevant =
		search !== undefined &&
		(search.searchButtonDisplayCondition === undefined ||
			evaluatePreviewSearchPredicate(
				search.searchButtonDisplayCondition,
				expressions({ slot: "search_button_display_condition" }),
				environment,
				inputs,
				session,
				new Map(),
			));
	let run = buildSearchRunState(input.moduleUuid, inputs, session, environment);
	if (input.submitted !== undefined)
		run = restoreSearchRun(
			run,
			run,
			new Map(input.submitted.map(({ name, value }) => [name, value])),
		);
	if (input.entry)
		run = changeSearchRunDraft(
			run,
			run,
			new Map(input.entry.draft.map(({ name, value }) => [name, value])),
			false,
		);
	const errors = new Map<string, string>(
		Object.entries(input.entry?.errors ?? {}),
	);
	if (input.answers !== undefined) {
		errors.clear();
		if (!relevant || !config)
			throw new FormEvaluationInputError(
				"Search is not available on this screen.",
			);
		const values = new Map(run.draft);
		const seen = new Set<string>();
		for (const { name, value } of input.answers) {
			if (!run.allowedKeys.has(name) || seen.has(name))
				throw new FormEvaluationInputError(
					`Search answer ${name} is unavailable or repeated.`,
				);
			seen.add(name);
			values.set(name, value);
		}
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});
		try {
			const found = await searchInputSubmissionErrorsOnDevice(
				rules,
				config,
				mod.caseType,
				values,
				session,
				environment,
				{
					language,
					evaluateOnDevice: async (xpath) => {
						const result = await runtime.request(
							{
								entryKey: `search:${input.moduleUuid}`,
								revision: 0,
								profile: "search",
								source: xpath.source,
								instances: searchScreenWorkerInstances(xpath),
								dayNumberEpoch: rules.dayNumberEpoch,
							},
							{ signal: AbortSignal.timeout(30_000) },
						);
						if (!result.ok)
							throw new FormEvaluationInputError(
								`The search check could not be evaluated (${result.error.code}).`,
							);
						return toBoolean(deserializeXPathWorkerValue(result.value));
					},
				},
			);
			for (const [key, value] of found) errors.set(key, value);
		} finally {
			runtime.dispose();
		}
		run = changeSearchRunDraft(run, run, values, errors.size === 0);
	}
	// Use the same input-free launch decision as the running app.
	if (
		automaticallyLaunchesSearch({
			relevant,
			searchFirst: search?.searchFirst === true,
			hasVisibleInputs: run.allowedKeys.size > 0,
			hasEffectiveFilter:
				effectiveFilterForEmission(mod.caseListConfig?.filter) !== undefined,
			rules,
		}) &&
		!run.hasSubmitted
	)
		run = changeSearchRunDraft(run, run, new Map(), true);
	const values = relevant
		? withHiddenValues(run.submitted, run.submittedHidden)
		: new Map<string, string>();
	const expressionValues = withSearchInputExpressionValues(inputs, values);
	const excluded = (answers: ReadonlyMap<string, string>) =>
		mod.caseSearchConfig?.excludedOwnerIds === undefined
			? undefined
			: parseExcludedOwnerIds(
					evaluatePreviewSearchExpression(
						mod.caseSearchConfig.excludedOwnerIds,
						expressions({ slot: "excluded_owner_ids" }),
						session,
						answers,
						inputs,
						lookup,
					),
				);
	return {
		relevant,
		searchFirst: search?.searchFirst === true,
		hasVisibleInputs: run.allowedKeys.size > 0,
		hasSubmitted: run.hasSubmitted,
		draft: [...run.draft].map(([name, value]) => ({ name, value })),
		submitted: run.hasSubmitted
			? [...withHiddenValues(run.submitted, run.submittedHidden)].map(
					([name, value]) => ({ name, value }),
				)
			: undefined,
		errors: Object.fromEntries(errors),
		inputValues: values,
		expressionValues,
		excludedOwnerIds: excluded(expressionValues),
		authoredExcludedOwnerIds: excluded(
			withSearchInputExpressionValues(inputs, new Map()),
		),
	};
}
