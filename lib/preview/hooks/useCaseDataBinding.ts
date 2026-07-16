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
import type { CaseListConfig, CaseType } from "@/lib/domain";
import type { ValueExpression } from "@/lib/domain/predicate";
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
import {
	type SearchInputValues,
	searchInputValuesToWire,
} from "@/lib/preview/engine/runtimeBindings";
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
 * Optional `caseListConfig` threads through to the Server Action so
 * calc-arm columns surface materialized values on each row's
 * `calculated[uuid]` slot. Per-column sort directives order the rows
 * the same way CCHQ would; the optional `filter` narrows the
 * population. Hooks bound to the running-app case list pass it; hooks
 * loading raw rows for non-list-view consumers (case-loading form
 * lookups) leave it undefined and get the unchanged shape.
 *
 * Optional `caseTypes` is the live case-type catalog — the slice the
 * SQL compiler reads to cast `caseListConfig`'s predicate/sort/calc.
 * It travels with the config in the same call so the schemas stay
 * consistent with it (a property rename reaches both together), and a
 * fresh-reference `caseTypes` re-fires the load the instant the schema
 * changes. It is plain JSON, so the call stays off the multipart wire.
 * Raw-row consumers leave it undefined.
 *
 * Optional `inputValues` carries the per-input runtime-search bag
 * the running-app `SearchInputForm` builds as the user types. A
 * fresh-reference `inputValues` re-fires the effect's reload path
 * so the case-list re-queries against the AND-composed
 * `(filter, runtime-predicate)` shape. Callers that never mount
 * the search form leave it undefined and `readCases` short-circuits
 * to the existing filter-only path. It is a `Map` here and crosses
 * the wire as a plain object (`searchInputValuesToWire`) so the
 * Server Action call stays a plain-JSON body rather than multipart.
 *
 * Optional `excludedOwnerIdsExpression` remains a typed expression until the
 * authenticated Server Action so session-backed values (notably the current
 * worker id) resolve authoritatively before the local query is composed.
 */
export function useCases(args: {
	appId: string | undefined;
	caseType: string | undefined;
	caseListConfig?: CaseListConfig;
	inputValues?: SearchInputValues;
	excludedOwnerIdsExpression?: ValueExpression;
	caseTypes?: readonly CaseType[];
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
	const {
		appId,
		caseType,
		caseListConfig,
		inputValues,
		excludedOwnerIdsExpression,
		caseTypes,
	} = args;
	return useReloadableResource<LoadingState<LoadCasesResult>>({
		prepare: () =>
			!appId || !caseType
				? { notReady: { kind: "idle" } }
				: {
						fetch: () =>
							loadCasesAction({
								appId,
								caseType,
								caseListConfig,
								caseTypes,
								inputValues: inputValues
									? searchInputValuesToWire(inputValues)
									: undefined,
								excludedOwnerIdsExpression,
							}),
					},
		loading: { kind: "loading" },
		toError: (err) => ({
			kind: "error",
			message: err instanceof Error ? err.message : "Failed to load cases.",
		}),
		keepStale: (prev) => prev.kind === "rows" || prev.kind === "empty",
		deps: [
			appId,
			caseType,
			caseListConfig,
			inputValues,
			excludedOwnerIdsExpression,
			caseTypes,
		],
	});
}

/**
 * Subscribe to a single case row — plus its ancestor chain, walked
 * server-side — for case-loading forms. `idle` for any undefined id
 * (URL not yet parsed; registration / survey /
 * followup-without-case) — `idle` reads cleaner than `loading`
 * because the action is simply not applicable.
 */
export function useCaseData(args: {
	appId: string | undefined;
	caseType: string | undefined;
	caseId: string | undefined;
	/** Parent hops the form's refs can address —
	 *  `reachableCaseTypes(...).length - 1`. Bounds the server-side
	 *  ancestor walk. */
	ancestorDepth: number;
}): { state: LoadingState<LoadCaseDataResult> } {
	const { appId, caseType, caseId, ancestorDepth } = args;
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
		loadCaseDataAction(appId, caseType, caseId, ancestorDepth)
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
	}, [appId, caseType, caseId, ancestorDepth]);

	return { state };
}

/**
 * Curried action callback for the "Generate sample data" button.
 * The hook owns no loading state — the consuming component owns
 * pressed-state and toast UX. A fresh closure per render is fine for
 * a one-shot button callback, so it is intentionally not memoized.
 *
 * `caseType` is the live `CaseType` definition (the generator reads
 * its property declarations), passed straight through — the hook never
 * ships the whole blueprint.
 */
export function usePopulateSampleCases(args: {
	appId: string | undefined;
	caseType: CaseType | undefined;
}): () => Promise<PopulateSampleCasesResult> {
	const { appId, caseType } = args;

	return async () => {
		if (!appId || !caseType) {
			return {
				kind: "error",
				message: "App or case type not yet available.",
			};
		}
		return populateSampleCasesAction(appId, caseType);
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
 * Not memoized for the same reason `usePopulateSampleCases` isn't —
 * a fresh closure per render is fine for a one-shot button callback —
 * and it likewise passes the live `CaseType` definition straight
 * through, never the whole blueprint.
 */
export function useResetSampleCases(args: {
	appId: string | undefined;
	caseType: CaseType | undefined;
}): () => Promise<PopulateSampleCasesResult> {
	const { appId, caseType } = args;

	return async () => {
		if (!appId || !caseType) {
			return {
				kind: "error",
				message: "App or case type not yet available.",
			};
		}
		return resetSampleCasesAction(appId, caseType);
	};
}
