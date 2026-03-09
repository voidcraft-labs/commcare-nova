/**
 * System prompt for the form content step (Tier 3, Sonnet).
 *
 * Kept minimal — the schema's .describe() strings provide field-level guidance,
 * and the user message provides the form's type, purpose, and case properties.
 * Case wiring (case_properties, case_preload, case_name_field) is derived
 * automatically from per-question case_property / is_case_name fields.
 */
export const FORM_PROMPT = `You design form questions and case configuration for CommCare forms.

Given a form's name, type, purpose, and its case type properties, output JSON matching the schema.

Every form must have questions. Registration forms should have questions for each case type property — set case_property on each to link it. Set is_case_name on the one question that identifies the case. Followup forms should set case_property on questions that display or update case data.`
