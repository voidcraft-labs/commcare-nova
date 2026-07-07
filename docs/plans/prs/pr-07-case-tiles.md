# PR-07: Case tiles + tile grouping

*Self-contained implementation plan. Verified 2026-07-06 across HQ (models/emission/
fixtures/toggles), commcare-core (DetailParser/StyleParser/GridParser/DetailGroupParser),
and formplayer+cloudcare (response beans + the CSS-grid renderer). Supersedes the F4 plan's
"tiles: explicitly not yet" ruling per the owner's scope decision.*

**Goal.** A module's case list can render as **tiles** — each case a card laid out on a
12-column grid from the module's existing columns — optionally **grouped** (cases sharing a
parent index collapse under a header made of the tile's top rows, e.g. a clinic header over
per-bed-type rows). Same layout drives the case list, search results, and the persistent
tile pinned above forms. Works in Web Apps (verified renderer), the preview, and both export
paths.

## Verified contracts (cite these; do not re-derive)

- **Authoring model (HQ)**: `Detail.case_tile_template` with exactly two named templates +
  `custom` (`suite_xml/features/case_tiles.py::CaseTileTemplates`; `person_simple` is legacy
  — hardcoded profile image + register action, skips sort population; `icon_text_grid` is a
  2×3 icon+text grid); per-column `DetailColumn.case_tile_field` maps columns into named-
  template slots; `custom` uses per-column `grid_x/grid_y/width/height/horizontal_align/
  vertical_align/font_size/show_border/show_shading` (zero-based); grouping =
  `Detail.case_tile_group = {index_identifier, header_rows (default 2)}`.
- **Wire**: a tile detail is a normal `<detail>` whose `<field>`s carry
  `<style horz-align vert-align font-size show-border show-shading><grid grid-x grid-y
  grid-width grid-height/></style>` — all four grid attrs required once `<style>` exists
  (`commcare-core/.../GridParser.java::parse` does unguarded `Integer.parseInt`); a field is
  a tile cell iff all four set (`DetailField::isCaseTileField`); grouping = a `<group
  function="string(./index/<id>)" header-rows="N"/>` child of `<detail>` — attribute is
  **`header-rows`** (`DetailGroupParser::ATTRIBUTE_NAME_HEADER_ROWS`; note: one core test
  fixture misspells `grid-header-rows`, which silently defaults to 1 — emit `header-rows`)
  — plus a companion **entry datum** `…_parent_ids` = `join(' ', distinct-values(…/index/
  <id>))` (`entries.py`, multi-select variant with `selected(...)`).
- **12-column cap**: `x + width ≤ 12` (`test_suite_case_tiles.py::test_case_tile_column_count`,
  "parity with what mobile allows"); no core-side column constant (verified absent) — the
  renderer builds `repeat(maxWidth, 1fr)` from the actual extent.
- **Web Apps rendering** (all verified in source): formplayer serializes `Tile[]` (grid
  coords) + `Style[]` (font/align/border/shading/format) + `usesCaseTiles/maxWidth/maxHeight/
  numEntitiesPerRow/useUniformUnits/groupHeaderRows` on `EntityListResponse`
  (`::processCaseTiles`) and per-entity `groupKey` (evaluated in
  `NodeEntityFactory`); pagination is **by group** when grouped
  (`::getEntitiesForCurrentPage`); cloudcare converts coords to CSS `grid-area`
  (`views.js::getGridAttributes` — 1-based `rowStart/colStart/rowEnd/colEnd`), builds the
  container grid (`buildCellGridStyle` — `repeat(numColumns, 1fr)`, square cells via `cqw`
  when uniform-units), splits header vs body fields by `gridY < groupHeaderRows`
  (`CaseTileGroupedListView::initialize`), and renders the persistent tile sticky above
  forms (`PersistentCaseTileView`; suppressed in App Preview only).
- **Grouping mechanics**: group key is a real case **index** (never a calculated value);
  the header is the top N rows OF THE SAME TILE, taken from the group's first case — so
  header rows must reference **parent-case properties** (constant across the group) and
  body rows the child's own. This is exactly why the Colorado list changed from unit
  (parent) to capacity (child) cases: you group a list of children by their shared parent
  index; you cannot group parents.
