"use client";
import { useState } from "react";
import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import { ConnectManagerDialog } from "./ConnectManagerDialog";

/**
 * App-level CommCare Connect row in the App Settings panel: the label
 * ("Connect" + the brand logomark), the app's Connect status
 * (Off / Learn / Deliver) as a chip, plus one button that opens the
 * {@link ConnectManagerDialog}. The manager owns the whole app-level story
 * — enabling, switching Learn ⇄ Deliver, choosing which forms participate,
 * editing them, and turning Connect off — so this row carries no toggle or
 * mode pills of its own. (Per-form deep configuration still lives in each
 * form's own settings `ConnectSection`.)
 */
export function AppConnectSection() {
	const connectType = useConnectTypeOrUndefined();
	const [open, setOpen] = useState(false);
	const enabled = !!connectType;

	return (
		<div className="border-t border-white/[0.06] pt-3">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					{/* The logomark carries the "CommCare" half of the name, so the
					    word beside it is just "Connect". */}
					<span className="flex items-center gap-1.5 text-xs font-medium text-nova-text-secondary uppercase tracking-wider">
						Connect
						<ConnectLogomark size={12} className="text-nova-violet-bright" />
					</span>
					{/* One chip geometry across all three states — violet when on,
					    quiet neutral when off — so status is the only thing that
					    changes. The logomark lives in the label, not here. */}
					{connectType ? (
						<span className="flex h-[18px] items-center rounded border border-nova-violet/20 bg-nova-violet/15 px-1.5 text-[10px] font-medium capitalize text-nova-violet-bright">
							{connectType}
						</span>
					) : (
						<span className="flex h-[18px] items-center rounded border border-nova-border/60 bg-nova-surface px-1.5 text-[10px] font-medium text-nova-text-muted">
							Off
						</span>
					)}
				</div>
				<button
					type="button"
					onClick={() => setOpen(true)}
					className="cursor-pointer rounded-md border border-nova-border px-2 py-1 text-[11px] font-medium text-nova-text-secondary transition-colors hover:border-nova-violet/50 hover:text-nova-text"
				>
					{enabled ? "Manage" : "Set up"}
				</button>
			</div>

			{/* Always mounted so Base UI animates the open AND close. */}
			<ConnectManagerDialog open={open} onClose={() => setOpen(false)} />
		</div>
	);
}
