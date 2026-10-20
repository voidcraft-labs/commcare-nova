// lib/preview/engine/serverSearchRead.ts
//
// A records screen's search and the read its Results run, for the server-side
// runs of a worker's session: an App Test's steps and the form check
// (`evaluate_form`). The search screen runs in the bounded worker
// (`evaluateSearch`); the read is the one `readCases` runs, without a page
// window, so a paged Results read and a form's unpaged search-results read
// (`searchResultsSnapshot.ts`) both come from here.

import "server-only";
import type { RestoreScope } from "@/lib/case-store";
import type { BlueprintDoc, CaseType, LanguageTag, Uuid } from "@/lib/domain";
import {
	CASEDB_READING,
	type CaseQueryReading,
	caseQueryReadingFor,
	SEARCH_READING,
} from "@/lib/domain/expression/temporalType";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import { previewMenuCaseContext } from "../menuProjection";
import { projectWorkerModule } from "../workerModule";
import type { readCases } from "./caseDataBindingHelpers";
import { previewCaseStoreOrder } from "./caseListOrder";
import { caseListStepSession } from "./entrySessionData";
import { evaluateSearch } from "./evaluateForm";
import type { FormEvaluationContext } from "./formEvaluationTypes";
import { previewSessionValues } from "./identity";
import { previewLookupData } from "./lookupEvaluation";
import { previewCaseStoreBindings } from "./runtimeBindings";
import { evaluateSearchCsqlRuntime, foldSearchCsql } from "./searchCsqlRuntime";
import type { SearchEvaluationInput } from "./searchEvaluation";
import { readSearchResultsSnapshot } from "./searchResultsSnapshot";
import type {
	CaseDatabaseSnapshot,
	SearchResultsSnapshot,
} from "./xpathInstances";

/** The session a server-side records read stands in. */
export interface ServerSearchWorld {
	readonly doc: BlueprintDoc & { readonly caseTypes: readonly CaseType[] };
	readonly language: LanguageTag;
	readonly appId: string;
	readonly identity: FormEvaluationContext["identity"];
	/** The worker's device casedb, which the search screen reads. */
	readonly deviceCases: CaseDatabaseSnapshot;
	readonly lookup: FormEvaluationContext["lookup"];
	readonly caseTypeSchemas: ReadonlyMap<string, CaseType> | undefined;
	readonly timeZone: string;
	readonly restoreScope: RestoreScope;
	readonly selections: Readonly<Record<string, PreviewMenuCaseSelection>>;
}

