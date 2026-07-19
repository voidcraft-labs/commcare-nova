/**
 * Export menu — CommCare HQ is the primary destination and local files are
 * secondary. The shared shadcn menu owns positioning, focus, keyboard
 * navigation, collision handling, item highlights, and the floating chrome.
 */

"use client";

import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerCloudUpload from "@iconify-icons/tabler/cloud-upload";
import tablerUpload from "@iconify-icons/tabler/upload";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { SimpleTooltip } from "@/components/shadcn/tooltip";

export interface ExportOption {
	label: string;
	description: string;
	icon: IconifyIcon;
	onClick: () => void;
}

interface ExportDropdownProps {
	/** File download options (JSON, CCZ). */
	options: ExportOption[];
	/** Whether CommCare HQ credentials are configured. */
	commcareConfigured: boolean;
	/** Called when the user clicks "CommCare HQ" (only when configured). */
	onCommCareUpload: () => void;
}

export function ExportDropdown({
	options,
	commcareConfigured,
	onCommCareUpload,
}: ExportDropdownProps) {
	const [open, setOpen] = useState(false);
	const choose = (action: () => void) => {
		action();
		setOpen(false);
	};

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<SimpleTooltip content="Export">
				<DropdownMenuTrigger
					render={<Button type="button" variant="ghost" size="icon-lg" />}
					aria-label="Export"
					className="size-11 text-nova-text-muted not-disabled:hover:bg-white/5 not-disabled:hover:text-nova-text"
				>
					<Icon icon={tablerUpload} width={18} height={18} />
				</DropdownMenuTrigger>
			</SimpleTooltip>

			<DropdownMenuContent align="end" sideOffset={6} preferredMinWidth="18rem">
				<DropdownMenuGroup>
					<DropdownMenuLabel>CommCare HQ</DropdownMenuLabel>
					{commcareConfigured ? (
						<DropdownMenuItem
							onClick={() => choose(onCommCareUpload)}
							className="min-h-14"
						>
							<Icon
								icon={tablerCloudUpload}
								className="text-nova-violet-bright"
							/>
							<ItemCopy
								label="Upload app"
								description="Send this version to a project space"
							/>
						</DropdownMenuItem>
					) : (
						<DropdownMenuItem
							render={<Link href="/settings" />}
							nativeButton={false}
							onClick={() => setOpen(false)}
							className="min-h-14"
						>
							<Icon icon={tablerCloudUpload} className="text-nova-text-muted" />
							<ItemCopy
								label="Connect CommCare HQ"
								description="Set up direct uploads in Settings"
							/>
							<Icon
								icon={tablerChevronRight}
								className="ml-auto text-nova-text-muted"
							/>
						</DropdownMenuItem>
					)}
				</DropdownMenuGroup>

				<DropdownMenuSeparator />

				<DropdownMenuGroup>
					<DropdownMenuLabel>Download</DropdownMenuLabel>
					{options.map((option) => (
						<DropdownMenuItem
							key={`${option.label}:${option.description}`}
							onClick={() => choose(option.onClick)}
							className="min-h-14"
						>
							<Icon icon={option.icon} className="text-nova-text-muted" />
							<ItemCopy label={option.label} description={option.description} />
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ItemCopy({
	label,
	description,
}: {
	readonly label: string;
	readonly description: string;
}) {
	return (
		<span className="min-w-0 flex-1 text-left">
			<span className="block font-medium">{label}</span>
			<span className="mt-0.5 block whitespace-normal text-xs leading-snug text-nova-text-muted [overflow-wrap:anywhere]">
				{description}
			</span>
		</span>
	);
}
