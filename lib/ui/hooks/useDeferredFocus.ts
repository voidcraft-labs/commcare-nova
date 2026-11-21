"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

/** Subscribe while a focus handoff is pending, including while its destination
 * is still mounting. The caller owns the request and removes the listeners. */
export function onNewFocusIntent(cancel: () => void): () => void {
	const origin = document.activeElement;
	const onFocus = (event: FocusEvent) => {
		if (event.target !== origin && event.target !== document.body) cancel();
	};
	document.addEventListener("focusin", onFocus, true);
	document.addEventListener("pointerdown", cancel, true);
	document.addEventListener("keydown", cancel, true);
	return () => {
		document.removeEventListener("focusin", onFocus, true);
		document.removeEventListener("pointerdown", cancel, true);
		document.removeEventListener("keydown", cancel, true);
	};
}

/** A post-commit focus handoff is only a fallback. A newer focus choice or
 * interaction owns the keyboard, even if the scheduled frame has not run yet.
 * The latest handoff wins; effect callers may also return its cancellation. */
export function useDeferredFocus() {
	const pending = useRef<(() => void) | undefined>(undefined);
	const active = useRef(true);
	useLayoutEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
			pending.current?.();
		};
	}, []);

	return useCallback((focus: () => void): (() => void) => {
		pending.current?.();
		if (!active.current) return () => {};
		const cancel = () => {
			cancelAnimationFrame(frame);
			stopWatching();
			if (pending.current === cancel) pending.current = undefined;
		};
		const stopWatching = onNewFocusIntent(cancel);
		const frame = requestAnimationFrame(() => {
			cancel();
			focus();
		});
		pending.current = cancel;
		return cancel;
	}, []);
}
