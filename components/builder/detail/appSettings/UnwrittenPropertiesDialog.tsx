"use client";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { useUnwrittenPropertyCards } from "@/lib/doc/hooks/useUnwrittenProperties";

interface UnwrittenPropertiesDialogProps {
	open: boolean;
	onClose: () => void;
}

/**
 * Informational list of the case properties this app reads but never
 * writes (`lib/doc/unwrittenProperties.ts`), opened from the App
 * Settings data-sources row. Deliberately NOT a warning — reading data
 * another app or system writes is a normal shape (a viewer app is
 * exactly this) — so the chrome stays neutral: no semantic color, no
 * action to take, just the fact and where each property is read.
 * Mounts through a portal so it escapes the app-settings popover's
 * transformed positioner, the same pattern as `ConnectManagerDialog`.
 */
export function UnwrittenPropertiesDialog({
	open,
	onClose,
}: UnwrittenPropertiesDialogProps) {
	const cards = useUnwrittenPropertyCards();
	return (
		<Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
			<DialogContent>
				<DialogTitle>Data written outside this app</DialogTitle>
				<DialogDescription>
					No form in this app writes these case properties, though the app reads
					them. That's often intentional: the values can come from another app
					on the same case type, an integration, or sample cases created for
					testing.
				</DialogDescription>
				{cards.length === 0 ? (
					<p className="text-xs text-nova-text-muted">
						Every case property this app reads is now written by a form here
					</p>
				) : (
					<ul className="grid gap-2">
						{cards.map((card) => (
							<li
								key={`${card.caseType}/${card.property}`}
								className="rounded-lg border border-nova-border bg-nova-surface px-3 py-2.5"
							>
								<div className="flex items-baseline gap-2">
									<span className="font-mono text-[13px] text-nova-text">
										{card.property}
									</span>
									<span className="text-[11px] text-nova-text-muted">
										case type {card.caseType}
									</span>
								</div>
								<div className="mt-1.5 text-[10px] font-medium uppercase tracking-wider text-nova-text-muted">
									Read by
								</div>
								<ul className="mt-0.5 space-y-0.5">
									{card.reads.map((read) => (
										<li key={read} className="text-xs text-nova-text-secondary">
											{read}
										</li>
									))}
								</ul>
							</li>
						))}
					</ul>
				)}
			</DialogContent>
		</Dialog>
	);
}
