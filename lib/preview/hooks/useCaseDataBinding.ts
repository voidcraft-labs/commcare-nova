// lib/preview/hooks/useCaseDataBinding.ts
//
// Client hooks that wrap the case-data Server Actions in
// `lib/preview/engine/caseDataBinding.ts` with effect-based
// loading + reload triggers. Components subscribe to one hook
// per data shape and render off the discriminated-union state.
//
// ## Why hooks (and not Server Component prop-drilling)
//
// `PreviewShell`'s screen subtree is wholly client — `Activity`,
// the form engine, the doc-store subscriptions all require client
// rendering. Lifting case-data fetching to a Server Component
// above `PreviewShell` would force the entire builder client tree
// to relocate, which is structurally infeasible. The Server
// Action + client hook pair is the canonical Next.js 16 pattern
// for this shape: data fetching stays server-side via the action,
// the client hook owns the loading lifecycle.
//
// ## Loading lifecycle shape
//
// Each hook returns `{ state, reload }`:
//
//   - `state` is the discriminated-union result with two prefatory
//     arms — `{ kind: "idle" }` (a required argument is undefined,
//     so the action has not been asked for) and `{ kind: "loading" }`
//     (the action is in flight). After the first action returns,
//     `state` holds whatever the action produced (`rows` / `empty` /
//     `unauthenticated` / `error` for cases; `row` / `missing` /
//     `unauthenticated` / `error` for case-data).
//   - `reload` triggers a fresh action call. Used by the
//     case-list view's "Generate sample data" button to refresh
//     the table after the populate action returns.
//
// The hooks intentionally keep the loading lifecycle simple: no
// stale-while-revalidate cache, no SWR, no manual abort
// controllers. The case data is small (hundreds of rows per
// case-type at running-app scale), the actions are fast (single
// Postgres SELECT), and the consumer screens don't display data
// while remounting. A reload-on-mount + reload-on-button-click
// shape is sufficient for the running-app view's data freshness
// needs.

"use client";

import { useCallback, useEffect, useState } from "react";
import type { BlueprintDoc } from "@/lib/domain";
import {
	loadCaseDataAction,
	loadCasesAction,
	populateSampleCasesAction,
} from "@/lib/preview/engine/caseDataBinding";
import type {
	LoadCaseDataResult,
	LoadCasesResult,
	PopulateSampleCasesResult,
} from "@/lib/preview/engine/caseDataBindingTypes";

// ---------------------------------------------------------------
// `LoadingState<T>`
// ---------------------------------------------------------------

/**
 * Adds two prefatory arms to a discriminated-union load result:
 *
 *   - `idle` — the call site has not asked for the load yet (e.g.
 *     a required argument is undefined because the URL is still
 *     being parsed, or a registration form has no caseId to load
 *     against).
 *   - `loading` — the action is in flight; the consumer renders a
 *     spinner.
 *
 * After the first action returns, the state holds whichever arm
 * the action produced (`rows` / `empty` / `unauthenticated` /
 * `error` for cases; `row` / `missing` / ... for case-data).
 */
type LoadingState<T extends { kind: string }> =
	| T
	| { kind: "idle" }
	| { kind: "loading" };

// ---------------------------------------------------------------
// `useCases`
// ---------------------------------------------------------------

/**
 * Subscribe to the case-list rows for `(appId, caseType)`. The
 * hook fires `loadCasesAction` on mount and whenever the
 * `(appId, caseType)` pair changes; the returned `reload`
 * callback re-runs the same action without changing dependencies
 * (consumers call it after `populateSampleCasesAction` returns
 * to refresh the table).
 *
 * Pass `undefined` for either id when the URL is still being
 * parsed — the hook stays in `{ kind: "idle" }` until both are
 * bound. Same shape `useFormEngine` uses for `formUuid`.
 */
export function useCases(args: {
	appId: string | undefined;
	caseType: string | undefined;
}): {
	state: LoadingState<LoadCasesResult>;
	reload: () => void;
} {
	const { appId, caseType } = args;
	const [state, setState] = useState<LoadingState<LoadCasesResult>>({
		kind: "idle",
	});
	/* `reloadKey` increments to force the load effect to fire again
	 * without re-keying on data the action arguments don't capture
	 * (e.g. after a successful sample-data populate). The biome-
	 * ignore directive flags an intentional use of this trigger
	 * pattern: `reloadKey` is the dependency that causes a re-fire,
	 * but the body never reads it — exactly what the rule's heuristic
	 * mis-classifies as "unnecessary". */
	const [reloadKey, setReloadKey] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the trigger that re-fires this effect; not read in the body.
	useEffect(() => {
		if (!appId || !caseType) {
			setState({ kind: "idle" });
			return;
		}
		let cancelled = false;
		setState({ kind: "loading" });
		/* The Server Action's body wraps its work in try/catch and
		 * returns `{ kind: "error" }` for thrown failures, but
		 * wire-level rejections (HTTP 500, network unreachable, RSC
		 * serialization failures at the boundary) reject the returned
		 * promise without entering the action body. The `.catch`
		 * handler maps those to the same `error` arm so the loading
		 * machine always reaches a terminal state — without it, a
		 * wire failure leaves the hook stuck on `loading` forever. */
		loadCasesAction(appId, caseType)
			.then((result) => {
				if (cancelled) return;
				setState(result);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setState({
					kind: "error",
					message: err instanceof Error ? err.message : "Failed to load cases.",
				});
			});
		return () => {
			cancelled = true;
		};
	}, [appId, caseType, reloadKey]);

	const reload = useCallback(() => {
		setReloadKey((n) => n + 1);
	}, []);

	return { state, reload };
}

// ---------------------------------------------------------------
// `useCaseData`
// ---------------------------------------------------------------

/**
 * Subscribe to a single case row for the case-loading form path.
 * Used by `FormScreen` when `screen.caseId` is bound to fetch the
 * row whose properties the form engine consumes as preload.
 *
 * The hook returns `{ kind: "idle" }` whenever any of the three
 * ids is undefined — the URL parser may not have resolved the
 * module yet, or the form may have no `caseId` to load against
 * (registration / survey / followup-without-case). `idle` reads
 * cleaner than `loading` in those branches because the hook is
 * not waiting on a promise; the action is simply not applicable.
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
		/* See `useCases` for the wire-rejection rationale — same
		 * pattern; the `.catch` arm guarantees the loading machine
		 * always reaches a terminal state. */
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

// ---------------------------------------------------------------
// `usePopulateSampleCases`
// ---------------------------------------------------------------

/**
 * Returns an action callback the case-list view's "Generate
 * sample data" button calls. The callback fires
 * `populateSampleCasesAction` and returns its result so the
 * caller can chain a reload + display the inserted count.
 *
 * The hook does NOT manage its own loading flag — the consuming
 * component owns that UI state because the button's pressed
 * state and any toast/spinner UX is the consumer's responsibility.
 * The hook is a thin curry over the action that closes over the
 * three required arguments without forcing them through the
 * button's onClick prop.
 *
 * The closure is intentionally NOT wrapped in `useCallback`. The
 * typical caller passes a fresh-per-render `blueprint` projection
 * (`pickBlueprintDoc(docApi.getState())`), so a `useCallback` on
 * `[appId, caseType, blueprint]` would invalidate on every render
 * anyway — the memoization would be structurally empty. Closure
 * allocation is cheap; pretending to memoize is misleading.
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
