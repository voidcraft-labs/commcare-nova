# Schemas & Content Processing

## API Schemas (`apiSchemas.ts`)

Zod schemas for API route input validation:
- `chatRequestSchema` — validates `apiKey` (optional — omitted for authenticated users), `blueprint` (reuses `appBlueprintSchema`), `pipelineConfig` (typed to match `PipelineStageConfig`). Messages are typed as `UIMessage[]` separately — they come from the AI SDK, not validated by us. API key resolution (session → server key vs body → BYOK) is handled by `resolveApiKey()` in `lib/auth-utils.ts`, not the schema.
- `modelsRequestSchema` — validates `apiKey` (optional — same dual-auth pattern).

## Blueprint Schema (`blueprint.ts`)

Zod schemas for `AppBlueprint` and generation output schemas (`caseTypesOutput`, `scaffoldModules`, `moduleContent`).

**Shared exports consumed by tool schemas:**
- `questionFields` — canonical Zod field definitions for all question properties (id, type, label, hint, etc.). SA tool schemas in `toolSchemas.ts` derive from these directly.
- `QUESTION_DOCS` — canonical description strings for every question field. Single source of truth for all SA-facing guidance (type selection rules, `#form/` reference syntax, XPath quoting, reserved case properties). Update descriptions here — they propagate to blueprint validation and all SA tools automatically.
- `selectOptionSchema` — shared `{ value, label }` schema used by blueprint and tool schemas.

### Question Fields

Only `id` and `type` are required. All other fields are optional — present only when set:
- **Text:** `label`, `hint`
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

### Post-Submit Navigation

`post_submit?: PostSubmitDestination` on `BlueprintForm` — controls where the user goes after submitting the form. Also serves as the fallback when `form_links` have conditional links that don't match.

