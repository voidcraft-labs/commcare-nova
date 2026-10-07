# Step 2, part 07: Work item D, part 4: case lists (defects 10 and 16 hidden columns; findings 35, 36, 38, 42, 51, 57; tiles; date patterns)

Part of [step 2's plan](../2-emission-and-publish.md), which holds the baseline, the decisions, the stack and the exit. Citations are `file::symbol`; HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

This part is pull request 11 of the stack ("Case lists"; part 11, The stack). It lands after pull request 9 (part 05, Finding 33: `nova_trimmed` and the source-question guard), whose three entries sit on the expander document this part's sort tests produce, and before pull request 12 (part 06, Order and shared files), which edits other functions of `lib/commcare/hqJson/caseList.ts`. It also needs `localization.wireCodes` (pull request 3; part 01, A2. `localization.wireCodes`), because a sort element's `display` is keyed by the first language's HQ code.

Every cutover step id and notice reason this part names is the one registered in part 10, The transform steps, in order, and part 10, Changes that write nothing and still get a line, used verbatim. This part holds each step's exact rewrite and each reason's copy; part 10 holds the registry and the order.

One fault runs through defects 10 and 16 and findings 35, 36, 51 and 57: three surfaces decide a list's fields and order on their own (`lib/commcare/hqJson/caseList.ts::projectSortElements`, `lib/commcare/suite/case-list/sortKeys.ts::buildSortDirectives` with `columns.ts::resolveSortElement`, and `lib/preview/engine/caseDataBindingHelpers.ts::buildCaseStoreSortKeys`), and none states what HQ's build writes for the app Nova sends. From step 2 one derived plan states it and all three read it.

Every HQ, Core and Android fact in this part rests on reading the source at the pins, except finding 57's, which were executed during planning. Each block's **Lane** says what the pull request's lane run confirms and the decided fallback where one exists.

## The order plan: `lib/domain/caseListOrder.ts::caseListOrderPlan`

A new pure module in Nova vocabulary, so `lib/commcare` and Preview both import it. It stores nothing: it is derived from the document on every read.

```ts
export type CaseListSortKey =
	| { kind: "property"; property: string }      // the raw value
	| { kind: "option-label"; property: string }   // a select property's shown label
	| { kind: "mapping-position"; column: Uuid }   // index of the first matching entry as text, "" when none
	| { kind: "interval-text"; column: Uuid }      // the interval column's shown text
	| { kind: "link-text"; column: Uuid }          // the link column's shown markdown
	| { kind: "calculated"; column: Uuid };        // the expression's value

export type CaseListComparator = "text" | "integer" | "decimal";

export interface CaseListOrderRule {
	readonly order: number;                // 1-based
	readonly direction: SortDirection;
	readonly blanks: "first" | "last";     // first when ascending, last when descending
	readonly implicit: boolean;            // HQ's default on the first field
}

export interface CaseListShortField {
	readonly column: Column;
	readonly position: number;             // 0-based index in the stored short detail
	readonly hidden: boolean;              // visibleInList === false
	readonly wire: "property" | "expression";
	readonly joinText: string;             // the text HQ joins an order rule by: the column's HQ `field`
	readonly key?: CaseListSortKey;        // the sort key the field keeps; absent = none
	readonly comparator: CaseListComparator;
	readonly rule?: CaseListOrderRule;     // present when the list orders by it
}

export interface CaseListOrderCarrier {   // the hidden sort field HQ appends itself
	readonly property: string;             // its raw value is the carrier's text and its sort key
	readonly comparator: CaseListComparator;
	readonly rule: CaseListOrderRule;
}

export interface CaseListOrderPlan {
	readonly fields: readonly CaseListShortField[];
	readonly carriers: readonly CaseListOrderCarrier[];
}

export function caseListOrderPlan(
	config: CaseListConfig,
	caseProperties: readonly CaseProperty[],
	options: {
		readonly mediaOn: boolean;
		readonly calculatedType: (column: Column) => ResolvedType | undefined;
		readonly expressionText: (column: Column) => string;
	},
): CaseListOrderPlan;

export function comparatorForDataType(
	dataType: CasePropertyDataType | undefined,
): CaseListComparator;                    // int: integer, decimal: decimal, otherwise text
```

**Inputs.** The list's configuration (columns, `listColumnOrder`, each column's `sort`, `visibleInList`, the tile layout), the case type's property catalog (data types and select options), and three options a domain module cannot compute, because `lib/domain` imports nothing from `lib/commcare`:

- `mediaOn`: an image map with media off is a plain column on both paths, as today.
- `calculatedType(column)`: the resolved type of a calculated column's expression, `undefined` when it does not resolve. `int` maps to the integer comparator, `decimal` to decimal, everything else and `undefined` to text.
- `expressionText(column)`: the text reader 1 writes as an expression column's HQ `field`. The plan compares these texts for equality and reads nothing else from them.

