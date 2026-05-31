"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "@/lib/utils";

/**
 * Compound tooltip primitives (`Tooltip` / `TooltipTrigger` / `TooltipContent`)
 * used by the vendored AI Elements (prompt-input's icon buttons).
 *
 * There is intentionally NO `TooltipProvider` here. Nova mounts exactly one
 * provider app-wide — `components/ui/TooltipProvider` in `(app)/layout.tsx` —
 * which configures the shared Base UI delay group. Both this file and that
 * provider speak the same `@base-ui/react/tooltip` primitive, so these roots
 * attach to the app provider automatically. Exporting a second provider here
 * would invite a duplicate mount and a desynced delay group.
 */

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
	return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
	return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
	className,
	side = "top",
	sideOffset = 6,
	align = "center",
	alignOffset = 0,
	children,
	...props
}: TooltipPrimitive.Popup.Props &
	Pick<
		TooltipPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset"
	>) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
				collisionPadding={8}
				className="z-tooltip"
			>
				{/* Nova chrome: near-opaque deep-violet glass surface with the violet
				 * hairline border and soft shadow, matching `components/ui/Tooltip`.
				 * The default shadcn `bg-foreground`/`text-background` invert would
				 * read as a stark light chip against Nova's dark theme. */}
				<TooltipPrimitive.Popup
					data-slot="tooltip-content"
					className={cn(
						"max-w-xs origin-(--transform-origin) select-none rounded-lg border border-white/[0.08] bg-[rgba(20,20,44,0.95)] px-2.5 py-1.5 text-xs font-medium leading-snug text-nova-text shadow-[0_4px_12px_rgba(0,0,0,0.4)] transition-[transform,scale,opacity] duration-100 data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.96] data-[ending-style]:opacity-0",
						className,
					)}
					{...props}
				>
					{children}
				</TooltipPrimitive.Popup>
			</TooltipPrimitive.Positioner>
		</TooltipPrimitive.Portal>
	);
}

export { Tooltip, TooltipContent, TooltipTrigger };