**User-facing values** (exposed in UI dropdown and SA tools via `USER_FACING_DESTINATIONS`):
- `'default'` — App Home
- `'module'` — This Module (back to the module's form list)
- `'previous'` — Previous Screen (back to where the user was, e.g. case list for followup)

**Internal-only values** (accepted by the schema for CommCare export fidelity, not exposed to users):
- `'root'` — Currently same as `'default'`. When `put_in_root` is modeled on modules, `'root'` navigates to the root menu (which includes forms from `put_in_root` modules) while `'default'` clears the entire session. The system will auto-resolve when needed.
- `'parent_module'` — Currently falls back to `'module'`. When nested modules (`root_module`) are modeled, navigates to the parent module's menu. The system will auto-resolve when needed.

**`put_in_root` impact (not yet modeled):** CommCare's `put_in_root` boolean on modules flattens navigation — the module's forms appear at the parent menu level instead of inside a module menu. When this is set, `'module'` becomes invalid (there's no module menu to navigate to). The build should auto-resolve to `'root'` and validation should warn. See `lib/services/CLAUDE.md` "Session & Navigation" for the full gap inventory.

Present on both `blueprintFormSchema` (full `POST_SUBMIT_DESTINATIONS`) and `scaffoldModulesSchema` (user-facing `USER_FACING_DESTINATIONS` only).

### Form Links

`form_links?: FormLink[]` on `BlueprintForm` — conditional navigation to other forms/modules after submission. Each `FormLink` has:
- `condition?: string` — XPath condition (omit = always matches)
- `target: { type: 'form', moduleIndex, formIndex } | { type: 'module', moduleIndex }` — where to navigate
- `datums?: FormLinkDatum[]` — manual datum overrides (`{ name, xpath }`) for when auto-matching fails

When `form_links` is present, links are evaluated in order — the first matching condition wins. `post_submit` serves as the fallback when no condition matches.

**Validation is fully implemented** — target existence, self-reference, circular links (A→B→A), missing fallback, empty array. **Not yet exposed** in the SA tools, FormSettingsPanel UI, or preview engine navigation. The session module generates correct suite.xml `<stack>` operations when `form_links` are set directly on the blueprint.

### Close Case Format

- `{}` = unconditional close
- `{ question, answer }` = conditional close
- absent/undefined = no close

### CommCare Connect Config

App-level `connect_type?: ConnectType` (`'learn' | 'deliver'`) determines the app's Connect type. `ConnectType` is exported from `blueprint.ts` as the single source of truth. Form-level `connect?: ConnectConfig` opts individual forms into Connect (present = opted in, absent = not).

`ConnectConfig` has four independently optional sub-configs, each with an optional `id` field:
- **`learn_module`** (`id`, name, description, time_estimate) — the learning content module
- **`assessment`** (`id`, user_score XPath) — the assessment/quiz scoring
- **`deliver_unit`** (`id`, name, entity_id, entity_name) — the delivery entity
- **`task`** (`id`, name, description) — optional task metadata

The `id` field on each sub-config becomes the XForm wrapper element name, inner element `id` attribute, and bind path prefix (e.g. `/data/{id}`). IDs follow question ID rules (alphanumeric snake_case, starts with letter). Defaults: UI derives from app/module/form names via `toSnakeId()`; `deriveConnectDefaults()` falls back to `connect_learn`, `connect_assessment`, `connect_deliver`, `connect_task`.

**Learn apps:** `learn_module` and `assessment` are independent — a form can have either or both. Validation requires at least one. In production, learn modules and assessments are often in separate forms. The SA matches sub-configs to form content: educational content → `learn_module` only, quiz/test → `assessment` only, combined → both. Never add `learn_module` to a quiz-only form or `assessment` to a content-only form.

**Deliver apps:** `deliver_unit` is required. `task` is optional (controlled by a sub-toggle). `entity_id` and `entity_name` are auto-populated by `deriveConnectDefaults()` but user-visible and editable. The SA only sets `deliver_unit.name`.

All Connect forms get auto GPS capture (`orx:pollsensor` + `cc:location` in form metadata).

Scaffold schema has app-level `connect_type` as `z.enum(['learn', 'deliver', ''])` (empty string sentinel for standard apps). The enum constraint prevents garbled model output — `z.string()` with `strict: true` only enforces "any string" in JSON Schema, while the enum forces the model to pick a valid value.

## Tool Schemas (`toolSchemas.ts`)

SA tool input schemas for question fields — derived from `questionFields` in `blueprint.ts`. Three shapes for three tool contexts:

- **`addQuestionsQuestionSchema`** — batch generation. Flat with `parentId` for tree building. 2 sentinel fields (label, required) are required `z.string()` instead of optional, keeping optional count at 8 (Anthropic compiler limit). Post-processing via `stripEmpty()` converts empty strings back.
- **`editQuestionUpdatesSchema`** — partial updates. All fields optional. XPath fields (`relevant`, `calculate`, `default_value`) and `options`/`case_property_on` accept `null` to clear.
- **`addQuestionQuestionSchema`** — single insertion. Same shape as `questionFields` (no children, no sentinels).

Also exports `addQuestionsSchema` (wraps question array with module/form indices) used by `test-schema.ts`.

## Structured Output Constraints

The Anthropic schema compiler times out with >8 `.optional()` per array item (each creates an `anyOf` union in JSON Schema). The sentinel pattern in `addQuestionsQuestionSchema` works around this — see Tool Schemas above.

Test with: `npx tsx scripts/test-schema.ts`

## Content Processing (`contentProcessing.ts`)

Post-processing pipeline for structured output from form generation:

1. **`stripEmpty()`** — converts sentinel values (empty strings, false) back to undefined
2. **`buildQuestionTree()`** — converts flat `parentId`-based questions to nested `children` arrays
3. **`applyDefaults()`** — bakes case property defaults (type, label, hint, required, validation, options) into questions at generation time by matching question ID to case type property name. Also auto-sets `default_value` to `#case/{id}` for primary case properties in follow-up forms (excluding `case_name` and questions with `calculate`), making the preload visible in the UI and exported as `<setvalue>`. Accepts optional `formType` and `moduleCaseType` params for this. This is the only point where `case_types` is consulted — after generation, questions are self-contained. Also runs `unescapeXPath()` to sanitize HTML entities (`&gt;` → `>`) LLMs sometimes emit.
4. **`processSingleFormOutput()`** — chains all three in order

### XPath and Vellum Hashtags

Questions use `#case/property_name` and `#user/property_name` shorthand in XPath fields (`relevant`, `calculate`, `validation`, `default_value`). The expander handles expansion to full instance XPath — see `lib/services/CLAUDE.md` for the dual-attribute Vellum pattern.
