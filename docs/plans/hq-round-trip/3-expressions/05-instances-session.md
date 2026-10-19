# Step 3, part 05: Typed instance references and session datums as held identity

Part of [step 3's plan](../3-expressions.md), which holds the decisions, the stack and the exit.
Part 01 fixes the union, its arms and leaves; this part fixes, for every read of something outside
the form's own answers, what identity the read holds, how it prints in each carrier, what instance
it declares, what Preview supplies for it, what the project space must serve, and which rules
refuse it. It covers the session datums (`term session-datum`, `DatumRef`), a form link's datum
names, and the instance arms `cases` (from `casedb`, and the search results an inline-search
module's forms read), `project`, `table-lookup`, `table-rows`, `locations`, `selected-cases`, with
the deferrals of `groups`, search inputs in an inline-search module's ordinary forms and the device
query datums, each with its reason. It closes with the inventory rows and manifest entries these
settle, the authoring surface of each read, and where each piece lands in the stack (§7).

Citations are `path::symbol` for Nova at `main` `5cf6e327`, and `file::symbol` for CommCare at the
pins `proof/pins.json` names: commcare-hq `d6c6e16d8ae1` (paths relative to `corehq/apps` unless
named), commcare-core `8e9ba8d908e9` (paths under `src/main/java`), formplayer `24383ac71bfb`,
commcare-android `7a5584475580`, and Vellum `01215f251c57`, the submodule HQ's pin holds. A
citation says where a behavior lives. Where an execution decides a fact, the text names it, and
"Executed during planning" at the end describes each run.

## Decisions in brief

1. **A session datum read holds what supplies the value, never its id.** `DatumRef` (part 01 §1.2)
   has five kinds in step 3: `selected-case { module }`, `new-case`, `new-child-case { caseType }`,
   `worker-record`, `tile-group-parents { module }`. `device-query` leaves step 3 for step 4 (each
   datum exists only on Android, §2.6).
2. **One projection, in two halves, says which datum supplies which `DatumRef`.** Which refs an
   entry supplies, at each point a slot evaluates, is domain knowledge:
   `lib/domain/entryDatumSupplies.ts::entryDatumSupplies` (new) computes it from the session
   structure the domain already holds and is passed into `ExpressionContext`, so the builder and
   the checker read it without reaching `lib/commcare`. The datum id each ref prints as stays in
   `lib/commcare/formLinkProjection.ts::entryDatumIds` (new), which annotates every datum
   `entrySessionDatums` gives the entry with the refs it supplies (none for a placeholder). The
   parser, the printer, the reference index and Preview read the pair; no surface re-derives a
   datum id (§1.3).
3. **`new-case` and `new-child-case` print the id the case block reads,** `newCaseIdDatumId` and
   `subcaseSessionDatumId`, because that datum's value is the id of the case the form creates, and
   under root-menu alignment it is not the form's own (renamed) datum (Executed during planning,
   the datum projection probe, shape B).
4. **A form link's datum name is a `selected-case` of the target entry,** a narrower stored shape
   than "a `DatumRef` of the target entry", because naming a target's function datum would hand its
   create an id of the source's choosing. The SA and MCP wire keeps the name string it takes today;
   reads print the derived id. Production's form links carry no manual datum, so the cutover lifts
   no name.
5. **`SESSION_DATUM_NOT_SUPPLIED` becomes a rule over identity.** Text naming an id no ref resolves
   to is refused at parse; a stored ref the entry stops supplying is refused by the checker's
   profile admission (part 03 §3.9; `rules/sessionData.ts` leaves), with a sentence per kind. Reads
   of placeholder datums and of a multi-select datum's value, which the step 2 rule admits, become
   refusals. Every datum read production holds is a `selected-case` read of `case_id`, and none
   reads a placeholder, a multi-select datum, a query datum or an unsupplied id, so the new
   refusals meet nothing stored. Decisions 1 to 5 land in pull request 5, the shape, because that
   pull request's parser resolves every read stored today.
6. **Preview supplies `session/data` in form logic,** from one entry-time map
   (`lib/preview/engine/entrySessionData.ts`, new) that also replaces the post-submit
   `sourceSessionDatums` derivation. The ids a registration form and a non-repeat child create are
   minted at entry from the entry key, and the submission creates the cases with those ids, so a
   form that reads its new case's id in Preview reads the id the case gets, as on a device. It lands
   in pull request 7, Preview, because that pull request's Preview target prints every case read
   through `session/data` (part 07 §8).
7. **Step 3's instance reads are `casedb` queries, the search results an inline-search module's
   forms read, lookup tables (form logic and form links), flat `locations`, and the batch form's
   selected cases.** Deferred, each with its reason (§2.6): `groups` to step 7, group 2 (the read
   means case-sharing groups, held only from `caseSharing`; HQ's own groups are target state
   Preview cannot show); search inputs read in an inline-search module's ordinary forms to step 4
   (a read throws on Android); the `device-query` datum kind to step 4 (Android only). This plan's
   own pull request writes each deferral into the receiving step's outline file.
8. **Every instance declaration derives from the typed tree,** one table from arm to `(id, src)`
   per target (§2.1), and HQ's own factories agree with each. A declared fixture is one the publish
   pushes (lookup tables) or the person confirms is served (the flat location list), so no Nova
   form declares a fixture the project space does not serve. A form link's condition and datum
   values may read flat locations, so the suite gains a `locations` declaration and the lane gains
   the `hierarchical_locations` value-class reader (§2.4).
9. **Lookup reads in form logic are reference edges like every other carrier:** four new
   extractors in `lib/doc/lookupReferences.ts::PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS`, so the
   rows-free validation, the publish push, the `.ccz` fixtures, the plan feature, the table and
   column governance and the Project move rule all follow with no code of their own.
   **Implementation correction, 2026-10-19:** no extractor is added. The registry already makes one
   extractor per expression slot of the field, form and module reference-slot registries, keyed by
   slot name, so form logic, Connect, `form_link_condition` and `form_link_datum_xpath` were
   extracted before pull request 9; four more would count each occurrence twice, and a second
   `form_link_condition` throws "Duplicate lookup reference registry slot". Pull request 9 holds the
   edges with tests instead (§2.3's correction).
10. **Manifest:** seven entries flip from HELD-NEW to HELD in step 3, six in pull request 9 (the
    results read among them) and the navigation-slot datum read in pull request 10; every other
    entry this part touches stays HELD-NEW, named with the step that owns it (§3).
    **Implementation correction, 2026-10-19:** pull request 9 flips eight: the six of §3 and
    `jr-itext-id` and `jr-choice-name-value-path-on-a-static-choice-select`, which follow
    `targeted-text-reads` (part 10's file list already named them), so step 3 flips nine.
11. **A form of an inline-search module reads the cases its search found** (§2.8):
    `cases { source: "search-results" }` prints `instance('results:inline')/results/case[not(commcare_is_related_case = true())][…]`,
    always excluding the related cases HQ appends, so its row type is the searched case type. It is
    admitted where the evaluating entry carries the inline query datum (`entryDatumSupplies`'s
    `searchResults`, §1.3), in field and Connect slots and in a link's `condition` and `datums[].xpath`; elsewhere
    `SEARCH_RESULTS_NOT_SUPPLIED`, which the checker's profile admission raises (part 03 §1.4).
    Reads whose answer depends on HQ's order (a positional step, `position()`, `join`) are refused,
    since HQ's order is its relevance score, and so is a `@case_type` the search cannot return;
    both are `SEARCH_RESULTS_READ_INVALID` (part 03 §1.4). A row's `date_opened` is the UTC day, so
    part 03's `day-only-on-device` applies to it (part 04 §3.4).
12. **Preview supplies the whole set the search returned, capped as HQ caps it.** At form activation
    the engine loads the completed search's open matches of the module's case type through the
    unpaged read Results already has, up to 500 (`case_search/const.py::CASE_SEARCH_MAX_RESULTS`),
    builds HQ's `<results>` shape, and keeps it for the entry; a search that matched more says so
    on the form. The set is HQ's population: the Project's open cases of that type with the
    module's owner exclusion and filters, never the device's restore scope (part 07 §3.5).
13. **A `cases` query has a row type wherever it reads a custom property:** a `@case_type` literal,
    else a `@case_id` compared with a value whose case type is known, else the one case type of
    the effective catalog that declares the property, stored; with none or several,
    `case-query-untyped`. Most of production's `casedb` queries are typed by a literal or by a
    `@case_id`. Those with neither are, by part 09's probe, standard reads that need no type, custom
    reads that bind to one type, reads several types declare (the expected blockers) and reads in
    queries typed by `@case_id` from a known source after all (declarations, §2.2); the cutover's
    dry run settles them (§6.2).
14. **A query used as one value is admitted:** `many-values` refuses only a structural plurality
    (a repeat read from outside the repeat), so a `cases`, `table-rows` or search-results read used
    as one value commits and Core throws at run time on more than one row, as it does today. A
    several-case form's selected cases used as one value are refused (`XPATH_MANY_VALUES`): the
    module selects several cases by declaration, as a repeat holds several rows (§2.5).
15. **The case chosen in an earlier menu is readable in three record slots from pull request 10,**
    CSQL: a form's display condition, a case list's filter, and an advanced search input's
    predicate, each evaluated after that menu's datum is supplied (part 01 §4, "Chosen case").
    Only `selected-case` is admitted there, and the entry-supply rule checks each read against the
    datums supplied at the point the slot evaluates (§1.3, "Evaluation points"), so a list reads
    only the cases chosen before it, held at one datum id in every entry the list runs in, and a
    form's display condition only what its menu follows.
    Nothing a later step owns is needed: `DatumRef` and `entryDatumSupplies` land in pull request
    5, and Preview's `entrySessionData` already serves the Search screen (§1.8).

---

## 1. Session datums

### 1.1 What Nova derives today

`lib/commcare/formLinkProjection.ts::entrySessionDatums` is the one projection of an entry's
datums, which the compiler, the XForm emitter, the form links, the post-submit frames, the
validator and Preview read (`lib/commcare/CLAUDE.md`, "Ordinary nested menus"). It composes:

- `selectableDatums` (private): for a case-loading form (`CASE_LOADING_FORM_TYPES`), the
  parent-select chain from `Module.parentCaseModuleUuid` (`parentSelectChain`) plus the module
  itself; a multi-select module's datum is `('parent_' × remaining) + 'selected_cases'`, the own
  scalar one `case_id`, a parent's `('parent_' × remaining) + 'id'`. Each datum's source module is
  recorded in `ctx.selectionSourceModules`.
- `lib/commcare/session.ts::deriveSessionDatums`: then `newCaseIdDatumId(caseType)`
  (`case_id_new_<type>_0`) for an active `open_case`; one
  `lib/commcare/subcaseWire.ts::subcaseSessionDatumId` (`case_id_new_<type>_<index>`, the index
  `+ 1` when the form opens a case) per non-repeat subcase, the index counting repeat subcases too;
  `USERCASE_DATUM_ID` (`usercase_id`, `lib/commcare/usercaseWire.ts`) when `usercase_update` is
  active; and `<case datum>_parent_ids` for a grouped tile.
- `alignWithRootMenu` (private): a child menu's datums meet its root's first form's datums; a
  colliding id is renamed `<id>_<caseType>`, a same-type selection at the same position takes the
  root's id, and every non-selection root datum is copied in (`ctx.fromParentModuleDatums`).
- `withInlineSearchQueries` (private): a search-first module's `<query>` datum, which puts nothing
  in `session/data` (`SessionInstanceBuilder.java::addDatums` adds entity-selection and computed
  steps only).

`entrySelectionDatumSources` maps each selection datum to its source module;
`lib/commcare/previousTaskProjection.ts` reads the same frames for `previous` without wire names.

Today a session datum is read only as text: an XPath text run holding
`instance('commcaresession')/session/data/<id>` (`lib/domain/xpath/ast.ts`, text parts), which
`lib/commcare/validator/rules/sessionData.ts::sessionDatumNotSupplied` checks against the set of
ids `entrySessionDatums` gives the entry, read through
`lib/commcare/validator/bindingResolutionOracle.ts::sessionDataAccessInXPath`. A form link's
`datums[].name` is a string (`lib/domain/forms.ts::formLinkDatumSchema`) matched to target datum
ids by `matchFrameToManual`.

Executed during planning (the datum projection probe, "Executed during planning"), the projection
gives:

| Shape | Entry datums |
|---|---|
| A. flat registration of `household` writing a `member` outside and inside a repeat | `case_id_new_household_0`, `case_id_new_member_1`; the repeat child gets none |
| B. child menu of the same type, root's first form a registration | the child's registration: `case_id_new_household_0` (copied from the root), `case_id_new_household_0_household` (its own, renamed); its follow-up: `case_id_new_household_0` (copied), `case_id` |
| C. parent-select `household` → `member` | `parent_id` (source Households), `case_id` (source Members) |

In B the child registration's case block reads `case_id_new_household_0` (`newCaseIdDatumId`), the
datum copied from the root, so the case the form creates takes that datum's value and the form's
own renamed datum names no case. In B's follow-up the copied datum names no case either.

### 1.2 HQ's naming at the pin

| Rule | Source |
|---|---|
| own selection `case_id`, multi-select `selected_cases`; a parent `('parent_' * i or 'case_') + 'id'` with `i` counting from 1, a multi-select parent `('parent_' * i) + 'selected_cases'`, an "other relation" parent of the same type `case_id_<type>` | `app_manager/suite_xml/utils.py::get_select_chain_with_sessions` |
| new case `case_id_new_<module type>_0`; subcase `case_id_new_<type>_<index>`, index its position in `actions.subcases`, `+ 1` when `open_case` is active | `app_manager/models/forms.py::Form.session_var_for_action` |
| one `uuid()` datum per active open action and per subcase without `repeat_context` | `app_manager/suite_xml/sections/entries.py::EntriesHelper.get_new_case_id_datums_meta` |
| `usercase_id` = `UsercaseXPath().case()/@case_id` when the form's actions use the usercase; `<case datum>_parent_ids` = `join(' ', distinct-values(instance('casedb')/casedb/case[<predicate>]/index/<identifier>))` for grouped tiles, the case datum being the selection chain's last | `entries.py::EntriesHelper.get_extra_case_id_datums`, `::get_case_datums_basic_module`; `app_manager/const.py::USERCASE_ID` |
| child entries: a datum colliding with the root's first form's is renamed `<id>_<case_type>`; every root datum that needs no selection is carried `from_parent`; a same-case selection at the same position takes the root's id | `entries.py::EntriesHelper.add_parent_datums` |
| a manual link datum names any target frame element by id; an unnamed selection raises | `app_manager/suite_xml/post_process/workflow.py::_get_datums_matched_to_manual_values` |
| `session/data` holds each entity-selection and computed step's value, a multi-select step's being its stored instance's id, plus `stringquery` and `fingerprintquery` only when a list step carries Android's last query or callout extra | `org/commcare/session/SessionInstanceBuilder.java::addDatums`, `::addUserQueryData`, `::getStringQuery`, `::getCalloutSearchResultCount` |

Nova's projection mirrors each row it emits (`deriveSessionDatums` docblock;
`alignWithRootMenu` docblock), and Nova never emits the "other relation" arm because
`parentCaseModuleUuid` must name the direct parent type (`lib/domain/CLAUDE.md`, "Deep-link entry
points").

### 1.3 The `DatumRef` kinds and their resolution

The closed set Nova can supply in step 3, each with the datum that supplies it and the print rule:

| `DatumRef` | Supplied by | Prints | `caseIdOf` (part 01 §3.1) |
|---|---|---|---|
| `selected-case { module }` | a scalar selection datum whose source module is `module` (`entrySelectionDatumSources`), or, in a child entry, the root selection a child datum was aligned to | that datum's id after alignment: `case_id`, `parent_id`, `parent_parent_id`, `case_id_<type>`; in HQ JSON's `case_details.short.filter` alone, its id before alignment (`chainId`, below, and "One id per slot") | `module`'s case type |
| `new-case` | the owning registration form's create, present when `open_case` is active | `newCaseIdDatumId(moduleCaseType)` | the module's case type |
| `new-child-case { caseType }` | the form's non-repeat child bucket of that type (`lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory`, whose buckets key a child by case type and nearest repeat, so at most one per type sits in no repeat) | `subcaseSessionDatumId(subcase, index, opensCase)` over the expanded `FormActions` | `caseType` |
| `worker-record` | `usercase_id`, present when the form's `usercase_update` is active | `usercase_id` | `commcare-user` (`lib/domain/usercase.ts::USERCASE_CASE_TYPE`) |
| `tile-group-parents { module }` | the grouped-tile companion of that module's case datum, in its own entries or carried into a child entry | `<case datum id>_parent_ids` | none: the value is a space-separated list of ids (HQ's `join(' ', distinct-values(…))`, §1.2) |

`caseIdOf` is what types a `cases` row compared by `@case_id` with a datum read (part 01 §1.3, rule
2). Part 01 §3.2 gives it for every kind from this table. Production holds such queries, all typed
by a `selected-case` datum.

Step 7, group 6 (computed datums, `Form.computedDatums`) adds a kind
`{ kind: "computed"; form: Uuid; datum: Uuid }` and its place in both halves; the supply-point
entry of §3 flips then.

**Resolution: the domain half.** New `lib/domain/entryDatumSupplies.ts::entryDatumSupplies(doc,
point): EntryDatumSupplies`, with `EntryDatumSupplies = { refs: readonly { ref: DatumRef; scalar:
boolean }[]; searchResults?: { module: Uuid }; differs?: readonly DatumRef[] }`, is the set of refs
supplied at one evaluation point (`differs` only at the `case-list` and `search` points, below), from the structure `lib/domain` already holds. It derives the selection chain itself, walking
`Module.parentCaseModuleUuid` from the module with a guard against a revisited module (the walk
`lib/commcare`'s private `formLinkProjection.ts::parentSelectChain` makes, which `lib/domain` cannot
import), and every input it reads is an export of `lib/domain`: the parent-select chain
(`Module.parentCaseModuleUuid`), the case-loading form types (`lib/domain/forms.ts::CASE_LOADING_FORM_TYPES`),
a module's several-case selection (`caseListConfig.selection`), the menu tree
(`lib/domain/moduleHierarchy.ts::moduleParent`, `doc.formOrder` for a root's first form), the
match of a child selection to a root one (`lib/domain/modules.ts::caseSelectionCanFlowBetweenModules`
and the two case types), a form's case writes (`lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory`:
the registration's primary create, a non-repeat child bucket, the `usercase` bucket, read from the
inventory's buckets), tile grouping
(`caseListConfig.tile.grouping`), Search first (`lib/domain/modules.ts::moduleOpensOnSearch`) and
`lib/domain/forms.ts::isCaseFirstModule`. Executed during planning, by reading
`formLinkProjection.ts::selectableDatums`, `alignWithRootMenu`, `withInlineSearchQueries`,
`session.ts::deriveSessionDatums` and `formActions.ts::buildFormActions`: every input of those
functions that decides whether a datum exists, what it selects and whether it is aligned is one of
these domain reads; what only `lib/commcare` holds is the id (the `parent_` prefixes, the
`case_id_new_<type>_<index>` spellings, the collision rename) and the datum's wire detail
(nodesets, functions, details). So the set needs no wire vocabulary. `alignWithRootMenu`'s match
(a root selection taken by the next child selection of a type that can flow between the two
modules) moves into the domain half, which exports it, and `alignWithRootMenu` takes its matched
pairs from there and applies the rename, so the match exists once.

The set, per kind:

- `selected-case { module }` for every module of a case-loading form's selection chain (the
  parent-select chain and the module itself), `scalar: false` for a several-case module; and, in a
  child menu, for the root module whose selection a child selection is aligned to, the same datum
  listing both refs.
- `new-case` for a registration form whose module has a case type (its `open_case` is always
  active, `buildFormActions`).
- `new-child-case { T }` for each non-repeat child bucket of type `T`.
- `worker-record` when the form's inventory holds a `usercase` bucket.
- `tile-group-parents { module }` when the module (or, in a child entry, the root it is aligned
  to) groups its tiles.
- `searchResults: { module }` when the evaluating entry carries a search-first module's inline
  query (§2.8).

**Resolution: the id half.** New `lib/commcare/formLinkProjection.ts::entryDatumIds(doc, ctx,
moduleUuid, formUuid): readonly EntryDatumId[]`, with `EntryDatumId = { id: string; refs: readonly
DatumRef[]; scalar: boolean; searchResults?: { module: Uuid } }`, one row per datum
`entrySessionDatums` returns, in order. `searchResults` is set on the inline query datum's row only
(the datum `withInlineSearchQueries` inserts, whose `query.storageInstance` is `results:inline`),
naming the search-first module whose search it runs (§2.8). A selection datum's row also carries
`chainId: string`, the id `selectableDatums` gave it (`parent_id`, `case_id`, …) before
`alignWithRootMenu` renamed it, recorded in a new `ctx.chainDatumIds: WeakMap<SessionDatum,
string>` when the datum is made; it equals `id` in an entry with no root alignment. A ref resolves
in an entry when some row lists it; it prints that row's `id`, but in HQ JSON's case list filter its
`chainId` ("One id per slot"). `refs[0]` is the canonical ref the parser stores for text
naming that id. The rules:

- A selection datum lists `selected-case` of its source module, then, where `alignWithRootMenu`
  aligned it to a root datum, `selected-case` of that root datum's source module (the pair
  `alignWithRootMenu` takes from the domain half's match, recorded in a new
  `ctx.alignedSelectionSources: WeakMap<SessionDatum, Uuid>`). A multi-select datum
  (`maxSelectValue` set) lists the same ref with `scalar: false`: its session value is a stored
  instance's id, so the ref resolves there only for `selected-cases` (§2.5), never for
  `session-datum`.
- A `uuid()` datum lists `new-case` exactly when its id equals `newCaseIdDatumId(moduleCaseType)` on
  a registration form whose `open_case` is active, and `new-child-case { T }` exactly when its id
  equals the id `subcaseSessionDatumId` gives the non-repeat subcase of type `T`. By the probe's
  shape B the id the case block reads is either the form's own datum or the root datum aligned over
  it, and in both cases that datum's value is the created case's id; the form's renamed own datum
  (`case_id_new_household_0_household`) lists nothing.
- `usercase_id` lists `worker-record`; `<id>_parent_ids` lists `tile-group-parents` of the module
  whose grouping produced it (the owning module, or the root for a carried one).
- Every other datum is a **placeholder** and lists nothing: a root datum copied into a child entry
  that names no case of this form (shape B's follow-up), a renamed own create datum, and the
  scalar `uuid()` child datum HQ emits on a multi-select form, which Nova's batch XForm does not
  consume (`deriveSessionDatums`, the comment on HQ's multi-select parity datum).

Forms with no menu supply nothing. A survey supplies no selected or newly created primary case, but supplies the worker-record datum when it saves worker information, and retains copied root computed datums that have a live worker-record or tile-group identity. `entryDatumIds` is memoised per context like
`entrySessionDatums`, and `entryDatumSupplies` per document. The two halves agree by test: for every
entry of the corpus and of the fuzz documents, the refs the id half's rows list are exactly the
domain half's set at the form's own point (§5).

**Evaluation points.** A point is where a slot evaluates, and the set is what the session holds
there:

| Point | Slots | The set |
|---|---|---|
| `{ kind: "form", module, form }` | form logic and Connect slots; a form link's `condition` and `datums[].xpath` (the source form's point, part 01 §4) | every ref above for the form's entry |
| `{ kind: "case-list", module }` (pull request 10) | the module's `caseListConfig.filter`, on the device, in Preview's Postgres read and in its CSQL runtime segments | the `selected-case` refs every entry that reaches the module's list supplies before the module's own selection datum (its own entries, and those of a module that selects through it), at one datum id across them; a ref each supplies at different ids is in `differs` (below) |
| `{ kind: "search", module }` (pull request 10) | an advanced search input's `predicate` in its CSQL runtime segments (part 06 §3.9) | the same as the module's `case-list` point: the query step runs after the selections before the module's own and before its own (§1.8) |
| `{ kind: "form-menu", module, form }` (pull request 10) | the form's `displayCondition` | in a case-first module (`isCaseFirstModule`) the `selected-case` refs of the form's entry through the module's own selection; in a forms-first module none, since the menu shows before any case is chosen, which is today's display-condition rule (`lib/domain/CLAUDE.md`, "A form may read a direct self property … only when `isCaseFirstModule` proves a selected case"). In a search-first module the menu shows before the search's claim posts (part 07 §3.5), so a property of a searched case the worker's restore does not hold reads blank there, on a device and in Preview; the read stays admitted, as today's `#case/` read of the selected case behaves the same |

**One id per slot.** A record slot is one stored text on HQ's side: HQ JSON holds one
`case_details.short.filter` per module, which HQ's build writes into every entry the module's list
runs in, the entries of a module that selects through it included
(`app_manager/suite_xml/sections/entries.py::EntriesHelper.get_filter_xpath`, which
`EntriesHelper.get_datum_meta_module` applies to each select-chain datum's own module), and Nova's
own suite renders that list's nodeset into the same entries (`formLinkProjection.ts::selectableDatums`,
the `caseListFilter` of each chain module). A chosen datum's id is the chain position counted from the end
(`parent_id`, `parent_parent_id`, §1.2), so it differs between the module's own entries and the
entries of a module that selects through it: with Villages → Households → Members, the village is
`parent_id` where Households' list runs as its own and `parent_parent_id` where it runs as Members'
parent choice. So the `case-list` and `search` points list the refs every entry that reaches the
list supplies before the module's own selection datum at one id, and put a ref each of them
supplies at different ids in `differs`. The domain half decides this without spelling an id: two
entries print a `selected-case` ref at one id exactly when it sits at the same place counted back
from the entry's last selection and under the same root alignment, the two facts the id half spells
the `parent_` prefixes and the alignment rename from, and the agreement case of §5 holds the halves
to it. A read the point's `refs` lists is admitted; one `differs` lists is refused with the reason
`differs`; any other is refused with `not-before`, because the menu's case is not chosen before the
module's case list step (§1.6; part 06 §3.9). With Villages → Households → Members, a Households
filter reading the chosen village is `differs`. A module no other module selects through runs its
list only in its own entries, which share its chain and its alignment, and a form's display
condition sits in one menu, so neither meets `differs`.

**The case list filter's two prints.** HQ's build writes `case_details.short.filter` into each chain
datum's nodeset before it aligns a child entry with its root menu, then renames session variables
inside those nodesets: `suite_xml/sections/entries.py::EntriesHelper.get_case_datums_basic_module`
builds the chain with `get_datum_meta_module(module, use_filter=True)` (`get_filter_xpath` for each
chain datum's own module) and passes it to `add_parent_datums`, whose `set_id` calls `_update_refs`,
`xpath.replace(session_var(old_id), session_var(new_id))` over every datum's `nodeset` and `function`.
So the HQ JSON filter names a chosen case by its id before alignment. With Households a root,
case-first module and Members its child with parent-select Households (the shape
`CASE_PARENT_SELECTION_CONFLICT` recommends), a Members filter reading the chosen household holds
`parent_id`: HQ first renames the colliding own datum `case_id` to `case_id_member` (and every
`session/data/case_id` with it), then the household's `parent_id` to the root's `case_id`, which is
what the local suite prints after `alignWithRootMenu`. Written with the aligned `case_id`, HQ's first
rename would turn the read into `case_id_member`, the datum being chosen at that step, which holds no
value. Everything else takes the aligned id: the suite's nodeset (`selectableDatums` re-renders it
after alignment, `refreshDatumReferences`), the filter's CSQL copy in
`search_config.default_properties`, which HQ copies into the remote request's `<data ref>` verbatim
(`post_process/remote_requests.py::RemoteRequestFactory._remote_request_query_datums`) and into the
inline query datum it adds after alignment (`entries.py::EntriesHelper.configure_entry_module_form`,
`add_remote_query_datums` after `get_case_datums_basic_module`), an advanced search input's
predicate, and `form_filter`, which HQ never rewrites. Both prints are one id across the list's
entries wherever the ref is not `differs`, because both follow from the place counted back from the
entry's last selection and the root alignment. `targeted-csql-composition` holds an aligned child's
list filter reading its chosen parent, so proof 3 compares HQ's renamed nodeset with the local
suite's (part 08 §4.5).

A module's own `displayCondition` has no point: a menu shows before any datum of its entries is
supplied, so it admits no `session-datum` (part 01 §4). Only `selected-case` is admitted at the
three record points; the other kinds name a form's own creates, the worker's record and a tile
group's parents, which no list, search or menu reads.

### 1.4 Printing a `DatumRef` in every carrier

A ref prints as `instance('commcaresession')/session/data/<id>` (part 01 §2.4) through the entry
that evaluates its carrier:

| Carrier (part 01 §4) | Entry the ref resolves against | Wire |
|---|---|---|
| field logic (`relevant`, `validate`, `calculate`, `default_value`, `required`, `repeat_count`, `data_source.ids_query`) | the form's own entry (`owningModuleOf`, `entryDatumSupplies`) | XForm bind / setvalue; `commcaresession` declared on the form |
| Connect `user_score`, `entity_id`, `entity_name` | the form's own entry | XForm; declared on the form |
| form link `condition`, `datums[].xpath` | the **source** form's entry: Core evaluates both in the source session after the form closes (`lib/commcare/CLAUDE.md`, "Session scope") | local `<create if>` / `<datum value>`; HQ `form_links[].xpath` / `datums[].xpath`; `commcaresession` declared on the source entry by `deriveEntryDefinition` |
| form link `datums[].name` | the **target** frame (`targetFrameChildren`) | the `<datum id>` / HQ `datums[].name` (§1.5) |
| from pull request 10: a case list's `filter`, an advanced search input's `predicate`, a form's `displayCondition` (`selected-case` only) | the slot's evaluation point (§1.3): the module's list, its query step, the menu that lists the form; each prints the one id every entry the slot runs in gives that datum (§1.3, "One id per slot") | the suite datum `nodeset` filter and HQ `case_details.short.filter`, the latter with the id before root alignment (§1.3, "The case list filter's two prints"); the remote request's runtime `<data ref>` and HQ `default_properties` (part 06 §3.9); the command's `relevant` and HQ `form_filter`; `commcaresession` declared where the tree reads it (part 04 §2.4) |

The print context (`lib/domain/expression/print.ts`, part 01 §6.1) takes a `datumId(ref) => string
| undefined` resolver, built by `lib/commcare` from `entryDatumIds` and handed down, because
`lib/domain` cannot import `lib/commcare` (part 01 §3.5). Builder and tool reads print form logic
with the same resolver, so the text a person reads is the id the wire carries. An unresolved ref
prints the repair marker and the gate has refused the batch that caused it (§1.6). The record
dialect prints no datum id at all: from pull request 10 it spells the chosen case in Nova's words,
`chosen-case('<menu name>')` and `chosen-case-property('<menu name>', '<property>')`, the menu
resolved to its module through `AuthoringScope` (part 02 §2.2), and gains no `datum('…')`
spelling.

### 1.5 A form link's datum names

From step 3 `formLinkDatumSchema` is `{ name: FormLinkDatumName; xpath: Expression }` with
`FormLinkDatumName = { kind: "selected-case"; module: Uuid }`, one shape for one meaning: a manual
datum fills a selection the target needs. HQ lets a name override a function datum too
(`_get_datums_matched_to_manual_values` matches any frame element id), which would hand the
target's create a case id of the source's choosing; Nova refuses that from step 3. Production's
form links carry a condition and no manual datum, so no stored name names a function datum or a
query and the cutover lifts none.

- Resolution and print: the target frame's datum whose `entryDatumIds` row lists the ref;
  `matchFrameToManual` matches on the printed id, so its HQ arm is unchanged.
- `uniqueFormLinkDatumNames` compares refs, not strings. `FORM_LINK_DATUM_UNUSED` is a ref no target
  frame datum lists; `FORM_LINK_DATUMS_INCOMPLETE` is unchanged.
- **Implementation decision, 2026-10-18:** distinct refs can name one root-aligned target datum.
  A witness with parent and child selection refs passed the schema and gate, but both printed as
  `case_id`; HQ's name-keyed manual matcher silently kept the child's value. Keep semantic ref
  uniqueness, and separately refuse two assignments to one derived target with soundness
  `FORM_LINK_DATUM_TARGET_COLLISION` before projection, even if their values agree. Each alias
  remains valid on its own. This changes no stored or served input shape and stores no wire id.
- SA and MCP: `lib/agent/tools/form-links/shared.ts::datumInputSchema.name` is the `datum` family's
  position (part 01 §6.3), which lands in pull request 5 serving today's bytes: the schema keeps
  `name: string` and its description, so no served hash moves. The boundary resolves the string
  against the target frame's printed ids to the ref, and refuses a string no selection datum
  carries with "`<name>` isn't a case the destination asks for. It asks for <list of printed
  ids>." Tool reads print the derived id.
- Builder: `components/builder/form-links/CarryValuesSection.tsx` labels each row by meaning, "The
  case chosen in <module name>", with no wire id (`components/CLAUDE.md`, "Voice"; `carryValuesModel`
  compares refs).

### 1.6 The checker rule over identity

`SESSION_DATUM_NOT_SUPPLIED` keeps its code and class (soundness) and moves into the checker (part
03 §3.9 states the rule): entry supply is profile admission, which reads the set
`lib/domain/entryDatumSupplies.ts::entryDatumSupplies` gives at the slot's evaluation point (§1.3),
held in `ExpressionContext.supplies` (part 03 §1.3), for each `term session-datum` and each
`selected-cases` node of every stored `Expression` (the registry slots of part 01 §4, not text). A
ref the point's set does not hold is the finding `datum-not-supplied` → `SESSION_DATUM_NOT_SUPPLIED`, `details: { ref, slot,
carrier, reason }`. `lib/commcare/validator/rules/sessionData.ts` leaves (its walk over printed ids
has nothing left to check), and no rule file of this part replaces it. The form-logic and form-link
points land in pull request 5, the shape; the three record points and their sentences in pull
request 10, CSQL, which admits the chosen case there.
The binding-resolution oracle stays the fuzz-time proof that every emitted `session/data/<id>` is a
declared datum (`lib/commcare/__tests__/xformDocArbitrary.ts` now draws typed refs of every kind).

Text naming an id no row lists has no identity to store, so the parser refuses it
(`lib/commcare/xpath/expressionAst.ts`, the `instance('commcaresession')/session/data/<id>` shape):
a parse issue in the builder, an `AuthoringInputError` for SA and MCP. Copy:

| Case | Sentence |
|---|---|
| parse: id the entry does not carry | "This form doesn't open with a session value named "`<id>`". Its session values are `<ids>`." (or "This form doesn't open with any session values. You can read a question or a case property instead.") |
| parse: a placeholder | "`<id>` holds no case this form opens with or creates. You can read `#<type>/case_id` for the case this form opens." |
| parse: a multi-select datum | "`<id>` holds the cases chosen in <module> as a list. You can read them as `instance('<id>')/results/value`." |
| checker, `selected-case` | "`<question>` reads the case chosen in <module>, but `<form>` no longer opens with that choice, so CommCare can't open the form. You can choose the case before this form, or read a question or a case property instead." |
| checker, `new-case` | "`<question>` reads the id of the case `<form>` registers, but the form no longer registers one. You can read a question or a case property instead." |
| checker, `new-child-case` | "`<question>` reads the id of the new <type> case `<form>` creates, but the form no longer creates one outside a repeat. You can read a question instead." |
| checker, `new-child-case` on a several-case form | "`<question>` reads the id of a new <type> case, but in a form that works on several cases each chosen case gets its own, so this value names none of them. You can read a question instead." |
| checker, `worker-record` | "`<question>` reads the id of the worker's own record, but `<form>` no longer saves to it. You can read `#user/` values instead." |
| checker, `tile-group-parents` | "`<question>` reads the grouped cases' connections, but <module>'s case list no longer groups its tiles. You can group the tiles again, or read a case property instead." |
| checker, `case-list` or `search`, `not-before` (pull request 10) | "<list> reads the case chosen in <menu>, but <module> no longer opens after <menu>, so CommCare has no chosen case to read there. You can open <module> from <menu> again, or remove that read." |
| checker, `case-list` or `search`, `differs` (pull request 10) | "<list> reads the case chosen in <menu>, but <other module> also shows this list, and there CommCare keeps that choice in another place, so the read would not find that case. You can remove the read, or give <other module> its own list to choose from." |
| checker, `form-display-condition`, `not-before` (pull request 10) | "`<form>` shows only when the case chosen in <menu> matches, but its menu shows before that case is chosen. You can choose the case before this menu, or base the condition on the worker instead." |

