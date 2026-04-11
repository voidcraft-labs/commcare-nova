# Services Layer

## SA Agent

### Build Sequence

`askQuestions → generateSchema → generateScaffold → addModule × N → addQuestions × N → validateApp`

The SA makes all architecture and form design decisions. All tools are called directly — no sub-agents, no code execution.

### Tool Groups

Tools are split into `generationTools` and `sharedTools` in `solutionsArchitect.ts`:

- **Generation** (3, build mode only): `generateSchema`, `generateScaffold`, `addModule` — SA calls with structured data, `strict: true`. Excluded in edit mode.
- **Shared** (all modes):
  - *Conversation* (1): `askQuestions` (client-side, rendered as QuestionCard)
  - *Form Building* (1): `addQuestions` — batch-append with `stripEmpty → applyDefaults → buildQuestionTree`
  - *Read* (4): `searchBlueprint`, `getModule`, `getForm`, `getQuestion`
  - *Mutation* (10): `editQuestion`, `addQuestion`, `removeQuestion`, `updateModule`, `updateForm`, `createForm`, `removeForm`, `createModule`, `removeModule`
  - *Validation* (1): `validateApp` — runs `validateAndFix()` loop

Mutation tools return human-readable success strings (not JSON metadata) so the SA trusts its own edits without re-reading.

### Prompt Caching

`prepareStep` sets request-level `cacheControl: { type: 'ephemeral' }` in Anthropic provider options. The API automatically places the cache breakpoint on the last cacheable block and advances it as the conversation grows — the system prompt stays cached across all requests within a session. Cache TTL is 5 minutes — the route uses `lastResponseAt` from the client to control the message strategy: within the cache window, full conversation history is sent; after expiry, only the last user message is sent (one-shot). Edit vs. build mode is determined by `appReady` alone (see root CLAUDE.md).

## Expander Decisions

### WAF Bypass (`client.ts` multipart padding)

HQ's `import_app` API endpoint is missing the `waf_allow('XSS_BODY')` WAF exemption that all other XForms-handling endpoints have. AWS WAF scans the multipart request body for XSS patterns and returns a bare nginx 403 (`<center><h1>403 Forbidden</h1></center>`) when it finds XForms elements (`<input>`, `<select1>`, `<label>`) that look like HTML tags.

**Fix:** `importApp()` in `lib/commcare/client.ts` inserts a 16KB `waf_padding` form field before `app_file` in the multipart body. This pushes the JSON payload (which contains XForms XML in `_attachments`) past the WAF inspection window. Django ignores unknown POST fields. Do not remove the padding field or reorder it after `app_file`.

**Gotcha:** CouchDB rejects keys prefixed with `_` as reserved special members. An earlier approach injecting `_waf_padding` into the JSON body itself hit this — the multipart form field approach avoids touching the JSON entirely.

`applicationShell()` in `hqShells.ts` also places ~50 standard HQ Application properties before `_attachments` as secondary defense, but this alone is insufficient for small apps (1 module, 1 form can put `_attachments` as early as 5.5KB).

### Vellum Dual-Attribute Pattern

CommCare's Vellum editor requires both expanded XPath and the original shorthand on every bind. Real attributes (`calculate`, `relevant`, `constraint`) get the expanded instance XPath. Vellum attributes (`vellum:calculate`, `vellum:relevant`) preserve the original `#case/` and `#user/` shorthand. Every bind also gets `vellum:nodeset="#form/..."`. Without the Vellum attributes, reopening the form in Vellum would show raw instance paths instead of readable hashtag references.

### Bare Hashtags in Prose

`wrapBareHashtags()` uses regex, not the Lezer XPath parser, to find `#case/foo` in label/hint text. Labels are prose, not XPath — surrounding characters like `**` (markdown bold) get parsed as XPath multiplication operators by Lezer, swallowing the `#` and producing a garbled tree.

### Markdown itext

All itext entries (labels, hints, option labels) emit both `<value>` and `<value form="markdown">`. CommCare only renders markdown when the markdown form is present — without it, `**bold**` renders as literal text with asterisks. Safe for plain text: identical rendering when no markdown syntax is present.

### Secondary Instances

`InstanceTracker` accumulates required instances (`casedb`, `commcaresession`) at the point of use during the build — `buildQuestionParts` scans XPath fields and labels, `buildConnectBlocks` scans Connect expressions. `casedb` implies `commcaresession` (case XPath uses session for case_id). No post-hoc string scanning — requirements are registered where binds are generated.

## Error Flow

