"use client";

import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/tiptap-utils";
import "@/components/tiptap-ui-primitive/popover/popover.scss";

function Popover({
	...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
	return <PopoverPrimitive.Root {...props} />;
}

function PopoverTrigger({
	...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
	return <PopoverPrimitive.Trigger {...props} />;
}

function PopoverContent({
	className,
	align = "center",
	sideOffset = 4,
	...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Content
				align={align}
				sideOffset={sideOffset}
				className={cn("tiptap-popover", className)}
				{...props}
			/>
		</PopoverPrimitive.Portal>
	);
}

/**
 * PopoverContent variant for use inside InlineTextEditor's toolbar.
 *
 * Adds two workarounds for the portal-in-toolbar interaction:
 * - `data-inline-toolbar` prevents the editor's blur handler from triggering
 *   a save when focus moves into this portaled popover.
 * - `onMouseDown stopPropagation` prevents the LabelToolbar's blanket
 *   `preventDefault` from blocking focus on inputs inside the popover.
 *   (React portal events bubble through the React tree, not the DOM tree.)
 */
function ToolbarPopoverContent(
	props: React.ComponentProps<typeof PopoverPrimitive.Content>,
) {
	return (
		<PopoverContent
			data-inline-toolbar
			onMouseDown={(e) => e.stopPropagation()}
			{...props}
		/>
	);
}

export { Popover, PopoverTrigger, PopoverContent, ToolbarPopoverContent };
