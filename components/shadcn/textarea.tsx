import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Multi-line sibling of the Input: the same violet-wash fill, bright
 * border, hover lift, and focus ring, growing with its content from a
 * 44px-friendly floor. Inside an InputGroup the group supplies the
 * chrome and the field goes transparent (the group's own classes win).
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				"flex field-sizing-content min-h-16 w-full rounded-lg border border-nova-border bg-nova-violet/[0.09] px-3.5 py-2.5 text-[15px] transition-colors outline-none",
				"not-disabled:not-focus-visible:hover:border-nova-border-bright not-disabled:not-focus-visible:hover:bg-nova-violet/[0.14] placeholder:text-nova-text-muted",
				"nova-focusable",
				"disabled:cursor-not-allowed disabled:select-none disabled:opacity-(--disabled-opacity)",
				"aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
				className,
			)}
			{...props}
		/>
	);
}

export { Textarea };
