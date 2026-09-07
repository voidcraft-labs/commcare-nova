// ── Types ──────────────────────────────────────────────────────────────

type ScrollTarget = HTMLElement | undefined;

type ScrollCallback = (
	fieldUuid: string,
	/** Optional element to bring into view instead of the field row. It MUST
	 *  live inside the canvas scroll container (`[data-preview-scroll-container]`):
	 * the scroll offset is measured against that container, so an element
	 *  from another container (e.g. the rail inspector) would jump the canvas
	 *  to a bogus position. No production caller passes one today; the field
	 *  row is the right target for undo/redo and selection scrolls. */
	overrideTarget?: ScrollTarget,
	behavior?: ScrollBehavior,
	hasToolbar?: boolean,
) => void;

export interface ScrollRegistryApi {
	/** Consumed by BuilderLayout to register the DOM scroll implementation.
	 *  Returns a cleanup function for ref-callback use. */
	registerCallback: (cb: ScrollCallback) => () => void;
	/** Request a pending scroll: fulfilled when a matching field's
	 *  panel mount effect calls `fulfill(uuid)`. */
	setPending: (
		uuid: string,
		behavior: ScrollBehavior,
		hasToolbar: boolean,
	) => void;
	/** Try to consume a pending request. Returns true if fired. */
	fulfillPending: (uuid: string) => boolean;
	/** Scroll immediately (no pending gate): used by undo/redo where
	 *  flushSync guarantees the DOM is already committed. */
	scrollTo: ScrollCallback;
}

export function createScrollRegistry(): ScrollRegistryApi {
	/* Non-reactive state stored in refs: never triggers re-renders.
	 * This is the whole point of the scroll subsystem: DOM-level imperative
	 * plumbing that belongs outside React's render path. */
	const callbackRef: { current: ScrollCallback | null } = { current: null };
	const pendingRef: {
		current:
			| { uuid: string; behavior: ScrollBehavior; hasToolbar: boolean }
			| undefined;
	} = { current: undefined };

	return {
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
	};
}