/** What the worker did on the records screen. */
export interface ServerSearchRequest {
	readonly moduleUuid: Uuid;
	/** A previous completed search, including its system-generated values. */
	readonly submitted?: readonly { name: string; value: string }[];
	readonly entry?: SearchEvaluationInput["entry"];
	/** Omitted observes the screen; an empty array presses Search with defaults. */
	readonly answers?: readonly { name: string; value: string }[];
	/** The case a no-matches form registered, which Results then show alone. */
	readonly registeredCaseId?: string;
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

/**
 * Run the module's search screen and compose its Results read. The read is
 * absent while Results stay hidden behind an unsubmitted or invalid search.
 * `refuse` gives the surface's own refusal for a menu with no record list or
 * one whose parent record is not chosen yet.
 */
export async function serverRecordsRead(
	world: ServerSearchWorld,
	request: ServerSearchRequest,
	refuse: (reason: "no-record-list" | "parent-required") => Error,
) {
	const mod = projectWorkerModule(
		world.doc,
		world.language,
		request.moduleUuid,
	);
	if (!mod?.caseType) throw refuse("no-record-list");
	const caseType = mod.caseType;
	const search = await evaluateSearch(
		world.doc,
		{
			moduleUuid: request.moduleUuid,
			language: world.language,
			submitted: request.submitted,
			entry: request.entry,
			answers: request.answers,
		},
		{
			identity: world.identity,
			cases: world.deviceCases,
			lookup: world.lookup,
		},
	);
	const resultVisible = !(
		search.searchFirst &&
		search.hasVisibleInputs &&
		!search.hasSubmitted
	);
	const caseContext = previewMenuCaseContext(
		world.doc,
		request.moduleUuid,
		world.selections,
	);
	if (caseContext.requiredParentCase) throw refuse("parent-required");
	/* A completed or submitted search's Results read HQ's search population,
	 * as the browser's do; a browse list reads the session's restore. */
	const searched = recordsReadSearch(mod, {
		searchAnswers:
			search.relevant && search.hasSubmitted ? search.submitted : undefined,
		registeredCaseId: request.registeredCaseId,
	});
	const registeredCaseId = request.registeredCaseId;
	/* The session at the list's step: what a browse filter's chosen case and
	 * a search's runtime values read. A search's rows reach the store folded
	 * with what this session's device works out, as the browser's do. */
	const step = caseListStepSession(world.doc, request.moduleUuid, {
		menuSelections: world.selections,
		caseDatabase: world.deviceCases,
		identity: world.identity,
	});
	const searchConfig = world.doc.modules[request.moduleUuid]?.caseListConfig;
	const searchCsql =
		searched && registeredCaseId === undefined && searchConfig !== undefined
			? foldSearchCsql(
					world.doc,
					request.moduleUuid,
					searchConfig,
					evaluateSearchCsqlRuntime({
						doc: world.doc,
						moduleUuid: request.moduleUuid,
						caseListConfig: searchConfig,
						answers: search.inputValues,
						session: previewSessionValues(world.identity),
						sessionData: step.data,
						caseDatabase: world.deviceCases,
						lookup: previewLookupData(world.lookup),
					}) ?? { segments: {}, choices: {} },
				)
			: undefined;
	const read: Omit<Parameters<typeof readCases>[1], "page"> | undefined =
		!resultVisible || Object.keys(search.errors).length > 0
			? undefined
			: {
					appId: world.appId,
					caseType,
					reading: searchedReading(searched),
					caseIds: registeredCaseId ? [registeredCaseId] : undefined,
					caseTypeSchemas: world.caseTypeSchemas,
					caseListConfig: mod.caseListConfig,
					...(mod.caseListConfig !== undefined && {
						order: previewCaseStoreOrder(
							{ ...mod, caseType },
							world.doc,
							mod.caseListConfig,
							world.language,
						),
					}),
					parentCase: caseContext.parentCase
						? {
								caseType: caseContext.parentCase.caseType,
								caseIds: caseContext.parentCase.cases.map((row) => row.caseId),
							}
						: undefined,
					inputValues: registeredCaseId ? undefined : search.inputValues,
					...(searchCsql !== undefined && { searchCsql }),
					bindings: {
						...previewCaseStoreBindings(
							previewSessionValues(world.identity),
							mod.caseListConfig?.searchInputs,
							search.expressionValues,
							world.timeZone,
						),
						chosenCaseIds: step.chosenCaseIds,
					},
					lookupTableSchemas: new Map(
						world.lookup.definitions.map((table) => [
							table.id,
							new Map(
								table.columns.map((column) => [column.id, column.dataType]),
							),
						]),
					),
					excludedOwnerIds: search.excludedOwnerIds,
					authoredExcludedOwnerIds: search.authoredExcludedOwnerIds,
					...(searched
						? { searchPopulation: { heldBy: world.restoreScope } }
						: { restoreScope: world.restoreScope }),
				};
	return { search, searched, read };
}

/**
 * What a completed search returned to the forms of its module, from the read
 * `serverRecordsRead` composed: undefined when that read is not a search's
 * (no completed search, or Results hidden behind an invalid one).
 */
export async function serverSearchResults(
	store: Parameters<typeof readSearchResultsSnapshot>[0],
	read: Awaited<ReturnType<typeof serverRecordsRead>>["read"],
): Promise<SearchResultsSnapshot | undefined> {
	if (read?.searchPopulation === undefined) return undefined;
	const { restoreScope: _restore, searchPopulation, ...rest } = read;
	return readSearchResultsSnapshot(store, { ...rest, searchPopulation });
}
