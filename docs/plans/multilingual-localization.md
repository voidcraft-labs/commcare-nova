# Multilingual app authoring and translation

## Current state

This document describes the implemented multilingual capability and its
structured language identity model. The complete manual authoring/runtime
path, the durable initial-build translation finalizer, and the structured
identity model are all implemented on the current stack: the domain overlay,
the generated ISO/CLDR language registry, translation-unit inventory and
resolver, granular mutation dialect, validity rules, exact JSON persistence,
replay/diff behavior, shared SA/MCP read/write tools, the language wire plan
and localized CommCare emission with oracles, global Builder language lens,
Languages workspace with progressive-disclosure pickers, inline target
editing, Preview, coverage diagnostics, and focused tests are the current
source of truth. The production capability manifest marks every direction
between distinct members of the checked-in 57-language launch set Available.
Every other individual living language remains fully manual/copy-capable and
does not offer automatic translation. Capability-specific public
documentation is part of the Nova surface.

Keep this document as a description of the best current design and the actual
implementation state. When implementation teaches us something better, rewrite
the affected section in place. Do not append a decision log or preserve an
obsolete design for history; git already preserves that history.

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

## Language identity

A language is a three-part identity, not a code string:

```ts
interface AppLanguageIdentity {
  language: string;   // ISO 639:2023 Set 3, individual + living  ("cmn", "spa", "eng")
  script?: string;    // ISO 15924  ("Hans") — present only when the language branches
  region?: string;    // ISO 3166-1 alpha-2  ("CN") — present only when chosen
}
```

- `languageTag(identity)` joins the parts with `-` (`cmn-Hans-CN`);
  `parseLanguageTag` inverts it, unambiguously, because the segment grammars
  are disjoint. The tag is the record key in `AppLocalization`, the reference
  parameter in tag-consuming mutations, the `?lang=` URL value, and an
  internal map key. It is never rendered in any UI surface and never passed by
  agents; tools and the design contract speak the object.
- Script and region are orthogonal axes with independent rules. When a
  language has two or more customary writing systems, script is required, with
  no default and no unspecified option. Region is always skippable: a bare
  `spa` or `cmn` + `Hans` targets the language's general/international
  conventions.
- The selectable universe is Set 3 scope Individual, type Living, around
  7,100 languages. Macrolanguages (`zho`), Set 1 two-letter codes (`zh`),
  special codes, and non-living languages are rejected at every authoring
  boundary with the identifiers to use instead; a macrolanguage rejection
  lists its individual members by name.
- Names and direction are never stored and never authored. Display names
  (endonym, English qualified name, qualifier labels), the translator-prompt
  descriptor, and text direction all derive from the identity through the
  generated registry: direction from the script first, then the language's
  default script, then `ltr`.
- Two-letter codes exist in exactly one place in the codebase: inside
  `lib/commcare`, as emitted wire spellings.

### The registry

`lib/domain/languageRegistry/` holds generated TypeScript catalogs produced by
`scripts/generate-language-registry.ts` from the SIL ISO 639-3 tables and CLDR
supplemental data (customary scripts, official-status territories, RTL
scripts, endonyms, and labels). The generator reruns per ISO/CLDR release,
asserts structural pins (62 macrolanguages, the living-individual count band,
the Hans/Hant region sets), and proves every emitted name round-trips the
CommCare locale-file grammar, so a bad label is a generator failure rather
than a runtime one.

The static registry API (`index.ts`) answers membership verdicts
(`languageCodeVerdict` classifies individual-living, macrolanguage,
set1-alias, non-living, and unknown inputs), identity validation
(`identityIssues`), script and region choices, macro membership and the
Classic widening target, and the derivation helpers (display label, English
qualified name, qualifier labels, direction). The full English-name catalog
(~250 KB) lives behind a lazy chunk (`search.ts`, loaded through
`load.ts::loadLanguageRegistrySearch`) so the picker's search never weighs on
the main client bundle. Neither module is exported from the `lib/domain`
barrel; registry membership is enforced at authoring boundaries, and the
persistence layer never consults catalogs.

## Binding CommCare facts

These facts constrain emission only. They do not prescribe Nova's authoring
model.

- CommCare HQ accepts a lower-case two- or three-letter language code with an
  optional lower-case suffix. The binding source is
  `commcare-hq/corehq/apps/app_manager/models/applications.py::validate_lang`.
  Nova's wire plan emits only spellings inside that grammar.
