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
import tablerEdit from "@iconify-icons/tabler/edit";
import tablerPlayerPlay from "@iconify-icons/tabler/player-play";
import { usePreviewModeTransition } from "@/components/builder/usePreviewModeTransition";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { usePreviewing } from "@/lib/session/hooks";

interface PreviewToggleProps {
	/** Scroll-anchor-capturing wrapper around the store's `setPreviewing`. */
	onSetPreviewing: (on: boolean) => void;
}

export function PreviewToggle({ onSetPreviewing }: PreviewToggleProps) {
	const previewing = usePreviewing();
	const transitionPreview = usePreviewModeTransition(onSetPreviewing);
	return (
		<SimpleTooltip
			content={
				previewing ? "Back to editing (P)" : "Try your app as it runs (P)"
			}
			side="bottom"
		>
			<Button
				type="button"
				variant={previewing ? "default" : "outline"}
				size="xl"
				onClick={() => transitionPreview(!previewing)}
				className={`rounded-lg px-4 text-[13px] font-semibold ${
					previewing
						? "bg-nova-action border-nova-action text-white shadow-[0_0_16px_rgba(79,70,229,0.4)]"
						: "border-nova-border-bright bg-nova-violet/[0.12] text-nova-violet-bright hover:bg-nova-violet/[0.2] hover:text-nova-violet-bright dark:bg-nova-violet/[0.12] dark:hover:bg-nova-violet/[0.2]"
				}`}
			>
				{/* Preview is a destination, not a media transport. Once inside,
				 * the control names the useful return action explicitly. */}
				<Icon
					icon={previewing ? tablerEdit : tablerPlayerPlay}
					width="17"
					height="17"
				/>
				{previewing ? "Back to edit" : "Preview"}
			</Button>
		</SimpleTooltip>
	);
}
