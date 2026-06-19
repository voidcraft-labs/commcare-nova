// components/builder/InfoPopover.tsx
//
// A small "info" affordance shared across the builder: an info-circle trigger
// that opens a popover with a title + body. Keeps the trigger styling and the
// `w-80` content box in ONE place so every info popover reads and behaves the
// same (and a theme tweak reaches all of them).

"use client";

import { Icon } from "@iconify/react/offline";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import type { ReactNode } from "react";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { cn } from "@/lib/utils";

/**
 * `className` sizes the trigger (the icon fills it via `size-full`), so callers
 * can shrink it to fit a tight host — e.g. `size-3` to sit inside a Badge
 * without widening it. Defaults to `size-4`. `ariaLabel` names the affordance
 * for screen readers (e.g. "Why won't my logo appear?").
 */
export function InfoPopover({
	title,
	ariaLabel,
	className,
	children,
}: {
	title: string;
	ariaLabel: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<Popover>
			<PopoverTrigger
				className={cn(
					"inline-flex size-4 items-center justify-center rounded-full text-nova-text-muted transition-colors hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright",
					className,
				)}
				aria-label={ariaLabel}
			>
				<Icon icon={tablerInfoCircle} className="size-full" />
			</PopoverTrigger>
			<PopoverContent className="w-80">
				<PopoverHeader>
					<PopoverTitle>{title}</PopoverTitle>
				</PopoverHeader>
				<PopoverDescription>{children}</PopoverDescription>
			</PopoverContent>
		</Popover>
	);
}
