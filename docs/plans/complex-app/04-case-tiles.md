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
  the CLIENT defaults a missing one to `1`, while HQ's
  `models/case_list.py::CaseTileGroupConfig.header_rows` defaults to `2` — the two
  defaults disagree, so Nova always emits the attribute explicitly. **Three
  fixtures misspell it `grid-header-rows`** — `commcare-core/src/test/resources/app_structure/suite.xml`
  and `formplayer/src/test/resources/archives/case_claim_with_multi_select/suite.xml`
  among them — which silently reads as one header row. Do not copy that spelling.
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
- The group key must be a real case **index**, never a calculated value. Header
  rows reference parent-case properties (constant across the group) and body rows
  the child's own, so you group children by their shared parent index; you cannot
  group parents.
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
