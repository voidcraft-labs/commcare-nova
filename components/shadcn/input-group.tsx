"use client";

import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { Textarea } from "@/components/shadcn/textarea";
import { cn } from "@/lib/utils";

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
	return (
		// No `role="group"`: the group here is a layout shell around a single
		// textarea, not a semantic grouping of related form controls. The ARIA
		// `group` role would promise the latter to assistive tech and force the
		// non-semantic `<fieldset>` swap (with its border/min-width baggage) to
		// satisfy biome's `useSemanticElements`. A plain styling `<div>` is the
		// honest shape.
		// The disabled-dim (bg + opacity-(--disabled-opacity)) is scoped to the input *control*
		// being disabled, not shadcn's default `has-disabled:` (`:has(:disabled)`).
		// A composer commonly disables only its send button (e.g. empty input),
		// and `:has(:disabled)` would then drop the whole group, placeholder and
		// counter included: to 50% opacity, failing contrast in the resting state.
		<div
			data-slot="input-group"
			className={cn(
				"nova-focusable-within group/input-group relative flex h-11 w-full min-w-0 items-center rounded-lg border border-input transition-colors outline-none in-data-[slot=combobox-content]: in-data-[slot=combobox-content]: has-[[data-slot=input-group-control]:disabled]:bg-input/50 has-[[data-slot=input-group-control]:disabled]:opacity-(--disabled-opacity) has-[[data-slot=input-group-control]:focus-visible]:border-nova-ring has-[[data-slot=input-group-control]:focus-visible]:shadow-(--focus-ring) has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot][aria-invalid=true]]:ring-3 has-[[data-slot][aria-invalid=true]]:ring-destructive/20 has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>textarea]:h-auto dark:bg-input/30 dark:has-[[data-slot=input-group-control]:disabled]:bg-input/80 dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40 has-[>[data-align=block-end]]:[&>input]:pt-3 has-[>[data-align=block-start]]:[&>input]:pb-3 has-[>[data-align=inline-end]]:[&>input]:pr-1.5 has-[>[data-align=inline-start]]:[&>input]:pl-1.5",
				className,
			)}
			{...props}
		/>
	);
}

const inputGroupAddonVariants = cva(
	"flex h-auto cursor-text items-center justify-center gap-2 py-1.5 text-sm font-medium text-muted-foreground select-none group-data-[disabled=true]/input-group:opacity-(--disabled-opacity) [&>kbd]:rounded-[calc(var(--radius)-5px)] [&>svg:not([class*='size-'])]:size-4",
	{
		variants: {
			align: {
				"inline-start":
					"order-first pl-2 has-[>button]:ml-[-0.3rem] has-[>kbd]:ml-[-0.15rem]",
				"inline-end":
					"order-last pr-2 has-[>button]:mr-[-0.3rem] has-[>kbd]:mr-[-0.15rem]",
				"block-start":
					"order-first w-full justify-start px-2.5 pt-2 group-has-[>input]/input-group:pt-2 [.border-b]:pb-2",
				"block-end":
					"order-last w-full justify-start px-2.5 pb-2 group-has-[>input]/input-group:pb-2 [.border-t]:pt-2",
			},
		},
		defaultVariants: {
			align: "inline-start",
		},
	},
);

function InputGroupAddon({
	className,
	align = "inline-start",
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
	return (
		// The addon is a decorative slot (icons, buttons, labels) flanking the
		// control, not a semantic form group, so no `role="group"`. We also drop
		// the original click-to-focus-the-input handler: keyboard users tab
		// straight into the textarea, so forwarding clicks on the surrounding
		// padding was a mouse-only affordance that tripped `useKeyWithClickEvents`
		// for no real accessibility gain.
		<div
			data-slot="input-group-addon"
			data-align={align}
			className={cn(inputGroupAddonVariants({ align }), className)}
			{...props}
		/>
	);
}

function InputGroupButton({
	className,
	type = "button",
	variant = "ghost",
	size = "icon",
	...props
}: Omit<React.ComponentProps<typeof Button>, "type"> & {
	type?: "button" | "submit" | "reset";
}) {
	// Composer controls sit on the 44px hit-target floor like every other
	// control: the Button's one size IS that floor, so this is a plain
	// pass-through (icon-square by default: the attach "+", submit, …).
	return (
		<Button
			type={type}
			variant={variant}
			size={size}
			className={className}
			{...props}
		/>
	);
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			className={cn(
				"flex items-center gap-2 text-sm text-muted-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		/>
	);
}

function InputGroupInput({
	className,
	...props
}: Omit<React.ComponentProps<typeof Input>, "focusRing">) {
	return (
		<Input
			data-slot="input-group-control"
			focusRing={false}
			className={cn(
				"flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 disabled:bg-transparent aria-invalid:ring-0 dark:bg-transparent dark:disabled:bg-transparent",
				className,
			)}
			{...props}
		/>
	);
}

function InputGroupTextarea({
	className,
	...props
}: Omit<React.ComponentProps<typeof Textarea>, "focusRing">) {
	return (
		<Textarea
			data-slot="input-group-control"
			focusRing={false}
			className={cn(
				"flex-1 resize-none rounded-none border-0 bg-transparent py-2 shadow-none ring-0 disabled:bg-transparent aria-invalid:ring-0 dark:bg-transparent dark:disabled:bg-transparent",
				className,
			)}
			{...props}
		/>
	);
}

export {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	InputGroupText,
	InputGroupTextarea,
};