- **Search results**: `Module.search_detail()` deep-copies the short/long detail —
  search-result lists carry the SAME tile + grouping config (`models.py`, `details.py`).
- **Validation (HQ's failure modes to mirror)**: named-template slots must all be mapped;
  case-DETAIL (long) tiles must be custom; tabbed detail tiles keep each row within one
  tab; persistent case tile ⊥ persistent report tile (no report tiles in Nova — moot).
- **Gating**: `CASE_LIST_TILE`(+`_CUSTOM`) are TAG_FROZEN domain toggles gating HQ's
  authoring UI; grouping support additionally requires CommCare ≥2.54
  (`feature_support.py::supports_grouped_case_tiles` — note it ANDs the toggle). The local
  `.ccz` path is unaffected (the runtime parses tiles unconditionally). **Resolved
  (verified 2026-07-06): HQ's suite REGENERATION is NOT toggle-gated** —
  `suite_xml/sections/details.py` fires `CaseTileHelper` purely on
  `detail.case_tile_template` being set, and `models.py::has_grouped_tiles` checks only the
  model fields (template + `case_tile_group.index_identifier`); `supports_grouped_case_tiles`
  gates the authoring UI only. An uploaded Nova tile config emits fully on any domain; no
  setup-artifact prerequisite. (Grouping still needs CommCare ≥2.54 on the CLIENT — a
  given on the web-apps target.)
- **Fixtures to pin**: `tests/data/suite/suite-case-tiles.xml` (+ `app_case_tiles.json`),
  `case-tile-case-detail.xml` (+ `-tabs`), `case_tile_pulldown_session.xml`,
  `test_suite_case_tiles_grouping.py`'s `assertDetailGroup` shapes (single + multiselect
  datum), `test_suite_custom_case_tiles.py`, `bad_case_tile_config.json` error modes.

## The shape (Nova's, not HQ's)

HQ separates template pickers, slot mappings, and parallel grid fields. Nova puts **tile
placement on the column** — the same move as sort-on-column:

```ts
// caseListConfig additions (lib/domain/modules.ts)
tileLayout?: {
  grouping?: { parentIndex: string /* index identifier, default "parent" */,
               headerRows: number /* ≥1 */ },
  // Local-`.ccz`/preview ONLY (verified: `fit-across` + `uniform-units` are <detail>
  // attributes parsed by commcare-core's DetailParser but have NO HQ authoring model or
  // suite emission — repo-wide grep clean outside custom_xml, which Nova never emits).
  // The HQ-upload path CANNOT carry them: the compile boundary surfaces a non-silent
  // notice ("multi-tile rows / uniform cells don't survive HQ upload") when set on an
  // HQ-targeted export. Preview + .ccz honor them fully.
  entitiesPerRow?: number,   // → <detail fit-across="N">
  uniformCells?: boolean,    // → <detail uniform-units="true">
  persistOnForms?: boolean, pullDown?: boolean,
}
// per-column (all seven column kinds):
tile?: { x: number, y: number, w: number, h: number,      // zero-based, x+w ≤ 12
         align?: …, valign?: …, fontSize?: …, border?: boolean, shading?: boolean }
```

Tile mode is ON when `tileLayout` is present; then every list-visible column must carry
`tile` placement (validator), and non-placed columns keep their search/sort roles (the
verified hidden-field template shape). Nova offers **layout presets** (an icon_text_grid-
style starter) as builder gestures that FILL `tile` slots — never as persisted template
slugs; emission is always HQ's `custom` vocabulary (per-column grid fields +
`case_tile_template: "custom"`), which sidesteps `person_simple`'s legacy baggage and the
slot-mapping validators entirely, and keeps one wire path for presets and hand layouts.

## Build

