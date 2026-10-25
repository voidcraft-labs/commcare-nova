/**
 * The session at a module's case list step, and what the device works out
 * for the module's search before it reaches HQ.
 *
 * `useCaseListStepSession` builds the step's session from the menu's case
 * choices and the device's cases (`entrySessionData.ts::caseListStepSession`):
 * the Search screen reads its datums, and a browse list's filter reads its
 * chosen cases. `useSubmittedSearchDeviceValues` works out a submitted
 * search's runtime values over the Search screen's world
 * (`searchCsqlRuntime.ts::evaluateSearchCsqlRuntime`), the pieces Preview's
 * synchronous evaluator can't run in the Search screen's XPath worker, once
 * per submission: a device evaluates the request as it sends it and keeps it
 * for the query step. The Results read waits for them and sends them for the
 * server to fold.
 *
 * A search-first module's search keeps its values on the session
 * (`PreviewSearchState.deviceValues`), and `SearchDeviceValuesRecorder`
 * works them out there, beside the case database, from the Search press on:
 * Results leaving before they are in doesn't stop them, and the module's
 * Results and forms only wait for that record (`waitsForRecord`). A search
 * action's values belong to its screen's own Search press.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	type CaseListStepSession,
	caseListStepSession,
} from "@/lib/preview/engine/entrySessionData";
import { previewSessionValues } from "@/lib/preview/engine/identity";
import { withNavigationWidth } from "@/lib/preview/engine/previewDevice";
import type { SearchInputValues } from "@/lib/preview/engine/runtimeBindings";
import {
	evaluateSearchCsqlRuntime,
	moduleSearchReadsCaseDatabase,
	resendingWhenSuperseded,
	type SearchCsqlRuntimeWire,
} from "@/lib/preview/engine/searchCsqlRuntime";
import { usePreviewLookupStatus } from "@/lib/preview/engine/useLookupPreviewData";
import {
	useDeviceCaseDatabaseLoad,
	useNavigationDeviceCases,
} from "@/lib/preview/engine/useNavigationDeviceCases";
import type { CaseDatabaseSnapshot } from "@/lib/preview/engine/xpathInstances";
import { useSelectedPreviewIdentity } from "@/lib/preview/hooks/useSelectedPreviewIdentity";
import {
	usePreviewDevice,
	usePreviewMenuCaseSelections,
} from "@/lib/session/hooks";
import type { PreviewSearchDeviceValues } from "@/lib/session/types";
import { useBuilderFormEngine } from "../engine/provider";

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
	const device = usePreviewDevice();
	const step = useMemo(
		() =>
			moduleUuid === undefined
				? NO_STEP_SESSION
				: caseListStepSession(doc, moduleUuid, {
						menuSelections,
						caseDatabase: deviceCases.snapshot,
						session: previewSessionValues(
							identity,
							withNavigationWidth(device),
						),
					}),
		[doc, moduleUuid, menuSelections, deviceCases.snapshot, identity, device],
	);
	return useStableContent(step);
}

/** What a Results read sends for a submitted search's `_xpath_query` rows:
 * nothing to send (no submission, or the registered case, read by its id),
 * values still being worked out, values that can't be worked out until the
 * device's cases load again (`retry` reads them again), or the values. */
export type SubmittedSearchDeviceValues =
	| Exclude<SubmissionValuesState, { kind: "unavailable" }>
	| { readonly kind: "unavailable"; readonly retry: () => Promise<void> };

/** {@link SubmittedSearchDeviceValues} as the state alone decides it. */
export type SubmissionValuesState =
	| { readonly kind: "none" }
	| { readonly kind: "pending" }
	| { readonly kind: "unavailable" }
	| {
			readonly kind: "ready";
			readonly value: SearchCsqlRuntimeWire | undefined;
	  };

/** One submission of a search, by the identity its values are kept under. */
export interface SearchSubmission {
	readonly key: string;
	readonly answers: SearchInputValues;
}

/** Whether the world a submission's values read is there: `ready`, still
 * loading, or `failed` (the device's cases the search reads didn't load). */
export type SearchWorld = "ready" | "waiting" | "failed";

/**
 * The values a submission's read sends: the values kept for it (the module's
 * search state, or this screen's own last evaluation), else `unavailable`
 * when the world they read failed to load, else pending. A value kept under
 * another submission's key is never sent for this one.
 */
export function submittedSearchDeviceValues(
	submission: SearchSubmission | undefined,
	kept: readonly (
		| { readonly key: string; readonly values: PreviewSearchDeviceValues }
		| undefined
	)[],
	world: SearchWorld,
): SubmissionValuesState {
	if (submission === undefined) return { kind: "none" };
	const found = kept.find((entry) => entry?.key === submission.key);
	if (found !== undefined) return { kind: "ready", value: found.values.value };
	return world === "failed" ? { kind: "unavailable" } : { kind: "pending" };
}

/**
 * Whether the world a search's values read is there to read. The lookup
 * tables must not still be loading. The device's cases matter only to a
 * search with a runtime piece that reads them
 * (`searchCsqlRuntime.ts::moduleSearchReadsCaseDatabase`, the predicate the
 * case database provider loads them by): such a search waits for them, as a
 * device holds them before it sends, and a failed load fails it rather than
 * leaving it waiting. A search with none sends without them. Since both
 * sides read one predicate over the one live document, an `idle` load while
 * the search reads them lasts only until the provider's layout effect
 * installs the requirement the same commit computed.
 */
