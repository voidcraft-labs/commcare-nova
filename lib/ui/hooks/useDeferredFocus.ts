"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

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
		const origin = document.activeElement;
		const cancel = () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("focusin", onFocus, true);
			document.removeEventListener("pointerdown", cancel, true);
			document.removeEventListener("keydown", cancel, true);
			if (pending.current === cancel) pending.current = undefined;
		};
		const onFocus = (event: FocusEvent) => {
			if (event.target !== origin && event.target !== document.body) cancel();
		};
		const frame = requestAnimationFrame(() => {
			cancel();
			focus();
		});
		pending.current = cancel;
		document.addEventListener("focusin", onFocus, true);
		document.addEventListener("pointerdown", cancel, true);
		document.addEventListener("keydown", cancel, true);
		return cancel;
	}, []);
}