`<list>` is "The case list of <module>" for `case-list` and "The search in <module>" for `search`
(part 06 §3.9 quotes these).

The link and Connect variants keep step 2's carrier wording ("A link from …", "A CommCare Connect
setting of …"). `details.carrier` gains `case-list`, `search` and
`form-display-condition` for the record points, and `details.reason` gains `not-before` and
`differs`.
`lib/doc/userFacingErrors.ts` picks the sentence from `details.reason` and `details.carrier`. Part 02's parse table takes the parse sentences verbatim and adds the
`placeholder-datum` code, and part 03 §3.9 uses the checker sentences.

### 1.7 Renames, moves and removals

Part 01 §5 gives the behaviour; this part adds the index keys. `lib/doc/referenceIndex.ts` indexes
each ref: `selected-case` and `tile-group-parents` under their module UUID, `new-case` and
`worker-record` under the form, `new-child-case` under `(form, caseType)`, and a link's datum name
under the module; from pull request 10 a record slot's chosen case is indexed under its menu's
module like every `selected-case`. So:

- a module removal, a parent-select change, a move out of a nested menu, a switch to several-case
  selection, or turning tile grouping off, that leaves a ref unsupplied, is refused by the rule
  naming the read; the case-selection review (`components/builder/case-list-config`, "Case
  selection") lists such reads among its blockers through the same verdict;
- removing the last field that writes a child type outside a repeat is refused while a
  `new-child-case` names it;
- from pull request 10, making a module another module's parent-select source while its list's
  filter or search reads a chosen case is refused with `differs` where the new entries hold that
  case at another id, and with `not-before` where they do not choose it before the list (§1.3, "One
  id per slot"), and adding a registration or survey form to a case-first module, which makes it forms
  first (`isCaseFirstModule`), is refused while one of its forms' display conditions reads a
  chosen case;
- a rename or a reorder that moves a derived id (root alignment, a subcase's index shifting when a
  repeat child is added before it) reprints and rewrites nothing.

### 1.8 Preview supplies the session

Today Preview's form engine has no `session/data`: `formEngine.ts` builds its instances through
`xpathInstances.ts::secondaryXPathInstances` with no `sessionData`, and its `resolveInstance` serves
only `context` and `user/data` (`searchExpressionEvaluation.ts::sessionInstancePathValue`), so a
supplied read reads blank in Preview and a value on a device. A registration form's
`#<own>/case_id`, which the wire prints as `session/data/case_id_new_<type>_0`, reads blank in
Preview for the same reason (`formEngine.ts`, `resolveHashtag`, the registration comment). Only
after-submit evaluation has datum values (`formLinkEvaluation.ts::sourceSessionDatums`).

From step 3 (this section lands in pull request 7, Preview; part 07 §8):

- **One entry-time map.** New `lib/preview/engine/entrySessionData.ts::entrySessionData(doc,
  formUuid, { appId, entryKey, selectedCases, caseDatabase, identity })` walks `entryDatumIds` in
  order and values each datum as Core does when the session reaches it: a selection from the
  menu/session case map Preview already resolves (`previewMenuCaseContext`, keyed by source module
  UUID, the bound case for the own datum); a `uuid()` datum from
  `lib/domain/entryCaseIdentity.ts::entryDatumCaseId(appId, entryKey, key)` (new, UUIDv5 under a
  fixed Nova namespace), where `key` is `"new-case"`, `"new-child-case:<type>"`, or
  `"placeholder:<id>"`; `usercase_id` and `<id>_parent_ids` by evaluating the datum's printed
  function with the Preview evaluator over the entry's casedb snapshot and the map so far. A
  multi-select datum takes no value (`selected-cases` reads the selection, §2.5).
- **The engine reads it.** `FormEngineRuntimeOptions` gains `sessionData`; `secondaryXPathInstances`
  receives it (its `sessionData` argument exists), `sessionInstancePathValue` serves
  `/session/data/<id>` from it, and the `form-case case_id` read on a registration form resolves to
  the `new-case` value. `EngineController` builds the map at `activateForm` with its `entryKey`, so
  a rebuild in the same entry keeps it and **Clear form** (a new entry key) mints anew.
- **The submission creates the cases with those ids.** The entry key already reaches the store
  in the submission's receipt claim (`lib/case-store/submission.ts::ApplySubmissionArgs.submissionReceipt`,
  `SubmissionReceiptIdentity.entryKey`). `lib/case-store/postgres/store.ts::PostgresCaseStore.applySubmission`
  only delegates; the inserts are in `lib/case-store/postgres/submissionEnvelope.ts::applyOrdinaryAction`,
  whose `registration` arm inserts the primary with `entryDatumCaseId(appId, entryKey, "new-case")`
  and each non-repeat ordinary child with `entryDatumCaseId(appId, entryKey,
  "new-child-case:<type>")`, through `SubmissionEnvelopeHost.insertCase`'s existing `caseId`
  argument; its follow-up arm inserts a one-case form's non-repeat child the same way, while a
  several-case form's children, one per chosen case, keep `uuidv7()`, since that datum names none
  of them (§1.6). Repeat children and generated case-operation creates keep `uuidv7()`, as their
  XForm calculates mint `uuid()` per iteration. A primary-key
  conflict on such an id refuses the submission with `SubmissionRejectedError` (reason
  `case-id-taken`, "This form's new case is already saved. You can open it from the case list."),
  never an upsert. An exact retry carries the same entry key, so it derives the same ids and the
  receipt replays it.
- **After submit reads the same map.** `sourceSessionDatums` is rebuilt over the entry map: the
  device's session does not change when the form closes, so a link condition reading
  `case_id_new_member_1` reads the id the child was created with, and the receipt-order matching of
  created children (`subcaseValue`) retires.
- App Tests (`lib/preview/app-tests`) and the non-writing evaluator (`engine/evaluateForm.ts`) mint
  an entry key per form session and use the same function, so their proposed submissions name the
  same ids their logic read.
- **The Search screen's session reads the same map.** A module's Search screen runs at its query
  step, so `entrySessionData` is also built for that step, holding the datums the session supplies
  before it (a parent selection, the copied root datums), and Preview's fold of part 06 §3.9's
  runtime segments reads `session/data` from it wherever the request's wire tree reads a datum.
- **The record points read the same map** (pull request 10). A case list's filter reads the
  chosen case from the map built for the list's step, holding the selections before it, in
  Preview's Postgres read and in its CSQL fold alike; an advanced search input's predicate from the
  Search screen's map above; a form's display condition from the map the module's menu holds once
  its case is chosen (`displayConditionEvaluation.ts`). Each is `entrySessionData` over the same
  rows at the slot's evaluation point (§1.3), so Preview gains no second session for them (part 07
  plans each reader).

