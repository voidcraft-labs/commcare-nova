"use client";

import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";

import { cn } from "@/lib/utils";

function Drawer({ ...props }: DrawerPrimitive.Root.Props) {
	return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerPortal({ ...props }: DrawerPrimitive.Portal.Props) {
	return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerBackdrop({
	className,
	...props
}: DrawerPrimitive.Backdrop.Props) {
	return (
		<DrawerPrimitive.Backdrop
			data-slot="drawer-backdrop"
			className={cn(
				"absolute inset-0 z-raised bg-black/45 backdrop-blur-[1px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
				className,
			)}
			{...props}
		/>
	);
}

function DrawerViewport({
	className,
	...props
}: DrawerPrimitive.Viewport.Props) {
	return (
		<DrawerPrimitive.Viewport
			data-slot="drawer-viewport"
			className={cn(
				"pointer-events-none absolute inset-0 flex items-stretch overflow-clip data-closed:pointer-events-none",
				className,
			)}
			{...props}
		/>
	);
}

function DrawerPopup({ className, ...props }: DrawerPrimitive.Popup.Props) {
	return (
		<DrawerPrimitive.Popup
			data-slot="drawer-content"
			className={cn(
				"pointer-events-auto h-full min-w-0 overflow-hidden bg-nova-deep text-nova-text shadow-2xl outline-none",
				className,
			)}
			{...props}
		/>
	);
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
	return (
		<DrawerPrimitive.Title
			data-slot="drawer-title"
			className={cn("text-base font-semibold text-nova-text", className)}
			{...props}
		/>
	);
}

function DrawerDescription({
	className,
	...props
}: DrawerPrimitive.Description.Props) {
	return (
		<DrawerPrimitive.Description
			data-slot="drawer-description"
			className={cn("text-sm text-nova-text-secondary", className)}
			{...props}
		/>
	);
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
	return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

export {
	Drawer,
	DrawerBackdrop,
	DrawerClose,
	DrawerDescription,
	DrawerPopup,
	DrawerPortal,
	DrawerTitle,
	DrawerViewport,
};
