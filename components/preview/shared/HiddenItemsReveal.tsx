"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerEyeOff from "@iconify-icons/tabler/eye-off";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";

export interface HiddenNavigationItem {
	readonly key: string;
	readonly name: string;
	/** Person-readable condition summary (display-only prose from
	 *  `summarizeFilter`) — why the item is hidden right now. */
	readonly summary?: string;
}

/**
 * The running preview's reveal affordance for display-condition-hidden
 * navigation items. The device simply hides them; under "Preview as
 * me" the signed-in worker often lacks the session data a condition
 * reads, so the author needs a way to SEE what exists without the
 * preview lying about what a worker would get. Collapsed by default
 * (runtime-faithful); expanding lists ghosted, non-interactive entries
 * with each item's condition summary.
 */
export function HiddenItemsReveal({
	items,
}: {
	items: readonly HiddenNavigationItem[];
}) {
	const [open, setOpen] = useState(false);
	if (items.length === 0) return null;
	return (
		<div>
			<Button
				type="button"
				variant="ghost"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="min-h-11 gap-2 rounded-md px-2 py-1.5 text-[13px] text-nova-text-muted not-disabled:hover:text-nova-text"
			>
				<Icon
					icon={open ? tablerChevronDown : tablerChevronRight}
					width="14"
					height="14"
				/>
				<Icon icon={tablerEyeOff} width="14" height="14" />
				Hidden items ({items.length})
			</Button>
			{open && (
				<ul className="mt-1 space-y-1.5">
					{items.map((item) => (
						<li
							key={item.key}
							className="rounded-lg border border-dashed border-pv-input-border px-3 py-2 opacity-60"
						>
							<span className="block text-sm text-nova-text">{item.name}</span>
							{item.summary && (
								<span className="block text-xs text-nova-text-muted">
									Shown when {item.summary}
								</span>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
