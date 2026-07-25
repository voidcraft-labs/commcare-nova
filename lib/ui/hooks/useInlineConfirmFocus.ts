/**
 * Focus choreography for an inline confirmation that REPLACES its trigger.
 *
 * The builder's destructive actions confirm in place rather than in a
 * dialog: pressing "Remove X" swaps the button for a panel asking whether
 * you meant it. That swap unmounts the trigger, so without help focus falls
 * to the document body — a keyboard or screen-reader user is silently
 * returned to the top of the page while a destructive question sits on
 * screen they never heard. The bug looks fine at every individual site,
 * which is exactly why it needs one home.
 *
 * The panel takes focus when it opens (announcing its own question) and
 * hands focus back to the trigger when it closes, which is the only moment
 * the trigger remounts.
 *
 * Give the panel `tabIndex={-1}` so it can receive focus, and pair it with
 * `outline-none` — the panel is a focus DESTINATION, not an interactive
 * control, so a focus ring on it would suggest it does something when
 * activated. The controls inside keep their own visible focus.
 *
 *   const [confirming, setConfirming] = useState(false);
 *   const { triggerRef, panelRef } = useInlineConfirmFocus(confirming);
 *
 *   if (!confirming) {
 *     return <Button ref={triggerRef} onClick={() => setConfirming(true)}>…</Button>;
 *   }
 *   return <div ref={panelRef} tabIndex={-1} className="… outline-none">…</div>;
 *
 * A confirmation that opens a real dialog does NOT need this — Base UI's
 * dialog primitives own focus entry and return themselves.
 */
"use client";

import { useEffect, useRef } from "react";

export function useInlineConfirmFocus(open: boolean) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	/* Only hand focus BACK if this hook is the reason it moved. Without the
	 * latch, the first render of a closed confirmation would steal focus to
	 * a trigger the person never touched. */
	const wasOpen = useRef(false);

	useEffect(() => {
		if (open) {
			wasOpen.current = true;
			panelRef.current?.focus();
		} else if (wasOpen.current) {
			wasOpen.current = false;
			triggerRef.current?.focus();
		}
	}, [open]);

	return { triggerRef, panelRef };
}
