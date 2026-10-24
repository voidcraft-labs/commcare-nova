# Step 4, part 08: Proving step 4 on the lane

Part of [step 4's plan](../4-platforms.md), which holds the baseline, the decisions, the stack and
the exit. This part holds how the proof lane proves step 4: pull request 2, the lane mechanics (a
served reader reads an app only on the platforms the app declares, configuration sensitivity holding
a fixed entry on its control, the sync requirement in a publish verdict, Web Apps granted from what
the app body says); the register and walk-stop moves of finding 74, defect 20 and defect 21; what
every corpus source declares and why; the fuzz mapping; the edit kinds; the targeted documents step
4 adds; the native families' new scenarios; what each pull request costs in CI; the reader runs made
by hand before the merge and the first night after it; and the stale lane docs this step corrects.
The HELD-NEW manifest check is part 02's and lands in pull request 1; this part only relies on it.

Citations are `path::symbol` for Nova at `main` `e9e6cd93` and `file::symbol` for CommCare at the
pins `proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, formplayer `24383ac71bfb`, commcare-core
`8e9ba8d908e9` (paths under `src/main/java`), commcare-android `7a5584475580`, commcare-connect
`046c7fd78081`, Vellum `01215f251c57`. Stack references use the fifteen pull requests by number:

| # | Pull request | # | Pull request |
|---|---|---|---|
| 1 | Manifest audit | 9 | Preview, the screens |
| 2 | Lane mechanics | 10 | Expression reads |
| 3 | The split's groundwork | 11 | Builder |
| 4 | The declaration and the platform table | 12 | Agent |
| 5 | Publish, Web Apps | 13 | Cutover |
| 6 | Publish, defect 20 | 14 | Contracts and public docs |
| 7 | Media by platform | 15 | Removal of the cutover tooling and of this plan |
| 8 | Preview, the model | | |

The declaration this part reads is `appSettings.runsOnlyOn?: "web-apps" | "android"`, absent for
both (pull request 4). No production count enters this part.

## Decisions in brief

1. **A served reader reads an app only on a platform the app declares.** The Web Apps client (on a
   desktop, on a phone and in App Preview) replays a state only where its app declares Web Apps; a
   device reads a state, Nova's local archive and HQ's build alike, only where its app declares
   Android; proof 3 compares Nova's local archive with HQ's build only for an app that declares
   Android. Formplayer reads every app: its walk is how every state is served to the other readers
   and to Connect (`proof/lane/readers.py::BRINGS`), and it models the Web Apps client (the
   placeholder text it submits for a question it draws no widget for) only where the app declares
   Web Apps. Reason: Nova refuses what a declared platform cannot run, so a symptom a reader shows
   on a platform the app does not declare reaches no worker; this is step 1's decision 19 ("a check
   runs only against a target Nova's publish accepts") read for platforms, and it is written into
   `proof/CLAUDE.md` as a rule (§1.8).
2. **The declaration is read, never derived again.** A corpus document's from its `document.json`
   (`doc.appSettings.runsOnlyOn`, D's or D′'s), a control's from its `derived.json`, which a control
   retained from step 4 on carries as `platforms`; a control without it, every control retained
   before step 4, reads as both, as it was published (`proof/checks/corpus.py::Document.platforms`).
   Reason: a control's bytes are the pre-fix inputs its entries show on, published as an app every
   platform runs, so reading it as both keeps every retained control showing what it shows.
3. **Pull request 2 changes nothing any reader records about today's corpus.** Every document
   declares nothing until pull request 4, so every one reads as both. Its by-hand reader run (§6.3)
   checks exactly that.
4. **Configuration sensitivity holds a fixed entry on its control.** On a control, the entries a
   flip's difference is held to before the gate's effects are the known register's and the fixed
   entries of this check naming that control (`proof/checks/sensitivity.py::flip_entries`); on a
   document, the known register's alone. Reason: defect 20's three sensitivity entries are the first
   fixed `sensitivity` entries; without this, the gate's effects explain each difference on the
   control, and the fixed entry fails as one that no longer shows.
5. **A verdict states a sync requirement, and absent means none.** `verdict.json`'s
   `minimumConfiguration.syncCasesOnFormEntry` is `false` where Nova's publish requires the setting
   off, and absent otherwise; `sensitivity.accepts` and `corpus.lacking` read it so, and proof 5
   reads D′'s verdict through `corpus.lacking` (`proof5.py::_edit_lacks`). Reason: every
   retained control's verdict holds no such field, so every control keeps accepting the sync flip and
   keeps showing what it shows.
6. **Web Apps is granted from what the app body says.** `_needs_cloudcare` is true unless an app Nova
   sends carries `cloudcare_enabled: false`; absent is today's answer, true. Reason: from pull request
   5 every body carries the declaration, and a control's bodies carry none.
7. **The intent clause on `cloudcare_enabled` lands in pull request 5, with the wire** (the step's
   outline put it with the lane mechanics, pull request 2). HQ's stored app at A, B and B-edit holds
   `cloudcare_enabled` true exactly where D's (or D′'s) declaration includes Web Apps. Reason: pull
   request 4 declares 30 documents Android only before pull request 5 writes the value, so the clause
   in pull request 2 would fail pull request 4's own lane on every one of them.
8. **The corpus writes no local archive for a document that does not declare Android, from pull
   request 5.** `local.ccz`, `local-again.ccz` and `local-empty-list-text.ccz` exist only where D
   declares Android, and `edit/local.ccz` only where D′ does. Reason: pull request 5 makes Nova's own
   download refuse a `.ccz` for such an app (`lib/deployment/runtimeTarget.ts::chooseDownloadTarget`,
   which the corpus's `proof/corpus/publish.ts::localCcz` calls), and the capture moves with publish.
   The checks that read a local archive are ready for its absence from pull request 2 (§1.6).
9. **The census, with Connect: 324 documents run on both, 37 on Web Apps only, 30 on Android only
   (12 for a date-and-time question, 18 Connect apps) and 1 on neither** (§3.1). Four edits turn
   Connect on in a document that runs on both, so their D′ declares Android only. No known-defect
   entry is lost to decision 1 (§3.2).
10. **Finding 74's two walk stops leave their documents in pull request 4.**
    `targeted-datetime-ordering` declares Android only and its stop moves to its control;
    `fuzz-xform-20260930-0` is declared Android only by the fuzz mapping and its entry is removed (no
    control). `walk-stops.json` goes from 26 entries to 25.
11. **Defect 20's 15 entries move to `fixed-defects.json` in pull request 6**, `OPEN_DEFECTS` drops
    20, and `targeted-sync-on-form-entry` keeps both platforms with sync off. Defect 21's `requests`
    entry, which names that document, is re-homed onto a new targeted document,
    `targeted-sync-on-form-entry-web-apps`, declared Web Apps only with sync on (a project space
    Nova's publish accepts for such an app), whose proof 4 inputs are the original's; it stays live
    and its control is unchanged. Pull request 6's own lane decides it: where the new document does
    not show the class, the entry moves to `fixed-defects.json` on that control instead (§2.4).
12. **Defect 21 gains two `manifest` entries in pull request 5**, the REFUSED `list-first-with-web-apps`
    class a list-first searching module meets once its app body says `cloudcare_enabled: true`, on
    `targeted-list-first-web-apps` with a control retained after pull request 5,
    `targeted-list-first-web-apps-declared`. Step 5's exit removes them.
13. **The fuzz mapping runs at the end of each generator's `lowerToDoc`** through
    `lib/doc/platformDeclaration.ts::declaredForContent`, a thin wrapper over the one pure planner
    the cutover reuses, `planContentDeclaration` (part 09 §5, step 1), with no new random call
    (§3.4).
14. **No new edit kind and no third `setAppSettings` candidate.** `setConnectType` turning Connect on
    narrows the app to Android in the same batch, as pull request 11's store action commits it
    (`lib/session/store.ts::switchConnectMode`, part 07 §2.7) (§3.5).
15. **Step 4 adds six targeted documents** (§4): `targeted-datetime-split` (pull request 3),
    `targeted-platform-declaration` (pull request 4), `targeted-sync-on-form-entry-web-apps` (pull
    request 6), `targeted-preview-android-renders` (pull request 9, the document part 06 §24's
    Android observations read), `targeted-session-context-reads` and `targeted-case-list-search-text`
    (pull request 10). None needs a control: each witnesses a fix or an observation, and no register
    entry names it but the re-homed defect 21 entry, whose control exists. No Web-Apps-only document
    is added for coverage: the census already holds 37. Pull request 10 also extends
    `targeted-inline-search-reads` and `targeted-instance-reads` (§4.7).
16. **The native families gain three Core classes and three media scenarios** (four where HQ
    refuses the AVIF, part 04 §8.3): the split's instant
    in the four device zones (pull request 3); the session context and `case-list-search-text`
    reads with their nodes absent and present, with the `window_width` gate's two arms, and a form
    read inside a row predicate under each of Core's evaluations (pull request 10); and part 04
    §8.3's media scenarios per declaration (pull request 7) (§5).
17. **Every pull request from 2 up runs the 12.7-minute lane** (all groups observed afresh), because
    pull request 2 changes observation code and a stacked pull request reads only main's store; pull
    request 1 runs the 10.7-minute row. Pushes are batched once per review round (§6).
18. **Served readers run on GitHub's runners only, never on the person's machine**, by hand at the
    heads of pull requests 2, 3, 4, 5, 6, 7, 9 and 10 and once at the top of the stack before the
    merge (§6.3); the `window_width` gate's native run is started by hand on pull request 10's
    branch before that pull request's manifest text is written. The night after the merge is the
    whole lane with every reader (§6.4).

## 1. Pull request 2, the lane mechanics

Every change here reads a declaration that no document carries yet, so each one changes nothing a
reader records about today's corpus. Each is written so that it holds unchanged once pull request 4
declares 68 documents narrower than both.

### 1.1 The platform each reader runs an app on (`proof/lane/readers.py`)

Today `BRINGS` makes every reader bring Formplayer: "every served state is served along Formplayer's
walk, which the client replays, whose submissions Connect receives, and along which B and proof 4's
saves are served to a device". From pull request 2 the module also names the platform each reader
runs an app on:

```python
# The platform each served reader runs an app on (proof/CLAUDE.md, "A reader reads an app on the platforms
# it declares"): the Web Apps client runs it on Web Apps, in App Preview too, and a device on Android.
# Formplayer and Connect read every app: Formplayer's walk is how every state is served (BRINGS), and Connect
# takes what any worker submits.
PLATFORM_OF = {"webapps": "web-apps", "android": "android"}


def reads_app(reader: str, platforms: Iterable[str]) -> bool:
    """Whether ``reader`` reads an app that declares ``platforms`` (``PLATFORM_OF``)."""
    platform = PLATFORM_OF.get(reader)
    return platform is None or platform in frozenset(platforms)
```

The module stays on the standard library (the queue builder and the gate import it with no image).
Its docstring gains one paragraph after the `BRINGS` sentence: "A reader the run names still reads
a state only where the state's app declares the platform the reader runs it on (`PLATFORM_OF`):
Formplayer and Connect read every app, the client an app that declares Web Apps, a device an app
that declares Android."

### 1.2 Where the declaration is read (`proof/checks/corpus.py`, `proof/checks/controls.py`)

`corpus.py` gains the constants `WEB_APPS = "web-apps"`, `ANDROID = "android"`,
`PLATFORMS = (WEB_APPS, ANDROID)` and `BOTH = frozenset(PLATFORMS)`, adds `"platforms"` to
`OPTIONAL_DERIVED_KEYS` (beside `caseTypes`), and gives `Document` one method:

```python
def platforms(self, *, edit=False) -> frozenset[str]:
    """The platforms D (or D', ``edit``) declares: its ``appSettings.runsOnlyOn``, or both where it names
    none; on a control, what its ``derived.json`` retains, or both for a control retained before a document
    declared any, which was published as an app every platform runs."""
```

- A corpus document reads `document.json` (or `edit/document.json`) `doc.appSettings.runsOnlyOn`:
  absent or `None` gives `BOTH`, `"web-apps"` or `"android"` gives that one, and anything else raises
  `CorpusLayoutError(f"{path} declares the app's platforms as {value!r}; Nova stores
  appSettings.runsOnlyOn as \"web-apps\", \"android\" or nothing, for both.")`.
- A control reads `held = self.derived("platforms", edit=edit)`: `None` gives `BOTH`; a non-empty
  list of members of `PLATFORMS` gives that set; anything else raises, with `which = "D'" if edit
  else "D"` named in the method as `Document.derived` names its own, `CorpusLayoutError(f"{self.root
  / DERIVED} holds {which}'s platforms as {held!r}; a control retains a non-empty list of
  \"web-apps\" and \"android\".")`.

`controls.py::derived` adds `"platforms": sorted(document.platforms(edit=edit))` to each side it
writes, so every control retained from pull request 2 on carries its declaration; its module
docstring's list of derived keys gains "the platforms D and D′ declare".

### 1.3 Formplayer's walk models the client only where the app declares Web Apps

Today `proof/formplayer/walk.py` models the client for every app: `answerable` answers only the data
types the client draws a widget for (`CLIENT_DATA_TYPES`, which leaves out `datetime`, from
`entries.js::getEntry`), `drawn_with` gives an undrawn question `UNSUPPORTED` ("Not Supported by Web
Entry", `entries.js::UnsupportedEntry`), and `submission` sends that text where the client still
holds it. From pull request 2:

- `proof/formplayer/hq.py::Served` gains `platforms: frozenset = BOTH` and a method
  `reads(self, reader) -> bool: return readers.reads_app(reader, self.platforms)`; `serve()` builds it
  with `platforms=corpus.BOTH if document is None else document.platforms(edit=edit)`, so B-edit's
  state carries D′'s declaration, and a state served with no document (HQ's own app, which
  `proof/connect/test_hq_own_rename.py` and `proof/android/test_hq_own_grouped_tile_reopen.py` serve
  with `database=` given) reads as both, as it does today. `serve`'s docstring gains: "A state
  served with no document is HQ's own app, read as both platforms."
- `answerable(question, *, web_apps=True)` returns, after the address rule,
  `datatype in CLIENT_DATA_TYPES or (not web_apps and datatype == "datetime")`. Its docstring gains:
  "Where the app declares no Web Apps no worker meets the client, so the walk answers a date and
  time question as Core's session does."
- `drawn_with(question, *, web_apps=True)` returns `question.get("answer")` where `not web_apps` or
  the question is answerable, else `UNSUPPORTED`.
- `Walk` gains the field `web_apps: bool = True`; `Walk.of` sets it to `served.reads("webapps")`.
  `_values`, `_fill`, `_reconcile` and `_resends` pass `web_apps=self.web_apps` (`_resends` becomes
  an instance method). `submission` is unchanged: `held` holds `UNSUPPORTED` only where `drawn_with`
  wrote it.
- The module docstring's first paragraph gains: "Where the app declares no Web Apps (`Walk.web_apps`
  false) the walk answers a date and time question as Core's session does, and nothing holds the
  client's placeholder." The walk's other client rules (the address and binary questions it leaves
  unanswered, `chosen_as_the_client_answers`, the `search-refused` stop) are unchanged.

Formplayer takes the table's date-and-time answers: its answer route casts every answer but a
select, a multiple select and a location through
`formplayer/api/json/JsonActionUtils.java::getAnswerData`, `AnswerDataFactory.template(...).cast(new
UncastData(data))`, and `org/javarosa/core/model/data/DateTimeData.java::cast` parses the text with
`DateUtils.parseDateTime`, the parser the Core runner's answers go through (`proof/core/answers.json`
`dataTypes.dateTime`: `@clock:now`, `2001-02-03T04:05:06.000Z`, `2099-06-15T14:30:00.000Z`) (read).

### 1.4 The served observation (`proof/observe/served.py`, `proof/observe/proof4.py`)

`served.py` gains one helper beside `observes`:

```python
def observes_state(reader, served) -> bool:
    """Whether the run hands ``served`` to ``reader`` and its app declares the platform ``reader`` runs it on
    (``proof.lane.readers.PLATFORM_OF``)."""
    return observes(reader) and served.reads(reader)
