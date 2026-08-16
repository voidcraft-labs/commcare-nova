# Multilingual app authoring and translation

## Current state

This is the binding implementation plan for multilingual CommCare Nova apps.
The architecture is approved. The language foundation and the complete manual
authoring/runtime path are implemented on the current stack: the domain overlay,
exact Classic picker catalog, translation-unit inventory and resolver, granular
mutation dialect, validity rules, exact JSON persistence, replay/diff behavior,
shared SA/MCP read/write tools, localized CommCare emission and oracles, global
Builder language lens, Languages workspace, inline target editing, Preview,
coverage diagnostics, and focused tests are the current source of truth. The
manual-language public documentation is part of that surface. The durable AI
translation orchestrator, its capability-specific documentation, and plugin
delivery build on those final APIs in the remaining stack layers.

Keep this document as a description of the best current design and the actual
implementation state. When implementation teaches us something better, rewrite
the affected section in place. Do not append a decision log or preserve an
obsolete design for history; git already preserves that history.

The feature ships as one product capability across Nova and `nova-plugin`.
Implementation may use a stack of independently reviewable pull requests, but
every PR boundary must be a clean, valid, production-quality state. No PR may
introduce a temporary schema, compatibility adapter, feature dialect, or other
transitive implementation that a later PR removes. The complete stack is merged
and deployed as one coordinated feature, with the plugin release immediately
after Nova is live and verified.

## Product outcome

An app has an ordered catalog of languages, one canonical source language, and
one runtime default language. Authors can add a language by copying every
currently effective string from any existing language, translate it manually,
or ask Nova to translate it when the selected direction is supported well.

The Builder, Preview, Solutions Architect, MCP API, AI translator, validator,
and CommCare compiler all consume one derived translation-unit inventory. A
string cannot be visible to a worker through a supported static wire surface
while remaining undiscoverable to either the translation workspace or an
agent.

Nova does not store language pairs. “English to Spanish” is an operation whose
source and target are two members of the app's language catalog. Storing pairs
would duplicate a language's content and make three-language apps ambiguous.

The existing worker-facing values in `BlueprintDoc` remain the canonical source
content. Multilingual support is an app-level overlay, not CommCare-style
language maps threaded through every field, form, and mutation. CommCare's
localized maps and resources exist only at the one-way `lib/commcare` emission
boundary.

## Binding CommCare facts

These facts constrain emission only. They do not prescribe Nova's authoring
model.

- CommCare HQ accepts a lower-case two- or three-letter language code with an
  optional lower-case suffix. The binding source is
  `commcare-hq/corehq/apps/app_manager/models/applications.py::validate_lang`.
  Nova uses the stricter nonempty-suffix form
  `^[a-z]{2,3}(?:-[a-z]+)?$` and normalizes user input to lower case before it
  becomes identity.
- Nova vendors Classic's picker data byte-for-byte from
  `commcare-hq/submodules/langcodes/langs.json`; the reviewed source snapshot
  and `config/commcare-classic-languages.json` both have SHA-256
  `50cc621456e6e7a1b14afcbf5cccaa5a59b03f82271fc4d8a80bf6756ad5e4a4`.
  The vendored file is formatter-excluded so source provenance remains directly
  verifiable. It supplies discovery names and Classic's preferred two- versus
  three-letter picker code, but it is not an authoring allowlist.
- The first member of `Application.langs` is the runtime default language.
  Module, form, detail, and Search labels are language maps in the HQ JSON.
- An XForm itext block contains one `<translation lang="...">` per language.
  Each language is unique and at most one translation is marked default. With
  no explicit default JavaRosa selects the first translation. The binding
  sources are `commcare-core`'s `XFormParser::parseIText`,
  `XFormParser::parseTranslation`, and `FormDef::initLocale`.
- JavaRosa's `Localizer(true, true)` resolves through the default locale, but
  Nova emits a complete effective table for every configured language. Runtime
  fallback is not Nova's authoring or completeness model.