export function searchWorld(args: {
	readonly readsCaseDatabase: boolean;
	readonly deviceCases: CaseDatabaseSnapshot | null;
	readonly deviceCasesLoad: "idle" | "loading" | "ready" | "error";
	readonly lookup: { readonly kind: string };
}): SearchWorld {
	if (args.readsCaseDatabase && args.deviceCases === null)
		return args.deviceCasesLoad === "error" ? "failed" : "waiting";
	return args.lookup.kind === "loading" ? "waiting" : "ready";
}

/**
 * Work out a submitted search's values once per submission, as the device
 * does when it sends the request. `kept` is the value already kept for the
 * submission (the module's search state), which is sent as it is; a new
 * evaluation starts only for a submission with none, once the world is
 * ready, and its result goes to `onWorkedOut` and is kept here for the
 * submission. A later change to the device's cases, a lookup or the session
 * does not work them out again for the same submission. With
 * `waitsForRecord` the hook never evaluates: the values are the session's
 * to record (`SearchDeviceValuesRecorder`), and it waits for `kept`.
 */
export function useSubmittedSearchDeviceValues(args: {
	readonly doc: BlueprintDoc;
	readonly moduleUuid: Uuid | undefined;
	readonly submission: SearchSubmission | undefined;
	readonly kept?: {
		readonly key: string;
		readonly values: PreviewSearchDeviceValues;
	};
	readonly onWorkedOut?: (
		key: string,
		values: PreviewSearchDeviceValues,
	) => void;
	readonly sessionData: Readonly<Record<string, string>>;
	readonly waitsForRecord?: boolean;
}): SubmittedSearchDeviceValues {
	const engine = useBuilderFormEngine();
	const deviceCases = useNavigationDeviceCases(args.doc.caseTypes ?? undefined);
	const deviceCasesLoad = useDeviceCaseDatabaseLoad();
	const identity = useSelectedPreviewIdentity();
	const device = usePreviewDevice();
	const lookupStatus = usePreviewLookupStatus();
	const [own, setOwn] = useState<{
		readonly key: string;
		readonly values: PreviewSearchDeviceValues;
	}>();
	const module =
		args.moduleUuid === undefined
			? undefined
			: args.doc.modules[args.moduleUuid];
	const readsCaseDatabase =
		module !== undefined && moduleSearchReadsCaseDatabase(module);
	const world = searchWorld({
		readsCaseDatabase,
		deviceCases: deviceCases.snapshot,
		deviceCasesLoad: deviceCasesLoad.status,
		lookup: lookupStatus,
	});
	const found = submittedSearchDeviceValues(
		args.submission,
		[args.kept, own],
		world,
	);
	const status: SubmittedSearchDeviceValues =
		found.kind === "unavailable"
			? { kind: "unavailable", retry: deviceCasesLoad.retry }
			: found;
	/* The latest world, read when an evaluation starts; the submission's key
	 * and the world's readiness alone decide whether one starts. */
	const latest = useRef({
		args,
		deviceCases,
		identity,
		device,
		lookupStatus,
		engine,
	});
	latest.current = {
		args,
		deviceCases,
		identity,
		device,
		lookupStatus,
		engine,
	};
	const pendingKey =
		args.waitsForRecord !== true &&
		status.kind === "pending" &&
		world === "ready"
			? args.submission?.key
			: undefined;
	useEffect(() => {
		if (pendingKey === undefined) return;
		const input = latest.current;
		const { doc, moduleUuid, submission } = input.args;
		const caseListConfig =
			moduleUuid === undefined
				? undefined
				: doc.modules[moduleUuid]?.caseListConfig;
		if (
			submission === undefined ||
			moduleUuid === undefined ||
			caseListConfig === undefined
		)
			return;
		const controller = new AbortController();
		const lookup =
			input.lookupStatus.kind === "data" ? input.lookupStatus.data : undefined;
		const keep = (values: PreviewSearchDeviceValues) => {
			if (controller.signal.aborted) return;
			setOwn({ key: pendingKey, values });
			latest.current.args.onWorkedOut?.(pendingKey, values);
		};
		evaluateSearchCsqlRuntime(
			{
				doc,
				moduleUuid,
				caseListConfig,
				answers: submission.answers,
				session: previewSessionValues(
					input.identity,
					withNavigationWidth(input.device),
				),
				sessionData: input.args.sessionData,
				caseDatabase: input.deviceCases.snapshot,
				...(lookup === undefined ? {} : { lookup }),
			},
			/* No signal reaches the worker: cancelling a request terminates it,
			 * and with it the Search screen's other checks. A superseded
			 * evaluation sends no further piece and its result is dropped. */
			resendingWhenSuperseded(
				(xpath) => input.engine.evaluateSearchScreenXPath(moduleUuid, xpath),
				controller.signal,
			),
			controller.signal,
		).then(
			(value) => keep({ value }),
			/* The evaluation itself never throws for a piece it can't run (it
			 * has no value); a failure here is the engine's own, and the read
			 * refuses the rows it could not work out. */
			() =>
				keep({
					value: { segments: {}, choices: {}, unevaluated: true as const },
				}),
		);
		return () => controller.abort();
	}, [pendingKey]);
	return status;
}

/** A key for each distinct submitted values object: one submission keeps its
 * key across renders, and a new Search press (a new object) gets a new one. */
export function useSubmissionKey(
	submitted: object | undefined,
): string | undefined {
	const keys = useRef(new WeakMap<object, string>());
	const next = useRef(0);
	if (submitted === undefined) return undefined;
	let key = keys.current.get(submitted);
	if (key === undefined) {
		next.current += 1;
		key = `submission:${next.current}`;
		keys.current.set(submitted, key);
	}
	return key;
}
