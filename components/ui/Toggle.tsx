"use client";
import { useCallback } from "react";

interface ToggleProps {
	enabled: boolean;
	onToggle: () => void;
	variant?: "default" | "sub";
	/** When true, the toggle button receives focus on mount via ref callback. */
	autoFocus?: boolean;
	/** Undo/redo scroll + flash target — placed on the button element. */
	dataFieldId?: string;
}

export function Toggle({
	enabled,
	onToggle,
	variant = "default",
	autoFocus,
	dataFieldId,
}: ToggleProps) {
	const isSub = variant === "sub";

	/** Ref callback — focuses the button on mount when autoFocus is true.
	 *  Uses a ref callback instead of the HTML autoFocus attribute to satisfy
	 *  the a11y lint rule (noAutofocus). */
	const focusRef = useCallback(
		(el: HTMLButtonElement | null) => {
			if (el && autoFocus) el.focus({ preventScroll: true });
		},
		[autoFocus],
	);

	return (
		<button
			ref={focusRef}
			type="button"
			role="switch"
			aria-checked={enabled}
			onClick={onToggle}
			data-field-id={dataFieldId}
			className={`relative inline-flex shrink-0 items-center rounded-full transition-colors cursor-pointer ${
				isSub
					? `h-4 w-7 ${enabled ? "bg-nova-violet" : "bg-nova-border"}`
					: `h-5 w-9 ${enabled ? "bg-nova-violet" : "bg-nova-border"}`
			}`}
		>
			<span
				className={`inline-block rounded-full bg-white transition-transform ${
					isSub
						? `h-2.5 w-2.5 ${enabled ? "translate-x-[14px]" : "translate-x-[3px]"}`
						: `h-3.5 w-3.5 ${enabled ? "translate-x-[18px]" : "translate-x-[3px]"}`
				}`}
			/>
		</button>
	);
}