- CommCare Android already exposes app-level and in-form locale selection.
  `ChangeLocaleUtil::getLocaleCodes` reads the installed locales and
  `FormEntryDialogs` changes a form's language. Formplayer likewise validates
  requested locales in `SessionUtils::setLocale` and changes an active form in
  `FormSession::changeLocale`.
- CommCare language menus resolve each language code through app strings.
  `commcare-hq/corehq/apps/app_manager/app_strings.py::_create_custom_app_strings`
  supplies language names and `lang.current`. Nova must emit the equivalent
  resources for a useful picker in a direct CCZ.
- The app's own display name needs localized app-string overrides in addition
  to the unlocalized HQ `Application.name` authoring value.
- Connect learn-module, delivery-unit, and task names/descriptions are plain
  data elements inside the XForm. The current accepted wire has no per-locale
  carrier for them. Nova must report this limitation rather than pretend those
  values were translated.

## Nova language model

`BlueprintDoc` gains an optional localization value. Absence has one exact
meaning for legacy apps: source `en`, default `en`, ordered languages `[en]`,
and no translation overlays. The first language mutation materializes that
effective state, and returning to that exact legacy state dematerializes the
optional value again. The database has an optional `apps.localization` JSONB
root added by an ordinary schema migration; existing rows remain null and need
no data migration or reinterpretation of their text.

The persisted shape is conceptually:

```ts
interface AppLocalization {
  sourceLanguage: LanguageCode;
  defaultLanguage: LanguageCode;
  languageOrder: LanguageCode[];
  languages: Record<LanguageCode, AppLanguage>;
  translations: Record<LanguageCode, Record<TranslationUnitId, TranslationEntry>>;
}

interface AppLanguage {
  code: LanguageCode;
  name: string; // worker-facing endonym, for example “Español”
  direction: "ltr" | "rtl";
}

interface TranslationEntry {
  value: LocalizedValue;
  sourceFingerprint: string;
  origin: "copied" | "ai" | "human";
  review: "needs-review" | "reviewed";
  translatedFrom: LanguageCode;
}
```

These are the implemented domain names and semantics:

- Language code is the language's stable external identity. Changing a code is
  remove-and-add, because CommCare also treats it as locale identity.
- The source language describes the canonical values already stored on normal
  domain entities.
- The default language controls runtime start-up and is always first in
  `languageOrder`. It may differ from the source language.
- The source language is not represented again in `translations`.
- The source language cannot be removed. The default must be changed before
  removing the current default.
- A single-language app may relabel its source/default language. Once target
  translations exist, changing canonical source language is not offered as a
  casual metadata edit.
- The picker contains every ISO language code in CommCare Classic's supported
  language catalog, with endonyms and direction metadata. A wire-valid custom
  regional code remains possible wherever Classic accepts it.
- Every language CommCare Classic supports is available for manual authoring,
  copy-from-existing, Preview, and export. AI capability policy governs only
  whether Nova offers automatic translation for an exact source→target
  direction; it can never make a Classic-supported language unavailable.
- `translatedFrom` is historical provenance. It may continue to name a source
  language that was later removed; target overlay keys, not provenance values,
  are what remain closed over the current catalog.

## Translation units and inventory

`lib/domain` owns the pure `collectTranslationUnits(doc)` derivation,
`collectLocalizedTranslationUnits(doc, language)` status projection, and
`resolveTranslationUnitValue(doc, language, id)` effective-value resolver.
Every other surface consumes them rather than walking display slots
independently.

A translation unit contains:

- an opaque stable `TranslationUnitId` derived from the owning identities and
  semantic slot;
- the value kind and source value;
- its current explicit and effective target values;
- a deterministic source fingerprint;
- status and provenance;
- its role, such as app name, field label, hint, help, validation message,
  option label, case-list heading, interval text, Search prompt, or Search
  action copy;
- a source-language breadcrumb through module, form, field, column, or Search
  screen;
- relevant context such as field kind, option value, sibling label, and
  authored constraint;
