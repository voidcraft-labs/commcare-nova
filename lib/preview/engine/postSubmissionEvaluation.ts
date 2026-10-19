import type { SubmissionEnvelopeResult } from "@/lib/case-store";
import {
	type BlueprintDoc,
	effectivePostSubmit,
	moduleIsCaseFirst,
	moduleUuidOfForm,
	reachableCaseTypes,
	type Uuid,
} from "@/lib/domain";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import {
	afterSubmitRoute,
	automaticLinkedCaseCollection,
	carriedChildCasesFromReceipt,
	previewMenuSelectionsAfterTargetCases,
	previewTargetHasSelectedCase,
} from "../afterSubmitRouting";
import { createInProcessXPathWorkerFactory } from "../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../xpath/workerProjection";
import { caseDatabaseToFormPreloads } from "./caseDataBindingClient";
import type { SubmissionMutation } from "./caseDataBindingTypes";
import { afterSubmitSessionDatums, entrySessionData } from "./entrySessionData";
import type { FormEvaluationContext } from "./formEvaluationTypes";
import { FormEvaluationInputError } from "./formEvaluationTypes";
import {
	carriedCaseFromSelections,
	createFormLinkWorkerWorld,
	evaluateFormLinksAsync,
	type FormLinkAsyncEvaluator,
	projectTargetCaseSelectionsAsync,
} from "./formLinkEvaluation";
import { previewSessionValues } from "./identity";
import { previewLookupData } from "./lookupEvaluation";
import { resolvePreviousTask, selectionsForModuleTask } from "./previousTask";

export interface PostSubmissionEvaluationInput {
	formUuid: Uuid;
	mutation: SubmissionMutation;
	result: SubmissionEnvelopeResult;
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>;
}

/** Resolve the next task from the actual receipt and patched device snapshot.
 * These are Preview's link evaluator and navigation projections, run inside
 * the bounded server worker so authored Java patterns cannot block Node. */