- Nova vendors Classic's picker data byte-for-byte from
  `commcare-hq/submodules/langcodes/langs.json`; the reviewed source snapshot
  and `config/commcare-classic-languages.json` both have SHA-256
  `50cc621456e6e7a1b14afcbf5cccaa5a59b03f82271fc4d8a80bf6756ad5e4a4`.
  The vendored file is formatter-excluded so source provenance remains
  directly verifiable. It is wire data quarantined in `lib/commcare`
  (`classicLanguages.ts`); its only consumers are the language wire plan and
  the language-identity migration script.
- CommCare HQ resolves a language code to a human name through its `langcodes`
  Django app, whose lookup table is keyed by the THREE-letter code except the
  exact grandfathered tuple `('en', 'sw', 'es', 'af')`
  (`commcare-hq/submodules/langcodes/__init__.py::get_name` /
  `langs_by_code`); a miss returns `None`. HQ's own picker stores that same
  canonical spelling (`langcodes/views.py::format_lang`). The Web Apps
  language menu labels come from
  `corehq/apps/cloudcare/views.py::FormplayerMain.get_main`'s
  `lang_code_name_mapping` (via `get_name`) with a falsy fallback to the raw
  code in `cloudcare/js/formplayer/menus/utils.js::showMenuDropdown` — so an
  app with lang `fr` shows the literal `fr`, while `fra` shows `French`. That
  menu never reads app strings or `Application.translations`, and the names
  are English exonyms (`langs.json` carries no endonyms). No HQ path aliases
  two- and three-letter codes; `fr` and `fra` are unrelated strings on save,
  import, suite emission, and formplayer locale selection. Emitting Classic's
  canonical code is therefore the only lever Nova has over HQ-side language
  labels. Android's change-language menu instead looks each code up as an app
  strings key (`commcare-android/.../ChangeLocaleUtil.java::translateLocales`),
  which Nova's emitted `<code>=<name>` rows and HQ-JSON `translations` overlay
  do control.
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
- A direct CCZ carries the initialization-only `default` locale resource plus
  one named locale resource for every configured language, including the
  default language. CommCare Android removes only the literal `default` from
  its worker-facing picker, so the named copy is what lets a worker switch back
  to the default language. The binding sources are Classic's
  `LocaleResourceContributor` and Android's `ChangeLocaleUtil`.
- The app's own display name needs localized app-string overrides in addition
  to the unlocalized HQ `Application.name` authoring value.
- Connect learn-module, delivery-unit, and task names/descriptions are plain
  data elements inside the XForm. The current accepted wire has no per-locale
  carrier for them. Nova must report this limitation rather than pretend those
  values were translated.

## Nova language model

`BlueprintDoc` has an optional localization value. Absence has one exact
meaning: source `eng`, default `eng`, ordered languages `[eng]`, and no
translation overlays. The first language mutation materializes that effective
state, and returning to that exact state dematerializes the optional value
again. The database has an optional `apps.localization` JSONB root; NULL
remains the canonical spelling of the English-only state and is never
materialized.

The persisted shape is conceptually:

```ts
interface AppLocalization {
  sourceLanguage: LanguageTag;
  defaultLanguage: LanguageTag;
  languageOrder: LanguageTag[];
  translations: Record<LanguageTag, Record<TranslationUnitId, TranslationEntry>>;
}

interface TranslationEntry {
  value: LocalizedValue;
  sourceFingerprint: string;
  origin: "copied" | "ai" | "human";
  review: "needs-review" | "reviewed";
  translatedFrom: LanguageTag;
}
```

There is no per-language metadata record: with names and direction derived
from the identity, a metadata record would carry nothing beyond its keys.

These are the implemented domain semantics:

- The tag is the language's stable record identity. Changing an identity is
  remove-and-add, because CommCare also treats the emitted spelling as locale
  identity; the sole-language relabel is the one exception.
- `LANGUAGE_TAG_PATTERN` (`^[a-z]{3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$`) is the
  only tag grammar. Parsing admits shape only; registry membership is enforced
  at the authoring boundaries (tool schemas, design contract, picker), so
  persistence never consults catalogs.
- The source language describes the canonical values already stored on normal
  domain entities.
- The default language controls runtime start-up and is always first in
  `languageOrder`. It may differ from the source language.
- The source language is not represented again in `translations`.
- The source language cannot be removed. The default must be changed before
  removing the current default.
- A single-language app may replace its source/default language identity
  (`relabelSourceLanguage`). Once target translations exist, changing the
  canonical source language is not offered as a casual edit.
