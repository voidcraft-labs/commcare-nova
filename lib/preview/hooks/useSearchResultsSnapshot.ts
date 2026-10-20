/**
 * useSearchResultsSnapshot — what a search-first module's completed search
 * returned, for a form of that module that reads it.
 *
 * The read is the completed attempt's own Results read without a page window
 * (`loadSearchResultsSnapshotAction`), so the form reads the cases Results
 * showed for that search, up to `SEARCH_RESULTS_CAP`. It is keyed by the
 * attempt, its answers, the worker, the parent selection and what the device
 * worked out for the search's `_xpath_query` rows when it sent the search
 * (`PreviewSearchState.deviceValues`, the value Results read with). A search
 * reads the Project's open cases, not the worker's restore, and those values
 * are kept with the search, so a claim the form's entry posts reads nothing
 * again. It is never keyed by the document's identity either: an edit
 * elsewhere in the app does not read the search again, and the form keeps the
 * snapshot it opened with for the whole entry, as a device's session keeps
 * its query step.
 *
 * The values are the ones kept with the search, recorded as Results worked
 * them out. A completed search that holds none (Results left before
 * recording them) has them worked out here, once, by the same evaluator and
 * recorded with the search (`useSearchCsqlRuntime.ts`); the read waits for
 * them and never runs without them.
 */
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { toRscSerializableDoc } from "@/lib/doc/ownRecords";
import type { BlueprintDoc, CaseType, Uuid } from "@/lib/domain";
import { loadSearchResultsSnapshotAction } from "@/lib/preview/engine/caseDataBinding";
import { viewerTimeZone } from "@/lib/preview/engine/caseDataBindingClient";
import type { ParentCaseSelection } from "@/lib/preview/engine/caseDataBindingTypes";
import type {
	LoadSearchResultsSnapshotResult,
	SearchResultsSnapshot,
} from "@/lib/preview/engine/xpathInstances";
import {
	useAccessPhase,
	usePreviewClaimedCaseIds,
	usePreviewPersonaUuid,
	useSetPreviewSearchState,
} from "@/lib/session/hooks";
import { recordSearchDeviceValues } from "@/lib/session/previewSearchState";
import type { PreviewSearchState } from "@/lib/session/types";
import {
	type SubmissionValuesState,
	useCaseListStepSession,
	useSubmittedSearchDeviceValues,
} from "./useSearchCsqlRuntime";

export type SearchResultsSnapshotState =
	| { readonly kind: "idle" }
	| { readonly kind: "loading" }
	| { readonly kind: "data"; readonly snapshot: SearchResultsSnapshot }
	/** The search itself cannot run (its inputs or settings refuse it): the
	 * same search fails again, so the worker goes back to Search. */
	| { readonly kind: "invalid-search"; readonly message: string }
	| { readonly kind: "error"; readonly message: string };

/** What one load of the snapshot leaves the form with. A search its inputs
 * or settings refuse keeps its own message and is not retried; any other
 * failure can be tried again. */
export function searchResultsLoadState(
	loaded: LoadSearchResultsSnapshotResult,
): Exclude<SearchResultsSnapshotState, { kind: "idle" | "loading" }> {
	switch (loaded.kind) {
		case "data":
			return { kind: "data", snapshot: loaded.snapshot };
		case "invalid-search":
			return { kind: "invalid-search", message: loaded.message };
		case "unauthenticated":
			return {
				kind: "error",
				message: "You're signed out, so what the search found can't load.",
			};
		default:
			return { kind: "error", message: loaded.message };
	}
}

/**
 * The identity of one snapshot load, or `undefined` while no load can start.
 * The device's runtime values are part of it unless the search is the one
 * case the no-matches form registered, whose read sends none; any other
 * search's load waits until its values are ready.
 */
export function searchResultsSnapshotKey(args: {
	readonly ready: boolean;
	readonly appId: string | undefined;
	readonly moduleUuid: Uuid | undefined;
	readonly caseType: string | undefined;
	readonly searchState: PreviewSearchState | undefined;
	readonly personaUuid: string | undefined;
	readonly parentCase: ParentCaseSelection | undefined;
	readonly deviceValues: SubmissionValuesState;
	readonly retries: number;
}): string | undefined {
	const completed =
		args.searchState?.kind === "completed" ? args.searchState : undefined;
	if (
		!args.ready ||
		args.appId === undefined ||
		args.caseType === undefined ||
		completed === undefined
	)
		return undefined;
	const registered = completed.registeredCaseId !== undefined;
	if (!registered && args.deviceValues.kind !== "ready") return undefined;
	return JSON.stringify([
		args.appId,
		args.moduleUuid,
		args.caseType,
		completed.submission,
		completed.answers,
		completed.registeredCaseId ?? null,
		args.personaUuid ?? null,
		args.parentCase ?? null,
		!registered && args.deviceValues.kind === "ready"
			? (args.deviceValues.value ?? null)
			: null,
		args.retries,
	]);
}

/** The form's answer while the device's cases its search reads failed to load. */
export const SEARCH_DEVICE_CASES_FAILED_MESSAGE =
	"The cases on this device didn't load, so what the search found can't load. Try again.";

