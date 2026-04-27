/**
 * BuilderReferenceProvider — isolates the `useLocation()` subscription
 * needed to resolve the in-scope form for reference autocomplete/lint.
 *
 * The in-scope form lives on the URL, so `getRefContext` needs a
 * `useLocation()` read. Keeping that read here — rather than in
 * `BuilderLayout` — preserves the layout's "re-render only on app
 * lifecycle transitions and replay toggle" invariant: every selection
 * change issues a navigation, and a layout-level `useLocation()` would
 * cascade those into layout re-renders.
 *
 * This component owns the `useLocation()` subscription, constructs
 * `getRefContext` via the doc store imperatively (no reactive
 * subscription), and renders `ReferenceProviderWrapper`. Re-renders here
 * are cheap — the child tree is just the wrapper, whose
 * `ReferenceProvider` instance is memoized and whose cache invalidation
 * is driven by the `subscribeMutation` handle, not the React render
 * cycle.
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
	 *  Covers fields (field references, case_property_on), modules (case_type renames),
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
