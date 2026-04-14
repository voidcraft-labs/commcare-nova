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
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { ReferenceProviderWrapper } from "@/lib/references/ReferenceContext";
import { useLocation } from "@/lib/routing/hooks";
import {
	assembleBlueprint,
	type NormalizedData,
} from "@/lib/services/normalizedState";

interface BuilderReferenceProviderProps {
	children: React.ReactNode;
}

/** Adapt a BlueprintDoc snapshot to the legacy `NormalizedData` shape that
 *  `assembleBlueprint` expects. The underlying entity shapes are identical;
 *  the cast crosses only the branded-`Uuid` vs plain-`string` key boundary. */
function docToNormalized(s: BlueprintDoc): NormalizedData {
	return {
		appName: s.appName,
		connectType: s.connectType ?? undefined,
		caseTypes: s.caseTypes ?? [],
		modules: s.modules as unknown as NormalizedData["modules"],
		forms: s.forms as unknown as NormalizedData["forms"],
		questions: s.questions as unknown as NormalizedData["questions"],
		moduleOrder: s.moduleOrder as unknown as string[],
		formOrder: s.formOrder as unknown as Record<string, string[]>,
		questionOrder: s.questionOrder as unknown as Record<string, string[]>,
	};
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
		const s = docStore.getState();
		if (s.moduleOrder.length === 0) return undefined;

		const bp = assembleBlueprint(docToNormalized(s));

		/* Resolve the form in scope from the URL. The callback fires at edit
		 * time, so the current location accurately reflects which form the
		 * user is editing. */
		if (loc.kind === "form") {
			/* Resolve module/form indices from UUIDs via the doc's ordering
			 * maps, since assembleBlueprint returns a wire-format BlueprintApp
			 * with index-based modules/forms. The cast narrows branded UUIDs. */
			const moduleIndex = (s.moduleOrder as unknown as string[]).indexOf(
				loc.moduleUuid,
			);
			if (moduleIndex < 0) return undefined;
			const mod = bp.modules[moduleIndex];
			const formIds =
				(s.formOrder as unknown as Record<string, string[]>)[loc.moduleUuid] ??
				[];
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
	}, [docStore, loc]);

	/** Subscribe to entity changes that invalidate the ReferenceProvider cache.
	 *  Covers questions (question references, case_property_on), modules
	 *  (case_type renames), and forms (form type changes affecting case config).
	 *  Uses a tuple selector with reference equality — only fires when at least
	 *  one entity map gets a new Immer reference. */
	const subscribeMutation = useCallback(
		(listener: () => void) => {
			if (!docStore) return () => {};
			return docStore.subscribe(
				(s) => [s.questions, s.modules, s.forms] as const,
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
