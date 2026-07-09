/**
 * BuilderReferenceProvider — isolates the `useLocation()` subscription
 * needed to resolve the in-scope form for reference autocomplete/lint.
 *
 * The in-scope form lives on the URL, so `getRefContext` needs a
 * `useLocation()` read. Keeping that read here — rather than in
 * `BuilderLayout` — preserves the layout's "re-render only on app
 * lifecycle transitions" invariant: every selection change issues a
 * navigation, and a layout-level `useLocation()` would cascade those
 * into layout re-renders.
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
import type { Uuid } from "@/lib/domain";
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

	/** Build the `XPathLintContext` for any form by uuid. Called by
	 *  `ReferenceProvider` whenever it resolves a ref — the active form for
	 *  in-editor surfaces, each field's owning form for the sidebar. Reads the
	 *  doc store imperatively so we don't subscribe to blueprint state here
	 *  (cache invalidation is driven by `subscribeMutation` below). */
	const getContextForForm = useCallback(
		(formUuid: string) =>
			docStore
				? buildLintContext(docStore.getState(), formUuid as Uuid)
				: undefined,
		[docStore],
	);

	/** The form the user is currently editing, surfaced via `useCurrentFormUuid`
	 *  so editor/canvas chip surfaces resolve without threading the uuid. */
	const currentFormUuid = loc.kind === "form" ? loc.formUuid : undefined;

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
			getContextForForm={getContextForForm}
			currentFormUuid={currentFormUuid}
			subscribeMutation={subscribeMutation}
		>
			{children}
		</ReferenceProviderWrapper>
	);
}