```

and reads it where it reads `observes` for the client or a device:

- `Serving.formplayer`: the client's places are derived only where `observes_state("webapps",
  self.served)`; elsewhere the walk gives a location question the table's place, as a run that
  names no client does today.
- `Serving.webapps`: returns None unless `observes_state("webapps", self.served)`. The state's record
  then holds no `webapps` key, which proofs 3 and 4 already read as "nothing to compare"
  (`proof/checks/proof3.py::served_equivalence`, `proof/checks/proof4.py`, `a.get("webapps")`).
- `Serving.devices_on` and `_devices`: return `{}` unless `observes_state("android", ...)` of the
  served state.
- `aligned`: inside the `serving` block, `archive = document.local_ccz_for(configuration)` only where
  `held.served.reads("android")`, else None, so neither Formplayer's walk of Nova's local archive nor
  a device on it runs for an app that declares no Android; the local device keys follow
  `observes_state("android", held.served)`.
- The module docstring gains the paragraph: "Each reader reads a state only where the state's app
  declares the platform it runs the app on (`proof.lane.readers.PLATFORM_OF`, `Served.platforms`):
  the client an app that declares Web Apps, a device one that declares Android. Formplayer's walk
  runs for every app, the serving every other reader relies on, and models the client only where the
  app declares Web Apps (`proof.formplayer.walk.Walk.web_apps`)."

`proof4.py::_Observation._device_update` returns None unless
`served.observes_state("android", serving.served)`.

`proof/observe/sessions.py::observe` reads the local archive only where the document declares
Android: `archive = document.local_ccz_for(...) if ANDROID in document.platforms() else None`; it
returns None, as today, where A is missing or unbuildable or where the document declares Android and
holds no archive; for a document that declares no Android it runs A's baseline, the CSQL compiles
(`search_compiles`, which the intent check reads) and B's sessions, and records no `local` side.
Reason: today a missing archive returns no sessions at all, which would lose proof 3's B comparison
and the intent check's CSQL compiles on every Web-Apps-only document from pull request 5.

`proof/android` has no code change: `served.py` hands it only states whose app declares Android. Its
package tests keep their documents: `test_navigation.py` reads `targeted-multi-select-destinations`,
which declares Web Apps only from pull request 4, because that test is the lane's evidence for the
Android reading of several-case selection the platform table holds ("a device opens no form of such
a menu").

### 1.5 The Web Apps package (`proof/webapps/hq.py`)

`project()` checks the declaration before the privilege:

- where `"web-apps"` is not in `document.platforms()`: `AssertionError(f"{document.id} declares
  Android only, so no worker opens it in Web Apps and HQ's Web Apps page lists no build of it. A Web
  Apps test reads a document that declares Web Apps (Document.platforms).")`;
- where the configuration lacks `CLOUDCARE`: `AssertionError(f"{document.id}'s configuration
  {configuration} grants no {WEB_APPS_PRIVILEGE}, which the configuration of every document that
  declares Web Apps grants (proof/checks/configurations.py::_needs_cloudcare).")`.

The module docstring's first bullet ends: "A configuration grants it where an app Nova sends
declares Web Apps, which every app Nova sent before step 4 did (`proof.checks.configurations`,
finding 64)."

### 1.6 The checks that read a local archive

Each reads the archive only where the document's declaration includes Android; for a document that
declares Android, a missing archive is reported as today.

- `proof/checks/proof1.py::document_identity` adds `local_identity_differences(...)` only where
  `ANDROID in document.platforms()`.
- `proof/checks/proof3.py::behavioral_equivalence` gains `platforms=BOTH`. Where `ANDROID` is in it,
  the function is today's. Where it is not, it reports no `/no-local-archive`, compares no local
  run, and goes on to B's comparison from `baseline`; the `RecordIncomplete` message for missing
  sessions names "a document that declares Android" in place of "the document a local archive".
- `proof3.py::compare_runs` gains `platforms=BOTH` and reads a run under `RUNTIMES[other.side] &
  platforms` (profile properties read only by a runtime the app does not declare are not compared).
  `document_behavior` passes `document.platforms()` to `behavioral_equivalence`, which passes it to
  both of its `compare_runs` calls, and passes `served_equivalence` `has_local=local_ccz is not None
  and ANDROID in document.platforms()`.
- `proof/checks/proof5.py::comparisons` compares `local.ccz` with `edit/local.ccz` only where D and
  D′ both declare Android; there, one side's archive missing raises `CorpusLayoutError` as today.
- The bar, the intent check and the manifest check read the archives a document carries
  (`Document.local_archives`, `proof/observe/unit.py::local_archives`) and need no change.

Three package tests outside the checks read the local archive of a document pull request 4
declares Web Apps only (`proof/hq/test_publish.py`, `proof/rules/test_xpath_reading.py` and the
native search family's `proof/native/steps/session_reads.py`); pull request 5, which stops writing
those archives, moves each (§3.3).

### 1.7 Sensitivity, the verdict's sync requirement and Web Apps

`proof/checks/sensitivity.py`:

```python
def accepts(verdict, configuration):
    """Whether Nova's publish would send the document to a project space configured so (decision 19).

    ``verdict`` is the document's ``verdict.json``: its ``minimumConfiguration`` names the flags Nova's
    publish requires, whether it requires case search, and, where Nova's publish requires sync cases on
    form entry off, ``syncCasesOnFormEntry: false``; a verdict without that key requires nothing of it.
    """
    minimum = verdict["minimumConfiguration"]
    if not set(minimum["flags"]) <= set(configuration.flags):
        return False
    if minimum["caseSearchEnabled"] and not configuration.case_search_enabled:
        return False
    return not (minimum.get("syncCasesOnFormEntry") is False and configuration.sync_cases_on_form_entry)


def flip_entries(document, known, fixed):
    """The entries a flip's difference on ``document`` is held to before the gate's effects (``hold_flips``):
    the known register's, and on a control the fixed entries of this check naming it, which must keep
    showing there as a known entry does on its document (``proof.checks.cases.hold``)."""
    if document.kind != "control":
        return tuple(known)
    return (*known, *(entry for entry in fixed if entry.control == document.id and entry.check == CHECK))
```

`proof/checks/test_sensitivity.py::test_every_change_a_flipped_gate_makes_is_its_effect_or_registered`
holds the flips to `sensitivity.flip_entries(document, cases.load_register(), cases.load_fixed())`
and still passes `cases.load_register()` to `cases.hold`, which adds the control's fixed entries
itself.

`proof/checks/corpus.py::lacking` accepts a verdict whose `minimumConfiguration` holds
`syncCasesOnFormEntry` only as `false` (anything else raises `CorpusLayoutError(f"{verdict_path}
holds syncCasesOnFormEntry {value!r}; a verdict requires the setting off (false) or says nothing of
it.")`), and appends `"sync cases on form entry off"` to what a configuration lacks where it is
required and the configuration has the setting on.

`proof/checks/proof5.py::_edit_lacks` reads D′'s verdict a second time today, flags and case search
alone, so with D′'s verdict requiring sync off it would call a configuration with sync on one Nova
publishes D′ to, and `unpublished` would refuse a document whose D′ is rightly unpublished there.
It becomes `return corpus.lacking(configuration, document.edit.root / "verdict.json")`, its
docstring citing `corpus.lacking`, so decision 19's verdict is read in one place. Test:
`proof/checks/test_proof5_locality.py::test_d_prime_is_unpublished_under_sync_on_where_its_verdict_requires_it_off`
(pure, a tmp `edit/verdict.json`): `_edit_lacks` names "sync cases on form entry off" for a
configuration with sync on under a verdict with `syncCasesOnFormEntry: false`, and nothing for the
same configuration under a verdict without the key.

`proof/checks/configurations.py::_needs_cloudcare` becomes
`return content.source.get("cloudcare_enabled") is not False`, with the docstring: "Web Apps lists
an app only where the project space has the privilege (`_create_app_from_doc` sets a new app's
`cloudcare_enabled` from it, `get_web_apps_available_to_user` lists only an app that has it). Nova
writes the app's declaration as `cloudcare_enabled` on every publish from step 4, so an app that
declares Web Apps needs the privilege and one that declares Android only does not; an app that says
nothing, as every publish before step 4 and every control retained then, is one a worker opens in Web
Apps (finding 64)." The module docstring's "One of them every document needs: Web Apps" sentence
becomes "Web Apps (`CLOUDCARE`) is one of them where an app Nova sends declares it".

HQ facts this relies on (read): `corehq/apps/app_manager/models/applications.py::_create_app_from_doc`
sets `cloudcare_enabled = domain_has_privilege(domain, CLOUDCARE)` on a create whatever the body
says; `overwrite_app_from_source` → `_merge_source_into_app` overlays every source key not in
`Application._update_excluded_fields`, which does not hold `cloudcare_enabled`, so Nova's update
writes its value; `corehq/apps/cloudcare/utils.py::get_web_apps_available_to_user` lists a build only
where `cloudcare_enabled`; `cloudcare/views.py::FormplayerMain.dispatch` refuses a mobile worker
without the privilege (`accounting/decorators.py::requires_privilege_for_commcare_user`, HQ's 402
page); `cloudcare/views.py::PreviewAppView.get` reads neither; and no Formplayer or Core source
reads `cloudcare_enabled` (`rg -i cloudcare_enabled` over `formplayer/src` and commcare-core
`src/main`: nothing).

### 1.8 The `proof/CLAUDE.md` rule

A new bullet after "A check runs only against a target Nova's publish accepts":

> - **A reader reads an app on the platforms it declares.** An app declares Web Apps, Android, or
>   both (`appSettings.runsOnlyOn`, absent for both), and Nova refuses what a declared platform
>   cannot run, so what a reader shows on a platform the app does not declare reaches no worker
>   (decision 19, read for platforms). The Web Apps client, in App Preview too, replays a state only
>   where its app declares Web Apps, a device reads one only where its app declares Android, and
>   proof 3 compares Nova's local archive with HQ's build only for an app that declares Android, the
>   only app Nova hands one (`proof/lane/readers.py::PLATFORM_OF`, `proof/observe/served.py`).
>   Formplayer reads every app: its walk is how every state is served to the other readers and to
>   Connect (`BRINGS`), and it models the client's placeholder for a question it draws no widget for
>   (`walk.py::UNSUPPORTED`) only where the app declares Web Apps; elsewhere it answers the date and
>   time question the client cannot. A document's declaration is read from its `document.json` and a control's from its
>   `derived.json` (`Document.platforms`), never derived again from what the app holds, and a control
>   retained before step 4 reads as both, as it was published. A corpus document declares what
>   Nova's own rule gives its content, or what a targeted document states for its witness: a
>   declaration is never chosen to make the lane pass.

In the Web Apps bullet, "(every configuration of the lane grants it)" becomes "(every configuration
of a document that declares Web Apps grants it, `proof/checks/configurations.py::_needs_cloudcare`)".
Pull request 4 adds to the Connect bullet, after "Connect runs as Connect, and is given only what HQ
sent.": "A Connect app declares Android only, so Formplayer's runs of it are Core's sessions on a
server, kept because Connect reads them as it reads a device's, all but the location; a `connect`
run brings Formplayer and no device."

### 1.9 Tests pull request 2 adds

Each pairs the refusal or narrowing with its accepted neighbor and runs without Docker unless it
names a fixture that starts one.

- `proof/lane/test_readers.py::test_a_reader_reads_an_app_only_on_a_platform_it_declares`: the client
  reads an app on both or Web Apps only and not one on Android only; a device the converse;
  Formplayer and Connect every one. Catches a reader handed an app it does not run, or one withheld
  from an app it does.
- `proof/checks/test_corpus.py::test_a_documents_platforms_are_its_declaration_and_a_control_without_one_reads_as_both`:
  tmp directories with a `document.json` holding no `runsOnlyOn`, `"android"`, and `"tablet"` (refused
  by name), and two controls whose `derived.json` hold `platforms: ["web-apps"]` and no `platforms`.
  Catches a control read as narrower than it was published, and a typo read as both.
- `proof/checks/test_controls.py::test_a_control_reads_what_its_documents_checks_derive_and_holds_no_document`
  also asserts the retained `derived.json` holds `platforms` for D (and D′ where kept) equal to the
  document's.
- `proof/formplayer/test_walk.py::test_the_clients_placeholder_is_held_only_in_an_app_that_declares_web_apps`
  (pure): a tree with a date-and-time question and a text question: with `web_apps=True` the question
  is not answerable, is drawn with `UNSUPPORTED`, and `submission` sends the text; with `False` it is
  answerable, drawn with Formplayer's answer, and no `UNSUPPORTED` is sent. Catches a walk that
  submits the client's text for an app no client opens, or loses finding 74 where Web Apps is
  declared.
- `proof/checks/test_sensitivity.py::test_a_fixed_entry_holds_its_flip_on_its_own_control_and_owns_nothing_on_a_document`:
  a fixed entry built as `DEFECT_20` is, naming control `c`: on a control `c`, `flip_entries` holds the
  accepted flip's difference as held; on a document, `flip_entries` is the known register alone and
  the same difference is explained by `EFFECTS`.
- `proof/checks/test_sensitivity.py::test_a_flip_turning_sync_on_is_refused_where_the_verdict_requires_it_off`:
  a verdict with `syncCasesOnFormEntry: false` refuses the sync flip and accepts every other; the same
  verdict without the key accepts it (`test_a_flip_is_refused_exactly_where_nova_publish_would_refuse_the_configuration`
  stays as it is).
- `proof/checks/test_corpus.py::test_a_configuration_with_sync_on_lacks_what_a_verdict_requiring_it_off_names`:
  `lacking` names "sync cases on form entry off" under that verdict, nothing without the key, and
  refuses `syncCasesOnFormEntry: true` in a verdict by name.
- `proof/checks/test_corpus.py::test_web_apps_is_granted_where_the_app_nova_sends_declares_it_or_says_nothing`
  (pure, `AppContent(app=None, source=..., lookup_push=False)`): `cloudcare_enabled` true and absent
  need `CLOUDCARE`, false does not.
- `proof/checks/test_proof3_behavior.py::test_a_document_that_declares_no_android_is_compared_on_hqs_builds_and_never_on_a_local_archive`
  (`hq`, `core_runner`): `case-list-inline` copied into a tmp corpus with its `document.json` declaring
  `"web-apps"` and its local archives removed: its sessions record holds a baseline and no `local`
  side, and `behavioral_equivalence` reports no `/no-local-archive`; the same copy declaring nothing
  and holding no archive reports `/no-local-archive`.

## 2. The registers and the walk stops

### 2.1 State at `e9e6cd93` (read)

`proof/known-defects.json` holds 286 entries (defect 25 ×101, 23 ×79, 21 ×37, 24 ×26, 26 ×18, 20
×15, 30 ×4, 27 ×3, 28 ×3); `proof/fixed-defects.json` 734, none with `check: "sensitivity"`;
`proof/checks/registers.py::OPEN_DEFECTS` `{20: 4, 21: 5, 23: 5, 24: 5, 25: 5, 26: 5, 27: 5, 28: 5,
30: 5}`; `proof/walk-stops.json` 26 entries (nine `document` and nine `control` entries of Formplayer,
four of App Preview, four of the client); `proof/controls/` 108 directories.

### 2.2 Finding 74's two stops (pull request 4)

Both are Formplayer's `submit-refused:validation-error`.

- **`targeted-datetime-ordering`** declares Android only from pull request 4
  (`proof/targeted/documents/datetimeOrdering.ts` passes `appSettings: { ...NEW_APP_SETTINGS,
  runsOnlyOn: "android" }`), keeping its two date-and-time questions and every expected value, so it
  stays finding 56's device witness. Formplayer's walk of it then answers both questions (§1.3) and
  submits. Its control `proof/controls/targeted-datetime-ordering/` (finding 56's, already named by
  fixed entries) holds no `platforms`, reads as both, and its walk keeps stopping, so the entry
  becomes:

  ```json
  {"control": "targeted-datetime-ordering", "reader": "formplayer", "cause": "submit-refused:validation-error",
   "reason": "The control keeps the survey form an app that declared Web Apps held before step 4: the client draws no widget for a date and time question, holds \"Not Supported by Web Entry\" as the answer of each of the form's two and submits it, and Formplayer refuses the submission (form_entry/entries.js::UnsupportedEntry, finding 74). The document now declares Android only, where no client opens it."}
  ```

  The spec's header paragraph "The Web Apps client draws no widget ... (finding 74's stop, held in
  `proof/walk-stops.json`)" becomes: "The document declares Android only, where a device has a widget
  for a date and time question and Formplayer's walk answers it as Core's session does; its control
  keeps the form an app declaring Web Apps held, where the client's placeholder stops the walk at
  the submit (finding 74's stop, held on the control in `proof/walk-stops.json`)."
- **`fuzz-xform-20260930-0`** holds a date-and-time question and no Android-unavailable feature, so
  the fuzz mapping declares it Android only (§3.4), its walk answers Form 1-0's `/data/itext`, and the
  stop leaves. No control exists for a fuzz document, so the entry is removed.

`walk-stops.json`: 26 → 25. Every other stop stays: `fuzz-suite-20260930-8`'s `search-refused` is on
its search screen, before any form, and the document declares Web Apps after its split;
`prompt-widgets` declares Web Apps only; `fuzz-xform-20260930-4`'s `submit-refused:validation-error`
is a `false()` validation, not the client's placeholder, and Formplayer's walk of that Connect app
(Android only) meets it the same; the tile, location and instance stops are on documents that run
on both; the nine `control` entries read as both.

The finding 74 harm also exists, unstopped, on `fuzz-xform-20260930-3`, `-10`,
`fuzz-suite-20260930-3`, `-5`, `-7`, `fuzz-expression-20260930-3`, `-5`, `-7`, `case-operation-sequence`
and `workforce-case-operation-sequence`; each declares Android only and leaves the client's replay.

### 2.3 Defect 20's 15 entries (pull request 6)

The entries (read): three `sensitivity` entries, artifact
`suite.xml@project-space-setting/CaseSearchConfig.sync_cases_on_form_entry`:
`d20-sync-on-form-entry-suite-entry-post` (document `case-list-local`, control
`targeted-list-first-web-apps`), `d20-sync-on-form-entry-suite-post-relevant` (`case-list-inline`,
both), `d20-sync-on-form-entry-suite-post-exclude` (`search-multiple`, both); and twelve `proof3`
entries on `targeted-sync-on-form-entry` (document and control): nine `trace@local.ccz`, two
`formplayer@local.ccz` and one `android@local.ccz` (`Session Refresh Required`).

What pull request 6 changes, and what the lane then observes:

1. `proof/corpus/publish.ts::novaPublishVerdict` writes `minimumConfiguration.syncCasesOnFormEntry:
   false` exactly where Nova's publish asks for the `form-entry-sync-off` confirmation (the
   production predicate pull request 6 adds, `lib/commcare/planPrivileges.ts::formEntrySyncReasons`,
   non-empty: the app declares Android and a module with an effective search holds a form that loads
   a case), and leaves the key out otherwise; `NovaPublishVerdict.minimumConfiguration` gains
   `readonly syncCasesOnFormEntry?: false`. The capture change is part 05 §12's (pull request 6);
   this part reads the key (§1.7).
