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
   - *Offered the split, else refused.* An app whose content runs on neither
     platform only because of its date-and-time questions beside something
     Android cannot run is offered step 4's split
     (`lib/doc/platformDeclaration.ts::planContentDeclaration`, with the split
     `lib/doc/datetimeSplit.ts` plans),
     declared Web Apps only, as step 4's cutover and fuzz mapping make such
     content run; the split changes the HQ app's forms at its next publish, so
     the person confirms it before the app exists, and this step's plan
     decides how the reader recognizes its result on a later read. Any other
     app whose content runs on neither platform (`contentRunsOn` gives none),
     or one whose split the person declines, is refused, with the reason
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
     that works on a case in a menu with Search, and step 5's `commtrack-off`.
     The same-type child check is not a confirmation of this list: what
     import does for it is item 10's *Confirmations* bullet. It records only
     the answers the person gives.
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
10. **What step 5 left to import.** Step 5 builds no reader, so what it
    writes reads back here, with the shapes only an imported app holds:
    - *Placements.* From step 5 each case operation, own close and query
      repeat may hold where HQ holds it (basic, Save to Case or advanced),
      and a module may hold its kind. The reader matches an imported form's
      case transactions to placements through
      `lib/commcare/hq/publishedCaseBlocks.ts::publishedCaseBlocks`, which
      step 5 builds for its cutover, and holds each; it needs no frozen
      classifier, since an imported app has no Nova emission before it. The
      retained HQ reads of step 5's migration witnesses
      (`proof/hq-reads/targeted-migration-*`) stay as the evidence it is
      proven over. The drift merge (item 4) inherits step 5's rule for a
      published deployment whose baseline is unread: its operations and
      query repeats keep the placements they hold, except a query repeat
      whose rule gives the count placement, which moves to it; a stored
      baseline whose bytes fail gunzip, the digest or the parse is first
      refreshed from CommCare HQ, as step 5's blocker `baseline-unreadable`
      requires. Ending a
      deployment, this step's lifecycle ("creating afresh after an ended
      deployment"), decides which deployments stop counting as published
      for placements, since step 5 has no ended state.
    - *Case writes.* HQ's subcase condition picker offers every repeat
      question (`case_config_utils.js::getQuestions`), where step 5 admits a
      child's condition only from the child's own repeat or from no repeat,
      since an absolute path to another repeat's question in a bind
      under this repeat reads several nodes; the reader reads the wider set
      and judges it. A preload from any other index path
      (`forms-and-case-writes/case-preload-from-any-other-index-path-host-user-a-mixed-path`,
      HELD-NEW) and a preload that is not an exact case read are this step's,
      since Nova never emits them. An advanced load's HQ `preload`
      (`forms-and-case-writes/loadupdateaction-preload-question-property`,
      HELD-NEW) reads back as the question's default only where nothing
      later in the form reads the question at load: HQ's build appends a
      load's preload setvalues after every setvalue the form holds
      (`xform.py::_create_casexml_advanced`), and step 5 writes a writer's
      starting value as its default in an advanced form as in a basic one.
      `show_product_stock` true, or a non-empty `product_program`, is
      refused (`forms-and-case-writes/show-product-stock-true-or-a-non-empty-product-program`
      stays REFUSED), since Nova always writes `false` and `""`.
    - *An advanced form's case selections.* Step 5 stores no case selection:
      an advanced form's loads (each one's type, list module, tag and index
      name) are derived from its module's parent-selection chain
      (`Module.parentCaseModuleUuid`). The reader reads an imported advanced
      form whose loads that chain gives into it, and refuses one whose
      selections the chain does not give (a load beyond the chain, or a chain
      that differs between the module's forms), naming the form and the
      load, because the stored selections that would hold it are step 7's
      (group 6).
    - *Query repeats.* The reader recognizes the count placement (the
      wrapper Group, `nova_query_ids_<repeat>`, `nova_query_count_<repeat>`,
      `nova_query_id_<repeat>`, the guard condition, and the position and
      index nodes) as one query repeat with its placement held, and reads
      an expression's count-placement spelling back into the one authoring
      spelling both placements share (`item/@id` and the others,
      `formNodeProjection`'s `authoring` surface). Model iteration's
      admission widens from step 5's structural rule to the research's
      load-time rule for imported repeats, since step 5 has no import to
      need it.
    - *Labels and markdown.* The reader reads `plainLabel` from an item's
      `hasMarkdown`, including the one Vellum turns on when an HQ author
      types text that looks like markdown
      (`javaRosa/util.js::looksLikeMarkdown`), and a field-list appearance
      spelled in another case, which Core reads and Vellum loads as a plain
      group. This step holds a hint or validation message imported without
      a markdown form, which otherwise gains one on republish, since step 5
      always writes one and no runtime reads it; a help text imported
      without a markdown form, because republishing it adds markdown
      rendering on Android; and
      `Form.plainText` for `vellum:ignore="markdown"`
      (`questions/vellum-ignore-containing-markdown-on-h-html-vellum-s-disable`,
      HELD-NEW), which only an imported form holds.
    - *Search and menus.* The reader reads `auto_launch`, `default_search` and
      `inline_search` into `caseSearchConfig.workflow` and `formsReadSearch`
      (absent for `auto_launch` without `default_search`), and `auto_launch:
      false` in an app with `cloudcare_enabled: false` into `listFirst`; on a
      module that searches (one with search properties; HQ stores a default
      `search_config` with `auto_launch: false` on every module, which a
      module without search properties reads as no search) it refuses
      `auto_launch: false` where Web Apps is declared, with the `list-first`
      reason. It reads `case_list.show` into
      `Module.caseListMenuItem` (its label and media), and `case_list_form`
      on a host whose forms read the search, its form in a `module_filter:
      false()` module, into `caseListRegistrationForm { kind:
      "after-empty-search" }`. It reads `commcare-case-claim` cases nowhere,
      since they are case data, not app content. HQ's Case List page keeps
      every workflow shape Nova emits through a save, so the reader reads
      each as written here (`caseSearchConfig.workflow`,
      `docs/architecture/complex-apps.md`, "The search workflow").
    - *Form links.* The reader reads `form_links` in reverse order into
      `formLinks`, and an otherwise (`Form.otherwise`) from exactly two
      shapes: a `post_form_workflow_fallback` word beside some non-blank
      `xpath`, or the last element of `form_links` when its `xpath` is
      `not(x_1) and … and not(x_n)` over every other link's, then any
      held-case conjuncts. Only the last element can be the otherwise link;
      the elements before it are the destinations, read in reverse. An
      HQ-authored last link that matches the pattern reads as the otherwise,
      and the round trip keeps HQ's JSON order: Nova emits the destinations
      reversed and the otherwise link last, so `[L1: c, L2: not(c)]` reads as
      destination L1 with otherwise L2 and republishes as `[L1, L2]`. It strips a
      trailing held-case conjunct spelled as `caseById` prints it, whose
      value equals a carried datum's and whose type equals the target
      datum's case type, read through the grammar, and reads a link to the
      source form as `this-form`. It refuses, naming each, a link to a
      submenu HQ does not offer and datums on a menu (apps under
      `FORM_LINK_ADVANCED_MODE`); reads a fallback outside the offered set
      as INERT where no conditional link exists and refuses it otherwise;
      and reads an HQ fallback beside an unconditional link as the
      otherwise it is. Nova emits the held-case guard on every carried
      value of a single-case selection, no runtime evaluates it before the
      submission lands and HQ's settings save keeps it, so the reader strips
      it as written here (`formLinkCarriedCaseGuards`;
      `lib/commcare/CLAUDE.md`, "After-submit links (`form_links`)").
    - *Confirmations.* Import is the other way an app reaches a project
      space, so it asks `commtrack-off` with the predicate publish uses
      (`lib/commcare/planPrivileges.ts::commtrackReasons`) over the imported
      source. For an imported same-type basic child case it probes
      `same-type-child-links` as publish does: the project-space list reads
      `DONT_INDEX_SAME_CASETYPE`, and HQ's build drops the child's parent
      index while the flag is on, so the capability needs the flag off
      (`projectSpaceCompatibility.ts::sameTypeChildReasons`;
      `lib/commcare/CLAUDE.md`, "CommCare HQ project-space compatibility",
      and `lib/deployment/CLAUDE.md`, "Placements").

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
