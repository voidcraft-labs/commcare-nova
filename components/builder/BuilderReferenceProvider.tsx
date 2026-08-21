/**
 * BuilderReferenceProvider: isolates the `useLocation()` subscription
 * needed to resolve the in-scope form for reference autocomplete/lint.
 *
 * The in-scope form lives on the URL, so `getRefContext` needs a
 * `useLocation()` read. Keeping that read here, rather than in
 * `BuilderLayout`: preserves the layout's "re-render only on app
 * lifecycle transitions" invariant: every selection change issues a
 * navigation, and a layout-level `useLocation()` would cascade those
 * into layout re-renders.
 *
 * This component owns the `useLocation()` subscription, constructs
 * `getRefContext` via the doc store imperatively (no reactive
 * subscription), and renders `ReferenceProviderWrapper`. Re-renders here
 * are cheap: the child tree is just the wrapper, whose
 * `ReferenceProvider` instance is memoized and whose cache invalidation
 * is driven by the `subscribeMutation` handle, not the React render
 * cycle.
 */

"use client";

import { useCallback, useContext } from "react";
import { buildLintContext } from "@/lib/codemirror/buildLintContext";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { asUuid } from "@/lib/domain";
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
	 *  `ReferenceProvider` whenever it resolves a ref: the active form for
	 *  in-editor surfaces, each field's owning form for the sidebar. Reads the
	 *  doc store imperatively so we don't subscribe to blueprint state here
	 *  (cache invalidation is driven by `subscribeMutation` below). */
	const getContextForForm = useCallback(
		(formUuid: string) =>
			docStore
				? buildLintContext(docStore.getState(), asUuid(formUuid))
				: undefined,
		[docStore],
	);

	/** The form the user is currently editing, surfaced via `useCurrentFormUuid`
	 *  so editor/canvas chip surfaces resolve without threading the uuid.
	 *  A form's own configuration URLs name the same form. */
	const currentFormUuid =
		loc.kind === "form" ||
		loc.kind === "form-condition" ||
		loc.kind === "form-operations" ||
		loc.kind === "form-links"
			? loc.formUuid
			: undefined;

	/** Subscribe to every document family read by `buildLintContext`. Field
	 *  moves change only `fieldOrder`; form moves change only `formOrder`;
	 *  worker-information renames and case-catalog edits likewise live outside
	 *  the field/module/form entity maps. Missing one of those families leaves
	 *  the provider's per-form path/name indexes stale. Uses a tuple selector
	 *  with reference equality, so unrelated document/UI changes do not clear
	 *  the cache. */
	const subscribeMutation = useCallback(
		(listener: () => void) => {
			if (!docStore) return () => {};
			return docStore.subscribe(
				(s) =>
					[
						s.fields,
						s.fieldOrder,
						s.modules,
						s.forms,
						s.formOrder,
						s.caseTypes,
						s.userProperties,
					] as const,
				() => listener(),
				{
					equalityFn: (a, b) =>
						a[0] === b[0] &&
						a[1] === b[1] &&
						a[2] === b[2] &&
						a[3] === b[3] &&
						a[4] === b[4] &&
						a[5] === b[5] &&
						a[6] === b[6],
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
