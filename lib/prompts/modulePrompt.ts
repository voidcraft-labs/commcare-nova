/**
 * System prompt for the module content step (Tier 2).
 *
 * Designs case list columns. The message provides the module's case type,
 * its properties, and the case name property from the scaffold.
 */
export function modulePrompt(knowledge?: string): string {
  const knowledgeSection = knowledge
    ? `

## CommCare Platform Knowledge

The following is reference documentation about CommCare platform capabilities.
Consult this when making design decisions — prefer idiomatic CommCare patterns
over simpler structural workarounds.

<knowledge>
${knowledge}
</knowledge>`
    : ''

  return `You design the case list — the screen users see when they open a module and need to find the right case. They might be scrolling through hundreds of records on a phone, so the columns you pick determine whether they can quickly find who they're looking for.${knowledgeSection}

Choose whichever columns help users find the right case quickly. Column headers should be short and scannable.

Use "case_name" as the field to display the case name. For survey-only modules (no case type), set case_list_columns to null.

For case_detail_columns (the detail view when a user taps on a case), include more fields than the list view — this is where users see the full case record. Set to null to auto-mirror case_list_columns if the same fields work for both views.

Output the module content as JSON matching the schema.`
}

