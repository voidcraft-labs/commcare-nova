"use client";
import { Icon } from "@iconify/react/offline";
import tablerEyeOff from "@iconify-icons/tabler/eye-off";

/**
 * Who the running preview is acting as, for copy that has to address them.
 *
 * A discriminant rather than a name string, because the two read completely
 * differently: previewing as yourself is second person ("your device"), and
 * previewing as a persona is third ("their device"). Passing `"You"` as a name
 * and interpolating it produces "You would not have them on their device".
 */
export type PreviewWorkerLabel =
	| { readonly kind: "me" }
	| { readonly kind: "persona"; readonly name: string };

/** "your" / "Amara's" — the possessive that fits the sentence. */
function possessive(worker: PreviewWorkerLabel): string {
	return worker.kind === "me" ? "your" : `${worker.name}'s`;
}

/**
 * What the running list is NOT showing, and whose device decided that.
 *
 * A worker's phone does not hold every case in the project. It holds what
 * their ownership pulls in, plus whatever the case relationships pull in after
 * that, so previewing as a worker legitimately shows fewer cases than the
 * builder's case data does. Without a word on screen that looks like data
 * loss, and the author's next move is to go hunting for a bug that is not
 * there.
 *
 * Same doctrine as {@link HiddenItemsReveal}: authoring-only inspection
 * sitting BESIDE a runtime-faithful list, never a blend of the two. The list
 * stays exactly what the device would show; this says how much is outside it.
 * It cannot list the cases themselves, because the preview never loaded them,
 * which is the point.
 */
export function RestoreScopeNote({
	count,
	worker,
}: {
	/** Cases matching the same query that this worker's device would not hold. */
	readonly count: number;
	readonly worker: PreviewWorkerLabel;
}) {
	if (count <= 0) return null;
	const one = count === 1;
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
				{count.toLocaleString()} more {one ? "case" : "cases"} in this project{" "}
				{one ? "matches" : "match"} this list, but {one ? "it" : "they"} would
				not be on {possessive(worker)} device, so the list leaves{" "}
				{one ? "it" : "them"} out.
			</span>
		</p>
	);
}

/**
 * The empty-state copy for when the RESTORE is why the list is empty.
 *
 * Copy rather than a component, because the screen owns one `CaseListEmptyNotice`
 * shell that every empty cause renders through, and a second shell beside it
 * would drift in spacing and heading level.
 *
 * This cause has to OUTRANK every other empty state, because the others are
 * all read off a TENANT-wide count and would misattribute: the unconstrained
 * arm concludes "no case data exists" from an empty list, and the search arm
 * blames the worker's Search values or the authored availability conditions.
 * All three would be saying something false right next to a note on the same
 * screen saying the project holds hundreds of these cases.
 */
export function restoreScopeEmptyCopy(
	count: number,
	worker: PreviewWorkerLabel,
): { readonly title: string; readonly description: string } {
	const held = `This project has ${count.toLocaleString()} ${
		count === 1 ? "case" : "cases"
	} here.`;
	// The two arms differ in more than person. Previewing as yourself IS a
	// worker assigned nowhere, so the reason is the absent assignment and the
	// next step is to preview as someone who has one. Previewing as a persona
	// has an assignment to go and change.
	return worker.kind === "me"
		? {
				title: "None of these cases would be on your device",
				description: `${held} You are not assigned to a place, so you only carry the cases you own. Preview as one of your workers to see what they would carry.`,
			}
		: {
				title: `None of these cases would be on ${worker.name}'s device`,
				description: `${held} A worker carries the cases they own plus the cases from the places they are assigned to. Change ${worker.name}'s assignment in App setup to bring these within reach.`,
			};
}
