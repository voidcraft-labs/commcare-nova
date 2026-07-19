"use client";

import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { useMergedRefs } from "@base-ui/utils/useMergedRefs";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerX from "@iconify-icons/tabler/x";
import type * as React from "react";
import { useRef } from "react";
import { Button } from "@/components/shadcn/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/components/shadcn/input-group";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";
import { cn } from "@/lib/utils";

const Combobox = ComboboxPrimitive.Root;

function ComboboxValue({ ...props }: ComboboxPrimitive.Value.Props) {
	return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />;
}

function ComboboxTrigger({
	className,
	children,
	...props
}: ComboboxPrimitive.Trigger.Props) {
	return (
		<ComboboxPrimitive.Trigger
			data-slot="combobox-trigger"
			className={cn("[&_svg:not([class*='size-'])]:size-4", className)}
			{...props}
		>
			{children}
			<Icon
				icon={tablerChevronDown}
				width="16"
				height="16"
				className="pointer-events-none shrink-0 text-nova-text-muted"
			/>
		</ComboboxPrimitive.Trigger>
	);
}

function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props) {
	return (
		<ComboboxPrimitive.Clear
			data-slot="combobox-clear"
			render={<InputGroupButton variant="ghost" size="icon-lg" />}
			className={cn(className)}
			{...props}
		>
			<Icon
				icon={tablerX}
				width="16"
				height="16"
				className="pointer-events-none"
			/>
		</ComboboxPrimitive.Clear>
	);
}

function ComboboxInput({
	ref,
	className,
	children,
	disabled = false,
	showTrigger = true,
	showClear = false,
	clearLabel = "Clear",
	onClear,
	startAdornment,
	...props
}: React.ComponentPropsWithRef<typeof ComboboxPrimitive.Input> & {
	showTrigger?: boolean;
	showClear?: boolean;
	clearLabel?: string;
	onClear?: () => void;
	startAdornment?: React.ReactNode;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const mergedRef = useMergedRefs(inputRef, ref);
	return (
		<InputGroup
			className={cn(
				"min-h-11 w-auto rounded-lg border-white/[0.08] bg-nova-deep/55",
				className,
			)}
		>
			{startAdornment !== undefined && (
				<InputGroupAddon align="inline-start">{startAdornment}</InputGroupAddon>
			)}
			<ComboboxPrimitive.Input
				ref={mergedRef}
				render={<InputGroupInput disabled={disabled} />}
				{...props}
			/>
			<InputGroupAddon
				align="inline-end"
				className="h-full p-0 has-[>button]:mr-0"
			>
				{showTrigger && (
					<InputGroupButton
						size="icon-lg"
						variant="ghost"
						render={<ComboboxTrigger />}
						data-slot="input-group-button"
						className="group-has-data-[slot=combobox-clear]/input-group:hidden data-pressed:bg-transparent"
						disabled={disabled}
					/>
				)}
				{showClear &&
					(onClear === undefined ? (
						<ComboboxClear
							aria-label={clearLabel}
							disabled={disabled}
							onClick={() => {
								requestAnimationFrame(() => inputRef.current?.focus());
							}}
						/>
					) : (
						<InputGroupButton
							aria-label={clearLabel}
							variant="ghost"
							size="icon-lg"
							disabled={disabled}
							onClick={() => {
								onClear();
								inputRef.current?.focus();
							}}
						>
							<Icon
								icon={tablerX}
								width="16"
								height="16"
								className="pointer-events-none"
							/>
						</InputGroupButton>
					))}
			</InputGroupAddon>
			{children}
		</InputGroup>
	);
}

function ComboboxContent({
	className,
	side = "bottom",
	sideOffset = 6,
	align = "start",
	alignOffset = 0,
	anchor,
	...props
}: ComboboxPrimitive.Popup.Props &
	Pick<
		ComboboxPrimitive.Positioner.Props,
		"side" | "align" | "sideOffset" | "alignOffset" | "anchor"
	>) {
	return (
		<ComboboxPrimitive.Portal>
			<ComboboxPrimitive.Positioner
				side={side}
				sideOffset={sideOffset}
				align={align}
				alignOffset={alignOffset}
				anchor={anchor}
				className={cn("isolate", POPOVER_POSITIONER_GLASS_CLS)}
				style={{ zIndex: "var(--z-modal)" }}
			>
				<ComboboxPrimitive.Popup
					data-slot="combobox-content"
					data-chips={!!anchor}
					className={cn(
						POPOVER_POPUP_CLS,
						"group/combobox-content relative flex max-h-[min(22rem,var(--available-height))] w-[var(--anchor-width)] min-w-[min(18rem,var(--available-width))] max-w-[var(--available-width)] origin-[var(--transform-origin)] flex-col overflow-hidden p-0 text-nova-text outline-none *:data-[slot=input-group]:m-2 *:data-[slot=input-group]:mb-0 *:data-[slot=input-group]:shrink-0 data-[chips=true]:min-w-[var(--anchor-width)]",
						className,
					)}
					{...props}
				/>
			</ComboboxPrimitive.Positioner>
		</ComboboxPrimitive.Portal>
	);
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
	return (
		<ComboboxPrimitive.List
			data-slot="combobox-list"
			className={cn(
				"min-h-0 flex-1 scroll-py-1 overflow-y-auto overscroll-contain p-1 data-empty:p-0",
				className,
			)}
			{...props}
		/>
	);
}

function ComboboxItem({
	className,
	children,
	...props
}: ComboboxPrimitive.Item.Props) {
	return (
		<ComboboxPrimitive.Item
			data-slot="combobox-item"
			className={cn(
				"relative flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-lg py-2.5 pr-9 pl-3 text-sm leading-5 text-nova-text outline-hidden select-none data-highlighted:bg-white/[0.07] data-disabled:cursor-not-allowed data-disabled:opacity-40",
				className,
			)}
			{...props}
		>
			{children}
			<ComboboxPrimitive.ItemIndicator
				render={
					<span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
				}
			>
				<Icon
					icon={tablerCheck}
					width="16"
					height="16"
					className="pointer-events-none"
				/>
			</ComboboxPrimitive.ItemIndicator>
		</ComboboxPrimitive.Item>
	);
}

function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
	return (
		<ComboboxPrimitive.Group
			data-slot="combobox-group"
			className={cn(className)}
			{...props}
		/>
	);
}