**Implementation correction, 2026-10-19** (pull request 7):

- `entrySessionData(doc, formUuid, { appId, entryKey, boundCases, menuSelections, caseDatabase,
  identity })` returns `{ data, values, newCaseId? }`: `data` for the session instance, `values`
  with each named case's name for after-submit links, and the registration's minted id. An unsaved
  app (no `appId`) mints no ids, so its `uuid()` datums stay unvalued. A datum that names no case
  Nova creates is keyed `placeholder:<datum id>` (`entryCaseIdentity.ts::entryDatumCaseKey`).
- The rejection is the existing union's `{ kind: "new-case", reason: "case-id-taken", caseId }`
  (`lib/case-store/errors.ts`), checked by a read before the insert so it is a typed rejection
  rather than an aborted transaction. The dedicated sentence above is not written.
- `sourceSessionDatums` retires: `EngineController.entrySession` holds the map built at
  `activateForm`, and `afterSubmitSessionDatums(entry, submission, registeredCaseId)` adds the
  names the submission saved, refusing a registration whose created id differs from the minted one.
  A child created in a repeat has no datum, so a repeat bucket of the same type never shadows a
  non-repeat child's datum.
- The Search screen's map for the module's query step is left to pull request 10, where its readers
  (part 06 §3.9's runtime segments and the advanced input's chosen-case reads) land: in pull request
  7 `PreviewSearchEnvironment.sessionData` and `searchScreenXPathInstances` take it, and the running
  Search screen passes none.

---

## 2. Typed instance references

### 2.1 The instance table

Instance declarations derive from the emitted wire tree (part 04's serializer); this is the table
the serializer applies, per arm (part 01 §1.4) and target. Core dispatches by `src`: contains
`ledgerdb`, contains `casedb`, contains `fixture`, contains `session`, then starts with
`jr://instance/remote`, `jr://instance/selected-entities`, `jr://instance/search-input`, else
`ConcreteInstanceRoot.NULL` (`org/commcare/core/process/CommCareInstanceInitializer.java::generateRoot`).

| Arm | XForm `<instance>` (id, src) | Suite / HQ JSON id (form links) | HQ factory, and agreement | Preview | Project space must serve | Step 3 |
|---|---|---|---|---|---|---|
| `term session-datum`, `session-context`, `session-user` | `commcaresession`, `jr://instance/session` | same | `preset_instances` (`INSTANCE_KWARGS_BY_ID`): same src | entry map (§1.8) | nothing | authorable |
| `cases`, `project`, `prop` in a case row, `form-case` | `casedb`, `jr://instance/casedb` | same | `preset_instances`: same | device casedb snapshot (`caseDatabaseXPathInstance`) | nothing | authorable |
| `table-lookup`, `table-rows`, `table-column` | `<tag>`, `jr://fixture/item-list:<tag>` | `item-list:<tag>`, same src | XForm: Nova's declaration stands (`XForm.add_missing_instances` adds only undeclared ids, and a bare tag is an unknown id there, so Nova must declare it); suite: `generic_fixture_instances` | `lookupXPathInstances` under the XForm id; form-link evaluation with `includeFixtureAliases` | the table, pushed before the content (`lib/deployment`, `resources`) | authorable |
| `locations`, `location-field`, `location-level` | `locations`, `jr://fixture/locations` | `locations`, same, on a form link's source entry (§2.4) | XForm: Nova's declaration stands; suite: `location_fixture_instances`, which writes `jr://fixture/commtrack:locations` only under HIERARCHICAL_LOCATION_FIXTURE with `LocationFixtureConfiguration.sync_flat_fixture` off, a space the flat-list confirmation excludes | new instance from the persona's footprint (§2.4) | the `locations` plan feature and the flat location list | authorable |
| `selected-cases { module }` | `<datum id>`, `jr://instance/selected-entities/<datum id>` | (not admitted in links) | `selected_cases_instances`: same | the batch form's ordered selection (§2.5) | nothing | authorable |
| `term input` in a no-matches form | `search-input:results:inline`, `jr://instance/search-input/results:inline` | none | `search_input_instances` (`results:inline` is a valid results instance name) | `searchInputXPathInstance` from the launching search | nothing | authorable, as today |
| `groups` | none | none | (`preset_instances`: `jr://fixture/user-groups`) | none | none | deferred to step 7, group 2 (§2.6) |
| `cases { source: "search-results" }` with `project` and its row leaves | `results:inline`, `jr://instance/remote/results:inline` (`lib/commcare/session.ts::INLINE_SEARCH_RESULTS_SRC`) | same, on the source entry for a link | XForm: Nova's declaration stands; suite: `remote_instances`, which declares it because `results:inline` is a valid results instance name (`suite_xml/utils.py::is_valid_results_instance_name`) | the completed search's snapshot (§2.8) | case search, which the module already requires | authorable (§2.8) |

Sources for the table: `app_manager/suite_xml/post_process/instances.py::get_instance_factory`,
`INSTANCE_KWARGS_BY_ID`, `::preset_instances`, `::generic_fixture_instances`,
`::search_input_instances`, `::selected_cases_instances`, `::location_fixture_instances`,
`::get_all_instances_referenced_in_xpaths`, `::get_instance_names` (HQ finds ids by its own regex,
so the serializer never writes a spelling it misreads: `instance('<id>')` with single quotes and no
spaces); `app_manager/xform.py::XForm.add_missing_instances` (declared ids kept, recognised
undeclared ids added, unrecognised undeclared ids refused).

The suite column serves every suite carrier: a form link's source entry, and part 06 §3.9's
runtime segments, whose remote request declares what their wire tree reads. Part 04 §2.4 builds
each declaration from this table at the arm (`InstanceDecl`), and a declaration no tree reads is no
longer written (part 04, Departures).

What this replaces: `lib/commcare/xpath/carriers.ts::xpathCarrierAllowedInstanceIds` (raw XPath may
name only `casedb` and `commcaresession`) and the instance pass of
`lib/commcare/xpath/compatibility.ts` retire, since an instance the union cannot hold is
unrepresentable (part 01 §1.5) and a held one declares itself. The XForm tracker's substring scans
(`xform/builder.ts::InstanceTracker.scanXPath`) and the suite collectors' separate AST walk
(`predicate/instances.ts::instanceSourceFor`, the closed `isSelectedCasesInstanceId` regex family)
are replaced by the derivation part 04 builds.

**No unserved fixture.** Core initialises every declared instance when a form opens and
`loadFixtureRoot` throws `FixtureInitializationException` for a fixture the device does not hold
(`CommCareInstanceInitializer.java::loadFixtureRoot`), so the form cannot open. From step 3 a form
declares a fixture only where its tree reads one, and each fixture it can read is either pushed by
the same publish (a global lookup table: HQ restores one fixture element per global table whether
or not it has rows, `fixtures/fixturegenerators.py::ItemListsProvider._get_fixtures`) or confirmed
by the person (the flat location list). The inventory row "declared, unreferenced fixture instance
the project space does not serve" therefore has no Nova instance.

### 2.2 `casedb` queries

Arms `cases { source: "casedb", where }`, `project`, and the row leaves `prop`, `case-row-type`,
`case-index`, `case-type` (part 01 §1.3–1.4); identities are case types and `(caseType, property)`
pairs, name-backed (part 01 §5); relation steps `index/<identifier>` name-backed. Raw XPath admits
these reads as text today (the SA guide teaches them, `lib/agent/authoring/reference.ts`, the
`instance('casedb')/casedb/case[@case_type = 'visit']` paragraph), and Preview reads them from the
device's casedb snapshot (`lib/preview/engine/caseDataBinding.ts::loadCaseDatabaseSnapshotAction`,
over `CaseStore.readDeviceCaseDatabase` with the persona's restore scope).
From step 3 they are typed with no change of reach: declaration `casedb` (§2.1), Preview
unchanged, nothing for the project space to serve, and the rules are part 01's (`row-scope`,
`many-values`, unknown property, case-type retirement counting query reads).

**Row type** (part 01 §1.3). A row's case type comes from, in order:

1. a predicate `@case_type = '<type>'`;
2. else a predicate `@case_id = <e>` whose `e` has a known `caseIdOf` (a cases-sourced select's
   answer, a query-bound repeat's `@id`, a session datum by the table of §1.3, a `case-index`);
3. else, for each custom property the query reads, the one case type of the effective catalog
   (`lib/domain/effectiveCaseTypes.ts::effectiveCaseTypes`) that declares that property. The parser
   stores that type in the `prop` leaf, so a later declaration of the same property on a second type
   changes nothing stored. Where no type or several declare it, the read is the parse refusal
   `case-query-untyped`: "You can add `[@case_type = '<type>']` so CommCare knows which records to read."

`@case_id`, `@case_type`, `@status`, `@owner_id`, `index/<identifier>` and the standard properties
every case holds are readable in a query with no row type, since every case type holds them.

**One value or many.** A `cases` query used as one value is admitted: only its data decides how
many rows match, an author filtering by a unique property gets one, and Core throws at run time on
more than one (`org/javarosa/xpath/XPathNodeset.java::unpack`, part 03 §3.4), as it does today.
`[1]` remains the author's way to take the first row of a `casedb` query.

**System dates.** In a `casedb` row `date_opened` and `last_modified` are held `date` (Core's
`DateData`, the day only), so in a slot Core evaluates (targets XF or SU) an ordering of either
against a `datetime` operand that is not day-aligned, and `=` or `!=` with any `datetime` operand,
day-aligned included, is part 03's `day-only-on-device` refusal; against a `date` operand it is
part 03's `date-datetime` (part 03 §3.2, part 04 §3.4; the row stack carries its root, part 01
§3.2). Production holds a few raw `casedb` reads of a system date and time, none in a comparison;
the dry run counts them again, and any it refuses is a `target-gate` blocker (§6.2).

**A property no case type declares.** A typed row reading a custom property the effective catalog
lacks is part 01's unknown-property finding. The cutover declares each property a lifted query reads
on its row's type (the outline's cutover: "the migration declares, on the queried case type, each
property an existing expression reads that the type does not list"), so a stored read keeps
committing. Production holds a few such reads, all text use: some in a query typed by a
`@case_type` literal, and the rest in queries with no `@case_type` literal, which part 09's probe
shows are typed by `@case_id` from a known source (rule 2). So every one is a typed read and
becomes a declaration, all `text` (part 09 §5, step 5, `declare-read-properties`). None is a
`case-query-untyped` blocker.

