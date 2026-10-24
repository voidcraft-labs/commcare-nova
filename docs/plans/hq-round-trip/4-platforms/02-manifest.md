# Step 4, part 02: The manifest

Part of [step 4's plan](../4-platforms.md), which holds the baseline, the decisions, the stack and
the exit. This part holds every edit step 4 makes to the surface manifest
(`lib/commcare/surface/entries/*.json`, `media-formats.json`, `entries/gates.json`) and to the
matching rows of the research's inventory (`docs/research/2026-09-26-hq-round-trip/inventory/*.md`),
each with its exact old and new text and its citation, grouped by the pull request that lands it;
the lane's new check for an emitted HELD-NEW item (`proof/checks/manifest_usage.py`,
`proof/checks/registers.py`); the two new value-class readers and their tests; the instance-read
lists in `lib/commcare/surface/__tests__/manifest.test.ts`; the `lib/commcare/CLAUDE.md` sentence
on the inventory; and what the binding test of the platform table (part 01 §8) may name in each
pull request.

Citations are `path::symbol` for Nova at `main` `e9e6cd93` and `file::symbol` for CommCare at the
pins `proof/pins.json` names, unchanged since step 2: commcare-hq `d6c6e16d8ae1`, commcare-core
`8e9ba8d908e9` (paths under `src/main/java` unless they start with `src/cli`), formplayer
`24383ac71bfb` (paths under `src/main/java/org/commcare/formplayer`), commcare-android
`7a5584475580` (paths under `app/src/org/commcare`), commcare-connect `046c7fd78081`, and Vellum
`01215f251c57`. Every CommCare fact this part relies on was read at those pins for it. Stack
references use the fifteen pull requests by number; the stack table is the plan's.

## Decisions in brief

1. **The lane refuses an emitted HELD-NEW item.** Today `proof/checks/manifest_usage.py::_standing_plan`
   counts every entry that is not REFUSED as allowing, so a use whose key only HELD-NEW entries name
   passes silently. From pull request 1 such a use is its own standing, `held-new`, a difference at
   `/<key>/held-new`, which the register refuses to hold (§2). Reason: HELD-NEW means "Nova adds this
   concept later", so an export that uses it means the disposition or the emitter is wrong, and
   neither is a symptom to register.
2. **Pull request 1 flips everything Nova already emits**, so the new check finds nothing on the
   corpus at that head (§3). Executed during planning: the lane's own extraction over a corpus
   emitted at `main` found 35 surface keys whose only allowing entries are HELD-NEW, and a scan of
   the same corpus's local archives found a 36th the extraction cannot judge without readings,
   `session-path:session/context/drift`, which the meta block of every form reads. Pull request 1
   resolves all 36 by editing or adding 30 entries: 27 flips from HELD-NEW to HELD, one key added to
   each of two HELD entries, and one new INERT entry. It also flips skip-to-results, which Nova emits
   under keys that HELD entries share, and adds the entry of §3.5. Reason: the check and the flips
   that empty it land together, or the lane fails on its own pull request.
3. **A flip to HELD of something Nova derives but does not let the author choose is HELD with a
   widen.** The Disposition cell reads "**HELD**: <what Nova writes>; widen: <the concept a later
   step adds>", with the widen in `slotChanges`. Reason: one entry stays one row, as
   `questions/help-media` and `questions/hint-text` already do, and the lane, the binding test and
   the instance-read test all read HELD.
4. **Readings corrected where no code moves land in pull request 1**: `here()` in a case list is
   unavailable on Web Apps in the case detail too; the case list menu item on Web Apps redirects to
   the app's first screen; the date-and-time hidden sibling runs on Web Apps (§3.6). Reason: each is
   read at the pins and none waits on a code change.
