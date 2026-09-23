import type { AppTestScope } from "@/lib/db/appTests";
import { noMatchesFormOf } from "@/lib/domain";
import { readCases } from "../engine/caseDataBindingHelpers";
import { evaluateSearch } from "../engine/evaluateForm";
import { previewSessionValues } from "../engine/identity";
import { previewCaseStoreBindings } from "../engine/runtimeBindings";
import { previewMenuCaseContext } from "../menuProjection";
import { noMatchesFormAdmission } from "../noMatchesForm";
import type { AppTestContext } from "./context";
import type { AppTestState } from "./types";

export async function appTestRecords(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestState,
	answers?: readonly { name: string; value: string }[],
) {
	const screen = state.screen;
	if (screen.kind !== "records") throw new Error("Open a record list first.");
	const mod = context.doc.modules[screen.moduleUuid];
	if (!mod.caseType) throw new Error("This menu has no record list.");
	const search = await evaluateSearch(
		context.doc,
		{
			moduleUuid: screen.moduleUuid,
			submitted: screen.searchAnswers,
			entry: screen.searchEntry,
			answers,
		},
		{
			identity: context.identity,
			cases: state.deviceCases,
			lookup: context.lookup,
		},
	);
	const next = {
		...state,
		screen: {
			...screen,
			searchAnswers: search.submitted,
			searchEntry: { draft: search.draft, errors: search.errors },
			registeredCaseId:
				answers === undefined ? screen.registeredCaseId : undefined,
			offset: answers === undefined ? screen.offset : 0,
		},
	};
	const resultVisible = !(
		search.searchFirst &&
		search.hasVisibleInputs &&
		!search.hasSubmitted
	);
	const caseContext = previewMenuCaseContext(
		context.doc,
		screen.moduleUuid,
		state.selections,
	);
	if (caseContext.requiredParentCase)
		throw new Error("Select the required parent record first.");
	const result =
		!resultVisible || Object.keys(search.errors).length > 0
			? undefined
			: await readCases(context.store, {
					appId: scope.appId,
					caseType: mod.caseType,
					caseIds: next.screen.registeredCaseId
						? [next.screen.registeredCaseId]
						: undefined,
					caseTypeSchemas: context.caseTypeSchemas,
					caseListConfig: mod.caseListConfig,
					parentCase: caseContext.parentCase
						? {
								caseType: caseContext.parentCase.caseType,
								caseIds: caseContext.parentCase.cases.map((row) => row.caseId),
							}
						: undefined,
					inputValues: next.screen.registeredCaseId
						? undefined
						: search.inputValues,
					bindings: previewCaseStoreBindings(
						previewSessionValues(context.identity),
						mod.caseListConfig?.searchInputs,
						search.expressionValues,
						context.clock.timeZone,
					),
					lookupTableSchemas: new Map(
						context.lookup.definitions.map((table) => [
							table.id,
							new Map(
								table.columns.map((column) => [column.id, column.dataType]),
							),
						]),
					),
					excludedOwnerIds: search.excludedOwnerIds,
					authoredExcludedOwnerIds: search.authoredExcludedOwnerIds,
					page: { offset: next.screen.offset ?? 0, limit: 50 },
					restoreScope: context.restoreScope,
				});
	const candidate = noMatchesFormOf(context.doc, screen.moduleUuid);
	// Each action serializes a completed read, so its launch and search share
	// this one attempt. No caller can provide a stale or privileged launch.
	const admission = noMatchesFormAdmission({
		form: candidate,
		moduleUuid: screen.moduleUuid,
		launch: search.hasSubmitted
			? { moduleUuid: screen.moduleUuid, attempt: 0 }
			: undefined,
		searchState:
			search.hasSubmitted &&
			(result?.kind === "empty" || result?.kind === "rows")
				? {
						kind: "completed",
						attempt: 0,
						answers: Object.fromEntries(
							(search.submitted ?? []).map(({ name, value }) => [name, value]),
						),
						matchCount: result.kind === "empty" ? 0 : result.rows.length,
					}
				: undefined,
	});
	return {
		state: next,
		search,
		result,
		registration: admission.kind === "admitted" ? candidate : undefined,
	};
}
