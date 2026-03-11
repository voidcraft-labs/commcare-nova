# Case List & Case Detail Configuration

## Two Display Contexts

- **Case List (short detail)**: One row per case; columns for scanning and selection.
- **Case Detail (long detail)**: Single selected case; verification before form entry. Supports tabs and nodesets.

Both support calculated properties, icons, address formats, and display formatting.

---

## Case List Column Display Formats

| Format | Behavior |
|--------|----------|
| **Plain** | Display raw value as-is |
| **Date** | Format as date (configurable: DD/MM/YYYY, etc.) |
| **Time Since/Until** | Relative time from a date property (years/months/days); truncated, not rounded |
| **Phone Number** | Clickable call/SMS on Android and Web Apps |
| **ID Mapping** | Maps stored values to display labels; supports translations |
| **Late Flag** | Shows `*` if date property is more than N days past; blank otherwise |
| **Search Only** | Not displayed; included in searchable/sortable fields |
| **Address** | Opens Google Maps with GPS coordinates or address string |
| **Distance from current location** | Shows km distance from user's GPS to case GPS property |
| **Image** | Reserved for `cc_case_image` property (micro-image feature, limited) |
| **Icon (Preview!)** | Displays icon based on calculated conditions; order matters — first match wins |
| **Clickable Icon** | Triggers auto-submitting form when clicked; Web Apps only; requires `SESSION_ENDPOINTS` feature flag |
| **Address (map)** | For case tile map fields; format must be "Address" |
| **Address Popup** | For case tile map popup; format must be "Address Popup" |

---

## Calculated Properties in Case List

Requires "Custom Calculations in Case List" add-on.

### Referencing the current row's case

```xpath
current()/@case_id              <!-- case ID of current row -->
current()/index/parent          <!-- parent case ID -->
current()/age                   <!-- any case property -->
```

### Reaching beyond the current case

```xpath
<!-- Parent case name -->
instance('casedb')/casedb/case[@case_id=current()/index/parent]/case_name

<!-- Count open child cases -->
count(instance('casedb')/casedb/case[@case_type='member'][index/parent=current()/@case_id])

<!-- Current user's location ID -->
instance('commcaresession')/session/user/data/commcare_location_id

<!-- Lookup table value via case property -->
instance('locations')/locations/location[@id=current()/village_id]/name

<!-- Lookup table (item-list) via case property -->
instance('item-list:medicine')/medicine_list/medicine[index=current()/medication_index]/medication
```

### Performance note
Each calculated property runs once per row. Aggregate queries over child/extension cases (e.g., `count()`) run N×M times. For expensive computations, pre-compute in forms and store as case properties, or move to case detail (runs once on selection).

---

## Case List Filtering

Case list filters are XPath expressions returning true/false. Reference case properties directly by name (no `/data/` prefix).

```xpath
(date(admission_date) + 7) <= today() and today() <= (date(admission_date) + 30)
if(phone_number = '', false(), (date(admission_date) + 7) <= today())
#user/favorite_number = "1"
```

### Indexed vs. Non-Indexed Property Ordering

**Indexed properties** (fast — always place first in predicate chains):
- `@case_type`, `@status`, `@case_id`, `@owner_id`, `@external_id`
- `index/INDEX_NAME`

Each predicate in its own brackets. Indexed predicates first:

```xpath
<!-- Fast: indexed predicates filter first -->
instance('casedb')/casedb/case[@case_type='patient'][@status='open'][non_indexed_prop='value']

<!-- Slow: non-indexed predicate filters first, scans everything -->
instance('casedb')/casedb/case[non_indexed_prop='value'][@case_type='patient']
```

### Parent/child filter patterns

```xpath
<!-- Show only parents with open child cases -->
count(instance('casedb')/casedb/case[index/parent=@case_id][@status='open']) >= 1

<!-- Display parent property in child case list column -->
instance('casedb')/casedb/case[@case_id=current()/index/parent]/unit_description
```

### User/session references in filters

```xpath
@owner_id = instance('commcaresession')/session/context/userid
instance('commcaresession')/session/user/data/commcare_location_id
```

---

## Case List Sorting

- Sort types: Plain (text), Date, Integer, Decimal
- No limit on number of sort properties
- Properties do not need to be displayed to be sorted on
- Default: sorts by first display column if no sort configured
- Fuzzy search on mobile is enabled when a property is in the sort list and fuzzy search is on (app-level setting); requires 3+ characters typed

### Sort Calculation (requires `SORT_CALCULATION_IN_CASE_LIST` feature flag)

```xpath
if(risk = 'Very Risky', 1, 
  if(risk = 'Risky', 2, 
    if(risk = 'Ok', 3, 
      if(risk = 'Not too Risky', 4, 5))))
```

### Sorting by search relevance (case search only)
Add `commcare_search_score` as first sort property, format=Decimal, direction=Decreasing.

---

## Case Tiles

Requires feature flags: `case_list_tile` (predefined templates), optionally `case_list_tile_custom` (manual grid config), `case_list_map` (map in Web Apps).