- value-specific rules, including whether blank content is legal and which
  reference tokens must survive.

Existing UUIDs identify app structure wherever possible. Nested values without
UUID identity, such as an ID-mapping row or case-property option, use their
existing stable semantic key under the UUID-bearing owner. Classic permits a
case-property catalog to repeat one stored value, so later same-value
occurrences add their zero-based same-value ordinal: every legal label stays
injective while the first occurrence retains its established identity. The
mutation that changes such a key also remaps or removes the corresponding
translation entry atomically. Deleting an owner prunes its overlay entries as a
deterministic dependent effect once at the end of that same replayed batch;
per-entry translation writes do not rescan the full inventory. Source text
edits preserve the unit and the old overlay as out of date. Orphan translation
entries are not a valid stored state.

The unit registry is exhaustive over worker-facing display slots and derived
defaults. A reviewed slot classification and fixtures containing every carrier
make adding a new display-text schema slot without a localization decision a
test failure.

### Reference-bearing prose

`ProseTemplate` remains structured. Translation input exposes its reference
atoms as protected tokens with friendly renderings, for example `REF_1`
alongside “the Patient name answer.” Translation output may reorder tokens for
the target grammar but must contain each token exactly as many times as the
source. Human editing uses a reversible backslash escape for literal backslashes
and text that exactly resembles a protected token, so every literal remains
representable without confusing it for structure. The server maps the tokens
back to the original typed field, case, user property, or external-user
reference.

The inventory review editor owns the validity of the text currently visible in
its textarea, not merely the last parseable draft. It disables commit while a
protected token is missing or duplicated. A Missing unit may commit an explicit
source-identical human value, because equality does not mean the fallback was
reviewed. Inline Builder editors likewise retain a rejected target draft and
surface the commit-gate reason. Inventory search matches source, effective
target, and retained explicit target text. The structure-tree search consumes
the same localized values it renders. Both source and target comparison panes
use their own language direction, and language-selection/search controls expose
their names and selected state to assistive technology.

Neither AI nor human tooling reparses rendered `#form/...` text. UUID-backed
identity moves and display renames leave the source and target reference atoms,
unit identity, and fingerprint unchanged. The semantic case-property rename
command rewrites both source and target reference atoms and refreshes a current
entry's fingerprint without falsely declaring the surrounding translation
stale.

## Effective values and status

Adding target language B from existing language A is one atomic language
operation. It copies every currently effective A value into explicit B entries
and records `origin: copied`, `translatedFrom: A`, and `needs-review`. B is
never born blank, and the operation works for any existing A/B pair.

Agent/MCP `set` writes echo the current source fingerprint returned by the
inventory read. `review` writes independently echo both that current source
fingerprint and the prior explicit entry's fingerprint/value. Either concurrent
source or target change refuses the atomic batch instead of binding a
translation or approval to content the caller did not inspect.

Status is derived per unit:

- **Missing**: no explicit target entry exists.
- **Needs review**: an explicit copied or AI entry matches the current source
  fingerprint but has not been reviewed.
- **Out of date**: the entry's source fingerprint no longer matches.
- **Ready**: an explicit reviewed entry matches the current source.

Missing and out-of-date target content resolves to the current canonical source
value in Builder, Preview, and emission. Nova does not show a semantically stale
translation merely because it is in the target language. The old value remains
available in the translation workspace for comparison. “Keep translation” can
review the old value against the new source without forcing a textual edit.

A direct human edit is reviewed. Copied and AI-authored values need review.
Review status is advisory rather than a draft/release gate: every document is
valid and every language has a complete effective projection at every commit.

Existing labels containing two or more stacked languages remain literal source
text. Nova does not split them heuristically. They can be cleaned up manually or
through an explicit reviewed translation action.

## Coverage boundaries

The primary inventory contains static worker-facing text that Nova can emit
faithfully today:

- app, module, and form names;
- visible field and group/repeat labels;
- field hints, help, validation messages, and inline select option labels;
- case-property option labels when they provide runtime display labels for
  case-list select values;
