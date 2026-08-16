"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import type * as React from "react";

import { Button } from "@/components/shadcn/button";
import { usePortaledContentDirection } from "@/components/shadcn/portaled-content-direction";
import { cn } from "@/lib/utils";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
	return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
	return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
	return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
	return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
	className,
	...props
}: DialogPrimitive.Backdrop.Props) {
	return (
		<DialogPrimitive.Backdrop
			data-slot="dialog-overlay"
			className={cn(
				"fixed inset-0 z-modal bg-black/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
				className,
			)}
			{...props}
		/>
	);
}

function DialogContent({
	className,
	children,
	showCloseButton = true,
	dir,
	...props
}: DialogPrimitive.Popup.Props & {
	showCloseButton?: boolean;
}) {
	const inheritedDirection = usePortaledContentDirection();
	return (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Popup
				data-slot="dialog-content"
				dir={dir ?? inheritedDirection}
				// A column, not a scroller: the panel caps its own height and
				// `DialogBody` takes the leftover and scrolls INSIDE it, so the
				// title, the close button, and the actions stay put. Scrolling the
				// whole panel puts the actions below the fold and carries the X off
				// the top: the user has to scroll back up to dismiss.
				//
				// `overflow-y-auto` stays as the fallback for a dialog whose middle
				// isn't wrapped in `DialogBody`: it then behaves exactly as it always
				// did rather than clipping. Wrap the middle and it never engages,
				// because a `min-h-0 flex-1` body can shrink to fit.
				className={cn(
					"group/dialog-content fixed top-1/2 left-1/2 z-modal flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] min-w-0 -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-nova-border bg-nova-deep p-5 [scrollbar-gutter:auto] text-sm text-nova-text shadow-elevated outline-none transition-[transform,opacity] sm:max-w-md data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
					className,
				)}
				{...props}
			>
				{children}
				{showCloseButton && (
					<DialogPrimitive.Close
						data-slot="dialog-close"
						render={
							<Button
								variant="ghost"
								className="absolute top-2 right-2"
								size="icon"
							/>
						}
					>
						<Icon icon={tablerX} />
						<span className="sr-only">Close</span>
					</DialogPrimitive.Close>
				)}
			</DialogPrimitive.Popup>
		</DialogPortal>
	);
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-header"
			className={cn(
				// Sitting directly on the footer means there is no body to absorb a
				// short viewport, so the header becomes the scroller rather than
				// pushing the actions past the fold. With a body between them the
				// selector doesn't match and the header stays fixed.
				"flex min-w-0 shrink-0 flex-col gap-1.5 group-has-data-[slot=dialog-close]/dialog-content:pr-11 [&:has(+[data-slot=dialog-footer])]:min-h-0 [&:has(+[data-slot=dialog-footer])]:shrink [&:has(+[data-slot=dialog-footer])]:overflow-y-auto",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * The scrolling middle of a dialog.
 *
 * Wrap whatever sits between the header and the footer. It takes the height the
 * panel has left and scrolls inside it, which is what keeps the actions and the
 * close button on screen no matter how long the content runs.
 *
 * The negative inline margin cancels the panel's own `p-5` and the padding puts
 * it back on the CONTENT, so the scroll track lands where you expect it, hard
 * against the panel's inside edge: instead of floating 20px in from it. A
 * panel that sets its own padding (`p-0` and custom chrome) passes
 * `className="mx-0 px-0"` to opt out.
 */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-body"
			className={cn(
				"-mx-5 min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-5",
				className,
			)}
			{...props}
		/>
	);
}

function DialogFooter({
	className,
	showCloseButton = false,
	children,
	...props
}: React.ComponentProps<"div"> & {
	showCloseButton?: boolean;
}) {
	return (
		<div
			data-slot="dialog-footer"
			className={cn(
				"flex min-w-0 shrink-0 flex-row justify-end gap-2",
				className,
			)}
			{...props}
		>
			{children}
			{showCloseButton && (
				<DialogPrimitive.Close render={<Button variant="outline" />}>
					Close
				</DialogPrimitive.Close>
			)}
		</div>
	);
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
	return (
		<DialogPrimitive.Title
			data-slot="dialog-title"
			className={cn(
				"min-w-0 break-words text-base leading-snug font-semibold text-nova-text [overflow-wrap:anywhere]",
				className,
			)}
			{...props}
		/>
	);
}

function DialogDescription({
	className,
	...props
}: DialogPrimitive.Description.Props) {
	return (
		<DialogPrimitive.Description
			data-slot="dialog-description"
			className={cn(
				"min-w-0 break-words text-sm text-nova-text-secondary [overflow-wrap:anywhere] *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-nova-text",
				className,
			)}
			{...props}
		/>
	);
}

export {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogOverlay,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
};
