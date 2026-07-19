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
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/shadcn/popover";

/**
 * The glyph stays visually quiet inside a full 44px target. Callers cannot
 * shrink the hit area to make a tight layout work; the host must leave enough
 * room for the same accessible control used everywhere else in the builder.
 * `ariaLabel` names the affordance for screen readers.
 */
export function InfoPopover({
	title,
	ariaLabel,
	children,
}: {
	title: string;
	ariaLabel: string;
	children: ReactNode;
}) {
	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="size-11 shrink-0 rounded-full text-nova-text-muted not-disabled:hover:text-nova-text"
					/>
				}
				aria-label={ariaLabel}
			>
				<Icon icon={tablerInfoCircle} className="size-4" />
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