- case-list column headings, ID-mapping labels, and interval text;
- Search input labels, screen title/subtitle, and action label, including
  effective Nova defaults.

The same inventory boundary also returns explicit coverage diagnostics through
the Languages workspace and `get_languages` for content that cannot honestly
participate. These values do not disappear behind a misleading 100 percent
score:

- lookup-backed option labels are mutable Project table data and require a
  separate localized-lookup-column model;
- Connect names and descriptions have no multilingual carrier on the current
  accepted wire;
- module/form audio labels and other media currently reference one shared asset
  for every locale;
- automation messages have recipient-language semantics independent of an app's
  currently selected locale;
- authoring-only metadata such as purposes, case-property guidance, personas,
  roles, organization descriptions, and setup instructions is outside the
  worker-app language catalog unless it feeds an emitted display surface.

## Builder and Preview experience

The Builder header has a compact global language selector beside Preview.
Changing it selects the worker-content lens for the structure tree, canvas,
inspector, case workspace, and running Preview. Nova's authoring chrome remains
in the author's interface language. The selected language is URL-owned so it
survives reload, navigation, back/forward, and shared links. With no explicit
selection, the app's default language is effective.

App setup gains a Languages section containing:

- the ordered language catalog with Source and Default badges;
- Ready, Needs review, Missing, and Out-of-date coverage;
- Add language, set default, edit language metadata, and remove actions;
- unsupported/dynamic coverage diagnostics;
- a searchable and filterable translation workspace.

The Add language dialog asks for a target and an existing “Start with”
language. Copy is always available. “Translate with Nova” is offered only when
the exact direction passes the current AI capability policy.

The translation workspace uses source/target rows grouped by owning screen and
form. Context is concrete, for example “Intake → Patient name → Hint.” It has
status filters, reference-safe prose tokens, and a jump to the owning Builder
screen. Wide layouts show source and target side by side; narrow layouts edit
one target row without compressing two columns below usability.

When a target language is selected in the ordinary Builder, editing a
worker-facing value writes the target overlay. The global selector remains
visible while editing, and the Languages workspace is the authoritative
side-by-side source/target review surface. Structural IDs and authoring-only
values never change with the language lens. An existing target edit may share
one gesture with a structural edit; the target string and canonical structure
still land as separate mutations in one admitted batch. A newly-created entity
is born with canonical source content. An optional worker-facing slot that has
no source content yet is added under the source lens before a target can
translate it, so selecting a target can never put that target language into the
canonical source by accident.

Preview consumes the same effective-value resolver and selected locale. It
applies language direction to worker content and input controls. Preview-only
diagnostics and editor guidance remain Nova authoring UI rather than pretending
to be emitted app content.

## Solutions Architect and MCP experience

The shared SA/MCP surface has one coherent language family:

- `get_languages`
- `get_translatable_content`
- `add_language`
- `update_language`
- `remove_language`
- `update_translations`
- a high-level request to translate or refresh one target language, supplied by
  the durable AI orchestration layer

The implemented names follow the registry's camelCase SA / snake_case MCP
convention. `add_language` is the nonblank product operation: it composes the
raw language mutation with one explicit copied entry per current unit in a
single commit. `update_translations` accepts at most 50 unique units, treats
machine-authored values as Needs review, and uses an exact prior-value and
source-fingerprint fence for review/keep actions. All mutations use the same
document grammar and commit gate as the Builder. `get_translatable_content` is
snapshot-bound, bounded, and pageable, supports language, owner, role, text,
and status filters, and exposes context plus protected segments from the
central inventory. An external agent may author translations itself or invoke
Nova's durable translator.

The follow-up SA responds in the language the user is speaking unless the user
asks for a different response language. That conversational choice is separate
from the app's source/default/target language choices. A French conversation
may build canonical French content and request English as a target, or may
discuss an English-source app without changing its source language. Prompt
guidance must never infer an app-language mutation merely from conversation
language.

