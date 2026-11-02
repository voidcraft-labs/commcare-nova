/**
 * Named hook: each identity move as the builder's dialogs list it, one row
 * per move. A row names what moves and where it goes (`identityMoveRow`),
 * and its second line says why (`identityMoveCopy.ts`). The words read the
 * live document, so a rename made while a dialog is open shows in it.
 */

"use client";

import { type BlueprintDoc, placementLabelWords } from "@/lib/domain";
import { deepEqual } from "../deepEqual";
import {
	identityMoveReasonSentence,
	identityMoveRenamesChosenCases,
	identitySubjectName,
} from "../identityMoveCopy";
import type { IdentityMove } from "../identityMoves";
import { useBlueprintDocEq } from "./useBlueprintDoc";

export interface IdentityMoveRow {
	/** What moves and where it goes. */
	readonly title: string;
	/** Why it can no longer stay where it is. */
	readonly reason: string;
}

/** One move's row: the subject, where it goes, and the reason under it. */
export function identityMoveRow(
	doc: BlueprintDoc,
	move: IdentityMove,
): IdentityMoveRow {
	return {
		title: identityMoveRowTitle(doc, move),
		reason: identityMoveReasonSentence(doc, move),
	};
}

function identityMoveRowTitle(doc: BlueprintDoc, move: IdentityMove): string {
	const name = identitySubjectName(doc, move.subject);
	switch (move.subject.kind) {
		case "case-operation":
		case "own-close":
			return `${name}: from ${placementLabelWords(move.from)} to ${placementLabelWords(move.to)}`;
		case "query-repeat":
			/* Every authored answer keeps its path in both placements; only
			 * the generated row nodes move. */
			return `${name}: its rows now follow the cases found, so each row's case id moves to a new place in the submission`;
		case "module-kind": {
			const kind =
				move.to === "advanced-menu" ? "an advanced menu" : "an ordinary menu";
			const parentCase = identityMoveRenamesChosenCases(move)
				? ", and its forms read the cases chosen through its parent case under new names"
				: "";
			return `${name}: becomes ${kind} in CommCare HQ, so every form in it keeps its case changes in a new place${parentCase}`;
		}
		default: {
			const _exhaustive: never = move.subject;
			return _exhaustive;
		}
	}
}

/** Every move's row, over the live document. */
export function useIdentityMoveRows(
	moves: readonly IdentityMove[],
): readonly IdentityMoveRow[] {
	return useBlueprintDocEq(
		(doc) => moves.map((move) => identityMoveRow(doc, move)),
		deepEqual,
	);
}