1. **Domain**: the two schema additions; validator rules (all-visible-columns-placed;
   `x+w ≤ 12`; no overlapping cells; `headerRows` < the tile's row count; header-row
   columns should resolve against parent properties — gate the decidable case: a header-row
   column whose expression references own-case-only properties gets a finding). **Grouping
   `parentIndex` source of truth (explicit):** valid iff the module is case-first AND
   either (a) `parentIndex === "parent"` and the module's case type has catalog
   `parent_type` set (the derived-subcase convention — Nova's `case_property_on` children
   always index as `parent`), or (b) some case operation in the app links this case type
   via `links[].identifier === parentIndex` with `targetType` = the catalog `parent_type`
   (PR-01 vocabulary). Reference edges: case (b) keys the edge on that op link, so an
   identifier rename re-validates/updates `parentIndex`; case (a) needs no edge (the
   convention is fixed). **Detail scope (explicit): tiles apply to the SHORT + SEARCH
   details only in this PR — the long (case detail) view always emits a plain field list;
   long-detail tiling is recorded, not planned** (HQ models long tiles independently and
   requires custom config — out of scope). Class rows + repair judgments.
2. **Wire** (`lib/commcare/suite/case-list/*` + `hqJson`): per-field `<style><grid>`
   emission (the verified attribute names; header/template order per `Field` ORDER);
   `<group function="string(./index/<id>)" header-rows="N"/>`; the companion
   `_parent_ids` entry datum (both variants); search-detail inheritance (Nova's single
   config already models what HQ's deepcopy does); persistent-tile emission
   (`persist_tile_on_forms`, `pull_down_tile`) on the HQ JSON + the suite; HQ JSON carries
   `case_tile_template: "custom"` + per-column grid fields + `case_tile_group` (NO slot
   exists for `entitiesPerRow`/`uniformCells` — the HQ-target compile notice from §1's
   schema comment fires here). Local `.ccz` additionally emits `<detail fit-across="N"
   uniform-units="true">` when set (commcare-core `DetailParser::parse` attrs — the
   runtime authority). Pin every fixture listed above; extend the suite oracle (grid
   attribute completeness, the 12-col cap as an oracle assertion, group node shape).
3. **Preview**: tile rendering in the case-list screens mirroring the verified cloudcare
   math (grid-area conversion, per-group collapse with header-from-first-case, group
   pagination, entitiesPerRow container grid, uniform square cells); persistent tile above
   preview forms. **Grouping order contract (verified — do not skip): grouped lists are
   re-sorted by first-appearance order of `groupKey` AFTER the user sort and BEFORE
   pagination** (`commcare-core/src/cli/.../EntityScreenHelper::groupEntities` — a stable
   sort clustering group members contiguously; `EntityListResponse::getEntitiesForCurrentPage`
   then counts group boundaries on adjacent keys). The preview applies the same clustering
   re-sort, and the parity test matrix includes a case whose user sort does NOT cluster by
   the parent index.
4. **Builder UI**: a tile-layout editor on the case-list workspace (drag/resize cells on a
   12-col canvas; presets; grouping controls with the child-cases-grouped-by-parent-index
   explainer; live preview via the real renderer). Load the frontend-design skill.
5. **SA + docs**: tool params on the case-list config tools; guidance — tiles pair with
   the "project, don't copy" rule (header rows use parent-walk calculated columns; the
   grouped-list-must-be-children mechanism explained with the Colorado example); docs
   grounded in what renders on each surface (no HQ-path prerequisite — regeneration is
   toggle-free, per the resolved item in the contracts above).

## Tests / acceptance

Fixture-pinned emission (all listed); oracle extensions; preview visual parity cases
(grid-area math table-tested against `getGridAttributes`' arithmetic); validator matrix;
user-phrased acceptance: "I lay out my case list as cards on a grid, group them under
their clinic, and see the same cards in the preview, in search results, and pinned above
forms — and the exported app renders them identically in Web Apps."

## Non-goals

HQ named-template slugs (`person_simple`/`icon_text_grid`) as persisted config; report
tiles; case-list maps (`CASE_LIST_MAP`) and lazy loading (`CASE_LIST_LAZY`) — separate
frozen features, recorded not planned; Android-specific tile tuning.

## Open choices (implementer)

- Preset catalog contents (start with one icon+text starter and one two-line starter).
  (`entitiesPerRow`/`uniformCells` remain IN, scoped per §1's schema comment: local
  `.ccz` + preview only, with the non-silent HQ-upload notice — HQ's authoring model has
  no slot for them, verified.)
