"use client";
import { Popover } from "@base-ui/react/popover";
import tablerCircleOff from "@iconify-icons/tabler/circle-off";
import tablerDatabase from "@iconify-icons/tabler/database";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import {
	DropdownMenu,
	type DropdownMenuItem,
} from "@/components/ui/DropdownMenu";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";

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
	const [open, setOpen] = useState(false);
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
			setOpen(false);
		},
		[onChange],
	);

	const items: DropdownMenuItem[] = useMemo(() => {
		const result: DropdownMenuItem[] = [
			{
				key: "__none__",
				label: "None",
				description: "Don't save to a case",
				icon: tablerCircleOff,
				onClick: () => handleSelect(null),
			},
		];
		for (const ct of caseTypes) {
			result.push({
				key: ct,
				label: ct,
				description:
					ct === caseTypes[0] ? "Primary case type" : "Child case type",
				icon: tablerDatabase,
				onClick: () => handleSelect(ct),
			});
		}
		return result;
	}, [caseTypes, handleSelect]);

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
			<Popover.Root
				open={open}
				onOpenChange={isInteractive ? setOpen : undefined}
			>
				<Popover.Trigger
					ref={composedTriggerRef}
					id={triggerId}
					aria-label={`Saves to: ${displayLabel}`}
					disabled={!isInteractive}
					className={`w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors ${
						isInteractive
							? "cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30"
							: `${isCaseName && value ? "opacity-70" : "opacity-50"} cursor-not-allowed text-nova-text bg-nova-deep/50 border-white/[0.06]`
					}`}
				>
					<span
						className={
							value ? "text-nova-violet-bright" : "text-nova-text-muted"
						}
					>
						{displayLabel}
					</span>
					{isInteractive && (
						<svg
							aria-hidden="true"
							width="10"
							height="10"
							viewBox="0 0 10 10"
							className={`text-nova-text-muted transition-transform ${open ? "rotate-180" : ""}`}
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
					)}
				</Popover.Trigger>

				<Popover.Portal>
					<Popover.Positioner
						side="bottom"
						align="start"
						sideOffset={4}
						anchor={triggerRef}
						className={POPOVER_POSITIONER_GLASS_CLS}
						style={{ minWidth: "var(--anchor-width)" }}
					>
						<Popover.Popup className={POPOVER_POPUP_CLS}>
							<DropdownMenu items={items} activeKey={activeKey} />
						</Popover.Popup>
					</Popover.Positioner>
				</Popover.Portal>
			</Popover.Root>
		</div>
	);
}
