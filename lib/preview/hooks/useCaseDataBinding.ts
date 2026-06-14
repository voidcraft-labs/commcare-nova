// lib/preview/hooks/useCaseDataBinding.ts
//
// Client hooks wrapping the case-data Server Actions with
// effect-based load + reload triggers. Each hook returns
// `{ state, reload }` over a discriminated union with `idle` /
// `loading` prefatory arms. The Server Action + client hook pair
// is the canonical Next.js 16 shape for this case — `PreviewShell`'s
// screen subtree is wholly client (Activity, form engine, doc-store
// subscriptions all require client rendering), so lifting fetches
// to a Server Component above is structurally infeasible.
//
// `useCases` keeps the last settled rows on screen while a reload
// is in flight and reports the in-flight state through a separate
// `fetching` flag — typing into the search form re-queries on every
// debounced change, and blanking the table to a spinner for each
// ~100ms round-trip reads as flicker, not freshness. The `loading`
// arm appears only before the FIRST settle, when there is nothing
// truthful to show yet. No abort controllers — the actions are fast
// single SELECTs and the `cancelled` flag drops stale settles.

"use client";

import { useEffect, useState } from "react";
import type { BlueprintDoc, CaseListConfig } from "@/lib/domain";
import {
	loadCaseDataAction,
	loadCasesAction,
	populateSampleCasesAction,
	resetSampleCasesAction,
} from "@/lib/preview/engine/caseDataBinding";
import type {
	LoadCaseDataResult,
	LoadCasesResult,
	PopulateSampleCasesResult,
} from "@/lib/preview/engine/caseDataBindingTypes";
import type { SearchInputValues } from "@/lib/preview/engine/runtimeBindings";
import { useReloadableResource } from "@/lib/preview/hooks/useReloadableResource";

/**
 * Adds `idle` / `loading` arms to a load result. `idle` covers
 * "call site hasn't asked for the load yet" (URL parsing in
 * flight, registration form with no caseId).
 */
type LoadingState<T extends { kind: string }> =
	| T
	| { kind: "idle" }
	| { kind: "loading" };

/**
 * Subscribe to case-list rows for `(appId, caseType)`. `reload`
 * re-runs the action without changing dependencies (consumers
 * call it after `populateSampleCasesAction` returns to refresh
 * the table). `undefined` for either id keeps the hook in `idle`
 * — same shape `useFormEngine` uses for `formUuid`.
 *
 * Optional `blueprint` + `caseListConfig` thread through to the
 * Server Action so calc-arm columns surface materialized values
 * on each row's `calculated[uuid]` slot. Per-column sort directives
 * order the rows the same way CCHQ would; the optional `filter`
 * narrows the population. Hooks bound to the running-app case
 * list pass both; hooks loading raw rows for non-list-view consumers
 * (case-loading form lookups) leave them undefined and get the
 * unchanged shape.
 *
 * Optional `inputValues` carries the per-input runtime-search bag
 * the running-app `SearchInputForm` builds as the user types. A
 * fresh-reference `inputValues` re-fires the effect's reload path
 * so the case-list re-queries against the AND-composed
 * `(filter, runtime-predicate)` shape. Callers that never mount
 * the search form leave it undefined and `readCases` short-circuits
 * to the existing filter-only path.
 */
