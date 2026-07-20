"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronUp from "@iconify-icons/tabler/chevron-up";
import type * as React from "react";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { cn } from "@/lib/utils";

const Select = SelectPrimitive.Root;

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
	return (
		<SelectPrimitive.Group
			data-slot="select-group"
			className={cn("scroll-my-1", className)}
			{...props}
		/>
	);
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
	return (
		<SelectPrimitive.Value
			data-slot="select-value"
			className={cn("flex flex-1 text-left", className)}
			{...props}
		/>
	);
}

function SelectTrigger({
	className,
	size = "default",
	wrapValue = false,
	children,
	...props
}: SelectPrimitive.Trigger.Props & {
	size?: "sm" | "default";
	/** Allow an authored value to use multiple lines instead of clipping it. */
	wrapValue?: boolean;
}) {
	return (
		<SelectPrimitive.Trigger
			data-slot="select-trigger"
			data-size={size}
			className={cn(
				"flex w-fit justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:flex *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:not-disabled:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				wrapValue
					? "items-start whitespace-normal data-[size=default]:h-auto data-[size=sm]:h-auto *:data-[slot=select-value]:line-clamp-none *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:items-start *:data-[slot=select-value]:break-words *:data-[slot=select-value]:whitespace-normal *:data-[slot=select-value]:[overflow-wrap:anywhere]"
					: "items-center whitespace-nowrap data-[size=default]:h-8 data-[size=sm]:h-7 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:items-center",
				className,
			)}
			{...props}
		>
			{children}
			<SelectPrimitive.Icon
				render={
					<Icon
						icon={tablerChevronDown}
						className="pointer-events-none size-4 text-muted-foreground"
					/>
				}
			/>
		</SelectPrimitive.Trigger>
	);
}

function SelectContent({
	className,
	children,
	side = "bottom",
	sideOffset = 4,
	align = "center",
	alignOffset = 0,
	alignItemWithTrigger = false,
	collisionPadding = 8,
	...props
}: SelectPrimitive.Popup.Props &
	Pick<
		SelectPrimitive.Positioner.Props,
		| "align"
		| "alignOffset"
		| "side"
		| "sideOffset"
		| "alignItemWithTrigger"
		| "collisionPadding"
	>) {
	return (
		// The popup portals to document.body (Base UI's default) — escaping
		// ancestor stacking/overflow is the whole point, so a Select opened from
		// inside a Dialog floats above it with no per-call wiring. The positioner
		// sits at `z-modal`, co-planar with dialogs, and wins by portal order: its
		// portal mounts after the dialog's, so it stacks on top. Do NOT portal this
		// into a dialog panel — a fixed-position popup inside a transformed panel
		// (a centered dialog uses `translate(-50%,-50%)`) anchors to the panel
		// rather than the viewport and lands in the wrong place.
		//
		// Nova chrome: the frosted-glass surface (shared constants from
		// `lib/styles.ts`, same as every menu) lives on the POSITIONER — see the
		// compositing-boundary note there — so `alignItemWithTrigger` defaults
		// OFF: a translucent popup laid OVER its own trigger reads as a smear,
		// and dropping below the trigger is how every other Nova option
		// dropdown opens.
		<SelectPrimitive.Portal>
			<SelectPrimitive.Positioner
				side={side}
				sideOffset={sideOffset}
				align={align}
				alignOffset={alignOffset}
				alignItemWithTrigger={alignItemWithTrigger}
				collisionPadding={collisionPadding}
				className={cn("isolate", MENU_POSITIONER_CLS, "z-modal")}
			>
				<SelectPrimitive.Popup
					data-slot="select-content"
					data-align-trigger={alignItemWithTrigger}
					className={cn(
						MENU_POPUP_CLS,
						"relative max-h-(--available-height) w-(--anchor-width) min-w-[min(9rem,var(--available-width))] max-w-(--available-width) overflow-x-hidden overflow-y-auto data-[align-trigger=true]:animate-none",
						className,
					)}
					{...props}
				>
					<SelectScrollUpButton />
					<SelectPrimitive.List className="p-1">
						{children}
					</SelectPrimitive.List>
					<SelectScrollDownButton />
				</SelectPrimitive.Popup>
			</SelectPrimitive.Positioner>
		</SelectPrimitive.Portal>
	);
}

function SelectLabel({
	className,
	...props
}: SelectPrimitive.GroupLabel.Props) {
	return (
		<SelectPrimitive.GroupLabel
			data-slot="select-label"
			className={cn(
				"px-3 pt-2 pb-1 text-xs font-medium text-nova-text-muted",
				className,
			)}
			{...props}
		/>
	);
}

function SelectItem({
	className,
	children,
	wrap = false,
	...props
}: SelectPrimitive.Item.Props & {
	/** Wrap authored labels, including long values without natural breaks. */
	wrap?: boolean;
}) {
	return (
		<SelectPrimitive.Item
			data-slot="select-item"
			className={cn(
				MENU_ITEM_CLS,
				"relative rounded-lg pr-9 data-disabled:cursor-not-allowed data-disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
				className,
			)}
			{...props}
		>
			<SelectPrimitive.ItemText
				data-slot="select-item-text"
				className={cn(
					"flex flex-1 gap-2",
					wrap
						? "min-w-0 shrink whitespace-normal break-words [overflow-wrap:anywhere]"
						: "shrink-0 whitespace-nowrap",
				)}
			>
				{children}
			</SelectPrimitive.ItemText>
			<SelectPrimitive.ItemIndicator
				render={
					<span
						className={cn(
							"pointer-events-none absolute right-3 flex size-4 items-center justify-center",
							wrap && "top-3",
						)}
					/>
				}
			>
				<Icon icon={tablerCheck} className="pointer-events-none" />
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
}

function SelectSeparator({
	className,
	...props
}: SelectPrimitive.Separator.Props) {
	return (
		<SelectPrimitive.Separator
			data-slot="select-separator"
			className={cn(
				"pointer-events-none mx-2 my-1 h-px bg-white/[0.06]",
				className,
			)}
			{...props}
		/>
	);
}

function SelectScrollUpButton({
	className,
	...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
	return (
		<SelectPrimitive.ScrollUpArrow
			data-slot="select-scroll-up-button"
			className={cn(
				"top-0 z-10 flex w-full cursor-default items-center justify-center bg-[rgba(10,10,26,0.85)] py-1 text-nova-text-muted [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		>
			<Icon icon={tablerChevronUp} />
		</SelectPrimitive.ScrollUpArrow>
	);
}

function SelectScrollDownButton({
	className,
	...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
	return (
		<SelectPrimitive.ScrollDownArrow
			data-slot="select-scroll-down-button"
			className={cn(
				"bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-[rgba(10,10,26,0.85)] py-1 text-nova-text-muted [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		>
			<Icon icon={tablerChevronDown} />
		</SelectPrimitive.ScrollDownArrow>
	);
}

export {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectScrollDownButton,
	SelectScrollUpButton,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
};
