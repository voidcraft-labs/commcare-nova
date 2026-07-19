"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type * as React from "react";

import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";
import { cn } from "@/lib/utils";

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
	return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
	return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
	return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

function PopoverContent({
	className,
	align = "center",
	alignOffset = 0,
	side = "bottom",
	sideOffset = 4,
	collisionAvoidance,
	collisionPadding,
	...props
}: PopoverPrimitive.Popup.Props &
	Pick<
		PopoverPrimitive.Positioner.Props,
		| "align"
		| "alignOffset"
		| "side"
		| "sideOffset"
		| "collisionAvoidance"
		| "collisionPadding"
	>) {
	return (
		// Portals to document.body (Base UI default) and positions at `z-modal`,
		// co-planar with dialogs. A popover opened from inside a Dialog stacks on
		// top because its portal mounts after the dialog's; a page-level popover is
		// still covered when a dialog opens afterward, by the same portal ordering.
		//
		// Nova chrome: the frosted-glass surface (shared constant from
		// `lib/styles.ts`) lives on the POSITIONER — `will-change: transform`
		// there creates a compositing boundary that would break a descendant
		// `backdrop-filter` — while the popup carries only the animation.
		// The shared glass constant supplies `z-popover` for direct Base UI users.
		// An inline token is intentional here: Tailwind's generated utility order,
		// not class-string order, otherwise lets that shared class beat `z-modal`.
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
				collisionAvoidance={collisionAvoidance}
				collisionPadding={collisionPadding}
				className={cn("isolate", POPOVER_POSITIONER_GLASS_CLS)}
				style={{ zIndex: "var(--z-modal)" }}
			>
				<PopoverPrimitive.Popup
					data-slot="popover-content"
					className={cn(
						POPOVER_POPUP_CLS,
						"flex w-72 max-w-[var(--available-width)] flex-col gap-2.5 overflow-x-hidden p-3 text-sm text-nova-text outline-hidden",
						className,
					)}
					{...props}
				/>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	);
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="popover-header"
			className={cn("flex flex-col gap-0.5 text-sm", className)}
			{...props}
		/>
	);
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
	return (
		<PopoverPrimitive.Title
			data-slot="popover-title"
			className={cn("font-medium", className)}
			{...props}
		/>
	);
}

function PopoverDescription({
	className,
	...props
}: PopoverPrimitive.Description.Props) {
	return (
		<PopoverPrimitive.Description
			data-slot="popover-description"
			className={cn("text-muted-foreground", className)}
			{...props}
		/>
	);
}

export {
	Popover,
	PopoverClose,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
};
