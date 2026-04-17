/**
 * BuilderReferenceProvider — isolates the `useLocation()` subscription
 * needed to resolve the in-scope form for reference autocomplete/lint.
 *
 * Phase 2's URL-state migration moved the "current form" signal from the
 * legacy builder store onto the URL, which means `getRefContext` now needs
 * a `useLocation()` read. Placing that read directly in `BuilderLayout`
 * would break the layout's "re-renders only on app lifecycle transitions
 * and replay toggle" invariant — every selection change issues a
 * `router.replace`, which would cascade into a layout re-render.
 *
 * Solution: split the reference provider wiring into this tiny child.
 * It owns the `useLocation()` subscription, constructs `getRefContext`
 * via the builder engine's imperative store (no reactive subscription),
 * and renders `ReferenceProviderWrapper`. Re-renders of this component
 * are cheap — the child tree is just the wrapper, whose `ReferenceProvider`
 * instance is memoized and whose cache invalidation is driven by the
 * `subscribeMutation` handle, not the React render cycle.
 *
 * BuilderLayout now subscribes to exactly `phase` + `inReplayMode` again,
 * matching the invariant documented at the top of that file.
 */

"use client";

import { useCallback, useContext } from "react";
import { buildLintContext } from "@/lib/codemirror/buildLintContext";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { ReferenceProviderWrapper } from "@/lib/references/ReferenceContext";
import { useLocation } from "@/lib/routing/hooks";

interface BuilderReferenceProviderProps {
	children: React.ReactNode;
}

export function BuilderReferenceProvider({
	children,
}: BuilderReferenceProviderProps) {
	const docStore = useContext(BlueprintDocContext);
	const loc = useLocation();

	/** Build the `XPathLintContext` for whatever form the URL says the user
	 *  is editing. Called by `ReferenceProvider` at edit time — reads the
	 *  doc store imperatively so we don't subscribe to blueprint state
	 *  here (cache invalidation is driven by `subscribeMutation` below). */
	const getRefContext = useCallback(() => {
		if (!docStore) return undefined;
		if (loc.kind !== "form") return undefined;
		return buildLintContext(docStore.getState(), loc.formUuid);
	}, [docStore, loc]);

	/** Subscribe to entity changes that invalidate the ReferenceProvider cache.
	 *  Covers fields (field references, case_property), modules (case_type renames),
	 *  and forms (form type changes affecting case config). Uses a tuple selector
	 *  with reference equality — only fires when at least one entity map gets a
	 *  new Immer reference. */
	const subscribeMutation = useCallback(
		(listener: () => void) => {
			if (!docStore) return () => {};
			return docStore.subscribe(
				(s) => [s.fields, s.modules, s.forms] as const,
				() => listener(),
				{
					equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2],
				},
			);
		},
		[docStore],
	);

	return (
		<ReferenceProviderWrapper
			getContext={getRefContext}
			subscribeMutation={subscribeMutation}
		>
			{children}
		</ReferenceProviderWrapper>
	);
}
