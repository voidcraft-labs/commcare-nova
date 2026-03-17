# Schemas & Content Processing

## Blueprint Schema (`blueprint.ts`)

Zod schemas for `AppBlueprint` and generation output schemas (`caseTypesOutput`, `scaffoldModules`, `moduleContent`).

### Question Fields

Only `id` and `type` are required. All other fields are optional — present only when set:
- **Text:** `label`, `hint`, `help`
- **Logic:** `required`, `constraint`, `constraint_msg`, `relevant`, `calculate`, `default_value`
- **Data:** `case_property`, `is_case_name`, `options`
- **Structure:** `children` (nested groups/repeats)

All text fields are plain `string`. XPath fields support `#case/` and `#user/` hashtag shorthand.

### Question Format

- One `Question` type with nested `children` for groups/repeats
- Stored schema supports one level of nesting; SA tools with `parentId` build deeper structures
- `default_value` → `<setvalue event="xforms-ready">` in XForm (one-time on load, unlike `calculate` which recalculates)
- `is_case_name` is auto-derived from `case_name_property` in the case type — LLM only sets explicitly to override

### Close Case Format

- `{}` = unconditional close
- `{ question, answer }` = conditional close
- absent/undefined = no close

## Structured Output Constraints

The Anthropic schema compiler times out with >8 `.optional()` per array item (each creates an `anyOf` union in JSON Schema). The `singleFormSchema` in `solutionsArchitect.ts` uses a hybrid approach:

- **8 optional fields** (sparse, saves tokens): `hint`, `help`, `constraint`, `constraint_msg`, `relevant`, `calculate`, `default_value`, `options`
- **4 required sentinel fields** (almost always present, low cost): `label` (empty string), `required` (empty string), `case_property` (empty string), `is_case_name` (false)
- **`type`** uses `z.enum(QUESTION_TYPES)` (enums don't create `anyOf` unions)

Post-processing converts sentinels back to real values — see Content Processing below.

Test with: `npx tsx scripts/test-schema.ts`

## Content Processing (`contentProcessing.ts`)

Post-processing pipeline for structured output from form generation:

1. **`stripEmpty()`** — converts sentinel values (empty strings, false) back to undefined
2. **`buildQuestionTree()`** — converts flat `parentId`-based questions to nested `children` arrays
3. **`applyDefaults()`** — merges case property metadata (type, label, hint, help, required, constraint, options, is_case_name). Also runs `unescapeXPath()` to sanitize HTML entities (`&gt;` → `>`) LLMs sometimes emit.
4. **`processSingleFormOutput()`** — chains all three in order

### XPath and Vellum Hashtags

Questions use `#case/property_name` and `#user/property_name` shorthand in XPath fields (`relevant`, `calculate`, `constraint`, `default_value`). The expander handles expansion to full instance XPath — see `lib/services/CLAUDE.md` for the dual-attribute Vellum pattern.
