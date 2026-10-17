# Step 4: Platforms (outline)

Planned in full when step 3 exits. The design is the research's "Platforms" and
defects 11 (its second half), 18, 19 and 20.

## What it builds

1. **The platform declaration.** Web Apps, Android, or both, as a first-class
   fact of every app. Its wire form is `cloudcare_enabled`, written on every
   publish (`true` for an app that declares Web Apps, `false` otherwise). A new
   app declares both.
2. **Platform behavior per feature.** Each held feature carries, per platform,
   runs, ignored without harm, unavailable, or different, taken from the
   manifest (`lib/commcare/surface/`). The validator refuses any feature
   unavailable on a declared platform, and the builder, SA and MCP offer a
   feature only where it is available on every declared platform and show its
   stated difference where the author works.
3. **Media by platform** (defect 11, second half). A file is accepted only when
   every declared platform plays it and HQ types it as the same kind; a change
   of declaration is refused until each reference to a file the new platform
   cannot play is removed.
4. **Preview per platform.** Preview plays each declared platform, with browser
   stand-ins for device capabilities.
5. **Publish.** The `cloudcare` privilege joins the per-privilege confirmation
   for an app that declares Web Apps. Publish asks before changing a target's
   `cloudcare_enabled`. The sync-on-form-entry and CommTrack confirmations of
   defect 20 are recorded beside the privileges. The lane reproduces defect
   20's session (`targeted-sync-on-form-entry`, `proof/README.md`, "The defect
   rows"), and this step's fix removes its register entries.
6. **Defect 18.** The date-and-time question is offered only in an app that does
   not declare Web Apps. Finding 74 (`harness-findings.md`) is its harm as the
   lane's Web Apps client shows it: the client draws no widget for a date and
   time and holds "Not Supported by Web Entry" as its answer, and where it
   submits that text Formplayer refuses it, so the form can never be
   submitted: a question in a repetition a worker adds last, and the two
   questions of a survey form. It is the client's own, the same on HQ's build
   of the app, and a device has a widget for the question. Step 2 ended
   holding it as one walk stop in `proof/walk-stops.json`, Formplayer's
   `submit-refused:validation-error` on `targeted-datetime-ordering`, the
   witness of finding 56 (`proof/README.md`, "Walk stops"); the lane's second,
   on `fuzz-xform-20260930-10`, left in step 2 once that form's later repeat
   held rows. This step's exit removes the entry.
7. **Defect 19.** Inline search, multi-select case lists, entry points and the
   case list menu item carry their per-platform behavior, and Preview shows it.

8. **Reads step 3 left to the platform declaration.** Each depends on what a
   platform holds, so step 3 stores or refuses it and offers it nowhere:
   - *A search input read in an inline-search module's ordinary forms.*
     Formplayer keeps the inputs on the query step
     (`QueryScreen.updateSession`) and Android sets only the results there
     (`QueryRequestActivity`), so the read throws on Android (the inventory's
     `search-input:*` rows in inline-search forms: RUNS on Web Apps,
     UNAVAILABLE on Android). Step 3 refuses it outside the no-matches form
     (`INVALID_SEARCH_REF`), which keeps its `#search/` read. This step admits
     it where the app's declared platforms run it;
     `search-input-read-in-form-expressions-of-an-inline-search-module` and
     `search-input-results-read-in-the-search-results-detail` stay HELD-NEW
     until then.
   - *The `stringquery` and `fingerprintquery` session datums.* Each is in
     `session/data` only when an Android list step carries its last query or
     callout extra (commcare-core
     `SessionInstanceBuilder.java::addUserQueryData`, `::getStringQuery`); Web
     Apps never has it and Preview has no value. Step 3's `DatumRef` has no
     kind for them, and text naming either is an unknown datum. This step adds
     the kind for an app that declares Android, with what Preview shows for it;
     `session-data-stringquery` and `session-data-fingerprintquery` stay
     HELD-NEW until then.
   - *Authoring the session context values `drift`, `window_width` and
     `applanguage`.* Their values differ per platform. Step 3 stores and parses
     all seven context values and offers `deviceid`, `appversion`, `username`
     and `userid`, showing the other three read-only; this step offers them, in
     form logic and in a search's runtime values, with each platform's value
     and Preview's. `session-context-drift`, `-window-width`, `-applanguage`
     and
     `case-search/runtime-values-read-from-the-session-context-drift-window-width`
     stay HELD-NEW until then.

## Cutover and migration

One cutover. Each existing app is declared for the platforms its content other
than media runs on. An app whose content runs on neither is declared for Web
Apps and each of its date-and-time questions is split into a date question and
a time question joined by a datetime sibling, as the research's "Platforms"
gives it. Defect 11's removal then drops each reference to an asset a declared
platform does not play. The migration names every app and entity it changes.

## Contracts

- `contracts.md`: "Nova emits one wire flavor" is replaced by emission for the
  declared platforms.
- `lib/commcare/CLAUDE.md`: `cloudcare_enabled` becomes app content Nova writes.
- `lib/media/CLAUDE.md`: acceptance by declared platform.

## Exit

Every held feature carries its platform behavior; no app holds a feature
unavailable on a platform it declares; every platform cell that differs has a
Preview test exercising it on that platform.
