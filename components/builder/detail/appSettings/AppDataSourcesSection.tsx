"use client";
import { useState } from "react";
import { useUnwrittenPropertyCards } from "@/lib/doc/hooks/useUnwrittenProperties";
import { UnwrittenPropertiesDialog } from "./UnwrittenPropertiesDialog";

/**
 * App-level data-sources row in the App Settings panel — present only
 * while the app reads case properties no form in it writes
 * (`lib/doc/unwrittenProperties.ts`). Informational, not a warning
 * (neutral chrome, no semantic color): the row states the count and
 * one button opens {@link UnwrittenPropertiesDialog} with the full
 * list. Renders nothing when every read property has a writer — a
 * zero row would be dead chrome.
 */
export function AppDataSourcesSection() {
	const cards = useUnwrittenPropertyCards();
	const [open, setOpen] = useState(false);
	if (cards.length === 0) return null;

	return (
		<div className="border-t border-white/[0.06] pt-3">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider">
						Data Sources
					</span>
					<span className="flex h-[18px] items-center rounded border border-nova-border/60 bg-nova-surface px-1.5 text-[10px] font-medium text-nova-text-muted">
						{cards.length}
					</span>
				</div>
				<button
					type="button"
					onClick={() => setOpen(true)}
					className="cursor-pointer rounded-md border border-nova-border px-2 py-1 text-[11px] font-medium text-nova-text-secondary transition-colors hover:border-nova-violet/50 hover:text-nova-text"
				>
					View
				</button>
			</div>
			<p className="mt-1.5 text-xs text-nova-text-muted">
				{cards.length === 1
					? "1 case property is read in this app but not written by any form here."
					: `${cards.length} case properties are read in this app but not written by any form here.`}
			</p>

			{/* Always mounted so Base UI animates the open AND close. */}
			<UnwrittenPropertiesDialog open={open} onClose={() => setOpen(false)} />
		</div>
	);
}
