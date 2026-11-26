import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	moduleFormsReadSearch,
	moduleSearchWorkflow,
	type Uuid,
} from "@/lib/domain";
import type { LanguageTag } from "@/lib/domain/localization";
import { resolveAppLanguage } from "@/lib/domain/localization";
import { caseListStep } from "../caseListPhase";
import { previewPlatformRules } from "../platform";
import { projectWorkerModule } from "../workerModule";
import { toBoolean } from "../xpath/coerce";
import { createInProcessXPathWorkerFactory } from "../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../xpath/workerProjection";
import { readPreviewScreen } from "./dataRefusal";
import { caseListStepSession } from "./entrySessionData";
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
	openSearchRunState,
	restoreSearchRun,
	withHiddenValues,
} from "./searchRunState";
import { readingSurfaceNow, surfacedRefusal } from "./surfacedDataRefusal";

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
 * The caller supplies answers, never an expression or a replacement condition.
 * A read of data the device lacks is the refusal of the surface Preview shows
 * it on (`surfacedDataRefusal.ts`): the Search action's condition stops the
 * case list that offers the action, and every other read here is the Search
 * screen's. */
export async function evaluateSearchSnapshot(
	doc: BlueprintDoc,
	input: SearchEvaluationInput,
	context: FormEvaluationContext,
) {
	try {
		return await searchSnapshot(doc, input, context);
	} catch (error) {
		throw surfacedRefusal(error, "search");
	}
}

async function searchSnapshot(
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
	const slot = mod.caseListRegistrationForm;
	const rule = slot?.kind === "always" ? slot.showWhen : undefined;
	const actionCondition = search?.searchButtonDisplayCondition;
	const relevant =
		search !== undefined &&
		(actionCondition === undefined ||
			readingSurfaceNow("list", () =>
				evaluatePreviewSearchPredicate(
					actionCondition,
					expressions({ slot: "search_button_display_condition" }),
					environment,
					inputs,
					session,
					new Map(),
				),
			));
	const workflow = moduleSearchWorkflow(mod);
	const formsReadSearch = moduleFormsReadSearch(mod);
	/* The Search screen opens as Preview opens it (`openSearchRunState`),
	 * making every read Core's query manager makes as it is built. A read of
	 * data the device lacks stops a menu that opens on its search or its
	 * results (the step is not `browse`); a list that opens first keeps its
	 * cases, holds no field and no search, and its Search pane is the
	 * refusal, so the worker's Search is refused as the device refuses it
	 * when the press builds the query screen (`CaseListScreen`'s
	 * `screenRefusal` and its refused pane). */
	const opened = readPreviewScreen(() =>
		openSearchRunState(input.moduleUuid, inputs, session, environment),
	);
	if (opened.kind === "refused") {
		const step = caseListStep({
			workflow,
			formsReadSearch,
			searchRelevant: relevant,
			hasSubmitted: false,
			rules,
		});
		if (step !== "browse" || (relevant && input.answers !== undefined))
			throw opened.refusal;
	}
	const paneRefusal =
		opened.kind === "refused" && relevant ? opened.refusal.reason : undefined;
	let run =
		opened.kind === "read"
			? opened.value
			: buildSearchRunState(input.moduleUuid, [], session, environment);
	if (opened.kind === "read" && input.submitted !== undefined)
		run = restoreSearchRun(
			run,
			run,
			new Map(input.submitted.map(({ name, value }) => [name, value])),
		);
	if (opened.kind === "read" && input.entry)
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
	/* The case list's step decides what the worker sees, as on the running
	 * app: where it is Results with nothing submitted, the default search
	 * runs as the menu opens (skip to results). */
	if (
		!run.hasSubmitted &&
		caseListStep({
			workflow,
			formsReadSearch,
			searchRelevant: relevant,
			hasSubmitted: false,
			rules,
		}) === "results"
	)
		run = changeSearchRunDraft(run, run, new Map(), true);
	const listVisible =
		caseListStep({
			workflow,
			formsReadSearch,
			searchRelevant: relevant,
			hasSubmitted: run.hasSubmitted,
			rules,
		}) !== "search";
	const formActionRelevant =
		listVisible &&
		(rule?.kind !== "condition" ||
			readingSurfaceNow("list", () =>
				evaluatePreviewSearchPredicate(
					rule.condition,
					expressions({ slot: "case_list_action_condition" }),
					{
						...environment,
						sessionData: caseListStepSession(doc, input.moduleUuid, {
							menuSelections: context.session?.menuSelections ?? {},
							caseDatabase: context.cases,
							session,
						}).data,
					},
					[],
					session,
				),
			));
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
	/* The assigned-case exclusion is a rule of the Results read, which
	 * Preview evaluates as it reads Results (`caseDataBinding.ts::
	 * prepareRunningCaseRead`) and shows a refusal of as the list's. So a
	 * refusal here is held as data, and the records read throws it, named
	 * the list's, only where it reads Results
	 * (`serverSearchRead.ts::serverRecordsRead`): a menu on its Search
	 * screen reads no Results and refuses nothing for it. */
	const exclusion = readPreviewScreen(() => ({
		excludedOwnerIds: excluded(expressionValues),
		authoredExcludedOwnerIds: excluded(
			withSearchInputExpressionValues(inputs, new Map()),
		),
	}));
	return {
		relevant,
		formActionRelevant,
		/** The Search pane's refusal on a list that opens first: the screen
		 *  refused data the worker's device lacks as it opened, so the list
		 *  holds no search and a Search press is refused. Plain data, so it
		 *  crosses the worker thread. */
		...(paneRefusal === undefined ? {} : { paneRefusal }),
		/** The module's search workflow; undefined with no effective search. */
		workflow,
		/** The menu's forms read the search (`moduleFormsReadSearch`). */
		formsReadSearch,
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
		excludedOwnerIds:
			exclusion.kind === "read" ? exclusion.value.excludedOwnerIds : undefined,
		authoredExcludedOwnerIds:
			exclusion.kind === "read"
				? exclusion.value.authoredExcludedOwnerIds
				: undefined,
		/** The exclusion's refusal of data the worker's device lacks, which
		 *  the Results read throws as the list's. Plain data, so it crosses
		 *  the worker thread. */
		exclusionRefusal:
			exclusion.kind === "refused" ? exclusion.refusal.reason : undefined,
	};
}