The design author and reviewer capture explicit localization intent in the
accepted Design Contract: canonical source, runtime default, target languages,
seed languages, and whether each target is copy-only or AI-translated. They ask
when a meaningful distinction such as regional variant or runtime default is
ambiguous.

## AI translation service

Translation is a named model role using GPT-5.6 Sol through Nova's installed AI
SDK structured-output path. The SDK API called “translation” is speech/audio
translation and is not used for text localization.

The translator receives batches grouped by owning screen/form and bounded by
estimated tokens rather than item count alone. Each batch includes:

- source and target languages;
- app objective and relevant workflow context;
- unit roles and breadcrumbs;
- sibling labels/options where they disambiguate meaning;
- protected prose-reference tokens;
- a bounded durable terminology glossary from prior accepted batches.

Output is structured and must cover the exact requested unit IDs. The server
rejects missing, extra, duplicate, wrong-kind, blank-illegal, malformed
markdown, or protected-token-invalid results. Paid results and usage are stored
durably. Translation stages against a pinned source snapshot and reaches the
canonical document only after the complete change set validates. If concurrent
editing changes the base, unchanged results are reused by source fingerprint
and only affected work is regenerated before one exact commit.

All AI output begins as Needs review. Translation failure never silently
degrades an accepted “translate with Nova” build into copy-only output.

### Capability policy

Manual authoring and copy support every ISO language code CommCare Classic
supports, plus any Classic-accepted custom regional code. Automatic translation
is directional and gated separately. Nova must not claim that Sol supports a
language merely because Classic accepts its ISO code or because the model can
produce some text in it.

The production allowlist is informed by:

1. current official OpenAI statements about the exact deployed model;
2. relevant published multilingual benchmarks whose task resembles translation
   rather than English-only reasoning translated after the fact;
3. Nova-owned directional fixtures covering plain text, markdown, protected
   references, option sets, validation messages, domain terminology, and
   low-resource-language failure behavior;
4. an explicit quality threshold and human review of the acceptance languages.

The current public evidence does not justify a broad Sol allowlist:

- OpenAI's current [Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
  [GPT-5.6 announcement](https://openai.com/index/gpt-5-6/), and
  [system card](https://deploymentsafety.openai.com/gpt-5-6-preview/gpt-5-6-preview.pdf)
  publish no multilingual or text-translation coverage table for Sol. The model
  accepts and produces text and supports structured output, but those interface
  capabilities are not translation-quality evidence.
- The older GPT-5 system card's translated MMLU evaluation covers thirteen
  languages, but it measures translated knowledge questions on a different
  model family rather than translation fidelity. It is a useful prior for
  selecting evaluation candidates, not a product support contract for Sol.
- The narrow third-party [BelinDoc translation review](https://belindoc.com/blog/gpt-5-6-translation-review-sol-terra-luna)
  reports strong Sol results on clean English-to-Chinese, Chinese-to-English,
  and Japanese-to-English passages. It contains only eight short passages,
  relies on LLM judges, keeps raw results private, and found a material OCR
  weakness. It demonstrates plausible capability in those tested directions;
  it does not establish broad language coverage.

Nova therefore enables no direction merely from an ISO code, model-family
reputation, or a generic multilingual score. Automatic translation has three
plain-language availability states:

- **Available**: this exact direction and deployed model snapshot pass Nova's
  current acceptance suite and human review.
- **Not evaluated**: manual authoring and copy are fully available, but Nova
  makes no quality claim and does not offer a paid automatic run.
- **Withheld**: current evidence failed the quality threshold; Nova explains
  the tested limitation without describing the language itself as unsupported.

The policy is direction-specific: passing English→Spanish says nothing by
itself about Spanish→English or Spanish→French. English↔Spanish is the first
required bidirectional acceptance pair. French→English is also an initial
acceptance direction so an end-to-end reverse test can conduct the Nova
conversation in French, preserve French as canonical app content, and request
English worker-facing translations. Until those paid evaluations pass, the UI
reports them as Not evaluated rather than optimistically enabling them.

## Initial build integration

Workflow slices build canonical source-language content. Localization is a
post-slice finalizer because the complete string inventory does not exist until
every included workflow has materialized.

```text
design → independent review → workflow slices → requested translations
       → full validation and export compilation → finish
```

Translation is not a fake `BuildPlan` workflow slice. The invariant of exactly
one slice per included workflow remains intact. The orchestrator gains a
durable translating state and a localization receipt. Authoritative completion
requires every workflow receipt, the optional localization receipt, a canonical
head equal to the final receipt, full validation, and both export compilations.

The initial app stays frozen until translation and final proof complete.
Progress says which language is being translated without logging customer
content. A retry resumes the exact durable attempt and does not rebill completed
accepted batches. A deterministic translation failure is a build failure to
explain or recover, not permission to release a different app than the accepted
contract.

Later source edits derive Missing/Out-of-date status immediately. AI refresh is
explicit through Builder or chat rather than an unannounced paid call after
every keystroke.

## CommCare emission

The compiler derives an effective localized projection without mutating or
cloning `BlueprintDoc` into a second app model.

- HQ JSON `langs` follows `languageOrder`, with the default first.
- Every localized HQ property map contains every configured language.
- Localized app-name values populate the appropriate app-string overrides while
  `Application.name` remains the canonical source authoring name.
- Every XForm receives one translation block per language and exactly one
  default. The existing itext registry is populated through the localized
  resolver so text IDs and reference-bearing output remain identical across
  languages. Optional hints, help, validation messages, and container labels
  emit when any configured language has effective content, even when the source
  template is empty.
- Suite app strings become a complete table per language rather than one map
  copied to every directory. Multi-select label expressions retain each option's
  original catalog index when non-token values are skipped.
- The direct CCZ writes the default table to `default/app_strings.txt` and each
  other table to its language directory. Every table carries the language
  endonyms and `lang.current` values CommCare's picker expects. Values serialize
  through CommCare Core's locale-file grammar: comment hashes and physical line
  breaks are escaped, while literal backslash-`n`, carriage returns, and boundary
  ASCII whitespace fail closed because Core cannot round-trip them.
- HQ-upload and direct-CCZ paths consume the same projections and receive
  separate exact boundary tests.

The XForm oracle proves unique languages, one default, per-language itext
completeness, and identical referenced text-ID sets. The suite oracle validates
each locale table rather than only the default table. HQ JSON oracle fixtures
cover language maps and app-name overrides. Bilingual inline-byte fixtures are
grounded in the current HQ/Core functions named under Binding CommCare facts.

## Persistence, mutations, and validity

Language catalog operations and bounded translation updates use the granular
`relabelSourceLanguage`, `addLanguage`, `updateLanguage`, `removeLanguage`,
`setDefaultLanguage`, `setTranslation`, and exact-value-fenced
`reviewTranslation` mutations. They participate in admission, reducer replay,
undo/redo, diffing, accepted app-change rows, and multiplayer exactly like
existing Blueprint mutations. Shared agent/MCP tools compose these same
commands rather than introducing a second write dialect.

Builder metadata dialogs draft only properties the local user changes. An
untouched language name or direction continues to follow the live document, and
save emits only dirty properties, so a concurrent peer edit is never restored
from stale component state.

The localization schema and document-aware validator enforce catalog closure,
default ordering, source/target rules, entry kinds, unit existence, reference
tokens, and per-slot content requirements. Missing or unreviewed translations
are quality states, not validator findings, because an effective source fallback
always exists. An invalid language catalog or malformed translation entry can
never commit.

Legacy stored documents parse without a data migration. The forward schema
migration adds only the nullable app root, and persisted-shape, exact-text, and
fold fixtures prove that the optional value does not reinterpret old data.

## Documentation and plugin release

The Nova PR stack updates:

- public Languages and translation documentation;
- MCP tool documentation and examples;
- the nearest domain, doc, agent, Builder, Preview, and CommCare `CLAUDE.md`
  contracts;
- the complex-app index, moving this capability into “What is built” only when
  the complete stack is ready to merge.

The sibling `nova-plugin` is the model-facing copy of the public MCP contract.
Its build, autobuild, and edit guidance must understand the language tools,
source/default distinction, end-of-build translation phase, coverage warnings,
and conversation-language rule. Tool allowlists and copied schemas/prose remain
in parity. The plugin manifest version is bumped and its source tests pass.

Nova merges and deploys first. After the exact Nova merge is healthy in
production and the new MCP surface is live, the dependent plugin PR merges and
publishes immediately. The plugin must never go live first and teach clients to
call a surface production does not yet expose.

## Delivery stack

The implementation is divided only where each branch is a coherent final
architecture layer. The expected stack is:

1. **Language foundation** — this plan, domain model, inventory/resolver,
   mutations, validation, persistence/replay/diff support, and shared read/write
   tools. It has complete tests and no dormant alternative representation.
2. **Runtime and authoring surfaces** — CommCare emission/oracles, Preview,
   global selector, Languages workspace, inline target editing, accessibility,
   coverage diagnostics, and public manual-language documentation. This
   implemented layer consumes the final foundation APIs directly.
3. **AI orchestration** — Design Contract, build finalizer, durable translation
   staging/recovery, model role, prompts, capability policy/evaluation harness,
   progress, usage accounting, and shared high-level translation action.
4. **Plugin release** — the dependent `nova-plugin` contract and version bump,
   based on the final Nova MCP behavior and merged only after Nova deployment.

The exact number of Nova PRs may shrink if a proposed boundary would leave an
unreachable or misleading capability. It must not grow merely to make diffs
small. Every stacked Nova branch is based on the preceding branch, CI-clean,
reviewable on its own, and contains no feature flag, temporary adapter, dual
schema, or planned cleanup.

Nova uses GitHub's native stacked-pull-request public preview through the
official `gh stack` extension. The installed GitHub CLI satisfies its current
version requirement. Each Nova PR targets the branch immediately below it and
the bottom targets `main`; lower-layer fixes are rebased through the remaining
stack. After every frozen head and the complete stack are approved and green,
the contiguous Nova stack is merged together in dependency order as one
all-or-nothing product landing. No layer is intentionally deployed by itself.
The workflow follows GitHub's current
[stack tutorial](https://docs.github.com/en/pull-requests/tutorials/stack-code-changes-in-pull-requests)
and [stack management guidance](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/managing-stacked-pull-requests);
because the feature is in public preview, its behavior is rechecked before
submission and merge rather than assumed stable.

## Verification and completion

The feature is complete only when all of the following are true:

- legacy and multilingual documents pass schema, mutation, replay, undo, diff,
  topology, and multiplayer tests;
- unit IDs survive moves and identity renames, while deletion and semantic-key
  edits update overlays atomically;
- copy, manual edit, review, stale fallback, keep-translation, default change,
  remove, RTL, and unsupported-content behaviors have focused domain and UI
  coverage;
- SA and MCP expose identical language semantics and bounded inventories;
- an initial multilingual build proves post-slice translation durability,
  retry, billing, receipt ordering, frozen visibility, and final compilation;
- compiler fixtures prove two or more languages through HQ JSON, every XForm,
  suite locales, app strings, language picker labels, local CCZ, and HQ upload;
- Builder and Preview tests cover URL-owned language selection, responsive
  layouts, keyboard/touch interaction, focus, and target-language editing;
- `nova-plugin` source tests and contract checks pass against the final MCP
  names and behavior;
- `npm run test:changed`, scoped `npm run test:leaks`, typecheck, lint, build,
  and relevant Playwright smoke pass locally, followed by the full CI matrix;
- provider schema validation and live translation-quality evaluation run only
  after fresh approval because they spend money;
- each PR is reviewed at a frozen head and the complete stack is green;
- Nova is merged only after explicit user approval, its exact deployment is
  verified live, and the plugin release follows immediately afterward.