- Every individual living language is available for manual authoring,
  copy-from-existing, Preview, and export. AI capability policy governs only
  whether Nova offers automatic translation for an exact source→target
  direction; it can never make a language unavailable.
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
in the author's interface language. The selected language is URL-owned (the
`?lang=` tag) so it survives reload, navigation, back/forward, and shared
links. With no explicit selection, the app's default language is effective.
Every Builder selector and edit resolves that URL-owned language against the
exact document snapshot it is reading or mutating. If the selected language is
removed locally or by a peer, the same store notification falls back to that
snapshot's default language; no descendant can project or write through a
stale locale between the store update and the provider re-render.

A language renders only through the derivation helpers: the switcher and the
per-language cards show the endonym, the English qualified name where it
differs, and the direction word. No ISO code appears in any Builder surface;
the URL tag is the one technical exception. The switcher trigger carries a
tooltip with the full English qualified name, and a qualifier line
distinguishes two entries that share a language axis.

App setup's Languages section contains:

- the ordered language catalog with Source and Default badges;
- Ready, Needs review, Missing, and Out-of-date coverage;
- Add language, set default, sole-source language change, and remove actions;
- unsupported/dynamic coverage diagnostics;
- a searchable and filterable translation workspace.

The Add language dialog discloses progressively: search for the language by
its own name or English name (the registry's lazy search chunk loads on open;
a typed Set 3 code resolves through search like any other query, and a
macrolanguage or alias query yields a code-free notice with the member
languages as selectable rows); then a Writing system select, rendered only
when the language branches, with no default; then a Regional conventions
select, rendered only when meaningful, whose first option is the language's
general conventions. A resolved duplicate refuses inline by name. There is no
free-code entry: the registry is the selectable world. The dialog asks for an
existing “Start with” language; copy is always available. The workspace
reports whether the exact direction belongs to the automatic launch set, but
this ordinary edit gesture never initiates a paid model call: automatic
translation currently runs only as the explicit finalizer of an accepted
initial-build contract.

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
to be emitted app content. Its live engine resolves the presentation language
against every rebuilt document snapshot while preserving the current entry and
answers. Portaled controls provide the worker direction to Base UI's positioning
context as well as the popup DOM, so logical start/end alignment is correct for
RTL content.

## Solutions Architect and MCP experience

The shared SA/MCP surface has one coherent language family:

- `get_languages`
- `get_translatable_content`
- `add_language`
- `update_language`
- `remove_language`
- `update_translations`

The implemented names follow the registry's camelCase SA / snake_case MCP
convention. Every tool speaks identity objects wherever a language is named;
no tool passes or returns a combined tag. Strict membership enforcement lives
at this boundary, composed from registry verdicts, each rejection naming what
was tried, what is expected, and what to use instead: a macrolanguage lists
its individual members, a two-letter code names its Set 3 replacement, a
branching language with no script names the required choice and its options.
`get_languages` returns identities plus derived display fields (endonym,
English name, qualifiers, direction, isSource, isDefault,
automatic-translation status, coverage). `add_language` is the nonblank
product operation: it composes the raw language mutation with one explicit
copied entry per current unit in a single commit. `update_language` sets the
runtime default or replaces the sole source language's identity.
`update_translations` accepts at most 50 unique units, treats
machine-authored values as Needs review, requires a set to echo the current
source fingerprint it translated, and requires review/keep to echo the current
source fingerprint plus the prior explicit entry's fingerprint and value. All
mutations use the same document grammar and commit gate as the Builder.
`get_translatable_content` is snapshot-bound, bounded, and pageable, supports
language, owner, role, text, and status filters, and exposes context plus
protected segments from the central inventory. An external agent may author
translations through the bounded translation mutations. Nova's durable
translator runs only as part of an accepted initial-build localization intent
whose exact direction is Available.

There is deliberately no high-level existing-app automatic-translation tool.
The initial-build finalizer owns paid-run admission, durable recovery, and
exact-once accounting for accepted build intent; exposing its Sol runner through
an ordinary mutation tool would bypass those guarantees. A future existing-app
Builder/chat action needs its own general durable edit-translation lifecycle and
must not reuse design-build lineage tables. Until then, the bounded inventory
and update tools are the honest manual/external-agent surface even for a pair
that is Available during initial build.

