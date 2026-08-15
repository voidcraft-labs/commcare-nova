import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Text input at the one 44px control height (button = input = toggle).
 * Faint violet wash fill on the violet-tinted border; focus brings the
 * violet-bright border plus the soft 3px ring. No hover state: the text
 * cursor is the affordance for a text field (a hover restyle is reserved
 * for reveal-on-hover label editors, which carry their own). Disabled
 * dims to the one 0.6 opacity, keeps pointer events so the not-allowed
 * cursor can show, and drops out of text selection so a sweep from
 * surrounding content can't paint a highlight across its placeholder.
 */
function Input({
	className,
	type,
	focusRing = true,
	...props
}: React.ComponentProps<"input"> & { focusRing?: boolean }) {
	return (
		<InputPrimitive
			type={type}
			data-slot="input"
			className={cn(
				"h-11 w-full min-w-0 rounded-lg border border-nova-border bg-nova-violet/[0.09] px-3.5 py-1 text-[15px] transition-colors outline-none",
				"file:inline-flex file:h-8 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-nova-text-muted",
				focusRing && "nova-focusable",
				"disabled:cursor-not-allowed disabled:select-none disabled:opacity-(--disabled-opacity)",
				"aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
