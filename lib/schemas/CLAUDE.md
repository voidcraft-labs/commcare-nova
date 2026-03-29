# Schemas & Content Processing

## API Schemas (`apiSchemas.ts`)

Zod schemas for API route input validation:
- `chatRequestSchema` — validates `apiKey`, `blueprint` (reuses `appBlueprintSchema`), `pipelineConfig` (typed to match `PipelineStageConfig`). Messages are typed as `UIMessage[]` separately — they come from the AI SDK, not validated by us.
- `modelsRequestSchema` — validates `apiKey`.

## Blueprint Schema (`blueprint.ts`)

Zod schemas for `AppBlueprint` and generation output schemas (`caseTypesOutput`, `scaffoldModules`, `moduleContent`).

### Question Fields

Only `id` and `type` are required. All other fields are optional — present only when set:
- **Text:** `label`, `hint`, `help`
- **Logic:** `required`, `validation`, `validation_msg`, `relevant`, `calculate`, `default_value`
- **Data:** `case_property_on`, `options`
- **Structure:** `children` (nested groups/repeats)

All text fields are plain `string`. XPath fields support `#form/`, `#case/`, and `#user/` hashtag shorthand. String literal values in XPath fields must be quoted (`'pending'`, not `pending`) — the validator catches bare words via Lezer parse tree analysis.

### Question Format

- `Question` is a recursive interface (`children?: Question[]`) supporting arbitrary nesting depth
- The Zod schema (`questionSchema`) is also recursive via `z.lazy()` — used for API input validation only, not LLM structured output
- SA tools with `parentId` build deeper structures during generation
- `default_value` → `<setvalue event="xforms-ready">` in XForm (one-time on load, unlike `calculate` which recalculates)
- `case_property_on: "<case_type>"` marks a question as saving to that case type (property name = question ID). When it matches the module's case type, it's a normal case property. When it names a different type, it triggers child case creation. The case name question must have `id: "case_name"`.

### Case-List-Only Modules

`case_list_only?: boolean` on `BlueprintModule` — marks a module as a case-list viewer with no forms. Used for child case types that have no follow-up workflow but still need a module (CommCare requires every case type to have one). Present on both `blueprintModuleSchema` and `scaffoldModulesSchema`.

### Close Case Format

- `{}` = unconditional close
- `{ question, answer }` = conditional close
- absent/undefined = no close

### CommCare Connect Config

App-level `connect_type?: 'learn' | 'deliver'` determines the app's Connect type. Form-level `connect?: ConnectConfig` opts individual forms into Connect (present = opted in, absent = not).

`ConnectConfig` has four independently optional sub-configs, each with an optional `id` field:
- **`learn_module`** (`id`, name, description, time_estimate) — the learning content module
- **`assessment`** (`id`, user_score XPath) — the assessment/quiz scoring
- **`deliver_unit`** (`id`, name, entity_id, entity_name) — the delivery entity
- **`task`** (`id`, name, description) — optional task metadata

The `id` field on each sub-config becomes the XForm wrapper element name, inner element `id` attribute, and bind path prefix (e.g. `/data/{id}`). IDs follow question ID rules (alphanumeric snake_case, starts with letter). Defaults: UI derives from app/module/form names via `toSnakeId()`; `deriveConnectDefaults()` falls back to `connect_learn`, `connect_assessment`, `connect_deliver`, `connect_task`.

**Learn apps:** `learn_module` and `assessment` are independent — a form can have either or both. Validation requires at least one. In production, learn modules and assessments are often in separate forms. The SA matches sub-configs to form content: educational content → `learn_module` only, quiz/test → `assessment` only, combined → both. Never add `learn_module` to a quiz-only form or `assessment` to a content-only form.

**Deliver apps:** `deliver_unit` is required. `task` is optional (controlled by a sub-toggle). `entity_id` and `entity_name` are auto-populated by `deriveConnectDefaults()` but user-visible and editable. The SA only sets `deliver_unit.name`.

All Connect forms get auto GPS capture (`orx:pollsensor` + `cc:location` in form metadata).

Scaffold schema has app-level `connect_type` (empty string sentinel for standard apps).

## Structured Output Constraints

The Anthropic schema compiler times out with >8 `.optional()` per array item (each creates an `anyOf` union in JSON Schema). The `addQuestions` tool schema uses a hybrid approach:

- **8 optional fields** (sparse, saves tokens): `hint`, `help`, `validation`, `validation_msg`, `relevant`, `calculate`, `default_value`, `options`
- **3 required sentinel fields** (almost always present, low cost): `label` (empty string), `required` (empty string), `case_property_on` (empty string)
- **`type`** uses `z.enum(QUESTION_TYPES)` (enums don't create `anyOf` unions)

Post-processing converts sentinels back to real values — see Content Processing below.

Test with: `npx tsx scripts/test-schema.ts`

## Content Processing (`contentProcessing.ts`)

Post-processing pipeline for structured output from form generation:

1. **`stripEmpty()`** — converts sentinel values (empty strings, false) back to undefined
2. **`buildQuestionTree()`** — converts flat `parentId`-based questions to nested `children` arrays
3. **`applyDefaults()`** — bakes case property defaults (type, label, hint, help, required, validation, options) into questions at generation time by matching question ID to case type property name. Also auto-sets `default_value` to `#case/{id}` for primary case properties in follow-up forms (excluding `case_name` and questions with `calculate`), making the preload visible in the UI and exported as `<setvalue>`. Accepts optional `formType` and `moduleCaseType` params for this. This is the only point where `case_types` is consulted — after generation, questions are self-contained. Also runs `unescapeXPath()` to sanitize HTML entities (`&gt;` → `>`) LLMs sometimes emit.
4. **`processSingleFormOutput()`** — chains all three in order

### XPath and Vellum Hashtags

Questions use `#case/property_name` and `#user/property_name` shorthand in XPath fields (`relevant`, `calculate`, `validation`, `default_value`). The expander handles expansion to full instance XPath — see `lib/services/CLAUDE.md` for the dual-attribute Vellum pattern.
