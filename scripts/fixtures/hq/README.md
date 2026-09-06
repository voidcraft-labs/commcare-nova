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
CommCare Core proof.

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
Capture evidence also runs native `add_case_and_meta` and
`strip_vellum_ns_attributes`, producing complete executable forms.
It never saves an app or submits a form. Each native XML artifact is written
beside its input, and stdout records the HQ commit and input/source SHA-256s.

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
five regenerated capture forms and their CCZ counterparts through native form
entry and submission serialization. Neither proof sends a remote submission.
