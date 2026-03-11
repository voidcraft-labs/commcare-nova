

# Case Search & Claim Configuration

## Search Architecture

```
User searches → ES query (server) → 500-result max → Device filter (Search Filter) → Displayed results
```

**ES-side filters**: Default Search Filters, `_xpath_query`, excluded owner IDs, open/closed toggle
**Device-side filters**: Search Filter (post-ES, runs on device)

**Critical**: ES truncates to 500 results *before* the device-side Search Filter runs. A Search Filter that would match only 5 of 500 results may return 0 if those 5 weren't in the ES top-500. **Always prefer ES-side filtering.**

---

## Required Feature Flags

| Flag | Purpose |
|------|---------|
| `extension_sync` | Required for case search |
| `search_claim` | Core case search/claim |
| `case_claim_autolaunch` | Web Apps workflow variants |
| `SPLIT_SCREEN_CASE_SEARCH` | Split-screen UI |
| `inline_case_search` | Make search input available in forms |
| `session_endpoints` | Smart links, clickable icons |
| `SORT_CALCULATION_IN_CASE_LIST` | Custom sort XPath |
| `case_search_advanced` | Related case search (parent/grandparent in CSQL) |

---

## Search Properties Configuration

Each search property has:

| Field | Description |
|-------|-------------|
| Case Property | Direct property name, or `parent/name`, `parent/parent/name` |
| Display Text | Label shown to user |
| Help Text | Shows "?" icon with popup |
| Default Value Expression | XPath pre-populating the field |
| Format | Text, Barcode, Lookup Table, Date, Date Range, Geocoder Broadcast |
| Allow multiple selections | Only for Lookup Table format |
| Allow searching for blank values | Adds checkbox for null inclusion |
| Hide in Search Screen | Hidden from UI; still used if it has a default value |
| Exclude from Search Filters | Field value not sent to ES; use as variable for `_xpath_query` |
| Required | XPath expression; `true()` = always required |
| Geocoder Receiver Expression | `geocoder_field_name-geocoder_subfield` |

**Lookup Table format** requires a table with `value`, `name`, `sort` columns. Nodeset can be filtered using search input references:

```xpath
instance('cities')/cities_list/cities[state = instance("search-input:results")/input/field[@name='state']]
```

**Grouped search properties** (CommCare ≥2.54): Properties can be organized into collapsible groups. Each property must belong to a group; blank group name = singleton.

---

## Default Search Filters

Two types:

### 1. Simple Property Filter
Enter a case property name + XPath value expression. All conditions are AND'd. The value is evaluated on-device before sending to ES.

### 2. `_xpath_query` Special Property
Value is an XPath expression that produces a **CSQL string** sent to ES.

```xpath
"current_status = 'closed'"

concat("assigned_to_username = '", instance('commcaresession')/session/context/username, "'")

concat("fup_next_call_date <= '", today(), "' and current_status != 'closed'")
```

**Rules for `_xpath_query`**:
- Outside double-quotes = evaluated on device first (XPath)
- Inside double-quotes = literal string passed to ES (CSQL)
- Cannot compare two case properties directly (`a >= b` fails in CSQL)
- Can move math to the right side: `concat("last_modified <= '", date(today() - 7), "'")`
- Multiple `_xpath_query` entries are AND'd together

### Accessing User Search Input in Default Filters (CommCare ≥2.53)

```xpath
instance('search-input:results')/input/field[@name='field_name']
count(instance('search-input:results')/input/field[@name='field_name']) > 0
```

---

## CSQL Functions Reference

Available in `_xpath_query` and Case List Explorer:

| Function | Usage |
|----------|-------|
| `date('YYYY-MM-DD')` | Date literal |
| `today()` | Current date (project timezone) |
| `date-add(date, 'days', n)` | Date arithmetic |
| `now()` | Current datetime UTC |
| `selected(prop, "val")` | Multi-select contains value |
| `selected-any(prop, "val1 val2")` | Multi-select contains any of space-separated values |
| `selected-all(prop, "val1 val2")` | Multi-select contains all of space-separated values |
| `within-distance(prop, 'lat lon', dist, 'unit')` | GPS radius filter (units: `kilometers`, `miles`) |
| `fuzzy-match(prop, "val")` | Fuzzy string match |
| `phonetic-match(prop, "val")` | Soundex match |
| `fuzzy-date(prop, "YYYY-MM-DD")` | Date permutation match |
| `subcase-exists('rel', filter)` | Has matching subcase (boolean) |
| `subcase-count('rel', filter) > n` | Subcase count comparison |
| `ancestor-exists(parent/parent, filter)` | Ancestor match |
| `match-all()` | Return all cases (no filter) |
| `match-none()` | Return no cases |
| `starts-with(prop, "prefix")` | Starts with (case-sensitive, slow) |
| `not(expr)` | Boolean invert |

### Related Case Search in CSQL (requires `case_search_advanced` FF)

