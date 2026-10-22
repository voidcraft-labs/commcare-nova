import type { AppTestScope } from "@/lib/db/appTests";
import { noMatchesFormOf } from "@/lib/domain";
import {
	CASEDB_READING,
	type CaseQueryReading,
	caseQueryReadingFor,
	SEARCH_READING,
} from "@/lib/domain/expression/temporalType";
import { readCases } from "../engine/caseDataBindingHelpers";
import { previewCaseStoreOrder } from "../engine/caseListOrder";
import { evaluateSearch } from "../engine/evaluateForm";
import { previewSessionValues } from "../engine/identity";
import { previewCaseStoreBindings } from "../engine/runtimeBindings";
import { previewMenuCaseContext } from "../menuProjection";
import { noMatchesFormAdmission } from "../noMatchesForm";
import { projectWorkerModule } from "../workerModule";
import type { AppTestContext } from "./context";
import { AppTestActionError } from "./errors";
import type { AppTestSessionState } from "./types";

export async function appTestRecords(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
	answers?: readonly { name: string; value: string }[],
) {
	const screen = state.screen;
	if (screen.kind !== "records")
		throw new AppTestActionError("Open a record list first.");
	const mod = projectWorkerModule(
		context.doc,
		context.language,
		screen.moduleUuid,
	);
	if (!mod?.caseType)
		throw new AppTestActionError("This menu has no record list.");
	const search = await evaluateSearch(
		context.doc,
		{
			moduleUuid: screen.moduleUuid,
			language: context.language,
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
		throw new AppTestActionError("Select the required parent record first.");
	/* A completed or submitted search's Results read HQ's search population,
	 * as the browser's do; a browse list reads the session's restore. */
	const searched = recordsReadSearch(mod, {
		searchAnswers:
			search.relevant && search.hasSubmitted ? search.submitted : undefined,
		registeredCaseId: next.screen.registeredCaseId,
	});
	const result =
		!resultVisible || Object.keys(search.errors).length > 0
			? undefined
			: await readCases(context.store, {
					appId: scope.appId,
					caseType: mod.caseType,
					reading: searchedReading(searched),
					caseIds: next.screen.registeredCaseId
						? [next.screen.registeredCaseId]
						: undefined,
					caseTypeSchemas: context.caseTypeSchemas,
					caseListConfig: mod.caseListConfig,
					...(mod.caseListConfig !== undefined && {
						order: previewCaseStoreOrder(
							{ ...mod, caseType: mod.caseType },
							context.doc,
							mod.caseListConfig,
							context.language,
						),
					}),
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
					...(searched
						? { searchPopulation: { heldBy: context.restoreScope } }
						: { restoreScope: context.restoreScope }),
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
		searched,
		result,
		registration: admission.kind === "admitted" ? candidate : undefined,
	};
}

/**
 * What a session's read stands for: a search's population reads HQ's search,
 * then the results instance; every other read is the session's device, a
 * casedb throughout, even in a module whose Search action sits beside its
 * browse list.
 */
export function searchedReading(searched: boolean): CaseQueryReading {
	return searched ? SEARCH_READING : CASEDB_READING;
}

/**
 * Whether a records screen shows a search's Results: the module has an
 * effective Search, and the screen holds a submitted search or the case its
 * no-matches form registered. Its Results, and the Details and selections of
 * cases chosen from them, read the search's population.
 */
export function recordsReadSearch(
	mod: Parameters<typeof caseQueryReadingFor>[0],
	screen: {
		readonly searchAnswers?: readonly unknown[];
		readonly registeredCaseId?: string;
	},
): boolean {
	return (
		caseQueryReadingFor(mod) === SEARCH_READING &&
		(screen.searchAnswers !== undefined ||
			screen.registeredCaseId !== undefined)
	);
}
