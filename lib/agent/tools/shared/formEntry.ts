/**
 * The `entry` input the form tools share: how a form is reached when it is
 * not a menu item. One kind today, the no-matches registration form of a
 * search-first module. `null` clears it (the form becomes a menu form).
 */

import { z } from "zod";

export const formEntryInputSchema = z
	.object({
		kind: z
			.literal("search-no-matches")
			.describe(
				"Offered on Results after a search finds no matches; on no menu.",
			),
		label: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				'The Results action label, e.g. "Register a new patient"; null or omitted uses the form name.',
			),
	})
	.strict();

export const FORM_ENTRY_DESCRIPTION =
	"Use search-no-matches for registration offered after an empty Search result. This enables Search first and lets fields read #search/name. Submission returns to Results unless post_submit is app_home, which several-case selection requires. No other destination, links, or display condition applies. Null restores a menu form, disables Search first, and removes Search-based starting values; omission keeps the current entry.";
