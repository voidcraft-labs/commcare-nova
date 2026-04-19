"use client";
import { Menu } from "@base-ui/react/menu";
import { type ReactNode, useRef } from "react";
import {
	MENU_ITEM_BASE,
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
} from "@/lib/styles";

/** One selectable row in the menu. Label is rendered as-is when no
 *  `renderItem` is passed; it's also handed to `renderItem` so rich
 *  callers can compose around it. */
export interface SelectMenuOption<T extends string> {
	value: T;
	label: ReactNode;
}

interface SelectMenuProps<T extends string> {
	/** Currently active value. Rendered via `renderTrigger` or looked up
	 *  in `options` for the default trigger label. */
	value: T;
	/** Selectable options. Corner rounding on the popup is derived from
	 *  index + length — first item gets `rounded-t-xl`, last gets
	 *  `rounded-b-xl`, a single-item list gets full `rounded-xl`. */
	options: ReadonlyArray<SelectMenuOption<T>>;
	/** Invoked when the user picks a new value. Firing on Menu.Item click
	 *  matches Base UI's select-on-press semantics. */
	onChange: (value: T) => void;
	/** Optional id forwarded to `<Menu.Trigger>` so an external `<label>`
	 *  can associate with the trigger via `htmlFor`. */
	triggerId?: string;
	/** Optional override for the trigger body. Receives the current value
	 *  and the full options list so callers can render placeholder text
	 *  when `value` is falsy, mono-styled values, icons, etc. Default
	 *  behavior: render the active option's `label`, or the value string
	 *  itself if no option matches. */
	renderTrigger?: (
		value: T,
		options: ReadonlyArray<SelectMenuOption<T>>,
	) => ReactNode;
	/** Optional override for a single menu item body. Default renders the
	 *  option's `label` inside a `<span>`. Rich callers (icon + title +
	 *  description, mono value + suffix) use this to replace the label. */
	renderItem?: (option: SelectMenuOption<T>, isActive: boolean) => ReactNode;
}

/** Shared chevron used by every trigger. Rotates 180° when the popup is
 *  open via Base UI's `data-popup-open` attribute on the group. */
function Chevron() {
	return (
		<svg
			aria-hidden="true"
			width="10"
			height="10"
			viewBox="0 0 10 10"
			className="text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
		>
			<path
				d="M2 3.5L5 6.5L8 3.5"
				stroke="currentColor"
				strokeWidth="1.2"
				fill="none"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** Compute rounded-corner classes for a popup item based on its position
 *  in the list. Single-item popups get full rounding; first/last items
 *  round only their respective edges; interior items get no rounding so
 *  the popup edges look clean. */
function cornerClass(index: number, last: number): string {
	if (index === 0 && index === last) return "rounded-xl";
	if (index === 0) return "rounded-t-xl";
	if (index === last) return "rounded-b-xl";
	return "";
}

/**
 * Small dropdown primitive for the form-settings panel. Wraps the
 * Base UI `Menu.Root` → `Menu.Trigger` (+ chevron) → `Menu.Portal` →
 * `Menu.Positioner` → `Menu.Popup` → `Menu.Item` scaffolding that every
 * section's dropdown needs. The positioner anchors to the trigger ref
 * and matches its width via `var(--anchor-width)` so the popup always
 * aligns under the trigger regardless of content width.
 *
 * Callers customize two surfaces only:
 *   - `renderTrigger` — trigger body (default: active option's label).
 *   - `renderItem` — item body (default: option's label in a `<span>`).
 *
 * The chevron, corner-rounding, active-row styling, and ARIA wiring all
 * live here so a tweak to any of them touches one file instead of four.
 */
export function SelectMenu<T extends string>({
	value,
	options,
	onChange,
	triggerId,
	renderTrigger,
	renderItem,
}: SelectMenuProps<T>) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const last = options.length - 1;
	const activeOption = options.find((o) => o.value === value);

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				id={triggerId}
				className="group w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30"
			>
				{renderTrigger ? (
					renderTrigger(value, options)
				) : (
					<span>{activeOption?.label ?? value}</span>
				)}
				<Chevron />
			</Menu.Trigger>

			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_SUBMENU_POSITIONER_CLS}
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<Menu.Popup className={MENU_POPUP_CLS}>
						{options.map((opt, i) => {
							const isActive = opt.value === value;
							const corners = cornerClass(i, last);
							const itemClass = `${corners} ${
								isActive
									? `${MENU_ITEM_BASE} text-nova-violet-bright bg-nova-violet/10 cursor-pointer`
									: MENU_ITEM_CLS
							}`;

							return (
								<Menu.Item
									key={opt.value}
									onClick={() => onChange(opt.value)}
									className={itemClass}
								>
									{renderItem ? (
										renderItem(opt, isActive)
									) : (
										<span>{opt.label}</span>
									)}
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
