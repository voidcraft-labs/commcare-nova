// components/builder/navigation/DestinationMenu.tsx
//
// The "where does this go" chooser. A menu rather than a popover, per the
// repo rule for a selectable list, and every destination the app has is
// offered — including the ones that cannot be chosen, disabled with the
// reason, so an author is never left wondering where a form went.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import type { ReactNode } from "react";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import type { FormLinkTarget } from "@/lib/domain";
import type { DestinationChoice } from "./useEndOfFormNavigation";

export function DestinationMenu({
	choices,
	selectedKey,
	onSelect,
	disabled = false,
	label,
	ariaLabel,
	extraItems,
}: {
	readonly choices: readonly DestinationChoice[];
	readonly selectedKey?: string;
	readonly onSelect: (target: FormLinkTarget) => void;
	readonly disabled?: boolean;
	/** The trigger's own text — the current destination, or a prompt. */
	readonly label: ReactNode;
	readonly ariaLabel: string;
	/** Rows shown above the app's own destinations (the post-submit ones). */
	readonly extraItems?: ReactNode;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						disabled={disabled}
						aria-label={ariaLabel}
						className="min-w-0 max-w-full justify-between gap-2 border-white/[0.08] bg-transparent text-left text-[14px] text-nova-text-secondary dark:bg-transparent"
					/>
				}
			>
				<span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent preferredMinWidth={280}>
				{extraItems}
				{choices.map((choice) => (
					<DropdownMenuItem
						key={choice.key}
						disabled={choice.disabledReason !== undefined}
						data-selected={choice.key === selectedKey ? "" : undefined}
						onClick={() => onSelect(choice.target)}
					>
						<span className="flex min-w-0 flex-col">
							<span className="[overflow-wrap:anywhere]">{choice.label}</span>
							{choice.disabledReason !== undefined && (
								<span className="text-[12px] leading-tight text-nova-text-muted">
									{choice.disabledReason}
								</span>
							)}
						</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
