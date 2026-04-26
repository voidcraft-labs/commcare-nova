# lib/commcare

One-way emission boundary: `BlueprintDoc` → CommCare wire formats (XForm XML, `HqApplication` JSON, `.ccz` archive). The only package in `lib/` that imports CommCare's vocabulary (HQ shell shapes, `doc_type` strings, `case_property`, XPath functions, session datums, identifier rules). A Biome `noRestrictedImports` rule enforces the one-way direction.

## Public surface

- `expandDoc(doc)` → `HqApplication` JSON for HQ import (`./expander`).
- `compileCcz(hqJson, appName, doc)` → `.ccz` archive as `Buffer` (`./compiler`).
- `buildXForm(doc, formUuid, opts)` → XForm XML (`./xform`).
- `runValidation(doc)` → `ValidationError[]` (`@/lib/commcare/validator`).
- `parser`, `transpile`, term constants, `detectUnquotedStringLiteral` (`@/lib/commcare/xpath`).
- `listDomains`, `importApp` (`./client`); `encrypt`, `decrypt` (`./encryption`).
- Shared primitives re-exported from `./index.ts`: `constants`, `types`, `hqShells`, `hashtags`, `identifierValidation`, `session`, `formActions`, `deriveCaseConfig`, `xml`. The barrel stays client-safe: Node-only modules (`./compiler` via `adm-zip`; `./ids` via `node:crypto`) and the heavy emission pipeline (`./expander`, `./xform`) are imported from their explicit sub-paths so Turbopack can tree-shake them out of client bundles. The XPath engine, validator, encryption, and HQ HTTP client follow the same sub-path rule for the same reason.

## Allowlist

The set of allowed consumers is enforced by `biome.json`'s `noRestrictedImports` rule on `@/lib/commcare`. Read it there — keeping a hand-maintained copy here drifts.

## Subpackage layout

```
compiler.ts expander.ts formActions.ts deriveCaseConfig.ts session.ts
hashtags.ts ids.ts xml.ts constants.ts identifierValidation.ts hqShells.ts
types.ts client.ts encryption.ts fieldProps.ts
xform/{index,builder}.ts
validator/{index,runner,errors,fixes,typeChecker,functionRegistry,xformValidator,xpathValidator}.ts
validator/rules/{app,module,form,field}.ts
xpath/{grammar.lezer.grammar,parser,parser.terms,transpiler,typeInfer,detectUnquotedStringLiteral,index}.ts
xpath/passes/dateArithmetic.ts
```

`fieldProps.ts` is the one reading-helper the wire emitters share: a single untyped lookup over `Field`'s discriminated union for the optional string properties (`relevant`, `validate`, `calculate`, `default_value`, `required`, `hint`, `label`, `case_property`, `validate_msg`) — narrowing per kind at every call site would cascade N×M branches.

## Key design decisions

### Vellum dual-attribute pattern

CommCare's Vellum editor requires both expanded XPath AND the original shorthand on every bind. Real attributes (`calculate`, `relevant`, `constraint`) get the expanded instance XPath; `vellum:` attributes preserve the original `#case/` and `#user/` shorthand. Every bind also gets `vellum:nodeset="#form/..."`.

### Bare hashtags in prose

Hashtag wrapping in label/hint text uses regex, NOT the Lezer XPath parser. Labels are prose; surrounding characters like `**` (markdown bold) parse as XPath operators, which swallows the `#`.

### Markdown itext

All itext entries (labels, hints, option labels) emit both `<value>` and `<value form="markdown">`. Safe for plain text: identical rendering when no markdown syntax is present.

### Secondary instances

`casedb` and `commcaresession` are accumulated at the point of use — XPath field + label scans, Connect expression scans. `casedb` implies `commcaresession`.

### `post_submit` defaults

Controls post-submit navigation. Three user-facing values: `app_home`, `module`, `previous`. Two internal values (`root`, `parent_module`) exist for export fidelity. Form-type defaults when absent: followup/close → `previous`, registration/survey → `app_home`. The SA only sets `post_submit` when overriding the default.

### Form links

`form_links` on a form enables conditional navigation: `condition?` (XPath) + `target` (form or module by uuid) + optional `datums`. First matching condition wins; `post_submit` is the fallback. Fully validated.

## CommCare HQ upload

Upload creates a new app each time — HQ has no atomic update API. The HQ base URL is hardcoded (prevents SSRF). User API keys are KMS-encrypted at rest via `./encryption`. Domain slugs are validated against HQ's legacy regex to prevent path traversal in the import URL.

Two workarounds live on the import endpoint because HQ's decorators on it are incomplete:

- **CSRF:** HQ is missing `@csrf_exempt`. The client fetches a token from the unauthenticated login GET and sends it on the POST. Harmless if HQ fixes it upstream.
- **WAF:** HQ is missing the XSS-body exemption. AWS WAF blocks XForms-looking tags in multipart bodies. Fix: a 16KB padding form field inserted before the app file pushes JSON past the WAF inspection window. Padding field name must NOT start with `_` (CouchDB reserved). Symptom of a block: bare nginx 403 — distinct from Django's verbose CSRF 403.

## Not-yet-modeled

HQ features the pipeline does not cover yet — the validator's `app`/`module`/`form`/`field` rules gate additions as they land:

- Shadow modules, parent-select cycles, case-search config
- Case tile configuration, smart links, case list field actions
- Sort field format regex, multimedia, multi-language
- Itemset nodeset/label/copy/value relationships
- Repeat homogeneity

Validation stubs that activate when features land:
- `parent_module` + `root_module` (parent modules not modeled yet)
- `previous` + `multi_select`, `previous` + `inline_search`

### `put_in_root` impact (not yet modeled)

When added: `'module'` becomes invalid (no menu), `'root'` diverges from `'app_home'`, `'parent_module'` with a `put_in_root` parent is invalid. Validation should auto-resolve `'module'` → `'root'` for `put_in_root` modules.
