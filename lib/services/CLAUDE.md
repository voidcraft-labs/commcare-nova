# Services Layer

A grab-bag of shared helpers that don't yet have a domain-specific home:

- `connectConfig.ts` — Connect-config defaults derivation. Operates on the nested wire form and is called from the validation loop before any domain rules run.
- `fieldPath.ts`, `resetBuilder.ts`, `builder.ts` — doc-facing helpers the builder UI leans on.
- `toastStore.ts`, `keyboardManager.ts` — UI singletons (toast queue + keyboard shortcut registry).

The expander, CCZ compiler, XForm emitter, form-action / case-reference builders, and case-config derivation all live at `lib/commcare/` — the CommCare compile pipeline is not owned here.

The Solutions Architect and its generation loop live at `lib/agent/`; the CommCare wire-format primitives + validator live at `lib/commcare/`; generation logging lives at `lib/log/`.

## Session & navigation invariants

Emission-side behavior that the compile pipeline depends on. These rules live on the emitter + session modules inside `lib/commcare/` and are restated here for the utilities in this directory that care about them:

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
