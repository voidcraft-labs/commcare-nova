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
				"The form opens from Results after a search on its module finds no matches, carrying the search answers; it is on no menu.",
			),
		label: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				'The action\'s label on Results, for example "Register a new patient". null or omitted uses the form name.',
			),
	})
	.strict();

export const FORM_ENTRY_DESCRIPTION =
	"How the form is reached when it is not a menu item. { kind: \"search-no-matches\" } makes it the module's no-matches registration form: it opens from Results after a search finds nothing, its fields can read the search answers as #search/<prompt name> (search-answer-ref parts), it always returns to Results showing the case it registered, and it cannot carry post_submit, after-submit links, or a display condition. Setting it also turns the module's Search first on. Requires a registration form in a module with Search prompts. null makes it a menu form again; omitted keeps it.";