2. The corpus refuses a document whose `projectSettings.syncCasesOnFormEntry` is `true` while its
   verdict requires the setting off at one site, part 05 §12's `proof/corpus/entryWriter.ts`, with
   that section's message and test (`proof/corpus/__tests__/emitCorpus.test.ts`). It covers every
   document, a reproduction's included, so this part adds no refusal of its own.
3. On `case-list-local` (both) the sync flip is refused, its difference is held to the gate's effects,
   which name it (`lib/commcare/surface/entries/gates.json`, the setting's `effects`), and the entry
   no longer shows on its document.
4. On `case-list-inline` and `search-multiple` (Web Apps only from pull request 4) the flip stays
   accepted; once their entries leave the known register, the effects explain their differences.
   Sync on is no harm on Web Apps.
5. `targeted-sync-on-form-entry` drops `projectSettings` and keeps both platforms: its configuration
   is one Nova's publish accepts, proof 3's two paths agree (no sync step), and it shows the fix.
6. All fifteen move to `proof/fixed-defects.json` with their ids, check, artifact, path, kind and
   control, without `document`. Each keeps showing on its control: the retained verdicts hold no sync
   requirement, so each control's sync flip is accepted and `flip_entries` holds the three
   sensitivity entries there (§1.7); the twelve proof 3 entries show on the control's retained
   configuration with sync on, which reads as both, so its local comparison runs.
7. `OPEN_DEFECTS` drops `20`; its comment reads "steps 2, 3 and 4 fixed every other numbered defect and
   finding they registered"; `proof/checks/test_registers.py::test_every_live_defect_is_a_later_steps`'s
   docstring opens "Step 4's exit: the known-defect register holds no entry of a defect steps 2, 3 and
   4 fixed.", and its last assertion, today `step > 3`, becomes `assert all(step > 4 for step in
   registers.OPEN_DEFECTS.values())`, so a defect left at step 4 fails the test rather than only its
   docstring.

The CommTrack part of defect 20 has no entry (Nova emits nothing CommTrack's readers read;
`gates.json` `project-space-setting/Domain.commtrack_enabled` effects `[]`) and its confirmation is
step 5's.

### 2.4 Defect 21's `requests` entry (pull request 6)

`d21-list-first-turned-search-fir-trace-case-list-trace-requests` (proof 4, `trace@case list@*`,
`/runs/*/trace/*/requests`) names document and control `targeted-sync-on-form-entry`: the Case List
save that turns the list-first menu search-first, in a project space with sync cases on form entry
on, changes the remote requests Core's session sends. `targeted-list-first-web-apps`, the same app
with sync off, shows defect 21's other classes and not this one, so with sync off
`targeted-sync-on-form-entry` is expected to lose it.

Decision: the entry's `document` becomes `targeted-sync-on-form-entry-web-apps` (§4.3), its control
stays `targeted-sync-on-form-entry`, and it stays live. The new document is the original's app
declared Web Apps only, published with sync on: Nova's publish asks nothing about the setting for an
app that declares no Android, so the configuration is one decision 19 admits, and its proof 4 inputs
(HQ's build, the Case List save, Core's sessions of HQ's builds) are the original's but for
`cloudcare_enabled`, which HQ already stored true for the original (its configuration grants
`CLOUDCARE`), and which keeps the Case List page's selector shown
(`app_manager/views/modules.py::get_module_view_context`, `show_search_workflow`). A register entry
holds its class on every document, so if the sync-off original still shows the class, the same entry
holds it there too.

Pull request 6's own lane (readers off, proof 4 is Core's) decides whether the new document shows
the class, through `proof/checks/registers.py::reconcile`, which fails the gate on an entry that no
difference on its document matches (`unseen`):

- **Outcome A, expected: the new document shows it.** The entry is re-homed as above and stays
  live. Counts as §2.6's pull request 6 row.
- **Outcome B: it does not.** The class then needed sync on in an app that runs on Android, which
  Nova's publish now refuses (`form-entry-sync-off`), so it reaches no worker. The entry moves to
  `proof/fixed-defects.json` on its retained control `targeted-sync-on-form-entry`, with its id,
  check, artifact, path and kind, and no `document`; the control's retained configuration holds
  sync on and its sessions from before the fix, so the class keeps showing there. Its reason: "The
  Case List save that turns the list-first menu search-first changes Core's remote requests only
  with sync cases on form entry on in an app that runs on Android, which Nova's publish refuses
  from step 4; the same app declared Web Apps only and published with sync on does not show it."
  `targeted-sync-on-form-entry-web-apps` stays in the corpus as the witness that sync on is no harm
  for an app no phone runs, its `rows` dropping `"21"` and its header bullet the sentence on
  defect 21's class. Counts as §2.6's outcome B row.

### 2.5 Defect 21's `manifest` entries (pull request 5)

`proof/checks/manifest_value_classes.py::list_first_with_web_apps` classifies a JSON use of
`case-search/workflow-legacy-classic-auto-launch-false-in-an-app-with`'s keys (REFUSED, value class
`list-first-with-web-apps`) as the REFUSED class where the module offers search, `auto_launch` is
false, and the app body's `cloudcare_enabled` is truthy. No Nova body carries the key today. From
pull request 5 every body of an app that declares Web Apps carries `true`, and Nova emits both
`auto_launch` and `default_search` (`lib/commcare/hqJson/caseList.ts`, `hqShells.ts`), so every
list-first searching module of such a document shows two classes. Pull request 5 registers them:

```json
{"id": "d21-list-first-with-web-apps-manifest-auto-launch", "defect": 21, "part": "list-first turned search-first",
 "check": "manifest", "artifact": "*app.json", "path": "/schema:CaseSearch.auto_launch/refused/list-first-with-web-apps",
 "document": "targeted-list-first-web-apps", "control": "targeted-list-first-web-apps-declared"}
{"id": "d21-list-first-with-web-apps-manifest-default-search", "defect": 21, "part": "list-first turned search-first",
 "check": "manifest", "artifact": "*app.json", "path": "/schema:CaseSearch.default_search/refused/list-first-with-web-apps",
 "document": "targeted-list-first-web-apps", "control": "targeted-list-first-web-apps-declared"}
