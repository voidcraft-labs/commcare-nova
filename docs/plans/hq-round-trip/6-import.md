# Step 6: Import (outline)

Planned in full when step 5 exits. The design is the research's "The reader",
"What HQ's API provides", "Reference targets" and "Living with HQ after import".

## What it builds

1. **The reader.** It reads the stored app source and form JSON through HQ's
   API, and the media files the source's media map names, into one construction
   batch that passes the absolute gate, or refuses with the place and the
   reason. It derives every entity's UUID as UUIDv5 over the new app's UUID and
   the per-kind key the research's table gives, so every reading of one HQ app
   gives the same ids. It treats HQ-generated content as derived and reads each
   spelling of one meaning into Nova's one concept. It refuses an app that
   carries a translation for a runtime UI-catalog key until step 7's
   application-and-settings group holds UI string overrides: from step 2 Nova
   leaves those keys at HQ's value on publish and holds none of them. It keeps
   each imported form's `xmlns` in an optional stored slot this step adds:
   step 2 derives every `xmlns` from the form's UUID and stores none, and an
   imported form's is HQ's own.
2. **The `hq-import` birth owner**, the third owner of the one genesis writer
   (`lib/db/appGenesis.ts`). Lookup tables and media are materialized in Project
   storage atomically with sequence 1, and the HQ app is recorded in the
   deployment ledger as explicitly adopted. An import writes the ids its
   target holds that differ from Nova's derivation into
   `app_deployment_identities`, so this step gives the runtime role the write
   privilege on that table: its rows are the ones step 2's cutover wrote,
   nothing in the app writes them now, and the runtime role can only read it.
