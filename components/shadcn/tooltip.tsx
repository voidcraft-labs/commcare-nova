"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
	isValidElement,
	type ReactElement,
	type ReactNode,
	type RefAttributes,
} from "react";

import { cn } from "@/lib/utils";

/**
 * The one tooltip surface in Nova, three layers:
 *
 * - `TooltipProvider` — mounted exactly ONCE, in `(app)/layout.tsx`. It owns
 *   the shared Base UI delay group: once a tooltip opens, adjacent tooltips
 *   open instantly instead of re-waiting the delay. Never mount a second one.
 * - `Tooltip` / `TooltipTrigger` / `TooltipContent` — the compound primitives
 *   (shadcn API) for composed cases like the vendored AI Elements.
 * - `SimpleTooltip` — the everyday wrapper: `content` + child, with falsy
 *   passthrough and disabled-trigger handling built in.
 */

function TooltipProvider({ children }: { children: ReactNode }) {
	return (
		<TooltipPrimitive.Provider delay={400} closeDelay={0} timeout={400}>
			{children}
		</TooltipPrimitive.Provider>
	);
}

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
				 * hairline border and soft shadow.
				 * The default shadcn `bg-foreground`/`text-background` invert would
				 * read as a stark light chip against Nova's dark theme. */}
				<TooltipPrimitive.Popup
					role="tooltip"
					data-slot="tooltip-content"
					className={cn(
						"max-w-xs origin-(--transform-origin) select-none rounded-lg border border-white/[0.08] bg-nova-overlay px-2.5 py-1.5 text-xs font-medium leading-snug text-nova-text shadow-[0_4px_12px_rgba(0,0,0,0.4)] transition-[transform,scale,opacity] duration-100 data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.96] data-[ending-style]:opacity-0",
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

interface SimpleTooltipProps {
	/** Tooltip text or rich content. When falsy, the child renders unmodified. */
	content: ReactNode;
	/** Which side of the trigger to place the tooltip. Default: `"top"`. */
	side?: "top" | "bottom" | "left" | "right";
	/** Hover delay in ms before the tooltip appears. Defaults to the
	 *  provider-level delay; set to override for this trigger only. */
	delay?: number;
	/** Tooltip trigger element. Must accept a ref. For non-disabled elements,
	 *  Base UI's `render` prop attaches handlers directly (no wrapper). Disabled
	 *  elements get a transparent `<div>` wrapper that captures hover events. */
	children: ReactElement<RefAttributes<HTMLElement>>;
}

/**
 * Everyday tooltip — `content` + a single trigger child.
 *
 * Handles disabled children transparently: when the child has
 * `disabled={true}`, it's wrapped in a `<div role="presentation">` so hover
 * events fire regardless of whether the child is a native form element
 * (browser suppresses pointer events) or a Base UI component (render-prop
 * composition doesn't reliably forward tooltip handlers). The presentation
 * role keeps the wrapper invisible to the accessibility tree.
 *
 * Falsy `content` is a passthrough — the child renders unmodified, so
 * conditional tooltips don't need ternaries at the call site.
 */
function SimpleTooltip({
	content,
	side = "top",
	delay,
	children,
}: SimpleTooltipProps) {
	if (!content) return children;

	const isDisabled =
		isValidElement(children) &&
		(children.props as Record<string, unknown>).disabled === true;

	const trigger = isDisabled ? (
		<TooltipTrigger delay={delay} render={<div role="presentation" />}>
			{children}
		</TooltipTrigger>
	) : (
		<TooltipTrigger delay={delay} render={children} />
	);

	return (
		<Tooltip>
			{trigger}
			<TooltipContent side={side}>{content}</TooltipContent>
		</Tooltip>
	);
}

export {
	SimpleTooltip,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
};