export async function evaluatePostSubmissionSnapshot(
	doc: BlueprintDoc,
	args: PostSubmissionEvaluationInput,
	context: FormEvaluationContext,
) {
	const moduleUuid = moduleUuidOfForm(doc, args.formUuid);
	const form = doc.forms[args.formUuid];
	if (!moduleUuid || !form)
		throw new FormEvaluationInputError("The submitted form is unavailable.");
	const fallback = effectivePostSubmit(doc, args.formUuid);
	if (fallback === undefined)
		throw new FormEvaluationInputError("The next task is unavailable.");
	const caseType = doc.modules[moduleUuid].caseType;
	const ids = args.result.primaryCaseIds;
	let caseData =
		ids.length === 1
			? caseDatabaseToFormPreloads(
					context.cases,
					ids[0],
					reachableCaseTypes(caseType, doc.caseTypes ?? []),
				)
			: new Map<string, Map<string, string>>();
	if (caseData === undefined)
		throw new FormEvaluationInputError(
			"The saved record is unavailable for the next task.",
		);
	const submission = {
		...(ids.length === 1
			? {
					caseId: ids[0],
					caseName: caseType
						? caseData.get(caseType)?.get("case_name")
						: undefined,
				}
			: {}),
		childCases: carriedChildCasesFromReceipt({
			createdChildren: args.result.createdChildren,
			authoredChildren:
				"children" in args.mutation ? args.mutation.children : [],
			parentCaseIds: ids,
		}),
	};
	const menuSource = { ...doc, doc, caseTypes: doc.caseTypes ?? [] };
	/* The entry's own session map, rebuilt from its entry key: the device's
	 * session does not change when the form closes, so a link reads the ids
	 * the form read, created cases included. */
	const entry = entrySessionData(doc, args.formUuid, {
		appId: context.session?.appId,
		entryKey: args.mutation.entryKey,
		boundCases:
			"caseIds" in args.mutation
				? args.mutation.caseIds.map((caseId) => ({ caseId }))
				: [],
		menuSelections: args.selections,
		caseDatabase: context.cases,
		identity: context.identity,
	});
	const input = {
		doc,
		formUuid: args.formUuid,
		session: previewSessionValues(context.identity),
		usercase: context.identity.usercase,
		sessionDatums: afterSubmitSessionDatums(
			entry,
			submission,
			args.mutation.kind === "registration" ? ids[0] : undefined,
		),
		caseData,
		caseDatabase: context.cases,
		lookupData: previewLookupData(context.lookup),
	};
	const runtime = new XPathRuntime({
		workerFactory: createInProcessXPathWorkerFactory(),
	});
	try {
		const evaluate: FormLinkAsyncEvaluator = async (source, instances) => {
			const result = await runtime.request(
				{
					entryKey: args.mutation.entryKey,
					revision: 0,
					profile: "form-link",
					source,
					instances,
				},
				{ signal: AbortSignal.timeout(30_000) },
			);
			if (!result.ok)
				throw new FormEvaluationInputError(
					`The next-task condition could not be evaluated (${result.error.code}).`,
				);
			return deserializeXPathWorkerValue(result.value);
		};
		const world = createFormLinkWorkerWorld(
			input,
			`after:${args.mutation.entryKey}`,
		);
		const choice = await evaluateFormLinksAsync({
			links: form.formLinks ?? [],
			fallback,
			input,
			evaluate,
			world,
		});
		const projected =
			choice.kind === "link"
				? await projectTargetCaseSelectionsAsync(
						input,
						args.formUuid,
						choice.link,
						evaluate,
						world,
					)
				: [];
		const collection = automaticLinkedCaseCollection({
			choice,
			doc,
			sourceModuleUuid: moduleUuid,
			sourceFormType: form.type,
			submittedCases:
				"caseIds" in args.mutation
					? args.mutation.caseIds.map((caseId) => ({
							caseId,
							caseName:
								context.cases.rows.find((row) => row.case_id === caseId)
									?.case_name ?? "Case",
						}))
					: [],
			resultCaseIds: ids,
			caseDatabase: context.cases,
		});
		const collections = collection ? [collection] : [];
		const route = afterSubmitRoute({
			previousTask: () =>
				resolvePreviousTask({
					doc,
					formUuid: args.formUuid,
					submittedCaseIds: ids,
					selections: args.selections,
					caseDatabase: context.cases,
				}),
			choice,
			doc,
			caseFirstModules: new Set(
				doc.moduleOrder.filter((uuid) => moduleIsCaseFirst(doc, uuid)),
			),
			caseSelections: () => projected,
			carriedCase: (link) => carriedCaseFromSelections(input, link, projected),
			hasSelectedCase: (targetModuleUuid, selections) =>
				previewTargetHasSelectedCase({
					menuSource,
					current: selectionsForModuleTask(
						doc,
						targetModuleUuid,
						args.selections,
					),
					targetModuleUuid,
					projected: selections,
					collections,
				}),
		});
		for (const selected of projected) {
			if (selected.caseId === "") continue;
			const loaded = caseDatabaseToFormPreloads(
				context.cases,
				selected.caseId,
				reachableCaseTypes(selected.caseType, doc.caseTypes ?? []),
			);
			if (!loaded)
				throw new FormEvaluationInputError(
					"The next task requires a record absent from the saved device state.",
				);
			caseData = new Map([...caseData, ...loaded]);
		}
		const selections =
			route.kind === "previous-task"
				? route.task.selections
				: previewMenuSelectionsAfterTargetCases(
						menuSource,
						args.selections,
						projected,
						caseData,
						collections,
					);
		const moduleDestination =
			route.kind === "module"
				? route.moduleUuid
				: route.kind === "post-submit" && route.destination === "module"
					? moduleUuid
					: route.kind === "post-submit" && route.destination === "parentMenu"
						? doc.modules[moduleUuid]?.parentModuleUuid
						: undefined;
		return {
			route,
			selections:
				moduleDestination === undefined
					? selections
					: selectionsForModuleTask(doc, moduleDestination, selections),
			collection,
		};
	} finally {
		runtime.dispose();
	}
}
