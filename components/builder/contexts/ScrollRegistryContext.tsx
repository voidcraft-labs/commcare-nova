/**
 * ScrollRegistryContext — imperative scroll plumbing for the builder.
 *
 * Owns the "scroll the selected field into view" protocol. All state lives
 * in refs (never triggers React re-renders) because scroll is a DOM-level
 * concern that belongs outside the render path: a registered callback owns
 * the actual DOM scroll, and a pending-request slot bridges "select a
 * field" to "scroll when that field's panel mounts".
 *
 * Three public hooks expose the API to consumers:
 *  - `useRegisterScrollCallback` — BuilderLayout registers the DOM scroll impl
 *  - `useScrollIntoView` — setPending + scrollTo for navigation/edit call sites
 *  - `useFulfillPendingScroll` — consumed by the selected field's mount effect
 */
"use client";

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
} from "react";

// ── Types ──────────────────────────────────────────────────────────────

type ScrollTarget = HTMLElement | undefined;

type ScrollCallback = (
	fieldUuid: string,
	overrideTarget?: ScrollTarget,
	behavior?: ScrollBehavior,
	hasToolbar?: boolean,
) => void;

interface ScrollRegistryApi {
	/** Consumed by BuilderLayout to register the DOM scroll implementation.
	 *  Returns a cleanup function for ref-callback use. */
	registerCallback: (cb: ScrollCallback) => () => void;
	/** Request a pending scroll — fulfilled when a matching field's
	 *  panel mount effect calls `fulfill(uuid)`. */
	setPending: (
		uuid: string,
		behavior: ScrollBehavior,
		hasToolbar: boolean,
	) => void;
	/** Try to consume a pending request. Returns true if fired. */
	fulfillPending: (uuid: string) => boolean;
	/** Scroll immediately (no pending gate) — used by undo/redo where
	 *  flushSync guarantees the DOM is already committed. */
	scrollTo: ScrollCallback;
}

// ── Context ────────────────────────────────────────────────────────────

const ScrollRegistryContext = createContext<ScrollRegistryApi | null>(null);

// ── Provider ───────────────────────────────────────────────────────────

export function ScrollRegistryProvider({ children }: { children: ReactNode }) {
	/* Non-reactive state stored in refs — never triggers re-renders.
	 * This is the whole point of the scroll subsystem: DOM-level imperative
	 * plumbing that belongs outside React's render path. */
	const callbackRef = useRef<ScrollCallback | null>(null);
	const pendingRef = useRef<
		{ uuid: string; behavior: ScrollBehavior; hasToolbar: boolean } | undefined
	>(undefined);

	const api = useMemo<ScrollRegistryApi>(
		() => ({
			registerCallback(cb) {
				callbackRef.current = cb;
				return () => {
					if (callbackRef.current === cb) callbackRef.current = null;
				};
			},
			setPending(uuid, behavior, hasToolbar) {
				pendingRef.current = { uuid, behavior, hasToolbar };
			},
			fulfillPending(uuid) {
				const pending = pendingRef.current;
				if (pending?.uuid !== uuid) return false;
				pendingRef.current = undefined;
				callbackRef.current?.(
					uuid,
					undefined,
					pending.behavior,
					pending.hasToolbar,
				);
				return true;
			},
			scrollTo(uuid, overrideTarget, behavior, hasToolbar) {
				callbackRef.current?.(uuid, overrideTarget, behavior, hasToolbar);
			},
		}),
		[],
	);

	return <ScrollRegistryContext value={api}>{children}</ScrollRegistryContext>;
}

// ── Internal accessor ──────────────────────────────────────────────────

function useScrollRegistry(): ScrollRegistryApi {
	const ctx = useContext(ScrollRegistryContext);
	if (!ctx)
		throw new Error(
			"ScrollRegistry hooks must be used within ScrollRegistryProvider",
		);
	return ctx;
}

// ── Public hooks ───────────────────────────────────────────────────────

/** Ref callback for the scroll implementation owner (BuilderLayout).
 *  Registers the callback via useEffect — the cleanup unregisters it,
 *  aligned with the CLAUDE.md ref-callback cleanup convention. */
export function useRegisterScrollCallback(callback: ScrollCallback): void {
	const { registerCallback } = useScrollRegistry();
	useEffect(() => registerCallback(callback), [registerCallback, callback]);
}

/** Request a scroll that will fire once the target field's panel mounts,
 *  or scroll immediately when the DOM is already committed. */
export function useScrollIntoView(): {
	setPending: ScrollRegistryApi["setPending"];
	scrollTo: ScrollRegistryApi["scrollTo"];
} {
	const { setPending, scrollTo } = useScrollRegistry();
	return useMemo(() => ({ setPending, scrollTo }), [setPending, scrollTo]);
}

/** Consume a pending scroll request when the target field is selected.
 *  Re-fires when `isSelected` transitions false -> true, which is critical
 *  for within-form navigation where the target field is already mounted:
 *  setPending(uuid) -> select(uuid) -> isSelected flips -> effect re-runs
 *  -> fulfillPending matches -> scroll fires. */
export function useFulfillPendingScroll(
	uuid: string,
	isSelected: boolean,
): void {
	const { fulfillPending } = useScrollRegistry();
	useEffect(() => {
		if (isSelected) fulfillPending(uuid);
	}, [isSelected, uuid, fulfillPending]);
}
