/**
 * System prompt for the form design phase (text-only, no tools).
 *
 * Runs before the Form Builder agent. Produces a detailed implementation plan
 * for all forms in the app — exact question IDs, types, grouping, XPath
 * expressions, case property mappings, and UX reasoning.
 */
import type { Scaffold } from '../schemas/blueprint'

export interface FormDesignPromptOptions {
  scaffold: Scaffold
  knowledge?: string
  examples: string
}

export function formDesignPrompt(opts: FormDesignPromptOptions): string {
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

  // Build form listing with formDesign specs
  const formSections: string[] = []
  for (let mIdx = 0; mIdx < scaffold.modules.length; mIdx++) {
    const sm = scaffold.modules[mIdx]
    for (let fIdx = 0; fIdx < sm.forms.length; fIdx++) {
      const sf = sm.forms[fIdx]
      const lines = [
        `### m${mIdx}-f${fIdx}: "${sf.name}"`,
        `Module: "${sm.name}" (${sm.purpose})`,
        `Type: ${sf.type}`,
        `Purpose: ${sf.purpose}`,
        `Case type: ${sm.case_type ?? 'none (survey)'}`,
        `Sibling forms: ${sm.forms.map(f => `"${f.name}" (${f.type})`).join(', ')}`,
      ]
      if (sf.formDesign) {
        lines.push('', 'Architect design notes:', sf.formDesign)
      }
      formSections.push(lines.join('\n'))
    }
  }

  return `You are a senior CommCare form designer. Your job is to produce a detailed implementation plan for every form in the app below. You are NOT building the forms — you are designing them so that a builder agent can implement your design faithfully.

Think like an experienced CommCare app builder who has deployed dozens of apps for field programs. Design for the end user — the field worker, enumerator, or case manager — not for technical correctness alone.${knowledgeSection}

${dataModelSection}

## App Structure

App: "${scaffold.app_name}" — ${scaffold.description}

${formSections.join('\n\n')}

## Gold-Standard Examples

Study these examples carefully. They show what excellent form design looks like — the reasoning behind grouping, calculated fields, skip logic, cross-form coordination, and question type choices.

<examples>
${examples}
</examples>

## Your Task

For each form, produce a complete implementation plan that includes:

1. **Question flow** — Every question in order, with exact IDs (snake_case), types, and grouping structure
2. **Case property mappings** — Which questions map to which case properties, which are readonly in followups
3. **XPath expressions** — Exact expressions for calculate, relevant, constraint, and default_value
4. **Groups** — What groups to create, their labels, and why these questions belong together
5. **Close case** — Whether and when to close the case (conditional or unconditional)
6. **Child cases** — Any child/sub-cases to create
7. **UX reasoning** — Brief notes on key design decisions (why calculated vs asked, why this grouping, why this skip logic)

## Design Principles

- **Calculate, don't ask**: If a value can be derived (age from DOB, gestational age from LMP, BMI from height+weight), use a hidden calculated field. Reduces errors, saves the worker's time.
- **Coordinate sibling forms**: Registration and followup forms for the same case type should have the same question order and grouping. Followups preload values and make historical fields readonly.
- **Use groups for visual sections**: Groups aren't just nesting — they create visual sections that help the worker understand the form's structure. Label them meaningfully.
- **One decision point, then conditional detail**: For branching workflows, use one select question to drive conditional visibility of entire groups. Don't scatter conditional fields throughout.
- **Respect the worker's time**: Every question should earn its place. If a field isn't needed for the workflow, reporting, or case management, don't include it.
- **Choose the right type**: Phone type for phone numbers (triggers numeric keypad), date type for dates (not text), select for yes/no (not text), hidden+calculate for derived values.
- **Default the common case**: Use default_value (e.g. today()) when 90%+ of submissions will use the same value. The worker can always override.
- **Confirm context in followups**: Start followup forms with a readonly group showing key case details so the worker confirms they opened the right record.

Design all forms now. Be thorough — the builder will implement exactly what you specify.`
}
