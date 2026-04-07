/**
 * Themed tooltip wrapping Base UI's `Tooltip.*` with Nova styling and defaults.
 *
 * The child must be a single React element that accepts a ref — Base UI's
 * `render` prop attaches handlers directly, no wrapper `<span>`.
 *
 * Falsy `content` is a passthrough — the child renders unmodified, so
 * conditional tooltips don't need ternaries at the call site.
 */

"use client";

import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode, RefAttributes } from "react";

type Side = "top" | "bottom" | "left" | "right";

interface TooltipProps {
	/** Tooltip text or rich content. When falsy, the child renders unmodified. */
	content: ReactNode;
	/** Which side of the trigger to place the tooltip. Default: `"top"`. */
	placement?: Side;
	/** Hover delay in ms before the tooltip appears. Default: `400`.
	 *  Overrides the Provider-level delay for this specific trigger. */
	delay?: number;
	/** Tooltip trigger content. Must be a single React element that accepts a
	 *  ref. Interaction handlers are merged non-destructively via Base UI's
	 *  `render` prop — no cloneElement, no wrapper element. */
	children: ReactElement<RefAttributes<HTMLElement>>;
}

export function Tooltip({
	content,
	placement = "top",
	delay = 400,
	children,
}: TooltipProps) {
	/* Passthrough when there's nothing to show — child renders unmodified,
	 * no hooks allocated. Callers can always render <Tooltip content={maybeFalsy}>
	 * without branching. */
	if (!content) return children;

	return (
		<BaseTooltip.Root>
			<BaseTooltip.Trigger delay={delay} render={children} />
			<BaseTooltip.Portal>
				<BaseTooltip.Positioner
					side={placement}
					sideOffset={6}
					collisionPadding={8}
					className="z-tooltip"
				>
					<BaseTooltip.Popup className="max-w-xs px-2.5 py-1.5 rounded-lg bg-[rgba(20,20,44,0.95)] border border-white/[0.08] shadow-[0_4px_12px_rgba(0,0,0,0.4)] text-xs font-medium text-nova-text leading-snug pointer-events-none select-none origin-[var(--transform-origin)] transition-[transform,scale,opacity] duration-100 data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.96] data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.96]">
						{content}
					</BaseTooltip.Popup>
				</BaseTooltip.Positioner>
			</BaseTooltip.Portal>
		</BaseTooltip.Root>
	);
}
