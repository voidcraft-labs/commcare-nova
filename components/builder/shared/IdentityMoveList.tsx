// components/builder/shared/IdentityMoveList.tsx
//
// The rows that say where CommCare HQ will keep some answers after a change:
// one per identity move, naming what moves and where it goes, with the
// reason it can no longer stay where it is on the second line. The builder's
// identity-move dialog lists them, and so does every review dialog whose
// reviewed batch moves a held identity, so a person answers one dialog.

"use client";

import { useIdentityMoveRows } from "@/lib/doc/hooks/useIdentityMoveRows";
import type { IdentityMove } from "@/lib/doc/identityMoves";
import type { IdentityMoveOrigin } from "@/lib/doc/pendingIdentityMove";

/** What the change does to the answers' place, said for how it was made. */
export function identityMoveLead(origin: IdentityMoveOrigin): string {
	/* An edit a publish overtook: the publish recorded the place the edit
	 * now moves, so the lead says that rather than what the edit does. */
	if (origin === "conflict")
		return "A publish just recorded where CommCare HQ keeps these answers, so your change now moves them.";
	const change =
		origin === "undo"
			? "Undoing this"
			: origin === "redo"
				? "Redoing this"
				: "After this change it";
	return `Your published app keeps these answers in one place. ${change} keeps them in another, so from your next publish CommCare HQ's exports show them under new columns.`;
}

/** A move's subject names one held identity, and a batch moves each
 *  identity at most once. */
function moveKey(move: IdentityMove | undefined): string {
	return move === undefined ? "" : JSON.stringify(move.subject);
}

export function IdentityMoveList({
	moves,
}: {
	readonly moves: readonly IdentityMove[];
}) {
	const rows = useIdentityMoveRows(moves);
	return (
		<ul className="space-y-2" data-identity-moves>
			{rows.map((row, index) => (
				<li
					key={moveKey(moves[index])}
					className="rounded-xl border border-nova-amber/25 bg-nova-amber/[0.05] p-3 text-[13px] leading-5"
				>
					<p className="text-nova-text">{row.title}</p>
					<p className="mt-1 text-nova-text-secondary">{row.reason}</p>
				</li>
			))}
		</ul>
	);
}

/** The statement inside a review dialog whose batch moves a held identity:
 *  the lead, then the rows, so the person answers that one dialog. */
export function IdentityMoveReviewNote({
	moves,
}: {
	readonly moves: readonly IdentityMove[];
}) {
	return (
		<section aria-label="Where CommCare HQ keeps these answers">
			<p className="mb-2 text-[13px] leading-5 text-nova-text-secondary">
				{identityMoveLead("edit")}
			</p>
			<IdentityMoveList moves={moves} />
		</section>
	);
}
