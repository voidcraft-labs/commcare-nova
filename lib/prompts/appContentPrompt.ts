/**
 * System prompt for the app content generation step (Opus, single call).
 *
 * Replaces modulePrompt, formDesignPrompt, and formBuilderPrompt. One prompt,
 * one job: take the scaffold and produce all content for all modules — case list
 * columns and all form questions. Opus thinks through the design in extended
 * thinking tokens, then produces the structured output.
 */
import type { Scaffold } from '../schemas/blueprint'

export interface AppContentPromptOptions {
  scaffold: Scaffold
  knowledge?: string
  examples: string
}

export function appContentPrompt(opts: AppContentPromptOptions): string {
  const { scaffold, knowledge, examples } = opts

  const knowledgeSection = knowledge
    ? `
## CommCare Platform Knowledge

<knowledge>
${knowledge}
</knowledge>`
    : ''

  // Build a compact representation of the full data model
  const dataModelSection = scaffold.case_types?.length
    ? `## Data Model

${scaffold.case_types.map(ct => {
      const props = ct.properties.map(p => {
        const parts = [`${p.name}`]
        if (p.data_type) parts.push(`(${p.data_type})`)
        if (p.label) parts.push(`— ${p.label}`)
        if (p.required) parts.push('[required]')
        if (p.constraint) parts.push(`[constraint: ${p.constraint}]`)
        if (p.options) parts.push(`[options: ${p.options.map(o => o.value).join(', ')}]`)
        return `  - ${parts.join(' ')}`
      }).join('\n')
      return `### Case type: ${ct.name} (case_name_property: ${ct.case_name_property})
${props}`
    }).join('\n\n')}`
    : ''

  // Build full module/form listing with formDesign specs
  const moduleSections: string[] = []
  for (let mIdx = 0; mIdx < scaffold.modules.length; mIdx++) {
    const sm = scaffold.modules[mIdx]
    const formLines: string[] = []

    for (let fIdx = 0; fIdx < sm.forms.length; fIdx++) {
      const sf = sm.forms[fIdx]
      const lines = [
        `  ### Form ${fIdx}: "${sf.name}"`,
        `  Type: ${sf.type}`,
        `  Purpose: ${sf.purpose}`,
      ]
      if (sf.formDesign) {
        lines.push('', '  Architect design notes:', `  ${sf.formDesign}`)
      }
      formLines.push(lines.join('\n'))
    }

    moduleSections.push(
      `## Module ${mIdx}: "${sm.name}"
Case type: ${sm.case_type ?? 'none (survey-only)'}
Purpose: ${sm.purpose}

${formLines.join('\n\n')}`
    )
  }

  return `You are a senior CommCare app builder. You are given an app scaffold — the structure and data model — and your job is to produce the complete content for every module: case list columns and all form questions.

<examples>
${examples}
</examples>

${dataModelSection}

## App Scaffold

App: "${scaffold.app_name}" — ${scaffold.description}

${moduleSections.join('\n\n')}
${knowledgeSection}

## Case List Columns

- Choose columns that help the user quickly identify and differentiate records
- Include case_name as the first column unless there is a reason not to
- 3-5 columns is typical — enough to be useful, not so many that they crowd the screen
- Column headers should be short and scannable
- For case_detail_columns (the detail view when tapping a case), include more fields than the list. Set to null to auto-mirror case_list_columns if the same fields work for both
- Survey-only modules (no case type) have null columns

## Form Building

The architect provided a formDesign spec for each form describing the intended UX and question flow. Follow those specs closely but use your judgment to improve on them — add constraints, constraint messages, and calculated fields where they make sense even if the spec didn't mention them.

### Question Structure

Questions use a flat structure with parentId:
- **parentId** is empty string for top-level questions. For questions inside a group or repeat, set parentId to the group's id.
- **Array order** determines display order — emit questions in the order they should appear within each parent context.
- Add group/repeat questions first (with parentId empty or the outer group), then add child questions pointing to the group's id.

### Data Model Defaults

When a question maps to a case property (via case_property), the data model provides default values for label, hint, help, required, constraint, constraint_msg, and options. Do NOT send these fields unless you need to override the default. They are applied automatically. Only include fields that are form-context-specific: relevant, calculate, default_value.

**Important: calculate and default_value are NEVER auto-derived.** The system cannot infer XPath expressions — you must always provide them explicitly. Every hidden question MUST have either a calculate expression or a default_value. A hidden question with neither is broken — it will save blank data to the case property. For example: initialization fields need default_value ("0", "active", etc.), computed fields need calculate (XPath expression), and preloaded fields need default_value (#case/property_name).

### Case Wiring

- **Registration forms** create a new case. Set case_property on questions that save to case properties. Set is_case_name: true on the question that maps to the case_name_property.
- **Followup forms** update an existing case. Set case_property on questions that display or edit case data. For display-only context (e.g. showing the client name at the top of a followup), use a "trigger" type question with a label containing an <output value="#case/property_name"/> reference — this renders as static text without an input field. Use default_value with #case/property_name to preload editable values from the case. Set is_case_name: true on the question that maps to the case_name_property if the form can update it.
- **Survey forms** have no case — just collect data. Don't set case_property or is_case_name.

### Design Principles

- **Use groups** to create visual sections that help the worker understand the form's structure. Label them meaningfully.
- **Calculate, don't ask**: If a value can be derived (age from DOB, BMI from height+weight), use a hidden calculated field.
- **Coordinate sibling forms**: Registration and followup forms for the same case type should use the same question IDs, the same group structure, and the same question order for shared fields. Followups preload values from the case using default_value with #case/property_name.
- **Confirm context in followups**: Start followup forms with a context group showing key case details using trigger questions with <output value="#case/property_name"/> labels so the worker confirms they opened the right record.
- **Prefer calculated fields** over asking the user for derived data.
- **Use relevant** for conditional visibility to keep forms short. One decision point, then conditional detail.
- **Use constraint** with human-friendly constraint_msg on fields where invalid input is possible.
- **Default the common case**: Use default_value (e.g. today()) when 90%+ of submissions will use the same value.
- **Choose the right type**: phone for phone numbers, date for dates, select1 for yes/no, hidden+calculate for derived values.

### XPath Expressions

For relevant, calculate, constraint, default_value, and required:
- Use raw operators (>, <, >=, <=), never HTML-escaped (&gt;, &lt;)
- Reference questions by full path: /data/question_id for top-level, /data/group_id/question_id for nested
- Use #case/property_name for case data shorthand
- Use default_value for one-time values set on form open. Use calculate for continuously recomputed values.

### Close Case and Child Cases

- If a followup form should close the case: use close_case. Empty {} = always close. {question, answer} = conditional close.
- If a form creates child/sub-cases: use child_cases with the child case type, name field, and property mappings.

### Cross-Module Coordination

- If a form in one module creates child cases consumed by another module, the child case properties and the consuming module's columns/forms must agree on property names and types.
- Registration and followup forms for the same case type should use the same question IDs, the same group structure, and the same question order for shared fields.

Build the complete content for all modules in this app.`
}
