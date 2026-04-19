# Services Layer

Utility surfaces that cut across the builder: CommCare compile/validate (`cczCompiler`, `hqJsonExpander`, `xformBuilder`, `commcare/*`), per-form derivation helpers (`deriveCaseConfig`, `connectConfig`, `questionPath`), and UI plumbing (`toastStore`, `keyboardManager`, `formActions`, `resetBuilder`). Generation logging moved to `lib/log/` — see its CLAUDE.md for the event log boundary.

The Solutions Architect and its generation loop moved to `lib/agent/` in Phase 3 — see `lib/agent/CLAUDE.md` for the SA tool-loop rules, prompt caching, mutation-emission surface, and provider-options shape.

## Expander decisions

### Vellum dual-attribute pattern

CommCare's Vellum editor requires both expanded XPath AND the original shorthand on every bind. Real attributes (`calculate`, `relevant`, `constraint`) get the expanded instance XPath; `vellum:` attributes preserve the original `#case/` and `#user/` shorthand. Every bind also gets `vellum:nodeset="#form/..."`. Without the Vellum attributes, reopening a form in Vellum shows raw instance paths instead of readable hashtag references.

### Bare hashtags in prose

Hashtag wrapping in label/hint text uses regex, NOT the Lezer XPath parser. Labels are prose, not XPath — surrounding characters like `**` (markdown bold) parse as XPath multiplication operators by Lezer, which swallows the `#` and produces a garbled tree.

### Markdown itext

All itext entries (labels, hints, option labels) emit both `<value>` and `<value form="markdown">`. CommCare only renders markdown when the markdown form is present — without it, `**bold**` renders as literal asterisks. Safe for plain text: identical rendering when no markdown syntax is present.

### Secondary instances

Required instances (`casedb`, `commcaresession`) are accumulated at the point of use during the build: XPath field + label scans during question-part generation, Connect expression scans during connect-block generation. `casedb` implies `commcaresession` (case XPath uses session for case_id). No post-hoc string scanning — requirements are registered where binds are generated.

## Error flow

Three catch points cover the full surface:

1. Route outer catch — errors from agent creation
2. Route inner catch — errors during stream consumption via the manual reader loop
3. Generation-context wrap — errors from any LLM call (emits + re-throws)

Both route-level catches delegate to a shared error handler that classifies, emits an error data part, and calls the fail-app function fire-and-forget (Firestore failure must not block the error response).

## Session & navigation quirks

### `post_submit` defaults

Controls where the user lands after form submit. Three user-facing values: `app_home`, `module` (this module), `previous`. Two internal values exist for CommCare export fidelity: `root` (for `put_in_root`) and `parent_module` (nested modules). Form-type defaults when absent: followup/close → `previous`, registration/survey → `app_home`. The SA only sets `post_submit` when overriding the default.

### Form links

`form_links` on a form enables conditional navigation: `condition?` (XPath) + `target` (form or module by index) + optional `datums` overrides. Evaluation order: first matching condition wins; `post_submit` is the fallback. Fully validated (target existence, self-reference, cycles, missing fallback, empty array). Setting `form_links` directly on the blueprint generates correct suite.xml — the SA tool surface and HQ export (unique-id mapping) are not yet wired.

## Not-yet-implemented (watch when adding features)

HQ build checks we DON'T cover — add when the corresponding feature lands:

- Shadow modules (source module existence, shadow parent tags)
- Parent-select / child-module cycles between modules (we only check within-form cycles)
- Case-search config (search nodeset instances, grouped/ungrouped properties, search_on_clear + auto_select conflicts)
- Case tile configuration (tile templates, row conflicts, address formats)
- Smart links (endpoint presence, conflicts with parent select / multi-select / inline search)
- Case list field actions (endpoint_action_id resolution)
- Sort field format regex
- Multimedia attachments (once image/audio is supported)
- Multi-language (once non-English is generated)
- Itemset nodeset/label/copy/value relationships (dynamic select lists from lookup tables)
- Repeat homogeneity (structurally identical repeated nodes — relevant if we ever allow manual XForm editing)

Validation stubs that activate when features land:

- `parent_module` + `root_module` — errors today because parent modules aren't modeled; when `root_module` is added, check parent exists AND parent is not `put_in_root`
- `previous` + `multi_select` — HQ errors on mismatched multi-select between module and root module
- `previous` + `inline_search` — HQ errors when a followup form's module uses inline search (search results can't be restored)

### `put_in_root` impact (not yet modeled)

`put_in_root` flattens navigation (module forms appear at parent menu level). When it's added:

1. `'module'` becomes invalid (no module menu). HQ errors: "form link to display only forms."
2. `'root'` and `'app_home'` diverge: `'root'` shows the root menu (incl. flattened forms); `'app_home'` clears session.
3. `'parent_module'` with a `put_in_root` parent is invalid.
4. Validation should auto-resolve `'module'` → `'root'` for `put_in_root` modules.
5. Surface `'root'` as a separate UI option ("Main Menu" vs "App Home") only when `put_in_root` modules exist.
