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
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import type { CaseDatabaseSnapshot } from "@/lib/preview/engine/xpathInstances";
import { useSelectedPreviewIdentity } from "@/lib/preview/hooks/useSelectedPreviewIdentity";
import { usePreviewMenuCaseSelections } from "@/lib/session/hooks";
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

/** What a Results read sends for a submitted search's `_xpath_query` rows:
 * nothing to send (no submission, or the registered case, read by its id),
 * values still being worked out, or the values. */
export type SubmittedSearchDeviceValues =
	| { readonly kind: "none" }
	| { readonly kind: "pending" }
	| {
			readonly kind: "ready";
			readonly value: SearchCsqlRuntimeWire | undefined;
	  };

/** One submission of a search, by the identity its values are kept under. */
export interface SearchSubmission {
	readonly key: string;
	readonly answers: SearchInputValues;
}

/**
 * The values a submission's read sends: the values kept for it (the module's
 * search state, or this screen's own last evaluation), else pending. A
 * value kept under another submission's key is never sent for this one.
 */
export function submittedSearchDeviceValues(
	submission: SearchSubmission | undefined,
	kept: readonly (
		| { readonly key: string; readonly values: PreviewSearchDeviceValues }
		| undefined
	)[],
): SubmittedSearchDeviceValues {
	if (submission === undefined) return { kind: "none" };
	const found = kept.find((entry) => entry?.key === submission.key);
	return found === undefined
		? { kind: "pending" }
		: { kind: "ready", value: found.values.value };
}

/**
 * Whether the world a search's values read is there to read: the device's
 * cases have loaded and the lookup tables are not still loading. A device
 * holds both before it can send a search, so the values wait for them.
 */
export function searchWorldReady(
	deviceCases: CaseDatabaseSnapshot | null,
	lookup: { readonly kind: string },
): boolean {
	return deviceCases !== null && lookup.kind !== "loading";
}

/**
 * Work out a submitted search's values once per submission, as the device
 * does when it sends the request. `kept` is the value already kept for the
 * submission (the module's search state), which is sent as it is; a new
 * evaluation starts only for a submission with none, once the world is
 * ready, and its result goes to `onWorkedOut` and is kept here for the
 * submission. A later change to the device's cases, a lookup or the session
 * does not work them out again for the same submission.
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
}): SubmittedSearchDeviceValues {
	const engine = useBuilderFormEngine();
	const deviceCases = useNavigationDeviceCases(args.doc.caseTypes ?? undefined);
	const identity = useSelectedPreviewIdentity();
	const lookupStatus = usePreviewLookupStatus();
	const [own, setOwn] = useState<{
		readonly key: string;
		readonly values: PreviewSearchDeviceValues;
	}>();
	const status = submittedSearchDeviceValues(args.submission, [args.kept, own]);
	const ready = searchWorldReady(deviceCases.snapshot, lookupStatus);
	/* The latest world, read when an evaluation starts; the submission's key
	 * and the world's readiness alone decide whether one starts. */
	const latest = useRef({ args, deviceCases, identity, lookupStatus, engine });
	latest.current = { args, deviceCases, identity, lookupStatus, engine };
	const pendingKey =
		status.kind === "pending" && ready ? args.submission?.key : undefined;
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
		evaluateSearchCsqlRuntime(
			{
				doc,
				moduleUuid,
				caseListConfig,
				answers: submission.answers,
				session: previewSessionValues(input.identity),
				sessionData: input.args.sessionData,
				caseDatabase: input.deviceCases.snapshot,
				...(lookup === undefined ? {} : { lookup }),
			},
			/* No signal reaches the worker: cancelling a request terminates it,
			 * and with it the Search screen's other checks. A superseded
			 * evaluation sends no further piece and its result is dropped. */
			(xpath) => input.engine.evaluateSearchScreenXPath(moduleUuid, xpath),
			controller.signal,
		).then(
			(value) => {
				if (controller.signal.aborted) return;
				const values = { value };
				setOwn({ key: pendingKey, values });
				latest.current.args.onWorkedOut?.(pendingKey, values);
			},
			() => {
				/* The evaluation itself never throws for a piece it can't run (it
				 * has no value); a failure here is the engine's own, and the read
				 * refuses the rows it could not work out. */
				if (controller.signal.aborted) return;
				const values = {
					value: { segments: {}, choices: {}, unevaluated: true as const },
				};
				setOwn({ key: pendingKey, values });
				latest.current.args.onWorkedOut?.(pendingKey, values);
			},
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