```
parent/age > 55
parent/parent/dod = ''
```

**Warning**: Related case property searches significantly increase latency. Fuzzy + related degrades further. Hard platform limit: 500K intermediate results per related query — exceeding this causes timeout.

---

## CSQL Expression Patterns

### Basic filter with session data
```xpath
concat("assigned_to = '", instance('commcaresession')/session/context/userid, "'")
```

### Date range
```xpath
concat("fup_next_call_date <= '", today(), "' and current_status != 'closed'")
```

### GPS within-distance with user input
```xpath
concat('within-distance(location, "', instance('search-input:results')/input/field[@name='lat_lon'], '", 1000, "kilometers")')
```

### Subcase search with dynamic value
```xpath
concat('subcase-exists("parent", @case_type = "service" and selected(clinic_case_id,"',
  instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/clinic_case_ids,
  '"))')
```

### Date arithmetic (move math to right side)
```xpath
concat("last_modified <= '", date(today() - 7), "'")
```

---

## Search and Claim Options

| Option | Notes |
|--------|-------|
| Web Apps Search Workflow | Normal, Search First, See More, Skip to Default |
| Label for Searching | Button text on casedb list; header on results screen |
| Label for Searching Again | Button to return to search screen |
| Display condition | XPath to conditionally hide search button |
| Search Filter | Post-ES device-side filter (**last resort only**) |
| Claim condition | XPath; if true, case can be claimed |
| Don't claim already owned cases | Skips claim if user already owns it |
| Don't search cases owned by following IDs | XPath → space-separated owner_ids to exclude from ES |
| Case Property with Additional Case ID | Includes related case (custom relationship) in results instance |
| Include Related Cases | Pulls grandparent/parent/host/child/extension into results |
| Search Screen Title | Custom title (CommCare ≥2.53: in UI; earlier: via bulk translations `case.search.title`) |
| Search Screen Subtitle | Markdown text; Web Apps only |
| Empty Case List Text | Custom "no results" message |

---

## Web Apps Search Workflows

| Workflow | Behavior |
|----------|----------|
| Normal Case List | Local casedb first → search button → search screen → results |
| Search First | Skips local list; goes directly to search screen |
| See More | From local list, search runs with defaults immediately; skips search screen |
| Skip to Default Case Search Results | Skips local list; runs default filters immediately; shows results |

**Auto Selection** (multi-select): compatible only with **Search First** or **Skip to Default**.

---

## Instance Names

| Context | Instance Reference |
|---------|-------------------|
| Normal case search results | `instance('results')` |
| With "Make search input available" enabled | `instance('results:inline')` |
| With custom instance name set | `instance('results:CUSTOM_NAME')` |
| User search input (standard) | `instance('search-input:results')/input/field[@name='X']` |
| User search input (inline feature) | `instance('search-input:results:inline')/input/field[@name='X']` |
| Multi-select selected cases | `instance('selected_cases')/results/value` |
| Multi-select join to hidden value | `join(' ', instance('selected_cases')/results/value)` |

**Critical**: Enabling "Make search input available" changes `instance('results')` to `instance('results:inline')`. Any existing XPath referencing `instance('results')` will break.

---

## Sorting by Search Relevance

Add `commcare_search_score` as the first sort property, format = Decimal, direction = Decreasing.

---

## Common Mistakes and Non-Obvious Constraints

1. **Mirror filters**: Case list filter and Default Search Filters must enforce equivalent logic. If a user searches and selects a case that fails the case list filter, CommCare rejects the selection and loops them back — terrible UX.

2. **Search Filter vs. Default Search Filter**: Search Filter (post-ES, device-side) can produce incomplete results due to the 500-result truncation. Only use for comparisons between two case properties or session data unavailable server-side.

3. **Default Search Filter ↔ Search Properties conflict**: The same property cannot appear in both Default Search Filters and Search Properties — causes an app config error.

4. **Predicate ordering**: Always put indexed predicates (`@case_type`, `@status`, `@owner_id`) before non-indexed ones, each in its own brackets: `[@case_type='x'][@status='open'][custom_prop='y']`.

5. **`_xpath_query` quoting**: The entire CSQL expression must evaluate to a **string**. Values from instances must be concatenated outside the inner quotes. Forgetting this sends the literal XPath text as CSQL instead of the resolved value.

6. **ES returns max 500 results**: Design required search fields to narrow results. Fuzzy and related-case searches increase result counts. Searches matching >500K intermediate cases for related queries will timeout.

7. **Fuzzy properties are domain-wide**: Enabling fuzzy for a property affects all searches on that case type across the entire domain, not just one menu.

8. **Instance name changes with inline search**: See Instance Names section — enabling inline search silently changes the instance ID.

9. **Related case search latency**: Adding `parent/property` in CSQL increases search time significantly. Fuzzy + related compounds the degradation.

10. **Multi-select + filtering**: Multi-select skips the standard local casedb list. Filtering must be done via Search First or Skip to Default workflow.