function ComboboxLabel({
	className,
	...props
}: ComboboxPrimitive.GroupLabel.Props) {
	return (
		<ComboboxPrimitive.GroupLabel
			data-slot="combobox-label"
			className={cn(
				"px-3 pb-1 pt-2.5 text-xs font-semibold leading-5 text-nova-text-muted",
				className,
			)}
			{...props}
		/>
	);
}

function ComboboxCollection({ ...props }: ComboboxPrimitive.Collection.Props) {
	return (
		<ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />
	);
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
	return (
		<ComboboxPrimitive.Empty
			data-slot="combobox-empty"
			className={cn(
				"grid min-h-28 w-full place-items-center px-4 py-5 text-center text-sm leading-relaxed text-nova-text-muted empty:h-0 empty:min-h-0 empty:p-0",
				className,
			)}
			{...props}
		/>
	);
}

function ComboboxSeparator({
	className,
	...props
}: ComboboxPrimitive.Separator.Props) {
	return (
		<ComboboxPrimitive.Separator
			data-slot="combobox-separator"
			className={cn("mx-2 my-1 h-px bg-white/[0.06]", className)}
			{...props}
		/>
	);
}

function ComboboxChips({
	className,
	...props
}: React.ComponentPropsWithRef<typeof ComboboxPrimitive.Chips> &
	ComboboxPrimitive.Chips.Props) {
	return (
		<ComboboxPrimitive.Chips
			data-slot="combobox-chips"
			className={cn(
				"flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent bg-clip-padding px-2.5 py-1 text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 has-aria-invalid:border-destructive has-aria-invalid:ring-3 has-aria-invalid:ring-destructive/20 has-data-[slot=combobox-chip]:px-1 dark:bg-input/30 dark:has-aria-invalid:border-destructive/50 dark:has-aria-invalid:ring-destructive/40",
				className,
			)}
			{...props}
		/>
	);
}

function ComboboxChip({
	className,
	children,
	showRemove = true,
	...props
}: ComboboxPrimitive.Chip.Props & {
	showRemove?: boolean;
}) {
	return (
		<ComboboxPrimitive.Chip
			data-slot="combobox-chip"
			className={cn(
				"flex h-[calc(--spacing(5.25))] w-fit items-center justify-center gap-1 rounded-sm bg-muted px-1.5 text-xs font-medium whitespace-nowrap text-foreground has-disabled:pointer-events-none has-disabled:cursor-not-allowed has-disabled:opacity-50 has-data-[slot=combobox-chip-remove]:pr-0",
				className,
			)}
			{...props}
		>
			{children}
			{showRemove && (
				<ComboboxPrimitive.ChipRemove
					render={<Button variant="ghost" size="icon-xs" />}
					className="-ml-1 opacity-50 hover:opacity-100"
					data-slot="combobox-chip-remove"
				>
					<Icon
						icon={tablerX}
						width="14"
						height="14"
						className="pointer-events-none"
					/>
				</ComboboxPrimitive.ChipRemove>
			)}
		</ComboboxPrimitive.Chip>
	);
}

function ComboboxChipsInput({
	className,
	...props
}: ComboboxPrimitive.Input.Props) {
	return (
		<ComboboxPrimitive.Input
			data-slot="combobox-chip-input"
			className={cn("min-w-16 flex-1 outline-none", className)}
			{...props}
		/>
	);
}

function useComboboxAnchor() {
	return useRef<HTMLDivElement | null>(null);
}

export {
	Combobox,
	ComboboxChip,
	ComboboxChips,
	ComboboxChipsInput,
	ComboboxCollection,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxGroup,
	ComboboxInput,
	ComboboxItem,
	ComboboxLabel,
	ComboboxList,
	ComboboxSeparator,
	ComboboxTrigger,
	ComboboxValue,
	useComboboxAnchor,
};
