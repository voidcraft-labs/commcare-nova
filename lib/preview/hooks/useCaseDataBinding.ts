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

import { useMemo } from "react";
import type { CaseListConfig, CaseType } from "@/lib/domain";
import type { ValueExpression } from "@/lib/domain/predicate";
import {
	loadCaseCountAction,
	loadCaseDataAction,
	loadCasesAction,
	populateSampleCasesAction,
	resetSampleCasesAction,
} from "@/lib/preview/engine/caseDataBinding";
import { viewerTimeZone } from "@/lib/preview/engine/caseDataBindingClient";
import type {
	CaseQueryConstraintContext,
	LoadCaseCountResult,
	LoadCaseDataResult,
	LoadCasesResult,
	PopulateSampleCasesResult,
} from "@/lib/preview/engine/caseDataBindingTypes";
import {
	type SearchInputValues,
	searchInputValuesToWire,
} from "@/lib/preview/engine/runtimeBindings";
import {
	invalidateCaseData,
	useCaseDataReplacementRevision,
	useCaseDataRevision,
} from "@/lib/preview/hooks/caseDataInvalidation";
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
 * re-runs the action without changing dependencies; successful case-data
 * writes also refresh it through the shared per-type revision signal.
 * `undefined` for either id keeps the hook in `idle`
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
	/** Optional bounded server window for a real Results surface. */
	page?: { readonly offset: number; readonly limit: number };
	/** Stable caller identity for surfaces that may query the same case type
	 * with different modules/configuration. Rows stay stale only within this
	 * scope while prompt edits revalidate. */
	requestScopeKey?: string;
}): {
	state: LoadingState<LoadCasesResult>;
	/** Server-derived cause of the effective query's narrowing. Blank prompt
	 *  values and empty evaluated owner expressions remain unconstrained. */
	queryConstraintSource: CaseQueryConstraintContext;
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
		page,
		requestScopeKey = "",
	} = args;
	const pageOffset = page?.offset;
	const pageLimit = page?.limit;
	const caseDataRevision = useCaseDataRevision(appId, caseType);
	const replacementRevision = useCaseDataReplacementRevision(appId, caseType);
	const ready = Boolean(appId && caseType);
	/* Query edits within one case type deliberately keep settled rows visible,
	 * but an app/case-type change is an identity boundary. Keep that identity
	 * beside the result so the render that precedes the refetch effect can never
	 * project old rows through the new module's columns or row actions. */
	const requestIdentity = ready
		? `${appId}\u0000${caseType}\u0000${requestScopeKey}\u0000${replacementRevision}\u0000${pageOffset ?? "default"}\u0000${pageLimit ?? "default"}`
		: "";
	const reloadToken = useMemo(
		() => [
			requestIdentity,
			caseListConfig,
			inputValues,
			excludedOwnerIdsExpression,
			caseTypes,
			caseDataRevision,
		],
		[
			requestIdentity,
			caseListConfig,
			inputValues,
			excludedOwnerIdsExpression,
			caseTypes,
			caseDataRevision,
		],
	);
	interface KeyedCasesState {
		readonly kind: "cases";
		readonly key: string;
		readonly value: LoadingState<LoadCasesResult>;
	}
	const resource = useReloadableResource<KeyedCasesState>({
		prepare: () =>
			!appId || !caseType
				? {
						notReady: {
							kind: "cases",
							key: "",
							value: { kind: "idle" },
						},
					}
				: {
						fetch: async () => ({
							kind: "cases" as const,
							key: requestIdentity,
							value: await loadCasesAction({
								appId,
								caseType,
								caseListConfig,
								caseTypes,
								inputValues: inputValues
									? searchInputValuesToWire(inputValues)
									: undefined,
								excludedOwnerIdsExpression,
								page:
									pageOffset === undefined || pageLimit === undefined
										? undefined
										: { offset: pageOffset, limit: pageLimit },
								viewerTimeZone: viewerTimeZone(),
							}),
						}),
					},
		loading: {
			kind: "cases",
			key: requestIdentity,
			value: { kind: "loading" },
		},
		toError: (err) => ({
			kind: "cases",
			key: requestIdentity,
			value: {
				kind: "error",
				message: err instanceof Error ? err.message : "Failed to load cases.",
			},
		}),
		keepStale: (prev) =>
			prev.key === requestIdentity &&
			(prev.value.kind === "rows" || prev.value.kind === "empty"),
		reloadToken,
	});
	const state: LoadingState<LoadCasesResult> = !ready
		? { kind: "idle" }
		: resource.state.key === requestIdentity
			? resource.state.value
			: { kind: "loading" };
	const queryConstraintSource =
		state.kind === "rows" || state.kind === "empty"
			? (state.constraintSource ?? "unknown")
			: "unconstrained";
	return {
		state,
		fetching: resource.fetching,
		reload: resource.reload,
		queryConstraintSource,
	};
}

/**
 * Subscribe to the complete, unfiltered population size for one case type.
 * Unlike a Results query, this count never carries the module's authored
 * filter, so the case-data manager can safely distinguish "no cases exist"
 * from "no cases match this view."
 */