The follow-up SA responds in the language the user is speaking unless the user
asks for a different response language. That conversational choice is separate
from the app's source/default/target language choices. A French conversation
may build canonical French content and request English as a target, or may
discuss an English-source app without changing its source language. Prompt
guidance must never infer an app-language mutation merely from conversation
language.

The design author and reviewer capture explicit localization intent in the
accepted Design Contract as identity objects: canonical source, runtime
default, target languages, seed languages, and whether each target is
copy-only or AI-translated. Distinctness compares `languageTag(...)`, so two
spellings of one identity can never pass as distinct. They ask when a
meaningful distinction such as writing system, regional variant, or runtime
default is ambiguous.

## AI translation service

Translation is a named model role using GPT-5.6 Sol through Nova's installed AI
SDK structured-output path. The SDK API called “translation” is speech/audio
translation and is not used for text localization.

The translator receives batches grouped by owning screen/form and bounded by
estimated tokens rather than item count alone. Each batch includes:

- source and target languages, each as `{identity, descriptor}` where the
  descriptor is the registry-derived prose ("Mandarin Chinese (Simplified
  script, Singapore conventions)"), environment-stable so batch digests stay
  deterministic;
- app objective and relevant workflow context;
- unit roles and breadcrumbs;
- sibling labels/options where they disambiguate meaning;
- protected prose-reference tokens;
- a bounded durable terminology glossary from prior accepted batches.

The system prompt names the three standards and instructs the model to follow
the target's script and regional conventions.

Output is structured and must cover the exact requested unit IDs. The server
rejects missing, extra, duplicate, wrong-kind, blank-illegal, or
protected-token-invalid results. Roles emitted through CommCare locale files
also pass the shared locale-file representability check before a paid batch is
accepted, so boundary whitespace, carriage returns, and literal backslash-`n`
cannot become a durably replayed commit failure. Markdown delimiter preservation
is measured by the acceptance harness and judged by the bilingual reviewer;
Nova has no general markdown-validity oracle and does not claim one. Paid
results and usage are stored durably. Translation stages against a pinned
source snapshot and reaches the canonical document only after the complete
change set validates. The initial app is frozen throughout this finalizer;
source drift refuses the commit rather than merging model output onto a
different base.

All AI output begins as Needs review. Translation failure never silently
degrades an accepted “translate with Nova” build into copy-only output.

### Capability policy

Manual authoring and copy support every individual living language. Automatic
translation is directional and gated separately. Nova must not claim that Sol
supports a language merely because the model can produce some text in it.

Availability is a single membership test on the language axis:
`automaticTranslationLaunchLanguage(identity)` checks
`identity.language` against the checked-in launch set. Script and region
never affect availability, so two writing systems of one language
(`cmn-Hans` and `cmn-Hant`) are Withheld as a pair: script conversion is not
translation. The checked-in launch manifest contains exactly the 57 languages
selected for Nova's initial product policy; every direction between two
distinct members is Available. Languages outside the set remain Not evaluated
for automatic translation without losing any manual, copy, Preview, or export
capability.

This launch set is a deliberate product allowlist, not an assertion that
OpenAI published those exact languages for Sol or that every directed pair has
independent benchmark certification. Public evidence remains useful context but
does not provide an exact Sol support table:

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

Automatic translation has three plain-language availability states:

- **Available**: both language identities belong to the 57-language launch set
  on their language axis and are distinct there; the exact direction may use
  Nova's durable initial-build translator. Machine output still starts Needs
  review.
- **Not evaluated**: manual authoring and copy are fully available, but Nova
  makes no quality claim and does not offer a paid automatic run.
- **Withheld**: the pair shares one language axis (script or region conversion
  is not translation), or current evidence failed the quality threshold; Nova
  explains the limitation without describing the language itself as
  unsupported.

The policy is evaluated directionally even though the launch manifest currently
opens every distinct ordered pair within the set. That keeps future evidence
able to Withhold one weak direction without mischaracterizing its reverse. It
also supports the intended reverse test: a Nova conversation can be conducted
in French while the app preserves French canonical content and requests English
worker-facing translations.

`npm run eval:translations` is the explicit paid harness. It requires
`--confirm-paid`, one `--direction source:target` (two language tags, such as
`eng:spa`), and a new output directory; it has no default direction and never
edits the production policy. Its curated English, Spanish, and French source
fixtures exercise compact UI copy, public-health terminology, related option
sets, validation instructions, meaningful markdown delimiters, and protected
references. Any individual living language may be tested as a target. A run
writes the exact candidate, model/prompt/schema and fixture versions, usage,
deterministic structural checks, and a separate bilingual-review template. It
supplies evidence for future policy refinement but never changes the
checked-in launch manifest by itself.

