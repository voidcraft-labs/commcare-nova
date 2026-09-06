# Native HQ case-emission evidence

The producer exports six strictly valid Nova documents through the real
expander and CCZ compiler: registration, followup, user-controlled repeat,
query-bound repeat, multiple selected parents, and repeated entries under multiple
selected parents. Each creates two extension cases with an ordinary child between
them. Registration also links to the first
new extension. An extension also carries a captured file, including the combined
repeat/selection scope. The same document fixtures drive
`extensionCaseEmission.test.ts`. Two further documents exercise a worker-record
write on a survey and a followup form; these also drive
`usercaseWriteWire.test.ts`. The followup app has a separate, valid browse module.
Five capture documents combine both modes on registration, followup, user
repeats, query repeats and multiple selected cases. They drive `caseCaptureEmission.test.ts` and the
CommCare Core proof. Twelve operation documents cover submission order,
conditions, retypes, generated and authored repeat IDs, scalar bounds, dynamic
links, relation context and nested-menu selection. These drive
`caseOperationEmission.test.ts` and the native case-operation proof.

```bash
mise exec -- npx tsx scripts/fixtures/hq/emit-case-evidence.ts /tmp/nova-case-evidence
PYTHONDONTWRITEBYTECODE=1 /path/to/commcare-hq/.venv/bin/python \
  scripts/fixtures/hq/case-emission-proof.py \
  --hq-root /path/to/commcare-hq --exports /tmp/nova-case-evidence
```

Use an installed HQ development Python environment. `--python-path` accepts an
optional dependency overlay without changing that environment. The proof refuses
socket connections and replaces only external configuration: default build
selection, usercase availability, two feature toggles, and cache storage. It
executes native `Application.from_source`, `XForm._create_casexml`,
`EntriesHelper.get_new_case_id_datums_meta`, and the native navigation matcher.
Worker evidence also executes `XForm._add_usercase`,
`EntriesHelper.get_extra_case_id_datums`, and `add_usercase_id_assertion`.
Capture and operation evidence also run native `add_case_and_meta` and
`strip_vellum_ns_attributes`, producing complete executable forms.
It never saves an app or submits a form. Each native XML artifact is written
beside its input, and stdout records the HQ commit and input/source SHA-256s.
Expansion intentionally allocates fresh HQ IDs and form namespaces, so hashes
identify the concrete audited artifacts; they are not fixed fixture expectations.

The September 6 audit used HQ `f391f622123f52c8943098d1228986f6999cddb8`.
Its basic case builder ignores `OpenSubCaseAction.relationship`, although its
schema accepts it. HQ's action enumeration and new-case datum allocator include
subcase actions whose condition is `never`. Nova therefore carries the extension
transaction in the source XForm, retains its action as navigation metadata, and
sets that action's condition to `never`; HQ gives the redundant generated case
`relevant="false()"`. The local CCZ omits that inactive transaction. Both paths
use the same generated case ID, while repeats generate IDs per iteration.

Assertions verify two preserved extension indices, every inactive native case
path, the complete native create-datum list, and the native link match. A separate
call to native `add_case_preloads` checks the private owner-attribute projection.
Worker checks compare every worker-case bind against the local CCZ and join
the native lookup and assertion to the actual suite entry. An audit negative
control changed the CCZ bind to a wrong worker ID and failed that comparison.
These checks establish HQ's import/build transformation and navigation metadata
for these examples. The separate [Core proof](../javarosa/README.md) executes the
regenerated capture and operation forms and their CCZ counterparts. Capture
checks reach native form entry and submission serialization; operation checks
also apply the form through Core's case parser and inspect its in-memory case
records. Neither proof sends a remote submission.

## XML text and well-formedness

From the Nova checkout:

```bash
mise exec -- npx tsx scripts/fixtures/hq/emit-xml-evidence.ts /tmp/nova-xml-evidence
/path/to/commcare-hq/.venv/bin/python scripts/fixtures/hq/xml-boundary-proof.py \
  --hq-root /path/to/commcare-hq \
  --exports /tmp/nova-xml-evidence \
  --corpus scripts/fixtures/xml/well-formedness.json
```

An optional `--python-path` supplies an existing dependency overlay. The script
uses the same network-denied HQ bootstrap as the case proof, parses the syntax
corpus with HQ's native libxml, and imports actual Nova source with
`Application.from_source` and `XForm.xml`. It checks the decoded label, starting
value and CCZ profile name, then regenerates the accepted form for Core.

The four `before-audit-*.json` files preserve source content actually emitted
before the repair. Their documents passed Nova's schema and commit validation;
all four HQ forms failed native parsing. The repaired producer verifies that
admission and serialization now refuse those characters. JSON formatting is not
part of the counterexample; the embedded form source is.

The syntax corpus includes legal Unicode range edges, illegal literal and
referenced characters, scoped namespaces, duplicate expanded attribute names,
and comments/CDATA containing literal reference spellings. DTD and XML 1.1
refusals are explicit Nova policy and are excluded from native malformedness
claims. This does not connect to HQ, save an app or build Android.

