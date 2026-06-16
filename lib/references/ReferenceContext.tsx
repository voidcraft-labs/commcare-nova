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
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
} from "react";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import { ReferenceProvider } from "./provider";

const ReferenceCtx = createContext<ReferenceProvider | null>(null);

/** The form the user is currently editing, if any. Lets in-editor chip surfaces
 *  resolve refs against the active form without threading the uuid through every
 *  component. `undefined` off a form (or outside the wrapper). */
const CurrentFormUuidCtx = createContext<string | undefined>(undefined);

interface ReferenceProviderWrapperProps {
	/** Resolve the lint context for a given form uuid (blueprint + form +
	 *  reachable case types). The provider calls this with whatever form a ref
	 *  is being resolved against — the active form for in-editor surfaces, each
	 *  field's owning form for the sidebar. */
	getContextForForm: (formUuid: string) => XPathLintContext | undefined;
	/** The form currently being edited, exposed via `useCurrentFormUuid`. */
	currentFormUuid: string | undefined;
	/** Subscribe to external mutations that invalidate cached data.
	 *  Follows the useSyncExternalStore contract: subscribe(listener) → unsubscribe.
	 *  Fires when field entities change — not on UI state changes. */
	subscribeMutation: (listener: () => void) => () => void;
	children: React.ReactNode;
}

/**
 * Provides a ReferenceProvider to the subtree. The provider instance is stable
 * across re-renders. Cache invalidation is driven by explicit mutation events
 * from the builder — not by React render cycles or function identity changes.
 */
export function ReferenceProviderWrapper({
	getContextForForm,
	currentFormUuid,
	subscribeMutation,
	children,
}: ReferenceProviderWrapperProps) {
	const getContextRef = useRef(getContextForForm);
	getContextRef.current = getContextForForm;

	const provider = useMemo(
		() => new ReferenceProvider((formUuid) => getContextRef.current(formUuid)),
		[],
	);

	/* Subscribe to mutation events and invalidate caches. The subscription fires
     only when the blueprint is mutated, replaced, or the active form changes —
     exactly when cached field/case data may be stale. */
	useEffect(
		() => subscribeMutation(() => provider.invalidate()),
		[subscribeMutation, provider],
	);

	return (
		<ReferenceCtx.Provider value={provider}>
			<CurrentFormUuidCtx.Provider value={currentFormUuid}>
				{children}
			</CurrentFormUuidCtx.Provider>
		</ReferenceCtx.Provider>
	);
}

/**
 * Override the current-form scope for a subtree, keeping the ambient
 * `ReferenceProvider`. The provider resolves refs for ANY form, so a surface
 * that edits several forms at once (the app-wide Connect manager) wraps each
 * form's editor in its own scope for correct chip resolution / lint —
 * `currentFormUuid` is per URL otherwise (`undefined` off a form route).
 */
export function CurrentFormScope({
	formUuid,
	children,
}: {
	formUuid: string;
	children: React.ReactNode;
}) {
	return (
		<CurrentFormUuidCtx.Provider value={formUuid}>
			{children}
		</CurrentFormUuidCtx.Provider>
	);
}

/** Access the nearest ReferenceProvider. Returns null if outside a wrapper. */
export function useReferenceProvider(): ReferenceProvider | null {
	return useContext(ReferenceCtx);
}

/** The form currently being edited, for in-editor chip resolution. `undefined`
 *  when not on a form or outside a `ReferenceProviderWrapper`. */
export function useCurrentFormUuid(): string | undefined {
	return useContext(CurrentFormUuidCtx);
}

/** A stable getter that always reads the live current-form uuid. For TipTap
 *  suggestion configs that are memoized once but must resolve against whatever
 *  form is active at call time — the getter identity never changes, so the
 *  config doesn't re-create on navigation. */
export function useLiveFormUuidGetter(): () => string | undefined {
	const currentFormUuid = useCurrentFormUuid();
	const ref = useRef(currentFormUuid);
	ref.current = currentFormUuid;
	return useCallback(() => ref.current, []);
}
