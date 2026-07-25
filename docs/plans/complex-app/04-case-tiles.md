# Unit 4 — Case tiles

**PRs:**
1. `Case tile layout: authoring, preview, and wire`
2. `Grouped case tiles`

**Depends on:** nothing outstanding. · **Blocks:** nothing.

> Read [the binding contracts](00-contracts.md) first — the deliberate target
> gaps there exclude `entitiesPerRow` and `uniformCells` from constructible
> state, and long-detail tiles from scope.

Split by capability, not by layer: a laid-out tile is a complete, exportable
feature on its own, and grouping is a further capability on top of it. Neither
PR leaves emission that nothing can produce.

Land stable tile identities, validation, reference edges, HQ JSON, suite
emission, the query layer, preview rendering, and the layout authoring surface.
Author-facing surfaces use Nova relationship vocabulary, never `parentIndex`.

Add group-aware ordering and pagination **at the data layer** before rendering.
Groups cannot be formed after a 50-row page is fetched: grouped lists are
re-sorted by first-appearance order of the group key after the user sort and
before pagination (`EntityScreenHelper::groupEntities` performs a stable
clustering sort), and pagination then counts group boundaries on adjacent keys
(`EntityListResponse::getEntitiesForCurrentPage`). A grouped list pages by group,
not by row, and Nova's preview and query layers apply the same clustering
re-sort — including for a user sort that does not cluster by the parent index.

Web Apps tile rendering is fully specified in source and is the parity target:
Formplayer serializes `Tile[]` grid coordinates plus `Style[]`,
`usesCaseTiles`/`maxWidth`/`maxHeight`/`numEntitiesPerRow`/`useUniformUnits`/`groupHeaderRows`,
and a per-entity `groupKey`; cloudcare converts coordinates to 1-based CSS
`grid-area` (`views.js::getGridAttributes`), builds the container grid via
`buildCellGridStyle`, splits header from body fields by `gridY < groupHeaderRows`,
and renders the persistent tile sticky above forms (`PersistentCaseTileView`,
suppressed in App Preview only).

Define pager semantics, persistent-tile locations, presets, responsive rendering,
keyboard and numeric layout alternatives, and one visual parity journey.

Because `entitiesPerRow` and `uniformCells` are excluded from constructible state,
the parity renderer must pin what it assumes in their absence — the runtime
defaults, one tile per row and non-uniform units — and the parity journey asserts
against those values rather than leaving them implicit.

## Binding wire facts

- A tile detail is an ordinary `<detail>` whose `<field>`s carry
  `<style horz-align vert-align font-size show-border show-shading><grid grid-x
  grid-y grid-width grid-height/></style>`. All four grid attributes are required
  once `<style>` exists — `GridParser::parse` does an unguarded
  `Integer.parseInt` — and a field is a tile cell iff all four are set
  (`DetailField::isCaseTileField`).
- Grouping is a `<group function="string(./index/<id>)" header-rows="N"/>` child of
  `<detail>`. The attribute is `header-rows`
  (`DetailGroupParser.ATTRIBUTE_NAME_HEADER_ROWS`); one CommCare core test fixture
  misspells it `grid-header-rows`, which silently defaults to 1. A grouped list
  additionally needs the companion entry datum
  `<id>_parent_ids = join(' ', distinct-values(…/index/<id>))`, with a `selected()`
  variant for multi-select.
- The group key must be a real case **index**, never a calculated value. The group
  header is the top N rows of the same tile taken from the group's first case, so
  header rows reference parent-case properties (constant across the group) and body
  rows the child's own. You group children by their shared parent index; you cannot
  group parents.
- The 12-column cap (`x + width ≤ 12`) comes from HQ's own parity assertion
  (`test_suite_case_tiles.py::test_case_tile_column_count`), not a core constant —
  commcare-core has no column-count constant and the Web Apps renderer builds
  `repeat(maxWidth, 1fr)` from the actual extent. Nova enforces 12 itself.
- Nova always emits HQ's `custom` tile vocabulary (`case_tile_template = "custom"`
  plus per-column grid fields) and never the named templates `person_simple` or
  `icon_text_grid`. Layout presets are builder gestures that fill per-column
  placement, never persisted template slugs. This sidesteps `person_simple`'s
  legacy hardcoded profile image and register action, and HQ's slot-mapping
  validators, and keeps one wire path for presets and hand layouts.
- Search-result lists inherit tiles automatically: `Module.search_detail()`
  deep-copies the short/long detail, so one Nova config already drives the case
  list, the search results, and the persistent tile.
- HQ's suite regeneration of tiles is **not** toggle-gated — `details.py` fires
  `CaseTileHelper` purely on `detail.case_tile_template` being set. An uploaded
  Nova tile config emits fully on any domain with no setup-artifact prerequisite.
  Grouping needs CommCare ≥ 2.54 on the client, which the Web Apps target gives.

**Observed:** an author lays out a case tile on a grid, exports it, and sees the
same layout in the running preview that a device would show; then groups a child
list under its parent and sees it page by group.
