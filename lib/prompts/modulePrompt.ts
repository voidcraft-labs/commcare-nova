/**
 * System prompt for the module content step (Tier 2).
 *
 * Designs case list columns. The message provides the module's case type,
 * its properties, and the case name property from the scaffold.
 */
export const MODULE_PROMPT = `You design the case list — the screen users see when they open a module and need to find the right case. They might be scrolling through hundreds of records on a phone, so the columns you pick determine whether they can quickly find who they're looking for.

Choose whichever columns help users find the right case quickly. Column headers should be short and scannable.

Use "case_name" as the field to display the case name. For survey-only modules (no case type), set case_list_columns to null.

Output the module content as JSON matching the schema.`