### Template slots
Templates have fixed field slots (e.g., `header`, `top_left`, `bottom_left`, `map`, `map_popup`). **All slots must be assigned**; extra properties are ignored. Missing slot assignment causes a save error.

### Map fields
- `map` slot: format must be "Address"; value contains lat/lon coordinates
- `map_popup` slot: format must be "Address Popup"; supports markdown

### Grouping by parent (CommCare ≥2.54)
Configure on child module:
- Set "Parent case index name" (e.g., `parent`)
- Set "Case tile header rows" = number of rows from template used for parent info
- Reference parent properties: `instance('casedb')/casedb/case[@case_id=current()/index/parent]/case_name`

### Custom case tile grid
12 columns × variable rows. Position fields via `grid-x`, `grid-y`, `grid-width`, `grid-height`. Supports `horz-align`, `vert-align`, `font-size` styling.

### Persistent case tiles
Appear at top of follow-up forms showing selected case context. Requires `show_persist_case_context_setting` feature flag. Best practice: use with shadow menus.

---

## Case Detail Nodesets

Requires feature flags: `Tabs in the case detail list` + `Associate a nodeset with a case detail tab`.

Adds "data" tabs to case detail that iterate over related cases — displays a mini case list within the detail view.

### Nodeset expression

```xpath
instance('casedb')/casedb/case[@case_type='CHILD_TYPE'][@status='open'][index/parent=current()/@case_id]
```

### Sorting within nodeset
Use "Search Only" format properties within the nodeset tab. Sorting applies by first Search Only field, then second, etc.

### Case search menus
For case search modules, use the built-in child case type option (not a custom expression) to get proper integration with the search results instance.

---

## Multi-Select Case Lists

Requires `ush_case_list_multi_select` feature flag. Web Apps only.

### Accessing selected cases

```xpath
<!-- All selected case IDs -->
instance('selected_cases')/results/value

<!-- Join selected IDs into space-separated string (e.g., for hidden value) -->
join(' ', instance('selected_cases')/results/value)
```

### Working with selected cases in forms
No default case management is provided. Use Save to Case in repeat groups. Access individual case properties:

```xpath
instance('casedb')/casedb/case[@case_id=current()/../@id]/property_name
```

### Configuration
- Maximum selected value: configurable (default 100)
- Auto-selection: auto-selects all cases if count ≤ max; requires Search First or Skip to Default workflow

### Incompatibilities
Multi-select is incompatible with: form links, advanced menus, data registries, standard EOF navigation "previous screen".

For parent/child selection with multi-select: only compatible with "other" relationship, not "parent" relationship.

---

## Parent-Child Selection

Configured on the child module's case list. Forces selection of parent case before child case.

```
Start → Parent Case List → Child Case List → Form List → Form
```

- Case list filter on parent: applies at parent selection step
- Case list filter on child: applies at child selection step
- Parent-child selection configuration **cannot be copied** via the "Overwrite Case List Configuration" feature

---

## `results` vs `casedb` Instance in Search-First Lists

After case search, results are in `instance('results')` not `instance('casedb')`:

```xpath
<!-- Case list calculated column after search -->
count(instance('results')/results/case
  [index/parent=instance('commcaresession')/session/data/case_id]
  [@case_type='lab_result']/@case_id)

<!-- Same column in normal casedb list -->
count(instance('casedb')/casedb/case
  [index/parent=instance('commcaresession')/session/data/case_id]
  [@case_type='lab_result']/@case_id)
```

Using `instance('results')` in a non-search case list will crash. Using `instance('casedb')` in a search-first list returns 0 before case is claimed.

Enabling "Make search input available" changes `instance('results')` to `instance('results:inline')`. Any existing XPath referencing `instance('results')` breaks.

---

## Filter Mirroring Requirement

Case list filters and Default Search Filters must produce consistent results. If a user searches and selects a case that fails the case list filter, CommCare rejects the selection and loops the user back — poor UX. Always ensure both filters align.

---

## Cache and Index (Deprecated)

**Avoid for new implementations.** Relevant only for case lists of 1,000–10,000 cases.

- **Blocking mode**: ≥1 but not all fields marked cache-and-index → blocks display until cached
- **Non-blocking mode**: All fields marked → shows cases during cache build but disables sorting
- Cache invalidated on app update or 412 sync
- When enabled, search only works on sort properties, not display properties

---

## Instance References Quick Reference

| Context | Instance |
|---------|----------|
| Local case database | `instance('casedb')/casedb/case[...]` |
| Current session case ID | `instance('commcaresession')/session/data/case_id` |
| Current user ID | `instance('commcaresession')/session/context/userid` |
| Current username | `instance('commcaresession')/session/context/username` |
| User case properties | `instance('commcaresession')/session/user/data/PROPERTY` |
| Locations fixture | `instance('locations')/locations/location[...]` |
| Lookup table | `instance('item-list:TABLENAME')/...` |
| Search results (standard) | `instance('results')` |
| Search results (inline) | `instance('results:inline')` |
| Search results (custom name) | `instance('results:CUSTOM_NAME')` |
| User search input | `instance('search-input:results')/input/field[@name='X']` |
| Multi-select selected cases | `instance('selected_cases')/results/value` |