"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerCircleOff from "@iconify-icons/tabler/circle-off";
import tablerDatabase from "@iconify-icons/tabler/database";
import { useCallback, useId, useMemo, useRef } from "react";
import {
	MENU_ITEM_BASE,
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";

interface CasePropertyDropdownProps {
	value: string | undefined;
	isCaseName: boolean;
	disabled: boolean;
	caseTypes: string[];
	onChange: (caseType: string | null) => void;
	/** When true, the trigger button receives focus on mount (undo/redo restore). */
	autoFocus?: boolean;
}

/**
 * Dropdown for selecting which case type a question's value is saved to.
 * Options: "None" (no persistence) + one entry per writable case type.
 * Uses Base UI Menu for proper keyboard navigation and ARIA semantics.
 */
export function CasePropertyDropdown({
	value,
	isCaseName,
	autoFocus,
	disabled,
	caseTypes,
	onChange,
}: CasePropertyDropdownProps) {
	const isInteractive = !disabled && !isCaseName;
	const triggerId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);

	/** Compose autoFocus — focuses the button on mount when restoring focus
	 *  after undo/redo. Uses a ref callback to fire once on mount. */
	const composedTriggerRef = useCallback(
		(el: HTMLButtonElement | null) => {
			(triggerRef as React.MutableRefObject<HTMLButtonElement | null>).current =
				el;
			if (el && autoFocus) el.focus({ preventScroll: true });
		},
		[autoFocus],
	);

	const handleSelect = useCallback(
		(caseType: string | null) => {
			onChange(caseType);
		},
		[onChange],
	);

	const items = useMemo(() => {
		const result: { key: string; label: string; description: string }[] = [
			{
				key: "__none__",
				label: "None",
				description: "Don't save to a case",
			},
		];
		for (const ct of caseTypes) {
			result.push({
				key: ct,
				label: ct,
				description:
					ct === caseTypes[0] ? "Primary case type" : "Child case type",
			});
		}
		return result;
	}, [caseTypes]);

	/* Hide entirely when no case types exist and this isn't a case_name question */
	if (caseTypes.length === 0 && !isCaseName) return null;

	const activeKey = value ?? "__none__";
	const displayLabel = value ?? "None";

	return (
		<div>
			<label
				htmlFor={triggerId}
				className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block"
			>
				Saves to
			</label>

			{isInteractive ? (
				<Menu.Root>
					<Menu.Trigger
						ref={composedTriggerRef}
						id={triggerId}
						aria-label={`Saves to: ${displayLabel}`}
						className="group w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30"
					>
						<span
							className={
								value ? "text-nova-violet-bright" : "text-nova-text-muted"
							}
						>
							{displayLabel}
						</span>
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
					</Menu.Trigger>

					<Menu.Portal>
						<Menu.Positioner
							side="bottom"
							align="start"
							sideOffset={4}
							anchor={triggerRef}
							className={MENU_POSITIONER_CLS}
							style={{ minWidth: "var(--anchor-width)" }}
						>
							<Menu.Popup className={MENU_POPUP_CLS}>
								{items.map((item, i) => {
									const isActive = item.key === activeKey;
									const last = items.length - 1;
									const corners =
										i === 0 && i === last
											? "rounded-xl"
											: i === 0
												? "rounded-t-xl"
												: i === last
													? "rounded-b-xl"
													: "";

									return (
										<Menu.Item
											key={item.key}
											onClick={() =>
												handleSelect(item.key === "__none__" ? null : item.key)
											}
											className={`${corners} ${
												isActive
													? `${MENU_ITEM_BASE} text-nova-violet-bright bg-nova-violet/10 cursor-pointer`
													: MENU_ITEM_CLS
											}`}
										>
											<Icon
												icon={
													item.key === "__none__"
														? tablerCircleOff
														: tablerDatabase
												}
												width="16"
												height="16"
												className={
													isActive
														? "text-nova-violet-bright"
														: "text-nova-text-muted"
												}
											/>
											<span className="flex-1 text-left">
												<div>{item.label}</div>
												<div
													className={`text-xs leading-tight ${
														isActive
															? "text-nova-violet-bright/60"
															: "text-nova-text-muted"
													}`}
												>
													{item.description}
												</div>
											</span>
										</Menu.Item>
									);
								})}
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
			) : (
				/* Static trigger when non-interactive (disabled or case_name) */
				<button
					type="button"
					ref={composedTriggerRef}
					id={triggerId}
					aria-label={`Saves to: ${displayLabel}`}
					disabled
					className={`w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors ${
						isCaseName && value ? "opacity-70" : "opacity-50"
					} cursor-not-allowed text-nova-text bg-nova-deep/50 border-white/[0.06]`}
				>
					<span
						className={
							value ? "text-nova-violet-bright" : "text-nova-text-muted"
						}
					>
						{displayLabel}
					</span>
				</button>
			)}
		</div>
	);
}