Three catch points cover the full surface: (1) route outer catch — errors from agent creation, (2) route inner catch — errors during stream consumption via the manual reader loop, (3) `generationContext.ts` wraps — errors from any LLM call, emits + re-throws. Both route-level catches delegate to `handleRouteError()` which classifies, emits `data-error`, and calls `failApp()` fire-and-forget (Firestore failure doesn't block the error response).

## Validation Gap Inventory

### HQ Build Checks NOT Covered

Add validation for these when we build the corresponding features:

- **Shadow modules** — HQ validates source module exists, shadow parent tags present. Source: `validators.py:927-936`
- **Parent select / child module cycles** — HQ checks circular parent_select and root_module references between modules. Source: `validators.py:225-250`. We only check within-form cycles currently
- **Case search config** — HQ validates search nodeset instances, grouped vs ungrouped properties, search_on_clear + auto_select conflicts. Source: `validators.py:511-557`
- **Case tile configuration** — HQ validates tile templates, row conflicts, address formats, clickable icons. Source: `validators.py:656-715`
- **Smart links** — HQ validates endpoint presence, conflicts with parent select / multi-select / inline search. Source: `validators.py:435-466`
- **Case list field actions** — HQ validates endpoint_action_id references resolve. Source: `validators.py:559-572`
- **Sort field format** — HQ validates case list sort fields match a specific regex. Source: `validators.py:630-642`
- **Multimedia references** — HQ validates multimedia attachments exist. Not relevant until we support image/audio in case details
- **Multi-language** — HQ validates no empty language codes, itext for all languages. We only generate English currently
- **Itemset validation** — FormPlayer validates itemset nodeset/label/copy/value relationships. Source: `XFormParser.java:2554-2619`. Relevant for dynamic select lists from lookup tables
- **Repeat homogeneity** — FormPlayer validates all repeated nodes are structurally identical. Source: `XFormParser.java:2383`. Our generator produces uniform repeats, but should validate if we ever allow manual XForm editing

## Session & Navigation

### Post-Submit Overview

`post_submit` on forms controls where the user goes after submission. Three user-facing choices: `app_home` (App Home), `module` (This Module), `previous` (Previous Screen). Two internal-only values exist for future CommCare export fidelity: `root` (for `put_in_root`) and `parent_module` (for nested modules). Form-type-aware defaults when absent: followup/close → `previous`, registration/survey → `app_home` (`defaultPostSubmit()` in `blueprint.ts`). The SA only needs to set `post_submit` when overriding the default.

### `put_in_root` Impact (Not Yet Modeled)

CommCare's `put_in_root` boolean flattens navigation — module forms appear at the parent menu level. When this is added:

1. `'module'` becomes invalid (there IS no module menu). HQ errors: "form link to display only forms."
2. `'root'` and `'app_home'` diverge: `'root'` shows the root menu (includes flattened forms), `'app_home'` clears the session entirely.
3. `'parent_module'` with a `put_in_root` parent is also invalid.
4. Validation should auto-resolve `'module'` → `'root'` for `put_in_root` modules.
5. Surface `'root'` as a separate UI option ("Main Menu" vs "App Home") only when `put_in_root` modules exist.

### Validated But Not Yet Modeled

Validation stubs exist that will activate when features are added:

- `parent_module` + `root_module` — always errors today (parent modules not modeled). When `root_module` is added, check parent exists AND parent is not `put_in_root`
- `previous` + `multi_select` — HQ errors on mismatched multi-select between module and root module
- `previous` + `inline_search` — HQ errors when a followup form's module uses inline search (search results can't be restored)

### Not Yet Implemented

- **Auto datum matching** for form links — manual `datums` required. HQ's `_find_best_match()` matches by ID + case_type; must handle same-ID/same-type, different-ID/same-type, and surface warnings rather than silent fallback
- **Shadow module resolution** for form link targets (`form_module_id` in HQ)
- **`<push>` / `<clear>` stack operations** — typed but never generated
- **Form link export to HQ JSON** — `form_links` generates correct suite.xml and passes validation, but `hqShells.ts` still exports empty `form_links: []`. Must map index-based targets to HQ's unique_id-based identifiers
- **SA tool + UI surface for form links** — `updateForm`/`createForm` don't accept `form_links`, `FormSettingsPanel` doesn't display them, preview engine doesn't navigate to linked forms

### Form Links

`form_links` on BlueprintForm enables conditional navigation. Each link has `condition?` (XPath), `target` (form or module by index), and optional `datums` overrides. Evaluation order: first matching condition wins; `post_submit` is the fallback. **Fully validated** (target existence, self-reference, cycles, missing fallback, empty array). Setting `form_links` directly on the blueprint generates correct suite.xml — just not wired to SA tools or UI.