**Production** (the production shape scans, live apps). Production's `casedb` queries are typed by
a `@case_type` literal or by a `@case_id` from a known source (a cases-sourced select's answer, a
query-bound repeat's row id, a selected-case datum), except some with no row type that read a row
value (the case id from a Hidden Value, `selected-at`, a nested `casedb` read, a relative path),
almost all reading a custom property, which rule 3 binds or the dry run reports. Part 09's probe
splits those into standard reads that need no type, custom reads that bind to one type, reads that
match several (blockers), and reads in queries typed by `@case_id` from a known source after all
(declarations, above). Used as one value: some slot results and operands of `=` and `div`, each admitted;
every other many-row read sits in `count`, `sum`, `join`, `max` or an `ids_query` result.

### 2.3 Lookup tables in form logic

**Today** lookup reads exist only in typed carriers: a lookup select's `optionsSource`, and
`table-lookup` / `table-column` in record slots (`lib/commcare/CLAUDE.md`, "Lookup wire"). Raw XPath
may not name a table, because a tag is a mutable projection with no identity leaf
(`carriers.ts::xpathCarrierAllowedInstanceIds`), and the public docs say so
(`content/docs/building-with-nova.mdx`, "Raw XPath can use the stable `casedb` and
`commcaresession` instances, but it cannot name a lookup table by its mutable wire tag").

**From step 3** form logic and form-link slots read a table by `tableId` and `columnId`:
`table-lookup` (the first matching row's column, the arm whose canonical print is
`instance('<tag>')/<tag>_list/<tag>[<where>][1]/<col>`) and `table-rows` with `project { value:
table-column }` for every other shape (counts, sums, `join`, predicates on several columns).

- Spelling. Both instance ids parse to the same arms (part 01 §2.3). The canonical print follows the
  slot's target: the bare tag in an XForm slot, the id HQ's form builder uses
  (`fixtures/fixturegenerators.py::item_lists_by_domain(namespace_ids=False)`, called by
  `app_manager/views/formdesigner.py`), and `item-list:<tag>` in a form-link slot, the id HQ's suite
  build recognises (`generic_fixture_instances`). A bare tag in a suite is an unknown instance:
  `get_instance_factory` falls to `null_factory`, and `assert_no_unknown_instances` raises
  `UnknownInstanceError`.
- Rename: a tag rename reprints the root and the two path steps; a column `wireName` rename reprints
  its step (`lib/commcare/lookup/naming.ts`). Removal of a table or column is refused while
  referenced (`lib/lookup/schemaGovernance.ts`, reading `lookup_table_references` and
  `lookup_column_references`).
- Types: the column's `LookupDataType` (part 01 §3.2), held `string`.
- One value: a `table-rows` projection used as one value is admitted like a `cases` query (§2.2),
  and `table-lookup`'s print carries its own `[1]`. So
  `instance('t')/t_list/t[code = x]/name` in a scalar position is admitted and Core throws on
  several matching rows, as the same text does in an XForm HQ built.
- Preview: `xpathInstances.ts::lookupXPathInstances` already builds the instance under
  `table.xformInstanceId` from the captured snapshot; the snapshot's referenced set and the
  coverage predicates (`lookupEvaluation.ts`, `expressionLookupsCovered`) take the form-logic
  carriers through the extractor registry below, so a form whose logic reads a table waits for the
  covering snapshot exactly as a lookup select does.
- Wire: XForm declaration through the serializer's instance set (part 04 §2.4, which replaces
  `InstanceTracker.requireFixture`), suite declaration on the source entry for a link; `.ccz` embeds
  the table as today; HQ publish pushes it before the content as today. HQ's build checks the
  `lookup_tables` privilege for any form whose source holds `src="jr://fixture/item-list:`
  (`app_manager/models/forms.py::FormBase.has_fixtures`,
  `helpers/validators.py::ApplicationBaseValidator._validate_fixtures`), which
  `lib/commcare/planPrivileges.ts` already derives from `extractLookupReferenceTargets(doc)`.
- `LOOKUP_TAG_RESERVED_BY_RUNTIME` (a tag containing `casedb` or `ledgerdb`, which Core's `contains`
  dispatch would send to the case or ledger store) applies to these reads unchanged.

**Reference edges.** Four extractors join
`lib/doc/lookupReferences.ts::PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS`, each over the typed tree:
`field_form_logic` (every form-logic field slot, the path below the slot naming the field UUID and
slot id), `connect_form_logic`, `form_link_condition` and `form_link_datum` (the link UUID, and the
target datum ref for a datum). The edge tables hold `(app, table)` and `(app, table, column)` only
(`lib/db/lookupReferenceEdges.ts::readStoredLookupReferenceTargets`), so they need no migration.
Today no stored form logic can name a table, so the cutover rewrites no edge. Executed during
planning (the production shape scans): every `instance(…)` call production holds is a `casedb`
query or a `commcaresession` read (`session/data`, `session/context`, `session/user/data`), and no
other instance id appears, so no stored text reads a lookup table, a location, groups, selected
cases, search results or search inputs.

**Implementation correction, 2026-10-19 (pull request 9):** the four extractors are not written
(decision 9's correction). `lib/doc/__tests__/formLogicLookupReferences.test.ts` holds that a
question-logic, a Connect and a link read each give their exact occurrence and stored target (which
drives the deletion refusal), that `LOOKUP_TABLE_NOT_AVAILABLE` names each read once the table is
gone (one finding per carrier slot, in document order: `validateLookupReferences` reports a gone table
once for the expression that names it at several paths, a lookup's result and match columns, and
orders occurrences by menu, form and question, where extraction's identity order meant nothing to a
reader), and, through `prepareExportBoundaryWithReads`, that the `.ccz` embeds the fixture and both HQ
modes carry the workbook. `lib/commcare/validator/rules/form.ts`'s link datum rule now builds its
projection under `identityLookupWireNaming()`: without a naming, validating any link whose condition
or datum reads a table threw "A lookup-row query needs the Project lookup naming catalog", which broke
the gate and export. HQ's `FormBase.has_fixtures` is the literal substring
`'src="jr://fixture/item-list:'`, so `lib/commcare/__tests__/instanceReadEmission.test.ts` holds the
XForm's double-quoted `src="jr://fixture/item-list:regions"`; otherwise HQ's build would skip the
`lookup_tables` check for a form whose logic reads a table.

### 2.4 Flat locations

**Arms.** `locations { where }`, `project { value: location-field }`, and `location-level` (part 01
§1.3–1.4). Identities: a level's UUID (printed as its create-once code, `lib/domain/organization.ts`,
level codes), a location property's UUID (printed as `location_data/<slug>`), and the fixed row
fields `id`, `type`, `name`, `site_code`, `external_id`, `latitude`, `longitude`.

**HQ's fixture at the pin** (`locations/fixtures.py::FlatLocationSerializer.get_xml_nodes`,
`::_get_fixture_node`, `::_fill_in_location_element`, `::_get_metadata_node`): an index schema
node, then `<fixture id="locations" user_id indexed="true"><locations>` with one `<location
type="<code>" id="<location id>" <code>_id="…">` per location in the worker's footprint, ordered by
`site_code`, carrying an `@<code>_id` attribute for every level code of the space (the location's
own and its ancestors' filled, the rest empty), and children `name`, `site_code`, `external_id`,
`latitude`, `longitude`, `location_type`, `supply_point_id`, and `location_data` with one child per
location field the space defines (empty where the location holds none). `location_type` and
`supply_point_id` are not readable in step 3 (part 01 §1.2, `LocationRowField`). The provider sends
the fixture on a first restore whatever the footprint (`_get_fixture_node` appends the
`<locations>` element before its loop, so an unassigned worker gets an empty one; HQ's test of the
same for the hierarchical provider is
`locations/tests/test_location_fixtures.py::LocationFixturesTest.test_no_user_locations_returns_empty`)
and on a later sync only when something changed, the device keeping the one it has
(`LocationFixtureProvider.__call__`).

**What decides that the device gets it** (`locations/fixtures.py::should_sync_flat_fixture`): the
project space uses locations, and the app's `location_fixture_restore` is a flat option, or it is
`project_default` and `LocationFixtureConfiguration.sync_flat_fixture` holds. Nova writes
`project_default` on every app (`lib/commcare/hqShells.ts`, `location_fixture_restore`), so the
setting is the space's, which no API key reads. That is defect 14 / finding 69's resolution in step
2, and the confirmation Nova already asks for an app that reads places
(`lib/publish/planFeatures.ts`, "The flat location list"; `lib/deployment/confirmations.ts`).

**From step 3:**

- `lib/commcare/locations/readsLocationsFixture.ts::formsReadingLocationsFixture` answers from the
  derived instance set: a form whose XForm declares `locations`, which covers today's
  `owner-location-at-level` and every form-logic read, and a form whose link reads it. The
  `locations` plan feature and the flat-list confirmation therefore follow, and the reason line
  becomes "`<form>` reads places in your organization." where the form has a form-logic read
  (`planPrivileges.ts::flatLocationFixtureReasons`, `requiredPlanPrivileges`'s `locations` arm).
- Preview: new `xpathInstances.ts::locationsXPathInstance(rows, organization)` builds HQ's shape
  from `lib/organization/footprint.ts::personaFootprint`, "every place a persona's device can name,
  the contents of their `locations` fixture": ordered by site code, the lineage attributes for
  every level, the property children for every location property of the app, empty where unset.
  The footprint is server-side (it reads the place tree), so it travels with the device-scoped case
  snapshot the running form already loads (`caseDataBinding.ts::loadCaseDatabaseSnapshotAction`) and follows
  the same restore-scope key (`useRestoreScopeKey`). Previewing as yourself is a worker assigned
  nowhere: an empty instance, as HQ sends.
- Identities in the two worlds: on a device `@id` and the lineage attributes are HQ's location ids;
  in Preview they are Nova's place UUIDs, which is also what Preview's
  `commcare_location_id` user data holds, so comparisons between the two reads agree in each world.
  No expression can hold a literal place id: `fixed-location` stays an owner-slot leaf the export
  boundary refuses (`lib/commcare/CLAUDE.md`, "Location owners").
- Rule `LOCATIONS_READ_NEEDS_ORGANIZATION` (new, soundness): a `locations` read in an app with no
  organization levels. Such an app pushes no places (`lib/deployment/service.ts`, the
  `organizationLevelsOf` guard), so the read could only name places someone made in HQ, which
  Preview cannot show. Copy: "`<question>` reads places, but this app has no organization yet. You
  can add your organization's levels in App setup first."
- **A form link may read places.** Part 01 §4's form-link profile admits instance reads; a link's
  condition and datum values evaluate in the source entry's session, whose evaluation context holds
  the entry's declared instances (`org/commcare/session/CommCareSession.java::getEvaluationContext`,
  `entry.getInstances`), so a declared `locations` reads the same device fixture the form reads; and
  `formsReadingLocationsFixture` already counts a form whose link reads it, so the plan feature and
  the confirmation follow. The read puts a `locations` declaration in the suite on the source entry,
  where HQ's `location_fixture_instances` chooses the src, so pull request 9, which admits it, adds
  part 08 §5.2's value-class reader `proof/checks/manifest_value_classes.py::hierarchical_locations`
  for `expressions-and-data/commtrack-locations-hierarchical` (True for
  `jr://fixture/commtrack:locations`, False for `jr://fixture/locations`, None otherwise), with its
  pair in `proof/checks/test_manifest_value_classes.py`. `targeted-instance-reads` (part 08 §4.5)
  holds a form-logic location read and a link condition reading a place's name, so the reader
  meets a suite declaration; its other link condition reads `item-list:<tag>`.
- Native proof: `proof/native/test_location_emission.py`, which runs HQ's own
  `FlatLocationSerializer` over the lane's places, gains the comparison of that fixture node with
  `locationsXPathInstance` over the same organization and persona (element and attribute names,
  order, values up to the id mapping), so Preview's shape is held to HQ's.

**Implementation correction, 2026-10-19 (pull request 9):**

- `formsReadingLocationsFixture(doc)` returns `{ formUuid, why: "owner" | "reads" }[]`. It still
  decides by the serializer, not a domain walk: it lowers every expression the form carries
  (question logic, Connect, case operations and the display condition through
  `formExpressionEmission`, as XForm; link conditions and datum values through
  `projectFormLinkSessionExpression`, as suite) and counts a form whose printed trees declare
  `locations`. It prints under `identityLookupWireNaming()`, because `toWire` of a table read throws
  without a naming and the location decision reads no table id. `why` is `owner` only when a case
  owner is the form's only place read. A level code alone (`location-level`) prints a literal and
  declares nothing.
- `planPrivileges.ts::flatLocationFixtureReasons` says "`<form>` reads places in your
  organization." for a read in form logic or a link alike, and keeps "`<form>` sets a case's owner
  from a place in your organization." for an owner-only form; the `locations` privilege's form
  reasons are the same sentences. `lib/publish/planFeatures.ts` is unchanged. No other slot can read places,
  so forms are the whole count: every menu, case list, Search and display condition slot (and a case
  operation's or a choice list's record rule) is a record rule, and the checker refuses a `locations`
  read there, or a `count` or `project` of one, as `arm-unavailable` with reason `places-unavailable`
  ("This setting can't read places. You can read them in a form's questions or its links
  instead."), since no menu, detail or remote request declares the fixture. Preview therefore
  supplies places to forms only.
- `LOCATIONS_READ_NEEDS_ORGANIZATION` is a validator rule, `lib/commcare/validator/rules/locationsRead.ts`,
  run inside the per-form logic walk so the editor and the gate see it alike, and refuses a
  `locations` read only; owner hops keep their existing checks. Its sentence as written: "`<carrier>`
  reads places, but this app has no organization yet. You can add your organization's levels in App
  setup first."
- Preview: `personaFootprint` had no production caller; it now feeds
  `footprint.ts::locationFixtureRows`, which `loadCaseDatabaseSnapshotAction` returns as `locations`
  in plain JSON (part 07 §3's correction).
- The lane: `proof/native/test_location_emission.py` asserts HQ declares `jr://fixture/locations`,
  not the hierarchical fixture, on the link's entry and in the form; the comparison with
  `locationsXPathInstance` above is not written (part 08 §2.6's correction).
- `lib/commcare/validator/suiteOracle.ts`'s rule that every declared `jr://fixture/…` source names
  an embedded fixture skips exactly `jr://fixture/locations`, which HQ's restore delivers as the
  user fixture `locations` (`corehq/apps/locations/fixtures.py::flat_location_fixture_generator`)
  and the archive never embeds, so an app whose link reads places compiles to a `.ccz`.

### 2.5 The batch form's selected cases

`selected-cases { module }` prints `instance('<datum id>')/results/value` (part 01 §2.3), the
selected-entities instance a multi-select datum fills
(`org/commcare/data/xml/VirtualInstances.java::buildSelectedValuesInstance`;
`CommCareInstanceInitializer.java::setupSelectedEntitiesInstance`). It resolves where
`entryDatumSupplies` lists `selected-case { module }` with `scalar: false`, so in a follow-up or
close form of a several-case module (or its compatible child, `caseSelectionCanFlowBetweenModules`).
Its type is `{ nodes: "text", cardinality: "many" }`, so the `many-values` rule (part 01 §3.4) admits
it only under a node-set consumer (`count`, `join`, `selected(join(' ', …), x)`, a predicate), the
collection-aware read `lib/commcare/CLAUDE.md` asks for ("Never print one case by taking
`value[1]`"); `lib/commcare/validator/rules/multiSelect.ts::multiSelectFormSemantics` keeps refusing
a read of "the selected case" (`#case/`) in shared form logic. Used as one value it is refused
(`XPATH_MANY_VALUES`), because the module selects several cases by declaration, as a repeat holds
several rows: its plurality is the module's shape, not the data's, unlike a `cases`, `table-rows`
or `locations` query, whose predicates decide its rows and which stay admitted as one value.
Production holds no selected-cases read, so the cutover lifts none; a stored one would be a
`target-gate` blocker (part 09).

Admitted in field slots only: a link condition and a Connect expression refuse it, by the existing
operation-local rule (selected-case reads are operation-local and invalid in after-submit
conditions, `lib/domain/CLAUDE.md`, "A multiple selection"); a link condition reading the count of
selected cases is refused the same way. Preview builds the instance from the ordered
`previewCaseTarget.cases` the batch form already receives (`lib/preview/CLAUDE.md`, "Several-case
selection"). Nova's XForm declares the instance where its tree reads it: the batch case blocks'
read and any form-logic read (part 04 §2.4: the unconditional `requireSelectedCases` leaves); HQ's
factory gives the same src. Several-case selection is a Web Apps feature (inventory, "Secondary
instances", `selected_cases` RUNS / UNAVAILABLE), which step 4's platform declaration governs with
the module itself, not this read.

**Implementation correction, 2026-10-19 (pull request 9):** `typeChecker.ts::selectedCasesAdmission`
admits the read in a question (`slot.entity === "field"`) of a form whose supplies hold the module's
`selected-case` with `scalar: false`. A link or Connect slot is `datum-not-supplied` with reason
`selected-cases-carrier`, another form's question the same code with reason `selected-cases`, both
`SESSION_DATUM_NOT_SUPPLIED`; a removed module is a dangling identity. Read as one value it is
`XPATH_MANY_VALUES`. Preview builds the instance from `entrySessionData`'s `selectedCases`. Android
has no several-case selection at all (no multi-select entity screen in commcare-android at the pin),
so the public docs describe the read without naming a platform.

### 2.6 Deferred reads

The criterion, decided with the person (2026-10-17): a read leaves step 3 only when it depends on a
model concept a later step owns, or on the platform declaration (step 4); work that should
logically be done now is done now. Three reads meet it; this plan's own pull request writes each
into the receiving step's outline file (`docs/plans/hq-round-trip/7-rest-of-model.md`,
`4-platforms.md`), so nothing is dropped silently.

- **`groups` and `group-field`, to step 7, group 2.** *Reason:* the read means the worker's
  case-sharing groups, a concept Nova holds only from `caseSharing`, and HQ's own groups are target
  state Preview cannot show truthfully. HQ always sends the fixture (the element always holds its
  `<groups>` child, so `len(fixture)` is never zero,
  `users/fixturegenerators.py::UserGroupsFixtureProvider.__call__`) and fills it with one group per
  assigned location whose type shares cases, its id the location id and its name the location path
  with `-Cases` (`users/models.py::CouchUser._get_case_sharing_groups_for_locations`,
  `locations/models.py::SQLLocation.case_sharing_group_object`), plus every HQ group with case
  sharing on (`users/models.py::CommCareUser.get_case_sharing_groups`). The manifest entry stays
  HELD-NEW for that group. Text naming `instance('groups')` is refused at parse: "Reading the worker's
  case-sharing groups isn't available yet. You can read the places the worker is assigned to with
  `instance('locations')` instead."
- **Search inputs read in an inline-search module's ordinary forms, to step 4.** *Reason:* a read
  throws on Android, a platform question. Formplayer keeps the inputs on the query step
  (`QueryScreen.updateSession`), Android sets only the results on it (`QueryRequestActivity`), and a
  read there throws (inventory, `search-input:*` in inline-search forms, RUNS / UNAVAILABLE).
  Admitting it before the app declares its platforms would emit forms that cannot open on Android.
  The no-matches form keeps its `#search/` read (`lib/domain/menuForms.ts::searchInputNameResolver`,
  `INVALID_SEARCH_REF`), which Android never reaches. Parse copy elsewhere: "A search answer can be
  read only by the form offered when a search finds nothing. You can read a property of the case the
  worker chose instead."
- **The `device-query` datum kind (`stringquery`, `fingerprintquery`), to step 4.** *Reason:*
  Android only: §1.2 shows each exists only when an Android list step carries its extra; Web Apps
  never has it (inventory: UNAVAILABLE), Preview has nothing to show, and no surface would offer
  it. A stored kind with no author, no Preview value and no platform rule is not a complete held
  feature, so step 4 adds it with its platform reading. Production holds no stored read of either
  (§6.1).

Also step 4's, and not a read of this part: the authoring of session context `drift`,
`window_width` and `applanguage` (their values differ per platform; the stored enum holds all
seven, part 01, Departures). Production reads none of them (§6.1).

Kept in step 3: search results read in the forms of an inline-search module, §2.8. Nova already
emits inline search, the search-first inline shape and `results:inline`, so no later concept is
needed; `cases.source` keeps `"search-results"`. The "Inline search" arm group's `input` stays in a
no-matches form only, since search inputs in ordinary forms go to step 4.

### 2.7 Rules, by code

| Code | New or changed | Refuses |
|---|---|---|
| `SESSION_DATUM_NOT_SUPPLIED` | over identity, in the checker's profile admission (§1.6, part 03 §3.9); `rules/sessionData.ts` leaves; the record points, with the reasons `not-before` and `differs`, from pull request 10 | a stored `session-datum` or `selected-cases` the slot's evaluation point does not supply (§1.3) |
| `FORM_LINK_DATUM_UNUSED`, `FORM_LINK_DATUMS_INCOMPLETE` | over refs (§1.5) | as today |
| `LOCATIONS_READ_NEEDS_ORGANIZATION` | new (§2.4) | a `locations` read with no organization levels |
| `LOOKUP_*` occurrence codes | unchanged, four new extractors (§2.3) | a missing or foreign table or column, an incompatible column type |
| `INVALID_SEARCH_REF` | unchanged | `input` outside a no-matches form |
| `many-values` → `XPATH_MANY_VALUES`, `row-scope` | part 01, part 03 §3.4; `many-values` refuses only structural plurality, and `selected-cases` (§2.5) | a selected-cases read used as one value (§2.5); a row leaf with no row. A `cases`, `table-rows`, `locations` or search-results read used as one value is admitted (§2.2) |
| `case-query-untyped` | parse refusal, part 02 §1.4; rule 3 of §2.2 | a custom property read in a `cases` query with no row type, where no case type or several declare it |
| unknown property | part 01 | a typed row reading a property its type does not declare; the cutover declares each stored one (§2.2) |
| `XPATH_INCOMPATIBLE_VALUES` reason `day-only-on-device` | part 03 §3.2, with part 04 §3.4 | a `casedb` row's `date_opened` / `last_modified`, or a results row's `date_opened`, ordered against a `datetime` operand that is not day-aligned, or compared by `=`/`!=` with any `datetime` operand, day-aligned included, in an XF or SU slot (§2.2, §2.8); against a `date` operand it is `date-datetime` |
| `SEARCH_RESULTS_NOT_SUPPLIED` | new, the checker's profile admission (§2.8, part 03 §1.4) | a `search-results` read where the evaluating entry carries no inline query |
| `SEARCH_RESULTS_READ_INVALID`, `details.reason` `order` or `other-type` | new, one code for the checker's `search-results-order` and `search-results-other-type` (§2.8; part 03 §1.4) | an order-sensitive read of search results; a `@case_type` the search cannot return |

### 2.8 Search results in an inline-search module's forms

This section plans the read in full: arm, row, declaration, rules, Preview's supply, authoring,
docs and proof.

**Today.** A search-first module (`caseSearchConfig.searchFirst`, `lib/domain/modules.ts::moduleOpensOnSearch`)
lowers to HQ's inline search on both wire paths (`lib/commcare/CLAUDE.md`, "Search-first inline
shape"). Each case-requiring entry's `<session>` is `[parent datum] <query url
storage-instance="results:inline" template="case" [default_search="true"]>` then the case datum,
whose nodeset reads `instance('results:inline')/results/case[@case_type='t'][@status='open']{filter}[not(commcare_is_related_case=true())]{parent}`;
the claim `<post>` sits between `<form>` and `<command>` (`suite/case-search/claim.ts::buildInlineClaimPost`).
`lib/commcare/formLinkProjection.ts::withInlineSearchQueries` puts the query datum in the entry's
projection with `query.storageInstance` `"results:inline"` (`lib/commcare/session.ts::INLINE_SEARCH_RESULTS_INSTANCE`,
`INLINE_SEARCH_RESULTS_SRC = "jr://instance/remote/results:inline"`). Executed during planning
(the search results probe, over `lib/commcare/__tests__/endpointWireFixture.ts`'s `inline`
scenario): the follow-up form's entry datums are `results:inline` (the query, case type `patient`)
then `case_id`. No form logic reads the instance: raw XPath may name only `casedb` and
`commcaresession` (`xpath/carriers.ts::xpathCarrierAllowedInstanceIds`, which the probe prints),
and no typed arm reads results. Production holds no `results` or `results:inline` read (§2.3), so
the cutover lifts none.

**Where a form can read it** (at the pins):

- Core keeps the instance on the frame. `org/commcare/session/CommCareSession.java::setQueryDatum`
  pushes a `STATE_QUERY_REQUEST` step carrying the query's result source
  (`step.addDataInstanceSource(queryResultInstance.getSource())`; its comment: "The instance is
  available in session's evaluation context until the corresponding query frame is removed"). An
  inline entry carries no `<rewind>`, which is the remote request's stack
  (`app_manager/suite_xml/post_process/remote_requests.py::RemoteRequestFactory.build_stack`, the
  inventory's REFUSED row for a search that is not inline). The claim removes no step: a post that
  succeeds adds the frame step extra `EXTRA_POST_SUCCESS`, and for an entry that has a form the
  session simply goes on (`org/commcare/util/screen/SyncScreen.java::handleInputAndUpdateSession`,
  `::updateSessionOnSuccess`, which Formplayer's `FormplayerSyncScreen` extends;
  `CommCareSession.getNeededData` reads the extra in its `STATE_SYNC_REQUEST` arm).
- The form's `<instance id="results:inline" src="jr://instance/remote/results:inline"/>` reaches
  `org/commcare/core/process/CommCareInstanceInitializer.java::generateRoot`'s remote arm,
  `setupExternalDataInstance(instance, ref, SessionFrame.STATE_QUERY_REQUEST)`, whose
  `getExternalDataInstanceSource` returns the frame step's source for that reference
  (`StackFrameStep.hasDataInstanceSource`, `::getDataInstanceSource`). The source's root is the
  fetched instance; with none, `ExternalDataInstanceSource.getRoot` throws "Uninstantiated external
  instance source".
- After the form, the session's evaluation context includes every frame step's instances
  (`CommCareSession.getEvaluationContext`, `instanceMap.putAll(step.getInstances(iif))`), so a link
  `condition` or `datums[].xpath` evaluated there reads the same instance.
- Formplayer: `formplayer/session/FormSession.java::initialize` builds
  `FormplayerSessionWrapper(platform, sandbox, sessionFrame, instanceFetcher, windowWidth)`, whose
  constructor calls Core's `SessionWrapper.prepareExternalSources` →
  `StackFrameStep.initDataInstanceSources` → `ExternalDataInstanceSource.remoteInit`, so a session
  Formplayer rebuilds from its stored frame fetches the results through its fetcher before the form
  initialises its instances (`formDef.initialize(newInstance, sessionWrapper.getIIF(), …)`). A case
  changed between the search and the form's next request can therefore read differently in Web
  Apps than when the worker searched, while Android holds the first fetch. Preview reads the
  snapshot once per entry, which is a device's reading; the native proof runs Core's session, and
  the lane's Formplayer walk shows Formplayer's.
- Android: `activities/QueryRequestActivity.java` calls `setQueryDatum` with the fetched instance, and
  `utils/AndroidInstanceInitializer.java` extends Core's initializer, so a form in the same session
  reads it. `models/AndroidSessionWrapper.java::prepareExternalSources` throws ("This method is not
  yet implemented"), so a session Android rebuilt without the fetched root holds no results. That is
  the inventory's "UNAVAILABLE for results not on the device", and it is the inline-search module's
  own platform reading (inventory, the `inline_search` rows of `case-search.md`, RUNS / UNAVAILABLE,
  "Session Refresh Required"), which step 4's platform declaration governs with the module, as §2.5
  says of several-case selection. This read adds no platform condition of its own.

So the forms that can read search results are exactly those whose entry carries the inline query
datum: the menu forms of a search-first module, a search-first child of an ordinary parent-select
source included. Not the no-matches form: its synthetic module's entry carries no query datum
(`lib/commcare/emissionPlan.ts::emissionPlan`), and it opens only while
`count(instance('results:inline')/results/case) = 0`, so every read there would be empty. A module
whose parent-select source or root is search-first does not arise: `SEARCH_FIRST_UNIQUE_INSTANCE`
refuses both.

**What HQ puts in the instance** (at the pin):

- `case_search/utils.py::get_unconfigured_endpoint_results` → `get_primary_case_search_results` →
  `CaseSearchQueryBuilder.build_query`: open cases only (`_get_initial_search_es`, `.is_closed(False)`)
  of the requested types (`.case_type(self.case_types)`; Nova's query sends the module's one type,
  `<data key="case_type">`), at most `case_search/const.py::CASE_SEARCH_MAX_RESULTS = 500`
  (`.size(max_results)`; 1,500 under `INCREASED_MAX_SEARCH_RESULTS`, a domain toggle tagged
  `TAG_FROZEN` in `corehq/toggles/__init__.py`), sorted by `commcare_sort` when the request sends it,
  which Nova's does not, else `['_score', '_doc']` (`_apply_sort`).
- Then `get_and_tag_related_cases` appends related cases outside the cap: every related live case and
  direct child when `x_commcare_include_all_related_cases` is sent (`_get_all_related_cases`),
  otherwise the cases the search details' relationship paths and child case types name
  (`get_related_cases_result`); each is tagged `commcare_is_related_case = "true"`
  (`_tag_is_related_case`), and none need be open or of the searched type.
- Each primary hit carries `commcare_search_score` (`es/case_search.py::wrap_case_search_hit`,
  `include_score`; `case_search/const.py::RELEVANCE_SCORE`).
- The XML is `casexml/apps/case/fixtures.py::CaseDBFixture` over
  `casexml/apps/case/xml/generator.py::CaseDBXMLGenerator`: `<results id="case">`, one `<case
  case_id case_type owner_id status>` per case with `case_name`, `last_modified`
  (`datetime_to_xml_string` → `json_format_datetime`, `%Y-%m-%dT%H:%M:%S.%fZ`), then
  `V2CaseXMLGenerator.add_custom_properties`: `external_id` and `location_id` only when set,
  `date_opened` (`date_to_xml_string`, `YYYY-MM-DD`), one element per stored dynamic property; then
  `index` and `attachment`.

**The arm.** `cases { source: "search-results", where }` (part 01 §1.4), with `project` and the row
leaves `prop`, `case-row-type`, `case-index`, `case-type`. It reads the cases the search found, never
the related cases HQ appends: those exist for HQ's own detail columns, their set depends on HQ's
reading of the app's details, and Nova's datum nodeset already excludes them.

- **Canonical print:** `instance('results:inline')/results/case[not(commcare_is_related_case = true())][<where…>]`,
  then the projection. The id is `results:inline` because Nova's inline search names no
  `instance_name` (`caseSearchConfig.resultsInstanceName` is HELD-NEW, step 7, group 5; when it
  lands, the print reads the module's effective name through the same projection).
- **Parse:** text `instance('results:inline')/results/case[…]` parses to the arm only when its first
  predicate is that exclusion. Without it the parser refuses: "Search results also hold cases
  CommCare adds to show related details. You can read the cases the search found with
  `instance('results:inline')/results/case[not(commcare_is_related_case = true())]`." Text naming
  `instance('results')`, the remote search's instance, keeps the inventory's REFUSED reading: "This
  form opens after the worker leaves the search, so its results are gone by then. You can read the
  case the worker chose with `#<type>/` instead."
- **Row type:** the searched case type. Every primary row is open and of the module's case type
  (`CaseSearchQueryBuilder._get_initial_search_es`, `.case_type`, `.is_closed(False)`), and the
  print always excludes related rows, so part 01 §1.3's three rules are not needed for it; part 01
  §1.3 types a `search-results` row as the module's case type. A `@case_type` predicate naming
  another type is the checker's `search-results-other-type`, `SEARCH_RESULTS_READ_INVALID` with
  `details.reason` `other-type` (part 03 §1.4): "This search only finds <type> cases, so no result
  is a <other> case."
- **Row leaves and their types,** against a `casedb` row:

| Read | Results row (HQ) | `casedb` row (Core) | Type and runtime |
|---|---|---|---|
| `@case_id`, `@case_type`, `@owner_id` | attributes, the same values | the same | text, String |
| `@status` | always `open` | `open` or `closed` | `single_select`, String |
| `case_name`, custom properties | the stored text; a `datetime` as HQ's `…T04:30:00.000000Z` (part 06 §3.13) | the same text, from the restore | the catalog's type, String |
| `last_modified` | text `%Y-%m-%dT%H:%M:%S.%fZ` | the day, `DateData` (`org/commcare/cases/instance/CaseChildElement.java`) | data type `datetime` in both; results row: held text (String), which finding 56's lowering orders as an instant; `casedb` row: held `date`, so part 03's `day-only-on-device` applies (part 04 §3.4: the row stack carries its root) |
| `date_opened` | text `YYYY-MM-DD`, the UTC day of `opened_on` | the day, `DateData` | data type `datetime` in both; held text (String) in a results row, `date` (`DateData`) in a `casedb` row. In both it is a day: ordered against a `datetime` operand that is not day-aligned, or compared by `=` / `!=` with any `datetime` operand, day-aligned included, it is part 03's `day-only-on-device` refusal in an XF or SU slot, because the instant lowering would read the date-only text as NaN; ordered against a day-aligned operand it compares bare, by day (part 04 §3.4). The rule lands with this read, in pull request 9 |
| `external_id`, `location_id` | present only when set | as casedb holds them | text, String |
| `index/<identifier>` with `@case_type`, `@relationship` | the same | the same | the relation step (`case-index`) |
| `commcare_search_score`, `commcare_is_related_case`, `closed_on` | the first two HQ's, the third absent | absent | not readable: no catalog property holds them (`unknown-property`); the exclusion is the print's own |

- **Order.** HQ orders the primary results by relevance score and index order, which neither Nova
  nor Preview reproduces. A read whose answer depends on the order is refused (the checker's
  `search-results-order`, `SEARCH_RESULTS_READ_INVALID` with `details.reason` `order`, part 03 §1.4,
  in part 01 §3.4's family): a positional step (`[1]`, `[last()]`),
  `position()` inside the query, and `join` or `distinct-values` over its node-set. Copy:
  "CommCare's search returns its cases in no fixed order, so the first or last result can change
  from one search to the next. You can count the results, or read a value of the case the worker
  chose." `count`, `sum`, `min`, `max`, a predicate on `@case_id` and a node-set used as a condition
  are order-free and admitted. A results query used as one value (`…/case[@case_id = x]/district`)
  is admitted too (§2.2): its predicates decide its rows, and Core throws on more than one. The
  positional step that would take the first of several is the one thing refused, by this rule,
  because HQ's first is its relevance order's.

**Where it is admitted.** In every field form-logic slot and Connect slot of a form whose entry
carries the inline query, and in a form link's `condition` and `datums[].xpath` when the link's
source form's entry carries it (they evaluate in the source session, §1.4). Resolution reads the
same projection as datums: the domain half's set at the form's point carries `searchResults {
module }` (§1.3), and the id half gives the query datum's row `{ id: "results:inline", refs: [],
scalar: false, searchResults: { module } }`. Entry supply is the checker's: profile admission reads
`searchResults` in `ExpressionContext.supplies`, the domain set at the slot's point (part 03 §1.3,
§1.4), so no rule file of this part carries it. Part 03 §1.4 admits `search-results` from pull
request 9, which emits its declaration. `SEARCH_RESULTS_NOT_SUPPLIED` (new, soundness) is the
finding where the set carries none, `details: { slot, carrier, reason }`, with `reason` one of:

| Reason | Sentence |
|---|---|
| `not-search-first` | "`<question>` reads what <module>'s search found, but <module> no longer opens on its search, so `<form>` has no search results. You can turn Search first back on, or read the case the worker chose instead." |
| `no-matches-form` | "`<question>` reads what the search found, but `<form>` opens only when the search finds nothing. You can read the worker's search answers with `#search/` instead." |
| `link-source` | "A link from `<form>` reads what a search found, but `<form>` doesn't open after a search. You can read a question or a case property instead." |

`lib/doc/referenceIndex.ts` indexes each read under the module whose search supplies it, so turning
Search first off, moving the form out of the module, or adding a registration menu form to it (which
withdraws Search first, `content/docs/case-workspace.mdx`, "Search first") is refused naming the
read, and the Search panel's review lists the read among its blockers through the same verdict.

**Instance declaration.** The arm's wire tree declares `results:inline`,
`jr://instance/remote/results:inline` (§2.1): on the XForm through part 04's serializer (HQ's
`app_manager/xform.py::XForm.add_missing_instances` keeps a declared id), and on the source entry
for a link (HQ's `suite_xml/post_process/instances.py::InstancesHelper.add_entry_instances`
collects stack frame XPaths in `_get_all_xpaths_for_entry`, and `remote_instances` declares the id
because `suite_xml/utils.py::is_valid_results_instance_name` holds for `results:inline`). The entry
already declares it for its own datum, so a link adds no new declaration there. HQ's id regex
(`get_instance_names`) reads the serializer's `instance('results:inline')` spelling.

**Preview supplies the set the search returned.** Today Preview's Results runs the search in
Postgres and reads at most 50 cases a page (`lib/preview/CLAUDE.md`, "Running Results reads at most
50 cases per page"), and its form engine has no `results:inline` instance. From step 3:

- **One snapshot per entry.** New `lib/preview/engine/searchResultsSnapshot.ts` and the Server Action
  `lib/preview/engine/caseDataBinding.ts::loadSearchResultsSnapshotAction({ appId, moduleUuid,
  attempt, inputValues, personaUuid, viewerTimeZone })` run the read Results runs for the module's
  completed attempt (`lib/session/previewSearchState.ts`, `completed`, with that attempt's answers,
  `runtimeBindings.ts::searchInputInstanceValues`), through `caseDataBindingHelpers.ts::readCases`
  without `page` (the complete-candidate path the form-selection caller of `loadCasesAction` already
  uses) and with no `restoreScope` (part 07 §3.5: a search is not a restore): the Project's
  open cases of the module's case type with the module's owner exclusion and filters applied, as
  HQ's case search reads them, in the Results order plan, limited to
  `SEARCH_RESULTS_CAP = 500` (`lib/commcare/session.ts`, beside `INLINE_SEARCH_RESULTS_INSTANCE`,
  `INLINE_SEARCH_RESULTS_SRC` and `EXCLUDE_RELATED_CASES_FILTER`, citing `CASE_SEARCH_MAX_RESULTS`;
  `lib/preview/engine` is an allowlisted `lib/commcare` consumer). It returns `{ rows, totalMatches }` as plain
  JSON (no `Map`, `Set` or `Date`, `lib/preview/CLAUDE.md`, "Case-data Server Action wire shape").
- **HQ's shape.** New `lib/preview/engine/xpathInstances.ts::searchResultsXPathInstance(rows,
  catalog)` builds `<results>` with one `<case case_id case_type owner_id status="open">` per row:
  `case_name`; `last_modified` from `modified_on` printed `%Y-%m-%dT%H:%M:%S.%fZ` in UTC with six
  digits; `external_id` and `location_id` only when set; `date_opened` as the UTC date of
  `opened_on`; each stored custom property as the text HQ would hold (a `datetime` printed as
  `json_format_datetime` of its instant, as HQ's receiver stores it, part 06 §3.13; a multi-select's
  tokens space-joined); `index/<identifier>` with `case_type` and `relationship`. No related rows, no
  `commcare_is_related_case`, no `commcare_search_score`: the arm reads none of them.
- **The engine reads it.** `FormEngineRuntimeOptions` gains `searchResults`; `secondaryXPathInstances`
  adds the instance under `results:inline` beside `search-input:results:inline`. `EngineController`
  loads the snapshot at `activateForm` for a form the reference index lists as reading search
  results, keyed by its entry key, so a rebuild in the same entry keeps it and **Clear form** (a new
  entry key) reads it again. App Tests (`lib/preview/app-tests`), `engine/evaluateForm.ts` and the
  after-submit link evaluation (`engine/formLinkEvaluation.ts`) read the same snapshot.
- **No completed search.** A form reached with no completed attempt for its module (a direct URL)
  shows the refusal panel the no-matches form uses, with **Go to Search**: "This form reads what the
  search found. You can run the search, then choose the case again." The engine does not activate,
  as a device reaches the form only through its search.
- **The cap.** When `totalMatches` exceeds 500, the form shows one line above its first question:
  "This search found <n> cases. CommCare's search sends a device the first 500, so this form reads
  500 of them here too." Preview's 500 are the first in Results' order and HQ's the first by
  relevance; since order-sensitive reads are refused, a count reads alike, and a membership test over
  a search of more than 500 cases can differ, which the line says. Under HQ's frozen
  `INCREASED_MAX_SEARCH_RESULTS` toggle HQ sends up to 1,500 and Preview keeps 500 everywhere,
  named on the form. Nova's compatibility probe can read a domain toggle (`lib/commcare/client.ts`,
  the `feature_flag` domain listing), but before publish there is no target, and reading it for a
  published target is not step 3's work (part 07).
- **The population** is Results' own read, so the form reads exactly the cases Results showed for
  that search. Today Preview's Results read binds the device's restore scope
  (`lib/preview/engine/caseDataBinding.ts::loadCasesAction` passes `context.restoreScope` to
  `readCases`), while HQ's case search filters by domain, case type and open status only
  (`CaseSearchQueryBuilder._get_initial_search_es`): it finds cases the worker's device does not
  hold, which is what the claim is for. From step 3 a search's Results, this snapshot included,
  reads the Project's open cases of the type with the owner exclusion and filters, without the
  device's restore scope, as HQ's case search does (part 07 §3.5, "A search's population and the
  claim"); part 07 applies it to every search, a Search action's as well as a search-first
  module's. Part 07 §3.2 adopts this section's server read (`searchResultsSnapshot.ts`,
  `loadSearchResultsSnapshotAction`), its no-related-rows instance
  (`searchResultsXPathInstance(rows, catalog)`), the cap line and the no-completed-search panel.

**Authoring.** Builder: completion inside `instance('results:inline')/results/case[…]` offers the
module's case properties and `@case_id`, `@owner_id`, `@status`, and offers the instance only in a
form whose entry carries the query; a resolved read renders as a chip "What the search found"
(`lib/codemirror/xpath-chips.ts`); the completion source lands in pull request 9 and the chip in
pull request 11, the builder. SA and MCP: `lib/agent/authoring/reference.ts`'s search-first
paragraph gains one sentence and one example, `count(instance('results:inline')/results/case[not(commcare_is_related_case = true())])`,
in pull request 9, which bumps `MODEL_CONTEXT_VERSION` to `"v4-hq-round-trip-expressions.9"`
because it changes model-facing prose (part 02 §9); tool reads print the canonical text. No tool
schema changes.

**Docs.** In pull request 9, with the read, `content/docs/case-workspace.mdx`, "Search first", gains a paragraph in the present tense:
"A form in a search-first module can read what the search found, for example how many cases it
returned. CommCare's search returns up to 500 cases, and Preview reads the same 500. Cases CommCare
adds only to show related details aren't part of what the search found." It says nothing of Android;
step 4's platform declaration does.

**Native proof.** `proof/native/core/SearchRuntimeTest.java` gains
`formReadsTheResultsItsSearchReturned`: Core's own session runs the `inline` scenario's entry
(`setQueryDatum` with the fixture's six results, the fifth tagged related), selects `patient-1`,
opens the form with Core's own `CommCareInstanceInitializer` over that session (not the test's
initializer, which synthesizes `results:inline` directly), and evaluates the form's Hidden Value
`count(instance('results:inline')/results/case[not(commcare_is_related_case = true())])` to `5`, then
the link condition reading the same count after the form, on the local archive and on HQ's
regenerated suite and form.

**Lane.** The targeted document `proof/targeted/documents/inlineSearchReads.ts`
(`targeted-inline-search-reads`, part 08 §4.5), explicit identities: case type `patient` with
`district`; a registration module "Register patient" and a search-first module "Find patient" with
one text prompt on `district`; its follow-up form "Check in" holds a Hidden Value `found` whose
calculate is the count above and a label that shows it, and an after-submit link to the module's
second follow-up form "Note" whose condition is the same count `> 1` (a link condition reads no
`#form/`). Its Core expectation fixes the value: in the walk whose search for the corpus's district
returns its three seeded patients, Core's evaluation of `found` is `3`, which proof 3's Core trace
records for the form and Formplayer's walk shows in the label. The module's no-matches form reads
`#search/district` in a Hidden Value, whose expectation is the district a second walk searches for
and finds no patient in (part 08 §4.5: "`#search/<name>` in the no-matches form"). No edit batch
(part 08 §4.5). Proofs 1 to 5 with every walk held to its end; the manifest usage record shows
`results-read-in-form-expressions-of-an-inline-search-module`, now HELD.

**Implementation correction, 2026-10-19 (pull request 9):**

- **Row type.** Both halves type a `results:inline` row with no `@case_type` as the searched
  module's case type, `ctx.facts.moduleCaseTypes.get(ctx.supplies.searchResults.module)`:
  `typeChecker.ts::expressionRowScope` and `lib/commcare/xpath/formPathBinding.ts`'s provisional row.
  Before, both typed by `@case_type` / `@case_id` alone, so rule 3 could bind a custom property to
  another type that declares it and the checker's row type would disagree.
- **Parse copy** as written: the remote-search refusal ends "You can read the case the worker chose
  with #<own module type>/ instead." and drops "with #…/" when the module has no case type; the
  plan's backticks are left out, as in the other parse messages.
- **Order.** Also refused: `index-of` over results and `concat` of the results alone, which keep
  the node-set's order as `join` does (Core's `XPathConcatFunc`).
- **`link-source`'s sentence** ends "You can read a case property instead.", because a link cannot
  read a question.
- **The gate.** The edges are as planned (`referenceIndex.ts::expressionEdges` keys the read on the
  carrier's module, which for a link is the source form's module). A registration form added alone
  is refused by `SEARCH_FIRST_REQUIRES_CASE_FIRST_MODULE` before any search-results rule, so what
  reaches `SEARCH_RESULTS_NOT_SUPPLIED` is turning Search first off, moving the form out, or a batch
  that adds a registration form while turning Search first off; the docs say so. The
  scoped gate's module scope adds every form of a module whose Search settings change, and every
  link source (part 03 §3.8's correction).
- **The cap.** `lib/commcare/session.ts::SEARCH_RESULTS_CAP = 500`, beside `INLINE_SEARCH_RESULTS_SRC`,
  citing `CASE_SEARCH_MAX_RESULTS`, the `.size()` of `_get_initial_search_es` and the 1,500 toggle.
- **Preview** loads the snapshot in `FormScreen` through `hooks/useSearchResultsSnapshot.ts`, keyed by
  the attempt and its answers, the worker and the parent selection, not in `EngineController` by
  entry key, and finds the forms that read it by a walk of their expression slots, not the
  reference index; **Clear form keeps the entry's snapshot** (part 07 §3.2's correction).
  `evaluateFormSnapshot` refuses a form that reads results with no snapshot supplied; App Tests read
  the session's latest search; the MCP `evaluate_form` and App Tests' after-submit evaluation supply
  none yet (open).
- **Native proof and lane.** `formReadsTheResultsItsSearchReturned` reads the targeted document
  `targeted-inline-search-reads` rather than the `inline` producer scenario (part 08 §2.6's
  correction). The document as built: "Find patient" opens on Search, its "Check in" form counts the
  results and reads the chosen patient's district from its own result, its link condition reads the
  count, and "Register patient" (the no-matches form) starts its name from `#search/patient_name`.
  Core's evaluate opens no form with a search behind it, so the fixed value is a plain "Visit" form's
  answer, and the reads of the results run on every walk.

---

## 3. Inventory rows and manifest entries

Rows of `docs/research/2026-09-26-hq-round-trip/inventory/expressions-and-data.md`, "Secondary
instances", and their entries in `lib/commcare/surface/entries/expressions-and-data.json`. A
HELD-NEW or HELD entry allows a use alike in the lane's manifest check
(`proof/checks/manifest_usage.py::_standing_plan`: every non-REFUSED entry allows), so a flip is the
record of what Nova holds and its `slotChanges`, and changes no gate.

| Entry | Step 3 | Why |
|---|---|---|
| `session-data-datum` | **HELD** | `term session-datum` with `DatumRef` (§1) |
| `item-list-tag-read-in-any-other-expression` (`other-expression`) | **HELD** | form-logic and form-link lookup reads (§2.3) |
| `locations-flat-jr-fixture-locations-read-in-an-expression` (`flat-locations`, gate `LocationFixtureConfiguration.sync_flat_fixture`) | **HELD** | §2.4; the gate entry's confirmation already exists |
| `instance-id-current-path-roots` | **HELD** | the typed path roots (part 01 §2.3) |
| `xpath-location-paths` | **HELD** | part 01's typed steps; this part's instance paths are among them |
| `casedb-jr-instance-casedb`, `commcaresession-jr-instance-session`, `item-list-tag-read-through-nova-s-typed-lookup-carriers`, `selected-cases-search-selected-cases-parent-selected-cases-jr` | HELD (unchanged); `slotChanges` restated for the typed arms | §2.2, §2.3, §2.5 |
| `groups-jr-fixture-user-groups` | HELD-NEW | step 7, group 2 (§2.6) |
| `results-read-in-form-expressions-of-an-inline-search-module` | **HELD** | `cases { source: "search-results" }` in the forms of an inline-search module (§2.8) |
| `search-input-read-in-form-expressions-of-an-inline-search-module`, `search-input-results-read-in-the-search-results-detail` | HELD-NEW | step 4: Android does not keep the inputs |
| `session-data-stringquery`, `session-data-fingerprintquery` | HELD-NEW | step 4: Android only (§2.6) |
| `session-data-supply-point-id-in-an-advanced-form-whose-computed` | HELD-NEW | needs `Form.computedDatums`, step 7, group 6; `DatumRef` gains a `computed` kind there (§1.3) |
| `session-data-datum-hq-shorthand-in-navigation-slots` | **HELD**, in pull request 10 | a case chosen in an earlier menu, read in a case list's filter, an advanced search input and a form's display condition (§1.3, "Evaluation points"; decision 15), emitted as the expanded `instance('commcaresession')/session/data/<id>` path; the computed datums a navigation slot could also read wait for step 7, group 6 |
| `session-context-drift`, `-window-width`, `-applanguage` | HELD-NEW (part 01, Departures) | their values differ per platform; step 4 offers them; the stored enum holds all seven |
| `case-search/instance-name-without-casedb-ledgerdb-fixture-or-session-in-it` (`caseSearchConfig.resultsInstanceName`, in `lib/commcare/surface/entries/case-search.json`) | HELD-NEW | a setting Nova does not hold yet, step 7, group 5; §2.8 prints `results:inline` until then |
| `results-read-in-form-expressions-reached-through-a-search-that` | REFUSED (unchanged) | the remote search's rewind drops the query step; the parser refuses `instance('results')` (§2.8) |
| `commtrack-locations-hierarchical` (class `hierarchical-locations`) | REFUSED (unchanged) | a form link's `locations` read now reaches a suite declaration (§2.4), so the class gains its reader `hierarchical_locations` in pull request 9, instances and session (part 08 §5.2) |

**Implementation correction, 2026-10-19:** pull request 9 also flips `jr-itext-id` and
`jr-choice-name-value-path-on-a-static-choice-select` to HELD (decision 10's correction), so its
flips are eight, each with its `narrow:` slot change written into the disposition cell and held by
`manifest.test.ts`; `xpath-location-paths` has no inventory row (it is export use).
`commtrack-locations-hierarchical`'s class gains `hierarchical_locations`, and its `KNOWN_GAPS` entry
in `test_manifest_value_classes.py` is removed.

The six flips of pull request 9 and the navigation-slot flip of pull request 10 are part 08 §5.1's
part-05 row, each edited in `lib/commcare/surface/entries/expressions-and-data.json` and the
inventory row, held by `lib/commcare/surface/__tests__/manifest.test.ts`, in its pull request. The REFUSED rows stay refused and the parser makes each unrepresentable: `ledgerdb`,
`commtrack:*`, reports, `registry`, `schedule:*`, `indicators:*`, `case-search-fixture:*`, inline
instances, legacy `search-input`, results and search inputs reached through a search that is not
inline (part 01 §1.5). The INERT "declared, unreferenced" rows get no Nova instance, since nothing
is declared unread.

---

## 4. Authoring surface for each read

Every read in step 3's scope is complete: domain arm, checker, emitter, Preview, builder, SA and
MCP, docs and proof.

| Read | Text grammar (form logic) | Builder | SA and MCP | Docs |
|---|---|---|---|---|
| session datum | `instance('commcaresession')/session/data/<id>` | completion after `/session/data/` lists the entry's supplied ids labelled by meaning ("The case chosen in Households", "This form's new household case"); the editor renders a resolved read as a chip with that label (`lib/codemirror/xpath-chips.ts`) | the parser resolves the id; tool reads print it; no new teaching, because `#<type>/case_id` remains the way to read a selected or created case and covers the common need | the form-logic page names session values and that Preview reads the id a new case gets |
| form-link datum name | the name string, unchanged | rows labelled by meaning (§1.5) | unchanged schema; the refusal lists the ids the target asks for | unchanged |
| chosen case in a record slot (pull request 10) | record dialect `chosen-case('<menu name>')`, `chosen-case-property('<menu name>', '<property>')` (part 02 §2.2) | the card editor's value source menu offers "The case chosen in <menu>" and its properties, listing only the menus the slot's evaluation point holds (part 02 §4.5) | `reference.ts`'s chosen-case sentence (part 02 §3.1) | part 06's search and case-list docs |
| casedb query | as today | completion of case types, properties and `index/<identifier>` inside `instance('casedb')/casedb/case[…]` | as today (`reference.ts`) | as today |
| lookup table | `instance('<tag>')/<tag>_list/<tag>[…]` and `item-list:<tag>` | completion of table tags (labelled by table name) after `instance(`, columns after the row step | `reference.ts` gains a form-logic lookup paragraph naming `get_lookup_tables` for tags and column names | `building-with-nova.mdx` drops "cannot name a lookup table" and shows a read |
| flat locations | `instance('locations')/locations/location[…]/…` | completion of `@type` with level codes, `@<code>_id`, the row fields and `location_data/<slug>`, offered only when the app has levels | `reference.ts` gains a places paragraph | the organization page shows reading a place's name or a property |
| selected cases | `instance('<datum id>')/results/value` | completion in a batch form only | `reference.ts`'s several-case paragraph names `count(instance('selected_cases')/results/value)` | the several-case docs say how to show the count |
| search results | `instance('results:inline')/results/case[not(commcare_is_related_case = true())][…]` | completion of the module's properties and the row attributes, only in a form whose entry carries the inline query; chip "What the search found" (§2.8) | `reference.ts`'s search-first paragraph gains the count example | `case-workspace.mdx`, "Search first", gains the paragraph of §2.8 |

The builder's completion and chip work is part 02's to integrate; this part gives what each
completion offers and its labels. The session datum read is parsed, stored and checked from pull
request 5, the shape, and Preview supplies it from pull request 7. Every completion source of this
table, the session datum's included, rides pull request 9, instances and session, on today's
Lezer-node detection, and the four form-logic lookup extractors of §2.3 ride it too; every chip
rides pull request 11, the builder, whose chips come from parse spans. The SA guide changes are
model-facing, so pull request 9 bumps `MODEL_CONTEXT_VERSION` to
`"v4-hq-round-trip-expressions.9"` (each pull request that changes model-facing schema or prose
bumps it; the stack bumps in pull requests 3, 5, 9, 10 and 12). Each docs cell lands in the pull
request whose behavior it describes (part 10, "Public docs that change"): every cell of this table
in pull request 9 but the session values paragraph, which part 10 splits: its reading and
Preview's supply land in pull request 7 with the session map, and its sentence on the editor's list
lands in 9 with the completion source. The sibling `../nova-plugin` repository's prose is swept
for any claim that raw XPath cannot read a table (part 10, the nova-plugin check).

**Implementation correction, 2026-10-19: the completion sources and guide, as built (pull request
9).** `lib/codemirror/xpath-lint.ts`'s reference context gains `instanceReads`, built in
`buildLintContext.ts` from the slot's checker context and `entryDatumIds` with the checker's own
admission: tables; places only when the app has levels; the several-case datum id only in a question
of a several-case form; `results:inline` only where the entry carries the inline query and the form is
not the no-matches form; `search-input:results:inline` in the no-matches form; and the session values
labelled by meaning ("The case chosen in Patients", "This form's new patient case").
`xpath-autocomplete.ts`'s `instanceSource` completes the id inside `instance('…')`, each step below
each instance (for `results:inline` the exclusion row is the only row offered), row predicates and
level codes after `@type = '`, detected on Lezer nodes alone; the function source stands aside inside
a quoted value. `groups` and `results` are never offered. The editor's `search-input` paths follow the
parser, which reads exactly Core's `/input/field[@name = '…']` with the name quoted
(`VirtualInstances.java::buildSearchInputInstance`), the shape `#search/<name>` prints; the
`…/results/inputs/<name>` spelling an earlier draft of the parser accepted is refused with the
unknown-search-input sentence (implementation correction, 2026-10-19). The guide (`reference.ts`) gains item 3 and item 6
of part 02 §3.1 as written, and `MODEL_CONTEXT_VERSION` is not bumped in this pull request: the stack
deploys once, and pull request 12 sets the final value. `../nova-plugin`'s
`skills/upload_to_hq/SKILL.md` says a table is left behind when "the last question reading it is
gone"; form logic, Connect and links read tables too, so "the last read of it" is the accurate claim.

---

## 5. Tests and proofs

Each test names its contract and the failure it catches (`docs/testing.md`). Each lands with the
behavior it holds. In pull request 5, the shape: the form points of
`lib/domain/__tests__/entryDatumSupplies.test.ts`, `entryDatumIds.test.ts`'s session rows and its
agreement case, the session parser round trips and refusals, `sessionData.test.ts`, the link-datum
gate test, and `targeted-session-reads` (its `DatumRef` reads) with the session-read scenarios of
`FormLinkRuntimeTest`, `NestedMenuRuntimeTest` and `TileGroupingRuntimeTest`. In pull request 7,
Preview: `entrySessionData.test.ts` and `entryCaseIds.postgres.test.ts`. In pull request 10, CSQL:
the record points with `not-before` and `differs` (`entryDatumSupplies.test.ts`, `sessionData.test.ts`).
Every other test below, `entryDatumIds.test.ts`'s search-results row, the search-results cases of
`formLogicFindings.test.ts` and `targeted-session-reads`'s batch form among them, in pull request 9,
instances and session.

- Pure, `lib/domain/__tests__/entryDatumSupplies.test.ts` (new): the set at the form point for each
  kind over shapes A, B and C of the datum projection probe, a several-case parent, a grouped tile,
  a worker-record write and a child menu aligned to a root selection; the alignment match the
  domain half exports, which `alignWithRootMenu` reads. From pull request 10 the record points over
  Villages → Households → Members: Members' `case-list` and `search` points hold Villages and
  Households; Households' points list Villages under `differs`, because Members selects through
  Households' list and holds the village at another id there; a case-first
  module's `form-menu` point holds its own selection, a forms-first module's holds none, and a
  module's own display condition has no point. Catches a set that follows the datum's id, and a
  list admitted to read a choice whose id differs between the entries it runs in.
- Pure, `lib/commcare/__tests__/entryDatumIds.test.ts` (new): the same shapes; each row's id and
  refs, the placeholders, and that `new-case` prints the id the case block reads. Its agreement
  case holds, for every entry of the expander corpus and the fuzz documents, that the refs the rows
  list are the domain half's set at the form's point. From pull request 10 it also holds `chainId`:
  Members, a child of the root case-first Households with parent-select Households, lists the
  household at `id` `case_id` and `chainId` `parent_id`, and an entry with no root alignment has
  `chainId` equal to `id`. Catches a print that follows the renamed datum, an HQ JSON filter written
  with the aligned id, and two halves that drift.
- Pure, parser round trips (`lib/commcare/xpath/__tests__`): every arm of §2.1 parses from both
  spellings and prints canonically per target; each deferred and refused instance is a parse issue
  with its sentence.
- Pure, `lib/commcare/validator/__tests__/sessionData.test.ts` (part 03 §3.9's file, through
  `runValidation`, since the rule is the checker's): each kind accepted where
  supplied and refused after the edit that stops it (module removal, several-case switch, child
  writer removed, grouping off), paired; the placeholder and multi-select refusals. From pull
  request 10, paired per record point: `chosen-case('Villages')` in Members' list filter accepted,
  and refused with `not-before` once Members stops selecting through Households; the same read in
  Households' filter refused with `differs`; a case-first form's display condition accepted and refused
  after a registration form joins its module; each refusal with its sentence (§1.6).
- Pure, parser (`lib/commcare/xpath/__tests__`), the row type of §2.2: a custom property in a query
  with no `@case_type` binds to the one type declaring it and stores it, and a second declaration
  added afterwards leaves the stored leaf unchanged; no declaring type and two declaring types each
  refuse with `case-query-untyped`; `@status`, `@owner_id` and `index/<identifier>` read with no
  row type are admitted; a `@case_id` compared with each `DatumRef` kind types the row by §1.3's
  `caseIdOf` and `tile-group-parents` types none. Catches a binding that reads the catalog again at
  print time.
- Pure, checker: `instance('casedb')/casedb/case[@case_type = 't'][p = x]/q` as a slot result and
  opposite `=` accepted; a selected-cases value as one value refused with `XPATH_MANY_VALUES`
  beside the same read under `count` accepted (§2.5); a `casedb` row's `last_modified` ordered
  against `now()` in a field slot refused with `day-only-on-device`, and a results row's ordered
  against `now()` accepted (part 04 §3.4); a results row's `date_opened` against a moment that is
  not day-aligned, and under `=` against a day-aligned operand, refused with `day-only-on-device`,
  and ordered against a day-aligned operand accepted (part 04 §3.4). Catches a day rule keyed on
  `casedb` alone.
- Pure, `lib/doc` gate tests: a module removal refused while a link datum names it; a tag rename
  reprints a form-logic read and rewrites nothing.
- Preview, `lib/preview/engine/__tests__/entrySessionData.test.ts`: values for every kind over a
  fixture casedb, the same map at a same-entry rebuild, a new map after Clear form.
- Postgres, `lib/case-store/postgres/__tests__/entryCaseIds.postgres.test.ts`: a registration whose
  hidden value reads `#<own>/case_id` and a child id; the stored primary and child carry those
  values; an exact retry replays; a taken id refuses with `case-id-taken`.
- Native Core (`proof/native/core`), in pull request 5 with session datum identity:
  `FormLinkRuntimeTest` and `NestedMenuRuntimeTest` gain session reads of each kind through Core's
  session, asserting the value read equals the case the case block creates, on the local archive
  and HQ's regenerated form, and `TileGroupingRuntimeTest` reads the companion datum. In pull
  request 9 with the instance reads: `LookupRuntimeTest` gains a form-logic `table-rows` read and a
  link condition reading `item-list:<tag>`; `LocationOwnerRuntimeTest` gains a form-logic
  `locations` read and a link condition reading a place's name; `SearchRuntimeTest` gains §2.8's
  scenario. Each new scenario is a producer document under part 08 §2.6's rule: appended after its
  fixture's last scenario with every entity named, and the pull request that appends it diffs every
  fixed document's `edit/batch.json` at base and head with no Docker; a scenario that moves another
  document's batch becomes a targeted document instead.
- Lane value classes: `proof/checks/test_manifest_value_classes.py` pairs
  `hierarchical_locations` (True for `jr://fixture/commtrack:locations`, False for
  `jr://fixture/locations`, None for another source), §2.4.
- Pure, `lib/commcare/__tests__/entryDatumIds.test.ts` and the domain half's test (as above) also:
  the inline scenario's query row and the domain set carry `searchResults { module }`; an ordinary
  module's and the no-matches form's entries carry none. Catches a results read admitted where no
  query step exists.
- Pure, part 03's `lib/commcare/validator/__tests__/formLogicFindings.test.ts`, which holds these
  cases because the rules run in the checker's admission and typing and no rule file of their own
  exists (part 03 §3.8; it calls `runValidation`): a count read
  accepted in a search-first module's follow-up form and in its link condition; refused after Search
  first is turned off, in the no-matches form, and in a link whose source form is outside the module,
  each with its reason (`SEARCH_RESULTS_NOT_SUPPLIED`); `SEARCH_RESULTS_READ_INVALID` with reason
  `order` refuses `[1]`, `position()` and `join` over results while `count` and a `@case_id`
  predicate are admitted, and with reason `other-type` refuses another `@case_type`. Paired accept
  and refuse per rule.
- Pure, parser: text without the related-case exclusion and text naming `instance('results')` are
  parse issues with their sentences; the canonical print round-trips.
- Pure, `lib/preview/engine/__tests__/searchResultsXPathInstance.test.ts`: the instance's shape over
  fixed rows against HQ's `CaseDBXMLGenerator` element order and spellings (six-digit `last_modified`,
  date-only `date_opened`, `external_id` only when set, a `datetime` property in HQ's stored
  spelling). Catches a casedb-shaped row (`DateData` day) standing in for a results row.
- Postgres, `lib/preview/engine/__tests__/searchResultsSnapshot.postgres.test.ts`: the snapshot of a
  completed attempt holds every open match of the module's type (not one page), stops at 500 with
  `totalMatches` the full count, holds no closed case, and holds a Project case outside the
  persona's restore scope while the module's owner exclusion still drops its excluded owner (§2.8,
  the population). Catches the 50-row page reaching the form, and a restore-scoped read standing in
  for HQ's search.
- Native Core: `SearchRuntimeTest.formReadsTheResultsItsSearchReturned` (§2.8).
- Lane: part 08 §4.5's three targeted documents for this part, with explicit identities:
  `targeted-session-reads` (`sessionReads.ts`: from pull request 5, one read of each `DatumRef`
  kind, each value equal to the id the session or the case block holds, and its D′ edit gives the
  read's source module a parent menu, which renames the entry's datum, while proof 5 holds the
  reprint inside the footprint; from pull request 9, a batch form's
  `count(instance('selected_cases')/results/value)`, which lands with the other new instance reads),
  `targeted-instance-reads` (`instanceReads.ts`: a form-logic `table-lookup` and `table-rows` count,
  a link condition reading `item-list:<tag>`, a flat `locations` read of a place's name and a
  location property, and a link condition reading a place's name (§2.4), with levels, places and
  the flat fixture confirmed; no edit) and `targeted-inline-search-reads` (`inlineSearchReads.ts`,
  §2.8; no edit), run through proofs 1 to 5 with every walk held to its end. Proof 1 holds a datum
  read's derived id across two publishes of one revision (part 08 §5). `targeted-session-reads`
  lands with session datum identity, with the three Core classes' session-read scenarios above, so
  the pull request that changes datum reads carries their lane evidence, and R5 reads it with every
  reader before that merge (part 08 §6.4); pull request 9 adds the batch form's `selected_cases`
  read to it, so by the exit it reads every session datum kind and a batch form's selected cases,
  and the new instance reads' documents and scenarios land in 9 too. Pull request 10 adds the
  chosen case in a record slot to part 08's `targeted-csql-composition`, whose search narrows by
  the case chosen in an earlier menu (part 08 §4.5).

**Implementation correction, 2026-10-19: the tests of pull request 9, as built.**

- The three Core scenarios are targeted documents from the start, not producer appends (PR 5's
  appends moved other documents' batches): `LookupRuntimeTest.formLogicAndItsLinkReadTheTableByItsTag`
  and `LocationOwnerRuntimeTest.formLogicAndItsLinkReadPlacesFromRealIndexedFixture` read
  `targeted-instance-reads`, and `SearchRuntimeTest.formReadsTheResultsItsSearchReturned` reads
  `targeted-inline-search-reads`, each on the local archive and on HQ's regenerated form and suite
  (part 08 §2.6's correction). No producer changes.
- Pure and gate tests: `lib/commcare/validator/__tests__/instanceReadAdmission.test.ts` (replacing
  `deferredInstanceAdmission.test.ts`, over `lib/domain/expression/__tests__/instanceReadsFixture.ts`),
  `lib/doc/__tests__/instanceReadReferences.test.ts` (each read's reference edge, and the gate
  refusing turning Search first off, moving the form and a registration batch, each with
  `not-search-first` or `link-source`, beside a rename that commits),
  `lib/doc/__tests__/formLogicLookupReferences.test.ts` (§2.3's correction),
  `lib/commcare/__tests__/instanceReadEmission.test.ts` over `instanceReadFixture.ts` (each arm's
  XForm declaration, the double-quoted fixture source, the link text HQ receives and the suite
  entry's `item-list:regions`, `results:inline` and `locations`),
  `lib/commcare/xpath/__tests__/instanceReads.roundtrip.test.ts` (each arm, `item-list:<tag>`
  printing back as the bare tag in a form, the row typing beside its `case-query-untyped` contrast,
  both parse sentences), and `lib/codemirror/__tests__/instanceCompletion.test.ts` (each offer
  completed to a read the editor's parser and checker admit). `typeChecker.test.ts`,
  `formLogicFindings.test.ts`, `gate.test.ts`, `sessionData.test.ts`, `entryDatumIds.test.ts`,
  `entryDatumSupplies.test.ts`, `fromExpression.test.ts`, `instantAgreement.test.ts` and
  `planPrivileges.test.ts` are extended.
- Preview: `searchResultsXPathInstance.test.ts`, `formText.test.ts`,
  `formEngineInstanceReads.test.ts` (every read in question logic and in links, through the
  synchronous engine and the worker), `lib/preview/xpath/__tests__/formTextFunctions.test.ts`, and
  `searchResultsSnapshot.postgres.test.ts`, which CI runs. The refusal panel and the cap line have
  no automated test yet; they need a Playwright smoke.

## 6. Production and the cutover

### 6.1 What production holds (executed during planning)

The production shape scans ran read-only during planning (2026-10-17, under the person's standing
permission for read-only production reads), each in one `REPEATABLE READ, READ ONLY` transaction,
content-free (closed labels and counts only), over live apps; every app was read, none unreadable,
with no scan failure.

| Shape | Production | What it means for step 3 |
|---|---|---|
| `instance(…)` calls | every one a `casedb` query or a `commcaresession` read; no other instance id | nothing else to lift |
| `session/data/<id>` reads | some, in field form logic and in Connect slots; all `case_id`, all `selected-case` | each lifts to `selected-case { module }` against pull request 5's parser; no placeholder, multi-select, query (`stringquery`, `fingerprintquery`) or unsupplied read, so §1.6's new refusals and the `device-query` deferral meet nothing |
| `session/context/<f>` reads | some, of `userid` and `username` | all among the four step 3 authors; none of `drift`, `window_width`, `applanguage` |
| form links | a condition and no manual datums; the condition reads no `session/data` | no datum name to lift (§1.5) |
| `groups`, `results`, `results:inline`, `search-input*`, `locations`, `selected_cases`, lookup tags in text | none | nothing to lift or refuse; the deferrals of §2.6 strand nothing stored |
| `casedb` queries | most typed by a `@case_type` literal, the rest of the typed ones by a `@case_id` from a known source (a cases-select answer, a query-repeat row id, a selected-case datum) | rules 1 and 2 of §2.2 |
| `casedb` queries with no row type reading a row value | some (the case id from a Hidden Value, `selected-at`, a nested `casedb` read, a relative path); by part 09's probe, standard reads, reads that bind to one type, reads that match several, and reads typed by `@case_id` after all | the standard reads need no type; rule 3 of §2.2 binds the one-type reads; those that match several are blockers the author resolves; the last are declarations (next row) |
| property reads outside the effective catalog in `casedb` queries | a few, all text use: some in a query typed by a `@case_type` literal, the rest in queries with no literal, which part 09's probe shows are typed by `@case_id` from a known source | all are typed reads, so the cutover declares them, all `text` (§2.2; part 09 step 5) |
| raw `casedb` reads of `date_opened` / `last_modified` | a few | candidates for `day-only-on-device` (§2.2) |
| `casedb` queries used as one value | some slot results and operands of `=` and `div`; every other many-row read in `count`, `sum`, `join`, `max` or an `ids_query` result | admitted (§2.2) |
| `selected-cases` reads used as one value | none (no `selected_cases` read at all, above) | no lift; a stored one would be a `target-gate` blocker (part 09) |
| structural repeat reads used as one value | a few, in `concat` and `selected` | part 01's and the cutover's: each lifts to its first row with notice reason `repeat-read-takes-first-row`; not this part's reads |
| `app_changes` after each app's step 2 fold baseline | none | the step 3 horizon's opaque suffix is whatever accrues before the window |

### 6.2 What remains for the cutover's dry run

The dry run lifts every document at the stack's head with the frozen printer and the production
parser against the target document (part 09) and reports, for this part:

1. **The session reads:** each lifts, against pull request 5's parser and `entryDatumSupplies`, to
   a `selected-case { module }` that `entryDatumSupplies` lists for the form's entry; the expected
   result is every read lifting, with no `unknown-datum`, `multi-select-datum-value` or placeholder
   refusal. Any refusal is an `expression-parse-refused` blocker the author resolves (part 09
   §11).
2. **The `casedb` queries with no row type:** each custom property read in a query typed neither
   way binds under §2.2's rule 3 to exactly one case type of the target document's effective
   catalog. The dry run lists each read that binds to no type or to several, by app; each is a
   blocker the author resolves before the window. Part 09's probe, over the scanner's index,
   expects some in a few apps that several types declare and none that no type declares; the dry
   run's production binder replaces that expectation.
3. **The typed reads of an undeclared property** (typed by a `@case_type` literal or by a
   `@case_id` from a known source): the cutover declares each on its row's type, all `text`; the
   dry run lists the declarations it would add and the notice names them.
4. **The raw system-date reads:** the dry run reports any that `day-only-on-device` refuses after
   the lift; each is a `target-gate` blocker the author resolves before the window (part 04 §5.5,
   part 09 §11).
5. **The row types of the typed queries:** the dry run confirms rules 1 and 2 give the scan's
   types and reports any query whose literal names a case type the catalog lacks.
6. **No finding of this part's rules over lifted documents:** `SESSION_DATUM_NOT_SUPPLIED`,
   `SEARCH_RESULTS_NOT_SUPPLIED`, `LOCATIONS_READ_NEEDS_ORGANIZATION`, `FORM_LINK_DATUM_UNUSED`,
   `XPATH_MANY_VALUES` on a selected-cases read and `SEARCH_RESULTS_READ_INVALID` are each expected
   at zero, since production holds none of their reads; a non-zero count is a lift defect, not a
   cutover decision.

The dry run replays no history after the step 2 baseline: the cutover lifts each app's head, which
already holds every committed edit, and the history behind it becomes opaque (part 09 §1), so items
1 to 6 over the heads cover every edit made after the baseline.

Nothing else of this part needs the dry run: no lookup, location, selected-cases or search-results
read exists in stored text, the ids Preview mints (§1.8) change no stored case row, and the lookup
reference edges need no rewrite (§2.3).

---

## 7. How this part lands in the stack

The stack is fifteen pull requests in one `gh stack` chain, merged together in one deploy (part 10
holds it in full). This part lands in four of them:

- **Pull request 5, the shape:** session datum identity (§1): `DatumRef`, `FormLinkDatumName`, the
  domain half `lib/domain/entryDatumSupplies.ts` at the form points with the alignment match
  `alignWithRootMenu` now reads, the id half `formLinkProjection.ts::entryDatumIds`, the `datum`
  family serving today's bytes (part 01 §6.3), the datum parse refusals, `SESSION_DATUM_NOT_SUPPLIED`
  over identity with entry supply in the checker, and `rules/sessionData.ts` leaving;
  `targeted-session-reads` with its `DatumRef` reads, and the session-read scenarios of
  `FormLinkRuntimeTest`, `NestedMenuRuntimeTest` and `TileGroupingRuntimeTest`. The session reads
  production holds lift against it there; the lift itself is written in pull request 13, the
  cutover.
- **Pull request 7, Preview:** §1.8's session map (`entrySessionData`, the submission's minted ids
  in `submissionEnvelope.ts::applyOrdinaryAction` and the after-submit map), because that pull
  request's Preview target prints every case read through `session/data` (part 07 §8).
- **Pull request 9, instances and session:** the new instance reads of §2 (lookups in form logic,
  flat `locations`, `selected-cases`, search results, `jr:itext`, `jr:choice-name`), with their
  `toWire` rows (part 04 §8.5), profile admission and Preview supplies (part 07 §3.2's snapshot),
  the day rule over results rows (part 04 §3.4), `SEARCH_RESULTS_NOT_SUPPLIED`,
  `SEARCH_RESULTS_READ_INVALID` (its cases in part 03's `formLogicFindings.test.ts`),
  `LOCATIONS_READ_NEEDS_ORGANIZATION`, the four form-logic lookup extractors, the completion
  sources of §4 and the guide rows, which bump `MODEL_CONTEXT_VERSION` to `".9"`, the six manifest
  flips, `hierarchical_locations`, the batch form's `selected_cases` read added to
  `targeted-session-reads`, `targeted-instance-reads`, `targeted-inline-search-reads`,
  `targeted-text-reads` (the `jr:itext` and `jr:choice-name` reads) and the new
  Core scenarios of `LookupRuntimeTest`, `LocationOwnerRuntimeTest` and `SearchRuntimeTest`. The
  chips ride pull request 11, the builder.
  **Implementation correction, 2026-10-19:** no lookup extractor is added (decision 9), the flips
  are eight (decision 10), `MODEL_CONTEXT_VERSION` is not bumped (pull request 12 sets the final
  value, since the stack deploys once), the worker protocol stays 8, and the Core scenarios read
  targeted documents (§5's correction).
- **Pull request 10, CSQL:** the chosen case's supply (decision 15): the `case-list`, `search` and
  `form-menu` points of the domain half, `SESSION_DATUM_NOT_SUPPLIED` at those points with the
  record sentences and the reasons `not-before` and `differs` (§1.6), the reference-index refusals of §1.7, Preview's
  readers at those points (§1.8, part 07), the case list filter's HQ JSON print through `chainId`
  (§1.3, "The case list filter's two prints"), and the navigation-slot manifest flip (§3). Part 01 §4,
  part 02 and part 06 §3.9 carry the arm's admission, its record spelling and cards, and its CSQL
  emission and fold.

Each public docs row lands in the pull request whose behavior it describes (§4; part 10, "Public
docs that change").

---

## Departures

Each is a departure from the outline or from step 2's behavior, with its reason.

- **Stricter than step 2's rule.** Reads of placeholder datums and of a multi-select datum's value
  (a stored instance's id), which `sessionDatumNotSupplied` admits today because the entry declares
  the id, are refused from step 3: neither names a case the author can mean.
- **Preview mints new case ids at entry and the case store creates with them** (§1.8). Today the
  store mints a `uuidv7()` at submit and a form that reads its new case's id reads blank in
  Preview. The departure changes the id an ordinary create gets (a UUIDv5 of the app, entry key and
  supplying ref) and adds the `case-id-taken` refusal.
- **The outline lists user groups, and search results and inputs, among step 3's typed instance
  references** (its item 3). Search results stay (§2.8). `groups` and the inputs read in an
  inline-search module's ordinary forms leave step 3 with the reasons of §2.6: `groups` depends on
  case sharing, a concept step 7, group 2 owns; the inputs depend on the platform declaration, step
  4.
- **`LOCATIONS_READ_NEEDS_ORGANIZATION`** refuses a place read in an app that has no organization,
  rather than letting it read places made in HQ that Preview cannot show.
- **A search-results read always excludes the related cases HQ appends** (§2.8): the parser refuses
  text without the exclusion rather than reading rows whose set depends on HQ's reading of the
  app's details.
- **Order-sensitive reads of search results are refused** (§2.8): HQ orders by relevance score,
  which Preview cannot reproduce.
- **A case list's filter or search reads a chosen case only at one datum id** (§1.3, "One id per
  slot"), where HQ's editor takes any text: HQ writes the module's one filter into every entry the
  list runs in, and where the chosen datum's id differs between them no single text is right in
  all.

## Executed during planning

Nothing here was a paid call, and no served reader ran on a local machine. The local probes are
planning scripts, run from the repo root at `5cf6e327` with `npx tsx --conditions=react-server`,
with no network and no Docker, and the working tree left clean; they are not committed.

- **The production shape scans** (2026-10-17, read-only, each through
  `scripts/lib/prodDb.ts::targetProdDb` in one `REPEATABLE READ, READ ONLY` transaction, emitting
  closed labels and counts only, no ids, names, text or values: the first run by the person, the
  second by planning under the person's standing permission for read-only production reads). This
  part relies on their inventory of `instance` calls, `casedb` queries and their predicate and
  final-step classes, session data, context and user reads, form links and their manual datums and
  conditions, case typing by literal and by `@case_id` source, the untyped-query classes, property
  reads outside the catalog, raw system-date reads, and the many-value classes (§2.2, §2.3, §6.1).
  The scanner's classifier (its session path reader, the `instance` case of its path walk and its
  form-link loop) was read to confirm what an absent class means.
- **Part 09's production probe** (read-only, the same transaction and content rules, under the
  person's standing permission): every property read outside the catalog is in a typed query, the
  ones in queries with no `@case_type` literal being typed by a `@case_id` from a known source; and
  the queries typed neither way split into standard reads, reads that bind to one type and reads
  that match several (§2.2, §6).
- **The datum projection probe**, over Nova's own `buildDoc`, `formLinkProjectionContext`,
  `entrySessionDatums`, `entrySelectionDatumSources`, `newCaseIdDatumId` and
  `subcaseSessionDatumId`. Output:

  ```
  A  Households / Register: case_id_new_household_0=fn[household], case_id_new_member_1=fn[member]
     case block reads new case: case_id_new_household_0; subcase member: case_id_new_member_1;
     repeat subcase member: uuid() calculate
  B  Households / Register household: case_id_new_household_0=fn[household]
     Households / Visit household: case_id[household]  (source Households)
     More households / Register another: case_id_new_household_0=fn(fromParent)[household],
       case_id_new_household_0_household=fn[household]; case block reads case_id_new_household_0
     More households / Follow up again: case_id_new_household_0=fn(fromParent)[household],
       case_id[household]  (source More households)
  C  Households / Visit: case_id  (source Households)
     Members / Check member: parent_id (source Households), case_id (source Members)
  ```

- **The datum supply reading**, at `5cf6e327`: `formLinkProjection.ts::selectableDatums`,
  `alignWithRootMenu`, `withInlineSearchQueries`, `entrySessionDatums`, `entrySelectionDatumSources`,
  `session.ts::deriveSessionDatums` and `formActions.ts::buildFormActions`, with
  `lib/domain/forms.ts::isCaseFirstModule`, `lib/domain/modules.ts::caseSelectionCanFlowBetweenModules`,
  `::moduleOpensOnSearch` and `lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory`. Every
  input that decides whether a datum exists, what it selects and whether it is aligned is a domain
  read; `lib/commcare` alone holds the ids and the wire detail, so the domain half of §1.3 needs no
  wire vocabulary.
- **HQ's root-alignment rename of the case list filter**, read at commcare-hq `d6c6e16d8ae1`
  (§1.3, "The case list filter's two prints"): `suite_xml/sections/entries.py::EntriesHelper.get_filter_xpath`,
  `::get_datum_meta_module` (the filter in each chain datum's nodeset, `use_filter=True`),
  `::get_case_datums_basic_module` (the chain, then `add_parent_datums`), `::add_parent_datums` and its
  `set_id` (the collision rename to `<id>_<case_type>`, then the same-case match to the root's id),
  `_update_refs` (`str.replace` of the session variable over every datum's `nodeset` and `function`),
  `::configure_entry_module_form` (`add_remote_query_datums` after the chain is aligned), and
  `post_process/remote_requests.py::RemoteRequestFactory._remote_request_query_datums` (each default
  property's `defaultValue` copied verbatim into a `<data ref>`). Against Nova's
  `formLinkProjection.ts::alignWithRootMenu` and `refreshDatumReferences`, which re-render the local
  nodeset after the rename: the local suite and HQ's build print the same aligned id when HQ JSON
  holds the id before alignment.
- **Core's claim point**, read at commcare-core `8e9ba8d908e9` (part 07 §3.5):
  `org/commcare/session/CommCareSession.java::getNeededData` returns `STATE_SYNC_REQUEST` only in
  its `entriesForCurrentCommand.size() == 1` branch with `getEntryForCommand(currentCmd)` naming an
  entry whose `<post>` is relevant, so through a menu the claim of a search-first module waits for
  the form command.
- **The search results probe**, over `lib/commcare/__tests__/endpointWireFixture.ts`'s `inline`
  scenario, `formLinkProjectionContext`, `entrySessionDatums` and
  `xpathCarrierAllowedInstanceIds`. Output:

  ```
  entry datums: results:inline [query storage-instance=results:inline], case_id
  carrier allowed instance ids: casedb, commcaresession
  query datum: {"id":"results:inline","caseType":"patient","storageInstance":"results:inline","defaultSearch":false}
  ```

- Read at the pins for search results (§2.6, §2.8): Core
  `org/commcare/session/CommCareSession.java::setQueryDatum`, `::syncState`, `::getNeededData`,
  `::getEvaluationContext`; `org/commcare/suite/model/StackFrameStep.java` (`addDataInstanceSource`,
  `hasDataInstanceSource`, `getDataInstanceSource`, `getDataInstanceSourceById`,
  `initDataInstanceSources`, `getInstances`); `org/javarosa/core/model/instance/ExternalDataInstanceSource.java`
  (`needsInit`, `getRoot`, `remoteInit`); `org/commcare/core/process/CommCareInstanceInitializer.java`
  (`generateRoot`, `setupExternalDataInstance`, `getExternalDataInstanceSource`,
  `getExternalDataInstanceSourceById`, `isNonUniqueReference`); `org/commcare/modern/session/SessionWrapper.java::prepareExternalSources`;
  `src/cli/java/org/commcare/util/screen/SyncScreen.java::handleInputAndUpdateSession`,
  `::updateSessionOnSuccess`. Formplayer `session/FormSession.java::initialize`,
  `session/FormplayerSessionWrapper.java` (constructors), `session/MenuSession.java` (the
  `STATE_SYNC_REQUEST` arm), `screens/FormplayerSyncScreen.java`. Android
  `activities/QueryRequestActivity.java` (`setQueryDatum`), `models/AndroidSessionWrapper.java::prepareExternalSources`,
  `utils/AndroidInstanceInitializer.java`, `activities/HomeScreenBaseActivity.java::showSessionRefreshWarning`.
  HQ `app_manager/suite_xml/post_process/instances.py::remote_instances`, `::search_input_instances`,
  `::location_fixture_instances` (the HIERARCHICAL_LOCATION_FIXTURE and `sync_flat_fixture`
  branch), `InstancesHelper.add_entry_instances`, `::_get_all_xpaths_for_entry`, `IGNORED_INSTANCES`;
  `app_manager/suite_xml/utils.py::is_valid_results_instance_name`;
  `case_search/utils.py::get_case_search_results`, `::get_unconfigured_endpoint_results`,
  `::get_primary_case_search_results`, `CaseSearchQueryBuilder` (`build_query`,
  `_get_initial_search_es`, `_apply_sort`), `::get_and_tag_related_cases`,
  `::get_related_cases_result`, `::_get_all_related_cases`, `::get_child_case_results`,
  `::_tag_is_related_case`, `QueryHelper.wrap_case`; `case_search/const.py::CASE_SEARCH_MAX_RESULTS`,
  `RELEVANCE_SCORE`; `es/case_search.py::wrap_case_search_hit`; `corehq/toggles/__init__.py::INCREASED_MAX_SEARCH_RESULTS`;
  `casexml/apps/case/fixtures.py::CaseDBFixture`; `casexml/apps/case/xml/generator.py`
  (`CaseDBXMLGenerator`, `V2CaseXMLGenerator.add_custom_properties`, `datetime_to_xml_string`);
  `casexml/apps/phone/data_providers/case/livequery.py::get_all_related_live_cases`. Nova
  `lib/commcare/formLinkProjection.ts::withInlineSearchQueries`, `lib/commcare/session.ts`
  (`INLINE_SEARCH_RESULTS_INSTANCE`, `INLINE_SEARCH_RESULTS_SRC`, `EXCLUDE_RELATED_CASES_FILTER`), `lib/commcare/xpath/carriers.ts`,
  `lib/commcare/CLAUDE.md` ("Search-first inline shape", "No-matches registration lowering"),
  `lib/preview/CLAUDE.md` ("Running Results reads at most 50 cases per page", "The completed-search
  context and the no-matches form"), `lib/preview/engine/caseDataBinding.ts` (`loadCasesAction`,
  `loadCaseDataAction`'s `deviceScoped`, `loadCaseDatabaseSnapshotAction`, `restoreScope`),
  `caseDataBindingHelpers.ts::readCases`,
  `lib/commcare/projectSpaceCompatibility.ts` (`HQ_PRIVATE_FEATURE_FLAG_SYMBOLS`),
  `lib/commcare/client.ts` (the `feature_flag` listing), `content/docs/case-workspace.mdx` ("Search
  first"), and `proof/native/core/SearchRuntimeTest.java`.
- Read at the pins for the rest of this part: HQ `app_manager/suite_xml/utils.py::get_select_chain_with_sessions`;
  `app_manager/suite_xml/sections/entries.py::EntriesHelper.get_filter_xpath`, `::get_datum_meta_module`
  (each select-chain datum's nodeset takes its own module's `case_details.short.filter`);
  `app_manager/models/forms.py::Form.session_var_for_action`, `::FormBase.has_fixtures`;
  `app_manager/suite_xml/sections/entries.py::EntriesHelper.get_extra_case_id_datums`,
  `::get_new_case_id_datums_meta`, `::get_case_datums_basic_module`, `::add_parent_datums`;
  `app_manager/const.py::USERCASE_ID`;
  `app_manager/suite_xml/post_process/workflow.py::_get_datums_matched_to_manual_values`;
  `app_manager/suite_xml/post_process/instances.py` (the factories, `get_instance_factory`,
  `null_factory`, `assert_no_unknown_instances`, `get_all_instances_referenced_in_xpaths`,
  `get_instance_names`); `app_manager/xform.py::XForm.add_missing_instances`;
  `fixtures/fixturegenerators.py::item_lists_by_domain`, `::item_lists_by_app`,
  `ItemListsProvider._get_fixtures`, and its caller `app_manager/views/formdesigner.py`;
  `helpers/validators.py::ApplicationBaseValidator._validate_fixtures`;
  `users/fixturegenerators.py::UserGroupsFixtureProvider`;
  `users/models.py::CouchUser._get_case_sharing_groups_for_locations`,
  `::CommCareUser.get_case_sharing_groups`; `locations/models.py::SQLLocation.case_sharing_group_object`;
  `locations/fixtures.py::should_sync_flat_fixture`, `LocationFixtureProvider.__call__`,
  `FlatLocationSerializer`, `_fill_in_location_element`, `_get_metadata_node`;
  `locations/tests/test_location_fixtures.py::LocationFixturesTest.test_no_user_locations_returns_empty`; `settings.py`
  `FIXTURE_GENERATORS`. Core `org/commcare/session/SessionInstanceBuilder.java` (`addDatums`,
  `addUserQueryData`, `addMetadata`, `addData`, `getStringQuery`, `getCalloutSearchResultCount`);
  `org/commcare/session/CommCareSession.java::getEvaluationContext`;
  `org/commcare/core/process/CommCareInstanceInitializer.java` (`generateRoot`,
  `setupFixtureData`, `loadFixtureRoot`, `setupExternalDataInstance`,
  `setupSelectedEntitiesInstance`); `org/commcare/data/xml/VirtualInstances.java::buildSelectedValuesInstance`;
  `org/javarosa/xpath/XPathNodeset.java::unpack`. Nova `lib/domain/usercase.ts::USERCASE_CASE_TYPE`,
  `lib/commcare/validator/rules/multiSelect.ts::multiSelectFormSemantics`.