export function useCases(args: {
	appId: string | undefined;
	caseType: string | undefined;
	blueprint?: BlueprintDoc;
	caseListConfig?: CaseListConfig;
	inputValues?: SearchInputValues;
}): {
	state: LoadingState<LoadCasesResult>;
	/** A reload is in flight while settled data stays on screen.
	 *  Render the stale rows dimmed (or with an inline spinner)
	 *  rather than unmounting them. */
	fetching: boolean;
	/** Re-runs the load. The returned promise resolves only once the
	 *  re-fired load SETTLES, so the caller (the sample-data action) can
	 *  hold its pressed/spinning state until the fresh rows are on screen,
	 *  not merely until the write returned. */
	reload: () => Promise<void>;
} {
	const { appId, caseType, blueprint, caseListConfig, inputValues } = args;
	return useReloadableResource<LoadingState<LoadCasesResult>>({
		prepare: () =>
			!appId || !caseType
				? { notReady: { kind: "idle" } }
				: {
						fetch: () =>
							loadCasesAction({
								appId,
								caseType,
								blueprint,
								caseListConfig,
								inputValues,
							}),
					},
		loading: { kind: "loading" },
		toError: (err) => ({
			kind: "error",
			message: err instanceof Error ? err.message : "Failed to load cases.",
		}),
		keepStale: (prev) => prev.kind === "rows" || prev.kind === "empty",
		deps: [appId, caseType, blueprint, caseListConfig, inputValues],
	});
}

/**
 * Subscribe to a single case row for case-loading forms. `idle`
 * for any undefined id (URL not yet parsed; registration / survey
 * / followup-without-case) — `idle` reads cleaner than `loading`
 * because the action is simply not applicable.
 */
export function useCaseData(args: {
	appId: string | undefined;
	caseType: string | undefined;
	caseId: string | undefined;
}): { state: LoadingState<LoadCaseDataResult> } {
	const { appId, caseType, caseId } = args;
	const [state, setState] = useState<LoadingState<LoadCaseDataResult>>({
		kind: "idle",
	});

	useEffect(() => {
		if (!appId || !caseType || !caseId) {
			setState({ kind: "idle" });
			return;
		}
		let cancelled = false;
		setState({ kind: "loading" });
		/* See `useCases` for the wire-rejection rationale. */
		loadCaseDataAction(appId, caseType, caseId)
			.then((result) => {
				if (cancelled) return;
				setState(result);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setState({
					kind: "error",
					message: err instanceof Error ? err.message : "Failed to load case.",
				});
			});
		return () => {
			cancelled = true;
		};
	}, [appId, caseType, caseId]);

	return { state };
}

/**
 * Curried action callback for the "Generate sample data" button.
 * The hook owns no loading state — the consuming component owns
 * pressed-state and toast UX.
 *
 * NOT wrapped in `useCallback` — the typical caller passes a
 * fresh-per-render `blueprint` projection
 * (`pickBlueprintDoc(docApi.getState())`), so `useCallback` would
 * invalidate every render and the memoization would be
 * structurally empty.
 */
export function usePopulateSampleCases(args: {
	appId: string | undefined;
	caseType: string | undefined;
	blueprint: BlueprintDoc | undefined;
}): () => Promise<PopulateSampleCasesResult> {
	const { appId, caseType, blueprint } = args;

	return async () => {
		if (!appId || !caseType || !blueprint) {
			return {
				kind: "error",
				message: "App, case type, or blueprint not yet available.",
			};
		}
		return populateSampleCasesAction(appId, caseType, blueprint);
	};
}

/**
 * Curried action callback for the "Reset sample data" affordance.
 * Mirror of `usePopulateSampleCases` over `resetSampleCasesAction` —
 * delete the existing rows for the bound `(appId, caseType)` and
 * regenerate a fresh population in one atomic case-store transaction.
 * The consuming component owns pressed-state, the confirmation
 * dialog, and toast UX.
 *
 * Not wrapped in `useCallback` for the same reason
 * `usePopulateSampleCases` isn't: the typical caller passes a
 * fresh-per-render `blueprint` projection
 * (`pickBlueprintDoc(docApi.getState())`), so memoizing would
 * invalidate every render and the memoization would be structurally
 * empty.
 */
export function useResetSampleCases(args: {
	appId: string | undefined;
	caseType: string | undefined;
	blueprint: BlueprintDoc | undefined;
}): () => Promise<PopulateSampleCasesResult> {
	const { appId, caseType, blueprint } = args;

	return async () => {
		if (!appId || !caseType || !blueprint) {
			return {
				kind: "error",
				message: "App, case type, or blueprint not yet available.",
			};
		}
		return resetSampleCasesAction(appId, caseType, blueprint);
	};
}
