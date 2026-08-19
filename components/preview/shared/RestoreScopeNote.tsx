"use client";
import { Icon } from "@iconify/react/offline";
import tablerEyeOff from "@iconify-icons/tabler/eye-off";

/**
 * What the running list is NOT showing, and whose device decided that.
 *
 * A worker's phone does not hold every case in the project. It holds what
 * their ownership pulls in, plus whatever the case relationships pull in after
 * that, so previewing as a worker legitimately shows fewer cases than the
 * builder's case data does. Without a word on screen that looks like data
 * loss, and the author's next move is to go looking for a bug that is not
 * there.
 *
 * This is the same doctrine as {@link HiddenItemsReveal}: authoring-only
 * inspection sitting BESIDE a runtime-faithful list, never a blend of the two.
 * The list stays exactly what the device would show; this says how much is
 * outside it. It cannot list the cases themselves, because the preview never
 * loaded them — which is the point.
 */
export function RestoreScopeNote({
	count,
	workerName,
}: {
	/** Cases matching the same query that this worker's device would not hold. */
	readonly count: number;
	/** The worker Preview is running as, named so the note is about somebody. */
	readonly workerName: string;
}) {
	if (count <= 0) return null;
	return (
		<p className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-nova-text-muted">
			<Icon
				icon={tablerEyeOff}
				width="14"
				height="14"
				className="mt-0.5 shrink-0"
				aria-hidden
			/>
			<span>
				{count.toLocaleString()} more {count === 1 ? "case" : "cases"} in this
				project {count === 1 ? "matches" : "match"} this list. {workerName}{" "}
				would not have {count === 1 ? "it" : "them"} on their device, so the
				list leaves {count === 1 ? "it" : "them"} out.
			</span>
		</p>
	);
}
