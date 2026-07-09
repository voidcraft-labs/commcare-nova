"use client";

/**
 * Confirm row for a STAGED Connect sub-config — the sub-toggle scale of
 * the app-level enable dialog's collect-before-commit footer. A staged
 * block lives only in component state until the user writes its content;
 * this row is the one commit affordance, disabled (with the reason as the
 * hint) until the draft is complete. Toggling the sub-config off discards
 * the draft — that is the cancel.
 */
export function StagedCommitRow({
	ready,
	hint,
	onCommit,
}: {
	/** Whether the staged draft satisfies its block's content bar. */
	ready: boolean;
	/** What's still needed (shown while not ready) or a ready cue. */
	hint: string;
	onCommit: () => void;
}) {
	return (
		<div className="flex items-center justify-between gap-2 pt-0.5">
			<span className="text-[10px] text-nova-text-muted">{hint}</span>
			<button
				type="button"
				onClick={onCommit}
				disabled={!ready}
				className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-nova-action text-white transition-colors enabled:not-disabled:hover:brightness-110 enabled:cursor-pointer disabled:opacity-40"
			>
				Add
			</button>
		</div>
	);
}