## Case-tile regeneration

```bash
mise exec -- npx tsx scripts/fixtures/hq/emit-tile-evidence.ts /tmp/nova-tile-evidence
PYTHONDONTWRITEBYTECODE=1 /path/to/commcare-hq/.venv/bin/python \
  scripts/fixtures/hq/tile-emission-proof.py \
  --hq-root /path/to/commcare-hq --exports /tmp/nova-tile-evidence
```

The optional `--python-path` argument adds a local dependency overlay, as in the
case and XML proofs. Eight schema-valid, validator-admitted documents cover row
and tile layouts, visible borders/shading, hidden retained placement and sort,
explicit one/two-row groups, Search, persistent tiles and a formless browser.
The real `Application.from_source` and `DetailContributor` regenerate all detail
fields from the actual HQ JSON. The comparison checks decoded grid/style,
values, sort rules, group settings and action counts against local CCZ details.
Absent and false border flags have the same consumer meaning. Child order is
not compared: HQ can append Search after the group, and Core accepts both.

Only four unrelated external domain flags are disabled (UCR, list optimizations,
empty-list text and data registry). The native contributors are unmodified;
network access is denied. This is detail regeneration, not a full HQ build.
The resulting `*.hq-details.xml` files feed the native Core proof below.

## Navigation forms and Search payloads

```bash
mise exec -- npx tsx scripts/fixtures/hq/emit-navigation-evidence.ts /tmp/nova-navigation-evidence
PYTHONDONTWRITEBYTECODE=1 /path/to/commcare-hq/.venv/bin/python \
  scripts/fixtures/hq/navigation-emission-proof.py \
  --hq-root /path/to/commcare-hq --exports /tmp/nova-navigation-evidence
```

This regenerates 11 forms from eight admitted documents. Run the Core navigation
proof next, then feed its exact evaluated payloads to the native CSQL compiler:

```bash
PYTHONDONTWRITEBYTECODE=1 /path/to/commcare-hq/.venv/bin/python \
  scripts/fixtures/hq/search-payload-proof.py --hq-root /path/to/commcare-hq \
  --payloads /path/to/commcare-core/build/nova-search-payloads.tsv
```

Both commands accept `--python-path` for a local dependency overlay. The first
runs real import, case/meta generation and new-case datum allocation, with
external usercase, case-index, edited-fields and data-registry configuration
disabled. The second runs the actual HQ CSQL parser/compiler without replacing
its functions. Complete expected filters specify leap-day arithmetic and UTC
half-open date/datetime ranges; an invalid property-function comparison must
raise HQ's `CaseFilterError`. No database or remote search request runs.

## Search suite regeneration

```bash
mise exec -- npx tsx scripts/fixtures/hq/emit-search-evidence.ts /tmp/nova-search-evidence
PYTHONDONTWRITEBYTECODE=1 /path/to/commcare-hq/.venv/bin/python \
  scripts/fixtures/hq/search-emission-proof.py \
  --hq-root /path/to/commcare-hq --exports /tmp/nova-search-evidence
```

The optional `--python-path` supplies the same local dependency overlay. Twelve
schema-valid, validator-admitted apps cover inline/browse/remote Search,
single/multiple/parent selection, automatic/hidden/advanced/defaulted prompts,
and automatic and explicit registration links. Native HQ import and its real
detail, entry and menu contributors run before remote-request, workflow and
instance post-processing. Complete entry and remote-request trees must match,
including decoded values and child order. Two exact differences are asserted
before normalization: HQ's explicit unfiltered `match-all()` and Nova's unused
ordinary collection-instance declaration. The Core proof consumes the original
artifacts from both paths, including those differences.

Network is denied. Domain configuration is supplied explicitly: unrelated
UCR/optimization/empty-list/registry/endpoint flags and sync-on-entry are off;
advanced Search is on for authored defaults. Build version and public origin
are fixed. No native generator is replaced, no resources are installed and no
full HQ build is claimed. The resulting `*.hq-suite.xml` files feed Core.

## Search prompts

```bash
mise exec -- npx tsx scripts/fixtures/hq/emit-prompt-evidence.ts /tmp/nova-prompt-evidence
PYTHONDONTWRITEBYTECODE=1 /path/to/commcare-hq/.venv/bin/python \
  scripts/fixtures/hq/search-emission-proof.py --corpus prompts \
  --hq-root /path/to/commcare-hq --exports /tmp/nova-prompt-evidence
```

The same optional dependency overlay applies. This corpus requires exactly
three admitted documents: widget metadata and lookup choices, numeric and quote
guards, and dependent computed values with independent location guards. Complete
native entries and remote requests match without normalization exceptions. The
producer also emits the archive's source-language strings and exact lookup
fixture bytes for Core. It does not generate native HQ locale resources.