```

A control retained before pull request 5 holds bodies without the key, so it cannot show them; the
existing `targeted-list-first-web-apps` control is named by known entries and stays. The new control
is retained from pull request 5's own emission after the lane's first run at that head. The lane
uploads its corpus as one zstd-compressed tar under the file's own name
(`.github/workflows/ci.yml`, "Pack the proof corpus" and "Upload the proof corpus", `archive:
false`), so the artifact is `proof-corpus-<attempt>.tar.zst`, `<attempt>` being the run's attempt:

```bash
gh run download <run id> -n proof-corpus-<attempt>.tar.zst -D <dir>
mkdir <dir>/corpus && zstd -dc <dir>/proof-corpus-<attempt>.tar.zst | tar -x -C <dir>/corpus
python3 -m proof.checks.controls <dir>/corpus targeted-list-first-web-apps manifest --as targeted-list-first-web-apps-declared
```

`OPEN_DEFECTS` already gives 21 to step 5.
`proof/README.md`, "The defect rows", row 21's checks column gains "manifest
(`list-first-with-web-apps`, from step 4's `cloudcare_enabled`)".

### 2.6 Counts by pull request

| After | Known | Fixed | Walk stops | Controls | `OPEN_DEFECTS` |
|---|---|---|---|---|---|
| `main` | 286 | 734 | 26 | 108 | 20, 21, 23 to 28, 30 |
| 2, lane mechanics | 286 | 734 | 26 | 108 | unchanged |
| 4, the declaration | 286 | 734 | 25 | 108 | unchanged |
| 5, publish, Web Apps | 288 | 734 | 25 | 109 | unchanged |
| 6, publish, defect 20 (§2.4 outcome A) | 273 | 749 | 25 | 109 | 21, 23 to 28, 30 |
| 6, publish, defect 20 (§2.4 outcome B) | 272 | 750 | 25 | 109 | 21, 23 to 28, 30 |
| step 4's exit | 273 or 272 | 749 or 750 | 25 | 109 | 21, 23 to 28, 30 |

Outcome B moves sixteen entries out of the known register (defect 20's fifteen and defect 21's
`requests` entry); defect 21 keeps 39 known entries under outcome A and 38 under outcome B (37 at
`main`, plus pull request 5's two), so `OPEN_DEFECTS` still gives it to step 5. No other pull request moves a register entry, a stop or a control.

## 3. The corpus

### 3.1 The census, and which documents change

Read from a corpus emitted at `main` (392 documents, seed 20260930, sample 24 + 8; §8) by the domain
shapes of each platform-scoped feature: search first (`caseSearchConfig.searchFirst`), several-case
selection (`caseListConfig.selection.kind === "multiple"`), `date` and `multi-select` search inputs,
the date-and-time question (`fields[*].kind === "datetime"`), a Connect app (`connectType`), and the
expression nodes `here` and `session-context`. No document holds a `here()` read, a read of the
session context fields step 4 scopes to a platform (`window_width`, `drift`, `applanguage`), or a
case list search text read; the session context reads the corpus holds are of fields both platforms
supply (`username` in `lookup-app` and `lookup-reversed`, `userid` in `targeted-csql-composition`).
Each document declares the platforms on which none of its uses is unavailable, media aside; where
that is neither, Web Apps with each date-and-time question split.

| Declaration | Count | Documents, by source |
|---|---|---|
| both | 324 | every document not named below |
| Web Apps only | 37 | producers (28): `case-capture-multiple`, `case-extension-multiple`, `case-extension-multiple-repeat`, `case-list-inline`, `endpoint-inline`, `endpoint-multiple`, `function-arguments`, `navigation-search-date-add`, `navigation-search-datetime-add`, `navigation-search-day-range`, `nested-menu-same-multiple`, `no-matches-bare`, `-basic`, `-home`, `-multiple-home`, `-parent`, `-parent-bare`, `prompt-widgets`, `search-advanced`, `-automatic`, `-browse`, `-hidden`, `-hidden-link`, `-inline`, `-multiple`, `-parent`, `-registration-link`, `-remote-multiple`; workforce (1): `workforce-case-list-inline`; expander (3): `expander-a-survey-menu-s-case-type-keeps-the-host-s-case-a0ec1500-0`, `expander-expanddoc-hq-json-projection-search-config-137d770b-0`, `expander-expanddoc-hq-json-projection-search-config-keeps-1b12e3dc-0`; targeted (5): `targeted-form-links-hidden-and-fallback`, `targeted-inline-search-reads`, `targeted-multi-select-destinations`, `targeted-no-matches-return-identity`, `targeted-session-reads` |
| Android only, a date-and-time question | 12 | `case-operation-sequence`, `workforce-case-operation-sequence`, `targeted-datetime-ordering`, `fuzz-xform-20260930-0`, `-3`, `-10`, `fuzz-suite-20260930-3`, `-5`, `-7`, `fuzz-expression-20260930-3`, `-5`, `-7` |
| Android only, a Connect app | 18 | producers `connect-deliver-custom`, `connect-deliver-default`, `connect-learn-custom`, `connect-learn-default`; `expander-the-app-level-keys-of-the-hq-import-file-writes-8f03ffc5-0` to `-3`; `fuzz-xform-20260930-2`, `-4`, `-5`, `-6`, `-8`, `-9`, `-11`; `targeted-connect-deliver-rename`, `targeted-connect-learn-rename`, `targeted-invalid-connect-ids` |
| neither, Web Apps with the split | 1 | `fuzz-suite-20260930-8` (search first, and the date-and-time question `model`) |

No Connect document holds an Android-unavailable use, so none is unresolvable. Every D′ holds its D's
platform-scoped features but four, whose edit turns Connect on in a document that runs on both, so
their D′ declares Android only: `expander-case-list-only-admission-refuses-removing-the-9dd27652-0`,
`expander-expanddoc-hq-json-projection-sort-elements-85a51a04-0`,
`expander-form-hashtag-expansion-keeps-an-unresolvable-f5cf70e7-0` and
`expander-markdown-itext-for-all-field-kinds-emits-616f6b4b-0`.

Where each declaration is written (pull request 4): every corpus source of a document narrower than
both writes its declaration explicitly in the module that builds the document (`appSettings: {
...NEW_APP_SETTINGS, runsOnlyOn: <platform> }`, for the scenarios named above), a choice made so
each witness states its platform where its content is read, except the Connect fixtures below.
Where a fixture adds a platform-scoped use after `lib/__tests__/docHelpers.ts::buildDoc` returns,
the write is also what the gate requires, since `buildDoc`'s default (part 01 §11.3) reads only the
content it was given: `csqlArgumentFixture` and `searchPromptFixture` add `date` search inputs to
`searchEmissionFixture("remote")`, which runs on both. The sources:

- the producer fixtures in `lib/commcare/__tests__/`: `caseCaptureFixture.ts`,
  `extensionCaseFixture.ts`, `caseListEmissionFixture.ts`, `endpointWireFixture.ts`,
  `csqlFunctionFixture.ts` (`csqlArgumentFixture`), `compilerNavigationFixture.ts`
  (`temporalSearchFixture`), `nestedMenuWireFixture.ts`, `noMatchesWireFixture.ts`,
  `searchPromptFixture.ts`, `searchEmissionFixture.ts` and `caseOperationFixture.ts`;
- the expander test documents in `lib/commcare/__tests__/expander.test.ts`;
- the targeted specs `formLinksHiddenFallback.ts`, `inlineSearchReads.ts`,
  `multiSelectDestinations.ts`, `noMatchesReturnIdentity.ts`, `sessionReads.ts`,
  `datetimeOrdering.ts`, `connectApps.ts` (D and D′) and `formShapes.ts::invalidConnectIds`.

The workforce documents (`proof/corpus/workforce.ts`) are built over their producer bases and carry
each base's declaration, so `workforce-case-list-inline` and `workforce-case-operation-sequence`
need no edit of their own. The Connect fixtures (`lib/commcare/__tests__/connectWireFixtures.ts`,
which builds with `buildDoc`, and the `8f03ffc5` expander documents) take `buildDoc`'s default for a
document that sets `connectType` and no `appSettings`, which declares Android only.

The census holds itself: every corpus document passes `proof/corpus/emitCorpus.ts::admittedDoc`
(`runValidation` empty, or emission throws by name), and every fuzz document `fuzzSample.ts::admitted`,
so a document whose declaration does not admit its content fails pull request 4's emission by name.
After pull request 4 the corpus holds 394 documents: 326 on both (with `targeted-datetime-split` and
`targeted-platform-declaration`), 38 on Web Apps only, 30 on Android only. Pull request 6 adds
`targeted-sync-on-form-entry-web-apps` (395), pull request 9 `targeted-preview-android-renders`
(396), and pull request 10 `targeted-session-context-reads` and `targeted-case-list-search-text`.
At step 4's exit, 398: 326 on both, 40 on Web Apps only (with `targeted-sync-on-form-entry-web-apps`
and `targeted-session-context-reads`), 32 on Android only (with `targeted-preview-android-renders`
and `targeted-case-list-search-text`).

`proof/checks/test_corpus.py::test_the_corpus_holds_each_declaration_and_a_narrowing_edit` (pull
request 4, over `Corpus.emitted`): some document declares each of both, Web Apps only and Android
only; some document's D′ declares fewer platforms than its D; no D or D′ declares an empty set.
Catches a fixture change that leaves a reader's policy branch with no document to read.

### 3.2 What the reader policy does to the registers

Joined with the register (read): the twelve `android@` entries are on `container-nested-query` (9),
`expander-form-links-emission-forwards-literal-condition-47c96355-0` (2) and
`targeted-sync-on-form-entry` (1), all three on both. Every `webapps@` and `formplayer@` entry is on a
document on both or Web Apps only. The Web-Apps-only documents that hold entries
(`case-capture-multiple` 14, `case-extension-multiple` 19, `case-extension-multiple-repeat` 11,
`targeted-form-links-hidden-and-fallback` 16, `case-list-inline` 1, `search-multiple` 1) hold no
`android@` artifact and no `trace@local.ccz` or proof 1 local entry. The Android-only documents hold
no entry, and no Connect document holds a known entry (the fixed Connect entries are on controls,
which read as both). So decision 1 moves no register entry, and only the two finding 74 stops of §2.2
move.

From pull request 5 the Android-only documents' configurations lack `CLOUDCARE` (§1.7): none of
HQ's views Formplayer, a device or Connect asks reads the privilege (the restore, the receiver, the
archive and the search are outside `cloudcare/views.py`), and the App Settings save forces
`cloudcare_enabled` false without it (`app_manager/views/apps.py`, `should_edit("cloudcare_enabled")`),
which is the value an Android-only app already stores.

### 3.3 What changes for the Web Apps-only documents' local archives (pull request 5)

From pull request 5 (decision 8): `proof/corpus/entryWriter.ts` writes `local.ccz`, `local-again.ccz`
and `local-empty-list-text.ccz` only where D declares Android and `edit/local.ccz` only where D′ does;
`proof/corpus/writePublishCaptures.ts` compiles the per-configuration archive under the same rule;
`proof/corpus/emitCorpus.ts::refusal` checks the `ccz` export mode only for a document that declares
Android, so a Web-Apps-only document stays in the corpus; `proof/corpus/inputs.ts` lists only the
archives a document holds, as it does today. A targeted document that declares no Android runs its
expectations on HQ's build: `proof/targeted/build.ts::targetedDocument` refuses an expectation whose
`export` is `"local"` there (`throw new Error(\`The targeted document ${spec.id} declares no Android,
so Nova offers no local archive of it; run its expectation ${expectation.id} on HQ's build ("A").\`)`),
and pull request 5 moves the expectations of `formLinksHiddenFallback.ts`, `inlineSearchReads.ts`,
`multiSelectDestinations.ts` and `noMatchesReturnIdentity.ts` to `"A"` and drops `"local"` from
`sessionReads.ts`'s loop. `proof/checks/test_corpus.py::test_a_document_is_read_with_every_export_and_its_configuration`
asserts `(document.local_ccz is not None) == (ANDROID in document.platforms())` in place of the local
archives' presence. `proof/targeted/__tests__/targeted.test.ts` gains `it("refuses an expectation on a
local archive of a document that declares no Android, and runs the same one on HQ's build")`.

Three package readers of a local archive run in the pull request lane (no `reader` mark) over a
document pull request 4 declares Web Apps only, and pull request 5 moves each (every other package
test that reads `local_ccz` or `local.ccz` reads a document on both, an Android-only Connect
document, or a control):

- `proof/hq/test_publish.py::test_a_working_app_serves_what_a_ccz_names` reads
  `documents[ARCHIVE_DOCUMENT].local_ccz.read_bytes()` with `ARCHIVE_DOCUMENT = "case-list-inline"`.
  `ARCHIVE_DOCUMENT` becomes `"case-list-local"`, the same fixture's list-first scenario, which runs
  on both and whose first module searches, so the suite still names the search and case fixture
  URLs the test resolves. `proof/hq/conftest.py::DOCUMENTS` gains `"case-list-local"` and keeps
  `"case-list-inline"` (`test_date_pattern_characters.py` publishes it), and its comment names the
  archive test's document.
- `proof/rules/test_xpath_reading.py::_texts` opens `document.root / "local.ccz"` for every id in
  `proof/rules/conftest.py::DOCUMENTS`, which holds `case-list-inline`.
  `test_the_port_reads_each_shape_as_cores_parser_builds_it` reads the documents of `DOCUMENTS`
  that declare Android (`ANDROID in document.platforms()`), and `DOCUMENTS` gains
  `"case-list-local"`, whose one form is the same fixture's "Visit" form, so the expressions read
  stay the same; `case-list-inline` stays named for `test_stored_position_keys.py`, which publishes
  it and reads no local archive.
- `proof/native/steps/session_reads.py::session_reads` raises "has no local.ccz archive" for
  `targeted-inline-search-reads`, the search family's witness (`suite_emission.py`), whose search
  first keeps it Web Apps only, so no Android document can carry its reads. The adapter copies the
  local archive only where the document declares Android, where a missing one still raises
  ("The targeted session witness {document_id} declares Android and has no local.ccz archive."),
  and its evidence records `"localArchiveSha256": None` otherwise; HQ's regeneration is written as
  today. `proof/native/core/SearchRuntimeTest.java::formReadsTheResultsItsSearchReturned` reads the
  local side only where the step copied `local.ccz`, and HQ's side always: Core is the engine Web
  Apps runs the regenerated forms on, so the witness keeps proving the reads a Web Apps worker
  meets.

### 3.4 The fuzz mapping

`proof/CLAUDE.md`: "An existing fuzz sample keeps its draws. A generator change that repairs an
inadmissible value maps the value after its draw, without a new random call." No generator draws a
declaration. Pull request 4 adds one module, `lib/doc/platformDeclaration.ts`, holding the planner
part 09 §5 (step 1, `declare-platforms`) specifies, `planContentDeclaration(doc):
ContentDeclarationPlan` (kinds `declared`, `runs-on-neither` and `split-refused`; a `declared` plan
carries `runsOnlyOn`, `causes`, `mutations` and `splits: readonly DatetimeSplit[]`, part 03 §2.11's
type), and,
for the fuzz mapping and test fixtures, one thin wrapper:

```ts
/** `doc` with `planContentDeclaration(doc)`'s mutations applied (`applyMutations` in one draft); throws
 *  `PlatformDeclarationBlocked`, naming the plan's kind and its blocking feature ids or field, on any
 *  kind but `declared`. Deterministic and idempotent. */
export function declaredForContent(doc: BlueprintDoc): BlueprintDoc;
```

The planner reads `lib/domain/platformUses.ts::platformFeatureUses` and `contentRunsOn` (part 01 §3)
and plans the split with `lib/doc/datetimeSplit.ts::planDatetimeSplits` (pull request 3), whose
identities are UUIDv5 under the split's namespace. The mutations are `setAppSettings({ runsOnlyOn })`
first, then the split's. The cutover (pull request 13) calls `planContentDeclaration` as its first
step (part 09 §5) and adds the media removals the corpus never needs.

The mapping is the last step of each generator's `lowerToDoc`:
`lib/commcare/__tests__/xformDocArbitrary.ts::lowerToDoc` returns
`declaredForContent(resolveArbitraryDocument({...}))`, and
`lib/commcare/__tests__/suiteDocArbitrary.ts::lowerToDoc` returns
`declaredForContent(orderRulesTheGateAdmits(resolveArbitraryDocument({...})))`. Reasons: it runs
inside the existing `docGenSpecArb.map(lowerToDoc)`, so no `fc` call is added and every draw stays;
and the generators' own Vitest consumers draw the same arbitraries and require admission
(`compilerEvidence.ts::checkCompilerEvidence` asserts `runValidation(...)` is `[]`;
`xformOracle.fuzz.test.ts` asserts a refused session-read draw's findings are exactly
`SESSION_DATUM_NOT_SUPPLIED`), which a mapping only in `fuzzSample.ts::afterDraw` would leave failing.
`expressionDocArbitrary.ts` draws `suiteDocArbitrary`, so it is mapped already; its plans add no
platform-scoped use. `fuzzSample.ts::afterDraw`'s nesting runs after the mapping and changes no
platform-scoped use. The xform generator draws Connect apps (`connectType` learn or deliver) and
date-and-time questions and no search; the suite generator draws search first, `date` search inputs
and date-and-time questions and no Connect app; so the mapping never meets `runs-on-neither`. Nor
does it meet `split-refused`, which needs a date-and-time question whose validation reads the
question itself through a step filter: no admitted document holds one (part 03 §2.4), the xform
generator's validations are constants that read no field (`xformDocArbitrary.ts::SAFE_BOOLEAN_XPATH`),
and `expressionDocArbitrary.ts`, which adds a drawn condition to a field's validation, reads a form
answer as a bare field read of a root answer (its `reference` shape over `rootAnswers`, which leaves
out every field in a repeat) and draws no step filter over form paths. Were a later generator change to draw either,
`declaredForContent` throws `PlatformDeclarationBlocked` naming the kind, and the draw is mapped
before that change lands.

Effect on the sample: ten sampled documents' `doc` changes (`fuzz-xform-20260930-0`, `-3`, `-10` and
the six suite and expression documents of §3.1 narrow; `fuzz-suite-20260930-8` declares Web Apps and
splits `model` into `model_date` and `model_time`), plus the seven Connect fuzz documents, which
narrow to Android; the rest are byte-identical until pull request 5 writes `cloudcare_enabled`.

Tests: `lib/doc/__tests__/platformDeclaration.test.ts`, the one file that holds part 09 §5's
planner cases and these of the wrapper: no mutation for a document on both; Android only for a
date-and-time question; Android only for a Connect app; Web Apps only for search first; Web Apps
with the split for search first beside a date-and-time question, its question ids `<id>_date` and
`<id>_time` and UUIDs `datetimeSplitFieldUuid(appId, uuid, "date" | "time")` (attempt 0, part 03
§2.5); `PlatformDeclarationBlocked` naming the uses for a Connect app with search first
(`runs-on-neither`); applied twice equals applied once; a document that declares already is
unchanged. `proof/corpus/__tests__/fuzzSample.test.ts`
gains `it("declares each draw for the platforms its content runs on and splits the date-and-time
questions of one that runs on neither, with no further draw")`: at seed 20260930, size 24,
`fuzz-xform-20260930-0` and `-2` declare `"android"`, `fuzz-suite-20260930-8` declares `"web-apps"`
and holds `model_date`, `model_time` and no `datetime` field, `fuzz-suite-20260930-0` declares
nothing; and the existing prefix property (`draw(2)` equals the first two of a larger draw) holds.

### 3.5 Edit kinds

`proof/corpus/editKinds.ts::EDIT_KIND_GENERATORS` is typed over every `Mutation["kind"]`; the
declaration rides `setAppSettings`, so no kind is added and the balanced assignment of kinds to
documents does not move. No third `setAppSettings` candidate is appended: `editBatches.ts::judgeProposal`
keeps the first admitted candidate, the first flip (`showSavedForms`) is admitted on every document
this emission tried (4 of 4), so a third would never be judged; the narrowing's witness is
`targeted-platform-declaration`'s written D′ ("A precise witness writes its precise edit",
`proof/CLAUDE.md`).