export function useSearchResultsSnapshot(args: {
	/** The form reads what its module's search found. */
	readonly enabled: boolean;
	readonly appId: string | undefined;
	readonly doc: BlueprintDoc;
	readonly moduleUuid: Uuid | undefined;
	readonly searchState: PreviewSearchState | undefined;
	readonly parentCase?: ParentCaseSelection;
	readonly caseTypes: readonly CaseType[];
	readonly language: string;
}): { readonly state: SearchResultsSnapshotState; readonly retry: () => void } {
	const accessPhase = useAccessPhase();
	const personaUuid = usePreviewPersonaUuid();
	const claimedCaseIds = usePreviewClaimedCaseIds(personaUuid);
	const [retries, setRetries] = useState(0);
	const module =
		args.moduleUuid === undefined
			? undefined
			: args.doc.modules[args.moduleUuid];
	const completed =
		args.searchState?.kind === "completed" ? args.searchState : undefined;
	const stepSession = useCaseListStepSession(args.doc, args.moduleUuid);
	const setPreviewSearchState = useSetPreviewSearchState();
	const latestSearchState = useRef(args.searchState);
	latestSearchState.current = args.searchState;
	const submissionKey = completed?.submission;
	const answers = completed?.answers;
	const submission = useMemo(
		() =>
			submissionKey === undefined || answers === undefined
				? undefined
				: { key: submissionKey, answers: new Map(Object.entries(answers)) },
		[submissionKey, answers],
	);
	const deviceValues = useSubmittedSearchDeviceValues({
		doc: args.doc,
		moduleUuid: args.moduleUuid,
		submission:
			args.enabled && completed?.registeredCaseId === undefined
				? submission
				: undefined,
		...(completed?.deviceValues === undefined
			? {}
			: {
					kept: {
						key: completed.submission,
						values: completed.deviceValues,
					},
				}),
		onWorkedOut: (key, values) => {
			const current = latestSearchState.current;
			if (args.moduleUuid === undefined) return;
			const next = recordSearchDeviceValues(current, key, values.value);
			if (next !== current) setPreviewSearchState(args.moduleUuid, next);
		},
		sessionData: stepSession.data,
	});
	const key = searchResultsSnapshotKey({
		ready: args.enabled && accessPhase === "authorized",
		appId: args.appId,
		moduleUuid: args.moduleUuid,
		caseType: module?.caseType,
		searchState: args.searchState,
		personaUuid,
		parentCase: args.parentCase,
		deviceValues,
		retries,
	});
	/* The latest inputs, read when a load starts; the key alone decides
	 * whether one starts. */
	const csqlRuntime =
		deviceValues.kind === "ready" ? deviceValues.value : undefined;
	const latest = useRef({ ...args, claimedCaseIds, personaUuid, csqlRuntime });
	latest.current = { ...args, claimedCaseIds, personaUuid, csqlRuntime };
	const [result, setResult] = useState<{
		readonly key: string;
		readonly state: SearchResultsSnapshotState;
	}>();

	useEffect(() => {
		if (key === undefined) return;
		let current = true;
		const input = latest.current;
		const mod =
			input.moduleUuid === undefined
				? undefined
				: input.doc.modules[input.moduleUuid];
		const search =
			input.searchState?.kind === "completed" ? input.searchState : undefined;
		if (
			input.appId === undefined ||
			input.moduleUuid === undefined ||
			mod?.caseType === undefined ||
			search === undefined
		)
			return;
		setResult({ key, state: { kind: "loading" } });
		loadSearchResultsSnapshotAction({
			appId: input.appId,
			caseType: mod.caseType,
			moduleUuid: input.moduleUuid,
			blueprint: toRscSerializableDoc(input.doc),
			caseListConfig: mod.caseListConfig,
			excludedOwnerIdsExpression: mod.caseSearchConfig?.excludedOwnerIds,
			/* After the no-matches form registers a case, the search is that
			 * one case, as the wire's return frame keys it. */
			...(search.registeredCaseId === undefined
				? { inputValues: { ...search.answers } }
				: { caseIds: [search.registeredCaseId] }),
			...(input.parentCase === undefined
				? {}
				: { parentCase: input.parentCase }),
			...(input.csqlRuntime === undefined ||
			search.registeredCaseId !== undefined
				? {}
				: { csqlRuntime: input.csqlRuntime }),
			caseTypes: input.caseTypes,
			language: input.language,
			viewerTimeZone: viewerTimeZone(),
			...(input.personaUuid === undefined
				? {}
				: { personaUuid: input.personaUuid }),
			claimedCaseIds: [...input.claimedCaseIds],
		}).then(
			(loaded) => {
				if (!current) return;
				setResult({
					key,
					state: searchResultsLoadState(loaded),
				});
			},
			() => {
				if (current)
					setResult({
						key,
						state: {
							kind: "error",
							message: "We couldn't load what the search found. Try again.",
						},
					});
			},
		);
		return () => {
			current = false;
		};
	}, [key]);

	const state: SearchResultsSnapshotState =
		deviceValues.kind === "unavailable"
			? { kind: "error", message: SEARCH_DEVICE_CASES_FAILED_MESSAGE }
			: key === undefined
				? args.enabled && deviceValues.kind === "pending"
					? { kind: "loading" }
					: { kind: "idle" }
				: result?.key === key
					? result.state
					: { kind: "loading" };
	return {
		state,
		retry: () => {
			if (deviceValues.kind === "unavailable") void deviceValues.retry();
			else setRetries((count) => count + 1);
		},
	};
}
