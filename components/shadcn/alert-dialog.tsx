"use client";

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import type * as React from "react";
import { Button } from "@/components/shadcn/button";
import { cn } from "@/lib/utils";

function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
	return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
	return (
		<AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
	);
}

function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
	return (
		<AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
	);
}

function AlertDialogOverlay({
	className,
	...props
}: AlertDialogPrimitive.Backdrop.Props) {
	return (
		<AlertDialogPrimitive.Backdrop
			data-slot="alert-dialog-overlay"
			className={cn(
				"fixed inset-0 z-modal bg-black/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogContent({
	className,
	size = "default",
	...props
}: AlertDialogPrimitive.Popup.Props & {
	size?: "default" | "sm";
}) {
	return (
		<AlertDialogPortal>
			<AlertDialogOverlay />
			<AlertDialogPrimitive.Popup
				data-slot="alert-dialog-content"
				data-size={size}
				className={cn(
					// Same Nova chrome + z-modal plane as `dialog.tsx` — co-planar
					// with other modals, so an alert opened from inside one stacks
					// on top by portal order (its portal mounts later). The viewport
					// gutter and dynamic-height cap are part of the primitive contract:
					// call sites should never have to rebuild modal positioning or
					// scrolling just because their confirmation copy is longer.
					//
					// Which is why this is a COLUMN, not a scroller: `AlertDialogBody`
					// takes the leftover height and scrolls inside it, so Cancel and
					// the destructive action never leave the panel. Scrolling the whole
					// panel would put the choice below the fold — the one thing a
					// confirmation must never do. `overflow-y-auto` remains only as the
					// fallback for a body that isn't wrapped.
					"group/alert-dialog-content fixed top-1/2 left-1/2 z-modal flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] min-w-0 -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-nova-border bg-nova-deep p-5 [scrollbar-gutter:auto] text-sm text-nova-text shadow-elevated outline-none transition-[transform,opacity] data-[size=default]:max-w-xs data-[size=sm]:max-w-xs data-[size=default]:sm:max-w-sm data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
					className,
				)}
				{...props}
			/>
		</AlertDialogPortal>
	);
}

function AlertDialogHeader({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-dialog-header"
			className={cn(
				// Most confirmations are a question and two buttons with nothing
				// between them, so there is no body to absorb a short viewport. When
				// this header sits directly on the footer it therefore BECOMES the
				// scroller: the question scrolls, and Cancel / the destructive action
				// stay put. With a body in between the selector doesn't match and the
				// header stays fixed, so there is never a second scrollbar.
				"grid shrink-0 grid-rows-[auto_1fr] place-items-center gap-1.5 text-center [&:has(+[data-slot=alert-dialog-footer])]:min-h-0 [&:has(+[data-slot=alert-dialog-footer])]:shrink [&:has(+[data-slot=alert-dialog-footer])]:overflow-y-auto has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-4 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-left sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * The scrolling middle of an alert dialog — see `DialogBody`, including why the
 * inline margin is negative. Wrap anything that can run long (a list of
 * blockers, sample values) so the confirmation choice itself stays anchored at
 * the bottom of the panel.
 */
function AlertDialogBody({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-dialog-body"
			className={cn(
				"-mx-5 min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-5",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogFooter({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-dialog-footer"
			className={cn(
				// Confirmation choices are one compact decision, never a vertical
				// stack. Context belongs in the title and description, leaving
				// concise action words in the standard contained shadcn action row.
				"flex min-w-0 shrink-0 flex-row justify-end gap-2",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogMedia({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-dialog-media"
			className={cn(
				"mb-2 inline-flex size-10 items-center justify-center rounded-md bg-muted sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-6",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogTitle({
	className,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
	return (
		<AlertDialogPrimitive.Title
			data-slot="alert-dialog-title"
			className={cn(
				"min-w-0 break-words text-base leading-snug font-semibold text-nova-text [overflow-wrap:anywhere] sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogDescription({
	className,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
	return (
		<AlertDialogPrimitive.Description
			data-slot="alert-dialog-description"
			className={cn(
				"min-w-0 break-words text-sm text-balance text-nova-text-secondary [overflow-wrap:anywhere] md:text-pretty *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-nova-text",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDialogAction({
	className,
	...props
}: React.ComponentProps<typeof Button>) {
	return (
		<Button
			data-slot="alert-dialog-action"
			className={cn("min-w-0", className)}
			{...props}
		/>
	);
}

function AlertDialogCancel({
	className,
	variant = "outline",
	size = "default",
	...props
}: AlertDialogPrimitive.Close.Props &
	Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
	return (
		<AlertDialogPrimitive.Close
			data-slot="alert-dialog-cancel"
			className={cn("min-w-0", className)}
			render={<Button variant={variant} size={size} />}
			{...props}
		/>
	);
}

export {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogOverlay,
	AlertDialogPortal,
	AlertDialogTitle,
	AlertDialogTrigger,
};
