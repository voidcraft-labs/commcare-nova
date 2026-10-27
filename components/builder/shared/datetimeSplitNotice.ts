/**
 * What the builder says around the two date-and-time gestures, in one place,
 * so the field actions menu, the platform section's refusal row and the
 * insertion menu say the same words.
 */

import { showToast } from "@/lib/ui/toastStore";

/** The gesture's label, in the field actions menu and on a refusal row. */
export const SPLIT_DATETIME_LABEL = "Ask for the date and the time separately";

/** The lead of a refused split shown in place; the reason follows it. */
export const SPLIT_DATETIME_REFUSAL_LEAD = "Nova couldn't split this question.";

/** After a date-and-time question is split. */
export function announceDatetimeSplit(): void {
	showToast(
		"info",
		"Now asking for the date and the time separately",
		"A hidden value joins the two answers, so everything that read this question reads the same date and time. Both new questions use its label, and you can give each its own.",
	);
}

/** After a date and a time are inserted as two questions. */
export function announceDatetimeAsTwoQuestions(): void {
	showToast(
		"info",
		"Added a date question and a time question",
		"A hidden value joins the two answers into one date and time. Both questions use the same label, and you can give each its own.",
	);
}
