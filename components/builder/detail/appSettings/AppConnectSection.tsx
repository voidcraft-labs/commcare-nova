"use client";
import { useState } from "react";
import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import { CONNECT_TYPE_LABELS } from "@/lib/domain";
import { ConnectManagerDialog } from "./ConnectManagerDialog";

/**
 * App-level CommCare Connect row in the App Settings panel: the label
 * ("Connect" + the brand logomark), the app's Connect status
 * (Off / Learn / Deliver) as a chip, plus one button that opens the
 * {@link ConnectManagerDialog}. The manager owns the whole app-level story
 * (enabling, switching Learn to Deliver, choosing which forms participate,
 * editing them, and turning Connect off) so this row carries no toggle or
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
					<span className="flex items-center gap-1.5 text-xs font-medium text-nova-text-secondary">
						Connect
						<ConnectLogomark size={12} className="text-nova-violet-bright" />
					</span>
					{/* One chip geometry across all three states: violet when on,
					    quiet neutral when off, so status is the only thing that
					    changes. The logomark lives in the label, not here. */}
					{connectType ? (
						<Badge variant="violet">{CONNECT_TYPE_LABELS[connectType]}</Badge>
					) : (
						<Badge variant="muted">Off</Badge>
					)}
				</div>
				<Button type="button" variant="ghost" onClick={() => setOpen(true)}>
					{enabled ? "Manage" : "Set up"}
				</Button>
			</div>

			{/* Always mounted so Base UI animates the open AND close. */}
			<ConnectManagerDialog open={open} onClose={() => setOpen(false)} />
		</div>
	);
}
