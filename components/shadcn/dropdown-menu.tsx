"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import type * as React from "react";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
} from "@/lib/styles";
import { cn } from "@/lib/utils";

/* Nova chrome throughout: the frosted-glass surface classes come from
 * `lib/styles.ts` — the same constants the raw `@base-ui/react` menu call
 * sites use — so shadcn menus and hand-composed menus cannot drift apart.
 * Glass lives on the POSITIONER (Base UI's `will-change: transform` there
 * creates a compositing boundary that would break a descendant
 * `backdrop-filter`); the popup only carries the open/close animation. */

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
	return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
	return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
	return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

const MENU_VIEWPORT_WIDTH_CAP =
	"max(0px, calc(var(--available-width) - 0.5rem))";

function cssLength(value: React.CSSProperties["width"]): string | undefined {
	if (value === undefined || value === null) return undefined;
	return typeof value === "number" ? `${value}px` : value;
}

function viewportSafePositionerStyle(
	style: React.CSSProperties | undefined,
): React.CSSProperties {
	const {
		minWidth: requestedMinWidth,
		maxWidth: requestedMaxWidth,
		...positionerStyle
	} = style ?? {};
	const minimum = cssLength(requestedMinWidth);
	const maximum = cssLength(requestedMaxWidth);

	return {
		...positionerStyle,
		minWidth:
			minimum === undefined
				? undefined
				: `min(${minimum}, ${MENU_VIEWPORT_WIDTH_CAP})`,
		maxWidth:
			maximum === undefined
				? MENU_VIEWPORT_WIDTH_CAP
				: `min(${maximum}, ${MENU_VIEWPORT_WIDTH_CAP})`,
	};
}

/**
 * The positioned glass layer for menus that need a richer internal layout than
 * `DropdownMenuContent` provides (for example, a searchable picker with a
 * frozen search field). Keeping this wrapper public lets those composites stay
 * on the shared shadcn primitive without reaching into Base UI directly.
 *
 * Base UI exposes the collision-safe width as `--available-width`. Cap both a
 * requested minimum and maximum against it: CSS otherwise lets `min-width` win
 * over `max-width`, which is how a roomy desktop menu can escape a narrow
 * builder canvas or mobile viewport.
 */
function DropdownMenuPositioner({
	className,
	style,
	surface = "glass",
	...props
}: MenuPrimitive.Positioner.Props & {
	readonly surface?: "glass" | "elevated";
}) {
	return (
		<MenuPrimitive.Positioner
			data-slot="dropdown-menu-positioner"
			className={cn(
				"isolate",
				surface === "elevated"
					? MENU_SUBMENU_POSITIONER_CLS
					: MENU_POSITIONER_CLS,
				className,
			)}
			style={
				typeof style === "function"
					? (state) => viewportSafePositionerStyle(style(state))
					: viewportSafePositionerStyle(style)
			}
			{...props}
		/>
	);
}

/** Shared popup chrome for rich menus composed inside a positioner. */
function DropdownMenuPopup({ className, ...props }: MenuPrimitive.Popup.Props) {
	return (
		<MenuPrimitive.Popup
			data-slot="dropdown-menu-popup"
			className={cn(
				MENU_POPUP_CLS,
				"max-h-(--available-height) max-w-full overflow-x-hidden overflow-y-auto p-1 outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
				className,
			)}
			{...props}
		/>
	);
}

