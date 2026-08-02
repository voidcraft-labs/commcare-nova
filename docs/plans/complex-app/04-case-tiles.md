# Unit 4 — Grouped case tiles

**PR:** `Grouped case tiles`

**Depends on:** nothing outstanding. · **Blocks:** nothing.

> Read [the binding contracts](00-contracts.md) first, and
> [what is built](../complex-app-plan.md#case-tiles) for the tile layout this
> unit groups — the `<style>`/`<grid>` contract, the occupied-extent rule, the
> `custom`-only vocabulary, and the two scope fences are all recorded there and
> are not repeated here.

Group a child case list under its shared parent: the group header is the top N
rows of the same tile, drawn from the group's first case, and the body rows are
each child's own. Add group-aware ordering and pagination **at the data layer**
before rendering, plus the grouping authoring surface.

Groups cannot be formed after a 50-row page is fetched. A grouped list is
re-sorted by first-appearance order of the group key *after* the user sort and
*before* pagination, and pagination then counts group boundaries on adjacent
keys — so a grouped list pages by group, not by row. Nova's preview and query
layers apply the same clustering re-sort, including for a user sort that does not
already cluster by the parent index.

Author-facing surfaces use Nova relationship vocabulary, never `parentIndex`.

## Binding facts

- Grouping is a `<group function="string(./index/<id>)" header-rows="N"/>` child
  of `<detail>`, emitted on the SHORT detail only by
  `commcare-hq/corehq/apps/app_manager/suite_xml/features/case_tiles.py::CaseTileHelper.build_case_tile_detail`
  (not `sections/details.py`). Its model is
  `suite_xml/xml_models.py::TileGroup`, and HQ's gate is
  `models/modules.py::Module.has_grouped_tiles`.
- The attribute is `header-rows`
  (`commcare-core/.../org/commcare/xml/DetailGroupParser.java::DetailGroupParser.ATTRIBUTE_NAME_HEADER_ROWS`).
  `function` is required and must parse as XPath; `header-rows` is optional and
  the two sides default it differently — the CLIENT falls back to `1`
  (`DetailGroupParser::parse`), while HQ's model defaults to `2`
  (`models/case_list.py::CaseTileGroupConfig.header_rows`) — so Nova always
  emits the attribute explicitly; relying on either default silently halves or
  doubles the header depending on which side you read. **Three of the four
  `<group>` fixtures in the checkouts misspell it `grid-header-rows`** —
  `commcare-core/src/test/resources/app_structure/suite.xml` and
  `formplayer/src/test/resources/archives/case_claim_with_multi_select/suite.xml`
  among them, plus vendored/build copies — which parses as an unknown attribute
  and silently takes the default, so those fixtures prove nothing about
  header-row behavior; do not copy that spelling. The one correctly-spelled
  fixture, and therefore the byte oracle this unit asserts against, is
  `formplayer/src/test/resources/archives/case_list_auto_select/suite.xml`.
- A grouped list additionally needs the companion entry datum
  `<datum id="<caseDatumId>_parent_ids" function="join(' ', distinct-values(instance('casedb')/casedb/case[<predicate>]/index/<id>))"/>`,
  emitted by
  `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper.get_extra_case_id_datums`.
  The predicate is `@case_id = instance('commcaresession')/session/data/<caseDatumId>`
  for a single-select datum. Unit 17 later adds the multi-select variant
  (`selected(join(' ', instance('<caseDatumId>')/results/value), @case_id)`) when
  it swaps the datum class to `<instance-datum>`; land the datum builder so that
  variant is an added arm rather than a reshape. Unit 16 must also describe every
  selection-requiring datum as an endpoint `<argument>`, so a new datum is a new
  endpoint obligation.
- **Nova narrows the group key to a case index. That is Nova's choice, not the
  platform's rule.** The group header is the top N rows of the same tile taken
  from the group's **first** case, so a header cell is only honest when its value
  is invariant across every member of the group. A case index is the only group
  key Nova can statically prove invariant — grouping by a plain property makes
  exactly one value shared and turns every other header cell into a guess drawn
  from an arbitrary member. So header rows reference parent-case properties and
  body rows the child's own: you group children by their shared parent index, and
  you cannot group parents.

  The wire is **wider than this**, and the plan must not pretend otherwise.
  `commcare-core/.../org/commcare/xml/DetailGroupParser.java::parse` validates the
  attribute with `XPathParseTool.parseXPath` and nothing else — any syntactically
  valid XPath is accepted. The runtime treats the result as an opaque string
  (`NodeEntityFactory::getEntity` / `AsyncEntity::getGroupKey` evaluate to a
  `String`, compared with `Objects.equals` and used as a map key; no consumer
  inspects its shape), and a shipped fixture groups by a plain property:
  `formplayer/src/test/resources/archives/case_claim_with_multi_select/suite.xml`
  carries `<group function="string(case_name)" …>`. HQ is index-shaped by
  construction rather than validation — it interpolates
  `string(./index/{index_identifier})` from an unvalidated free-text box. Do not
  write "CommCare requires an index" anywhere; property-keyed grouping is a
  deliberate Nova narrowing, out of scope for this unit rather than impossible.

  One coupling supports the narrowing without being an engine requirement:
  `cloudcare/.../formplayer/menus/views.js::CaseTileView.iconClick` uses
  `groupKey` **as a case id** when a clickable-icon endpoint fires from the header
  region, so a non-case-id key breaks that one optional feature.
- **The empty group key is the sharpest hazard, and the runtime has no answer
  for it.** `string(./index/parent)` on a parentless child evaluates to `""`, and
  the clustering map accepts that as an ordinary key — so **every parentless
  child collapses into a single group**, headed by whichever of them sorts first.
  There is no "ungrouped" concept anywhere in the engine, so Nova must not invent
  one: a synthetic bucket would make the preview show something no device shows.
  Which rows lack the index is runtime data, so a construction-time refusal
  cannot be honest on its own. The unit ships a truthful preview (the collapse
  rendered exactly as the device renders it) plus an author-time statement of the
  consequence at the point grouping is chosen.
- **Two states Nova can construct that HQ cannot, both failing silently, both
  therefore validator refusals rather than warnings:**
  - A cell that **straddles the header boundary**. The split is start-row only
    and ignores height — `cloudcare/.../formplayer/menus/views.js::CaseTileGroupedListView.initialize`
    computes `isHeaderRow = (y) => y < groupHeaderRows` — so a cell starting at
    row 1 spanning three rows is classified *entirely* as header when
    `header-rows` is 2. The client will not split it.
  - A `<group>` on a detail with **no tile**. It still clusters and still
    switches pagination to group-based, but `utils.js::getCaseListView` routes to
    the grouped view only when tiles are present, so it renders flat. HQ cannot
    reach this state; Nova could.
- **Grouped pagination is unbounded in rows.** `getEntitiesForCurrentPage` pages
  by group, so `casesPerPage` counts groups, not rows: 100 rows in 4 groups at
  `casesPerPage = 10` returns all 100 in one response. That is a real caveat for
  the docs and for Nova's own query layer, not a bug to work around.
  (`MAX_CASES_PER_PAGE = 100`, `DEFAULT_CASES_PER_PAGE = 10`.) The sibling
  upstream defect — an out-of-range offset returning a silently empty page,
  because the skip guard and the clamp count rows while selection counts groups —
  is **unreachable from Nova's pager and is therefore neither reproduced nor
  simulated**: `CaseListScreen`'s only two `choosePage` callers step one page from
  the *settled* server offset, Previous is disabled at offset 0, Next is disabled
  once `pageEnd >= totalMatchingCases`, the setter clamps at `Math.max(0, index)`,
  and no URL path seeds a page index.
- **Grouped tiles are a Web Apps capability only.** CommCare Android parses
  `<group>` and ignores it, degrading to an ungrouped tile list. That belongs
  where the author chooses grouping, not in a footnote.
- Grouping needs client CommCare ≥ 2.54
  (`commcare-hq/corehq/apps/app_manager/feature_support.py::CommCareFeatureSupportMixin.supports_grouped_case_tiles`),
  which the Web Apps target gives. That property gates only HQ's authoring
  template — the suite emitter is not toggle-gated.
- Grouping happens at the data layer because
  `commcare-core/src/cli/java/org/commcare/util/screen/EntityScreenHelper.java::EntityScreenHelper.groupEntities`
  performs a stable clustering re-sort after the user sort and before pagination
  (each distinct key takes an ordinal equal to the map size at first insertion, so
  groups follow first-appearance order and TimSort keeps members in their
  post-sort order), and
  `formplayer/.../beans/menus/EntityListResponse.java::EntityListResponse.getEntitiesForCurrentPage`
  then counts group boundaries on adjacent keys, reinterpreting `offset` as a
  group offset and `casesPerPage` as groups per page.
- Web Apps routes a grouped list to `CaseTileGroupedListView` when
  `groupHeaderRows >= 0` (Formplayer initializes it to `-1` when ungrouped), and
  splits header from body fields on `gridY < groupHeaderRows` — on the cell's
  START row alone, ignoring its height, so a cell starting inside the header rows
  is entirely a header cell.

**Observed:** an author groups a child list under its parent and sees it page by
group, with each group's header drawn once from the parent.
