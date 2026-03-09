/**
 * System prompt for the scaffold step (Tier 1, Sonnet).
 *
 * Kept minimal — most guidance lives in the schema's .describe() strings.
 */
export const SCAFFOLD_PROMPT = `You plan the structure of CommCare applications. Your response defines the app's data model and organization.

Design the app's architecture based on what the user asked for:
1. Define case types and their properties (the data model)
2. Organize modules (menus) and their forms
3. Each form has a type (registration/followup/survey) and a purpose

Only create what the user's specification calls for. Do not invent extra forms or modules beyond what is needed.

Output the app scaffold as JSON matching the schema.`
