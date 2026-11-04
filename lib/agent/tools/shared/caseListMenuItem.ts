/**
 * The `case_list_menu_item` input the module tools share: the module's case
 * list as its own item in its menu (`Module.caseListMenuItem`). No tool sets
 * the item's icon or spoken label.
 */

import { z } from "zod";
import type { CaseListMenuItem } from "@/lib/domain";

export const caseListMenuItemInputSchema = z.strictObject({
	label: z
		.string()
		.min(1)
		.nullable()
		.optional()
		.describe("The menu item's text; null or omitted uses the module's name."),
});

export type CaseListMenuItemInput = z.infer<typeof caseListMenuItemInputSchema>;

/** The stored item for what the SA gave, keeping the item's media. */
export function caseListMenuItemFromInput(
	input: CaseListMenuItemInput,
	current?: CaseListMenuItem,
): CaseListMenuItem {
	const { label: _label, ...media } = current ?? {};
	return input.label == null ? media : { ...media, label: input.label };
}
