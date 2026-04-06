/**
 * React context providing a ReferenceProvider to the component tree.
 *
 * Wraps the provider so both CodeMirror and TipTap surfaces can access
 * reference search/resolution without prop drilling. The provider reads
 * from the live blueprint via the same getContext getter pattern used by
 * the XPath linter and autocomplete. Cache is invalidated via an explicit
 * mutation subscription — not React render cycles.
 */

"use client";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import { ReferenceProvider } from "./provider";

const ReferenceCtx = createContext<ReferenceProvider | null>(null);

interface ReferenceProviderWrapperProps {
	/** Getter returning the current lint context (blueprint + form + moduleCaseType). */
	getContext: () => XPathLintContext | undefined;
	/** Subscribe to external mutations that invalidate cached data.
	 *  Follows the useSyncExternalStore contract: subscribe(listener) → unsubscribe.
	 *  Fires when question entities change — not on UI state changes. */
	subscribeMutation: (listener: () => void) => () => void;
	children: React.ReactNode;
}

/**
 * Provides a ReferenceProvider to the subtree. The provider instance is stable
 * across re-renders. Cache invalidation is driven by explicit mutation events
 * from the builder — not by React render cycles or function identity changes.
 */
export function ReferenceProviderWrapper({
	getContext,
	subscribeMutation,
	children,
}: ReferenceProviderWrapperProps) {
	const getContextRef = useRef(getContext);
	getContextRef.current = getContext;

	const provider = useMemo(
		() => new ReferenceProvider(() => getContextRef.current()),
		[],
	);

	/* Subscribe to mutation events and invalidate caches. The subscription fires
     only when the blueprint is mutated, replaced, or the active form changes —
     exactly when cached question/case data may be stale. */
	useEffect(
		() => subscribeMutation(() => provider.invalidate()),
		[subscribeMutation, provider],
	);

	return (
		<ReferenceCtx.Provider value={provider}>{children}</ReferenceCtx.Provider>
	);
}

/** Access the nearest ReferenceProvider. Returns null if outside a wrapper. */
export function useReferenceProvider(): ReferenceProvider | null {
	return useContext(ReferenceCtx);
}