## Initial build integration

Workflow slices build canonical source-language content. Localization is a
post-slice finalizer because the complete string inventory does not exist until
every included workflow has materialized.

The accepted design must also give every list and navigation entry exactly one
module-composition owner. An orphan work queue is not deferred executor work:
it is an incomplete design that must be repaired before planning, so a build
cannot materialize part of the source app and then discover that the remaining
worker-facing inventory has no constructible host.

```text
design → independent review → workflow slices → requested translations
       → full validation and export compilation → finish
```

Translation is not a fake `BuildPlan` workflow slice. The invariant of exactly
one slice per included workflow remains intact. The orchestrator has a
durable translating state and a localization receipt. Authoritative completion
requires every workflow receipt, the optional localization receipt, a canonical
head equal to the final receipt, full validation, and both export compilations.

The initial app stays frozen until translation and final proof complete.
Progress says which language is being translated without logging customer
content. A retry resumes the exact durable attempt and does not rebill completed
accepted batches. A deterministic translation failure is a build failure to
explain or recover, not permission to release a different app than the accepted
contract.

A failed structured-output generation is terminal for its exact
input/model/prompt/schema identity, so an ordinary retry never purchases a
different random sample. The accepted attempt remains resumable: a real
deployed protocol correction appends a new immutable generation at the same
semantic batch index only for the failed or now-invalid generation. Valid
accepted semantic predecessors remain authoritative across model, prompt, and
schema upgrades, so recovery neither regenerates nor rebills the accepted
prefix; exact-once usage accounting still retains every failed call's cost.

Later source edits derive Missing/Out-of-date status immediately. Nova never
makes an unannounced paid call after a keystroke. Existing-app authors and
external agents use the bounded inventory and translation mutations until the
separate durable edit-translation lifecycle exists.

## CommCare emission

The compiler derives an effective localized projection without mutating or
cloning `BlueprintDoc` into a second app model.