One helper builds the options for every reader, so no reader can pass different ones: new `lib/commcare/suite/case-list/orderPlanOptions.ts::caseListOrderOptions(mod, doc, mediaOn)`. Its `calculatedType` is `lib/domain/predicate/typeChecker.ts::checkExpression` over `lib/commcare/validator/rules/case-list/shared.ts::moduleTypeContext(mod, doc)` (the body of today's unexported `sortKeys.ts::resolveCalculatedSortType`, with `ANY_TYPE` returned as `undefined`). Its `expressionText` is new `orderPlanOptions.ts::hqExpressionFieldText(column, mod, doc)`, which `caseList.ts::projectColumnToDetail` also calls for every expression arm, printed with no lookup naming for the plan (a lookup name maps one table to one name, so equality is the same under any naming). Readers 1 and 2, the validator rules below and the cutover steps call it directly; Preview calls it from `lib/preview/engine`, which may import `lib/commcare`.

The property comparator table moves into the domain: `caseListOrder.ts::comparatorForDataType` replaces `sortKeys.ts::applicableSortTypes` and `APPLICABLE_SORT_TYPES`, which go with `sortKeys.ts::resolveColumnSortType`, `resolveCalculatedSortType` and `mapResolvedTypeToSortType`. The comment in `lib/domain/casePropertyTypes.ts` that names `applicableSortTypes` is updated to the new name.

**Outputs.** `fields`: the short detail's fields in stored order, each with its wire class, its join text, the sort key it keeps, and its rule if the list orders by it. `carriers`: the hidden sort fields HQ appends for rules that join no field, in rule order.

### The rules it encodes

Each rule is a statement of what HQ's build writes; the citation is the comment the rule carries in the module.

| # | Rule | What HQ does |
|---|---|---|
| 1 | **Fields.** Every column of `orderedColumns(config, "list")`, hidden ones included. In a list with a tile layout, a column hidden from Results is not a field (the tile clause below). | The short detail's stored columns are the fields; an `invisible` column is a field at width 0 (`detail_screen.py::Invisible`, `HideShortColumn`). |
| 2 | **Wire class and join text.** `property`: `plain` over a property that is not a select with options, `date`, `phone`, `id-mapping`, `image-map` with media on, and every hidden column that is not calculated. Its join text is the property name. `expression`: `plain` over a select with options, `interval`, `link`, `calculated`, and every column, shown or hidden, over an attribute-backed property (`case_id`, `owner_id`, `status`; finding 57). Its join text is `options.expressionText(column)`, which is `@<name>` for an attribute-backed column that is not a shown link. | A property column's `field` is a property name that `detail_screen.py::PropertyXpathGenerator.xpath` turns into a path; an expression column's `field` is used verbatim (`detail_screen.py::FormattedDetailColumn.xpath`). HQ joins a sort element to a column by that `field` text and nothing else (rule 5). |
| 3 | **The key a field keeps with no rule.** `date`: `property`, text. `id-mapping` and `image-map` (media on): `mapping-position`, text. Shown `plain` over a select: `option-label`, text. `interval`: `interval-text`, text. Every other field, and every hidden field, keeps none. | `detail_screen.py::FormattedDetailColumn.sort_node` writes a `<sort>` with `type` alone, before it tests for a sort element, for every format that has a sort expression of its own: `Date.SORT_XPATH_FUNCTION` (the raw property), `Enum.sort_xpath_function` and `EnumImage` (the mapping position, closed with `''`, `suite_xml/xml_models.py::XPathEnum.build`), `TranslatableEnum._make_xpath` (the column's own expression, the shown text). `plain`, `phone`, `markdown` and `invisible` have none. |
| 4 | **Authored rules become elements**, in `priority` order, ties by Results position (today's order in `buildSortDirectives`). A rule on a property field is a property element, the property name. A rule on an expression field is a positional element, `_cc_calculated_<position>`. Three exceptions. (i) A rule on a SHOWN `link` column over any property but `case_id` is a property element over that property, so a link orders by its raw value under the property's comparator. (ii) A shown link over `case_id` takes the positional element and the `link-text` key: `case_id` has no property element (row 5), and the link text is one fixed prefix, so the shown markdown orders exactly as the id does. (iii) In a tile list a rule on a column hidden from Results, which is no field there (rule 1), is a property element over its property. That holds for a column over an authored or standard property that is not attribute-backed; a hidden calculated column and a hidden column over `case_id`, `owner_id` or `status` are refused there (`CASE_TILE_HIDDEN_CALCULATED_SORT`), so no admitted document reaches this arm with one. A property element over `owner_id` or `status`, which only exception (i) produces, is the bare name. | `util.py::get_sort_and_sort_only_columns` reads `_cc_calculated_<i>` as `detail_columns[i]`, which must be an expression column or the build raises. A sort row's field is a property name or `_cc_calculated_<i>` (`helpers/validators.py::ModuleDetailValidatorMixin._validate_detail_screen_field`), so `@case_id` is no sort row, and the bare `case_id` reads a child element no case has (`detail_screen.py::CASE_PROPERTY_MAP` has no entry for it). |
| 5 | **Join.** Every element lands on the FIRST field whose join text equals the element's own: a property element's is the property name, a positional element's is its own column's join text. So a rule authored on a later field with the same text (a hidden `case_id` carrier after a shown `case_id` column, a plain `status` column after an ID mapping over `status`, a second select-label column over one property, a second calculated column with the same expression) lands on the earlier field, and the authored field keeps only its rule 3 key. Two elements with one join text collapse to the later one. A property element that no field's text equals becomes a carrier. The key of the field that takes the rule: its rule 3 key; or else `calculated`, comparator from `options.calculatedType`, for a calculated column; `link-text`, text, for a shown link; `property`, comparator `comparatorForDataType` of the property's data type, for every other field, attribute-backed ones included. A carrier's key is `property` with that comparator. `CASE_LIST_SORT_PROPERTY_AMBIGUOUS` (below) refuses the collapse and every join that lands on a field with another key, so in an admitted document every rule orders as authored. | `util.py::get_sort_and_sort_only_columns` keeps the joined elements in one dict keyed by `column.field`: a property element by its own `field`, a positional one by the `field` of `detail_columns[i]`, a later entry replacing an earlier one. `suite_xml/sections/details.py::get_detail_column_infos` pops that dict by `column.field` while it walks the columns, so the first column with that text takes the element and a later one gets none. An element left over becomes a temporary `invisible` column appended after the stored ones (`util.py::create_temp_sort_column`, model `case`), which is never stored; its path goes through `detail_screen.py::CASE_PROPERTY_MAP`, which turns `owner_id` and `status` into `@owner_id` and `@status`. With an element, `sort_node` sorts a format that has its own sort expression by that expression and reads the element only for `order`, `direction` and `blanks`. The surface entry `menus-and-case-lists/field-cc-calculated-n` already states the first-column join. |
| 6 | **A shown interval column orders by its shown text.** A rule on a SHOWN interval column is a positional element, and the field's key stays `interval-text`. A hidden one is a property field ordered by the raw date (rules 2 and 5). | `sort_node`'s first branch wins for `translatable-enum` and never reads `sort_calculation`. Ordering by the date is also inside HQ's envelope (a property sort row); step 2 keeps what HQ's build does with the app Nova sends today, so no device changes order. |
| 7 | **No authored rule.** One implicit rule, order 1, ascending, blanks first, comparator text, on field 0. Field 0's key is its rule 3 key, or else `link-text` for a shown link, `calculated` for a calculated column compared as text, and `property`, text, for every other field: a property field, a hidden field, and an attribute-backed field (a plain column over `case_id`, `owner_id` or `status`). A list with no field has no rule. | `suite_xml/sections/details.py::get_default_sort_elements`: one element whose `field` is that of `detail.get_column(0)`, type `string`, ascending, `blanks` unset, whatever the column's format. It joins field 0 by rule 5, since field 0 is the first field with its own text. |
| 8 | **Comparator of an element.** Integer and decimal only for a `property` or `calculated` key over an integer or decimal value; every rule 3 key is text. | `sort_node` writes `SORT_TYPE` (`string`) on the first branch and maps the element's `date` and `plain` to `string` on the second. |
| 9 | **Blanks.** `first` for ascending, `last` for descending, on every rule. | `static/app_manager/js/details/bootstrap5/sort_rows.js`: a row's `blanks` is the stored value or else that default. Core places a blank by `blanks` whatever the direction (commcare-core `cases/entity/EntitySorter.getCmp`, `xml/DetailFieldParser.parseBlanksPreference`). |

What Core does with a key that has no rule, so the reader knows why rule 3 exists: the field's `<sort>` has no `order`, so it never joins the default order (commcare-core `suite/model/Detail.getOrderedFieldIndicesForSorting`), but Core still evaluates it for every row (`cases/entity/NodeEntityFactory`), a fuzzy search matches against it (`util/EntitySortUtil.sortEntities`), and Android sorts by it when a worker picks that header (commcare-android `activities/EntitySelectActivity.getSortOptionsList`). Proof 3 compares it as `sortFields`.

### Reader 1: HQ JSON, `lib/commcare/hqJson/caseList.ts`

- `hqShortSourceColumns` returns the plan's fields in order. Its filter and the sentence in its doc comment beginning "Useless hidden definitions" go.
- `projectColumnToDetail`: the `id-mapping` arm writes `format: "enum"`, `field` the property token, `useXpathExpression: false`, and `enum: [{ key: <entry value>, value: <text map of the entry's label> }]` in mapping order. The `plain` over a select and `interval` arms are unchanged (`translatable-enum`, `useXpathExpression: true`). Every expression arm takes its `field` from `orderPlanOptions.ts::hqExpressionFieldText`, the function the plan's join text comes from. An attribute-backed column writes its kind's format with `field: "@<name>"` and `useXpathExpression: true` (finding 57). A calculated column keeps `format: "calculate"` in this pull request: the `calculate` to `plain` spelling, and the oracle's refusal of `calculate`, belong to pull request 12 (part 06, 10. The equivalent spellings), and no rule here depends on it, because `detail_screen.py::get_class_for_format` falls back to the base class for an unregistered slug and `Plain` overrides nothing, so the build is the same under either word.
- `projectColumnForShortDetail`, hidden column: built from `lib/commcare/hqShells.ts::detailColumn`, never from the shown projection. Not calculated and not attribute-backed: `format: "invisible"`, `field` the property token, `useXpathExpression: false`, `enum: []`. Calculated: `invisible` with its expression and `useXpathExpression: true`. Attribute-backed: `invisible`, `field: "@<name>"`, `useXpathExpression: true`.
- A hidden short column's `header`: where the column is shown on Details (`visibleInDetail !== false`), `localization.textMap` of its header unit, the map today's hidden order carriers write and a Case List save keeps on every corpus document; where it is hidden from both screens, so that no header unit exists (`caseListColumnTextShows` below), `repeatForLanguages(localization.languages, column.header)`, the stored header under every wire code. HQ's build reads neither: `detail_screen.py::Invisible.header` writes an empty text unless the joined sort element has display text, and Nova's never has (`models/case_list.py::SortElement.has_display_values`).
- `projectSortElements` is rewritten over the plan. One element per rule that is not implicit, in `order`, fields and carriers together: `field` the property name (a carrier's, or a property field's) or `_cc_calculated_<position>` of the field the rule was AUTHORED on, which HQ then joins as rule 5 says; `type` the Case List page's word (`int`, `double`, `date` for a text comparator over a date, datetime or time property, otherwise `plain`); `direction`; `blanks` `first` or `last`; `display: { <localization.wireCodes of the first language>: "" }`; `sort_calculation: ""` always. An unsorted list writes `[]`, and HQ's build adds its default.
- `applyTileLayoutToShortDetail` walks the same fields (tile blocks below).

### Reader 2: the local suite, `lib/commcare/suite/case-list/`

- `sortKeys.ts::buildSortDirectives` is replaced by `planSortNodes(plan, ctx)`, which returns one sort node per field that keeps a key, keyed by column uuid, plus the carrier nodes. `ResolvedSortDirective` gains optional `order`, `direction` and `blanks` (absent for a key with no rule) and a third arm `kind: "variables"` for a key whose text needs locale variables. `SORT_TYPE_WIRE_MAP` keeps `string`, `int`, `double` for the suite only.
- `sortKeys.ts::buildSortBlock` writes `type` always and `order`, `direction`, `blanks` only with a rule, in HQ's attribute order (`suite_xml/xml_models.py::Sort`). The implicit rule writes `order="1" direction="ascending"` and no `blanks`, as HQ's default element has none; Core reads that as blanks first.
- `columns.ts::resolveSortElement` writes, per key: `property`, the wire path; `mapping-position`, `if(selected(<path>, '<value 0>'), 0, if(selected(<path>, '<value 1>'), 1, ''))` from new `idMappingSortXpath` and `imageMapSortXpath` beside `idMappingDisplayXpath` (values through `quoteLiteral`, positions as bare numbers, the closing `''`); `option-label` and `interval-text`, the field's display expression with the same `<variable>` children its template carries (`propertyDisplayProjection`); `link-text` and `calculated`, `$calculated_property` with its variable.
- `shortDetail.ts::buildShortDetail` walks the plan's fields (the `hidden && !sortByUuid.has(...)` skip goes), then appends one field per carrier: an empty-text header at width 0, a width 0 template over the raw wire path, and the `<sort>`. This is what HQ builds from `create_temp_sort_column` with an element whose `display` is empty (`detail_screen.py::Invisible.header`, `models/case_list.py::SortElement.has_display_values`).

### Reader 3: Preview, through the case store

- `lib/preview/engine/caseDataBindingHelpers.ts::buildCaseStoreSortKeys` takes the plan (built with `caseListOrderOptions`, as readers 1 and 2 build it), the worker language (`ColumnDisplayContext.language`) and the case type, and returns one `SortKey` per rule in `order`, fields and carriers together, then the `case_id` tie-break for paging. `creationOrder` goes: an unsorted list is the plan's implicit rule. Preview reads only keys that carry a rule; it has no header sort and no fuzzy search.
- `lib/case-store/store.ts::SortKey` becomes a union, and gains the comparator and blanks placement:

```ts
export type SortKey =
	| { kind: "expression"; expression: ValueExpression; portableCaseDates?: true;
	    comparator: "text" | "integer" | "decimal"; direction: "asc" | "desc"; blanks: "first" | "last" }
	| { kind: "interval-text"; property: string; display: "always" | "flag";
	    thresholdDays: number; divisorDays: number; text: string;
	    direction: "asc" | "desc"; blanks: "first" | "last" };
```

- The `ValueExpression` each key compiles from, built from arms the compiler already has (`lib/case-store/sql/compileExpression.ts`):

| Key | Expression |
|---|---|
| `property` | `term(prop(caseType, property))` |
| `calculated` | the column's expression, `portableCaseDates: true` |
| `option-label`, single select | `switch` on the property: each option's value to its label in the worker language, the raw value as fallback; first match wins, as `columns.ts::plainSelectDisplayXpath` nests |
| `option-label`, multi select | `concat` of each option's label and a space where `multi-select-contains` holds, then the raw property as a second key |
| `mapping-position` | nested `if` giving the index as a TEXT literal, `""` last; the test is `multi-select-contains` for a multi-select property, `eq` otherwise |
| `link-text` | `if(is-blank(prop), "", concat("[<link text>](", prop, ")"))`. The link text is the stored `linkText`: it has no translation (`linkColumnSchema`), so no language enters |
| `interval-text` | not a `ValueExpression`: the `interval-text` arm below, whose `text` is the column's text in the worker language (its `text` translation unit, the same lookup `option-label` uses for a label) |

- **The comparator**, in `lib/case-store/postgres/store.ts::query` and `queryGrouped`, the two places a `SortKey` becomes `ORDER BY`, as `sql` tagged templates over typed-builder expressions (no `sql.raw`):
  - text: `lower(coalesce((<expr>)::text, '')) collate "C"`. Core compares `toLowerCase()` strings by code unit (`EntitySorter`), and a missing property is `""` on a device. So `"10"` sorts before `"2"`, as on a device.
  - integer and decimal: the typed read, as today.
- **Blanks placement**: a leading key `(<expr> is null or (<expr>)::text = '')`, ordered so blanks come first or last as the rule says, whatever the direction. It is needed because Postgres puts `NULL` last ascending and a blank under a numeric comparator has no natural place, while Core puts a blank first unless told otherwise.
- **The interval-text sort-key compiler**, new `lib/case-store/sql/compileIntervalText.ts`. `arith` refuses a date operand (`lib/domain/predicate/typeChecker.ts::checkExpression`), so a date difference is no `ValueExpression`, and this one key gets its own compiler entry, built from typed-builder calls. It lives in the compiler package, so the AST-to-Kysely compiler stays the only evaluator. It is needed whichever way an interval rule orders, because an unsorted list whose first field is an interval column is ordered by that text on every device (rule 7).
  - The caller converts the column: `divisorDays = TIME_SINCE_UNIT_DAYS[unit]` (the table `columns.ts::TIME_AGO_DIVISOR_DAYS` aliases), `thresholdDays = threshold * divisorDays`, `text` as above.
  - `v` is the property's text read, trimmed. `d` is its calendar day in the viewer's zone: `compileExpression.ts::compilePinnedInstant(v, <viewer zone>)` (exported for this), which reads a date-only or zone-less value in the viewer's zone and keeps an authored offset, then the date of that instant in the viewer's zone. A date-only value is therefore its own day, and a value with a time is the viewer's local day, as a device's `date()` and `formatIntervalForPreview` take it. `today` is the compiler's viewer-zone date (`lib/case-store/sql/viewerTimeZone.ts`).
  - The guard comes before any cast, so a malformed stored value never fails the query: `WHEN NOT pg_input_is_valid(v, 'timestamptz') THEN v` (Postgres 16 and later; production and the local database run 18) yields the raw text, which is `formatIntervalForPreview`'s fallback. It is written `<guard>` below.
  - `display: "always"`, the branches of `columns.ts::intervalAlwaysXpath`: `CASE WHEN v IS NULL OR v = '' THEN '' WHEN <guard> THEN v WHEN (today - d) > <thresholdDays> THEN <text> ELSE trunc((today - d) / <divisorDays>)::text END`.
  - `display: "flag"`, the branches of `columns.ts::intervalFlagXpath`: `CASE WHEN v IS NULL OR v = '' THEN <text> WHEN <guard> THEN v WHEN (today - d) > <thresholdDays> THEN <text> ELSE '' END`. A blank shows the flag text, as on a device.
- **Where Preview differs from a device, stated in `lib/preview/CLAUDE.md`:** `option-label` over a multi select orders by known labels in catalog order and then the raw value, where a device also appends tokens outside the catalog; `mapping-position` over a text property holding several space-separated tokens matches the whole value, where a device's `selected()` matches a token; text compares by code point, where Core compares by UTF-16 code unit (they differ only above the Basic Multilingual Plane).
- `components/preview/shared/listFilter.tsx::rowMatchesFilterText` matches, all taken from the plan: the shown columns' text as today; each hidden field's text, which is the raw property value, or the calculated value for a hidden calculated column; and each carrier's raw value. A carrier is a field whose width 0 template holds the raw property on every path (`detail_screen.py::FormattedDetailColumn.template` on HQ's temporary column, reader 2's carrier field locally), and Core's search matches every field's text, so **a carrier's raw value is matched by the list's search on every path**, in a tile list too.

## Defect 10: label, ID-mapping, image-map and unsorted order

**Today.** `lib/commcare/hqJson/caseList.ts::projectColumnToDetail` writes an ID mapping as `translatable-enum` with `useXpathExpression: true`, and `projectSortElements` writes `_cc_calculated_<i>` with `sort_calculation` the raw property, which `detail_screen.py::FormattedDetailColumn.sort_node` never reads for a format with its own sort, so HQ's build orders select, ID-mapping and interval columns by shown text while `sortKeys.ts::propertySortXpath` and `buildCaseStoreSortKeys` order by the raw property. An unsorted list is ordered by its first column on HQ's build and by `date_opened` in Preview.

**Fix.** The order plan, plus:

- An ID mapping is HQ's `enum` (reader 1). Its display on HQ's build is the `selected` chain `columns.ts::idMappingDisplayXpath` already writes locally (`detail_screen.py::Enum._xpath_template`), so no display changes; the list now orders by mapping position on every path.
- **HQ's key rule** lives in the validator, not the persisted schema (the step's rule for narrowings): new rule `lib/commcare/validator/rules/case-list/idMappingKeyCharacters.ts`, code `CASE_LIST_ID_MAPPING_KEY_CHARACTERS`, class soundness, at the column, for an `id-mapping` entry whose `value` holds `&`, `<`, `>`, `"` or `'`. Reason: HQ's ID mapping has no spelling for a key holding `'` (`Enum._xpath_template`), and the other four are what HQ's mapping editor marks an error for an ID mapping (`hqwebapp/js/ui_elements/bootstrap5/ui-element-key-val-mapping.js::hasBadXML`). An image-map entry takes no such rule: its HQ key is an expression, which `hasBadXML` exempts, and Nova quotes the value through `quoteLiteral`. Message: "An ID mapping value can't hold &, <, >, \" or '. CommCare HQ's ID mapping has no way to store one."
- **Correction 3** (`harness-findings.md`): an interval column orders by its shown text and an image map by mapping position, on every path (rules 3 and 6).
- **Correction 10**: an unsorted list orders by its first field, by that field's own key (rule 7), on every path. The local suite states the rule that Core otherwise infers from the first field with a header (commcare-core `cases/entity/SortableEntityAdapter.determineFieldsForSortingInOrder`), so the two paths agree for a date and an image-map first column too.
- HQ names an `enum` variable `k<key>` or `h<md5>` (`models/case_list.py::MappingItem.key_as_variable`); the local suite keeps its own `knova_text_<index>` names. Core reads only the resolved text and no proof compares the local suite's bytes with HQ's.

**Files.**
- Domain: `lib/domain/caseListOrder.ts` (new, with `comparatorForDataType`); `lib/domain/casePropertyTypes.ts` (the comment naming `applicableSortTypes`); `lib/domain/modules.ts` (comments on `idMappingEntrySchema` and `imageMapEntrySchema`, hidden-column block below).
- Doc and mutations: none (no stored shape changes outside the cutover).
- Validator: `rules/case-list/idMappingKeyCharacters.ts` (new), `lib/commcare/validator/errors.ts`, `gate.ts`, `lib/doc/userFacingErrors.ts`, the rule list in `rules/module.ts`; `lib/commcare/validator/hqJsonOracle.ts` refuses the former spellings (sort `type: "string"`, `blanks: ""`, a non-empty `sort_calculation`, `translatable-enum` on a property column); its refusal of `format: "calculate"` is pull request 12's (part 06, 10. The equivalent spellings).
- Emitters: `lib/commcare/hqJson/caseList.ts`; `lib/commcare/suite/case-list/orderPlanOptions.ts` (new), `sortKeys.ts`, `columns.ts`, `shortDetail.ts`, `types.ts`.
- Surface: `lib/commcare/surface/entries/menus-and-case-lists.json`, edited by hand as the table under "The surface entries this part edits" lists. `npm run surface` is not run: it regenerates only the generated half, `surface.json`, from the upstream checkouts, and this pull request moves no pin.
- Preview: `lib/preview/engine/caseDataBindingHelpers.ts`, `caseDataBinding.ts`; `lib/case-store/store.ts`, `lib/case-store/postgres/store.ts`, `lib/case-store/sql/compileIntervalText.ts` (new), `lib/case-store/sql/index.ts`.
- Builder: `components/builder/case-list-config/cards/column/IdMappingCard.tsx` and `components/builder/case-list-config/columnEditorSchemas.ts` (the value sentence on blur; "This list orders by the table's own order" under the table), `ImageMapColumnCard.tsx` (the same line for images), `components/builder/case-list-config/SortPriorityStack.tsx` (an unsorted list reads "Ordered by the first column"), `components/builder/case-list-config/configValidity.ts` (the new finding shows on its column).
- SA and MCP tools: `lib/agent/tools/case-list-config/shared.ts` (the mapping entry description names the excluded characters and says entry order is sort order; the sort description says what each column kind orders by), `lib/agent/summarizeBlueprint.ts`. This changes tool schemas: the implementer asks the person before running `npm run test:schema`, which bills. With the date column's `pattern` enum below, this pull request changes the tool catalog, so it bumps `lib/models.ts::MODEL_CONTEXT_VERSION`; part 11, The model-addition checklist, item 13, is the one list of the pull requests that do and of the value each sets. Sweep `../nova-plugin` for the old claims in the same stack.
- Docs: `content/docs/case-workspace.mdx`, `content/docs/mcp/tools.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("Case-list emission" and the paragraph beginning "Sort lives on each column" are rewritten to the plan), `lib/preview/CLAUDE.md`, `lib/case-store/sql/CLAUDE.md` (the interval-text entry, the comparator), `lib/domain/CLAUDE.md` (the order plan as the one statement of a list's order).

**Stored shape and migration.** No schema change. Cutover step `id-mapping-keys` (`scripts/lib/hqRoundTripCutover/steps/idMappingKeys.ts`; step 16 of part 10, The transform steps, in order): removes each `id-mapping` entry whose `value` holds one of the five characters, with its `mapping` translations. Notice reason `id-mapping-entry-removed`, naming the menu, the column and the value: "<menu>, <column>: the mapping for <value> is gone. CommCare HQ's ID mapping can't hold that value, so cases with it now show nothing in this column."

The order changes that write nothing get lines from `scripts/lib/hqRoundTripCutover/behavior.ts`, which reads the migrated document and its order plan. Reason `case-list-order-changes`, one line per list, naming the menu and, for the first four causes, the column. `detail.cause` is the first of these that holds, tested on the field that takes the list's FIRST rule (rule 5), or on field 0 where the list has no authored rule:

| `detail.cause` | Holds when that field is | Installs that change | Copy |
|---|---|---|---|
| `id-mapping` | an ID mapping | every one | "<menu>: the list now orders <column> by the order of its mapping table. Apps installed from CommCare HQ ordered it by label, and downloaded apps and Preview by the stored value." |
| `image-map` | an image map, in an app with media | downloaded `.ccz` and Preview | "<menu>: downloaded apps and Preview now order <column> by the order of its image table, as apps installed from CommCare HQ already do." |
| `interval` | a shown interval column | downloaded `.ccz` and Preview | "<menu>: downloaded apps and Preview now order <column> by the text it shows, not by its date, as apps installed from CommCare HQ already do." |
| `option-label` | a shown plain column over a select with options | downloaded `.ccz` and Preview | "<menu>: downloaded apps and Preview now order <column> by its labels, not by the stored values, as apps installed from CommCare HQ already do." |
| `unsorted` | anything else, in a list with no authored rule | Preview; a downloaded `.ccz` only where field 0 is a date column | "<menu>: with no order rule, Preview now lists cases by the first column, as devices do." and, where field 0 is a date column, the added sentence "Downloaded apps now order that column by date, not by the text it shows." |

A list whose first rule lands on any other field (a plain, phone, date, link or calculated column, a hidden field, a carrier) gets no line: its order is the same on every install before and after. On an unsorted list a downloaded app already ordered by the first column's shown text (Core's inference), so for `interval` and `option-label` only Preview changes there; the copy is the same.

**Register.** 2 entries move to `proof/fixed-defects.json`: `d10-row-order-trace-rows-caseid` and `d10-row-order-trace-rows-sortfields`, check proof 3, control `expander-expanddoc-hq-json-projection-sort-elements-5899296f-0`.

**Spelling rule.** None of its own; the four sort rules retire in "The sort spellings" below.

**Identity.** None. Proof 1's identities hold no column position, detail locale id or sort element, and `proof/identity-moves.json` gains no entry.

**Control.** `expander-expanddoc-hq-json-projection-sort-elements-5899296f-0` keeps the pre-fix archive, so proof 3 keeps reporting both classes there. `targeted-label-sort` stays admitted and turns from symptom to witness.

**Nova tests.**
- Pure, `lib/domain/__tests__/caseListOrder.test.ts`: the plan for every column kind, shown and hidden, as field 0 of an unsorted list (a plain column over `case_id` included); two columns over one property in both orders; a rule on a link with and without a property field over its property (join and carrier), and on a link over `case_id` (positional, `link-text`); the equal-text joins of rule 5 (a rule on a hidden `case_id` carrier after a shown `case_id` column lands on the shown field; a rule on a plain `status` column after an ID mapping over `status` lands on the mapping; a rule on the second of two calculated columns with one expression lands on the first); a hidden interval column as a property field; rule numbering; every rule 3 key present with no rule.
- Pure, `lib/commcare/__tests__/caseListOrderParity.test.ts` (the shape of `tileEmissionParity.test.ts`): one admitted document through `expandDoc` and the local compiler; for each field the HQ element the plan implies and the local `<sort>` are read from the emitted JSON and the parsed suite, never by pattern, and compared with the plan. The document holds the two equal-text shapes that an admitted document can hold: a shown `case_id` column before a hidden `case_id` column that carries the rule (the local `@order` and HQ's joined element both sit on the SHOWN field), and two calculated columns with one expression, the rule authored on the second. It also asserts that two fields have equal `joinText` exactly when their emitted HQ `field` strings are equal.
- Real Postgres, `lib/preview/engine/__tests__/caseListOrder.postgres.test.ts`: rows holding `"10"` and `"2"`, a blank, a missing property and mixed-case text, ordered by each key in both directions and compared with the order the plan's comparator defines; `lib/case-store/sql/__tests__/compileIntervalText.postgres.test.ts` compares the compiled text row by row with `lib/preview/columnDisplay.ts::formatIntervalForPreview`, for both displays, over a blank, a missing property, a date-only value, a zone-less datetime, a datetime with an offset on each side of the viewer's midnight, malformed text, and an impossible date (`2026-02-31`), none of which may fail the query.
- Pure, `lib/commcare/validator/rules/case-list/__tests__/idMappingKeyCharacters.test.ts`: each of the five characters refused beside an accepted neighbour, and an image-map value holding `'` accepted.
- Playwright, one smoke test: the ID mapping card shows the sentence for `a'b`.

**Lane.** Locally: `npm run proof -- proof/checks -k targeted-label-sort`, then the same for `case-list-inline` and the `-5899296f-0` control. CI's full lane must show no proof 3 difference at `/runs/*/trace/*/rows/*/caseId` or `/sortFields/*` on any corpus document, and both fixed entries held on their control. Proof 4 confirms the Case List page keeps an `enum` column and the new sort elements unchanged. Fallback, decided: a difference that remains is a wrong rule in `caseListOrderPlan` or a spelling the page rewrites, corrected in the emitter in this pull request; no entry is registered for it.

## Finding 51: the sort keys a field keeps

**Today.** `sortKeys.ts::buildSortDirectives` returns an empty map for an unsorted list and keys every directive to its authored column, so the local suite puts sort keys on other fields than HQ's build does, and a fuzzy search reads them.

**Fix.** Entirely the plan: the implicit rule on field 0 (rule 7), the join of every element to the first field with its join text (rule 5), and the keys fields keep with no rule (rule 3). Rule 3 is required, not optional: without it the local trace differs from HQ's on every list that shows a date, an ID mapping, an image map, a select label or an interval, sorted or not.

**Files.** Those of defect 10; no others.

**Stored shape and migration.** None. A join that would order by another column's key is refused and migrated by `CASE_LIST_SORT_PROPERTY_AMBIGUOUS` below.

**Register.** 2 entries: `d51-sort-keys-trace-rows-sortfields-removed` (control `case-operation-query`) and `d51-sort-keys-trace-rows-sortfields-added` (control `targeted-shared-property-sort`), check proof 3.

**Spelling rule.** None.

**Identity.** None; `proof/identity-moves.json` gains no entry.

**Control.** `case-operation-query` and `targeted-shared-property-sort`; the latter's document stays admitted as a witness (a hidden order carrier after a shown column over one property joins the shown column, with the same key).

**Nova tests.** Pure: the parity test asserts that the set of local fields holding a `<sort>`, and the subset holding `@order`, equal the plan's, on an unsorted list, on the shared-property document, and on a list where a hidden `case_id` rule joins an earlier shown `case_id` field.

**Lane.** Locally: `-k targeted-shared-property-sort` and `-k case-operation-query`. CI: no `sortFields` difference in either direction on any corpus document; both fixed entries held.

## Hidden columns: defect 16's column half, findings 35 and 36

**Today.** `caseList.ts::hqShortSourceColumns` and `shortDetail.ts::buildShortDetail` drop a column hidden from Results unless it carries an order rule, so a list's search does not match it; Preview's `listFilter.tsx::rowMatchesFilterText` matches shown columns only. A hidden select column holds its raw value on HQ's build and its label expression locally (`columns.ts::buildColumnField` keeps `propertyDisplayProjection`), and `columns.ts::buildHeaderBlock` writes the header text at width 0 where `detail_screen.py::Invisible.header` writes an empty text, so Android's Sort menu offers the hidden column on a local install.

**Fix.**
- Every column of a list with no tile layout is a field of the short detail on both paths (rule 1), and Preview's quick filter matches every hidden field's text and every carrier's raw value (reader 3). A device's search matches every field's text, hidden fields and carriers included (commcare-core `util/EntitySortUtil.sortEntities`).
- A hidden field's local shape is HQ's, byte for byte: header `<header width="0"><text/></header>` with no locale id, no entry in the app strings or the translation units; template `width="0"` over the RAW wire path for a column that is not calculated (never the label expression, never variables), and the calculated template for a calculated one.
- `lib/domain/modules.ts::caseListColumnIsEmitted` is replaced by two predicates, because "reaches a runtime" now has two meanings:
  - `caseListColumnRuns(column, config)`: a runtime evaluates the column's value. True for every column of a list with no tile layout; in a tile list, `visibleInList !== false || visibleInDetail !== false`. Read by `lib/commcare/compiler.ts`, `lib/commcare/suite/case-search/searchSession.ts::buildSearchSession`, `lib/commcare/suite/case-search/relatedCaseProjection.ts`, `lib/preview/engine/caseDataBindingHelpers.ts` and `proof/corpus/footprint.ts` (its calculated-column walk).
  - `caseListColumnTextShows(column)`: its header, labels or images reach a screen: `visibleInList !== false || visibleInDetail !== false`. Read by `lib/domain/translationUnits.ts` and by every call site in `lib/domain/mediaRefs.ts`, the inverted one included (`column.kind !== "image-map" || caseListColumnTextShows(column)`). A hidden order carrier no longer counts: its header is now empty on every path.
  - `lib/commcare/projectSpaceCompatibility.ts::linkWriteIsShown`, which pull request 13 adds (part 03, C3. Defect 12: the flag probe), reads `caseListColumnTextShows`; `caseListColumnIsEmitted` no longer exists when it lands.
- **Instance accumulation for a fully hidden calculated column.** Today a calculated column hidden from both screens with no order rule is skipped by the instance walk (`lib/commcare/session.ts::accumulateCaseLoadingInstances`, fed from `compiler.ts`) and by the related-case search projection. From step 2 its expression is evaluated for every row in the hidden field, so a lookup table, a parent case or a session read it names must be declared on the entry and on the remote request, or the list fails to open on a device. Both walks take `caseListColumnRuns`, and `validator/rules/case-search/searchRelatedCalculationCompatibility.ts` holds such a column to the same refusals as a shown one. A document that the widened refusal now stops is scan-blocking (the cutover stops for a person; none expected, since the shape needs a hidden, unsorted calculated column over a related case in a searching list).
- Defect 16's comment half for this code: the two mapping schemas' comments and messages stop saying `selected()` "splits both sides on whitespace" (commcare-core `xpath/expr/XPathSelectedFunc.multiSelected` trims only the key and matches it as one token). The schemas keep refusing blank and multi-token values; the message becomes "A mapping value is one word with no spaces."

**Files.**
- Domain: `lib/domain/modules.ts` (the two predicates, the mapping comments and messages), `lib/domain/translationUnits.ts`, `lib/domain/mediaRefs.ts`.
- Proof: `proof/corpus/footprint.ts` takes `caseListColumnRuns(column, config)`.
- Doc and mutations: none.
- Validator: `rules/case-search/searchRelatedCalculationCompatibility.ts` (the widened refusal, and its header comment, which names `caseListColumnIsEmitted`).
- Emitters: `lib/commcare/hqJson/caseList.ts` (`hqShortSourceColumns`, `projectColumnForShortDetail`, the comment block on `projectCaseListForHq`), `lib/commcare/suite/case-list/columns.ts` (`buildHeaderBlock`, `buildTemplateBlock`, `buildColumnField`, `buildCalculatedField`), `shortDetail.ts`, `lib/commcare/compiler.ts`, `lib/commcare/suite/case-search/searchSession.ts`, `relatedCaseProjection.ts`.
- Preview: `components/preview/shared/listFilter.tsx`, `lib/preview/engine/caseDataBindingHelpers.ts`.
- Builder: hiding is done on the canvas, not on a card. `components/builder/case-list-config/CaseListConfigWorkspace.tsx` (the announcement on hiding a column from Results) and `components/builder/case-list-config/canvas/DisplayFieldComposer.tsx` (the placement line of a column that is not on Results) say "Hidden from Results. The list's search still matches it." for a list with no tile layout.
- SA and MCP tools: `lib/agent/tools/case-list-config/shared.ts` (the `visibleInList` description), `lib/agent/summarizeBlueprint.ts`; ask the person before `npm run test:schema`.
- Docs: `content/docs/case-workspace.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md` (the sentence "Fully off-screen, unsorted definitions have no runtime role and are ignored" is replaced by the two predicates), `lib/preview/CLAUDE.md`, `lib/domain/CLAUDE.md` (its sentence naming `caseListColumnIsEmitted` as the sole predicate), `docs/architecture/contracts.md` (the same sentence there).

**Stored shape and migration.** None stored. `behavior.ts` emits two lines from the migrated document:

- Reason `case-list-search-matches-hidden-fields`, for each list with NO tile layout that holds a column with `visibleInList === false`, naming the menu: "<menu>: the list's search now also matches the fields hidden from Results."
- Reason `hidden-order-column-not-in-sort-menu`, for each list, tile or not, that holds a column with `visibleInList === false` and a `sort`, naming the menu and the column: "<menu>: Android's Sort menu no longer offers <column> in a downloaded app, because the column is hidden. The list's own order still follows it." Apps installed from CommCare HQ never offered it.

**Register.** 3 entries: `d16-hidden-columns-evaluate-rows-caseid` (intent, values pinned, control `targeted-hidden-column`), `d35-hidden-select-text-trace-rows-fields` (proof 3, control `expander-expanddoc-hq-json-projection-sort-elements-keeps-67fa0ac7-0`), `d36-hidden-sort-offered-trace-headers` (proof 3, control `case-list-inline`).

**Spelling rule.** None.

**Identity.** None; `proof/identity-moves.json` gains no entry.

**Control.** `targeted-hidden-column`, `expander-expanddoc-hq-json-projection-sort-elements-keeps-67fa0ac7-0` and `case-list-inline`. The `expandDoc HQ JSON projection sort elements` tests this pull request edits keep their titles and their document counts, so the corpus ids of their documents (`-5899296f-0`, `-keeps-67fa0ac7-0`, `-85a51a04-0`) do not move while `proof/rules/conftest.py::DOCUMENTS` and the register still name them; only their assertions change.

**Nova tests.**
- Pure: the parity test asserts, for a hidden select column, the same raw text on both paths and an empty header with no locale id; a test that `translationUnits` lists no header unit for a hidden order carrier.
- Pure, `lib/commcare/__tests__/hiddenCalculatedInstances.test.ts`: a fully hidden calculated column that reads a lookup table, and one that reads a parent property, declare their instances on the entry and on the remote request, read from the parsed suite.
- Playwright: Preview's quick filter finds a case by a hidden column's value (the lane does not run Preview).

**Lane.** A new targeted document, `targeted-hidden-calculated-column` (`proof/targeted/documents/hiddenColumn.ts`): a list with a calculated column hidden from both screens that reads a lookup table, with intent expectations that the list opens and that a search by the calculated value finds its case. It is a passing document with no entry. Locally: `-k targeted-hidden-column`, `-k targeted-hidden-calculated-column`, `-k case-list-inline`. CI: no proof 3 difference at `/rows/*/fields/*` or `/headers/*` for a hidden field; proof 4 shows the Case List save keeping `/modules/*/case_details/short/columns/*/header` on every hidden column, for both header spellings of reader 1; the three fixed entries held. Fallback, decided: if the save rewrites the header of a column hidden from both screens, that column writes the map the save leaves, in this pull request.

## Finding 38: image-map width

**Today.** `columns.ts::buildHeaderBlock` and `buildTemplateBlock` write no width for an image-map field, while HQ's build writes `13%` on its header and template (`detail_screen.py::EnumImage.template_width` and `header_width`; `feature_support.py::enable_case_list_icon_dynamic_width` returns `False`).

**Fix.** Both builders take a width string. An image-map field with media on writes `width="13%"` on header and template, on the short and the long detail; a hidden one writes `0`.

**Files.** Emitters: `lib/commcare/suite/case-list/columns.ts`, `longDetail.ts`. CLAUDE.md: one line in `lib/commcare/CLAUDE.md`, "Case-list emission". No other group changes.

**Stored shape and migration.** None, and no notice: Android lays the column out from the hint and nothing else reads it.

**Register.** 2 entries: `d38-image-map-width-trace-headerwidths` and `d38-image-map-width-trace-templatewidths`, proof 3, control `case-list-inline`.

**Spelling rule.** None. **Identity.** None; `proof/identity-moves.json` gains no entry. **Control.** `case-list-inline`.

**Nova tests.** Pure: an image-map field's header and template carry `13%` on both details, a hidden one `0`, read from the parsed suite.

**Lane.** Locally `-k case-list-inline`. CI: no `headerWidths` or `templateWidths` difference on any corpus document; both fixed entries held.

## The corrected tile clause

**Today.** In a list with a custom tile, a column hidden from Results reaches the short detail only when it carries an order rule, as a stored `invisible` column with no cell (`caseList.ts::hqShortSourceColumns`, `lib/domain/modules.ts::tileCellFor`). HQ's Case List save writes a cell for every stored column, `invisible` ones included (`static/app_manager/js/details/bootstrap5/column.js`, `serialize`: `grid_x` 0, `grid_y` 0, `width` 6, `height` 1), and HQ's build then styles it (`suite_xml/features/case_tiles.py::CaseTileHelper.build_case_tile_detail`), so one save changes the tile.

**Fix.** The research's sentence (a hidden column in a custom tile is refused, and the migration removes each) is corrected, because a column hidden from Results is usually shown on Details and devices show it there today. Nothing is refused for a hidden column as such. The refusal is narrowed to the shapes that have no spelling inside HQ's envelope: a hidden column that carries an order rule and can only be written as a stored expression column.

| Column hidden from Results, in a tile list | From step 2 |
|---|---|
| No order rule, shown on Details or not | Nothing is refused and nothing is removed. It stays out of the tile's short detail and its search (today's behavior) and stays in the long detail where `visibleInDetail !== false`. |
| Order rule, a column of any kind but calculated over a property that is not attribute-backed | The rule rides as a sort-only property carrier (rules 4 and 5): a sort row on the property and no stored column. HQ appends the hidden field itself (`util.py::create_temp_sort_column`), it is never stored, so no save can give it a cell, and `build_case_tile_detail` writes no style for it. If a field's join text equals the property name the rule joins that field. The carrier's raw value is matched by the list's search (reader 3). |
| Order rule, calculated column | Refused: `CASE_TILE_HIDDEN_CALCULATED_SORT`. |
| Order rule, a column over an attribute-backed property (`case_id`, `owner_id`, `status`) | Refused under the same code, and removed by the same migration. Finding 57 makes every stored column over one of the three an expression column, so its order rule is a positional element that needs the stored column, exactly as a calculated column's does. |

- **All three attribute-backed properties are refused, not `case_id` alone.** `case_id` has no property element at all (rule 4), so its hidden order rule can only be a positional element on a stored column. `owner_id` and `status` do have a bare-name sort row that HQ's validators pass (`helpers/validators.py::ModuleDetailValidatorMixin._validate_detail_screen_field`, `static/app_manager/js/details/utils.js::isValidPropertyName`) and that HQ's temporary column would read through `detail_screen.py::CASE_PROPERTY_MAP`. It is not used for a hidden tile column, for two reasons. Finding 57 gives every stored column over the three one spelling, the expression column with a positional sort, and that spelling was executed; a hidden `owner_id` or `status` column that ordered through a bare-name carrier in a tile list and through a positional element everywhere else would be a second spelling of one authored thing, resting on reading alone. And one rule for the three is what a person can hold in mind: an order rule on one of the three needs its column on the tile.
- **The refused shapes.** New rule `lib/commcare/validator/rules/case-list/caseTileHiddenCalculatedSort.ts`, code `CASE_TILE_HIDDEN_CALCULATED_SORT`, class soundness, at the column: in a list with a tile layout, a column with `visibleInList === false` and a `sort` that is calculated or reads a member of `lib/domain/standardCaseProperties.ts::ATTRIBUTE_BACKED_COLUMN_PROPERTIES` (`case_id`, `owner_id`, `status`; the constant finding 57's block adds). The code keeps its name though it now covers both shapes: both are stored expression columns. Reason: a positional element needs the stored column, which a Case List save gives a cell; the only other spelling, a sort row carrying a `sort_calculation`, is dropped by the same save unless the project has `SORT_CALCULATION_IN_CASE_LIST` (`views/modules.py::_update_sort_elements`), and Nova adds no gate for it in step 2. Two messages, by shape:
  - calculated: "A tile list can't order by a calculation that isn't on the tile. You can place this column on the tile, or order by a case property."
  - attribute-backed: "A tile list can't order by <label> unless the column is on the tile. You can place this column on the tile.", where `<label>` is `lib/domain/standardCaseProperties.ts::standardCasePropertyDisplayLabel` of the property: "Record ID", "Owner" or "Case status (open or closed)".
- **Where a bare-name sort row remains.** Only a SHOWN link over `owner_id` or `status` writes one (rule 4, exception i), in a tile list or not; no field's join text equals the bare name, so HQ appends its carrier, which reads `@owner_id` or `@status` through `CASE_PROPERTY_MAP`. That shape is today's and is not changed by this block. It rests on reading, so the lane keeps a document for it: `targeted-attribute-columns` holds a second list with a shown link over `status` that carries the list's order rule (finding 57's block, "Its targeted documents"), and the parity test and `hqJsonOracle.ts` hold its spelling.
- **Search in a tile list, stated exactly.** A column hidden from Results with NO order rule is not matched by a tile list's search; one WITH an order rule is, through its carrier. Tile lists get the search fix for the first kind in step 7, which holds a hidden column's cell. Until then every surface says what is true.
- **Who reads what.** `lib/domain/modules.ts::tileCellFor` is unchanged: it already returns no cell for a column hidden from Results, and rule 1's tile arm uses the same test (`caseListOrder.ts` imports `modules.ts`, never the reverse). `lib/preview/caseTileRendering.ts::tileResultsColumns` and `caseList.ts::applyTileLayoutToShortDetail` iterate `plan.fields`, so all three agree on which columns a tile's short detail holds.

**Files.**
- Domain: `lib/domain/caseListOrder.ts` (rule 1's tile arm, rule 4's exception iii), `lib/domain/modules.ts` (`tileCellFor`'s comment only; its body is unchanged).
- Doc and mutations: none.
- Validator: `rules/case-list/caseTileHiddenCalculatedSort.ts` (new), `errors.ts`, `gate.ts`, `lib/doc/userFacingErrors.ts`, `rules/module.ts`; the header comment of `rules/case-list/caseTileLayout.ts` (its "zero-width sort carrier" paragraph).
- Emitters: `lib/commcare/hqJson/caseList.ts` (`applyTileLayoutToShortDetail` and its comment), `lib/commcare/suite/case-list/shortDetail.ts`.
- Preview: `lib/preview/caseTileRendering.ts`.
- Builder: `components/builder/case-list-config/tile/TileLayoutCanvas.tsx` and `components/builder/case-list-config/canvas/DisplayFieldComposer.tsx` (the placement line): "Not on the tile. The list's search doesn't match it yet." for a column hidden from Results with no order rule in a tile list; `components/builder/case-list-config/configValidity.ts` shows the new finding on its column.
- SA and MCP tools: `lib/agent/tools/case-list-config/setCaseListTile.ts`, `shared.ts` descriptions; ask before `npm run test:schema`.
- Docs: `content/docs/case-workspace.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("Case-tile emission"), `docs/architecture/contracts.md` (the tile search gap, scoped to a column hidden from Results with no order rule, as a stated gap until step 7).

**Stored shape and migration.** No schema change. Cutover step `tile-hidden-calculated-sort` (`steps/tileHiddenCalculatedSort.ts`; step 18 of part 10, The transform steps, in order): in each list with a tile layout, removes the `sort` of each column hidden from Results that is calculated or reads `case_id`, `owner_id` or `status`, which is every column the rule refuses. The column itself stays, with its place on Details. Notice reason `tile-order-rule-removed`, naming the menu and the column, with `detail.shape` (`calculated` or the property name) choosing the sentence: "<menu>: the list no longer orders by <column>. A tile list can't order by a calculation that isn't on the tile." or "<menu>: the list no longer orders by <column>. A tile list can't order by <label> unless the column is on the tile.", with the same three labels as the rule's message."

**Register.** 6 entries, the ones of defect 14's nine tile entries that an unplaced hidden carrier draws: `d14-tiles-app-null-on-an-unplaced-custom-tile-column` (manifest), `d14-tiles-app-grid-x-changed`, `-app-grid-y-changed`, `-app-height-added`, `-app-width-added`, `d14-tiles-suite-style-added` (proof 4), all on control `tile-grouped-browse`. The other three move in the next block.

**Spelling rule.** None. `proof/rules/tile_cell_fields.py` stays: it covers details that are not custom tiles, where Nova still writes no cell.

**Identity.** None; `proof/identity-moves.json` gains no entry.

**Control.** `tile-grouped-browse`.

**Nova tests.** Pure: the plan's tile arm (a hidden rule over an authored property is a carrier, a hidden column with no rule is no field, and a shown link over `owner_id` with a rule is a carrier named `owner_id`); `lib/commcare/validator/rules/case-list/__tests__/caseTileHiddenCalculatedSort.test.ts` (a hidden calculated column with an order rule refused; a hidden column with an order rule over each of `case_id`, `owner_id` and `status` refused, each with its own label in the message; beside them accepted: a hidden order rule over an authored property, the same four columns hidden with no order rule, the same four shown on the tile with one, and the same four hidden with one in a list with no tile layout); `lib/commcare/__tests__/tileEmissionParity.test.ts` asserts the HQ JSON holds no `invisible` column in a tile's short detail and one sort row for the carrier, and the local suite one styleless carrier field. Native proof: `proof/native/test_tile_emission.py` reads the carrier with Core's suite parser on both paths (no grid, order kept). Pure, cutover: the step over a frozen pre-step fixture holding a tile list with a hidden calculated order rule, one hidden order rule over each of `case_id`, `owner_id` and `status`, and a hidden order rule over an authored property, asserting the four removals, the kept rule, the kept columns and each notice sentence.

**Lane.** A new passing document with no entry, `targeted-tile-hidden-order` (`proof/targeted/documents/customTile.ts`): a tile list ordered first by one hidden plain column over an authored property and then by a second hidden plain column over another authored property, with cases that tie on the first and differ on the second, so each rule is seen to order; its intent expectations say the rows come in that order, and proof 4 must show the Case List save changing nothing. Locally: `-k tile`, `-k workforce-tile-persistent`, `-k tile-grouped-browse`, `-k targeted-tile-hidden-order`. CI: proof 4 shows no `grid_x`, `grid_y`, `height`, `width` or `style` difference on a tile document after the Case List save; the six fixed entries held. Fallback, decided: if a save still changes a property carrier, every hidden order rule in a tile list is refused under the same code and step, with the message "A tile list can't order by a column that isn't on the tile. You can place this column on the tile." and the notice sentence "A tile list can't order by a column that isn't on the tile."

## Tile cells and finding 42

**Today.** `lib/domain/modules.ts::tileCellSchema` holds `horizontalAlign`, `verticalAlign` and `fontSize` as optional slots, and `caseList.ts::applyTileLayoutToShortDetail` and `lib/commcare/suite/case-list/tileStyle.ts::buildTileStyleBlock` write each only when set. HQ's Case List save writes all three for every cell (`column.js` defaults: `left`, `start`, `medium`), so one save changes the tile.

**Fix.**
- The three slots are required on a cell. `lib/domain/modules.ts::tileCell()` fills `left`, `top`, `medium` when a caller gives none. Reason for required over "optional with an emitted default": absence would then mean exactly those values, two spellings of one state, and step 6's reader always sees explicit values. `showBorder` and `showShading` stay optional (the lane reports nothing for them).
- Both emitters write the three on every cell: `horizontal_align`, `vertical_align` through `tileStyle.ts::TILE_VERTICAL_ALIGN_WIRE` (`top` is `start`), `font_size`; `horz-align`, `vert-align`, `font-size` on `<style>`.
- **What changes on Android** (commcare-android `views/EntityViewTile.java::getView`, `computeGravity`, `setScaleType`; commcare-core `util/GridStyle.java`): `top` changes nothing (Android has no case for `start` and reads it as none). `left` moves an image cell from the centre of its cell to its start and aligns text left in a right-to-left language. `medium` sets a text size where absence left Android's default.
- **What changes in Web Apps** (`cloudcare/static/cloudcare/js/formplayer/menus/views.js::getValidFieldAlignment`, `buildCellLayout`; `cloudcare/static/cloudcare/js/formplayer/constants.js::ALLOWED_FIELD_ALIGNMENTS`): an absent alignment reads as `start`, so `top` (sent as `start`) changes nothing, and explicit `left` changes nothing in a left-to-right language and moves text from the right edge to the left in a right-to-left one. `medium` stops the cell inheriting the list's size.
- No explicit value reproduces absence (HQ's page offers `left`, `center`, `right`), so the migration takes HQ's own defaults, which are also what the first Case List save in HQ would write.

**Files.**
- Domain: `lib/domain/modules.ts` (`tileCellSchema`, `tileCell`, the comments on `TILE_FONT_SIZES` and the alignments).
- Doc and mutations: `lib/doc/types.ts`; the tile mutations' callers through `tileCell()` (`components/builder/case-list-config/tile/tileMutationPlan.ts`, `tilePresets.ts`).
- Validator: none (schema).
- Emitters: `lib/commcare/hqJson/caseList.ts::applyTileLayoutToShortDetail`, `lib/commcare/suite/case-list/tileStyle.ts`, `columns.ts` (`tileStyleChildren`).
- Preview: `lib/preview/caseTileRendering.ts::planTileCell` (the inherit branch goes).
- Builder: `components/builder/case-list-config/tile/TileCellInspector.tsx` shows the three as chosen values.
- SA and MCP tools: `lib/agent/tools/case-list-config/setCaseListTile.ts` and `shared.ts` (the three stay optional inputs with the defaults stated; the read projection `lib/agent/summarizeBlueprint.ts::tilePlace` always shows them); ask before `npm run test:schema`.
- Docs: `content/docs/case-workspace.mdx`, `content/docs/mcp/tools.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("Case-tile emission": "An unset presentation slot stays off the wire" is no longer true).

**Stored shape and migration.** `tileCellSchema` requires the three slots. Cutover step `tile-cells` (`steps/tileCells.ts`; step 20 of part 10, The transform steps, in order): fills `horizontalAlign: "left"`, `verticalAlign: "top"`, `fontSize: "medium"` on every cell missing one. Notice reason `tile-cell-defaults-set`, naming each menu whose tile changed: "<menu>: each tile cell now states its size and alignment. On Android, text may show at a different size and images sit at the start of their cell. In Web Apps, text no longer follows the list's size. In a right-to-left language, text now aligns left on both."

**Register.** 8 entries. Defect 14's remaining three: `d14-tiles-app-null-on-a-custom-tile-column` (manifest), `d14-tiles-app-font-size`, `d14-tiles-suite-style-font-size` (proof 4), control `targeted-custom-tile`. Finding 42's five: `d42-tile-alignment-app-null-on-a-placed-custom-tile-column` (manifest), `-app-horizontal-align`, `-suite-style-horz-align`, and the two equivalence entries `-app-vertical-align`, `-suite-style-vert-align` (proof 4), control `targeted-custom-tile`. With the six of the tile clause, all nine of defect 14's tile entries and all five of finding 42 move.

**Spelling rule.** None; `tile_cell_fields` stays.

**Identity.** None; `proof/identity-moves.json` gains no entry.

**Control.** `targeted-custom-tile` keeps the pre-fix bytes and its retained `export/CASE_LIST_TILE` configuration, so the eight classes keep showing there whatever defect 12's gate later does to the document's configurations. Its document stays admitted as a witness.

**Nova tests.** Pure: `tileCell()` defaults; `tileEmissionParity.test.ts` asserts the three attributes on every cell on both paths; a state-model test of `planTileCell` for the three defaults. Native proof: `test_tile_emission.py` updates to the explicit attributes read by Core's parser. Pure, cutover: the step over the frozen fixture.

**Lane.** Locally `-k targeted-custom-tile`. CI: proof 4 shows no `horizontal_align`, `vertical_align`, `font_size` or `style/@*` difference after the Case List save on any tile document; eight fixed entries held. The lane cannot observe Android's or Web Apps' rendering; the source citations above stand for it.

On `targeted-custom-tile` under its `CASE_LIST_TILE` configuration, defect 12's save drops the tile (its six `d12-custom-tile-*` entries, which pull request 13 moves; part 03, C3. Defect 12: the flag probe), and from this pull request that save can also drop the three keys Nova now writes. Decided: those classes are defect 12's, not this block's. If the run reports them, this pull request adds them as `d12-custom-tile-app-horizontal-align`, `d12-custom-tile-app-vertical-align` and `d12-custom-tile-app-font-size` (proof 4, `/modules/*/case_details/short/columns/*/<key>`, `app.json@case list@*@CASE_LIST_TILE`), on a new control `targeted-custom-tile-explicit-cells` retained from this pull request's bytes, because the existing control's bytes hold none of the three keys and cannot show a save dropping them. The suite side needs no entry: `d12-custom-tile-suite-style` already holds the whole `<style>`. Pull request 13 moves the three with the other six. If the run reports none, nothing is added.

## The sort spellings and the four rules they retire

**Today.** `projectSortElements` writes `type` from `SORT_TYPE_WIRE_MAP` (`string`), `blanks: ""`, `display: {}`, and a `sort_calculation` beside `_cc_calculated_<i>`; four spelling rules erase the differences a Case List save makes.

**Fix.** Reader 1's element is the Case List page's own:

| Key | Nova writes today | From step 2 | HQ source |
|---|---|---|---|
| `type` | `string` | `plain`, `date`, `int`, `double` | `sort_rows.js` keeps a loaded type; the page's menu offers these words |
| `blanks` | `""` | `first` ascending, `last` descending | `sort_rows.js` |
| `display` | `{}` | `{ <first language's HQ code>: "" }` | `views/modules.py::_update_sort_elements` sets `display[lang]` for the page's language, the app's first unless a cookie says otherwise |
| `sort_calculation` | the raw property or the expression | `""` always | the save copies it only under `SORT_CALCULATION_IN_CASE_LIST` |

The local `<sort>` writes `blanks` wherever a rule is authored, as HQ's build copies it from the element.

**Files.** Emitters: `lib/commcare/hqJson/caseList.ts`, `lib/commcare/suite/case-list/sortKeys.ts`. Validator: `lib/commcare/validator/hqJsonOracle.ts` (defect 10's list). Proof: the four rule modules and their tests, `proof/rules/__init__.py::RULES`, `proof/rules/conftest.py::DOCUMENTS` (loses `expander-expanddoc-hq-json-projection-sort-elements-1e1c54c0-0` and `-5899296f-0`, read only by the four tests), `proof/README.md` (the rule table). No other group changes.

**Stored shape and migration.** None, no notice: no runtime reads any of the four differently.

**Register.** None; these differences were erased by rules, never registered.

**Spelling rule.** Four retire in this pull request: `proof/rules/sort_type_plain.py`, `sort_blanks_default.py`, `sort_calculation_pair.py`, `sort_display_empty.py`, each with its test (`proof/rules/test_closed_set.py` holds the set). `column_tab_keys`, `tile_cell_fields`, `detail_null_booleans` and `lookup_fields_unshown` stay.

**Identity.** None; `proof/identity-moves.json` gains no entry.

**Control.** None needed: a retired rule has no control. Proof 4 over every corpus document is what now shows a regression.

**Nova tests.** Pure: the parity test reads each element's four keys from the emitted JSON; the oracle test that the former spellings are refused.

**Lane.** Locally: `npm run proof -- proof/rules` and `-k case-list-inline`. CI: with the four rules gone, proof 4 reports no difference at `/modules/*/case_details/short/sort_elements/*` on any corpus document. Fallback, decided: where the save writes another value for one of the four keys, the emitter adopts that value in this pull request; a retired rule does not return.

## Date patterns narrowed to HQ's five

**Today.** A date column's `pattern` is any JavaRosa pattern (`lib/domain/modules.ts`, `dateColumnSchema`, `lib/domain/commCareDatePattern.ts::COMMCARE_DATE_PATTERN_REGEX`), and the builder offers `%m/%d/%Y`, `%B %e, %Y` and `%Y-%m-%d` (`lib/domain/dateFormats.ts::DATE_FORMAT_PRESET_DEFINITIONS`).

**Fix.** A date column's pattern is one of HQ's five, the only ones its Case List page can produce (`column.js`, `date_extra`): `%d/%m/%y`, `%d/%m/%Y`, `%m/%d/%Y`, `%m/%d/%y`, `%b %d, %Y`. The page keeps any other pattern it loads (`hqwebapp/js/ui_elements/bootstrap5/ui-element-select.js::Select.val`, `harness-findings.md` correction 11), so the lane shows no difference; the narrowing rests on the envelope's first half, that an editor can produce each part. A new date column takes `%b %d, %Y`. Any other format is a calculated column with a `format-date` expression, which already takes every JavaRosa pattern.

- New constant `lib/domain/dateFormats.ts::CASE_LIST_DATE_PATTERNS`, the five in the order HQ's menu lists them, each with a label and an example for 17 July 2026 (the date `DATE_FORMAT_PRESET_DEFINITIONS` uses):

| Pattern | Label | Example |
|---|---|---|
| `%d/%m/%y` | Day/month/year, short year | 17/07/26 |
| `%d/%m/%Y` | Day/month/year | 17/07/2026 |
| `%m/%d/%Y` | Month/day/year | 07/17/2026 |
| `%m/%d/%y` | Month/day/year, short year | 07/17/26 |
| `%b %d, %Y` | Month name, day, year | Jul 17, 2026 |

- `DATE_FORMAT_PRESET_DEFINITIONS` stays for the `format-date` expression (`components/builder/shared/cards/expression/FormatDateCard.tsx`); the date column stops reading it and reads `CASE_LIST_DATE_PATTERNS`.
- New validator rule `lib/commcare/validator/rules/case-list/dateColumnPattern.ts`, code `CASE_LIST_DATE_PATTERN_NOT_OFFERED`, class soundness, at the column; the persisted schema keeps its pattern check. Message: "A date column shows one of five formats. For another format, you can use a calculated column."

**Files.**
- Domain: `lib/domain/dateFormats.ts`, `lib/domain/modules.ts` (`dateColumn`'s comment and default).
- Doc and mutations: none.
- Validator: the new rule, `lib/commcare/validator/errors.ts`, `gate.ts`, `lib/doc/userFacingErrors.ts`, `rules/module.ts`.
- Emitters: none.
- Preview: none (it formats the stored pattern as today).
- Builder: `components/builder/case-list-config/cards/column/DateColumnCard.tsx` lists the five with examples and no custom input, with the line "For another format, you can use a calculated column." (`components/builder/shared/primitives/CustomDatePatternInput.tsx` stays for the `format-date` card); `components/builder/case-list-config/columnEditorSchemas.ts` (the date column's choices come from `CASE_LIST_DATE_PATTERNS`); `components/builder/case-list-config/seeds.ts` (a new date column takes `%b %d, %Y`); `components/builder/case-list-config/configValidity.ts` (the new finding shows on its column).
- SA and MCP tools: `lib/agent/tools/case-list-config/shared.ts` (the date column's `pattern` is the enum of five); ask before `npm run test:schema`. Sweep `../nova-plugin`.
- Docs: `content/docs/case-workspace.mdx`, `content/docs/mcp/tools.mdx`.
- CLAUDE.md: `lib/domain/CLAUDE.md`.
- Surface: the entry `menus-and-case-lists/2-date-date-format-d-m-y-d-m-y-m-d-y-m-d-y-b-d-y` already carries the narrow; its emission citation is updated.

**Stored shape and migration.** No schema change. Cutover step `date-patterns` (`steps/datePatterns.ts`; step 17 of part 10, The transform steps, in order), run before `tile-hidden-calculated-sort` and `sort-property-ownership`, for each date column whose pattern is outside the five:

1. The column keeps its `uuid`, `header`, visibility flags and tile cell and becomes `kind: "calculated"` with `expression: { kind: "format-date", date: <term for the column's property>, pattern }`. Its header translations stay (they are keyed by the column's uuid). Display is unchanged, a blank included: `format-date` of a blank is `""` (commcare-core `xpath/expr/XPathFormatDateFunc`).
2. Where the column carried a `sort`, the rule moves to a new column appended last in `listColumnOrder` and `detailColumnOrder`: `kind: "plain"` over the same property, `visibleInList: false`, `visibleInDetail: false`, the date column's `header` (it shows on no device, and the builder's column list and order-rule row need a name), the same `sort`, and the uuid `steps/datePatterns.ts::dateOrderColumnUuid(<date column uuid>)`, which is `uuidv5(<date column uuid>, DATE_ORDER_COLUMN_NAMESPACE)` over a fixed uuid literal declared in that file, so the transform is reproducible. The list keeps ordering by the raw date. In a tile list that hidden column is a property carrier (the tile clause), which is not refused; the one exception is a date column over an attribute-backed property, whose moved rule the next step, `tile-hidden-calculated-sort`, then removes with its own notice line, as it would for any hidden column over that property.
3. Where the list has no order rule and the column is field 0, the same hidden column is added with `sort: { direction: "asc", priority: 0 }`, which is the order HQ's default gave it (rule 7 over a date field). The list now holds an order rule it did not have; the notice says so.

`behavior.ts` skips a column whose uuid is `dateOrderColumnUuid` of another column of its list when it emits `hidden-order-column-not-in-sort-menu`: no Sort menu ever offered a column this step added.

Notice reason `date-column-became-calculation`, naming the menu and the column, built from these sentences:

- always: "<menu>, <column>: this date column is now a calculation that shows the same text. On Android, choosing its header in the Sort menu now orders by that text, not by date."
- where step 2 or 3 added the hidden column: "The list keeps its date order through a hidden column, also named <column>, and the list's search still matches the stored date."
- otherwise: "A fuzzy search no longer matches the stored date."

Reason for the changes it names: a `date` field keeps a sort key over the raw date with no rule (rule 3), which Android's header sort and a fuzzy search read, and a calculated field keeps none. Where the hidden plain column exists, its text is the raw date (a hidden field in a list with no tile layout, a carrier in a tile list), and a search matches every field's text.

**Register.** None: no entry exists for a pattern outside the five.

**Spelling rule.** None. **Identity.** None; `proof/identity-moves.json` gains no entry. **Control.** None.

**Nova tests.** Pure: `lib/commcare/validator/rules/case-list/__tests__/dateColumnPattern.test.ts` (each of the five accepted, `%Y-%m-%d` refused); the cutover step over a frozen pre-step fixture holding a sorted date column, a first-column date column in an unsorted list, and one in a tile list, asserting the stored document, the added column's uuid and header, and each notice sentence; the order plan over the migrated document equals the plan over the original for the list's default order. Native proof: one fixture in `proof/native/test_core_runtime.py` evaluating the migrated expression for a blank, a date and a datetime value against Core, compared with the former date column's text.

**Lane.** Three sources write a date column outside the five, all with `%Y-%m-%d`: `lib/commcare/__tests__/suiteDocArbitrary.ts` (every fuzz date column), `lib/commcare/__tests__/caseListEmissionFixture.ts` (the `birthdate` column of the documents `proof/corpus/producers.ts` builds from it, `case-list-inline` among them) and `lib/commcare/__tests__/expander.test.ts` (its date-format tests). Generators emit, they do not migrate: all three switch to `%b %d, %Y`, and the expander test that asserts `date_format` asserts the new pattern. One new case in `caseListEmissionFixture.ts` holds a calculated `format-date` column with `%Y-%m-%d` beside a hidden plain column that carries the order rule, the migrated shape. The corpus emission is run and `index.json` diffed: no document id changes (the tests keep their titles and counts, and a fuzz document's id is its seed and index), the bytes of every document holding a date column change, and no control changes, because a control keeps its retained bytes and no entry may name a fuzz document. Locally: `-k case-list-inline`. CI: the full lane with no new difference on any of them.

## `CASE_LIST_SORT_PROPERTY_AMBIGUOUS`

**Today.** Nothing refuses two order rules that HQ joins by one text, or a rule that HQ gives to an earlier column with another key. HQ keeps one element per `field` text (`util.py::get_sort_and_sort_only_columns` holds the joined elements in a dict keyed by `column.field`, so the later replaces the earlier) and gives it to the first column with that text (`suite_xml/sections/details.py::get_detail_column_infos`). With an ID mapping now a property column and every attribute-backed column writing `@<name>`, both would order a device differently from what the builder shows.

**Fix.** New rule `lib/commcare/validator/rules/case-list/sortPropertyOwnership.ts`, code `CASE_LIST_SORT_PROPERTY_AMBIGUOUS`, class soundness, at the column. It reads the plan's `joinText` and nothing wire-shaped. This rule is an addition to the research, made because neither shape has a spelling HQ's build can hold: it keeps one element per join text, on the first column with it.

- (a) Two order rules whose elements have one join text: one property name (two columns over a property, or a shown link and a column over its property), one `@<name>` (two columns over `case_id`, `owner_id` or `status`), or one expression text (two select-label columns over a property, two calculated columns with the same expression). "This list already orders by the same value on \"<other column>\". CommCare keeps one order rule for each value, so you can remove either one."
- (b) An element that lands (rule 5) on a field whose key differs from the key the authored column would have under the rule. Examples: a rule on a plain, date, phone, link or hidden column over a property whose first field is an ID mapping or image map, or the reverse; a rule on a plain `status` column that sits after an ID mapping over `status`; a hidden property column's rule that lands on a calculated column whose expression prints as that bare property name. "CommCare gives this order rule to the first column with the same value, which is \"<first column>\", and that column orders differently. You can put the order rule on that column, or move this column ahead of it."

Two keys are the same when they have one kind and: for `property` and `option-label`, one property; for `mapping-position`, one property and the same entry values in the same order; for `interval-text`, `link-text` and `calculated`, equal join text, and for `interval-text` equal `text` as well.

Where the join lands on another column with the SAME key (a hidden order carrier after a shown plain column over one property; a hidden `case_id` carrier after a shown `case_id` column), nothing is refused: every runtime orders as authored, and the plan places the rule where HQ does.

**Files.** Validator: the rule, `lib/commcare/validator/errors.ts`, `gate.ts`, `lib/doc/userFacingErrors.ts`, `rules/module.ts` (beside `sortPriorityUniqueness`). Builder: `components/builder/case-list-config/SortPriorityStack.tsx` and `components/builder/case-list-config/configValidity.ts` show the finding on the rule. SA and MCP tools: the sort description in `lib/agent/tools/case-list-config/shared.ts` (one rule per value; the first column with a value takes it); ask before `npm run test:schema`. Docs: `content/docs/case-workspace.mdx`. No domain, emitter or Preview change beyond the plan.

**Stored shape and migration.** No schema change. Cutover step `sort-property-ownership` (`steps/sortPropertyOwnership.ts`; step 19 of part 10, The transform steps, in order), run after `date-patterns` and `tile-hidden-calculated-sort`. (a) is applied first, then (b) on what remains, so (b)'s target never already holds a rule: after (a) a list holds at most one rule per join text.
- (a) keeps the rule that comes first in priority order (the one the builder, Preview and a downloaded `.ccz` follow today) and removes the others. Reason `order-rule-removed-same-property`, naming the menu and both columns: "<menu>: removed the order rule on <column>. It ordered by the same value as the rule on <kept column>, and a list keeps one for each value. Apps installed from CommCare HQ followed the removed rule, so their order may change."
- (b) moves the `sort` to the first field with that join text. Reason `order-rule-moved-to-first-column`, naming both columns: "<menu>: the order rule on <column> moved to <first column>. CommCare gives an order rule to the first column with that value. Downloaded apps and Preview now order as apps installed from CommCare HQ do."

**Register.** None: no corpus document holds either shape.

**Spelling rule.** None. **Identity.** None; `proof/identity-moves.json` gains no entry. **Control.** None.

**Nova tests.** Pure, `lib/commcare/validator/rules/case-list/__tests__/sortPropertyOwnership.test.ts`: (a) for a property name, an `@<name>` and an expression text; (b) for a property field after an ID mapping, the reverse, a plain `status` column after an ID mapping over `status`, and a rule that lands on a calculated column with another key; each beside the same-key joins accepted (`targeted-shared-property-sort`'s shape, and a hidden `case_id` carrier after a shown `case_id` column). Pure, cutover: the step over a frozen fixture for (a), for (b) in both directions, for a list that holds both (so the order of the two is held), and for a document the `date-patterns` step has just rewritten.

**Lane.** CI: the corpus emission admits every document (the rule refuses none; `index.json` unchanged by it), and `targeted-shared-property-sort` still passes.

## Finding 57: the `case_id` column and attribute-backed hidden carriers

**Today.** `caseList.ts::projectColumnToDetail` writes a shown column over `case_id` with `field: "case_id"`, which `detail_screen.py::PropertyXpathGenerator.xpath` reads as a child element: `detail_screen.py::CASE_PROPERTY_MAP` has entries for `owner_id` and `status` and none for `case_id`, and the case database holds the id only as an attribute, so the column is blank on HQ's build while the local suite reads `@case_id` (`lib/commcare/casePropertyWire.ts::emitCasePropertyWirePath`). `projectColumnForShortDetail` writes a hidden column over `case_id`, `owner_id` or `status` with the attribute spelling in a property field, which HQ's Case List page refuses to save (`helpers/validators.py::ModuleDetailValidatorMixin._validate_detail_screen_field` and its page twin `static/app_manager/js/details/utils.js::isValidPropertyName` take no `@`).

**Fix.** Every column over an attribute-backed property is an expression column (rule 2). The set is the members of `lib/domain/standardCaseProperties.ts::CASE_NODE_ATTRIBUTE_PROPERTIES` that are keys of `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES`, which is `case_id`, `owner_id` and `status` (`case_type` is an attribute too, but no column can read it). It is exported as one new constant beside them, `ATTRIBUTE_BACKED_COLUMN_PROPERTIES`, which the plan reads for rule 2 and `orderPlanOptions.ts::hqExpressionFieldText` reads for the `@<name>` text. `lib/commcare/casePropertyWire.ts::emitCasePropertyWirePath` keeps its wider set (`RESERVED_CASE_ATTRIBUTES`), and a test holds that it prints `@<name>` for every member of the new constant.

- Shown: its kind's format, `field: "@<name>"`, `useXpathExpression: true`. HQ uses an expression column's `field` verbatim (`FormattedDetailColumn.xpath`) and its Case List page offers every format Nova writes on a calculated column (`details/utils.js::getFieldFormats`, `column.js`, `filterFormats`).
- Hidden: `format: "invisible"`, `field: "@<name>"`, `useXpathExpression: true`.
- An order rule on either is a positional element (`_cc_calculated_<position>`); its key is the raw value. HQ joins it to the FIRST field whose `field` is that `@<name>` (rule 5): where a shown `case_id` column sits before a hidden `case_id` column that carries the rule, HQ's `@order` and the local suite's both sit on the shown field, and the order is the same.
- A shown link over one of the three follows rule 4: a property element with the bare name for `owner_id` and `status`, the positional element and the `link-text` key for `case_id`.
- In a tile list a hidden column over `case_id`, `owner_id` or `status` with an order rule is refused (`CASE_TILE_HIDDEN_CALCULATED_SORT`), as the tile clause decides: the positional element needs the stored column, and a tile's short detail holds no column hidden from Results.
- One spelling serves every STORED column of the class. `owner_id` and `status` also read right through HQ's map as shown property columns, but not as hidden stored columns in today's spelling, and one rule for the three is simpler than two. Only a sort row with no stored column (a carrier) uses the bare name, because a sort row cannot hold `@`, and the only column that writes one is a shown link over `owner_id` or `status` (rule 4, exception i).

**Executed during planning**, in the lane's HQ: a shown column written `field: "@case_id"`, `useXpathExpression: true` builds clean, shows each case's id, and a Case List save keeps it; a hidden carrier written `invisible` with `useXpathExpression: true` and a positional sort element builds clean, orders the list by the value, and the save keeps it. Today's shapes were executed too: the shown column is blank, and the page refuses to save with a hidden carrier over any of the three. What rests on reading, each confirmed by the Lane below: a SHOWN column over `owner_id` or `status` in the expression arm; an ID mapping or image map over an expression (`detail_screen.py::FormattedDetailColumn.evaluate_template` substitutes `$calculated_property`); and the join of a positional element to the first field with its `field` text (rule 5).

**Its targeted documents.** `targeted-case-id-column` (`proof/targeted/documents/caseIdColumn.ts`, registered in `proof/targeted/index.ts`, `rows: ["57"]`) is added with its entries and its control by pull request 1 (part 09, Finding 57: a case list column over `case_id` is blank on HQ's build), before this fix. The document's content, its entry ids and its control are as this block names them, and part 09 defers to it. It holds a shown column over `case_id` and a hidden column over `owner_id` that carries the list's only order rule, and its `expected.json` names the id each row shows. This pull request adds a second document to the same file, `targeted-attribute-columns`, a passing document with no entry, for the shapes that rest on reading. Its first menu's list holds shown plain columns over `owner_id` and `status`, an ID mapping over `status`, and a shown `case_id` column before a hidden `case_id` column that carries the list's only order rule, with cases whose id order differs from their name order; its intent expectations say each field shows the case's own value and the rows come in id order. Its second menu's list holds a shown link column over `status` that carries that list's only order rule, the one shape that still writes a bare-name sort row (rule 4, exception i): HQ appends its own hidden carrier for it, which reads `@status` through `CASE_PROPERTY_MAP`. That list claims no row order, since every listed case is open; what the lane must show on it is that the Case List save keeps the sort row and changes nothing, and that proof 3 finds the appended carrier field and its `<sort>` alike on the two paths.

**Files.**
- Domain: `lib/domain/standardCaseProperties.ts` (`ATTRIBUTE_BACKED_COLUMN_PROPERTIES`), `lib/domain/caseListOrder.ts` (rule 2's attribute arm).
- Doc and mutations: none.
- Validator: the tile rule above, which reads `ATTRIBUTE_BACKED_COLUMN_PROPERTIES`; `lib/commcare/validator/hqJsonOracle.ts` (refuses `@` in a property column's `field` and in a sort element's `field`).
- Emitters: `lib/commcare/hqJson/caseList.ts` (`projectColumnToDetail`, `projectColumnForShortDetail`, `projectSortElements`), `lib/commcare/suite/case-list/orderPlanOptions.ts`.
- Surface: `lib/commcare/surface/entries/menus-and-case-lists.json` gains one entry, in "The surface entries this part edits" below, because no entry holds an attribute read in the expression arm (the two `useXpathExpression` entries hold a `calculated` column in format `plain`, and `21-translatable-enum-authored` a label projection).
- Preview, builder: none. The local suite and Preview already read the attribute.
- SA and MCP tools: none; no tool schema changes for this block.
- Proof: `proof/targeted/documents/caseIdColumn.ts`, `proof/targeted/index.ts`, `proof/timings.json`.
- Docs: `docs/research/2026-09-26-hq-round-trip/harness-findings.md` already records finding 57 (pull request 1).
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("Case-list emission") states the attribute arm.

**Stored shape and migration.** None stored. `behavior.ts` names each list with a shown column over `case_id`: reason `record-id-column-now-shows` ("<menu>, <column>: this column was blank in apps installed from CommCare HQ. After the next publish it shows each case's ID."). The tile refusal's migration, for all three properties, is the tile clause's (`tile-hidden-calculated-sort`).

**Register.** Every entry whose id starts `d57-case-id-column-`, all on control `targeted-case-id-column`, moves to `proof/fixed-defects.json`. Pull request 1 registers the classes its first lane run reports on that document; from what was executed during planning those are three:

| Id | Check | Path | Artifact | What it is |
|---|---|---|---|---|
| `d57-case-id-column-evaluate-values-value` | intent, values pinned | `/values/*/value` | `evaluate:*` | the `case_id` field is blank on HQ's build |
| `d57-case-id-column-trace-rows-fields` | proof 3 | `/runs/*/trace/*/rows/*/fields/*` | `trace@local.ccz` | the same field holds the id locally and nothing on HQ's build |
| `d57-case-id-column-editor-save-unsent` | proof 4 | `/save/unsent/*` | `editor:case list@*` | the Case List page refuses to save beside the hidden `owner_id` carrier |

The row order is no class of its own: today's hidden carrier already reads `@owner_id` on HQ's build, so both paths order alike. This block moves exactly the ids pull request 1 registered under that prefix, whatever their count; if its first run reported a class beside these three, it is moved here with them, and none stays live.

**Spelling rule.** None. **Identity.** None; `proof/identity-moves.json` gains no entry.

**Control.** `targeted-case-id-column`; its document stays admitted as a witness, passing with its `expected.json` values and no entry.

**Nova tests.** Pure: the plan's attribute arm (expression class, join text `@<name>`, positional rule, raw key) for each of the three, shown and hidden, and the join of a hidden `case_id` rule to an earlier shown `case_id` field; the parity test over a list holding them, reading `field` and `useXpathExpression` from the JSON and the path from the parsed suite; `emitCasePropertyWirePath` prints `@<name>` for every member of `ATTRIBUTE_BACKED_COLUMN_PROPERTIES`. Pure, `lib/commcare/__tests__`: the HQ JSON for both targeted shapes passes `hqJsonOracle.ts`, which gains the refusal of `@` in a property column's `field` and in a sort element's `field`. Pure, `lib/commcare/surface/__tests__`: the new entry parses and the manifest's closed-set tests hold.

**Lane.** Locally `-k targeted-case-id-column` and `-k targeted-attribute-columns`. CI: both documents show no proof 3 difference, their Case List saves succeed and change nothing, on `targeted-attribute-columns` HQ's `@order` and the local one sit on the shown `case_id` field of the first list and on the appended `status` carrier of the second, and the manifest check attributes every attribute-backed column on both to the new surface entry and reports no class; every `d57-case-id-column-` fixed entry held on the control. Fallback for the part that rests on reading, decided: if a shown `owner_id` or `status` column, or a mapping over one, differs in the expression arm, shown columns over those two keep the property token HQ's map resolves, and the expression arm stays for `case_id` and for hidden carriers, the executed shapes. If HQ's `@order` does not sit on the first field with the element's `field` text, rule 5 is corrected to what HQ's build shows, in `caseListOrderPlan` and its tests, in this pull request; no entry is registered for it. If the bare-name sort row of the second list differs across the two paths or is rewritten by the save, a shown link over `owner_id` or `status` takes the positional element and the `link-text` key, as a link over `case_id` does (rule 4, exception ii), in this pull request.

## The surface entries this part edits

`lib/commcare/surface/entries/menus-and-case-lists.json` is authored by hand. Each edit below lands with the block named; `lib/commcare/surface/__tests__` and the lane's manifest check hold the result.

| Entry id (under `menus-and-case-lists/`) | Block | Change |
|---|---|---|
| `5-enum-id-mapping` | Defect 10 | Emission cell loses "Nova emits `translatable-enum` sorted by label today: defect 10" and cites `hqJson/caseList.ts::projectColumnToDetail` and `lib/domain/caseListOrder.ts::caseListOrderPlan`. |
| `no-sort-elements` | Defect 10 | Emission cell becomes "`[]`; the local suite and Preview apply the same order (`caseListOrderPlan`, rule 7)". |
| `sort-on-a-translatable-enum-column-nova-s-label-projection-of-a` | Defect 10 | Emission cell becomes "`_cc_calculated_N`; the local suite and Preview sort by the label too (`caseListOrderPlan`, rule 3)". |
| `field-cc-calculated-n` | Finding 51 | Disposition unchanged; emission cell cites rule 5, the first-field join. |
| `blanks` | Sort spellings | Emission cell becomes "the explicit value"; the `unproducible` marker is removed. |
| `sort-calculation-equal-to-the-referenced-calculated-column` | Sort spellings | Emission cell becomes "`_cc_calculated_N` alone"; the `unproducible` marker is removed. |
| `field-and-a-differing-sort-calculation-on-a-column-whose-format` | Sort spellings | Emission cell becomes "`field` alone"; the `unproducible` marker is removed. |
| `field-and-a-differing-sort-calculation-on-any-other-column` | Sort spellings | Stays REFUSED. Emission cell becomes "not written: a sorted link column writes a sort element on the raw property, which HQ carries as a hidden sort column"; the `unproducible` marker is removed. |
| `type-plain-date-int-double-equal-to-the-type-nova-derives` | Sort spellings | Emission cell becomes "the derived type, in the Case List page's words (`plain`, `date`, `int`, `double`)". |
| `7-invisible-search-only-on-the-case-list-outside-a-custom-tile` | Hidden columns | Emission cell becomes "`invisible` for every column hidden from Results"; the clause about dropped columns goes. |
| `2-date-date-format-d-m-y-d-m-y-m-d-y-m-d-y-b-d-y` | Date patterns | Disposition cell drops "Nova admits any today"; the emission citation names `CASE_LIST_DATE_PATTERNS`. |
| `usexpathexpression-field-reading-one-case-attribute` (new) | Finding 57 | Section "Case list and case detail", subsection "Detail columns"; surface keys `schema:DetailColumn.field`, `schema:DetailColumn.useXpathExpression`; value class `expression-reading-one-case-attribute`; HELD, "a column over `case_id`, `owner_id` or `status`"; RUNS / RUNS; emission "`useXpathExpression: true`, `field: @<name>`, the column kind's format (`plain`, `date`, `phone`, `enum`, `enum-image`, `invisible`)"; no marker, no gate. |

`unregistered-format-slug-incl-nova-s-own-calculate` keeps its `unproducible` marker until pull request 12 writes `plain` (part 06, 10. The equivalent spellings).

## What this part moves, in one table

Findings 41 and 54 also land in pull request 11 (5 more fixed entries, and the rule `search_title_empty` retired). They are specified in part 06, 12. Finding 41: the empty-list text without English, and part 06, 13. Finding 54: the empty search description, and are not repeated here.

| Block | Entries to `proof/fixed-defects.json` | Rules retired | Cutover steps, in transform order | Notice reasons |
|---|---|---|---|---|
| Defect 10 | 2 | | `id-mapping-keys` | `id-mapping-entry-removed`; from `behavior.ts`, `case-list-order-changes` |
| Finding 51 | 2 | | | |
| Hidden columns (16, 35, 36) | 3 | | | from `behavior.ts`, `case-list-search-matches-hidden-fields` and `hidden-order-column-not-in-sort-menu` |
| Finding 38 | 2 | | | |
| Tile clause (hidden calculated and hidden `case_id`, `owner_id`, `status` order rules) | 6 | | `tile-hidden-calculated-sort` | `tile-order-rule-removed` |
| Tile cells and finding 42 | 8 | | `tile-cells` | `tile-cell-defaults-set` |
| Sort spellings | 0 | 4 | | |
| Date patterns | 0 | | `date-patterns` | `date-column-became-calculation` |
| Sort property ownership | 0 | | `sort-property-ownership` | `order-rule-removed-same-property`, `order-rule-moved-to-first-column` |
| Finding 57 | every `d57-case-id-column-` entry (three expected) | | | from `behavior.ts`, `record-id-column-now-shows` |

Transform order: `id-mapping-keys`, `date-patterns`, `tile-hidden-calculated-sort`, `sort-property-ownership`, `tile-cells`, which are steps 16 to 20 of part 10, The transform steps, in order. In `scripts/lib/hqRoundTripCutover/transform.ts` these five run together, in that order, after every rename step (`question-ids`, `case-operation-ids`, `connect-ids`, `entry-point-ids`, `option-values`), after `time-ordering`, `hidden-from-menu` and `post-submit`, and before `app-settings`, the last step. They must follow `option-values`, because that step can change a select's values and the plan reads the catalog's options, and they read no question id, so the rename steps do not otherwise bear on them. Each step is a module under `scripts/lib/hqRoundTripCutover/steps/`, registered in `transform.ts`. The four no-write reasons come from `scripts/lib/hqRoundTripCutover/behavior.ts`, which reads the migrated document after the last step. Each reason joins `DOCUMENT_NOTICE_REASONS` in `lib/notices/migrationNotice.ts` with its renderer in `lib/notices/migrationNoticeCopy.ts`, in this pull request (part 10, Work item F: the migration notice). Every entity a notice names is a `module` or a `caseListColumn` reference.

This pull request adds no `/api` route, so `lib/hostnames.ts` needs no entry. Each validator narrowing here runs the corpus emission, diffs `index.json`, and rewrites the documents it refuses (the date-pattern producers; any tile producer holding a hidden order rule on a calculated column or on a column over `case_id`, `owner_id` or `status`, or a cell missing a slot).
