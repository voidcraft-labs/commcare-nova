/**
 * PreviewToggle — the single Preview affordance for the whole builder.
 *
 * One toggle runs the app exactly as a worker sees it, wherever the user
 * is: forms fill in live, the case list searches real case data, and both
 * sidebars step aside (stash/restore lives in `setPreviewing`). Pressed
 * state = you're in preview; pressing again returns to editing with the
 * layout you left.
 *
 * Self-subscribes to `previewing` so the subheader doesn't re-render on
 * toggle. The actual store write goes through the `onSetPreviewing` prop —
 * BuilderLayout wraps it to capture the flipbook scroll anchor before the
 * mode flips.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerPlayerPause from "@iconify-icons/tabler/player-pause";
import tablerPlayerPlay from "@iconify-icons/tabler/player-play";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { usePreviewing } from "@/lib/session/hooks";

interface PreviewToggleProps {
	/** Scroll-anchor-capturing wrapper around the store's `setPreviewing`. */
	onSetPreviewing: (on: boolean) => void;
}

export function PreviewToggle({ onSetPreviewing }: PreviewToggleProps) {
	const previewing = usePreviewing();
	return (
		<SimpleTooltip
			content={
				previewing ? "Back to editing (P)" : "Try your app as it runs (P)"
			}
			side="bottom"
		>
			<button
				type="button"
				onClick={() => onSetPreviewing(!previewing)}
				aria-pressed={previewing}
				className={`inline-flex items-center gap-2 px-4 min-h-11 rounded-lg text-[13px] font-semibold whitespace-nowrap cursor-pointer border transition-all ${
					previewing
						? "bg-nova-action border-nova-action text-white shadow-[0_0_16px_rgba(79,70,229,0.4)]"
						: "bg-nova-violet/[0.12] border-nova-border-bright text-nova-violet-bright hover:bg-nova-violet/[0.2]"
				}`}
			>
				{/* Play ↔ pause: idle invites you to run the app; while
				 *  previewing it reads as "running", press to pause back to
				 *  editing. */}
				<Icon
					icon={previewing ? tablerPlayerPause : tablerPlayerPlay}
					width="17"
					height="17"
				/>
				Preview
			</button>
		</SimpleTooltip>
	);
}
