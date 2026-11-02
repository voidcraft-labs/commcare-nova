/**
 * The case changes a publish offers to move, as a person reads them, and the
 * answer a caller sends back once that person agreed.
 *
 * A publish that a project space cannot take as it is may still take it with
 * some case changes kept elsewhere: a Save to Case block that CommCare HQ's
 * Case Management settings can hold instead, where the plan lacks Save to
 * Case. The offer names each move, a digest binds the answer to exactly the
 * moves shown, and accepting it records the moves before the publish goes on
 * (`lib/deployment/placementMoves.ts` derives the offer from the document).
 *
 * Client-safe: the publish dialog, the upload route and MCP read it.
 */

import { z } from "zod";
import { namesInWords } from "./planFeatures";

export const PLACEMENT_OFFER_REASONS = [
	"save-to-case",
	"same-type-child-links",
] as const;
export type PlacementOfferReason = (typeof PLACEMENT_OFFER_REASONS)[number];

/** One move as a person reads it. */
export interface PlacementMoveView {
	/** The form's name, trimmed, or its id. */
	readonly form: string;
	/** The case change, in words: "makes a new household case". */
	readonly change: string;
	/** The whole sentence the dialog and MCP show. */
	readonly sentence: string;
}

export interface PlacementMoveOfferView {
	readonly reason: PlacementOfferReason;
	/** 64 lower case hex. */
	readonly digest: string;
	readonly moves: readonly PlacementMoveView[];
	/** True where a move puts a new case in a basic subcase, which asks for Child Cases. */
	readonly asksChildCases: boolean;
}

export const acceptPlacementMovesSchema = z.strictObject({
	reason: z.enum(PLACEMENT_OFFER_REASONS),
	digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AcceptPlacementMoves = z.infer<typeof acceptPlacementMovesSchema>;

/** The label of the one checkbox that accepts an offer. */
export const ACCEPT_PLACEMENT_MOVES_LABEL = "Move them and publish";

/** The heading of the `save-to-case` offer. */
export const SAVE_TO_CASE_OFFER_HEADING = "Move these case changes";

/**
 * The body of the `save-to-case` offer. Where a move puts a new case in a
 * basic subcase, the next preflight may ask for Child Cases, and the body
 * says so.
 */
export function saveToCaseOfferBody(asksChildCases: boolean): string {
	const body =
		"Your project space's plan may not include Save to Case. Nova can save these case changes the way CommCare HQ's Case Management settings do instead, which every plan keeps. Moving them changes where CommCare HQ keeps their answers in every project space this app is published to, so form exports show them under new columns from the next version. Answers already submitted stay where they are.";
	return asksChildCases
		? `${body} Where a moved change makes a new case, the publish then asks whether the plan includes Child Cases, which more plans do.`
		: body;
}

/** The heading of the `same-type-child-links` offer. */
export const SAME_TYPE_CHILD_LINKS_OFFER_HEADING =
	"Save these new cases with Save to Case";

/**
 * The body of the `same-type-child-links` offer, by what the compatibility
 * check found: the project space drops the link (`missing`), or Nova could
 * not tell (`unverified`). Either way a Save to Case block keeps it.
 */
export function sameTypeChildLinksOfferBody(
	state: "missing" | "unverified",
): string {
	const found =
		state === "missing"
			? "This project space drops the link from a new case to the case of the same type it was made from."
			: "Nova couldn't check whether this project space keeps the link from a new case to the case of the same type it was made from.";
	return `${found} Save to Case blocks keep that link everywhere. Moving these changes where CommCare HQ keeps their answers in every project space this app is published to, and the project space's plan then needs Save to Case.`;
}

/** A move the `save-to-case` offer makes: out of a Save to Case block. */
export function movedToCaseManagementSentence(
	form: string,
	change: string,
): string {
	return `In ${form}, the change that ${change} moves from a Save to Case block to Case Management.`;
}

/** A move the `same-type-child-links` offer makes: into a Save to Case block. */
export function movedToSaveToCaseSentence(
	form: string,
	change: string,
): string {
	return `In ${form}, the change that ${change} moves from Case Management to a Save to Case block.`;
}

/** A move another move of the same offer forces. */
export function forcedPlacementMoveSentence(
	form: string,
	change: string,
): string {
	return `In ${form}, the change that ${change} stays in Case Management, in a new place.`;
}

/**
 * What a person can do where the project space's plan lacks Save to Case:
 * accept the move when the publish offers one, or else the forms named can't
 * go there as they are.
 */
export function saveToCaseWhereMissing(
	offered: boolean,
	forms: readonly string[],
): string {
	if (offered)
		return "Where the plan doesn't include it, Nova can move these case changes to CommCare HQ's Case Management settings, which every plan keeps. Choose that when you publish.";
	const named =
		forms.length === 0
			? "this app's forms make"
			: `${namesInWords(forms)} ${forms.length === 1 ? "makes" : "make"}`;
	return `Where the plan doesn't include it, the app can't go to this project space as it is: ${named} case changes only Save to Case can hold.`;
}