function DropdownMenuContent({
	align = "start",
	alignOffset = 0,
	side = "bottom",
	sideOffset = 4,
	preferredMinWidth = "9rem",
	className,
	...props
}: MenuPrimitive.Popup.Props &
	Pick<
		MenuPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset"
	> & {
		readonly preferredMinWidth?: React.CSSProperties["minWidth"];
	}) {
	return (
		<MenuPrimitive.Portal>
			<DropdownMenuPositioner
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
				style={{ minWidth: preferredMinWidth }}
			>
				<DropdownMenuPopup
					data-slot="dropdown-menu-content"
					className={cn("min-w-0", className)}
					{...props}
				/>
			</DropdownMenuPositioner>
		</MenuPrimitive.Portal>
	);
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
	return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({
	className,
	inset,
	...props
}: MenuPrimitive.GroupLabel.Props & {
	inset?: boolean;
}) {
	return (
		<MenuPrimitive.GroupLabel
			data-slot="dropdown-menu-label"
			data-inset={inset}
			className={cn(
				"px-3 pt-2 pb-1 text-xs font-medium text-nova-text-muted data-inset:pl-9",
				className,
			)}
			{...props}
		/>
	);
}

function DropdownMenuItem({
	className,
	inset,
	variant = "default",
	...props
}: MenuPrimitive.Item.Props & {
	inset?: boolean;
	variant?: "default" | "destructive";
}) {
	return (
		<MenuPrimitive.Item
			data-slot="dropdown-menu-item"
			data-inset={inset}
			data-variant={variant}
			className={cn(
				MENU_ITEM_CLS,
				"group/dropdown-menu-item relative rounded-lg data-inset:pl-9 data-disabled:cursor-not-allowed data-disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				variant === "destructive" &&
					"text-nova-rose data-[highlighted]:bg-nova-rose/[0.08] data-[highlighted]:text-nova-rose *:[svg]:text-nova-rose",
				className,
			)}
			{...props}
		/>
	);
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
	return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
	className,
	inset,
	children,
	...props
}: MenuPrimitive.SubmenuTrigger.Props & {
	inset?: boolean;
}) {
	return (
		<MenuPrimitive.SubmenuTrigger
			data-slot="dropdown-menu-sub-trigger"
			data-inset={inset}
			className={cn(
				MENU_ITEM_CLS,
				"rounded-lg data-inset:pl-9 data-popup-open:bg-white/[0.06] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		>
			{children}
			<Icon icon={tablerChevronRight} className="ml-auto" />
		</MenuPrimitive.SubmenuTrigger>
	);
}

function DropdownMenuSubContent({
	align = "start",
	alignOffset = -3,
	side = "right",
	sideOffset = 0,
	preferredMinWidth = "6rem",
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuContent> & {
	readonly preferredMinWidth?: React.CSSProperties["minWidth"];
}) {
	return (
		// Submenus stack ABOVE a glass parent, so they take the near-opaque
		// elevated tier — glass-on-glass loses the backdrop blur.
		<MenuPrimitive.Portal>
			<DropdownMenuPositioner
				surface="elevated"
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
				style={{ minWidth: preferredMinWidth }}
			>
				<DropdownMenuPopup
					data-slot="dropdown-menu-sub-content"
					className={cn("w-auto min-w-0", className)}
					{...props}
				/>
			</DropdownMenuPositioner>
		</MenuPrimitive.Portal>
	);
}

function DropdownMenuCheckboxItem({
	className,
	children,
	checked,
	inset,
	...props
}: MenuPrimitive.CheckboxItem.Props & {
	inset?: boolean;
}) {
	return (
		<MenuPrimitive.CheckboxItem
			data-slot="dropdown-menu-checkbox-item"
			data-inset={inset}
			className={cn(
				MENU_ITEM_CLS,
				"relative rounded-lg pr-9 data-inset:pl-9 data-disabled:cursor-not-allowed data-disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			checked={checked}
			{...props}
		>
			<span
				className="pointer-events-none absolute right-3 flex items-center justify-center"
				data-slot="dropdown-menu-checkbox-item-indicator"
			>
				<MenuPrimitive.CheckboxItemIndicator>
					<Icon icon={tablerCheck} />
				</MenuPrimitive.CheckboxItemIndicator>
			</span>
			{children}
		</MenuPrimitive.CheckboxItem>
	);
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
	return (
		<MenuPrimitive.RadioGroup
			data-slot="dropdown-menu-radio-group"
			{...props}
		/>
	);
}

function DropdownMenuRadioItem({
	className,
	children,
	inset,
	...props
}: MenuPrimitive.RadioItem.Props & {
	inset?: boolean;
}) {
	return (
		<MenuPrimitive.RadioItem
			data-slot="dropdown-menu-radio-item"
			data-inset={inset}
			className={cn(
				MENU_ITEM_CLS,
				"relative rounded-lg pr-9 data-inset:pl-9 data-disabled:cursor-not-allowed data-disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		>
			<span
				className="pointer-events-none absolute right-3 flex items-center justify-center"
				data-slot="dropdown-menu-radio-item-indicator"
			>
				<MenuPrimitive.RadioItemIndicator>
					<Icon icon={tablerCheck} />
				</MenuPrimitive.RadioItemIndicator>
			</span>
			{children}
		</MenuPrimitive.RadioItem>
	);
}

function DropdownMenuSeparator({
	className,
	...props
}: MenuPrimitive.Separator.Props) {
	return (
		<MenuPrimitive.Separator
			data-slot="dropdown-menu-separator"
			className={cn("mx-2 my-1 h-px bg-white/[0.06]", className)}
			{...props}
		/>
	);
}

function DropdownMenuShortcut({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="dropdown-menu-shortcut"
			className={cn(
				"ml-auto text-xs tracking-widest text-nova-text-muted group-data-[highlighted]/dropdown-menu-item:text-nova-text",
				className,
			)}
			{...props}
		/>
	);
}

export {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
};