- `lib/commcare/languageWire.ts::planLanguageWire` is the one tag→wire-code
  mapping, computed once per emission over the ordered tag list, total and
  injective. Each identity's preferred spelling is its Classic catalog row's
  code, reached directly or by widening a macrolanguage member through its
  macro (`cmn` widens through `zho` to Classic's Chinese row): three-letter
  except the four grandfathered two-letter rows (`eng`→`en`, `spa`→`es`,
  `swh`→`sw`, `afr`→`af`). An identity with no Classic reach emits its Set 3
  code, which is always wire-valid. Identities colliding on one preferred
  spelling each take a single lowercase suffix segment
  (`cmn-Hans`/`cmn-Hant` → `cmn-hans`/`cmn-hant`), because Classic's grammar
  allows exactly one hyphen; distinct identities sharing a language differ in
  script or region, so suffixes are distinct by construction, and a final
  injectivity assert throws as a compiler bug.
- Device-picker name rows come from the registry's baked display labels at
  the most specific key, so two branches of one language stay distinguishable
  in the device language menu. Never runtime `Intl`: Node/ICU variance must
  not reach wire bytes.
- An `eng`-only app, including every app with an absent localization root,
  emits byte-identical output to the historical `en`-only shape: wire `en`,
  `default/` and `en/` directories, the `en=English` row, `lang.current=en`,
  itext `lang="en" default`, and HQ `langs: ["en"]`.
- HQ JSON `langs` follows `languageOrder` in wire codes, with the default
  first.
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
  original catalog index when non-token values are skipped. HQ enum variables
  use fixed-width, prefix-free indices because HQ discovers them through ordered
  substring replacement. Hidden Results sort carriers retain their positional
  calculation join but strip unused translated-enum expressions and variables
  that HQ's final Invisible formatter cannot declare.
- The direct CCZ writes the default table to `default/app_strings.txt` and each
  other table to its wire-code directory. Every table carries the language
  name rows and `lang.current` values CommCare's picker expects. Values
  serialize through CommCare Core's locale-file grammar: comment hashes and
  physical line breaks are escaped, while literal backslash-`n`, carriage
  returns, and boundary ASCII whitespace fail closed because Core cannot
  round-trip them.
- HQ-upload and direct-CCZ paths consume the same projections and receive
  separate exact boundary tests.

The XForm oracle proves unique languages, one default, per-language itext
completeness, and identical referenced text-ID sets. The suite oracle validates
each locale table rather than only the default table. HQ JSON oracle fixtures
cover language maps and app-name overrides. Bilingual inline-byte fixtures are
grounded in the current HQ/Core functions named under Binding CommCare facts.

## Persistence, mutations, and validity

Language catalog operations and bounded translation updates use the granular
`relabelSourceLanguage`, `addLanguage`, `removeLanguage`,
`setDefaultLanguage`, `setTranslation`, and exact-value-fenced
`reviewTranslation` mutations. `relabelSourceLanguage` and `addLanguage` carry
an `AppLanguageIdentity` object; the other kinds reference an existing
language by its tag. There is no `updateLanguage` kind: names and directions
derive from the identity, so no mutation edits them. The mutations participate
in admission, reducer replay, undo/redo, diffing, accepted app-change rows,
and multiplayer exactly like existing Blueprint mutations. Shared agent/MCP
tools compose these same commands rather than introducing a second write
dialect.

Builder language dialogs draft only the choice the local user is making; an
untouched control continues to follow the live document, so a concurrent peer
edit is never restored from stale component state. Names and direction are
derived at render rather than carried as drafts.

The localization schema and document-aware validator enforce catalog closure,
default ordering, source/target rules, entry kinds, unit existence, reference
tokens, and per-slot content requirements. Missing or unreviewed translations
are quality states, not validator findings, because an effective source fallback
always exists. An invalid language catalog or malformed translation entry can
never commit.

The stored shape is canonical-only. The one-off language-identity migration
(`scripts/migrate-language-identity.ts` over
`scripts/lib/languageIdentityRepair.ts`, invoked by `scripts/migrate.ts` so it
rides the production migrate Job) rewrites every store that can hold the old
code-keyed shape: `apps.localization` roots, `app_changes.mutations` payloads
(including removal of `updateLanguage` rows), `app_change_fold_baselines`
snapshots, and stored translation-batch state. The migration script's private
reader is the only place in the codebase that can parse the old shape. Each
app's rewrite applies in one transaction and is proven by re-folding the app
from its baseline over the rewritten rows with the canonical-only schemas; a
fleet postcondition scan asserts zero old-shape occurrences remain. A tag the
mechanical rules cannot decide lands in a reviewed explicit-mapping table, and
the migrate refuses to run while an entry is missing.

## Documentation and plugin release

The Nova surface documents this capability in:

- public Languages and translation documentation;
- MCP tool documentation and examples;
- the nearest domain, doc, agent, Builder, Preview, and CommCare `CLAUDE.md`
  contracts.

The sibling `nova-plugin` is the model-facing copy of the public MCP contract.
Its build, autobuild, and edit guidance states the identity-object contract:
pass `{language, script?, region?}` objects, never combined tags; rejections
name the identifiers to use; names and direction derive and are never
authored. Tool allowlists and copied schemas/prose remain in parity. The
plugin manifest version is bumped with each contract change.

Nova merges and deploys first. After the exact Nova merge is healthy in
production and the new MCP surface is live, the dependent plugin PR merges and
publishes immediately. The plugin must never go live first and teach clients to
call a surface production does not yet expose.

## Verification and completion

The capability holds only while all of the following remain true:

- canonical documents pass schema, mutation, replay, undo, diff, topology, and
  multiplayer tests, and the identity-repair fixtures prove the migration's
  rewrite, re-fold, idempotence, and refusal behaviors across all four stores;
- unit IDs survive moves and identity renames, while deletion and semantic-key
  edits update overlays atomically;
- copy, manual edit, review, stale fallback, keep-translation, default change,
  remove, RTL, and unsupported-content behaviors have focused domain and UI
  coverage;
- SA and MCP expose identical language semantics and bounded inventories, and
  every registry rejection message names the identifiers to use;
- an initial multilingual build proves post-slice translation durability,
  retry, billing, receipt ordering, frozen visibility, and final compilation;
- compiler fixtures prove two or more languages through HQ JSON, every XForm,
  suite locales, app strings, language picker labels, local CCZ, and HQ
  upload, plus the wire plan's grandfathered spellings, macro widening, and
  collision suffixing, and the `eng`-only byte pin;
- Builder and Preview tests cover URL-owned language selection, responsive
  layouts, keyboard/touch interaction, focus, and target-language editing;
- `nova-plugin` source tests and contract checks pass against the final MCP
  names and behavior;
- provider schema validation and live translation-quality evaluation run only
  after fresh approval because they spend money.