`setConnectType`'s turning-on branch returns `batch([{ kind: "setAppSettings", settings: {
runsOnlyOn: "android" } }, ...plan.mutations])` where `ctx.doc.appSettings.runsOnlyOn !== "android"`,
and `batch(plan.mutations)` where it already is, the batch shape pull request 11's store action
commits (`lib/session/store.ts::switchConnectMode`, part 07 §2.7, which prepends the declaration
where the app declares Web Apps); it draws from `ctx.rng` and `ctx.mint` exactly as today. The edit
kind's behavior in pull request 4 depends on no builder code. A document whose content cannot run
on Android has the batch refused by the gate, as Connect on such a document is refused anyway. The
four kept Connect batches of §3.1 stay kept and gain the narrowing.
`proof/corpus/__tests__/editBatches.test.ts` gains `it("turns Connect on as the builder commits it,
narrowing the app to Android in the same batch, and is refused where the content cannot run on
Android")`.

## 4. Targeted documents

Each has explicit identities from `targetedUuid`, is built by Nova's planner and admitted by the gate
(`proof/targeted/build.ts::targetedDocument`), is appended to `proof/targeted/index.ts::TARGETED_DOCUMENTS`
and to `proof/README.md`, "Targeted documents", and needs no control.

### 4.1 `targeted-datetime-split` (pull request 3)

`proof/targeted/documents/datetimeSplit.ts::datetimeSplit()`. The original is
`lib/doc/__tests__/datetimeSplitFixture.ts::datetimeSplitOriginal()` (shared with pull request 3's
planner tests and the `expression` family, §5.1): case type `visit` (`case_name`, `seen_at`
`data_type: "datetime"`); module "Visits" on `visit` with a Name column and two forms, "Book"
(registration: text `name` writing `case_name`) and "Check" (follow-up: date-and-time `seen_at`,
label "Seen at", `caseWrite` `visit.seen_at`, `default_value` `#visit/seen_at`, `validate`
`. <= now()`, `validate_msg` "Seen at can't be later than now"); module "Planning" (survey) with the
form "Plan": date-and-time `planned_at` ("Planned for", `default_value` `now()`), date-and-time
`due_at` ("Due by", `default_value` `now()`, no case write) and text `note` (label "Note for
#form/planned_at", `relevant` `#form/due_at >= #form/planned_at`, `validate` `#form/planned_at <=
now()`, `validate_msg` "A plan is for a time up to now"). The document is the original with
`planDatetimeSplits(original).mutations` applied: the writer's split, and two non-writers' splits
read by a constraint, a label and a relevance that compares the two joins (part 03 §9's coverage of
one joined value compared with another). It declares nothing: the split's fields run on both, so
every reader reads it. rows: `["the date-and-time split: a writer with its preload, validation and
default, and non-writers read by a constraint, a label and a comparison of two joins"]`. Expected
(Core on `"local"`, wall clock only, so the device's zone does not enter):

- `split-writer-joins`: form "Check", session `{ command: "m0-f1", caseId: "targeted-visit" }`,
  answers `/data/seen_at_date` `2026-03-04` and `/data/seen_at_time` `10:30:00`, expression
  `format-date(/data/seen_at, '%Y-%m-%d %H:%M')`: `"2026-03-04 10:30"`.
- `split-reader-joins`: form "Plan", answers `/data/planned_at_date` `2026-03-04` and
  `/data/planned_at_time` `09:15:00`, expression `format-date(/data/planned_at, '%H:%M')`: `"09:15"`.
- `split-joins-compare-later`: form "Plan", answers `/data/planned_at_date` `2026-03-04`,
  `/data/planned_at_time` `09:15:00`, `/data/due_at_date` `2026-03-04` and `/data/due_at_time`
  `10:00:00`, expression `if(/data/due_at >= /data/planned_at, 'due later', 'due earlier')`:
  `"due later"`.
- `split-joins-compare-earlier`: the same with `/data/due_at_time` `09:00:00`: `"due earlier"`.

Served readers read it at pull request 3's head in the run started by hand (§6.3); the pull request
lane serves no state.

### 4.2 `targeted-platform-declaration` (pull request 4)

`proof/targeted/documents/platformDeclaration.ts::platformDeclaration()`, built by one helper
`visits(narrowed: boolean)` so D and D′ share identities: case type `patient` (`note`); module
"Patients" on `patient` with a Name column and the follow-up form "Visit" (text `note`, label "Note",
writing `patient.note`). D declares nothing. D′ is `visits(true)`: `appSettings.runsOnlyOn:
"android"` and a date-and-time question `seen_at` ("Seen at", no case write) after `note`, so the
gate judges the narrowing and the question the narrowing admits as one batch. rows: `["the platform
declaration narrowed to Android only, with a date-and-time question the narrowing admits"]`. Expected:
`answerHeld("note-held", uuid("visit"), "/data/note", "seen", "local", { command: "m0-f0", caseId:
"targeted-patient" })`.

What reads it: at A, every reader (the client replays it); at B-edit, Formplayer's walk answers
`seen_at` and submits, a device walks it, and the client does not replay it. From pull request 5 the
intent clause holds `cloudcare_enabled` true at A and B and false at B-edit (§7.1), its configuration
grants `CLOUDCARE` (D's body declares Web Apps), and the capture of its D′ goes through the Web Apps
question pull request 5 adds (part of that pull request's capture change). The Web Apps package test
of §7.2 reads the home screen before and after.

### 4.3 `targeted-sync-on-form-entry-web-apps` (pull request 6)

`proof/targeted/documents/searchApps.ts::syncOnFormEntryWebApps()`: the app of `syncOnFormEntry()`
(`searchApp(id, "Claimed visits", ...)` with the same search input) with `appSettings: {
...doc.appSettings, runsOnlyOn: "web-apps" }`, `projectSettings: { syncCasesOnFormEntry: true }`,
rows `["21", "20, sync on form entry (an app for Web Apps only, where Nova asks nothing)"]`, and its
note expectation on `"A"` (`answerHeld("note-held", form, "/data/note", "seen", "A", { command:
"m0-f0", caseId: "targeted-patient" })`). The header gains a bullet: "`targeted-sync-on-form-entry-web-apps`
(defect 21, and defect 20's setting where it is no harm): the same app declared Web Apps only and
published with sync cases on form entry on, which Nova's publish accepts for an app no phone runs; it
carries defect 21's `requests` class, which the Case List save shows under that setting." Under
§2.4's outcome B the rows are `["20, sync on form entry (an app for Web Apps only, where Nova asks
nothing)"]` and the bullet ends before "it carries". In the same
pull request `syncOnFormEntry()` drops `projectSettings`, and its header bullet ends: "From step 4
Nova's publish asks a person to confirm the setting is off for an app that declares Android and opens
a searched case in a form, so the document is published with it off and its two paths agree; its
control keeps the session from before the fix."

### 4.4 `targeted-session-context-reads` (pull request 10)

`proof/targeted/documents/sessionContextReads.ts::sessionContextReads()`, declared Web Apps only
(`window_width` is unavailable on Android): case type `patient` (`note`); module "Patients" on
`patient` with

- the display condition `instance('commcaresession')/session/context/window_width > 0` (the
  comparison of `term(sessionContext("window_width"))` with `0`, a module slot part 03 §6.2 admits;
  Formplayer's walk and the client send a width, `proof/formplayer/webapps.py::WINDOW_WIDTH`, so the
  menu shows on both);
- columns Name (`case_name`), `calculatedColumn(uuid("window"), "Window", term(sessionContext("window_width")))`,
  `calculatedColumn(uuid("drift"), "Drift", term(sessionContext("drift")))` and
  `calculatedColumn(uuid("language"), "Language", term(sessionContext("applanguage")))`;
- case search with one Search field `width` ("Window width", text) whose starting value is
  `term(sessionContext("window_width"))`, the search value part 02 §8.3 holds;
- the follow-up form "Visit" with text `note` (writing `patient.note`) and four hidden values:
  `drift` (`term(sessionContext("drift"))`), `language` (`term(sessionContext("applanguage"))`),
  `app_version` (`term(sessionContext("appversion"))`) and `device_id`
  (`term(sessionContext("deviceid"))`).

rows: `["the session context read in record slots, a search value and form logic"]`. Expected: the
note echo on `"A"`. The context values of `window_width`, `drift` and `applanguage` are not fixed by
hand: each runtime gives its own (Web Apps `drift` 0, the session's language, the client's window
width), so they are held by the readers' records, compared across states by proofs 3 and 4, and by
the `expression` family (§5.2).

`appversion` and `deviceid` are pin facts Preview states on Web Apps (part 06 §18.2, §23.4), and
Formplayer supplies them (`session/FormplayerInstanceInitializer.java::getVersionString`,
`getDeviceId`), not Core's evaluate, whose intent values come from Core's own initializer. So the
spec writes the file `formplayer-session.json` (`TargetedSpec.files`) holding
`{"/data/app_version": WEB_APPS_APPVERSION, "/data/device_id": WEB_APPS_DEVICE_ID}`, imported from
`lib/preview/platform.ts`, and `proof/checks/intent.py` gains `formplayer_session_values(document,
records)`: where a document holds that file and a state's record holds Formplayer's walk (the lane
with the readers), each submission of the form at those paths must hold the file's values, one
`_difference(document, f"formplayer@{state.name}", path, path, "changed", expected, observed)` each
where not. A pin move that changes Formplayer's value then fails the nightly's intent check until the
constant in `lib/preview/platform.ts` moves. Test:
`proof/checks/test_intent.py::test_formplayer_gives_the_session_values_preview_states_for_web_apps`
(pure, records built by hand): the file's values held, one difference each way where a submission
differs, and nothing compared where the record holds no Formplayer walk.

### 4.5 `targeted-case-list-search-text` (pull request 10)

`proof/targeted/documents/caseListSearchText.ts::caseListSearchText()`, declared Android only (the
value arm is unavailable on Web Apps): case type `patient` (`note`, `searched`); module "Patients"
with a Name column (one case-list step) and the follow-up form "Visit" with hidden `searched`, whose
`calculate` is the value arm `{ kind: "case-list-search-text" }` (part 03 §5.2), writing
`patient.searched`, and text `note` (writing `patient.note`) whose `relevant` compares the same arm
with `''`. rows: `["the case list search text read in a form's calculate and relevance"]`.
Expected: the note echo on `"local"`. A device's walk taps cases without typing a search, so it reads
the arm's absent case (`''`) and `note` is relevant; the present case, one node and two, is the
`expression` family's (§5.2).

### 4.6 `targeted-preview-android-renders` (pull request 9)

`proof/targeted/documents/previewAndroidRenders.ts::previewAndroidRenders()`, declared Android only,
the document part 06 §24's three Android reader tests read; its header comment states what each form
shows:

- a survey module "Text" whose form "Text" holds a label question labelled `a` newline
  `b ![x](y) <b>c</b>` (part 06 §24.1);
- a module "Visits" on case type `visit` (`status`) with a custom tile of three cells, vertical
  alignment `top`, `middle` and `bottom` (`tileCell(…, { verticalAlign })`, part 06 §24.2);
- in "Visits", the follow-up form "Update visit" that writes `visit.status` from the text question
  `status`, with the entry point `update_visit` (part 06 §24.3).

rows: `["Preview's Android readings: a Markdown label, a tile cell's vertical alignment and an entry
point to a case the phone lacks"]`. Expected: `answerHeld("status-held", uuid("update-visit"),
"/data/status", "seen", "local", { command: "m1-f0", caseId: "targeted-visit" })`. The three tests
and what each outcome changes are part 06 §24's; this part registers the document and runs the tests
by hand (§6.3).

### 4.7 Two existing targeted documents gain the new reads (pull request 10)

- `targeted-inline-search-reads` (`proof/targeted/documents/inlineSearchReads.ts`, Web Apps only):
  "Check in" gains a hidden value whose starting value is `#search/patient_name`, and "Find
  patient"'s case list gains a calculated column reading the same Search field (part 03 §4.2); its
  expectation on `"A"` gains the searched name in both.
- `targeted-instance-reads` (`proof/targeted/documents/instanceReads.ts`) gains a repeat whose
  calculate counts cases by a predicate reading the row's own answer (`current()/../<question>`,
  part 03 §7.2), with an expectation that answers two rows differently and holds each row's own
  count.

## 5. Native proofs

### 5.1 `expression`: the split's instant (pull request 3)

`proof/native/producers/emit-expression-evidence.ts` writes `datetime-split/` (each form of
`datetimeSplitOriginal()` after `planDatetimeSplits`, through `compileCcz` with
`NATIVE_RUNTIME_TARGET`) and `datetime-split.json` (the rows). `proof/native/core/DatetimeSplitRuntimeTest.java`
runs in `DEVICE_ZONES` (`UTC`, `America/New_York`, `Asia/Kolkata`, `Pacific/Kiritimati`), each a
test JVM of its own, and asserts its own zone first (the zoned-class rule). Over the writer
("Check") and the non-writers ("Plan"):

- For rows (2026-03-04, 10:30:00), (2026-07-15, 23:45:00) and (2026-01-01, 00:00:00) it answers
  `seen_at_date` and `seen_at_time` in the form Core parsed and holds:
  `format-date(/data/seen_at, '%Y-%m-%d %H:%M:%S')` is the answered date and time (the value keeps
  its clock); the bound value is a `DateTimeData` (`xsd:dateTime` keeps the clock through
  `Recalculate.wrapData`, pull request 3's R3) equal to what `DateTimeData.cast` of the zone-less
  wall clock holds, which is what the original question held for the same entry; and the writer's
  `nova_datetime_` text names the same instant.
- For a time in New York's spring-forward gap (2026-03-08, 02:30:00) and one in its fall-back
  repeated hour (2026-11-01, 01:30:00), in each zone, the joined value equals `DateTimeData.cast`
  of the same wall clock, and the instant each zone gives is recorded in the method's report (the
  repeated hour's answer is the fact part 03 §2.12 reads).
- A preloaded case value `2026-03-04T10:30:00.000000Z` (the `default_value` `#visit/seen_at` of
  "Check") fills the two questions and rejoins to its instant.
- A blank date or a blank time leaves the joined value blank, and the time question's validation
  passes for a time with a blank date.

`families.py` gains `"DatetimeSplitRuntimeTest": "expression"` in `CORE_CLASSES` and
`"DatetimeSplitRuntimeTest": DEVICE_ZONES` in `ZONED_CLASSES`. Plausible failures: a join read in UTC
on a device in another zone, a bind that drops the clock, a join that lands outside a gap or a
repeated hour differently from the original question, a preload that does not rejoin, and a guard
that throws on a blank part.

### 5.2 `expression`: session context and row predicates (pull request 10)

`proof/native/producers/emit-expression-evidence.ts` writes `session-context/` and
`session-context.json` (from `lib/commcare/__tests__/sessionContextFixture.ts`, among its forms the
gate's `window-width.xml`) and `row-predicates/` and `row-predicates.json` (from
`rowPredicateFixture.ts`), each form through `compileCcz` with `NATIVE_RUNTIME_TARGET`.

- `proof/native/core/SessionContextRuntimeTest.java` (the suite's JVM), the one class for the
  session context reads, registered `"SessionContextRuntimeTest": "expression"`:
  - **The guarded reads.** Forms the producer emits with Nova's printer: `drift` and `applanguage`
    in a calculate, `window_width` in a case list detail field, each absent-capable read under the
    count guard `if(count(P) > 0, P, '')`, and `case-list-search-text` in a calculate printed as
    Nova emits it, `if(count(P) > 0, P[1], '')` with `P` =
    `instance('commcaresession')/session/data/stringquery` (part 03 §5.3). Each session instance is
    built by Core's own `org/commcare/session/SessionInstanceBuilder.java::getSessionInstance`,
    which writes no node for a null value (`addData`): with `windowWidth` and `applanguage` null and
    present, and with no case-list step, one, and two steps carrying `KEY_LAST_QUERY_STRING` ("Ama"),
    which `addUserQueryData` turns into one `session/data/stringquery` node per step. It asserts `''`
    where the node is absent and the value where present, `"Ama"` with two nodes, with no
    exception, and `drift` `0` through
    `org/commcare/core/process/CommCareInstanceInitializer.java::getCurrentDrift`. A bare read of
    `P` with two nodes throws, the control that shows the guard's `[1]` is needed.
  - **The `window_width` gate**, part 03 §6.4's design in two methods over `window-width.xml`, an
    XForm whose calculate reads `instance('commcaresession')/session/context/window_width` bare and,
    in a second calculate, under the count guard. Each initializes the form with a session root from
    `SessionInstanceBuilder.getSessionInstance(…, "1024", "en")`, then again with a root built with
    width `null`: `windowWidthReadOnACachedForm` (arm (a)) re-initializes the same `FormDef`, as
    Formplayer's cache hit does (`services/FormDefinitionService.java::getFormDefWithCache`), and
    `windowWidthReadOnAFreshForm` (arm (b)) re-parses the XForm into a fresh `FormDef`, which
    stands for the one Formplayer deserializes from the session's stored definition after a cache
    miss (`FormDefinitionService.java::getFormDefFromSession`, `FormDefStringSerializer.deserialize`):
    neither carries `templatePathChecked`, since `XPathPathExpr.java::writeExternal` and
    `::readExternal` do not serialize it, so either way each expression checks its path again. The
    first run is decisive by assertion (part 03 §6.4): both methods assert the guarded
    calculate reads `''`; `windowWidthReadOnACachedForm` asserts the bare calculate reads `''`, and
    `windowWidthReadOnAFreshForm` asserts it throws `XPathTypeMismatchException`; each bare
    assertion's failure message names what the calculate gave instead (the value read, or the
    exception's class and message). `proof/native/test_core_runtime.py::test_core_runs_the_proof_class`
    prints each failing JUnit test's name and message, so the slice's verdict is the readout: green
    is outcome A (expected), and a red `windowWidthReadOnAFreshForm` naming the value `''` is outcome
    B, after which that assertion flips to `''`. Part 03 §6.4 states what each outcome ships and how
    a failure of the cached arm or of a guarded assertion is read; part 02 §8.4's REFUSED entry cites
    this class and `FormDefinitionService.getFormDefWithCache`. The class is run by hand on pull
    request 10's branch before that pull request's manifest text is written (§6.3), and each method
    then stays as the retained evidence, asserting the outcome the run showed.
- `proof/native/core/RowPredicateCurrentRuntimeTest.java` (the suite's JVM): a form whose repeat
  `visits` holds `kind` and a hidden value counting rows whose `kind` equals the entry's own, printed
  `current()/../kind`, in three predicates: one Core answers through its predicate index (an equality
  on `@case_type` and an indexed property of `casedb`, which is a `StorageBackedTreeRoot`:
  `org/commcare/cases/util/StorageBackedTreeRoot.java::tryBatchChildFetch`), one it evaluates row by
  row (a `contains()` test,
  `org/javarosa/core/model/condition/EvaluationContext.java::expandReferenceAccumulator`), and an
  in-memory fixture's attribute predicate (`org/javarosa/core/model/instance/TreeElement.java::tryBatchChildFetch`,
  which delegates to `org/javarosa/core/model/instance/utils/TreeUtilities.java::tryBatchChildFetch`).
  With two entries answered differently, each entry's count is its own under all three. A fourth
  row reads the repeat's own `relevant`: it reads the row's `kind` in a non-indexed `casedb`
  predicate, printed `current()/kind`, and answers per entry. The bare `/data/visits/kind` print,
  the retained control, throws on the non-indexed predicates and answers per entry on the indexed
  one (part 03 §9). Plausible failure: a print that names every entry of the repeat in one of the
  evaluations.
- `families.py::CORE_CLASSES` gains both under `"expression"`.

### 5.3 `media`: per declaration (pull request 7)

The media family's new scenarios are part 04 §8.3's, which owns them: `mediaWireFixture(mediaOnly,
formats)` with `formats: "none" | "every-platform" | "web-apps" | "android"`, the scenarios
`media-web-apps-on` and `media-android-on` from the two new sets and `media-svg-refused` from
`proof/native/producers/emit-media-evidence.ts::svgRefusedScenario()`, the one deliberately
inadmissible emission, built on its own path without `runValidation` and never in `mediaManifest`,
all three in `proof/native/steps/media_emission.py::FORMAT_SCENARIOS`, their file sets and zip
counts, and the certificate's canonical count of 7. This family is the execution that settles "HQ
types it as its kind" for each newly accepted variant
(`hqmedia/models.py::CommCareMultimedia.get_class_by_data`) and HQ's refusal of an SVG: a variant
HQ types as another kind fails the family by name, and pull request 7 then drops that variant from
what Nova accepts, never loosening the test. Part 04 §8.3's AVIF gate is the one planned: where
`media-web-apps-on` shows HQ refusing the AVIF, `svgRefusedScenario()` becomes
`refusedImageScenario(file)`, emitting `media-svg-refused` and `media-avif-refused`, the `web-apps`
set drops to 7 files, and the canonical count becomes 8. The scenarios run in pull request 7's own
lane, as every native family does (a package group keyed by the harness's files).

The corpus video's re-encode as H.264 Main, the 46 documents whose bytes and keys it moves, the
three committed hash literals and the untouched controls are part 04 §8.1's. The corpus's synthetic
asset rows (`proof/corpus/editBatches.ts::readyRow`, `mediaWireFixtures.ts::mediaRecords`) carry the
stand-in key of their kind, which `lib/commcare/__tests__/mediaWireFixtures.test.ts` and
`proof/corpus/__tests__/editBatches.test.ts` hold equal to `classifyStoredMediaBytes` of the real
bytes (part 04 §8.1). The reader run before the merge is this part's: §6.3's pull request 7 row, a
hand dispatch over five of those documents and two slices. Five suffice because every corpus video
is the one re-encoded file (part 04 §8.1), so each of the 46 carries the same change, and the first
night after the merge reads all 46 with every reader (§6.4). The native `media` scenarios are not
part of that dispatch: they run in pull request 7's own lane.

Part 04 §8.5's H.264 High question is a gate on pull request 7, not a lane run: the pull request is
not cut until the person has answered whether to run `proof/android/decode/` for H.264 High on
their Mac, a run made only on their yes (part 10, house rule 6). If they run it, its outcome lands
in pull request 7; if they decline, the cutover's window does not open until they confirm the
advisory dry run's count of `mp4-h264-high` references to remove (part 09 §14, step 1(f)).

## 6. CI cost and the stack's order

### 6.1 The rows (`proof/README.md`, "Timings and what the lane is expected to take")

| The change | Groups | Shards | Expected end |
|---|---|---|---|
| nothing the lane reads | the audit sample | 1 | 5.9 to 6.6 min |
| a judge's file (`proof/checks/**`, `proof/rules/**`, a register, walk stops, the surface) | all 508, judged from stored records | 5 | 10.7 min |
| the observation's code, the image, or most documents | all 508, observed afresh | 15 | 12.7 min |

A pull request's store restore reads main's newest snapshot and its own `pr<number>` scope only
(`proof/ci/store-keys.mjs`), so a stacked pull request never reads its base's records, and its row is
the row of everything between main and its head.

### 6.2 What each pull request costs

| # | Row | Why |
|---|---|---|
| 1 | 10.7 min, 5 shards | the surface entries and part 02's check are judge files; no document's key moves |
| 2 | 12.7 min, 15 shards | observation code: `proof/formplayer/walk.py`, `proof/formplayer/hq.py`, `proof/observe/served.py`, `proof/observe/sessions.py`, `proof/observe/proof4.py`, `proof/webapps/hq.py`, `proof/lane/readers.py` |
| 3 to 15 | 12.7 min, 15 shards each | pull request 2's observation change is beneath each; pull request 5 also moves every document's key (every HQ body gains `cloudcare_enabled`), pull request 4 about 72 documents', pull request 7 46 documents' |

**What a push costs.** A push to pull request k starts 16 − k lane runs: 5 shard-jobs for pull request
1's and 15 for each above it, so 5·[k = 1] + 15·(16 − max(k, 2)) shard-jobs, beside each run's corpus,
gate, test, smoke and build jobs. A shard's job took 281 to 457 seconds on the measured fresh run
(run 39403685632).

| Push to | Lanes | Shard-jobs | Rounds of twenty | Rounds of six |
|---|---|---|---|---|
| 1, or cutting the stack | 15 | 215 | 11 | 36 |
| 2, lane mechanics | 14 | 210 | 11 | 35 |
| 4, the declaration | 12 | 180 | 9 | 30 |
| 5, publish, Web Apps | 11 | 165 | 9 | 28 |
| 7, media | 9 | 135 | 7 | 23 |
| 10, expression reads | 6 | 90 | 5 | 15 |
| 13, cutover | 3 | 45 | 3 | 8 |
| 15, removal | 1 | 15 | 1 | 3 |

GitHub's free plan runs about twenty jobs at once across the account; while a lane with the readers
holds fourteen, six remain ("Rounds of six"). On this model a push to pull request 2 is about eighty
minutes of the whole account before the top pull request's verdict, and over four hours while a
scheduled lane with the readers runs (the week from Saturday 19:07 UTC to Sunday evening, the pin pull
request from Monday 00:37 UTC, the image comparison from Monday 17:17 UTC). So:

- Pull requests 2, 3, 4 and 5 are settled on their own branches before the stack is cut (part 10,
  house rule 5): each one's lane, its tests, its base-and-head corpus emission where it narrows (3,
  4), and its by-hand reader run (§6.3's rows 2 to 5). Each moves what every later lane reads (2 the
  observation, 3 a stored shape and the split's identities, 4 about 72 documents' keys, 5 every
  document's key and the control it retains from its own emission), so a fix to any of them after
  the cut restacks ten or more fresh lanes.
- A fix-up goes to the pull request it belongs in, a session's pushes are one push of the stack
  (`gh stack`), and no restack is pushed while a scheduled lane with the readers runs.
- The by-hand reader runs of §6.3 run at a head and restack nothing.

### 6.3 Reader runs by hand before the merge

The pull request lane runs no served reader (`PROOF_READERS=0`), and the gate leaves the readers'
register and walk-stop entries to the nightly, so a stop leaving its document or a reader entry
holding is seen before the merge only in a run started by hand on GitHub's runners (`proof/README.md`,
"Seeing a reader's verdict before a merge"). None runs on the person's machine. Each names documents
(one of them carrying an edit), its gate holds them and the controls of the same name, and
`mechanics_shards=auto` sizes it from the queue. Each is started at its pull request's head once that
pull request's lane holds, and read with `gh run list --workflow proof-audit.yml --branch <branch>
--limit 1`, `gh run watch <id> --exit-status` and `gh run view <id> --web`.

| Head | Command | What it must show |
|---|---|---|
| 2 | `gh workflow run proof-audit.yml --ref <branch> -f nightly=false -f mechanics=targeted-datetime-ordering,targeted-connect-deliver-rename,case-list-inline,targeted-multi-select-destinations -f mechanics_shards=auto` | nothing moves: finding 74's stop still on `targeted-datetime-ordering`'s document, Connect, the client and a device as main's records hold them |
| 3 | `... -f mechanics=targeted-datetime-split,targeted-wire-equal-republish -f mechanics_shards=auto` | the split read by every reader, no stop, no entry |
| 4 | `... -f mechanics=targeted-datetime-ordering,fuzz-xform-20260930-0,fuzz-xform-20260930-3,fuzz-suite-20260930-8,case-operation-sequence,targeted-platform-declaration,targeted-connect-deliver-rename,case-list-inline,targeted-form-links-hidden-and-fallback,expander-markdown-itext-for-all-field-kinds-emits-616f6b4b-0 -f mechanics_shards=auto`, and `gh workflow run proof-audit.yml --ref <branch> -f nightly=false -f slice='proof/formplayer/test_case_blocks.py' -f slice_readers=formplayer` | §2.2's two stops leave their documents and the control's holds; `fuzz-suite-20260930-8`'s stop stays; no device on a Web-Apps-only document and no client on an Android-only one; the six `webapps@` proof 4 entries of `targeted-form-links-hidden-and-fallback` hold; the case blocks slice passes on `case-operation-sequence`, whose walk now answers `visible_at` (§7.3), and where it does not, its message names the form and the blocks, and the walk is fixed in pull request 4 |
| 5 | `... -f mechanics=targeted-platform-declaration,targeted-list-first-web-apps,targeted-list-first-places,case-operation-sequence,navigation-base -f mechanics_shards=auto`, and `gh workflow run proof-audit.yml --ref <branch> -f nightly=false -f slice='proof/webapps/test_session.py' -f slice_readers=webapps` | defect 21's proof 4 reader entries hold on the two list-first documents; the home test of §7.2 passes. Part 05's App Settings save test (`proof/editors/test_plan_features.py::test_without_cloudcare_a_settings_save_turns_web_apps_off`) is not dispatched: it starts no served reader, and HQ's editors run in the pull request lane (`proof/README.md`, "The lane's two profiles", without the readers), so pull request 5's own lane is the run that decides part 05's outcome pair |
| 6 | `... -f mechanics=targeted-sync-on-form-entry,targeted-sync-on-form-entry-web-apps,targeted-list-first-web-apps,case-list-local,case-list-inline,search-multiple,targeted-platform-declaration -f mechanics_shards=auto` | the fixed `formplayer@local.ccz` and `android@local.ccz` entries show on `targeted-sync-on-form-entry`'s control; no reader shows a sync step on the documents |
| 7 | `... -f mechanics=targeted-media-slots,media-rich,targeted-blank-labels,case-list-inline,targeted-platform-declaration -f mechanics_shards=auto`, and the two slices `-f slice='proof/webapps/test_media_slots.py' -f slice_readers=webapps` and `-f slice='proof/formplayer/test_media_slots.py' -f slice_readers=formplayer` | the re-encoded video plays and is shown on every reader, the three hash literals hold (part 04 §8.1); the native `media` family's three scenarios (four where HQ refuses the AVIF) run in the pull request's own lane (§5.3) |
| 9 | `... -f mechanics=targeted-preview-android-renders,targeted-platform-declaration -f mechanics_shards=auto`, and part 06 §24's three slices, `gh workflow run proof-audit.yml --ref <branch> -f nightly=false -f slice_readers=android` with `-f slice='proof/android/test_form_reads.py::test_a_markdown_label_renders_as_markwon_renders_it'`, `-f slice='proof/android/test_case_lists.py::test_a_tile_cell_takes_only_middle_vertical_alignment'` and `-f slice='proof/android/test_navigation.py::test_an_entry_point_to_a_case_the_phone_lacks_opens_blank_and_its_completion_is_read'` | the document read by Formplayer and a device and by no client, no stop; each slice's observed outcome, which part 06 §24 turns into Preview's reading before its copy lands |
| 10, the gate | `gh workflow run proof-audit.yml --ref <branch> -f nightly=false -f slice='proof/native/test_core_runtime.py -k SessionContextRuntimeTest' -f slice_readers=0`, at the commit that adds `SessionContextRuntimeTest` and before the commit that writes pull request 10's manifest text | the slice's verdict, read with `gh run view <id> --log-failed` where it fails (`test_core_runs_the_proof_class` prints each failing JUnit test's name and message): green is outcome A; a red `windowWidthReadOnAFreshForm` naming the value `''` is outcome B (§5.2, part 03 §6.4), which decides the manifest text part 02 §8.4 writes and part 01's `window-width` rows |
| 10 | `... -f mechanics=targeted-session-context-reads,targeted-case-list-search-text,targeted-inline-search-reads,targeted-instance-reads,targeted-platform-declaration -f mechanics_shards=auto` | the new reads on every reader their documents declare, no stop; Formplayer's `appversion` and `deviceid` held by `formplayer_session_values` (§4.4) |
| top of the stack | one run over the union of the lists above, before `gh stack merge` | everything above at the head that merges |

Both outcomes of each stop are planned: where a stop the table expects to leave does not, or a stop
appears that the table does not foresee, the run's evidence (`checks/stops/<kind>-<document>.json`)
names it; a reader's own end gets its entry in the same pull request by the rules of "Walk stops", and
one a worker would get past is a fix to the walk or the replay, never an entry.

### 6.4 The first night after the merge

The stack merges together (`gh stack merge`, one deploy), and its emission, observation and image
inputs move every key, so the next scheduled night (03:23 UTC, Tuesday to Saturday) is the whole lane
with every reader: about 13.5 hours on up to fourteen of the account's twenty runners. The merge is
made Monday to Friday so that night follows it. Its issue, where it fails, names each failing group,
why, and the command that reruns it (`python3 -m proof.lane.report`); a failure is fixed in a
follow-up pull request at that command's slice. Pull request 14 refreshes `proof/timings.json`'s
`no-readers` profile from a fresh dispatch of that pull request (`-f proof_fresh`); the `readers`
profile is refreshed from that first night's run in a pull request after it.

## 7. Pull request 5's lane changes (the wire carries the declaration)

### 7.1 The intent clause

`proof/checks/intent.py` gains:

```python
def web_apps_setting(document, platforms, state) -> list:
    """HQ's stored app lists the app in Web Apps (``cloudcare_enabled``) exactly where the document declares
    Web Apps: Nova writes the declaration on every publish, and HQ's update keeps it
    (``models/applications.py::_merge_source_into_app``)."""
```

It compares `state.doc.get("cloudcare_enabled")` with `WEB_APPS in platforms` and returns one
`_difference(document, f"app.json@{state.name}", "/cloudcare_enabled", "/cloudcare_enabled",
"changed", expected, observed)` where they differ. `intent_differences` calls it for A and B with
`document.platforms()` and for B-edit with `document.platforms(edit=True)`. A control reads as both,
and every control's stored app holds `true` (its configuration grants `CLOUDCARE` from bodies that
carry no key), so every control holds it. The module docstring's list gains: "**HQ, Web Apps**: the
stored app's `cloudcare_enabled` is the document's declaration (`app.json@<state>`,
`/cloudcare_enabled`)." Test: `proof/checks/test_intent.py::test_hq_stores_the_web_apps_setting_the_document_declares`
(pure, held states built by hand): true for both and Web Apps only, false for Android only, one
difference each way where they disagree.

### 7.2 Web Apps lists an app only while it declares Web Apps

`proof/webapps/test_session.py::test_web_apps_lists_an_app_while_it_declares_web_apps_and_not_once_it_narrows_to_android`
(readers: `formplayer_runner`, `editor_driver`) over `targeted-platform-declaration` (added to
`proof/webapps/conftest.py::DOCUMENTS`): in its minimum configuration (which grants `CLOUDCARE`), D's
first publish released (`webapps_hq.project`, `project.released`) stores `cloudcare_enabled` true, the
worker's home (`Session(release, editor_driver).run([steps.SCREEN])`) shows the app's tile (kind
`"default"`), and `get_web_apps_available_to_user` lists its build; then, in a fork of the unit, D′'s
captured update applied (`proof/observe/publish.py::update(unit, app_id,
document.edit.exports["minimum"].update, "B-edit")`) and released stores it false, the home shows no
app tile, and the listing holds no build of it. Plausible failures: an update HQ does not keep, and a
home that lists an app declared Android only. It holds once what the step's decisions asked of every
Android-only state (Departures).

### 7.3 Other lane files

- `proof/checks/test_corpus.py::PLAN_PRIVILEGES` gains `"CLOUDCARE"`; its comment reads "Web Apps is
  among them for an app that declares it: Nova asks for the plan feature and the lane grants it from
  the body's `cloudcare_enabled` (`configurations._needs_cloudcare`)".
- `proof/hq/test_publish.py::test_an_update_carrying_case_sharing_and_web_apps_writes_both` asserts
  `body["cloudcare_enabled"] is True` (`navigation-base` runs on both) in place of the key's absence;
  its docstring's "Nova sends neither yet" becomes "Nova sends `cloudcare_enabled` from the app's
  declaration and no `case_sharing` yet".
- `proof/webapps/conftest.py::DOCUMENTS` and `proof/webapps/test_generated_groups.py::DOCUMENTS` drop
  `case-operation-sequence` in pull request 4, where it declares Android only: no worker opens it in
  Web Apps, and the four other documents hold every generated group shape (`nova_operations`,
  `nova_condition_<operation>`, the keyed repeat). `test_generated_groups.py`'s module docstring
  names the four in its release list ("On HQ's release of Nova's export of
  ``case-operation-conditional``, ``case-operation-key``, ``case-operation-query`` and
  ``case-capture-multiple``").
- `proof/formplayer/test_case_blocks.py` keeps `case-operation-sequence` (Formplayer reads every
  app). From pull request 4 its walk answers the date-and-time question `visible_at` from the answer
  table, as Core's session does, in place of holding the client's placeholder (§1.3); the test's
  contract, Formplayer's blocks equal to Core's, is unchanged and is read in pull request 4's by-hand
  slice (§6.3, row 4). Its module docstring gains: "``case-operation-sequence`` declares Android
  only, so Formplayer's walk answers its date and time question as Core's session does."
- `docs/research/2026-09-26-hq-round-trip/harness-findings.md`, finding 64, gains: "*Step 4:* Nova
  writes `cloudcare_enabled` from the app's declaration on every publish, so the derivation grants
  `CLOUDCARE` exactly where an app Nova sends declares Web Apps or says nothing, as every publish
  before step 4 and every control retained then; an app declaring Android only is stored with it
  false and listed nowhere. Defect 21's selector then shows only on documents that declare Web Apps."

## 8. Stale lane docs

| Where | Today | From |
|---|---|---|
| `proof/README.md`, "Walk stops" | "The list now holds 25 entries: 30 before these six removals, plus this newly reached stop (R5 run 39129168950)." | pull request 2: "The list then held 25 entries: 30 before these six removals, plus this newly reached stop (R5 run 39129168950); finding 75's stop on its control (step 3) made it 26." Pull request 4 adds the paragraph: "Step 4 offers a date-and-time question only in an app that does not declare Web Apps. `targeted-datetime-ordering` declares Android only, so its stop moved to its control, which keeps the form an app declaring Web Apps held; `fuzz-xform-20260930-0` is declared Android only by the fuzz mapping, and its entry is removed. The list holds 25 entries." |
| `proof/README.md`, "Configurations" ("One of them every document needs: Web Apps") and "The Web Apps driver" ("Every configuration of the lane grants the privilege (finding 64), so every app it builds is one Web Apps lists.") | every configuration grants Web Apps | pull request 2: "Web Apps (`CLOUDCARE`) is one of them where an app Nova sends declares it, which every app sent before step 4 did (finding 64)" and "A configuration grants the privilege where the document declares Web Apps (finding 64), so every app such a document builds is one Web Apps lists; a document declaring Android only is not replayed by the client." |
| `proof/README.md`, "Served states" | no platform rule | pull request 2: the reader policy paragraph of §1.4 |
| `proof/README.md`, "Fixed defects" | a fixed entry is held on its control | pull request 2: rule 3 gains "Configuration sensitivity holds a control's fixed entries before the gate's effects, as it holds a document's known entries (`sensitivity.flip_entries`)." |
| `proof/README.md`, "The defect rows", row "20, sync on form entry" | open | pull request 6: the row's harm cell ends "Fixed in step 4: Nova's publish asks a person to confirm the setting is off for an app that declares Android and holds such a form (`form-entry-sync-off`), and an app for Web Apps only publishes with it on", and its last cell reads "fixed; still shown by the controls `targeted-sync-on-form-entry`, `targeted-list-first-web-apps`, `case-list-inline` and `search-multiple`" |
| `proof/README.md`, "The defect rows", row "21" | live; checks "proof 4, then 2 and 3" | pull request 5: the checks column gains "manifest (`list-first-with-web-apps`, from step 4's `cloudcare_enabled`)" (§2.5). Pull request 6, under §2.4's outcome A: nothing more. Under outcome B, the harm cell ends "Its change to Core's remote requests needs sync cases on form entry on in an app that runs on Android, which Nova's publish refuses from step 4 (`form-entry-sync-off`): that class is fixed, and the control `targeted-sync-on-form-entry` still shows it." |
| `proof/README.md`, "Connect in the unit", "Whose submissions" | no declaration | pull request 4: "A Connect app declares Android only (no Connect worker signs in to Web Apps), so Formplayer's runs of it are Core's sessions on a server, kept because Connect reads them as it reads a device's, all but the location; a `connect` run brings Formplayer and no device." |
| `proof/README.md`, "The corpus" | no platforms | pull request 4: a paragraph "Platforms": each source declares what §3.1 says, the fuzz mapping, and the census test |
| `proof/README.md`, "Targeted documents", "Native proofs" | | each pull request of §4 and §5 adds its document or scenario |
| `proof/CLAUDE.md` | "(every configuration of the lane grants it)" | §1.8 |
| `harness-findings.md`, finding 74 | open | pull request 4: "*Closed in step 4:* Nova offers a date-and-time question only in an app that does not declare Web Apps, so no worker meets the client's placeholder: `targeted-datetime-ordering` declares Android only, where Formplayer's walk answers the question as Core's session does, and its control keeps the stop; `fuzz-xform-20260930-0` is declared Android only by the fuzz mapping, and its stop left with no control." |

## Files

- Pull request 2: `proof/lane/readers.py`, `proof/lane/test_readers.py`, `proof/checks/corpus.py`,
  `proof/checks/controls.py`, `proof/checks/test_controls.py`, `proof/checks/test_corpus.py`,
  `proof/formplayer/hq.py`, `proof/formplayer/walk.py`, `proof/formplayer/test_walk.py`,
  `proof/observe/served.py`, `proof/observe/proof4.py`, `proof/observe/sessions.py`,
  `proof/webapps/hq.py`, `proof/checks/configurations.py`, `proof/checks/sensitivity.py`,
  `proof/checks/test_sensitivity.py`, `proof/checks/proof1.py`, `proof/checks/proof3.py`,
  `proof/checks/test_proof3_behavior.py`, `proof/checks/proof5.py` (`_edit_lacks`),
  `proof/checks/test_proof5_locality.py`, `proof/CLAUDE.md`, `proof/README.md`.
- Pull request 3: `lib/doc/__tests__/datetimeSplitFixture.ts`, `proof/targeted/documents/datetimeSplit.ts`,
  `proof/targeted/index.ts`, `proof/native/producers/emit-expression-evidence.ts`,
  `proof/native/core/DatetimeSplitRuntimeTest.java`, `proof/native/families.py`, `proof/README.md`.
- Pull request 4: `lib/doc/platformDeclaration.ts` and `lib/doc/__tests__/platformDeclaration.test.ts`
  (`declaredForContent` and its cases, beside part 09 §5's `planContentDeclaration`),
  `lib/commcare/__tests__/xformDocArbitrary.ts`, `suiteDocArbitrary.ts`, the fixture modules and
  `expander.test.ts` of §3.1, `proof/corpus/editKinds.ts`,
  `proof/corpus/__tests__/fuzzSample.test.ts`, `editBatches.test.ts`, the targeted specs of §3.1,
  `proof/targeted/documents/platformDeclaration.ts`, `proof/targeted/index.ts`,
  `proof/walk-stops.json` (26 to 25), `proof/webapps/conftest.py`, `proof/webapps/test_generated_groups.py`
  (`DOCUMENTS` and its docstring), `proof/formplayer/test_case_blocks.py` (its docstring),
  `proof/checks/test_corpus.py` (the census test), `proof/CLAUDE.md` (Connect), `proof/README.md`,
  `harness-findings.md` (finding 74).
- Pull request 5: `proof/checks/intent.py`, `proof/checks/test_intent.py`, `proof/webapps/test_session.py`,
  `proof/webapps/conftest.py`, `proof/checks/test_corpus.py`, `proof/hq/test_publish.py` (the update
  test of §7.3 and `ARCHIVE_DOCUMENT`, §3.3), `proof/hq/conftest.py`, `proof/rules/conftest.py`,
  `proof/rules/test_xpath_reading.py`, `proof/native/steps/session_reads.py`,
  `proof/native/core/SearchRuntimeTest.java`,
  `proof/corpus/entryWriter.ts`, `writePublishCaptures.ts`, `emitCorpus.ts`, `proof/targeted/build.ts`,
  `proof/targeted/__tests__/targeted.test.ts`, the four targeted specs and `sessionReads.ts` of §3.3,
  `proof/known-defects.json` (two entries, 286 to 288), `proof/controls/targeted-list-first-web-apps-declared/`,
  `proof/README.md`, `harness-findings.md` (finding 64). The capture's own changes
  (`proof/corpus/publish.ts`, `targetPeer.ts`) are part 05 §12's.
  `application-and-settings/40-hq-cloudcare-enabled` flips to HELD, with `gates.json`
  `privilege/cloudcare`, in pull request 4 (part 02 §5.2); pull request 5 edits only its emission
  cell (part 02 §6.1).
- Pull request 6: `proof/corpus/publish.ts` (`minimumConfiguration.syncCasesOnFormEntry`, with part
  05 §12), `proof/corpus/__tests__/publish.test.ts`, `proof/targeted/documents/searchApps.ts`,
  `proof/targeted/index.ts`, `proof/known-defects.json` (15 out, one re-homed, 288 to 273),
  `proof/fixed-defects.json` (734 to 749; under §2.4's outcome B 16 out, 288 to 272 and 734 to
  750), `proof/checks/registers.py` (`OPEN_DEFECTS`), `proof/checks/test_registers.py` (the
  docstring and the `step > 4` assertion), `proof/README.md` (rows 20 and, under §2.4's outcome B,
  21). The corpus's sync-on refusal is part 05 §12's `entryWriter.ts`, and the sync gate's content
  cell in `gates.json` is part 02 §6.2's.
- Pull request 7: none of this part's own beyond its by-hand run (§6.3); the fixture, the native
  `media` family and the hash literals are part 04 §11's.
- Pull request 9: `proof/targeted/documents/previewAndroidRenders.ts`, `proof/targeted/index.ts`,
  `proof/README.md` ("Targeted documents"); the three Android reader tests and `Views.java` are part
  06 §24's.
- Pull request 10: `proof/targeted/documents/sessionContextReads.ts`, `caseListSearchText.ts`,
  `inlineSearchReads.ts`, `instanceReads.ts`, `proof/targeted/index.ts`, `proof/checks/intent.py`
  (`formplayer_session_values`), `proof/checks/test_intent.py`,
  `lib/commcare/__tests__/sessionContextFixture.ts`, `rowPredicateFixture.ts`,
  `proof/native/producers/emit-expression-evidence.ts`, `proof/native/core/SessionContextRuntimeTest.java`,
  `RowPredicateCurrentRuntimeTest.java`, `proof/native/families.py`, `proof/README.md`.
- Pull request 14: `proof/timings.json` (`no-readers`), README tables that count documents, controls
  and groups.

## Departures

- **No per-state Web Apps record for an app that declares no Web Apps** (the step's decisions asked the client
  and App Preview to record the home without the app's tile). In the state's own configuration such an
  app's project space has no `CLOUDCARE` (§1.7), so HQ refuses the worker's Web Apps page by privilege
  (`FormplayerMain.dispatch`, the 402 page) before any home is drawn, and App Preview has no home of
  apps (`PreviewAppView.get` renders the one app). The fact that matters, that HQ lists no build of an
  app without `cloudcare_enabled`, is one listing rule (`get_web_apps_available_to_user`), held once
  with the client by §7.2 over a document whose space has Web Apps, and per state by the intent clause
  of §7.1.
- **The intent clause lands in pull request 5, not 2** (decision 7; the step's outline put it with the
  lane mechanics): in pull request 2 it would fail pull request 4's lane on every document declared
  Android only before the wire carries it.
- **The session context document is two documents** (the step's decisions named one): `window_width` is
  unavailable on Android and `case-list-search-text` on Web Apps, so no one declaration admits both.
- **The corpus writes no local archive for a document that declares no Android** (decision 8), which
  the stack table does not name: it follows from pull request 5's `.ccz` refusal, which the corpus's
  `localCcz` reaches through `chooseDownloadTarget`.
- **The census adds Connect's 18 documents** to the counts the step's decisions gave (342 / 37 / 12 / 1, which
  left Connect to the emission): 324 / 37 / 30 / 1.

## Executed during planning

- **A read of a corpus emitted at `main`** (392 documents, seed 20260930, sample 24 + 8; emitted
  between #798 and #800, and `git diff --stat 3d4171b3..e9e6cd93 -- lib proof/corpus proof/targeted`
  shows no change to a generator, fixture or targeted spec): every `document.json` and
  `edit/document.json` scanned by the domain shapes of §3.1, `connectType` among them, giving the
  census, the four Connect-on edits, and the absence of `here()` reads, of reads of the
  platform-scoped session context fields and of case list search text reads (the `username` and
  `userid` reads present are of fields both platforms supply). Pull request 4's emission is its own check (§3.1).
- **The registers and walk stops joined with the census** (`proof/known-defects.json`,
  `proof/fixed-defects.json`, `proof/walk-stops.json`, `proof/controls/`): the counts of §2.1, the
  artifacts by reader on each declaration (§3.2), and the stops by declaration (§2.2).
- **Reads of the lane** at `e9e6cd93`: `proof/formplayer/walk.py`, `proof/observe/served.py`,
  `proof/observe/sessions.py`, `proof/observe/proof4.py`, `proof/lane/readers.py`,
  `proof/webapps/hq.py`, `proof/checks/corpus.py`, `controls.py`, `configurations.py`,
  `sensitivity.py`, `cases.py`, `intent.py`, `proof1.py`, `proof3.py`, `proof5.py`,
  `manifest_value_classes.py::list_first_with_web_apps`, `registers.py`, `proof/corpus/publish.ts`,
  `emitCorpus.ts`, `entryWriter.ts`, `inputs.ts`, `editKinds.ts`, `proof/targeted/build.ts`,
  `searchApps.ts`, `datetimeOrdering.ts`, `proof/native/families.py`, and the package tests named.
- **Reads at the pins**: commcare-hq `corehq/apps/cloudcare/views.py::FormplayerMain`,
  `PreviewAppView`, `session_endpoint`; `cloudcare/utils.py::get_web_apps_available_to_user`;
  `accounting/decorators.py::requires_privilege_for_commcare_user`,
  `requires_privilege_with_fallback`; `app_manager/views/apps.py` (`should_edit("cloudcare_enabled")`);
  `app_manager/models/applications.py::_create_app_from_doc`; formplayer
  `api/json/JsonActionUtils.java::getAnswerData`,
  `services/FormDefinitionService.java::getFormDefWithCache`, `getFormDefFromSession`; commcare-core
  `org/javarosa/xpath/expr/XPathPathExpr.java::readExternal`, `writeExternal`,
  `org/javarosa/core/model/data/DateTimeData.java::cast`,
  `org/commcare/session/SessionInstanceBuilder.java::addMetadata`, `addData`, `addUserQueryData`,
  `getStringQuery`, `org/commcare/core/process/CommCareInstanceInitializer.java::setupSessionData`,
  `getCurrentDrift`.
- Nothing was run in HQ, Core, Formplayer, a browser, Docker or the lane, and no test or build ran.
