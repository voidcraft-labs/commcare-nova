import { Button } from "@/components/shadcn/button";

interface RuntimeDateAddRepairAlertProps {
	readonly adjustmentCount: number;
	readonly onRepair: () => void;
}

/**
 * Explicit all-at-once recovery for a pre-gate carrier with unavailable date
 * arithmetic. Removing the adjustment envelope preserves each authored
 * starting value and produces one candidate for Nova's absolute commit gate.
 */
export function RuntimeDateAddRepairAlert({
	adjustmentCount,
	onRepair,
}: RuntimeDateAddRepairAlertProps) {
	if (adjustmentCount < 1) return null;
	return (
		<div
			role="alert"
			className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-nova-rose/25 bg-nova-rose/[0.06] px-3 py-2.5"
		>
			<p className="min-w-0 flex-1 text-[13px] leading-relaxed text-nova-text-secondary">
				{adjustmentCount === 1
					? "This date calculation can't run here. The repair keeps its starting date and removes the unavailable adjustment."
					: `${adjustmentCount} date calculations can't run here. The repair keeps each starting date and removes its unavailable adjustment.`}
			</p>
			<Button type="button" variant="outline" onClick={onRepair}>
				{adjustmentCount === 1
					? "Remove adjustment"
					: `Remove ${adjustmentCount} adjustments`}
			</Button>
		</div>
	);
}