3. **Referenced and adopted project-space data.** A table or location an app
   only reads is recorded as referenced in its project space and never written
   there; adoption belongs to a Project table (or the app's location) and a
   target together. Each publish reads referenced data first.
4. **Drift merging.** Where step 2's drift check stops a publish, Nova also
   offers to bring HQ's changes in as ordinary mutations on the current
   document, matching entities by external identity, with conflicts shown.
5. **Entry points.** Import from the builder and over MCP, each confirming the
   platform declaration before the app exists.
6. **Grammar widenings.** Every `widen:` change a HELD row of the manifest names
   that no earlier step builds.
7. **Feature-matrix apps.** At least one HQ app per manifest entry, built through
   HQ's own models, plus generated combinations. This step builds them,
   because the reader is the first consumer of HQ-authored apps; the proof
   lane's corpus holds none before it.
8. **What step 3 left to import.** Each is a shape only an imported app holds,
   so no step-3 surface authors it:
   - *Project-timezone days.* HQ compares a date with `date_opened`,
     `closed_on` or `last_modified` as the project's day
     (`case_search/xpath_functions/comparison.py::_create_system_datetime_query`,
     `adjust_input_date_by_timezone`, `Domain.default_timezone`). No route an
     API key opens returns a project space's timezone, so no step-3 surface can
     author it with a meaning Preview evaluates as HQ does; Nova's search keeps
     the worker's day for `today()` and the UTC day for a date coerced to a
     date and time. This step decides how an imported comparison of that shape
     is held and how Preview evaluates it;
     `case-search/date-only-comparison-on-date-opened-closed-on-last-modified`
     stays HELD-NEW until then.
   - *Several `_xpath_query` rows.* HQ ANDs every row
     (`case_search/utils.py::_apply_filter`), so one row or several find the
     same cases, and Nova's own searches have no row identity to keep. An
     imported list of rows, each a typed default filter emitted as its own row,
     needs a slot that holds a list, which this step adds with where an
     imported row lives (a row may read what no device holds, such as
     `closed_on`, so it is not the case list filter).
     `case-search/several-xpath-query-rows` stays HELD-NEW until then.
   - *Arbitrary `<output value>` expressions in prose, and prose holding
     `instance('…')`.* Prose keeps its stored shape in step 3: its four
     reference part kinds hold identity (`field-ref`, `case-ref`,
     `user-property-ref` and the external `user-ref`, `lib/domain/prose.ts`),
     and changing the shape would re-fingerprint every translation. HQ's form
     builder admits any expression in an `<output value>`, and HQ's
     `add_missing_instances` scans the whole rendered XForm, labels included
     (`xform.py::XForm.add_missing_instances`,
     `post_process/instances.py::get_instance_names`), so a label whose text
     holds `instance('x')` makes HQ add or refuse an instance. Both are about
     which text in a form's prose CommCare reads as XPath, and only an imported
     app holds either; this step decides how an imported label's output
     expressions and its `instance(…)` text are stored and printed.
   - *HQ's escape hatches, which Nova holds and does not author.* HQ's own
     editors offer a list known only at run time (`unwrap-list('<json>')`),
     `casedb`, lookup-row and location reads inside a record CSQL value other
     than the chosen case's property, and a function call in a record slot.
     Nova's authoring has its own arms for what a person builds (a fixed list
     is `in`; a calculated column has its arms), so it does not reproduce an
     escape hatch because HQ has one. The union holds `value-list` and those
     reads, and the checker, the emitter, Preview's fold and Postgres handle
     them, natively proven, so the reader reads `unwrap-list` into `value-list`
     and each read into its arm, and `case-search/unwrap-list` and
     `case-search/runtime-values-read-from-casedb-or-session-datums` are HELD
     from step 3. `call` is a form-logic arm in step 3; this step admits it in
     record slots for import and owns compiling to Postgres the functions an
     imported calculated column uses (`substr`, `round`, `int`, `join`,
     `lower-case` and the others HQ's calculated columns reach for), since only
     an imported column needs one and Postgres compiles none of `call`'s
     functions in step 3.
   - *The lowered date-and-time comparison.* From step 3 Nova writes a
     comparison of two dates and times inline as zone-free instant arithmetic
     (`lib/commcare/xpath/wire/instant.ts`), in the form and in its Vellum
     shadow, so HQ's form builder shows the lowered formula and keeps it on
     save. The reader recognises the shape and reads it back as the comparison
     the author wrote: the template with one operand subtree `T` repeated,
     carrying the constants `719468`, `146097`, `'Zz+-'` and `'||||'`; `T` is the
     operand, or `format-date(coalesce(x, ''), '%Y-%m-%dT%H:%M:%S.%3%Z')`
     around a typed operand `x`, or `concat(<date>, 'T00:00:00Z')` around a
     coerced date (under `if(x = '', '', …)` inside a `coalesce`), or
     `if(string-length(x) = 10, concat(x, 'T00:00:00Z'), x)` around coerced
     text, or an `if` chain of such texts for a branching operand, whose
     literal branches are each literal's own date, clock and offset
     (`instantOperand.ts::literalInstantText`, `…Z` or `…±HH:MM`); an integer
     opposite a lowered operand is a folded literal, read back as its `…Z`
     spelling (a fold whose UTC moment is past 9999, as
     `9999-12-31T23:59:59-05:00`'s is, has no four-digit `…Z` spelling and
     reads back in an offset), and
     `x * 86400000000` is a coerced day number. A comparison of a system date
     with a day-aligned operand is bare, with `date(x)` for the coerced side.
     Nothing in step 3 reads lowered text back.
9. **What step 4 left to import.** From step 4 every app declares where it
   runs (`appSettings.runsOnlyOn`: absent for Web Apps and Android, or
   `"web-apps"` or `"android"`), and a feature or a media file a declared
   platform cannot run is refused:
   - *The proposed declaration.* The reader proposes the platforms the
     content runs on (`lib/domain/platformUses.ts::contentRunsOn`, the rule of
     `lib/doc/platformDeclaration.ts::planContentDeclaration` reduced to
     platforms, which step 4 keeps for this proposal), narrowed to Android
     only where the HQ app's `cloudcare_enabled` is `false` and Android is
     among them. The person confirms it, or narrows it, before the app exists
     (item 5), and the `hq-import` birth writes the declaration confirmed, not
     the default every other birth takes (`NEW_APP_SETTINGS`, both). Where the
     confirmed declaration and HQ's setting differ, the first publish after
     import asks before changing the setting (`hq_web_apps_change`): an app
     whose content runs on Android only, a date-and-time question or `here()`
     in a case-list column among it, imports Android only though HQ holds
     `true`, and that publish asks before turning the Web App setting off. A
     CommCare Connect app is one such app, since no Connect worker can sign in
     to Web Apps (step 4's platform feature `connect-app`).
   - *Refused by declaration.* Only an app whose content runs on neither
     platform (`contentRunsOn` gives none) is refused, with the reason
     `unavailable-on-declared-platform`
     (`lib/commcare/surface/schema.ts::REFUSAL_REASON_KINDS`, unused before
     this step), naming each use with step 4's platform table
     (`lib/domain/platforms.ts::PLATFORM_FEATURES`, `platformRefusal`) and the
     next step: changing the app in CommCare HQ so one platform runs all of
     it, then importing it again.
   - *Media.* Each imported file is classified by step 4's readers
     (`lib/media/validate.ts::validateMediaBytes`, which returns its variant
     key of `lib/domain/multimedia.ts::MEDIA_FORMATS`: the H.264 profile of an
     MP4, the encoding of a WAV, and ICO, ADTS AAC, AMR, MIDI and MKV among
     them, with AVIF where step 4's run of HQ's bulk upload kept it) and stored with its `media_assets.media_format`; each
     reference is accepted only where its file plays on every confirmed
     platform (`lib/media/platformPlayback.ts::unplayableReferences`, which
     the commit kernel's media admission applies to every birth), and an SVG
     is refused (`svg-not-accepted`), since HQ cannot store one.
   - *Defect 20's confirmations.* Import asks, for the project space it adopts
     the app from, the confirmations publish asks for it
     (`lib/deployment/confirmations.ts::requiredConfirmations`): step 4's
     `form-entry-sync-off`, for an app that declares Android and holds a form
     that works on a case in a menu with Search, and step 5's CommTrack kind.
     It records only the answers the person gives.
   - *The split's joined value.* A bind-only node with no control,
     `type="xsd:dateTime"` and a calculate reads back as a Hidden Value with
     that calculate; the reader admits `xsd:dateTime` on a bind-only node
     exactly when the node writes a date-and-time property or its calculate is
     the clock-keeping date (`lib/domain/expression/datePattern.ts::isClockKeepingDate`,
     the bind rule of `lib/domain/fieldValueType.ts::fieldValueType` run
     backwards), and refuses it otherwise. So a date-and-time question step 4
     split reads back as an ordinary Hidden Value beside a date question and a
     time question, with no shape of its own. Spacing and quoting from
     js-xpath are presentation the parser discards.
   - *Guarded and `current()` reads.* A session read step 4 prints under the
     count guard reads back as the bare read: `if(count(P) > 0, P, '')` for
     `window_width` and `applanguage`, and `if(count(P) > 0, P[1], '')` over
     `P = instance('commcaresession')/session/data/stringquery` as the value
     arm `{ kind: "case-list-search-text" }`
     (`lib/commcare/xpath/wire/emptyRows.ts::guardAbsentNode`). A form read
     inside a secondary-instance row predicate that step 4 prints
     `current()/<relative path>` reads back as a field read spelled `current`.

## Cutover and migration

One cutover: each lookup table's per-app deployment records merge into one
record per Project table and project space, adopted where any app adopted it
and Nova-created otherwise.

## Contracts

The contracts table's step 6 rows: the `hq-import` birth owner, the deployment
record key for lookup tables, "no arm for matched by name", creating afresh
after an ended deployment, and "every export mode carries the data".

## Exit

Every feature-matrix app made only of held entries reads, re-exports and passes
the proof, and every other app is refused with the right reason.