export function useCaseCount(args: {
	appId: string | undefined;
	caseType: string | undefined;
}): {
	state: LoadingState<LoadCaseCountResult>;
	fetching: boolean;
	reload: () => Promise<void>;
} {
	const { appId, caseType } = args;
	const caseDataRevision = useCaseDataRevision(appId, caseType);
	const ready = Boolean(appId && caseType);
	const requestIdentity = ready ? `${appId}\u0000${caseType}` : "";
	const reloadToken = useMemo(
		() => [requestIdentity, caseDataRevision],
		[requestIdentity, caseDataRevision],
	);
	interface KeyedCaseCountState {
		readonly kind: "case-count";
		readonly key: string;
		readonly value: LoadingState<LoadCaseCountResult>;
	}
	const resource = useReloadableResource<KeyedCaseCountState>({
		prepare: () =>
			!appId || !caseType
				? {
						notReady: {
							kind: "case-count",
							key: "",
							value: { kind: "idle" },
						},
					}
				: {
						fetch: async () => ({
							kind: "case-count" as const,
							key: requestIdentity,
							value: await loadCaseCountAction({ appId, caseType }),
						}),
					},
		loading: {
			kind: "case-count",
			key: requestIdentity,
			value: { kind: "loading" },
		},
		toError: (err) => ({
			kind: "case-count",
			key: requestIdentity,
			value: {
				kind: "error",
				message: err instanceof Error ? err.message : "Failed to count cases.",
			},
		}),
		keepStale: (prev) =>
			prev.key === requestIdentity && prev.value.kind === "count",
		reloadToken,
	});
	return {
		state: !ready
			? { kind: "idle" }
			: resource.state.key === requestIdentity
				? resource.state.value
				: { kind: "loading" },
		fetching: resource.fetching,
		reload: resource.reload,
	};
}

/**
 * Subscribe to a single case row — plus its ancestor chain, walked
 * server-side — for case-loading forms and canonical Details URLs. `idle` for any undefined id
 * (URL not yet parsed; registration / survey /
 * followup-without-case) — `idle` reads cleaner than `loading`
 * because the action is simply not applicable.
 *
 * A Details caller supplies `caseListConfig` and the live `caseTypes`
 * catalog to request calculated display projections for this one row.
 * Form callers omit them. Projection references are part of the keyed
 * result identity so a live config/catalog edit cannot render an older
 * calculated map for one frame while the replacement read starts.
 */
export function useCaseData(args: {
	appId: string | undefined;
	caseType: string | undefined;
	caseId: string | undefined;
	/** Parent hops the form's refs can address —
	 *  `reachableCaseTypes(...).length - 1`. Bounds the server-side
	 *  ancestor walk. */
	ancestorDepth: number;
	/** Optional one-row display projection for canonical Details URLs. */
	caseListConfig?: CaseListConfig;
	/** Live compiler catalog paired with `caseListConfig`. */
	caseTypes?: readonly CaseType[];
}): {
	state: LoadingState<LoadCaseDataResult>;
	reload: () => Promise<void>;
} {
	const { appId, caseType, caseId, ancestorDepth, caseListConfig, caseTypes } =
		args;
	const caseDataRevision = useCaseDataRevision(appId, caseType);
	const ready = Boolean(appId && caseType && caseId);
	/* Keep the request identity beside its result. A dependency change renders
	 * before this hook's effect can set `loading`; returning a row from the prior
	 * case/revision for that one render would let a case-loading form submit an
	 * identity that has already been replaced. */
	const requestKey = ready
		? `${appId}\u0000${caseType}\u0000${caseId}\u0000${ancestorDepth}\u0000${caseDataRevision}`
		: "";
	const reloadToken = useMemo(
		() => [requestKey, caseListConfig, caseTypes],
		[requestKey, caseListConfig, caseTypes],
	);
	interface KeyedCaseDataState {
		readonly kind: "case-data";
		readonly key: string;
		readonly caseListConfig: CaseListConfig | undefined;
		readonly caseTypes: readonly CaseType[] | undefined;
		readonly value: LoadingState<LoadCaseDataResult>;
	}
	const resource = useReloadableResource<KeyedCaseDataState>({
		prepare: () =>
			!appId || !caseType || !caseId
				? {
						notReady: {
							kind: "case-data",
							key: "",
							caseListConfig,
							caseTypes,
							value: { kind: "idle" },
						},
					}
				: {
						fetch: async () => ({
							kind: "case-data" as const,
							key: requestKey,
							caseListConfig,
							caseTypes,
							value: await loadCaseDataAction(
								appId,
								caseType,
								caseId,
								ancestorDepth,
								caseListConfig,
								caseTypes,
								viewerTimeZone(),
							),
						}),
					},
		loading: {
			kind: "case-data",
			key: requestKey,
			caseListConfig,
			caseTypes,
			value: { kind: "loading" },
		},
		toError: (err) => ({
			kind: "case-data",
			key: requestKey,
			caseListConfig,
			caseTypes,
			value: {
				kind: "error",
				message: err instanceof Error ? err.message : "Failed to load case.",
			},
		}),
		keepStale: () => false,
		reloadToken,
	});

	if (!ready) return { state: { kind: "idle" }, reload: resource.reload };
	return {
		state:
			resource.state.key === requestKey &&
			resource.state.caseListConfig === caseListConfig &&
			resource.state.caseTypes === caseTypes
				? resource.state.value
				: { kind: "loading" },
		reload: resource.reload,
	};
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
		const result = await populateSampleCasesAction(appId, caseType);
		if (result.kind === "ok") invalidateCaseData(appId, caseType.name);
		return result;
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
		const result = await resetSampleCasesAction(appId, caseType);
		if (result.kind === "ok")
			invalidateCaseData(appId, caseType.name, "replacement");
		return result;
	};
}
