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

import { useCallback } from "react";
import { useBuilderEngine } from "@/hooks/useBuilder";
import { ReferenceProviderWrapper } from "@/lib/references/ReferenceContext";
import { useLocation } from "@/lib/routing/hooks";
import {
	assembleBlueprint,
	getEntityData,
} from "@/lib/services/normalizedState";

interface BuilderReferenceProviderProps {
	children: React.ReactNode;
}

export function BuilderReferenceProvider({
	children,
}: BuilderReferenceProviderProps) {
	const builder = useBuilderEngine();
	const loc = useLocation();

	/** Build the `XPathLintContext` for whatever form the URL says the user
	 *  is editing. Called by `ReferenceProvider` at edit time — reads the
	 *  engine's store imperatively so we don't subscribe to blueprint state
	 *  here (cache invalidation is driven by `subscribeMutation` below). */
	const getRefContext = useCallback(() => {
		const s = builder.store.getState();
		if (s.moduleOrder.length === 0) return undefined;

		const bp = assembleBlueprint(getEntityData(s));

		/* Resolve the form in scope from the URL. The callback fires at edit
		 * time, so the current location accurately reflects which form the
		 * user is editing. */
		if (loc.kind === "form") {
			/* Resolve module/form indices from UUIDs via the legacy mirror,
			 * since assembleBlueprint returns a wire-format BlueprintApp with
			 * index-based modules/forms. */
			const moduleIndex = s.moduleOrder.indexOf(loc.moduleUuid);
			if (moduleIndex < 0) return undefined;
			const mod = bp.modules[moduleIndex];
			const formIds = s.formOrder[loc.moduleUuid] ?? [];
			const formIndex = formIds.indexOf(loc.formUuid);
			if (formIndex < 0) return undefined;
			const form = mod?.forms[formIndex];
			if (!form) return undefined;
			return {
				blueprint: bp,
				form,
				moduleCaseType: mod?.case_type ?? undefined,
			};
		}

		return undefined;
	}, [builder, loc]);

	/** Subscribe to entity changes that invalidate the ReferenceProvider cache.
	 *  Covers questions (question references, case_property_on), modules
	 *  (case_type renames), and forms (form type changes affecting case config).
	 *  Uses a tuple selector with reference equality — only fires when at least
	 *  one entity map gets a new Immer reference. */
	const subscribeMutation = useCallback(
		(listener: () => void) =>
			builder.store.subscribe(
				(s) => [s.questions, s.modules, s.forms] as const,
				() => listener(),
				{
					equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2],
				},
			),
		[builder],
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