5. **Each entry change edits its inventory row in the same pull request**; a split entry adds a row
   beside the one it splits from; an entry with `origin: "export-use"` has no row; the inventory's
   Counts table stays the research's. `lib/commcare/CLAUDE.md`'s sentence that says the inventory
   "is not kept in step" is corrected (§3.9). Reason: steps 2 and 3 edited rows in their pull
   requests (#763, #778, #779, #784, #785), so the sentence describes no practice.
6. **Connect and the declaration's wire form land in pull request 4, its emission cells in pull
   request 5.** A new HELD entry, `application-and-settings/connect-app-opened-in-the-connect-app`,
   records that no Connect worker can open a Connect app in Web Apps; `40-hq-cloudcare-enabled`
   becomes HELD with the declaration it is the wire form of (§5). Reason: the binding test (part 01
   §8, pull request 4) names both entries and refuses a non-HELD one, while Nova writes
   `cloudcare_enabled` only from pull request 5, whose emission cells say so (§6).
7. **Media entries move in pull request 7**: SVG becomes REFUSED (HQ cannot store it), ICO and AVIF
   HELD for Web Apps only, the Android-only variants HELD, the H.264 High entry merged into the
   Baseline-or-Main one, and the two narrows step 2 left are dropped as the MP4 and WAV readers
   land; `media-formats.json` takes the media work's edits too: AAC where it named AAC-LC, the
   browser playback record, and H.264 High's Android reading `runs` from the decode run made during
   planning (§7). One of part 04's gates decides text here, HQ's storage of an AVIF in the proof
   image, and §7.1 writes both its answers. Reason: these are what the media work (part 04)
   accepts, and an SVG anywhere in a publish loses every file of it.
8. **Expression reads move in pull request 10**: the three session context fields, the case list's
   search text (`session/data/stringquery`), search inputs read in a search-first module's forms
   and in its case list and detail, and the search-value context terms split by field (§8). The
   window width in form logic becomes REFUSED, gated on one native Core run of two arms, part 03
   §6.4's design, whose two outcomes are both planned (§8.4). Reason: these are what pull request 10
   admits.
9. **The date-and-time split's joined value gets a HELD entry of its own**, `questions/hidden-value-bound-xsd-datetime`,
   RUNS on both platforms, in pull request 1 for the writer Nova already binds `xsd:dateTime`, and
   completed in pull request 3 for the non-writer the split adds (§3.5, §4). Part 03 §2.13 cites
   this entry and adds none of its own. Reason: the manifest
   must not describe a bound `xsd:dateTime` with no control as the date-and-time question, which is
   unavailable on Web Apps.

## 1. What the manifest says today

**HELD-NEW is allowing in the lane.** `proof/checks/manifest_usage.py::_standing_plan` sets
`allowed = True` for every entry whose disposition is not REFUSED, and `_evaluate` returns `HELD`
whenever `plan.allowed`, so a key that only HELD-NEW entries name is held. `standing`'s docstring
calls every class that is not REFUSED "allowing". The lane has therefore never shown that Nova emits
an item the manifest says Nova does not hold yet.

**What Nova emits that only HELD-NEW entries allow** (executed during planning, below). Each key with
the number of corpus documents whose exports use it, and the entries naming it:

| Key(s) | Documents | HELD-NEW entries naming it | Nova's emitter |
|---|---|---|---|
| `setting:properties.<key>` for the 17 profile settings | 392 | `application-and-settings/{1,4,5,13,17,18,19,20,21,22,23,25,26,27,28,29,30}-properties-…` | `lib/commcare/appProfileSettings.ts::appProfileProperties` (HQ JSON `profile.properties` through `hqShells.ts::applicationShell`; the local `profile.ccpr`) |
| `parser:SuiteParser/locale`, `parser:SuiteParser/locale@language` | 392 | `application-and-settings/langs-code-spelling-matching-hq-s-grammar-a-z-2-3-a-z-e-g-en-hin` | the local suite's `<locale language>` from `localization.wireCodes` |
| `schema:Form.xmlns`, `parser:EntryParser/form`, `xform:model/instance/*@xmlns`, `xform:model/instance//*@xmlns` | 386 | `forms-and-case-writes/xmlns-form-json-and-xform-data-node` (the last key also `questions/data-node-xmlns-on-a-hidden-value`) | `lib/commcare/wireIdentity.ts::derivedFormXmlns`, `targetWireIdentity` |
| `schema:CaseList.label` | 62 | `menus-and-case-lists/module-case-list-label-lang` | `lib/commcare/expander.ts::expandDoc`, the `caseListOnly` branch |
| `format:translatable-enum` | 29 | `menus-and-case-lists/21-translatable-enum-authored` and the two non-calculated `translatable-enum` entries | `lib/commcare/hqJson/caseList.ts::projectColumnToDetail` (`plain` over a select with options, and `interval`) |
| `appearance:web-apps/minimal` | 28 | `questions/select1-minimal`, `questions/select-minimal` | the label's `<trigger appearance="minimal">` (`lib/commcare/xform/builder.ts`) |
| `parser:DetailFieldParser/alt_text` | 26 | `menus-and-case-lists/enum-mappingitem-alt-text-lang` | `lib/commcare/suite/case-list/columns.ts::imageMapAltText` |
| `schema:Application.auto_gps_capture` | 22 | `application-and-settings/45-hq-auto-gps-capture` | `expander.ts::expandDoc` (`autoGpsCapture` from `connectType`) into `hqShells.ts::applicationShell` |
| `schema:OpenSubCaseAction.close_condition` | 17 | `forms-and-case-writes/subcases-close-condition-active` | `lib/commcare/hqShells.ts::neverCondition` (`type: never`, `operator: null`) |
| `format:markdown` | 13 | `menus-and-case-lists/10-markdown-any-property-or-expression` | `hqJson/caseList.ts::projectColumnToDetail` (`link`) |
| `schema:CaseListForm.label`, `schema:CaseListForm.post_form_workflow` | 9 | `menus-and-case-lists/case-list-form-label-lang`, `case-list-form-post-form-workflow-default-case-list` | `expander.ts::expandDoc` (the no-matches form) |
| `schema:Itemset.sort`, `parser:QueryPromptParser/sort`, `parser:QueryPromptParser/sort@ref` | 2 | `case-search/itemset-sort-over-a-lookup-field` (two keys also `case-search/itemset-refs-to-item-attributes-attr-or-property-qualified`) | `lib/commcare/suite/case-search/searchPrompts.ts` (`SearchInputLookupOptions.sortColumnId`) |
| `session-path:session/context/drift` | 385 (local archives) | `expressions-and-data/session-context-drift` | `lib/commcare/xform/metaBlock.ts::addMetaBlock`, the `meta/drift` setvalue of every form's meta block |

Four of these are dispositions that were wrong when step 2 made the slot: `appSettings.showSavedForms`
and `showIncompleteForms` (#755), `localization.wireCodes` (#752), and `sortColumnId` (#762).

**Readings that are wrong at the pins.** `here()` is held as running in the case detail on Web Apps,
which no client makes possible (§3.6); the case list menu item is held as leaving an empty list on Web
Apps, which it does not; the date-and-time hidden sibling is held as unavailable on Web Apps, which it
is not.

**The inventory sentence.** `lib/commcare/CLAUDE.md` ("The surface manifest") says the inventory
"stays the research's evidence and is not kept in step with it", while steps 2 and 3 edited the rows
of every entry they moved.

## 2. The HELD-NEW check (pull request 1)

### 2.1 `proof/checks/manifest_usage.py`

1. **The standing.** The constants line becomes
   `HELD, UNNAMED, REFUSED, UNDECIDED, UNHELD, HELD_NEW = "held", "unnamed", "refused", "undecided", "unheld", "held-new"`.
   `HELD_NEW` stays out of `NOT_DIFFERENCES` (which stays `{HELD, BAR, SOURCE}`).
2. **The plan.** `_Plan` gains the field `new: tuple`, after `allowed`: the HELD-NEW entries naming
   the key. Its docstring's list gains "the HELD-NEW entries naming it (``new``)".
3. **`_standing_plan`.** The loop's head becomes:

   ```python
   refusing, source, new, readers = [], [], [], []
   allowed = False
   for entry in entries:
       if entry.disposition == "HELD-NEW":
           new.append(entry)
           continue
       if entry.disposition != "REFUSED":
           allowed = True
           continue
   ```

   The rest of the loop is unchanged. The bar's early return becomes
   `_Plan(entries, (), False, (), (), (), (BAR, entries))`, the plan is
   `_Plan(entries, tuple(refusing), allowed, tuple(new), tuple(source), tuple(readers), None)`, and
   the static return is `_Plan(entries, plan.refusing, allowed, plan.new, plan.source, (), static)`.
4. **`_evaluate`.** The tail becomes:

   ```python
       if taken:
           return SOURCE, tuple(taken)
       if unsure:
           return UNDECIDED, tuple(unsure)
       if plan.new:
           return HELD_NEW, plan.new
       return UNHELD, plan.entries
   ```

   So a REFUSED class that takes the use still refuses it, an allowing entry beside a HELD-NEW one
   still holds it, and in a local archive a use a class refused for the source takes is still
   `SOURCE`, judged on the app JSON that carries the same choice. Decision: `HELD_NEW` comes after
   the source tail, not before it. Reason: placed before it, a use in a local archive that the app
   JSON's REFUSED class already reports would be reported a second time as held-new, one symptom
   split in two, which `standing`'s rule for the archives exists to prevent.
5. **`_path` and `unclassified`** need no code change: `unclassified` already names a standing that
   is not REFUSED or UNDECIDED once per key (`for entry in entries if kind in (REFUSED, UNDECIDED) else (None,)`),
   so `_path(use.key, HELD_NEW)` is `/<key>/held-new`, the difference rests on the HELD-NEW entries
   (`after.entries`), and its kind is `refused` as every other manifest difference's. Their docstrings
   gain the path: in `_path`, "``/<key>/unheld`` or ``/<key>/held-new``"; in `unclassified`, before
   "and one every entry rules out", "one only HELD-NEW entries name is ``/<key>/held-new``".
6. **`standing`'s docstring.** The sentence "An allowing entry's class is what its row describes,
   never read" is preceded by "An allowing entry is HELD, TARGET-OWNED or INERT; a HELD-NEW entry
   allows nothing." After the bullet "else, in a local archive, a use some source-refused entry's
   class takes is ``SOURCE``, and one some such class may take, its reader not saying,
   ``UNDECIDED``;" and before the ``UNHELD`` bullet, the order item 4 gives the code, a bullet is
   inserted: "else a use some HELD-NEW entry names is ``HELD_NEW``, resting on each such entry:
   Nova's export uses an item the manifest says Nova does not hold yet, so the entry's disposition
   or the emitter is wrong, never a symptom a register entry holds;". It ends with the limit: "A HELD-NEW class that shares its key with an
   allowing class is not judged, since allowing classes have no readers: a use of the key is held
   whichever class it is in."
7. **The module docstring.** In the paragraph that lists the paths, "``/<key>/undecided/<value class>``
   (the REFUSED class the check does not read there) and ``/<key>/unheld``" becomes
   "``/<key>/undecided/<value class>`` (the REFUSED class the check does not read there),
   ``/<key>/held-new`` (only HELD-NEW entries name the key: Nova emits what the manifest says it does
   not hold yet) and ``/<key>/unheld``". In the same paragraph, before "An allowing entry's class is
   what its row describes", the sentence "An allowing entry is HELD, TARGET-OWNED or INERT." is
   inserted.

### 2.2 `proof/checks/registers.py`

Beside `UNDECIDED_STEP` and `_undecided`:

```python
# The step of a manifest path that names a use only HELD-NEW entries name
# (proof.checks.manifest_usage.HELD_NEW, written /<key>/held-new).
HELD_NEW_STEP = "held-new"


def _held_new(path):
    steps = path.split("/")
    return len(steps) > 2 and steps[2] == HELD_NEW_STEP
```

In `_field_problems`, after the undecided rule:

```python
    if raw.get("check") == "manifest" and isinstance(raw.get("path"), str) and _held_new(raw["path"]):
        problems.append(
            f"{where}: path {raw['path']!r} is a use only HELD-NEW entries name: Nova's export uses an item"
            " the manifest says Nova does not hold yet. That is a disposition to correct or an emission to"
            " stop, never a symptom a register entry holds. Mark the entry HELD in"
            " lib/commcare/surface/entries/ where Nova holds or derives the item, or stop the emitter"
            " writing it."
        )
```

`_field_problems` serves both registers, so a fixed entry is refused the same way. The module
docstring gains, after the undecided bullet:

```
- A ``manifest`` entry never names a held-new use (``/<key>/held-new``): an
  item only HELD-NEW entries name is in Nova's export, so the entry's
  disposition or the emitter is wrong, which is corrected, never held.
```

A key's step is written with `pointer_token` (a `/` in a key is `~1`), so the third step of a path
is the standing for every key, as `_undecided` already relies on.

### 2.3 `proof/README.md`

- "Manifest checks", the paragraph ending "closes and that the register refuses to hold.": add after
  it, in the same paragraph, "A use whose key only HELD-NEW entries name is held-new: Nova emits an
  item the manifest says it does not hold yet, so the entry's disposition or the emitter is wrong,
  and the register refuses to hold it too."
- The next paragraph's "`/<key>/undecided/<value class>` and `/<key>/unheld` (every entry naming the
  key rules the use out)" becomes "`/<key>/undecided/<value class>`, `/<key>/held-new` (only
  HELD-NEW entries name the key) and `/<key>/unheld` (every entry naming the key rules the use
  out)"; and its "An allowing class is what its row describes" is preceded by "An allowing class is
  a HELD, TARGET-OWNED or INERT entry's."
- The register's bullet "A manifest entry never names an undecided use: that is a gap in the check."
  becomes "A manifest entry never names an undecided use, a gap in the check, or a held-new one, a
  disposition to correct or an emission to stop."
- The loader's rule 1 "it names no undecided manifest use" becomes "it names no undecided or held-new
  manifest use".

### 2.4 `lib/commcare/CLAUDE.md`

In "The surface manifest", the sentence "The proof lane's manifest check holds Nova's own exports to
the entries: every item an export uses must be held by the entry whose value class takes it, and
every flag HQ reads while building it must have a gate entry (`proof/README.md`, "Manifest
checks")." becomes "The proof lane's manifest check holds Nova's own exports to the entries: every
item an export uses must be held by the entry whose value class takes it, where holding is a HELD,
TARGET-OWNED or INERT entry's, so a use whose key only HELD-NEW entries name is a difference
(`/<key>/held-new`); and every flag HQ reads while building it must have a gate entry
(`proof/README.md`, "Manifest checks")." Rewrapped to the file's width.

### 2.5 Tests

`proof/checks/test_manifest.py` (pure, no Docker), new
`test_a_use_only_held_new_entries_name_is_held_new`, over `_built`:

```python
NEW = ("questions/new", "HELD-NEW", "new-class")
entries = {
    "jr-type:int": [NEW],
    "jr-type:date": [NEW, ("questions/held", "HELD", "held-class")],
    "jr-type:time": [NEW, ("questions/target", "TARGET-OWNED", "target-class")],
    "jr-type:long": [NEW, ("questions/inert", "INERT", "inert-class")],
    "jr-type:decimal": [NEW, ("questions/refusing", "REFUSED", "refused-class", EDITOR)],
}
built = _built(entries, {"questions/refusing": _placed(True, False)})
```

It asserts:

- `jr-type:int` at `form:0.0` is `(HELD_NEW, ["new-class"])`;
- `jr-type:date`, `jr-type:time` and `jr-type:long` are `(HELD, [])`: any allowing entry beside a
  HELD-NEW one holds the use;
- `jr-type:decimal` at where `0` is `(REFUSED, ["refused-class"])` and at where `1` is
  `(HELD_NEW, ["new-class"])`;
- in `local.ccz/form:0.0`, `jr-type:decimal` at where `0` is `(SOURCE, ["refused-class"])` (the
  editor class is the source's) and at where `1` is `(HELD_NEW, ["new-class"])`;
- `unclassified("doc", [Use("jr-type:int", "form:0.0", "0"), Use("jr-type:date", "form:0.0", "0")], built)`
  is one difference, path `/jr-type:int/held-new`, `after["entries"]` naming `questions/new`.

Its docstring: "A use whose key only HELD-NEW entries name is Nova emitting what the manifest says it
does not hold yet: held-new, named after the key alone and resting on those entries. An allowing
entry (HELD, TARGET-OWNED or INERT) beside it holds the use, a REFUSED class that takes the use still
refuses it, and in a local archive a class refused for the source still takes its uses as the
source's."

`proof/checks/test_registers.py`, new `test_a_manifest_entry_never_holds_a_held_new_use`, beside
`test_a_manifest_entry_holds_a_refused_class_and_never_an_undecided_one` and built as it is: an entry
`{**GOOD, "check": "manifest", "artifact": "app.json", "path": "/schema:Application.auto_gps_capture/held-new"}`
raises `RegisterError` matching `"Mark the entry HELD"`. The test belongs to the register's test
file, not `test_manifest.py`, because the refusal is the loader's.

The real corpus is the check's own test: the pull request lane's `manifest` check runs over every
document and holds each difference to the register, so a held-new use the flips of §3 miss fails
pull request 1. Expected: none once §3's edits land, the meta entry's drift key of §3.5 among them:
planning found the 35 keys the extraction lists, and the 36th, the meta block's read of
`session/context/drift` in every local archive, by a scan of those archives (executed during
planning). If the run shows one, it is resolved the
way §3 resolves the 36 keys, by the entry's disposition where Nova holds or derives the item and by
the emitter otherwise, before pull request 1 merges; it is never registered. A retained control
cannot fail this way: on a control the check needs only that the entries naming it still show
(`proof/checks/cases.py::hold`).

## 3. Pull request 1: the flips of what Nova emits, and the readings

Conventions for §3 to §8:

- "→ HELD" sets `"disposition": "HELD"` and, since a HELD-NEW entry has no `slotChanges`
  (`lib/commcare/surface/schema.ts::inventoryEntrySchema`), adds `"slotChanges"`: `[]`, or the one
  widen or narrow the cell names, as `{"direction": "widen" | "narrow", "text": <the text after
  "widen: " or "narrow: " in the cell>}`. The cell holds that text verbatim, as
  `manifest.test.ts`'s instance-read test reads it.
- Every other field of an entry is unchanged unless the table says so.
- "Row" is the inventory row whose HQ item cell is the entry's `item`, in
  `docs/research/2026-09-26-hq-round-trip/inventory/<area>.md`. Its Disposition cell is the
  entry's `dispositionCell`, before and after, unless the table gives the row's old text separately;
  its Web Apps / Android cell is the entry's `platforms.cell` where the table changes it.
- Text in tables is the JSON value; a `"` inside a JSON string is written `\"` in the file.

### 3.1 Settings and profile (`entries/application-and-settings.json`)

Nova writes all seventeen profile settings on every export
(`lib/commcare/appProfileSettings.ts::appProfileProperties`): fifteen at the value a device reads
when the key is absent (`SEEDED_PROFILE_PROPERTIES`), and Nova's two settings
(`OWNED_PROFILE_PROPERTY_KEYS`, from `lib/domain/blueprint.ts::appSettingsSchema`).

**The fifteen seeds**, each → HELD with one widen. For each row of the table, with `<seed>`,
`<concept>` and the widen text W:

- W = "`appSettings.<concept>`, any of the setting's choices", except for 27, where W =
  "`appSettings.autoCaptureAccuracy`, any of the setting's choices (the number `10` that HQ's own
  settings save stores when none was chosen, from the yaml's numeric default against string choices,
  is the same state as `'10'`)";
- `dispositionCell`: "**HELD-NEW**: `appSettings.<concept>`" (27: with its parenthesis) →
  "**HELD**: Nova's seed `<seed>`, the value a device reads when the key is absent
  (`appProfileSettings.ts::SEEDED_PROFILE_PROPERTIES`); widen: W";
- `slotChanges`: `[{"direction": "widen", "text": W}]`;
- Row: Disposition cell to the new `dispositionCell`.

| Entry (`application-and-settings/…`) | `<seed>` | `<concept>` |
|---|---|---|
| `1-properties-cc-autoup-freq` | `freq-never` | `autoUpdateFrequency` |
| `4-properties-cc-days-form-retain` | `-1` | `daysFormRetain` |
| `5-properties-logenabled` | `Enabled` | `loggingEnabled` |
| `13-properties-cc-autosync-freq` | `freq-never` | `autoSyncFrequency` |
| `17-properties-cc-content-valid` | `no` | `multimediaValidation` |
| `18-properties-unsent-number-limit` | `5` | `unsentFormLimit` |
| `19-properties-unsent-time-limit` | `5` | `unsyncedTimeLimit` |
| `22-properties-cc-resize-images` | `none` | `resizeImages` |
| `23-properties-cc-fuzzy-search-enabled` | `no` | `fuzzyListSearch` |
| `25-properties-cc-login-duration-seconds` | `86400` | `loginDuration` |
| `26-properties-cc-inflation-target-density` | `none` | `imageTargetDensity` |
| `27-properties-cc-gps-auto-capture-accuracy` | `10` | `autoCaptureAccuracy` |
| `28-properties-cc-maps-default-layer` | `normal` | `defaultMapLayer` |
| `29-properties-cc-enable-tts` | `no` | `textToSpeech` |
| `30-properties-cc-label-required-questions-with-asterisk` | `no` | `requiredAsterisk` |

The seeds are the values `SEEDED_PROFILE_PROPERTIES` holds at `main`, each read against its entry's
`emission.cell`, which already names it.

**Nova's two settings**, → HELD with no slot change:

| Entry | `dispositionCell`: old → new |
|---|---|
| `20-properties-cc-show-saved` | "**HELD-NEW**: `appSettings.showSavedForms`" → "**HELD**: `appSettings.showSavedForms`" |
| `21-properties-cc-show-incomplete` | "**HELD-NEW**: `appSettings.showIncompleteForms`" → "**HELD**: `appSettings.showIncompleteForms`" |

**Language codes.** `langs-code-spelling-matching-hq-s-grammar-a-z-2-3-a-z-e-g-en-hin` → HELD,
`slotChanges` `[]`; `dispositionCell` "**HELD-NEW**: `localization.wireCodes`: the exact HQ code per
language (codes are external identity: device locale, build profiles, UI strings)" → "**HELD**:
`localization.wireCodes`: the exact HQ code per language (codes are external identity: device
locale, build profiles, UI strings)". Held since #752 (`lib/domain/localization.ts`, `wireCodes`).

**Auto GPS.** `45-hq-auto-gps-capture` → HELD:

- `dispositionCell`: "**HELD-NEW**: read as `Form.autoCaptureLocation` on every form, since HQ
  captures location for a form when the form or the app says so (`FormBase.get_auto_gps_capture`;
  today Nova derives the app value only from `connectType`)" → "**HELD**: derived: `true` on a
  Connect app, absent otherwise, which keeps the Auto Capture Location a person turned on in HQ
  (`expander.ts::expandDoc` from `connectType`, `hqShells.ts::applicationShell`); widen:
  `Form.autoCaptureLocation`, read on every form, since HQ captures location for a form when the form
  or the app says so (`FormBase.get_auto_gps_capture`)".
- `slotChanges`: `[{"direction": "widen", "text": "`Form.autoCaptureLocation`, read on every form,
  since HQ captures location for a form when the form or the app says so
  (`FormBase.get_auto_gps_capture`)"}]`.
- `platforms.webApps.note`: "`meta/location` submitted empty" → "`meta/location` submitted empty;
  HQ's own setting names it Android's (`commcare-app-settings.yml`, `auto_gps_capture`)";
  `platforms.cell`: "IGNORED (`meta/location` submitted empty) / RUNS" → "IGNORED (`meta/location`
  submitted empty; HQ's own setting names it Android's, `commcare-app-settings.yml`,
  `auto_gps_capture`) / RUNS".
- `emission.cell`: "`false`, with each form's own value" → "`true` on a Connect app; absent
  otherwise, which keeps a value set in HQ".
- Row: Disposition, Web Apps / Android and Emission cells to the new values.

Citations: `lib/commcare/expander.ts::expandDoc` (`...(doc.connectType && { autoGpsCapture: true })`),
`lib/commcare/hqShells.ts::applicationShell` (writes `auto_gps_capture: true` only then, and its
comment: an absent key keeps the setting a person turned on in HQ); commcare-hq
`corehq/apps/app_manager/models/forms.py::FormBase.get_auto_gps_capture` (`self.auto_gps_capture or
app.auto_gps_capture`); `corehq/apps/app_manager/static/app_manager/json/commcare-app-settings.yml`,
setting `auto_gps_capture` ("On CommCare Android, have this form automatically capture the user's
current geo-location."). `forms-and-case-writes/auto-gps-capture-form` stays HELD-NEW: Nova writes no
form's `auto_gps_capture`.

### 3.2 Menus and case lists (`entries/menus-and-case-lists.json`)

| Entry | Change |
|---|---|
| `10-markdown-any-property-or-expression` | → HELD. `dispositionCell` "**HELD-NEW**: `markdown` column kind (Nova's `link` is the fixed `[text](value)` case)" → "**HELD**: the `link` column kind, the fixed `[text](value)` case (`hqJson/caseList.ts::projectColumnToDetail`, `suite/case-list/columns.ts`); widen: a `markdown` column kind over any property or expression". Widen text "a `markdown` column kind over any property or expression". |
| `21-translatable-enum-authored` | → HELD. `dispositionCell` "**HELD-NEW**: `translatedExpression` column kind: a calculated expression whose key substrings are replaced by localized variables (one that is exactly Nova's label projection of a select property, `plainSelectDisplayXpath` over the property's options, reads back as a plain column over that property)" → "**HELD**: derived: Nova's label projection of a select property (`plainSelectDisplayXpath` over the property's options) and an interval column's text, each a calculated `translatable-enum` (`hqJson/caseList.ts::projectColumnToDetail`), which reads back as the column it came from; widen: the `translatedExpression` column kind, a calculated expression whose key substrings are replaced by localized variables". Widen text "the `translatedExpression` column kind, a calculated expression whose key substrings are replaced by localized variables". |
| `enum-mappingitem-alt-text-lang` | → HELD. `dispositionCell` "**HELD-NEW**: `imageMap[].altText` and the `clickableIcon` mapping's alt text (`app_strings.py` writes both)" → "**HELD**: derived: a blank alt text for each key of an image map, in every language, as HQ's build gives a mapping with none (`suite/case-list/columns.ts::imageMapAltText`); widen: `imageMap[].altText` and the `clickableIcon` mapping's alt text (`app_strings.py` writes both)". Widen text "`imageMap[].altText` and the `clickableIcon` mapping's alt text (`app_strings.py` writes both)". |
| `module-case-list-label-lang` | → HELD. `dispositionCell` "**HELD-NEW**: `Module.caseListLabel` (Nova reuses the module name today)" → "**HELD**: derived: the module's name, on a menu that holds only a case list (`expander.ts::expandDoc`, `caseListOnly`); widen: `Module.caseListLabel`, a label of its own". Widen text "`Module.caseListLabel`, a label of its own". |
| `case-list-form-label-lang` | → HELD, `slotChanges` `[]`. `dispositionCell` "**HELD-NEW**: `caseListRegistrationForm.label`" → "**HELD**: the no-matches form's label in the case list: its entry label, else its name (`emissionPlan.ts::caseListFormLabelUnit`)". |
| `case-list-form-post-form-workflow-default-case-list` | → HELD. `dispositionCell` "**HELD-NEW**: `caseListRegistrationForm.afterSubmit`" → "**HELD**: derived: `case_list` for the no-matches form (`expander.ts::expandDoc`); widen: the no-matches form's after-submit destination, `default` or `case_list`". Widen text "the no-matches form's after-submit destination, `default` or `case_list`". |
| `module-case-list-on-a-formless-basic-module-show-true` | Reading corrected, §3.6. |
| `detail-no-items-text-equal-to-hq-s-default` | `item` "`Detail.no_items_text` equal to HQ's default" → "`Detail.no_items_text` equal to HQ's default text (`List is empty.`), in any of the app's languages". Row: HQ item cell to match. Reason: Nova writes that text under every language's code on every menu (`expander.ts::expandDoc`, `repeatForLanguages(…, EMPTY_CASE_LIST_TEXT)`), which is this INERT class in substance, while the item read as HQ's literal `en`-only default. No verdict moves (the key is already allowed by this INERT entry). |

Each row's Disposition cell takes the entry's new cell, and the HQ item cell where the table says so.

`case-list-form-label-lang` takes no widen, departing from the outline's `caseListRegistrationForm.label`:
Nova already holds that label, the no-matches form's entry label or name
(`lib/commcare/emissionPlan.ts::caseListFormLabelUnit`), so nothing is left to add.

### 3.3 Case search (`entries/case-search.json`)

| Entry | Change |
|---|---|
| `itemset-sort-over-a-lookup-field` | → HELD, `slotChanges` `[]`. `dispositionCell` "**HELD-NEW**: `options.sortColumn` (the carrier has no sort today)" → "**HELD**: `SearchInputLookupOptions.sortColumnId` (absent: the label column)". Held since #762 (`lib/domain/modules.ts::searchInputLookupOptionsSchema`). |
| `workflow-skip-to-default-results-auto-launch-true-default-search` | → HELD. `dispositionCell` "**HELD-NEW**: `caseSearchConfig.workflow: skipToResults` (authored; today Nova derives it only for a filter with no visible inputs)" → "**HELD**: derived for a module whose search has an effective filter and no visible Search field (`suite/case-search/compileForPlatform.ts::compileForPlatform`); widen: `caseSearchConfig.workflow: skipToResults`, authored". Widen text "`caseSearchConfig.workflow: skipToResults`, authored". |

Rows: Disposition cells. Skip-to-results shares its keys with HELD entries, so the extraction never
showed it; it is flipped because Nova emits it (`compileForPlatform` returns `autoLaunch: true,
defaultSearch: true` for an effective filter with no visible Search field) and the platform table
names it (part 01 §4.2, `skip-to-results`). The cell cites `compileForPlatform` because that is the
function's name at pull request 1; pull request 4 renames it and updates the cite (§5.4).

### 3.4 Forms and case writes (`entries/forms-and-case-writes.json`)

**`xmlns-form-json-and-xform-data-node`** → HELD:

- `dispositionCell`: "**HELD-NEW**: `Form.xmlns`, the submission identity a new project space and the
  local `.ccz` take (exports, UCR, repeaters and forwarders key on it); the deployment ledger records
  each project space's `xmlns`, and a project space that already has its own keeps it" → "**HELD**:
  derived from the form's UUID (`wireIdentity.ts::derivedFormXmlns`), or the `xmlns` the deployment
  ledger records for that project space (`app_deployment_identities`,
  `wireIdentity.ts::targetWireIdentity`); widen: `Form.xmlns`, a stored submission identity an import
  keeps for a new project space and the local `.ccz`".
- `slotChanges`: `[{"direction": "widen", "text": "`Form.xmlns`, a stored submission identity an
  import keeps for a new project space and the local `.ccz`"}]`.
- `emission.cell`: "the target's recorded `xmlns`, or `Form.xmlns` (today re-minted per expansion)"
  → "the target's recorded `xmlns`, else the one derived from the form's UUID".
- Row: Disposition and Emission cells.

**`subcases-close-condition-never`** (new INERT), inserted after `subcases-close-condition-active`:

```json
{
  "id": "forms-and-case-writes/subcases-close-condition-never",
  "area": "forms-and-case-writes",
  "section": "Basic form actions",
  "item": "`subcases[].close_condition` never (any `operator`)",
  "surfaceKeys": ["schema:OpenSubCaseAction.close_condition"],
  "valueClass": "subcase-close-never",
  "disposition": "INERT",
  "dispositionCell": "**INERT**: no close: HQ reads only the condition's `type` (`models/form_actions.py::FormActionCondition.is_active`), and its `operator` only where the type is `if` (`xform.py::XForm.action_relevance`), so `never` with any `operator` is HQ's default",
  "platforms": { "kind": "not-applicable", "cell": "n/a" },
  "emission": { "cell": "`never`, `operator: null` (`hqShells.ts::neverCondition`)", "markers": [] },
  "gates": []
}
```

Row added after the row "`subcases[].close_condition` active":
`| \`subcases[].close_condition\` never (any \`operator\`) | <the dispositionCell above> | n/a | \`never\`, \`operator: null\` (\`hqShells.ts::neverCondition\`) |`.

Citations: commcare-hq `corehq/apps/app_manager/models/form_actions.py::FormActionCondition`
(`type` default `never`, `operator` default `'='`, `is_active` is `self.type in ('if', 'always')`),
`corehq/apps/app_manager/xform.py::XForm.action_relevance` (reads `operator` only under
`type == 'if'`); Nova `lib/commcare/hqShells.ts::neverCondition` writes `operator: null`, which is
why the field differs from HQ's default and is a use at all.

**`update-from-a-date-and-time-question-through-a-hidden-sibling`**: reading corrected, §3.6.

### 3.5 Questions (`entries/questions.json`)

**`label-trigger-whose-appearance-is-exactly-minimal`**: `surfaceKeys` gains
`"appearance:web-apps/minimal"` after `"appearance:android/minimal"`. Readings unchanged; the row is
unchanged, since its HQ item cell already names the trigger's appearance value. Reason: the surface
item `appearance:web-apps/minimal` records no `controls` (`surface.json`; its reader is
`cloudcare/js/form_entry/form_ui.js::getMatchingStyles`), so the extraction puts it on every element
whose appearance holds the token, Nova's label `<trigger appearance="minimal">` among them, where only
`questions/select1-minimal` and `questions/select-minimal` (HELD-NEW) name it today. Web Apps acts on
`minimal` only for a select: commcare-hq
`corehq/apps/cloudcare/static/cloudcare/js/form_entry/entries.js::getEntry` reads
`stylesContains(constants.MINIMAL)` under `constants.SELECT` and `constants.MULTI_SELECT`, and a label
(`constants.INFO`) is an `InfoEntry`. So the label's token runs, unread, on both platforms.
Recording `controls` for that item in the surface extractor (`proof/surface/`) instead would need a
surface regeneration in the proof image, which step 4 does not need.

**`hq-generated-meta-deviceid-timestart-timeend-username-userid`**: `surfaceKeys` gains
`"session-path:session/context/drift"` after `"xform:model/instance//*"`. Value class
(`hq-build-meta`), readings and row unchanged: its HQ item cell already names `drift`, and its Web
Apps note already says "`drift` 0". Reason: Nova's local archive writes the meta block HQ's build
adds, since it has no HQ build step (`lib/commcare/compiler.ts`, "`addMetaBlock` is
unconditional"), and that block's `meta/drift` setvalue reads
`instance('commcaresession')/session/context/drift` under a count guard
(`lib/commcare/xform/metaBlock.ts::addMetaBlock`), as HQ's own build writes it (commcare-hq
`corehq/apps/app_manager/xform.py::XForm._add_meta_2`). `surface.json` records
`xform:setvalue@value` as `parsedAs: xpath`, so the lane parses that value and
`proof/checks/manifest_usage.py::_expression_uses` names `session-path:session/context/drift` on
every form of every local archive. Today only `expressions-and-data/session-context-drift` names that
key, and it is HELD-NEW until pull request 10 (§8.1), so without this key §2's check would report a
held-new difference on every document with a form. The read is what HQ's build adds, which is this
entry's class; part 01 lists the entry as ambient (part 01 §4.3), so the binding test needs no
change.

**`hidden-value-bound-xsd-datetime`** (new, `origin: "export-use"`, so no row), inserted after
`questions/hidden-value-with-children`:

```json
{
  "id": "questions/hidden-value-bound-xsd-datetime",
  "area": "questions",
  "section": "Question types",
  "item": "Hidden Value (data node and bind, no control) whose bind type is `xsd:dateTime`",
  "surfaceKeys": ["jr-type:dateTime", "xform:model/bind@type"],
  "valueClass": "hidden-value-datetime",
  "origin": "export-use",
  "disposition": "HELD",
  "dispositionCell": "**HELD**: a Hidden Value that writes a date-and-time case property, bound `xsd:dateTime` (`lib/domain/fieldValueType.ts::fieldValueType`); widen: a Hidden Value that writes nothing, bound `xsd:dateTime` where its calculate keeps a date's clock (`datePattern.ts::isClockKeepingDate`)",
  "slotChanges": [
    {
      "direction": "widen",
      "text": "a Hidden Value that writes nothing, bound `xsd:dateTime` where its calculate keeps a date's clock (`datePattern.ts::isClockKeepingDate`)"
    }
  ],
  "platforms": {
    "kind": "each",
    "cell": "RUNS / RUNS",
    "webApps": { "reading": "runs" },
    "android": { "reading": "runs" }
  },
  "emission": { "cell": "`type=\"xsd:dateTime\"` on the bind of a data node no control draws", "markers": [] },
  "gates": []
}
```

Reason: `lib/domain/fieldValueType.ts::fieldValueType` binds a Hidden Value that writes a
date-and-time property `xsd:dateTime` today, and the keys it uses are named, with a reading of
unavailable on Web Apps, only by `questions/date-and-time-xsd-datetime` among the classes that
describe a question's type. The unavailability is the question's widget ("web entry cannot
support"); a bind with no control has no widget on either platform, and Core evaluates its calculate
(commcare-core `org/javarosa/core/model/FormDef.java::initialize`, which computes every calculate
whether or not a control draws its node). The key is shared
with allowing entries, so the lane's verdict does not move; the entry is what the platform table's
reading of a bind-only `xsd:dateTime` stands on (part 01 names no feature for it, since it reads the
same on both platforms).

The widen names `lib/domain/expression/datePattern.ts::isClockKeepingDate`, the predicate pull
request 3 adds (part 03 §2.6) and §4 holds; at pull request 1 it does not exist yet, which a widen,
the concept a later pull request adds, may name.

### 3.6 Readings corrected

**`expressions-and-data/here-in-a-case-list-calculated-column-or-sort`** (HELD; reading stays
`unavailable`):

- `platforms.webApps.note`: "in case-list rows and sorts (Core's São Paulo placeholder,
  `EntityScreen`), RUNS in the case detail with the browser's location, blank until granted
  (`MenuSessionRunnerService`, `FormplayerHereFunctionHandler`)" → "in case-list rows, sorts and the
  case detail: Core's São Paulo placeholder where Formplayer builds the list (`EntityScreen`), and
  `''` everywhere else, since HQ's Web Apps client sends no location
  (`SessionNavigationBean.getGeoLocation`, `FormplayerHereFunctionHandler`)".
- `platforms.cell`: "UNAVAILABLE in case-list rows and sorts (Core's São Paulo placeholder,
  `EntityScreen`), RUNS in the case detail with the browser's location, blank until granted
  (`MenuSessionRunnerService`, `FormplayerHereFunctionHandler`) / RUNS" → "UNAVAILABLE in case-list
  rows, sorts and the case detail (Core's São Paulo placeholder where Formplayer builds the list,
  `EntityScreen`; `''` everywhere else, since HQ's Web Apps client sends no location,
  `SessionNavigationBean.getGeoLocation`, `FormplayerHereFunctionHandler`) / RUNS".
- Row: Web Apps / Android cell to the new `platforms.cell`.

Citations: formplayer `services/MenuSessionFactory.java` passes
`sessionNavigationBean.getGeoLocation()` (the request's `geo_location`) to
`MenuSession.setCurrentBrowserLocation`, and `util/FormplayerHereFunctionHandler.java::eval` returns
`""` when that location is null; no script or template under commcare-hq `corehq` names
`geo_location` or `geoLocation` (searched, `*.js` and `*.html`), so HQ's client never sends one;
commcare-core `src/cli/java/org/commcare/util/screen/EntityScreen.java` installs
`ScreenUtils.HereDummyFunc(-23.56, -46.66)` while it builds the list's references.

**`menus-and-case-lists/module-case-list-on-a-formless-basic-module-show-true`** (HELD; readings stay
`different` / `runs`):

- `platforms.webApps.note`: "selecting a case leaves an empty list" → "selecting a case shows
  \"Redirecting after sync\" and returns to the app's first screen".
- `platforms.cell`: "DIFFERENT (selecting a case leaves an empty list) / RUNS (with no case detail,
  selecting a case returns to the home screen)" → "DIFFERENT (selecting a case shows \"Redirecting
  after sync\" and returns to the app's first screen) / RUNS (with no case detail, selecting a case
  returns to the home screen)".
- Row: Web Apps / Android cell.

Citations: formplayer `services/MenuSessionRunnerService.java::advanceSessionWithSelections` reaches
the end of the navigation with no form (the entry HQ builds for `case_list.show` has no `<form>`,
commcare-hq `corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesContributor`), calls
`resolveFormGetNext`, and on its null answers `new BaseResponseBean(null, new
NotificationMessage("Redirecting after sync", …), true)` ("Return use to the app root"); commcare-hq
`corehq/apps/cloudcare/static/cloudcare/js/formplayer/menus/controller.js::selectMenu` shows the
notice and, on `clearSession`, triggers `apps:currentApp`, the app's root menu.

**`forms-and-case-writes/update-from-a-date-and-time-question-through-a-hidden-sibling`** (HELD):

- `platforms.webApps`: `{"reading": "unavailable", "note": "the question has no Web Apps entry:
  defect 18"}` → `{"reading": "runs"}`; `platforms.cell`: "UNAVAILABLE (the question has no Web Apps
  entry: defect 18) / RUNS" → "RUNS / RUNS".
- Row: Web Apps / Android cell "RUNS / RUNS".

Reason: the sibling is a calculate that Core runs on both platforms, and Nova allocates it for every
`caseWrite` whose bind type is `datetime` (`lib/commcare/xform/generatedNodes.ts::planGeneratedNodes`,
the `nova_datetime_<id>` branch), which includes a Hidden Value that writes a date-and-time property.
The question's own unavailability stays on `questions/date-and-time-xsd-datetime`, where the
validator reads it (part 01 §4.1, `datetime-question`), so a date-and-time question feeding the sibling is still refused where
Web Apps is declared.

### 3.7 Inventory rows in pull request 1

| File | Rows (by HQ item cell) |
|---|---|
| `application-and-settings.md` | `` `langs` code spelling … ``; the seventeen `properties.*` rows 1, 4, 5, 13, 17 to 23, 25 to 30; `45 hq.auto_gps_capture` |
| `menus-and-case-lists.md` | `` `Module.case_list` on a formless basic module (`show: true`) ``; `` `Module.case_list.label{lang}` ``; `` `Detail.no_items_text` equal to HQ's default `` (item cell); `` `enum[]` `MappingItem.alt_text{lang}` ``; `` 10 `markdown` (any property or expression) ``; `` 21 `translatable-enum` (authored) ``; `` `case_list_form.label{lang}` ``; `` `case_list_form.post_form_workflow` (`default` / `case_list`) `` |
| `case-search.md` | `workflow Skip to Default Results …`; `` `itemset.sort` over a lookup field `` |
| `forms-and-case-writes.md` | `` `xmlns` (form JSON and XForm data node) ``; `update from a date-and-time question through a hidden sibling …`; a new row after `` `subcases[].close_condition` active `` |
| `expressions-and-data.md` | `` `here()` in a case-list calculated column or sort `` |

`questions.md` takes no edit: the label entry's and the meta entry's added keys change no cell, and
`hidden-value-bound-xsd-datetime` has no row (`export-use`).

Old cells are the entries' old values quoted in §3.1 to §3.6, which each row holds verbatim (read
for this part). Two rows carry an Emission cell older than their entry's and are left as they are,
since no step 4 edit touches their emission: `20 properties.cc-show-saved` and `21
properties.cc-show-incomplete` (their `.ccz` parity note was step 2's fix). `45 hq.auto_gps_capture`'s
Emission cell moves with its entry.

### 3.8 What the flips leave HELD-NEW, and why the check still passes

The entries that share one of the 36 keys and stay HELD-NEW are each beside an entry this pull
request makes allowing: `questions/select1-minimal` and `questions/select-minimal` beside the label
entry; `expressions-and-data/session-context-drift` beside the meta entry, until pull request 10
makes it HELD (§8.1); `questions/data-node-xmlns-on-a-hidden-value` beside the `xmlns` entry; the two non-calculated
`translatable-enum` entries beside `21-translatable-enum-authored`;
`case-search/itemset-refs-to-item-attributes-attr-or-property-qualified` beside the lookup sort;
`forms-and-case-writes/subcases-close-condition-active` beside the new INERT class. A use of their
class (a select's `minimal`, an authored active close) would pass as held, which is the limit §2.1
states: an allowing class is never read. Nova has no authored `drift` read before pull request 10
admits one, so the drift entry's class has no use for the meta entry to hide.

### 3.9 The inventory sentence (`lib/commcare/CLAUDE.md`)

In "The surface manifest", "The manifest is the living record of every disposition; the inventory
under `docs/research/2026-09-26-hq-round-trip/` stays the research's evidence and is not kept in step
with it." becomes "The manifest is the living record of every disposition. A change to an entry edits
its row in the inventory under `docs/research/2026-09-26-hq-round-trip/inventory/` in the same pull
request: a split entry adds its row beside the row it splits from, an entry marked `export-use` has
none, and the inventory's Counts table stays the research's." Rewrapped to the file's width.

## 4. Pull request 3: the joined value's entry

When R3 lands (`lib/domain/fieldValueType.ts::fieldValueType` binds `xsd:dateTime` for a Hidden Value
that writes nothing and whose calculate keeps a date's clock, part 03 §2.7, by the predicate
`lib/domain/expression/datePattern.ts::isClockKeepingDate` this pull request adds, part 03 §2.6),
the widen of §3.5 is held:

- `questions/hidden-value-bound-xsd-datetime`, `dispositionCell` → "**HELD**: a Hidden Value bound
  `xsd:dateTime`: one that writes a date-and-time case property, or one that writes nothing whose
  calculate keeps a date's clock (`datePattern.ts::isClockKeepingDate`), as the date-and-time split's joined value
  does (`lib/domain/fieldValueType.ts::fieldValueType`)"; `slotChanges` → `[]`.

No row (`export-use`). The lane's verification is `targeted-datetime-split` (part 08 §4.1): its exports use
`jr-type:dateTime` on a bind with no control, and the `manifest` check shows no difference on it.
Because the key is shared with allowing entries, that run proves no `refused` or `undecided` class
takes the joined value's bind, which is what this entry needs; which allowing entry holds it is not
something the lane reads.

## 5. Pull request 4: Connect and the declaration

### 5.1 A Connect app (`entries/application-and-settings.json`)

New entry, inserted after `application-and-settings/an-unknown-top-level-key-naming-an-application-read-only`
(the last entry of section "Application"):

```json
{
  "id": "application-and-settings/connect-app-opened-in-the-connect-app",
  "area": "application-and-settings",
  "section": "Application",
  "item": "a CommCare Connect app (learn or deliver)",
  "surfaceKeys": [],
  "noSurfaceKey": "Who opens a Connect app is Connect's and HQ's account state, which no export carries: Connect makes each worker's HQ account with no password (commcare-connect users/helpers.py::create_hq_user_and_link), HQ's user page refuses to set one (users/forms.py::SetUserPasswordForm), and HQ takes the worker's PersonalID token only at /oauth/token/ (domain/auth.py::ConnectIDAuthBackend), which the Connect app on Android calls (ApiPersonalId.retrieveHqToken).",
  "origin": "export-use",
  "disposition": "HELD",
  "dispositionCell": "**HELD**: `connectType` (learn or deliver) with its form blocks; declared Android only",
  "slotChanges": [],
  "platforms": {
    "kind": "each",
    "cell": "UNAVAILABLE (a Connect worker has no HQ password and signs in only in the Connect app on Android; the blocks themselves submit and Connect takes them) / RUNS (the Connect app installs the app from its media profile and signs in with PersonalID, `ConnectAppLauncher.awaitOutcome`)",
    "webApps": {
      "reading": "unavailable",
      "note": "a Connect worker has no HQ password and signs in only in the Connect app on Android; the blocks themselves submit and Connect takes them"
    },
    "android": {
      "reading": "runs",
      "note": "the Connect app installs the app from its media profile and signs in with PersonalID, `ConnectAppLauncher.awaitOutcome`"
    }
  },
  "emission": { "cell": "the form blocks and `auto_gps_capture`", "markers": [] },
  "gates": ["toggle/COMMCARE_CONNECT"]
}
```

Citations (read for this part): commcare-connect `commcare_connect/users/helpers.py::create_hq_user_and_link`
(the HQ user payload has a `connect_username` and no password) and
`opportunity/api/serializers/mobile.py::CommCareAppSerializer.get_install_url` (the install URL is the
app's `media_profile.ccpr`); commcare-hq `corehq/apps/users/forms.py::SetUserPasswordForm`
(`user_has_active_personalid_link`), `corehq/apps/domain/auth.py::ConnectIDAuthBackend.authenticate`
("Only allow for the token backend, for now"); commcare-android
`connect/network/personalId/ApiPersonalId.java::retrieveHqToken`,
`connect/ConnectAppLauncher.kt::awaitOutcome`. The block entries (`questions/connect-*`) keep RUNS /
RUNS: at the wire the blocks run on Web Apps, and the unavailability is the account model's, which no
surface item holds, hence `noSurfaceKey`. No inventory row: `export-use`. This is the entry's one
text: part 01 §10.2 cites it, and its emission cell gains `cloudcare_enabled` only in pull request 5
(§6), when Nova first writes the key.

**Gates.** `entries/gates.json`, `toggle/COMMCARE_CONNECT`:

- `contentEntries`: `["questions/connect-learn-module", "questions/connect-assessment",
  "questions/connect-deliver-unit", "questions/connect-task", "questions/connect-work-area-update"]`
  → the same list with `"application-and-settings/connect-app-opened-in-the-connect-app"` first
  (`gates.test.ts`, "govern only inventory entries that exist, in inventory order":
  `application-and-settings` is the first area of `schema.ts::INVENTORY_AREAS`).
- `content`: "HELD / HELD-NEW (Question types Connect blocks)" → "HELD / HELD-NEW (Application: a
  Connect app; Question types Connect blocks)".
- `inventory/gates.md`, the `COMMCARE_CONNECT [connect division]` row's second cell "TARGET-OWNED ·
  HELD / HELD-NEW (Question types Connect blocks)" → "TARGET-OWNED · HELD / HELD-NEW (Application: a
  Connect app; Question types Connect blocks)".

The gate is a precondition toggle the flag probe already asks (`gates.test.ts`, "checks each gate
where the manifest names it"), since the HELD block entries name it.

### 5.2 The declaration's wire form

`application-and-settings/40-hq-cloudcare-enabled` → HELD, `slotChanges` `[]`:

- `dispositionCell`: "**HELD-NEW**: the platform declaration's wire form: `true` exactly when the app
  declares Web Apps (Web Apps lists an app by the value on the build it serves,
  `cloudcare/utils.py::get_web_apps_available_to_user`)" → "**HELD**: `appSettings.runsOnlyOn`, the
  platform declaration, whose wire form this is: `true` exactly when the app declares Web Apps (no
  `runsOnlyOn`, or `web-apps`), `false` for `android` (Web Apps lists an app by the value on the build
  it serves, `cloudcare/utils.py::get_web_apps_available_to_user`)".
- Readings unchanged (RUNS / n/a): Android reads no `cloudcare_enabled`.
- Row `40 hq.cloudcare_enabled`: Disposition cell.

`entries/gates.json`, `privilege/cloudcare`: `content` "HELD-NEW (Settings and profile,
`cloudcare_enabled`)" → "HELD (Settings and profile, `cloudcare_enabled`)". `inventory/gates.md`, the
`` `cloudcare` `` row's second cell "TARGET-OWNED · HELD-NEW (Settings and profile,
`cloudcare_enabled`)" → "TARGET-OWNED · HELD (Settings and profile, `cloudcare_enabled`)". Class
`target-owned` and preflight `confirmation` unchanged; `gates.test.ts`'s probe rule reads toggle
gates only.

Citation: commcare-hq `corehq/apps/cloudcare/utils.py::get_web_apps_available_to_user` lists a build
only where `app.get('cloudcare_enabled')`. Reason for pull request 4: the binding test lands here
(part 01 §8) and lists this entry among the ambient ones (part 01 §4.3), which it requires HELD
(rule 2); the slot it names,
`appSettings.runsOnlyOn`, lands here too. Flipping before Nova emits the key costs nothing: §2's
check fires only on an emitted key, so it reads no use of this entry until pull request 5. Nova
writes the key from pull request 5, which edits only the entry's emission cell (§6); neither part 05
nor part 08 flips the disposition or the gate.

### 5.3 What the binding test may name, by pull request

`lib/commcare/surface/__tests__/platformFeatures.test.ts` (part 01 §8.2, rule 2) requires every
entry a platform feature or `AMBIENT_PLATFORM_ENTRIES` names to be HELD. The manifest edits of this
part make the entries HELD in this order, and the table follows it (part 01 §4.5):

- **From pull request 4**, every entry of the feature and ambient tables part 01 §4 gives is HELD (the
  flips of pull request 1 and §5.1, §5.2), except those of four features and two `search-first`
  entries: `expressions-and-data/session-data-stringquery` (`case-list-search-text`),
  `session-context-window-width` and `case-search/runtime-values-read-from-the-session-context-window-width`
  (`window-width`), `session-context-drift` and
  `case-search/runtime-values-read-from-the-session-context-drift` (`clock-drift`),
  `session-context-applanguage` (`app-language`),
  `search-input-read-in-form-expressions-of-an-inline-search-module` and
  `search-input-results-read-in-the-case-list-of-an-inline-search` (`search-first`). These four
  features and the two entries join the table in pull request 10, where §8 makes them HELD. Under
  outcome B of §8.4, `case-search/runtime-values-read-from-the-session-context-window-width` belongs
  instead to part 01's fifth pull request 10 feature, `window-width-in-search`, since its pair
  (runs / different) is then not `window-width`'s (different / different).
- **Media** (the binding test's rule 7 over `media-format:` keys, part 01 §8.2): from pull request 4
  the rule reads the media entries HELD at `main`; the three that are neither features nor ambient
  (part 01 §4.3) join it in pull request 7, when §7 makes them HELD; `video-mp4-h-264-high`,
  HELD-NEW at `main`, is removed in the same pull request, merged into the Baseline-or-Main entry
  (§7.1). Under the second outcome
  of §7.1's AVIF gate `image-ico` stands where `image-ico-avif` would, so three join under either
  outcome.

### 5.4 Skip-to-results' citation

Pull request 4 renames `lib/commcare/suite/case-search/compileForPlatform.ts::compileForPlatform` to
the platform-free `lib/commcare/suite/case-search/searchWireShape.ts::searchWireShape` (part 01
§4.2). `case-search/workflow-skip-to-default-results-auto-launch-true-default-search`, whose cell
§3.3 wrote at pull request 1, follows it in the same pull request:

- `dispositionCell`: "**HELD**: derived for a module whose search has an effective filter and no
  visible Search field (`suite/case-search/compileForPlatform.ts::compileForPlatform`); widen:
  `caseSearchConfig.workflow: skipToResults`, authored" → "**HELD**: derived for a module whose
  search has an effective filter and no visible Search field
  (`suite/case-search/searchWireShape.ts::searchWireShape`); widen: `caseSearchConfig.workflow:
  skipToResults`, authored". `slotChanges` unchanged.
- Row `workflow Skip to Default Results …` in `case-search.md`: Disposition cell, the same text.

Reason: a cell names the function that derives the item, and after pull request 4 no function of
the old name exists.

## 6. Pull requests 5 and 6: the emission cells of `cloudcare_enabled`, and the sync gate's content

### 6.1 Pull request 5: the emission cells of `cloudcare_enabled`

From this pull request Nova writes `cloudcare_enabled` on every application body it generates
(part 05).

- `application-and-settings/40-hq-cloudcare-enabled`, `emission.cell`: "explicit on every publish
  (create sets it from the plan, `_create_app_from_doc`); privilege `cloudcare` precondition when
  `true`" → "`true` or `false` by the declaration on every application body Nova generates, the update
  and the HQ import file alike, never through the target overlay; HQ's create sets it from the plan
  (`_create_app_from_doc`), and a publish asks before changing it on an app that holds Nova content;
  the `cloudcare` privilege is confirmed at publish for an app that declares Web Apps". Row `40
  hq.cloudcare_enabled`: Emission cell, the same text.
- `application-and-settings/connect-app-opened-in-the-connect-app`, `emission.cell`: "the form blocks
  and `auto_gps_capture`" → "the form blocks and `auto_gps_capture`; `cloudcare_enabled: false` from
  the declaration".

Citation: commcare-hq `corehq/apps/app_manager/models/applications.py::_create_app_from_doc` sets
`app.cloudcare_enabled = domain_has_privilege(domain, privileges.CLOUDCARE)`. Once Nova writes `true`,
`proof/checks/manifest_value_classes.py::list_first_with_web_apps` places every list-first search
module of a document that declares Web Apps in the REFUSED class
`case-search/workflow-legacy-classic-auto-launch-false-in-an-app-with`; the register entries that hold
those differences under defect 21 are part 08's, in this pull request.

### 6.2 Pull request 6: the sync on form entry gate

Pull request 6 asks about sync on form entry for each form that works on a case in a module whose
case list offers Search, in an app that declares Android (part 05 §10). The gate's content cell
states the same predicate:

- `entries/gates.json`, `project-space-setting/CaseSearchConfig.sync_cases_on_form_entry`:
  `content` "for an app that declares Android and has a module that offers search (defect 20)" →
  "for an app that declares Android with a form that works on a case in a module that offers search
  (defect 20)". `contentEntries`, class, preflight and effects unchanged.
- `inventory/gates.md`, the publish-checks paragraph: "that sync on form entry is off for an app
  that declares Android and has a module that offers search (defect 20)" → "that sync on form entry
  is off for an app that declares Android with a form that works on a case in a module that offers
  search (defect 20)".

Citation: commcare-hq `corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper.entry_for_module`
calls `include_post_in_entry` only `if form.requires_case()`, so a module that offers search gives
no entry a claim `<post>` unless its form works on a case. Reason: the cell is the gate's one
statement of when the question is asked, and it would otherwise name modules the question skips.

## 7. Pull request 7: media

This section is the one text of pull request 7's manifest, `media-formats.json` and lane reader
edits; part 04 §7 cites it and keeps only its registry test (part 04 §7.3).

### 7.1 Entries (`entries/expressions-and-data.json`, section Media)

**The two narrows step 2 left**, dropped with `lib/media/mp4.ts` and `lib/media/wav.ts` (part 04
§3.2, §3.3):

| Entry | `dispositionCell` old → new | `slotChanges` |
|---|---|---|
| `audio-mp3-aac-in-m4a-brand-m4a-m4b-flac-pcm-wav-8-or-16-bit` | "**HELD** (MP3, WAV, M4A with a brand check, FLAC; narrow: PCM 8- or 16-bit only, Nova checks no WAV encoding today): audio asset" → "**HELD** (MP3, WAV with an encoding check, M4A with a brand check, FLAC): audio asset" | `[]` |
| `video-mp4-h-264-baseline-or-main-with-aac-lc-or-no-audio-webm` | "**HELD** (MP4, WebM; narrow: Nova checks no MP4 codec today): video asset" → "**HELD** (MP4 with a codec check, WebM): video asset" | `[]` |

Rows: the rows hold older text than the entries. `audio MP3, AAC in M4A (brand `M4A `/`M4B `), FLAC,
PCM WAV (8- or 16-bit)`: Disposition "**HELD** (MP3, WAV; narrow: PCM 8- or 16-bit only, Nova checks
no WAV encoding today) and **HELD** widen (M4A with a brand check, FLAC): audio asset" → the new
`dispositionCell`. `video MP4 H.264 Baseline or Main, with AAC-LC or no audio; WebM VP8 or VP9, with
Vorbis, Opus or no audio`: Disposition "**HELD** (MP4; narrow: Nova checks no codec today) and
**HELD** widen (WebM): video asset" → the new `dispositionCell`.

The video cell names no AAC profile: the media work keeps step 2's choice not to read the AAC object
type, for ADTS as for M4A (part 04 §3.1, `lib/media/CLAUDE.md`, M4A), so from this pull request
`media-formats.json` names AAC where it named AAC-LC (§7.2) and the cell claims no profile check
Nova does not make. The entry's id keeps the research's wording; its `item` changes only by the H.264 High merge below,
and its `valueClass` `mp4-h264-baseline-main-webm` then covers High too (no test or lane reader
names either id or class).

**ICO, SVG and AVIF split.** `image-ico-svg-avif` is removed and replaced, at its position, by:

```json
{
  "id": "expressions-and-data/image-ico-avif",
  "area": "expressions-and-data",
  "section": "Media",
  "item": "image ICO, AVIF",
  "surfaceKeys": [
    "media-format:image/ico",
    "media-format:image/avif",
    "media-class:CommCareImage",
    "media-code:corehq/apps/hqmedia/models.py::CommCareMultimedia.get_class_by_data",
    "media-code:corehq/apps/hqmedia/models.py::CommCareMultimedia.get_base_mime_type",
    "media-code:corehq/apps/hqmedia/models.py::CommCareMultimedia.get_mime_type"
  ],
  "valueClass": "ico-avif",
  "disposition": "HELD",
  "dispositionCell": "**HELD**: an image asset for an app that does not declare Android (every browser in the bar plays them; Android 6.0 does not decode them, AVIF only from Android 14)",
  "slotChanges": [],
  "platforms": {
    "kind": "each",
    "cell": "RUNS / UNAVAILABLE",
    "webApps": { "reading": "runs" },
    "android": { "reading": "unavailable" }
  },
  "emission": { "cell": "same", "markers": [] },
  "gates": []
},
{
  "id": "expressions-and-data/image-svg",
  "area": "expressions-and-data",
  "section": "Media",
  "item": "image SVG",
  "surfaceKeys": [
    "media-format:image/svg",
    "media-class:CommCareImage",
    "media-code:corehq/apps/hqmedia/models.py::CommCareMultimedia.get_class_by_data",
    "media-code:corehq/apps/hqmedia/models.py::CommCareMultimedia.get_base_mime_type",
    "media-code:corehq/apps/hqmedia/models.py::CommCareMultimedia.get_mime_type"
  ],
  "valueClass": "svg",
  "disposition": "REFUSED",
  "dispositionCell": "**REFUSED**: broken at runtime: HQ types it as an image and cannot store it: `CommCareImage.attach_data` opens every image with Pillow, which reads no SVG, and the error escapes `process_bulk_upload_zip`'s loop, so the whole upload stops and no file of that publish is mapped",
  "reasons": [
    {
      "kind": "broken-at-runtime",
      "named": "`hqmedia/models.py::CommCareImage.attach_data` opens every image with Pillow (`get_image_object`), which reads no SVG, and the error escapes `hqmedia/tasks.py::process_bulk_upload_zip`'s loop, so the whole upload stops and no file of that publish is mapped"
    }
  ],
  "platforms": { "kind": "none", "cell": "—" },
  "emission": { "cell": "—", "markers": [] },
  "gates": []
}
```

Row `image ICO, SVG, AVIF` becomes two rows:
`| image ICO, AVIF | **HELD**: an image asset for an app that does not declare Android (every browser in the bar plays them; Android 6.0 does not decode them, AVIF only from Android 14) | RUNS / UNAVAILABLE | same |`
and `| image SVG | <the image-svg dispositionCell> | — | — |`. The old row's clause "an SVG is shown
only as an image, where a browser runs none of its script" leaves with SVG; `media-formats.json`'s SVG
item keeps it as a browser fact.

Citations (read for this part): commcare-hq `corehq/apps/hqmedia/models.py::CommCareImage.attach_data`
calls `get_image_object`, whose `Image.open` failure raises `BadMediaFileException("Upload is not a
valid image file.")`; `corehq/apps/hqmedia/tasks.py::process_bulk_upload_zip` guards only the
`uploaded_zip.read` per file, calls `multimedia.attach_data` unguarded, and its outer
`except Exception` marks the whole job with "Error while processing zip" before `app.save()`, so no
mapping of that upload is saved. Pillow's refusal of SVG was executed during planning (below).

**The AVIF gate.** Planning opened an AVIF in Pillow only on the author's Mac (below); the native
`media` family's `media-web-apps-on` scenario executes HQ storing one in the proof image (part 04
§8.3). Where HQ stores it, the split above lands as written. Where HQ's image refuses it, the whole
upload stopping as for the SVG, pull request 7 lands instead of `image-ico-avif`, at its position:

- `expressions-and-data/image-ico`: `image-ico-avif` without `"media-format:image/avif"` in
  `surfaceKeys`, with `item` "image ICO", `valueClass` `"ico"` and `dispositionCell` "**HELD**: an
  image asset for an app that does not declare Android (every browser in the bar plays it; Android
  6.0 does not decode it)"; readings, emission and gates as `image-ico-avif`'s.
- `expressions-and-data/image-avif`, after it: `image-svg`'s shape with `item` "image AVIF",
  `surfaceKeys` `image-svg`'s with `"media-format:image/avif"` in place of
  `"media-format:image/svg"`, `valueClass` `"avif"`, and the one reason `broken-at-runtime` whose
  `named` is "`hqmedia/models.py::CommCareImage.attach_data` opens every image with Pillow
  (`get_image_object`), and the Pillow build HQ installs reads no AVIF (the native `media`
  family's `media-web-apps-on` run), and the error escapes `hqmedia/tasks.py::process_bulk_upload_zip`'s
  loop, so the whole upload stops and no file of that publish is mapped"; `dispositionCell`
  "**REFUSED**: broken at runtime: HQ types it as an image and cannot store it: " followed by the
  same text from "`hqmedia/models.py`" on.
- Rows: `image ICO, SVG, AVIF` becomes three, `| image ICO | <its dispositionCell> | RUNS /
  UNAVAILABLE | same |`, `| image AVIF | <its dispositionCell> | — | — |` and the SVG row above.
- `media-formats.json`: `items["media-format:image/avif"].hq` gains `"note": "HQ types it as an
  image and cannot store it: the Pillow build HQ installs reads no AVIF
  (commcare-hq/corehq/apps/hqmedia/models.py::CommCareImage.attach_data), and the error stops the
  whole bulk upload (commcare-hq/corehq/apps/hqmedia/tasks.py::process_bulk_upload_zip)."`. Its
  readings and §7.2's `webApps.executed` mark stay: the item records what a browser plays.
- The lane reader of §7.3 gains its sibling `avif_image`, the same body with `"image/avif"` (the
  MIME `media-formats.json`'s item records for libmagic 5.44), registered after `svg_image` as
  `"expressions-and-data/image-avif": avif_image,`, with the constant
  `AVIF = b"\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1miaf"` (an `ftyp` box of brand `avif`)
  and the shapes `_media_shapes("CommCareImage", "media-class:CommCareImage", ("o.avif", AVIF),
  ("p.png", _png()))` under its id. Reason: the REFUSED class has a value class, so without a
  reader every `media-class:CommCareImage` use would be undecided, as §7.3 says for SVG.

**The Android-only variants**, each → HELD with `slotChanges` `[]`, the cell's parenthesis
unchanged:

| Entry | `dispositionCell` change |
|---|---|
| `audio-raw-aac-adts-aac-amr-midi` | "**HELD-NEW**: an audio asset for an app that does not declare Web Apps (…)" → "**HELD**: an audio asset for an app that does not declare Web Apps (…)" |
| `video-hevc-mp4-mpeg-4-part-2-mp4-and-mkv-holding-a-codec-android` | "**HELD-NEW**: a video asset for an app that does not declare Web Apps (…)" → "**HELD**: a video asset for an app that does not declare Web Apps (…)" |

"(…)" stands for the parenthesis each cell holds today, kept byte for byte. Rows: Disposition cells,
the same change.

**H.264 High merges into the Baseline-or-Main entry, by the decode run.** Android's decode probe
ran during planning, on the person's Mac at their request, and each of the three images
`android-decode` names decoded `lib/media/__tests__/fixtures/tiny-video.mp4`, the corpus's H.264
High video, to its end (part 04 §8.5). So in pull request 7:

- `media-formats.json`: `items["media-format:video/mp4-h264-high"].android` becomes
  `{"reading": "runs", "executed": "android-decode", "note": "Decoded by the emulator images'
  software decoders; Android 6.0 guarantees only Baseline and Main."}`. The `android-decode`
  record's readers are unchanged (the run's fingerprints are the ones it names), and its `files`
  becomes "lib/media/__tests__/fixtures/ and the files lib/media/__tests__/bmpFixtures.ts and
  lib/media/__tests__/builtFixtures.ts build", since pull request 7's probe lists add the built
  files for later runs.
- The inventory: `video-mp4-h-264-high` and its row `video MP4 H.264 High` are removed;
  `video-mp4-h-264-baseline-or-main-with-aac-lc-or-no-audio-webm` keeps its id, gains
  `"media-format:video/mp4-h264-high"` in `surfaceKeys` after `"media-format:video/mp4-h264-main"`,
  and its `item` becomes "video MP4 H.264 Baseline, Main or High, with AAC-LC or no audio; WebM VP8
  or VP9, with Vorbis, Opus or no audio", its row's HQ item cell the same.

Reason: rule 7 of part 01 §8.2 holds a HELD media entry to one reading pair for all its formats,
and High now reads as Baseline and Main do. The other variants' Android readings stay the
documentation's: the planning run used the probe as it stands at `main`, and part 04 §8.5's
extended `ACCEPTED` serves a later run.

### 7.2 `media-formats.json`

- `items["media-format:image/svg"].hq` gains `"note": "HQ types it as an image and cannot store it:
  Pillow reads no SVG (commcare-hq/corehq/apps/hqmedia/models.py::CommCareImage.attach_data), and the
  error stops the whole bulk upload (commcare-hq/corehq/apps/hqmedia/tasks.py::process_bulk_upload_zip)."`
  Precedent: `audio/3gp`'s and `audio/m4a-other-brand`'s `hq.note`.
- `hqClassification` gains `"storage": "An image must also open in Pillow: CommCareImage.attach_data
  opens every image (get_image_object) and refuses one it cannot read, and
  process_bulk_upload_zip does not catch that per file, so the whole upload stops. HQ stores audio and
  video without decoding them (CommCareAudio and CommCareVideo do not override attach_data)."`
- `format` "AAC-LC" → "AAC" in `items["media-format:audio/m4a"]`,
  `items["media-format:video/mp4-h264-baseline"]` and `items["media-format:video/mp4-h264-main"]`.
  Reason: Nova reads no AAC object type, for ADTS as for M4A (part 04 §3.1), so an item that named
  AAC-LC would claim a check no reader makes.
- `executions` gains the record of part 04 §8.4's browser playback spec:

  ```json
  "browser-playback-ci": {
    "platform": "webApps",
    "method": "Each file served over HTTP with range requests and its MIME type; audio and video played muted to the ended event; each image decoded into an img with a width above 0 (e2e/tests/browser/media-play.spec.ts), in CI's browser and browser-webkit projects.",
    "files": "lib/media/__tests__/fixtures/ and the BMP files lib/media/__tests__/bmpFixtures.ts builds",
    "readers": [
      {"name": "Chromium headless shell", "os": "Linux amd64", "version": "<the version Playwright's browsers.json pins>"},
      {"name": "WebKit", "os": "Linux amd64", "version": "<the version Playwright's browsers.json pins>"}
    ]
  }
  ```

  with each `version` read from the installed Playwright's `browsers.json` when pull request 7 is
  written.
- `webApps.executed: "browser-playback-ci"` on the items `image/png`, `image/jpeg`, `image/gif`,
  `image/webp`, `image/ico`, `image/avif`, `audio/mp3`, `audio/wav-pcm-8-or-16-bit`,
  `video/mp4-h264-baseline`, `video/mp4-h264-main` and `video/mp4-h264-high`: the readings step 2
  left as documentation and the two Web-Apps-only image items.

No reading changes when every file plays in both engines, as expected. A file an engine does not
play fails part 04's spec in pull request 7's CI; that item's `webApps.reading` then becomes
`unavailable` with a note naming the engine and the run, it carries no `executed` mark, and the
inventory entry reading it is edited to match in the same pull request (part 04 §8.4, its second
outcome; rule 7 of part 01 §8.2 holds the two together). The variant registry's equality with the
items (the `manifest.test.ts` test "names, for each registry format, items of its kind that HQ files
as that kind and both platforms run") moves with the registry, part 04 §7.3.

### 7.3 The SVG reader

`proof/checks/manifest_value_classes.py`, beside `tiff_heif`:

```python
def svg_image(use, manifest):
    """``expressions-and-data/image-svg``: an image HQ classifies as SVG, which it cannot store."""
    facts = _media(use)
    if facts is None:
        return None
    return facts["mime"] == "image/svg+xml"
```

Registered in `VALUE_CLASSES` after `"expressions-and-data/image-tiff-heif": tiff_heif,` as
`"expressions-and-data/image-svg": svg_image,`. It is required: without it the new REFUSED class has a
value class and no reader, so every `media-class:CommCareImage` use is undecided
(`manifest_usage.py::_verdict` returns None) and the PNG, BMP and ICO entries hold nothing.
`_media` reads `facts["mime"]` from `proof/observe/manifest.py::media_facts`, HQ's own
`CommCareMultimedia.get_mime_type` over the bytes, which `media-formats.json`'s `hqClassification`
records as `image/svg+xml` for SVG (libmagic 5.44, executed in the proof image in step 2).

Test, `proof/checks/test_manifest_value_classes.py`: a constant beside `TIFF`,

```python
SVG = b'<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n'
```

and in the media group of `SHAPES`, after `"expressions-and-data/image-tiff-heif"`:

```python
"expressions-and-data/image-svg": _media_shapes(
    "CommCareImage", "media-class:CommCareImage", ("m.svg", SVG), ("n.png", _png())
),
```

`test_every_reader_has_a_refused_shape_and_an_accepted_one_beside_it` requires the pair, and
`test_a_reader_places_each_shape_read_with_the_observations_readings` reads them through HQ's
classification in the proof image. Nova refuses SVG at upload today and from step 4
(`lib/media/validate.ts`), so no corpus document uses one; the lane's verdict on the corpus does not
move.

## 8. Pull request 10: the expression reads

This section is the one text of pull request 10's manifest, inventory and `manifest.test.ts` edits;
part 03 §8 cites it. The reads themselves, their types and the slots that admit them are part 03's
(part 03 §4 to §6).

### 8.1 Session context and the case list's search text (`entries/expressions-and-data.json`, section Secondary instances)

| Entry | Change |
|---|---|
| `session-context-drift` | → HELD, `slotChanges` `[]`. `dispositionCell` "**HELD-NEW**: typed session reference" → "**HELD**: `session-context`, field `drift`, typed as an integer". `platforms.webApps.note` "always 0" → "always `0`: Formplayer keeps Core's `getCurrentDrift`". `platforms.android` `{"reading": "runs"}` → `{"reading": "runs", "note": "signed whole hours the device's clock is ahead of the server's, from the last response, `DriftHelper.getCurrentDrift`"}`. `platforms.cell` "DIFFERENT (always 0) / RUNS" → "DIFFERENT (always `0`: Formplayer keeps Core's `getCurrentDrift`) / RUNS (signed whole hours the device's clock is ahead of the server's, from the last response, `DriftHelper.getCurrentDrift`)". |
| `session-context-applanguage` | → HELD, `slotChanges` `[]`. `dispositionCell` → "**HELD**: `session-context`, field `applanguage`, text whose values are the app's language wire codes". `platforms.webApps.note` "unreliable after first render" → "the worker's language in menus, case lists and when a form opens; on later form requests, whatever language Formplayer's request thread last held". `platforms.cell` "DIFFERENT (unreliable after first render) / RUNS" → "DIFFERENT (the worker's language in menus, case lists and when a form opens; on later form requests, whatever language Formplayer's request thread last held) / RUNS". |
| `session-context-window-width` | §8.4. |
| `session-data-stringquery` | → HELD. `dispositionCell` → "**HELD**: the `case-list-search-text` arm, printed under the count guard; narrow: to an entry with exactly one case list (`SESSION_DATUM_NOT_SUPPLIED`)". `slotChanges` `[{"direction": "narrow", "text": "to an entry with exactly one case list (`SESSION_DATUM_NOT_SUPPLIED`)"}]`. `platforms.webApps.note` "node absent" → "node absent, so the guarded read is always blank: only Android sets the last query, `CommCareActivity.saveLastQueryString`". `platforms.android` `{"reading": "runs"}` → `{"reading": "runs", "note": "the text typed into the case list's search box, blank when none"}`. `platforms.cell` "UNAVAILABLE (node absent) / RUNS" → "UNAVAILABLE (node absent, so the guarded read is always blank: only Android sets the last query, `CommCareActivity.saveLastQueryString`) / RUNS (the text typed into the case list's search box, blank when none)". `emission.cell` "path" → "path, under the count guard". |

`session-data-fingerprintquery` stays HELD-NEW: its only supplier is a case-list callout, which step 7
group 4 holds.

Rows (`expressions-and-data.md`): `session \`context/drift\``, `session \`context/applanguage\`` and
`session \`data/stringquery\``: Disposition and Web Apps / Android cells to the new values;
`session \`data/stringquery\``'s Emission cell "path" → "path, under the count guard".

Citations (read for this part): commcare-core
`org/commcare/core/process/CommCareInstanceInitializer.java::getCurrentDrift` returns `0`, and
formplayer `session/FormplayerInstanceInitializer.java` does not override it; commcare-android
`utils/AndroidInstanceInitializer.java::getCurrentDrift` returns
`activities/DriftHelper.java::getCurrentDrift`, which commcare-core
`org/commcare/core/network/CommCareNetworkServiceGenerator.java`'s `driftInterceptor` sets to
`(now - serverTimeInMillis) / HOUR_IN_MS`; `org/commcare/session/SessionInstanceBuilder.java::addMetadata`
writes all seven context fields and `addData` adds none whose value is null; the language is
`CommCareInstanceInitializer.java::getLocale`, `Localization.getCurrentLocale()`, which formplayer
sets per navigation request (`MenuSession`, `util/SessionUtils.java::setLocale`) and on a form's
language switch (`session/FormSession.java::changeLocale`), on a localizer that is per request thread
(`Application.java`, `LocalizerManager.setUseThreadLocalStrategy(true)`); commcare-android
`activities/CommCareActivity.java::saveLastQueryString`, the one setter of the last query, which no
formplayer source names.

`applanguage`'s value on a later form request on Web Apps is read, not run: the request thread's
leftover locale. No step 4 decision waits on it (the reading is `different` either way, and part 01
§4.2's `app-language` note, which the builder and the guide show (part 07, pull requests 11 and 12),
says only that it is the worker's language when a form opens and may differ on later answers in a
form), so no gate is planned for it.

The arm is part 03 §5.2's value arm `{ kind: "case-list-search-text" }`, printed
`if(count(P) > 0, P[1], '')` (part 03 §5.3), so the cell says "arm" and the emission "under the
count guard".

### 8.2 Search inputs (`entries/expressions-and-data.json`)

**`search-input-read-in-form-expressions-of-an-inline-search-module`** → HELD:

- `dispositionCell`: "**HELD-NEW**: typed search-input reference" → "**HELD**: `input` reads of the
  module's Search fields from `search-input:results:inline`; narrow: to the forms of a search-first
  module and its no-matches form; a form link's slots and a child module of a search-first parent
  stay refused (`INVALID_SEARCH_REF`)".
- `slotChanges`: `[{"direction": "narrow", "text": "to the forms of a search-first module and its
  no-matches form; a form link's slots and a child module of a search-first parent stay refused
  (`INVALID_SEARCH_REF`)"}]`.
- Readings unchanged (RUNS / UNAVAILABLE).
- Row `` `search-input:*` read in form expressions of an inline-search module ``: Disposition cell.

The narrow states part 03 §4.2's two refusal reasons: `form-link` (a form link runs after the form
closes, where the menu's Search answers are no longer available) and `not-search-first`, which
covers a form of a child module of a search-first parent.

**`search-input-results-read-in-the-search-results-detail`** is split:

- The entry keeps its id, `disposition` HELD-NEW, `valueClass` `results-detail`, keys and readings.
  `item` "`search-input:results[:…]` read in the search results detail" → "`search-input:results[:…]`
  read in the search results detail of a search that is not inline". `dispositionCell` "**HELD-NEW**: a
  typed search-input reference (typed expression model)" → "**HELD-NEW**: a typed search-input
  reference (typed expression model); step 7: Nova projects one case list onto both the module's list
  and its search results detail (`compiler.ts`)". Row: HQ item and Disposition cells.
- New entry, inserted after it:

```json
{
  "id": "expressions-and-data/search-input-results-read-in-the-case-list-of-an-inline-search",
  "area": "expressions-and-data",
  "section": "Secondary instances",
  "item": "`search-input:results:inline` read in the case list or case detail of an inline-search module",
  "surfaceKeys": ["instance-scheme:search-input"],
  "valueClass": "inline-search-list",
  "disposition": "HELD",
  "dispositionCell": "**HELD**: `input` reads of the module's Search fields in the `case_list_column_expression` profile; narrow: to a search-first module's case list and case detail",
  "slotChanges": [
    { "direction": "narrow", "text": "to a search-first module's case list and case detail" }
  ],
  "platforms": {
    "kind": "each",
    "cell": "RUNS / UNAVAILABLE (Formplayer keeps the inputs, `QueryScreen.updateSession`; Android sets only the results on the query step, `QueryRequestActivity`, so a read throws)",
    "webApps": { "reading": "runs" },
    "android": {
      "reading": "unavailable",
      "note": "Formplayer keeps the inputs, `QueryScreen.updateSession`; Android sets only the results on the query step, `QueryRequestActivity`, so a read throws"
    }
  },
  "emission": { "cell": "path", "markers": [] },
  "gates": []
}
```

Row added after the narrowed row:
`| \`search-input:results:inline\` read in the case list or case detail of an inline-search module | <the dispositionCell above> | RUNS / UNAVAILABLE (Formplayer keeps the inputs, \`QueryScreen.updateSession\`; Android sets only the results on the query step, \`QueryRequestActivity\`, so a read throws) | path |`.

Citations: commcare-core `src/cli/java/org/commcare/util/screen/QueryScreen.java::updateSession`
(Formplayer builds the user-input instance beside the results); commcare-android
`activities/QueryRequestActivity.java` (`setQueryDatum` with the results only);
`org/commcare/core/process/CommCareInstanceInitializer.java::generateRoot` (a `search-input` instance
resolves only from a query step's sources). In a search-first module the list is reached only through
the inline query, so the instance resolves for the list and the detail; an ordinary search's results
detail stays HELD-NEW because Nova writes one case list for both the module's list and the search
results detail (`lib/commcare/compiler.ts`, "only one case list"), where a read of the inputs would
throw in the local list.

### 8.3 Context terms in search values (`entries/case-search.json`)

`case-search/runtime-values-read-from-the-session-context-drift-window-width` is removed and replaced,
at its position, by three entries. Each copies the old entry's `area` (`case-search`), `section`
("Case search"), `subsection` ("CSQL in `_xpath_query` values and ancestor-path criteria"),
`surfaceKeys` (`["schema:DefaultCaseSearchProperty.defaultValue"]`), `emission`
(`{"cell": "printed", "markers": ["printed"]}`) and `gates` (`[]`), with `disposition` HELD and
`slotChanges` `[]`:

| `id` | `item` | `valueClass` | `dispositionCell` | `platforms` |
|---|---|---|---|---|
| `case-search/runtime-values-read-from-the-session-context-drift` | runtime values read from the session context `drift` | `session-context-drift-term` | **HELD**: the `session-context` term `drift` in a search value | `cell` "DIFFERENT (always `0`) / RUNS", `webApps` `{"reading": "different", "note": "always `0`"}`, `android` `{"reading": "runs"}` |
| `case-search/runtime-values-read-from-the-session-context-window-width` | runtime values read from the session context `window_width` | `session-context-window-width-term` | **HELD**: the `session-context` term `window_width` in a search value | `cell` "RUNS (sent with the menu request that builds the search) / UNAVAILABLE (never set, so a read fails)", `webApps` `{"reading": "runs", "note": "sent with the menu request that builds the search"}`, `android` `{"reading": "unavailable", "note": "never set, so a read fails"}` |
| `case-search/runtime-values-read-from-the-session-context-applanguage` | runtime values read from the session context `applanguage` | `session-context-applanguage-term` | **HELD**: the `session-context` term `applanguage` in a search value | `cell` "RUNS / RUNS", `webApps` `{"reading": "runs"}`, `android` `{"reading": "runs"}` |

`applanguage` runs on Web Apps here because a search is built on a navigation request, which sets the
locale on its thread (formplayer `MenuSession`, `util/SessionUtils.java::setLocale`). Reason for the
split: the old entry's one Android reading ("runs", with "`window_width` UNAVAILABLE" in a note)
cannot carry three readings, and part 01's table reads one pair per entry (part 01 §8.2, rule 3).

Gates: in `toggle/SYNC_SEARCH_CASE_CLAIM`, `project-space-setting/CaseSearchConfig.enabled` and
`project-space-setting/CaseSearchConfig.sync_cases_on_form_entry`, `contentEntries` replace
`"case-search/runtime-values-read-from-the-session-context-drift-window-width"` at its position with
the three ids in the table's order (each list holds it once today; read for this part).

Row `runtime values read from the session context \`drift\`, \`window_width\` or \`applanguage\`` in
`case-search.md` becomes three rows, each `| <item> | <dispositionCell> | <platforms cell> | printed |`.

### 8.4 The window width (gated)

**The gate.** Whether a bare read of `session/context/window_width` in form logic stops the form
when a later form request carries no width is settled by one native Core run. Its design and its two
outcomes are part 03 §6.4's; its file is part 08's (§5.2):
`proof/native/core/SessionContextRuntimeTest.java`, registered in
`proof/native/families.py::CORE_CLASSES` as `"SessionContextRuntimeTest": "expression"`, over the
`expression` family's evidence that `proof/native/producers/emit-expression-evidence.ts` writes. The
form is initialized with the width `"1024"`, as formplayer's `MenuSession` builds the opening
`FormSession`, then again with no width, as formplayer's `application/FormController.java` rebuilds
the session on each later answer (HQ's `form_entry/web_form_session.js` never sends `windowWidth`),
in two arms, each a method of its own:

- `windowWidthReadOnACachedForm`, arm (a): the same `FormDef` initialized again, Formplayer's cache
  hit (`services/FormDefinitionService.java::getFormDefWithCache`);
- `windowWidthReadOnAFreshForm`, arm (b): the XForm re-parsed into a fresh `FormDef`, standing for
  the one Formplayer deserializes from the session's stored definition after a miss of
  `getFormDefWithCache`
  (`FormDefinitionService.java::getFormDefFromSession`, `FormDefStringSerializer.deserialize`). A
  fresh `FormDef` behaves as that deserialized one for this check because `XPathPathExpr` does not
  serialize `templatePathChecked` (commcare-core `XPathPathExpr.java::readExternal` and
  `writeExternal` carry no such field), so either way each expression checks its path again.

How the run shows its outcome, and what each method asserts after it, are part 03 §6.4's. The run
is a hand-started dispatch of the `expression` family on pull request 10's branch (part 08 §6.3),
never on a laptop, and it runs before this section's manifest text is written; from then on the
class pins the reading this section relies on in every pull-request lane.

**Outcome A** is that arm (b) throws, whatever arm (a) shows; **outcome B** is that arm (b) reads
`''`. Expected: outcome A.
commcare-core `org/javarosa/xpath/expr/XPathPathExpr.java::evalRaw` makes an absolute reference with
no template path an invalid nodeset, which `XPathNodeset.java::unpack` refuses
(`lib/commcare/CLAUDE.md` records a native run where a missing session leaf throws in a scalar
calculation). The check runs once per expression object (`templatePathChecked`), so arm (a) reuses an
expression already checked while the width was present and may read `''`; arm (b), a fresh
`FormDef`, is the case that decides, since Formplayer serves a form request from a `FormDef` it
deserializes afresh whenever its cache misses, whose expressions have not checked their paths.

**Outcome A, arm (b) throws.** `session-context-window-width` → HELD and gains a value class:

- `item`: "session `context/window_width`" → "session `context/window_width` read outside form logic
  (menus, case lists, case details, display conditions, search values)".
- `valueClass`: `"outside-form-logic"` (new field on this entry).
- `dispositionCell`: "**HELD-NEW**: typed session reference" → "**HELD**: `session-context`, field
  `window_width`, typed as an integer; narrow: outside form logic, where the next row refuses it".
- `slotChanges`: `[{"direction": "narrow", "text": "outside form logic, where the next row refuses it"}]`.
- `platforms`: `{"kind": "each", "cell": "RUNS (the browser window's width, sent with every menu
  request) / UNAVAILABLE (never set, so a read fails)", "webApps": {"reading": "runs", "note": "the
  browser window's width, sent with every menu request"}, "android": {"reading": "unavailable",
  "note": "never set, so a read fails"}}`.

New REFUSED entry, inserted after it:

```json
{
  "id": "expressions-and-data/session-context-window-width-in-form-logic",
  "area": "expressions-and-data",
  "section": "Secondary instances",
  "item": "session `context/window_width` read in form logic",
  "surfaceKeys": ["session-path:session/context/window_width"],
  "valueClass": "in-form-logic",
  "disposition": "REFUSED",
  "dispositionCell": "**REFUSED**: broken at runtime: Android never sets it, and Web Apps sets it only on the request that opens the form, while Formplayer runs every calculate again on each later request, so the read stops the form whenever Formplayer deserializes the form afresh from the session's stored definition rather than reusing its cached copy",
  "reasons": [
    {
      "kind": "broken-at-runtime",
      "named": "Android never sets it (`AndroidSessionWrapper` builds its `SessionWrapper` with no width, and `SessionInstanceBuilder.addData` adds no node for a null value); Web Apps sends `windowWidth` only from `formplayer/menus/api.js`, never from `form_entry/web_form_session.js`, and each form request rebuilds the session from that request (`FormController`, `FormSession`) and runs every calculate again, so a read of the absent node throws on a `FormDef` Formplayer deserializes afresh from the session's stored definition after a miss of `FormDefinitionService.getFormDefWithCache`, whose expressions check their path again since `XPathPathExpr` does not serialize `templatePathChecked` (`XPathPathExpr.evalRaw`, `XPathNodeset.unpack`), and reads blank only on a cached form whose expression checked its path while the width was present (the native run `SessionContextRuntimeTest`, `windowWidthReadOnAFreshForm` and `windowWidthReadOnACachedForm`)"
    }
  ],
  "platforms": { "kind": "none", "cell": "—" },
  "emission": { "cell": "—", "markers": [] },
  "gates": []
}
```

Rows: `session \`context/window_width\`` becomes `| session \`context/window_width\` read outside form
logic (menus, case lists, case details, display conditions, search values) | <the HELD dispositionCell>
| RUNS (the browser window's width, sent with every menu request) / UNAVAILABLE (never set, so a read
fails) | path |`, and a row is added after it: `| session \`context/window_width\` read in form logic |
<the REFUSED dispositionCell> | — | — |`.

The reader, `proof/checks/manifest_value_classes.py`, beside `here_in_form`:

```python
def window_width_in_form_logic(use, manifest):
    """``expressions-and-data/session-context-window-width-in-form-logic``: a read of the session's
    ``context/window_width`` in an XForm's expression. HQ's Web Apps client sends the width only with a
    menu request (``formplayer/menus/api.js``), never with a form request
    (``form_entry/web_form_session.js``), and Formplayer runs every calculate again on each form
    request, which throws on a ``FormDef`` it deserializes afresh from the session's stored
    definition after a miss of ``FormDefinitionService.getFormDefWithCache``, since ``XPathPathExpr``
    does not serialize ``templatePathChecked``; Android never sets it. A suite's and an app JSON's expressions (case lists, details,
    display conditions, search values) are evaluated on a menu request, outside the class."""
    document, _ = _expression_at(use)
    if document is None:
        return None
    return document.kind == "xform"
```

Registered in `VALUE_CLASSES` after `"expressions-and-data/here-in-a-form": here_in_form,` as
`"expressions-and-data/session-context-window-width-in-form-logic": window_width_in_form_logic,`. A
`session-path:` use carries the `XmlAt` (or `JsonAt`) of the expression it was read from
(`manifest_usage.py::_expression_uses`), which `_expression_at` reads, as `here_in_form` does.

Its shapes, `proof/checks/test_manifest_value_classes.py`, in the expressions group beside
`"expressions-and-data/here-in-a-form"`:

```python
window_width = form(
    data="<w/>",
    model="""<bind nodeset="/data/w" calculate="instance('commcaresession')/session/context/window_width"/>""",
)
window_width_suite = b"""<suite version="1"><detail id="d"><title><text><locale id="t"/></text></title><field>
  <header><text><locale id="h"/></text></header><template><text>
  <xpath function="instance('commcaresession')/session/context/window_width"/></text></template></field></detail>
  <entry><form>http://example.org/f</form><command id="m0-f0"><text><locale id="c"/></text></command>
  <instance id="commcaresession" src="jr://instance/session"/></entry></suite>"""
```

and

```python
"expressions-and-data/session-context-window-width-in-form-logic": (
    refused("form", window_width, "session-path:session/context/window_width", "bind[1]/@calculate", readings=True),
    accepted("suite", window_width_suite, "session-path:session/context/window_width", "xpath[1]/@function", readings=True),
),
```

The `FORM` template already declares `commcaresession`; the suite declares it on its entry, which
`manifest_usage.py::_instance_uses` collects for the whole document, so Core's parse of the detail's
expression yields the session path.

**Outcome B, arm (b) reads `''`.** No REFUSED entry, no reader, no shapes. `session-context-window-width`
→ HELD with no value class and no narrow: `dispositionCell` "**HELD**: `session-context`, field
`window_width`, typed as an integer", `slotChanges` `[]`, `platforms` `{"kind": "each", "cell":
"DIFFERENT (the width when the menu or form opened; blank on later answers in a form) / DIFFERENT
(never set, so it reads blank)", "webApps": {"reading": "different", "note": "the width when the menu
or form opened; blank on later answers in a form"}, "android": {"reading": "different", "note": "never
set, so it reads blank"}}`; its row's Disposition and Web Apps / Android cells to match. The search
value entry `case-search/runtime-values-read-from-the-session-context-window-width` takes `android`
`{"reading": "different", "note": "never set, so it reads blank"}` and `cell` "RUNS (sent with the
menu request that builds the search) / DIFFERENT (never set, so it reads blank)". Part 01's
`window-width` feature then reads `different` / `different` and names only
`expressions-and-data/session-context-window-width`; the search value entry, whose pair is now
runs / different, moves to part 01's own feature `window-width-in-search`, since rule 3 of part 01
§8.2 holds every entry of a feature to the feature's pair (§5.3). Part 03 admits the read in form
logic with that stated difference (part 03 §6.4 holds both branches for the checker).

**Form links.** A form link's condition and datums are evaluated after a form is submitted, on a
request HQ's client sends from the form (`form_entry/web_form_session.js`, which sends no
`windowWidth`). The HELD class's item lists menus, case lists, case details, display conditions and
search values, and a form link is none of them: part 03 §6.2 keeps `window_width` out of a form
link's slots (`SlotProfile.windowWidth`), and this part adds no class for it.

### 8.5 `lib/commcare/surface/__tests__/manifest.test.ts`

- `HELD_INSTANCE_READS` gains, after its last element:
  `"expressions-and-data/session-data-stringquery"`, `"expressions-and-data/session-context-drift"`,
  `"expressions-and-data/session-context-window-width"`, `"expressions-and-data/session-context-applanguage"`,
  `"expressions-and-data/search-input-read-in-form-expressions-of-an-inline-search-module"`,
  `"expressions-and-data/search-input-results-read-in-the-case-list-of-an-inline-search"`.
- `WAITING_INSTANCE_READS` loses `"expressions-and-data/search-input-read-in-form-expressions-of-an-inline-search-module": "HELD-NEW"`
  and gains `"expressions-and-data/session-data-fingerprintquery": "HELD-NEW"`,
  `"expressions-and-data/search-input-results-read-in-the-search-results-detail": "HELD-NEW"` and, in
  outcome A only, `"expressions-and-data/session-context-window-width-in-form-logic": "REFUSED"`.
- The comment above them, "The reads that wait for a later step stay HELD-NEW, and the hierarchical
  fixture stays refused." becomes "The reads that wait for a later step stay HELD-NEW, and the reads
  no runtime evaluates where they sit stay refused."

The `it.each` over `HELD_INSTANCE_READS` holds each entry HELD and its cell naming its narrow; the
one over `WAITING_INSTANCE_READS` holds each other disposition. These are the regressions a later edit
could make silently, since the lane does not read allowing classes.

### 8.6 The lane's verification in pull request 10

Three targeted documents carry pull request 10's reads (part 08 §4.4, §4.5, §4.7; part 03 §9):

- `targeted-session-context-reads`, declared Web Apps only, reads `window_width` in a module display
  condition, a case list column and a Search field's starting value; `drift` and `applanguage` in
  case list columns and in a form's hidden values; and `appversion` and `deviceid` in hidden values.
- `targeted-case-list-search-text`, declared Android only, reads the case list's search text (the
  arm) in a follow-up form's hidden value and in a question's `relevant`.
- `targeted-inline-search-reads` reads a Search field of a search-first module in a form's hidden
  value and in its case list's calculated column.

Their `manifest` check shows no difference: every key they use is held, none is held-new, and in
outcome A the window width reads sit outside form logic, so outside `in-form-logic`. The hand-started
reader run of part 08 §6.3 at pull request 10's head names all three.

## 9. Files by pull request

| # | Files this part touches |
|---|---|
| 1 | `proof/checks/manifest_usage.py`, `proof/checks/registers.py`, `proof/checks/test_manifest.py`, `proof/checks/test_registers.py`, `proof/README.md`; `lib/commcare/surface/entries/application-and-settings.json`, `menus-and-case-lists.json`, `case-search.json`, `forms-and-case-writes.json`, `questions.json`, `expressions-and-data.json`; `docs/research/2026-09-26-hq-round-trip/inventory/application-and-settings.md`, `menus-and-case-lists.md`, `case-search.md`, `forms-and-case-writes.md`, `expressions-and-data.md`; `lib/commcare/CLAUDE.md` |
| 3 | `lib/commcare/surface/entries/questions.json` |
| 4 | `lib/commcare/surface/entries/application-and-settings.json`, `case-search.json`, `entries/gates.json`; `docs/research/2026-09-26-hq-round-trip/inventory/application-and-settings.md`, `case-search.md`, `gates.md` |
| 5 | `lib/commcare/surface/entries/application-and-settings.json`; `docs/research/2026-09-26-hq-round-trip/inventory/application-and-settings.md` |
| 6 | `lib/commcare/surface/entries/gates.json`; `docs/research/2026-09-26-hq-round-trip/inventory/gates.md` |
| 7 | `lib/commcare/surface/entries/expressions-and-data.json`, `media-formats.json`; `proof/checks/manifest_value_classes.py`, `proof/checks/test_manifest_value_classes.py`; `docs/research/2026-09-26-hq-round-trip/inventory/expressions-and-data.md` |
| 10 | `lib/commcare/surface/entries/expressions-and-data.json`, `case-search.json`, `gates.json`; `lib/commcare/surface/__tests__/manifest.test.ts`; in outcome A `proof/checks/manifest_value_classes.py`, `proof/checks/test_manifest_value_classes.py`; `docs/research/2026-09-26-hq-round-trip/inventory/expressions-and-data.md`, `case-search.md` |

Every manifest file is a judge file of the lane, so each of these pull requests runs the lane's
pull-request job in full; none adds a reader run. The window width gate's native files
(`proof/native/core/SessionContextRuntimeTest.java`, its evidence in
`proof/native/producers/emit-expression-evidence.ts`, `proof/native/families.py`) and its
hand-started run are part 08's (§5.2, §6.3); this part's pull request 10 edits wait on that run's
outcome.

## 10. What this part does not do

- **A declared-platform cross-check in the lane.** A check that refuses a HELD use whose entry reads
  `unavailable` on a platform the captured document declares would reuse §2's plan with the document's
  `appSettings.runsOnlyOn`. Step 4 adds none: every corpus document passes the commit gate, whose
  validator refuses an unavailable feature on a declared platform (part 01 §5, §6), and the binding test
  holds the validator's table to these entries.
- **The research's Counts table** and its README stay as the research wrote them.
- **The surface** (`surface.json`) is not regenerated: no edit here needs a new surface item.

## Executed during planning

- **The lane's extraction over an emitted corpus.** The manifest check's own extraction
  (`proof/checks/manifest_usage.py::app_json_uses` over each captured publish's `app_file` as HQ
  imports it, `as_imported`, and `archive_uses` over each local archive, app strings left out) ran
  read-only on this machine over a corpus of 392 documents emitted at `main` `e9e6cd93`, without HQ's
  or Core's readings (no `read_observed`). It listed each key whose allowing entries are all
  HELD-NEW, with the documents using it: the 35 keys of §1 other than the drift read, named by 34
  HELD-NEW entries, with no read error. §3's edits resolve them (27 flips, the label entry's added
  key, the new INERT class); the other HELD-NEW entries naming those keys are those §3.8 lists.
- **The families the extraction cannot judge without readings** (`jr-fn:`, `session-path:`,
  `csql-*`, `xpath-*`, `mug:`): a reading of the manifest's entries found that the only keys of
  those families allowed by HELD-NEW entries alone are the five session paths
  `session/context/{drift,window_width,applanguage}` and `session/data/{stringquery,fingerprintquery}`
  and four question kinds (`mug:AndroidIntent`, `mug:ConnectWorkAreaUpdate`, `mug:FaceCapture`,
  `mug:PhoneNumber`). A scan of every file inside each document's local archives and HQ import file
  found `session/context/drift` in the local archives of 385 of the 392 documents, every one with a
  form, in the meta block `lib/commcare/xform/metaBlock.ts::addMetaBlock` writes on every form
  (§3.5 adds the key to the meta entry), and no read of the other four paths in any export; Nova
  writes none of the four kinds (the Connect deliver unit carries `work_area_id`,
  `lib/commcare/xform/builder.ts`, and no work-area-update block).
- **Pillow on SVG, ICO and AVIF.** Pillow 12.3.0, the version commcare-hq's `uv.lock` pins, on the
  author's Mac, opened an ICO and an AVIF file and refused an SVG file with `UnidentifiedImageError`,
  an `IOError`, which `CommCareImage.get_image_object` turns into `BadMediaFileException`.
- **Android's decode of H.264 High**, on the person's Mac on 2026-10-23 at their request
  (`proof/android/decode/run.sh` on the three images `android-decode` names): each decoded
  `tiny-video.mp4` to its end, so §7.1 merges the High entry (part 04 §8.5).
- **Not executed, planned as gates**, each with both outcomes written:
  - the native run of §8.4, a hand-started `expression` run on pull request 10's branch (part 03
    §6.4, part 08 §5.2);
  - HQ storing an AVIF through the Linux wheel the proof image installs, the native `media`
    family's `media-web-apps-on` scenario in pull request 7's lane (§7.1, part 04 §8.3).
