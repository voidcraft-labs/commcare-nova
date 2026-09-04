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
	'How the form is reached when it is not a menu item. { kind: "search-no-matches" } makes it the module\'s no-matches registration form: offered on Results after a search finds nothing, its fields may read the answers as #search/<prompt name> (search-answer-ref), it returns to Results with the new case (to the search, on a module without menu forms), and it carries no post_submit, links, or display condition. Also turns Search first on. null makes it a menu form again, turning Search first off and dropping its #search/ starting values; omitted keeps it.';
