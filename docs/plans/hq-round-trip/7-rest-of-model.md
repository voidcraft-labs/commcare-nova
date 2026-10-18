# Step 7: The rest of the model (outline)

Each group below is its own step for the cutover rule, planned in full when the
group before it exits. The groups and their order are the inventory's HELD-NEW
concept list
([`inventory/README.md`](../../research/2026-09-26-hq-round-trip/inventory/README.md)),
less what steps 2 to 6 build.

## Groups, in order

1. **Cross-cutting:** `Field.appearance` (the typed appearance vocabulary with
   its per-platform readings) and `localizedMedia` (per-language media on
   labels, options and menus), with held media paths.
2. **Application and settings:** the rest of `appSettings` (step 2 creates the
   object with `showSavedForms` and `showIncompleteForms`; 21 typed slots in
   all), `androidLogos`, `caseSharing`, `menuStyle`, per-language display
   names, UI string overrides with `uiStringCatalogKeys` (step 2 leaves every
   runtime UI-catalog key at HQ's value until this group holds them), and
   `Form.autoCaptureLocation` in place of the app-level `auto_gps_capture`
   (defect 4's interim keeps HQ's value until then). Each setting Nova starts
   to own is read from each existing deployment in that group's cutover, as the
   research's "Identity" describes. With `caseSharing`, form logic reads the
   worker's case-sharing groups (`instance('groups')` and a group's fields).
   The read means the groups case sharing gives a worker, which HQ fills from
   each assigned location whose type shares cases and from every HQ group with
   case sharing on
   (`users/fixturegenerators.py::UserGroupsFixtureProvider.__call__`,
   `users/models.py::CouchUser._get_case_sharing_groups_for_locations`,
   `CommCareUser.get_case_sharing_groups`): target state Preview cannot show
   truthfully until Nova holds the setting. Step 3 refuses the read at parse
   and keeps `groups-jr-fixture-user-groups` HELD-NEW; this group adds the
   `groups` instance and its `group-field` leaf.
3. **Modules and navigation:** mirror menus, "display only forms", badges, and
   computed datum arguments on entry points.
4. **Case list and detail:** detail tabs, the case detail tile, persistent
   context, empty-list text, callouts, optimizations, tile templates and slots,
   the remaining column kinds, sort settings, and the other case-list rows. Two
   of its rows carry what step 3 found and left byte-stable, because each is
   the HQ spelling of a sort setting or column kind this group owns. *Sorting
   by a date and time:* case list sort keys over a date-and-time property sort
   the text (`lib/commcare/suite/case-list/sortKeys.ts`); HQ stores every such
   value as `…Z` (`form_processor/utils/xform.py::adjust_datetimes`), so synced
   cases sort right, while a case a device wrote before it synced carries its
   offset and can misorder. Step 3's instant lowering
   (`lib/commcare/xpath/wire/instant.ts`) can be the sort's `double` key; a
   Core run during step 3's planning evaluated it as a detail sort key. *The
   `date()` guard in generated columns:* the interval and late-flag columns
   (`lib/commcare/suite/case-list/columns.ts`) write `today() - date(x)` with
   only a blank guard, and Core's `date()` throws on text that is no date
   (`FunctionUtils.java::toDate`), which a detail shows as an invalid cell;
   this group's column kinds decide the guard.
5. **Case search:** result sort, additional case types, typed default filters,
   related-case properties, search-on-clear, prompt groups, geocoder inputs,
   and case search endpoints (the one reference to project data Nova cannot
   read). Its results instance name (`caseSearchConfig.resultsInstanceName`,
   `case-search/instance-name-without-casedb-ledgerdb-fixture-or-session-in-it`)
   is a setting Nova does not hold yet: until this group, form logic reads an
   inline search's results as `instance('results:inline')`, and from it the
   print reads the module's effective name.
6. **Forms and case management:** the rows not built in step 5, including
   computed datums, shadow forms of advanced forms, a label as a write source,
   and the writer-type joins (decimal, multi-select, text). Computed datums
   (`Form.computedDatums`) give `DatumRef` a `computed` kind (`{ kind:
   "computed"; form; datum }`) with its row in the entry's datum supplies
   (`lib/domain/entryDatumSupplies.ts`) and its id in
   `lib/commcare/formLinkProjection.ts::entryDatumIds`, so form logic reads one
   by identity, a navigation slot can read one as it reads a chosen case, and
   the advanced form's read of `supply_point_id`
   (`session-data-supply-point-id-in-an-advanced-form-whose-computed`) is held
   then.
7. **XForm:** acknowledge labels, pragma itext ids, face capture as its own
   kind, Android app callouts, image max dimension, repeat add labels,
   `Field.dataParent`, `Field.lockedInHq`, query-backed options, lookup sort
   columns beyond search prompts, a Hidden Value's default beside its calculate,
   and the remaining label forms.
8. **Media and lookup data:** field properties and multi-valued cells, row
   attributes, ownership and non-global tables, indexed fields, cell absence
   states, a referenced-only `types` table, and import-sized tables and media.
   Until this group holds the indexed-field flag, a push removes it from a
   table Nova adopts, and step 2's adoption and discard confirmations say so.
   A table's description stays outside every step: no lookup upload can carry
   one.
   Its cutover clears the baseline of each adopted table defect 5 left blocked,
   so its first push stops at the drift check and offers to bring HQ's content
   in.

## Contracts

The contracts table's step 7 rows: the hidden value's two sources (in
`lib/domain/CLAUDE.md`, `components/builder/CLAUDE.md` and
`lib/commcare/CLAUDE.md`), long-detail tiles, the form-type sentence's step 7
half, `case_sharing` and every other held setting as a key-level overlay, and
the document's external identities (language wire codes held since step 2,
media paths from group 1).

## Exit per group

Its feature-matrix apps read and pass the proof.
