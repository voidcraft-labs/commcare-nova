/**
 * The session at a module's case list step, and what the device works out
 * for the module's search before it reaches HQ.
 *
 * `useCaseListStepSession` builds the step's session from the menu's case
 * choices and the device's cases (`entrySessionData.ts::caseListStepSession`):
 * the Search screen reads its datums, and a browse list's filter reads its
 * chosen cases. `useSearchCsqlRuntime` evaluates a submitted search's
 * runtime values over the Search screen's world
 * (`searchCsqlRuntime.ts::evaluateSearchCsqlRuntime`), which the Results read
 * sends for the server to fold. Both keep one identity while their content
 * is unchanged, so a read keyed by them does not run again for nothing.
 */
"use client";

import { useMemo } from "react";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	type CaseListStepSession,
	caseListStepSession,
} from "@/lib/preview/engine/entrySessionData";
import { previewSessionValues } from "@/lib/preview/engine/identity";
import type { SearchInputValues } from "@/lib/preview/engine/runtimeBindings";
import {
	evaluateSearchCsqlRuntime,
	type SearchCsqlRuntimeWire,
} from "@/lib/preview/engine/searchCsqlRuntime";
import { usePreviewLookupStatus } from "@/lib/preview/engine/useLookupPreviewData";
import { useNavigationDeviceCases } from "@/lib/preview/engine/useNavigationDeviceCases";
import { useSelectedPreviewIdentity } from "@/lib/preview/hooks/useSelectedPreviewIdentity";
import { usePreviewMenuCaseSelections } from "@/lib/session/hooks";

const NO_STEP_SESSION: CaseListStepSession = { data: {}, chosenCaseIds: {} };

/** The same value while its JSON content is unchanged. */
function useStableContent<T>(value: T): T {
	const key = JSON.stringify(value) ?? "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: the key is the value's content.
	return useMemo(() => value, [key]);
}

export function useCaseListStepSession(
	doc: BlueprintDoc,
	moduleUuid: Uuid | undefined,
): CaseListStepSession {
	const menuSelections = usePreviewMenuCaseSelections();
	const deviceCases = useNavigationDeviceCases(doc.caseTypes ?? undefined);
	const identity = useSelectedPreviewIdentity();
	const step = useMemo(
		() =>
			moduleUuid === undefined
				? NO_STEP_SESSION
				: caseListStepSession(doc, moduleUuid, {
						menuSelections,
						caseDatabase: deviceCases.snapshot,
						identity,
					}),
		[doc, moduleUuid, menuSelections, deviceCases.snapshot, identity],
	);
	return useStableContent(step);
}

/** A submitted search's runtime values; `undefined` before a search, or for
 * a search with no row to fold. */
export function useSearchCsqlRuntime(args: {
	readonly doc: BlueprintDoc;
	readonly moduleUuid: Uuid | undefined;
	readonly answers: SearchInputValues | undefined;
	readonly sessionData: Readonly<Record<string, string>>;
}): SearchCsqlRuntimeWire | undefined {
	const deviceCases = useNavigationDeviceCases(args.doc.caseTypes ?? undefined);
	const identity = useSelectedPreviewIdentity();
	const lookupStatus = usePreviewLookupStatus();
	const lookup = lookupStatus.kind === "data" ? lookupStatus.data : undefined;
	const { doc, moduleUuid, answers, sessionData } = args;
	const caseListConfig =
		moduleUuid === undefined
			? undefined
			: doc.modules[moduleUuid]?.caseListConfig;
	const values = useMemo(
		() =>
			moduleUuid === undefined ||
			caseListConfig === undefined ||
			answers === undefined
				? undefined
				: evaluateSearchCsqlRuntime({
						doc,
						moduleUuid,
						caseListConfig,
						answers,
						session: previewSessionValues(identity),
						sessionData,
						caseDatabase: deviceCases.snapshot,
						...(lookup === undefined ? {} : { lookup }),
					}),
		[
			doc,
			moduleUuid,
			caseListConfig,
			answers,
			identity,
			sessionData,
			deviceCases.snapshot,
			lookup,
		],
	);
	return useStableContent(values);
}
